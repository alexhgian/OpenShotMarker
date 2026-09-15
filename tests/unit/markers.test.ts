import { describe, it, expect } from 'vitest';
import {
  MARKER_TYPES,
  MARKER_COLOURS,
  MARKER_LABELS,
  DEFAULT_PREROLL_MS,
  createMarker,
  createSession,
  createCamera,
  markerFrame,
  prerollFor,
  withNote,
  softDelete,
  isLive,
} from '../../src/core/markers';
import { TcClock } from '../../src/core/clock';
import { tcToFrames, realFps } from '../../src/core/timecode';
import { isUlid } from '../../src/core/ulid';

const fixedRandom = (len: number) => new Uint8Array(len).fill(0);
const NOW = 1_757_000_000_000;

const clock29 = () =>
  new TcClock({
    fps: '29.97',
    drop: true,
    anchor: { tcFrame: tcToFrames('10:14:22;07', '29.97', true), t: 5000 },
  });

const base = {
  session_id: 'S',
  camera_id: 'C',
  device: 'alex-iphone',
  nowMs: NOW,
  random: fixedRandom,
};

describe('§8 marker type to Resolve colour', () => {
  it('maps all five types, and only those five', () => {
    expect(MARKER_TYPES).toEqual(['earmark', 'great', 'cutaway', 'inout', 'note']);
    expect(MARKER_COLOURS).toEqual({
      earmark: 'Red',
      great: 'Green',
      cutaway: 'Yellow',
      inout: 'Blue',
      note: 'Cream',
    });
    expect(MARKER_LABELS.inout).toBe('In / Out');
    expect(Object.keys(MARKER_LABELS)).toHaveLength(5);
  });

  it('refuses a type that is not one of the five', () => {
    expect(() =>
      // @ts-expect-error deliberately wrong type
      createMarker({ ...base, type: 'banger', tCapturedMs: 5000, clock: clock29() }),
    ).toThrow(/unknown marker type/);
  });
});

describe('§5 pre-roll', () => {
  it('defaults to 1.5 s, and "Great" gets more than "Cutaway"', () => {
    expect(DEFAULT_PREROLL_MS.great).toBe(1500);
    expect(DEFAULT_PREROLL_MS.cutaway).toBe(1000);
    expect(DEFAULT_PREROLL_MS.great).toBeGreaterThan(DEFAULT_PREROLL_MS.cutaway);
    expect(prerollFor('great')).toBe(1500);
    expect(prerollFor('great', 2000)).toBe(2000);
    expect(prerollFor('great', 0)).toBe(0);
  });

  it('refuses a negative pre-roll — a marker after the tap is never wanted', () => {
    expect(() => prerollFor('great', -1)).toThrow(/preroll must be >= 0/);
    expect(() => prerollFor('great', NaN)).toThrow(/preroll must be >= 0/);
  });

  it('lands the marker before the tap, by pre-roll converted at real fps', () => {
    const clock = clock29();
    // 1.5 s at 29.97 real fps is 45 frames (44.955 rounded).
    expect(Math.round(1.5 * realFps('29.97'))).toBe(45);
    expect(markerFrame(clock, 5000, 1500)).toBe(1104761 - 45);
    expect(markerFrame(clock, 5000, 0)).toBe(1104761);
  });

  it('wraps a pre-roll that crosses back over midnight', () => {
    const clock = new TcClock({ fps: '29.97', drop: true, anchor: { tcFrame: 0, t: 0 } });
    expect(markerFrame(clock, 0, 1500)).toBe(2589408 - 45);
  });
});

describe('§8 createMarker', () => {
  it('stores frame alongside tc, and they agree', () => {
    const m = createMarker({ ...base, type: 'great', tCapturedMs: 5000, clock: clock29() });
    expect(m.frame).toBe(1104761 - 45);
    // 1104761 - 45; value taken from TCFix.frames_to_tc, never hand-calculated.
    expect(m.tc).toBe('10:14:20;22');
    expect(tcToFrames(m.tc, '29.97', true)).toBe(m.frame);
  });

  it('fills every column the schema requires', () => {
    const m = createMarker({
      ...base,
      type: 'cutaway',
      tCapturedMs: 5000,
      clock: clock29(),
      note: 'crowd wide',
      source: 'voice',
    });
    expect(isUlid(m.id)).toBe(true);
    expect(m.session_id).toBe('S');
    expect(m.camera_id).toBe('C');
    expect(m.type).toBe('cutaway');
    expect(m.color).toBe('Yellow');
    expect(m.note).toBe('crowd wide');
    expect(m.source).toBe('voice');
    expect(m.preroll_ms).toBe(1000);
    expect(m.audio_path).toBeNull();
    expect(m.device).toBe('alex-iphone');
    expect(m.created_at).toBe(new Date(NOW).toISOString());
    expect(m.updated_at).toBe(m.created_at);
    expect(m.deleted_at).toBeNull();
  });

  it('defaults source to tap and note to empty', () => {
    const m = createMarker({ ...base, type: 'note', tCapturedMs: 5000, clock: clock29() });
    expect(m.source).toBe('tap');
    expect(m.note).toBe('');
    expect(m.color).toBe('Cream');
  });

  it('carries an audio path when voice recorded one', () => {
    const m = createMarker({
      ...base,
      type: 'note',
      tCapturedMs: 5000,
      clock: clock29(),
      audio_path: '/local/a.m4a',
    });
    expect(m.audio_path).toBe('/local/a.m4a');
  });

  it('honours a per-marker pre-roll override', () => {
    const m = createMarker({
      ...base,
      type: 'great',
      tCapturedMs: 5000,
      clock: clock29(),
      prerollMs: 3000,
    });
    expect(m.preroll_ms).toBe(3000);
    expect(m.frame).toBe(1104761 - Math.round(3 * realFps('29.97')));
  });

  it('defaults its wall clock to now without touching the timecode clock', () => {
    const m = createMarker({
      session_id: 'S',
      camera_id: 'C',
      device: 'd',
      type: 'great',
      tCapturedMs: 5000,
      clock: clock29(),
    });
    expect(m.frame).toBe(1104761 - 45);
    expect(isUlid(m.id)).toBe(true);
  });

  it('depends only on the captured instant, never on when it was called', () => {
    // The whole point of §9 rule 1: passing the same tCapturedMs must give the same
    // frame however much later createMarker runs.
    const clock = clock29();
    const a = createMarker({ ...base, type: 'great', tCapturedMs: 5000, clock });
    const b = createMarker({ ...base, type: 'great', tCapturedMs: 5000, clock, nowMs: NOW + 9e6 });
    expect(b.frame).toBe(a.frame);
    expect(b.tc).toBe(a.tc);
  });
});

describe('§8 edits, soft deletes and sync', () => {
  it('bumps updated_at when a note is edited', () => {
    const m = createMarker({ ...base, type: 'great', tCapturedMs: 5000, clock: clock29() });
    const edited = withNote(m, 'the hair flip', NOW + 60_000);
    expect(edited.note).toBe('the hair flip');
    expect(edited.updated_at).toBe(new Date(NOW + 60_000).toISOString());
    expect(edited.id).toBe(m.id);
    expect(edited.frame).toBe(m.frame);
    expect(withNote(m, 'x').note).toBe('x');
  });

  it('soft-deletes so the delete reaches the server as a row, not an absence', () => {
    const m = createMarker({ ...base, type: 'great', tCapturedMs: 5000, clock: clock29() });
    expect(isLive(m)).toBe(true);
    const gone = softDelete(m, NOW + 1000);
    expect(gone.deleted_at).toBe(new Date(NOW + 1000).toISOString());
    expect(gone.updated_at).toBe(gone.deleted_at);
    expect(isLive(gone)).toBe(false);
    expect(softDelete(m).deleted_at).not.toBeNull();
  });
});

describe('§8 sessions and cameras', () => {
  it('creates a session with a ULID and defaults the reference camera to A', () => {
    const s = createSession({
      label: 'elfyou — Tuesday',
      fps: '29.97',
      drop_frame: true,
      device: 'alex-iphone',
      nowMs: NOW,
      random: fixedRandom,
    });
    expect(isUlid(s.id)).toBe(true);
    expect(s.reference_camera).toBe('A');
    expect(s.fps).toBe('29.97');
    expect(s.drop_frame).toBe(true);
    expect(s.created_at).toBe(new Date(NOW).toISOString());
    expect(s.updated_at).toBe(s.created_at);
  });

  it('accepts an explicit reference camera and defaults its clock to now', () => {
    const s = createSession({
      label: 'x',
      fps: '25',
      drop_frame: false,
      device: 'd',
      reference_camera: 'B',
    });
    expect(s.reference_camera).toBe('B');
  });

  it('creates a camera with zero offset until one is measured', () => {
    const c = createCamera({
      session_id: 'S',
      key: 'B',
      fps: '29.97',
      drop_frame: true,
      label: 'FX30 wide',
      bin_hint: 'CAM B',
      nowMs: NOW,
      random: fixedRandom,
    });
    expect(isUlid(c.id)).toBe(true);
    expect(c.key).toBe('B');
    expect(c.label).toBe('FX30 wide');
    expect(c.bin_hint).toBe('CAM B');
    expect(c.offset_frames).toBe(0);
    expect(c.offset_measured_at).toBeNull();
    expect(c.offset_confidence_frames).toBeNull();
    expect(c.roi).toBeNull();
    expect(c.last_locked_at).toBeNull();
    expect(c.lock_quality).toBeNull();
  });

  it('defaults label and bin hint to null', () => {
    const c = createCamera({ session_id: 'S', key: 'A', fps: '25', drop_frame: false });
    expect(c.label).toBeNull();
    expect(c.bin_hint).toBeNull();
  });
});
