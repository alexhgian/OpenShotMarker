import { test, expect, type Page } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Phase 1 acceptance, HANDOFF.md:
 *   open the dev harness, enter manual TC 10:00:00;00 at 29.97 DF, tap Great, assert a
 *   marker row appears with a timecode <= 1.5 s before the running clock (default
 *   pre-roll), reload the page, assert the marker is still there.
 */

const ARTIFACTS = join(process.cwd(), 'test-results');

/** 29.97 DF, mirroring core/timecode.ts. Independent of the app's own code on purpose. */
function tcToFrames2997df(tc: string): number {
  const [hh, mm, ss, ff] = tc.replace(';', ':').split(':').map(Number) as [number, number, number, number];
  const totalMin = hh * 60 + mm;
  return ((hh * 60 + mm) * 60 + ss) * 30 + ff - 2 * (totalMin - Math.floor(totalMin / 10));
}

async function lockCameraA(page: Page, tc = '10:00:00;00') {
  await page.getByTestId('chip-A').click();
  const sheet = page.getByTestId('lock-sheet-A');
  await expect(sheet).toBeVisible();
  await sheet.getByTestId('lock-tc').fill(tc);
  await expect(sheet.getByTestId('lock-fps')).toHaveValue('29.97');
  await expect(sheet.getByTestId('lock-drop')).toBeChecked();
  await sheet.getByTestId('lock-confirm').click();
  await expect(page.getByTestId('running-tc')).toHaveAttribute('data-locked', 'yes');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Each test starts from a clean IndexedDB so runs do not accumulate markers.
  await page.evaluate(() => indexedDB.deleteDatabase('tc-marker'));
  await page.reload();
  await expect(page.getByTestId('running-tc')).toBeVisible();
});

test('the harness works with no camera, no microphone and no network', async ({ page }) => {
  await expect(page.getByTestId('chip-A')).toContainText('NEVER LOCKED');
  await expect(page.getByTestId('pad-great')).toBeDisabled();

  await lockCameraA(page);

  await expect(page.getByTestId('chip-A')).toContainText('LOCKED');
  await expect(page.getByTestId('pad-great')).toBeEnabled();
});

test('a tapped marker lands within the pre-roll window and survives a reload', async ({ page }) => {
  await lockCameraA(page);

  const runningBefore = await page.getByTestId('running-tc').innerText();
  await page.getByTestId('pad-great').dispatchEvent('pointerdown');

  const row = page.getByTestId('marker-row').first();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-type', 'great');

  const markerTc = (await row.getAttribute('data-tc'))!;
  const runningAfter = await page.getByTestId('running-tc').innerText();

  // The marker must land BEFORE the tap, by roughly the 1.5 s default pre-roll (§5).
  const markerFrame = tcToFrames2997df(markerTc);
  const beforeFrame = tcToFrames2997df(runningBefore);
  const afterFrame = tcToFrames2997df(runningAfter);

  const behindBefore = beforeFrame - markerFrame;
  // 1.5 s at 29.97 real fps is 45 frames. Allow a little slack for the frames that
  // elapse between reading the clock and dispatching the event.
  expect(behindBefore).toBeGreaterThanOrEqual(40);
  expect(behindBefore).toBeLessThan(75);
  // And it is strictly in the past relative to the clock now.
  expect(markerFrame).toBeLessThan(afterFrame);

  // The frame stored alongside the label agrees with it (§8).
  expect(Number(await row.getAttribute('data-frame'))).toBe(markerFrame);

  // --- the reload: proves sql.js really reached IndexedDB ---
  await page.reload();
  await expect(page.getByTestId('running-tc')).toBeVisible();

  const reloadedRow = page.getByTestId('marker-row').first();
  await expect(reloadedRow).toBeVisible();
  await expect(reloadedRow).toHaveAttribute('data-tc', markerTc);
  await expect(reloadedRow).toHaveAttribute('data-type', 'great');
  // The clock is deliberately NOT restored: an anchor is only valid for the
  // performance.now() epoch it was taken in, and that epoch died with the page.
  await expect(page.getByTestId('running-tc')).toHaveAttribute('data-locked', 'no');
});

test('all five marker types record, and a typed note attaches', async ({ page }) => {
  await lockCameraA(page);

  await page.getByTestId('note-input').fill('second chorus, the hair flip');
  await page.getByTestId('pad-great').dispatchEvent('pointerdown');
  for (const type of ['earmark', 'cutaway', 'inout', 'note']) {
    await page.getByTestId(`pad-${type}`).dispatchEvent('pointerdown');
  }

  await expect(page.getByTestId('marker-row')).toHaveCount(5);
  // The note went to the first marker and the field cleared after it.
  const rows = page.getByTestId('marker-row');
  await expect(rows.last().getByTestId('marker-note')).toHaveValue('second chorus, the hair flip');
  await expect(page.getByTestId('note-input')).toHaveValue('');
  await expect(page.getByTestId('queue-depth')).toContainText('5 local');
});

test('a deleted marker disappears and stays gone across a reload', async ({ page }) => {
  await lockCameraA(page);
  await page.getByTestId('pad-great').dispatchEvent('pointerdown');
  await page.getByTestId('pad-cutaway').dispatchEvent('pointerdown');
  await expect(page.getByTestId('marker-row')).toHaveCount(2);

  await page.getByTestId('marker-row').first().getByTestId('marker-delete').click();
  await expect(page.getByTestId('marker-row')).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId('marker-row')).toHaveCount(1);
});

test('the exported .tcfix.json is accepted by TCFix.py and every frame re-derives', async ({
  page,
}) => {
  await lockCameraA(page, '10:14:22;07');
  for (const type of ['great', 'cutaway', 'earmark']) {
    await page.getByTestId(`pad-${type}`).dispatchEvent('pointerdown');
  }
  await expect(page.getByTestId('marker-row')).toHaveCount(3);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-tcfix').click(),
  ]);
  expect(download.suggestedFilename()).toBe('dev-harness-session.tcfix.json');

  mkdirSync(ARTIFACTS, { recursive: true });
  const saved = join(ARTIFACTS, 'exported.tcfix.json');
  writeFileSync(saved, readFileSync(await download.path(), 'utf8'));

  // The real Python loader, on a file the browser actually produced.
  const out = execFileSync('python3', ['scripts/check_tcfix.py', saved], { encoding: 'utf8' });
  expect(out).toContain('OK: 3 markers round-trip identically through TCFix.py');

  const file = JSON.parse(readFileSync(saved, 'utf8'));
  expect(file.format).toBe('tcfix');
  expect(file.version).toBe(1);
  expect(file.reference_camera).toBe('A');
  expect(file.cameras.B.offset_meaning).toBe('A_frame = B_frame + offset_frames');
});

test('a slept phone shows STALE and still accepts markers (§3.4)', async ({ page }) => {
  // Simulate the phone sleeping: freeze performance.now() where it is, while Date.now()
  // jumps twenty minutes. That is exactly what a paused monotonic counter looks like.
  await page.addInitScript(() => {
    const realPerfNow = performance.now.bind(performance);
    const realDateNow = Date.now.bind(Date);
    let frozenAt: number | null = null;
    let wallJumpMs = 0;
    (window as unknown as { __sleep: (ms: number) => void }).__sleep = (ms: number) => {
      frozenAt = realPerfNow();
      wallJumpMs = ms;
    };
    performance.now = () => (frozenAt === null ? realPerfNow() : frozenAt);
    Date.now = () => realDateNow() + wallJumpMs;
  });
  await page.goto('/');
  await page.evaluate(() => indexedDB.deleteDatabase('tc-marker'));
  await page.reload();

  await lockCameraA(page, '10:00:00;00');
  await expect(page.getByTestId('chip-A')).toHaveAttribute('data-state', 'locked');

  await page.evaluate(() => (window as unknown as { __sleep: (ms: number) => void }).__sleep(20 * 60_000));

  await expect(page.getByTestId('running-tc')).toHaveAttribute('data-stale', 'yes');
  await expect(page.getByTestId('chip-A')).toHaveAttribute('data-state', 'stale');
  await expect(page.getByTestId('chip-A')).toContainText('STALE');
  await expect(page.getByTestId('stale-banner')).toBeVisible();

  // §3.4: a marker taken now is still accepted, and labelled honestly.
  await page.getByTestId('pad-great').dispatchEvent('pointerdown');
  const row = page.getByTestId('marker-row').first();
  await expect(row).toBeVisible();
  const staleTc = (await row.getAttribute('data-tc'))!;
  // It landed ~20 minutes after the lock, from wall time, not back at 10:00.
  expect(tcToFrames2997df(staleTc)).toBeGreaterThan(tcToFrames2997df('10:19:00;00'));

  // Re-locking corrects it and clears the flag.
  await lockCameraA(page, '10:30:00;00');
  await expect(page.getByTestId('running-tc')).toHaveAttribute('data-stale', 'no');
  await expect(page.getByTestId('chip-A')).toHaveAttribute('data-state', 'locked');
  await expect(page.getByTestId('marker-row').first()).toHaveAttribute('data-clock', 'corrected');
});

test('the CSV export carries the documented columns', async ({ page }) => {
  await lockCameraA(page);
  await page.getByTestId('pad-great').dispatchEvent('pointerdown');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-csv').click(),
  ]);
  const csv = readFileSync(await download.path(), 'utf8');
  expect(csv.split('\r\n')[0]).toBe(
    'timecode,frame,camera,type,note,source,clock,created,device',
  );
  expect(csv.split('\r\n')[1]).toContain(',A,great,');
});
