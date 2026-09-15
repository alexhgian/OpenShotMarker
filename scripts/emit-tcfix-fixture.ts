/**
 * Emits a .tcfix.json from the real TypeScript exporter so that
 * scripts/check_tcfix.py can load it with the real Python loader.
 *
 * This is the cross-language half of the CLAUDE.md rule that TCFix.py and
 * core/timecode.ts must agree: a file written by one is read by the other, and every
 * frame is re-derived from its label rather than trusted.
 *
 * Usage: npx vite-node scripts/emit-tcfix-fixture.ts -- <out-path>
 */

import { writeFileSync } from 'node:fs';
import { buildTcfix, tcfixToJson } from '../src/core/export/tcfix';
import { createSession, createCamera, createMarker, type Marker } from '../src/core/markers';
import { TcClock } from '../src/core/clock';
import { tcToFrames, framesPerDay, realFps } from '../src/core/timecode';

const out = process.argv[2] ?? 'fixture.tcfix.json';

const NOW = Date.parse('2026-09-15T18:02:11Z');
const session = createSession({
  label: 'elfyou — Tuesday',
  fps: '29.97',
  drop_frame: true,
  device: 'alex-iphone',
  nowMs: NOW,
});

const camA = {
  ...createCamera({
    session_id: session.id,
    key: 'A',
    fps: '29.97',
    drop_frame: true,
    label: 'FX30 main',
  }),
  last_locked_at: '2026-09-15T18:03:40Z',
  lock_quality: { inliers: 14, residual_frames: 0.4 },
};
const camB = {
  ...createCamera({
    session_id: session.id,
    key: 'B',
    fps: '29.97',
    drop_frame: true,
    label: 'FX30 wide',
    bin_hint: 'CAM B',
  }),
  offset_frames: -4471,
  offset_measured_at: '2026-09-15T18:05:12Z',
  offset_confidence_frames: 1,
  lock_quality: { inliers: 11, residual_frames: 0.6 },
};

const clock = new TcClock({
  fps: '29.97',
  drop: true,
  anchor: { tcFrame: 0, t: 0 },
});

const types = ['earmark', 'great', 'cutaway', 'inout', 'note'] as const;
const perDay = framesPerDay('29.97', true);
const markers: Marker[] = [];

// Walk the whole 24-hour day, landing on and around every minute boundary where
// drop-frame discontinuities live. If the two implementations disagree anywhere,
// one of these frames finds it.
let n = 0;
for (let frame = 0; frame < perDay; frame += 1009) {
  const tSec = frame / realFps('29.97');
  markers.push(
    createMarker({
      session_id: session.id,
      camera_id: n % 3 === 0 ? camB.id : camA.id,
      type: types[n % types.length]!,
      tCapturedMs: tSec * 1000,
      prerollMs: 0,
      clock,
      device: 'alex-iphone',
      note: n % 7 === 0 ? 'note with a comma, a "quote" and a — dash' : '',
      source: n % 2 === 0 ? 'tap' : 'voice',
      nowMs: NOW + n,
    }),
  );
  n++;
}

// Plus the two markers from the shipped example file, exactly.
for (const [tc, type] of [
  ['10:14:22;07', 'great'],
  ['10:18:04;11', 'cutaway'],
] as const) {
  markers.push(
    createMarker({
      session_id: session.id,
      camera_id: camA.id,
      type,
      tCapturedMs: (tcToFrames(tc, '29.97', true) / realFps('29.97')) * 1000,
      prerollMs: 0,
      clock,
      device: 'alex-iphone',
      source: 'tap',
      nowMs: NOW + n++,
    }),
  );
}

const file = buildTcfix({ session, cameras: [camA, camB], markers });
writeFileSync(out, tcfixToJson(file));
console.log(`wrote ${out}: ${file.markers.length} markers across 24h at 29.97 DF`);
