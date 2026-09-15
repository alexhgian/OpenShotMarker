import { describe, it, expect, beforeEach } from 'vitest';
import { SqlJsStore } from '../../src/platform/sqljs-store';
import { MemoryBlobStore } from '../../src/platform/blob';
import { SCHEMA_VERSION } from '../../src/core/schema';
import {
  createSession,
  createCamera,
  createMarker,
  softDelete,
  withNote,
  type Session,
  type Camera,
} from '../../src/core/markers';
import { TcClock } from '../../src/core/clock';
import { tcToFrames } from '../../src/core/timecode';

const NOW = 1_757_000_000_000;
const clock = () =>
  new TcClock({
    fps: '29.97',
    drop: true,
    anchor: { tcFrame: tcToFrames('10:14:22;07', '29.97', true), t: 0 },
  });

let blobs: MemoryBlobStore;
let store: SqlJsStore;
let session: Session;
let cam: Camera;

async function fresh(): Promise<SqlJsStore> {
  const s = new SqlJsStore({ blobStore: blobs });
  await s.init();
  return s;
}

beforeEach(async () => {
  blobs = new MemoryBlobStore();
  store = await fresh();
  session = createSession({
    label: 'elfyou — Tuesday',
    fps: '29.97',
    drop_frame: true,
    device: 'alex-iphone',
    nowMs: NOW,
  });
  cam = createCamera({ session_id: session.id, key: 'A', fps: '29.97', drop_frame: true });
  await store.putSession(session);
  await store.putCamera(cam);
});

const marker = (n: number, over: Partial<Parameters<typeof createMarker>[0]> = {}) =>
  createMarker({
    session_id: session.id,
    camera_id: cam.id,
    type: 'great',
    tCapturedMs: n * 1000,
    prerollMs: 0,
    clock: clock(),
    device: 'alex-iphone',
    nowMs: NOW + n * 1000,
    ...over,
  });

describe('§8 the store', () => {
  it('refuses to be used before init', async () => {
    const s = new SqlJsStore({ blobStore: new MemoryBlobStore() });
    await expect(s.listSessions()).rejects.toThrow(/before init/);
  });

  it('is idempotent on init', async () => {
    await store.init();
    expect(await store.listSessions()).toHaveLength(1);
  });

  it('round-trips a session', async () => {
    const got = await store.getSession(session.id);
    expect(got).toEqual(session);
    expect(await store.getSession('nope')).toBeNull();
    expect(await store.listSessions()).toEqual([session]);
  });

  it('round-trips a camera, including the jsonb-ish columns', async () => {
    const full: Camera = {
      ...cam,
      roi: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 },
      offset_frames: -4471,
      offset_measured_at: '2026-09-15T18:05:12Z',
      offset_confidence_frames: 1,
      bin_hint: 'CAM B',
      last_locked_at: '2026-09-15T18:03:40Z',
      lock_quality: { inliers: 11, residual_frames: 0.6 },
      label: 'FX30 wide',
    };
    await store.putCamera(full);
    const [got] = await store.listCameras(session.id);
    expect(got).toEqual(full);
  });

  it('round-trips a marker with every column intact', async () => {
    const m = marker(1, { note: 'the hair flip', source: 'voice', audio_path: '/a.m4a' });
    await store.putMarker(m);
    const [got] = await store.listMarkers(session.id);
    expect(got).toEqual(m);
  });

  it('lists markers newest first', async () => {
    const a = marker(1);
    const b = marker(2);
    const c = marker(3);
    for (const m of [a, b, c]) await store.putMarker(m);
    expect((await store.listMarkers(session.id)).map((m) => m.id)).toEqual([c.id, b.id, a.id]);
  });

  it('is idempotent by ULID — a retried sync cannot duplicate a marker', async () => {
    const m = marker(1);
    await store.putMarker(m);
    await store.putMarker(m);
    await store.putMarker(m);
    expect(await store.listMarkers(session.id)).toHaveLength(1);
  });

  it('takes the later edit and ignores an older copy arriving late', async () => {
    const m = marker(1);
    await store.putMarker(m);
    const newer = withNote(m, 'newer', NOW + 60_000);
    const older = withNote(m, 'older', NOW - 60_000);
    await store.putMarker(newer);
    await store.putMarker(older); // arrives late, but is stale
    const [got] = await store.listMarkers(session.id);
    expect(got!.note).toBe('newer');
  });

  it('hides soft-deleted markers but still sends them to sync', async () => {
    const m = marker(1);
    await store.putMarker(m);
    await store.putMarker(softDelete(m, NOW + 5000));
    expect(await store.listMarkers(session.id)).toEqual([]);
    const changed = await store.markersChangedSince(session.id, new Date(NOW).toISOString());
    expect(changed).toHaveLength(1);
    expect(changed[0]!.deleted_at).not.toBeNull();
  });

  it('reports everything touched since a watermark', async () => {
    await store.putMarker(marker(1));
    const watermark = new Date(NOW + 1500).toISOString();
    const later = marker(5);
    await store.putMarker(later);
    const changed = await store.markersChangedSince(session.id, watermark);
    expect(changed.map((m) => m.id)).toEqual([later.id]);
  });

  it('reports queue depth so the operator can see the phone is holding markers', async () => {
    expect(await store.queueDepth(session.id)).toBe(0);
    await store.putMarker(marker(1));
    await store.putMarker(marker(2));
    expect(await store.queueDepth(session.id)).toBe(2);
  });

  it('keeps sessions separate', async () => {
    const other = createSession({ label: 'other', fps: '25', drop_frame: false, device: 'd' });
    await store.putSession(other);
    await store.putMarker(marker(1));
    expect(await store.listMarkers(other.id)).toEqual([]);
    expect(await store.listMarkers(session.id)).toHaveLength(1);
  });

  it('enforces the foreign key rather than accepting an orphan marker', async () => {
    await expect(store.putMarker(marker(1, { camera_id: 'ghost' }))).rejects.toThrow();
  });
});

describe('§2 persistence — the write is the commit', () => {
  it('survives a close and reopen through the blob store', async () => {
    const m = marker(1, { note: 'survives' });
    await store.putMarker(m);
    await store.persist();
    await store.close();

    const reopened = await fresh();
    const got = await reopened.listMarkers(session.id);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(m);
    expect(await reopened.getSession(session.id)).toEqual(session);
  });

  it('loses only what was written after the last persist', async () => {
    await store.putMarker(marker(1));
    await store.persist();
    await store.putMarker(marker(2)); // never persisted
    await store.close();

    expect(await (await fresh()).listMarkers(session.id)).toHaveLength(1);
  });

  it('starts empty when nothing was ever persisted', async () => {
    expect(await new SqlJsStore({ blobStore: new MemoryBlobStore() }).init()).toBeUndefined();
  });

  it('records the schema version it wrote', async () => {
    await store.persist();
    const reopened = await fresh();
    expect(SCHEMA_VERSION).toBe(1);
    expect(await reopened.getSession(session.id)).not.toBeNull();
  });

  it('closes idempotently', async () => {
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});
