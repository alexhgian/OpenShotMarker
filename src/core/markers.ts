/**
 * Markers (§8, §9).
 *
 * The one rule that outranks the rest: the timestamp is captured synchronously in
 * pointerdown, before any await, any store write, any DOM work (§9). Everything here
 * takes an already-captured `tCapturedMs` — this module cannot read a clock, so it
 * cannot accidentally read one late. `captureNow()` in the UI is the only reader.
 *
 * Pure. No DOM, no Capacitor, no React.
 */

import { framesToTc, realFps, wrapFrame, type FpsName } from './timecode';
import { TcClock, type ClockReading, type ClockProvenance } from './clock';
import { ulid, type RandomBytes, cryptoRandom } from './ulid';

export const MARKER_TYPES = ['earmark', 'great', 'cutaway', 'inout', 'note'] as const;
export type MarkerType = (typeof MARKER_TYPES)[number];

export type MarkerSource = 'tap' | 'voice' | 'typed';

/** §8: marker types map to Resolve colour names. TCFix.py validates against the same set. */
export const MARKER_COLOURS: Record<MarkerType, string> = {
  earmark: 'Red',
  great: 'Green',
  cutaway: 'Yellow',
  inout: 'Blue',
  note: 'Cream',
};

export const MARKER_LABELS: Record<MarkerType, string> = {
  earmark: 'Earmark',
  great: 'Great',
  cutaway: 'Cutaway',
  inout: 'In / Out',
  note: 'Note',
};

/**
 * §5: reaction time (500-2000 ms) dominates every other error source by an order of
 * magnitude, so markers land *before* the tap. Per type, because "Great" wants more
 * pre-roll than "Cutaway".
 */
export const DEFAULT_PREROLL_MS: Record<MarkerType, number> = {
  earmark: 1500,
  great: 1500,
  cutaway: 1000,
  inout: 1000,
  note: 1500,
};

export interface Marker {
  id: string;
  session_id: string;
  camera_id: string;
  tc: string;
  frame: number;
  type: MarkerType;
  color: string;
  note: string;
  source: MarkerSource;
  preroll_ms: number;
  /** Date.now() at pointerdown (§3.4). The witness, and what a correction re-derives from. */
  wall_ms: number;
  /** How this marker's timecode was derived (§3.4): mono | wall-fallback | corrected. */
  clock: ClockProvenance;
  audio_path: string | null;
  device: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateMarkerInput {
  session_id: string;
  camera_id: string;
  type: MarkerType;
  /**
   * Both clock readings, sampled together in pointerdown (§3.4). Never read a clock in
   * here — this module cannot, which is the point.
   */
  captured: ClockReading;
  clock: TcClock;
  device: string;
  note?: string;
  source?: MarkerSource;
  /** Overrides DEFAULT_PREROLL_MS for this type. */
  prerollMs?: number;
  audio_path?: string | null;
  /** Wall-clock ms for `created_at` and the ULID prefix — ordering only, never a timecode. */
  nowMs?: number;
  random?: RandomBytes;
}

export function prerollFor(type: MarkerType, override?: number): number {
  const ms = override ?? DEFAULT_PREROLL_MS[type];
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`preroll must be >= 0 ms, got ${ms}`);
  return ms;
}

/** Pre-roll expressed in frames at this clock's real rate (§5). */
function prerollFrames(clock: TcClock, prerollMs: number): number {
  return Math.round((prerollMs / 1000) * realFps(clock.fps));
}

/**
 * Frame the marker should land on: the captured instant, rolled back by the pre-roll
 * (§5). Computed in real frames, then wrapped into the 24-hour day.
 *
 * Carries the provenance out with it (§3.4): if the monotonic counter had paused, this
 * frame came from wall time and the marker must say so rather than look exact.
 */
export function markerFrame(
  clock: TcClock,
  captured: ClockReading,
  prerollMs: number,
): { frame: number; clock: ClockProvenance } {
  const reading = clock.readAt(captured);
  const rolledBack = reading.frame - prerollFrames(clock, prerollMs);
  return { frame: wrapFrame(rolledBack, clock.fps, clock.drop), clock: reading.clock };
}

export function createMarker(input: CreateMarkerInput): Marker {
  const {
    session_id,
    camera_id,
    type,
    captured,
    clock,
    device,
    note = '',
    source = 'tap',
    audio_path = null,
    nowMs = Date.now(),
    random = cryptoRandom,
  } = input;

  if (!MARKER_TYPES.includes(type)) throw new Error(`unknown marker type ${JSON.stringify(type)}`);

  const preroll_ms = prerollFor(type, input.prerollMs);
  const { frame, clock: provenance } = markerFrame(clock, captured, preroll_ms);
  const created = new Date(nowMs).toISOString();

  return {
    id: ulid(nowMs, random),
    session_id,
    camera_id,
    tc: framesToTc(frame, clock.fps, clock.drop),
    frame,
    type,
    color: MARKER_COLOURS[type],
    note,
    source,
    preroll_ms,
    wall_ms: captured.wall,
    clock: provenance,
    audio_path,
    device,
    created_at: created,
    updated_at: created,
    deleted_at: null,
  };
}

/**
 * §3.4: after a successful re-lock, every marker taken while the lock was stale is
 * re-derived from its wall timestamp against the new anchor, and flagged `corrected`.
 * The pre-roll is re-applied, because `wall_ms` is the raw pointerdown instant.
 *
 * Markers already on `mono` are returned untouched — correcting a good marker against a
 * newer anchor would move a number that was right.
 */
export function correctMarker(marker: Marker, clock: TcClock, nowMs: number = Date.now()): Marker {
  if (marker.clock !== 'wall-fallback') return marker;
  const frame = wrapFrame(
    clock.frameAtWall(marker.wall_ms) - prerollFrames(clock, marker.preroll_ms),
    clock.fps,
    clock.drop,
  );
  return {
    ...marker,
    frame,
    tc: framesToTc(frame, clock.fps, clock.drop),
    clock: 'corrected',
    updated_at: new Date(nowMs).toISOString(),
  };
}

/** Editing a note is last-writer-wins on updated_at (§8). */
export function withNote(marker: Marker, note: string, nowMs: number = Date.now()): Marker {
  return { ...marker, note, updated_at: new Date(nowMs).toISOString() };
}

/** Deletes are soft (§8): a delete on the phone reaches the server as a row, not an absence. */
export function softDelete(marker: Marker, nowMs: number = Date.now()): Marker {
  const at = new Date(nowMs).toISOString();
  return { ...marker, deleted_at: at, updated_at: at };
}

export function isLive(marker: Marker): boolean {
  return marker.deleted_at === null;
}

export interface Session {
  id: string;
  label: string;
  fps: FpsName;
  drop_frame: boolean;
  reference_camera: string;
  device: string;
  created_at: string;
  updated_at: string;
}

export interface Camera {
  id: string;
  session_id: string;
  key: string;
  label: string | null;
  fps: FpsName;
  drop_frame: boolean;
  roi: { x: number; y: number; w: number; h: number } | null;
  offset_frames: number;
  offset_measured_at: string | null;
  offset_confidence_frames: number | null;
  bin_hint: string | null;
  last_locked_at: string | null;
  lock_quality: { inliers: number; residual_frames: number } | null;
}

export function createSession(input: {
  label: string;
  fps: FpsName;
  drop_frame: boolean;
  device: string;
  reference_camera?: string;
  nowMs?: number;
  random?: RandomBytes;
}): Session {
  const nowMs = input.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();
  return {
    id: ulid(nowMs, input.random ?? cryptoRandom),
    label: input.label,
    fps: input.fps,
    drop_frame: input.drop_frame,
    reference_camera: input.reference_camera ?? 'A',
    device: input.device,
    created_at: at,
    updated_at: at,
  };
}

export function createCamera(input: {
  session_id: string;
  key: string;
  fps: FpsName;
  drop_frame: boolean;
  label?: string | null;
  bin_hint?: string | null;
  nowMs?: number;
  random?: RandomBytes;
}): Camera {
  const nowMs = input.nowMs ?? Date.now();
  return {
    id: ulid(nowMs, input.random ?? cryptoRandom),
    session_id: input.session_id,
    key: input.key,
    label: input.label ?? null,
    fps: input.fps,
    drop_frame: input.drop_frame,
    roi: null,
    offset_frames: 0,
    offset_measured_at: null,
    offset_confidence_frames: null,
    bin_hint: input.bin_hint ?? null,
    last_locked_at: null,
    lock_quality: null,
  };
}
