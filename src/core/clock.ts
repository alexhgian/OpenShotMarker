/**
 * The free-running timecode clock (§3.3, §3.4).
 *
 * Nothing counts ticks. A clock is an anchor — a known (tcFrame, mono, wall) triple —
 * plus a rate, and any later timecode is arithmetic on those.
 *
 * The anchor carries two time sources on purpose (§3.4). `mono` is the monotonic
 * counter the timecode is computed from. `wall` is Date.now(), which §3.3 forbids for
 * computing timecode and which is used here only as a witness: if the two disagree by
 * more than a second, the monotonic counter paused — the phone slept — and the lock is
 * stale. A stale lock still accepts markers, computed from wall time and labelled as
 * such, because losing the operator's intent is worse than an imprecise time.
 *
 * Pure. The caller supplies both readings; platform/clock.ts is what reads them.
 */

import { framesToTc, realFps, wrapFrame, type FpsName } from './timecode';

/** A monotonic millisecond source. Injectable so tests need no real time. */
export type MonotonicNow = () => number;

/** How a marker's timecode was derived (§3.4). */
export type ClockProvenance = 'mono' | 'wall-fallback' | 'corrected';

export interface Anchor {
  /** Timecode frame number that was true at this instant. */
  readonly tcFrame: number;
  /** Monotonic ms reading when `tcFrame` was true. Nanoseconds are converted at the edge. */
  readonly mono: number;
  /** Date.now() ms at the same instant. A witness, never the basis for timecode. */
  readonly wall: number;
}

/** A paired reading of both clocks. Always sampled together, or the skew is meaningless. */
export interface ClockReading {
  readonly mono: number;
  readonly wall: number;
}

export interface TcClockOptions {
  readonly fps: FpsName;
  readonly drop: boolean;
  readonly anchor: Anchor;
  /**
   * Drift term (§5), phone crystal against camera crystal. Defaults to 1.0 and should
   * only be updated from two locks more than 30 minutes apart; clamped to +/-200 ppm so
   * one bad lock cannot poison the clock.
   */
  readonly rate?: number;
}

/** §5: clamp the drift term to +/-200 ppm. */
export const MAX_DRIFT_PPM = 200;

/**
 * §3.4: above this, the monotonic counter is judged to have paused. Network time
 * corrections are small and rare, so a full second of disagreement is not one.
 */
export const STALE_SKEW_MS = 1000;

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) throw new Error(`rate must be finite, got ${rate}`);
  const lo = 1 - MAX_DRIFT_PPM / 1e6;
  const hi = 1 + MAX_DRIFT_PPM / 1e6;
  return Math.min(hi, Math.max(lo, rate));
}

export interface TcReading {
  /** The timecode frame, wrapped into the 24-hour day. */
  readonly frame: number;
  /** True when the monotonic counter paused and this came from wall time (§3.4). */
  readonly stale: boolean;
  /** Which source produced `frame`. */
  readonly clock: ClockProvenance;
  /** dWall - dMono, in ms. Exposed so the UI can show how far gone a stale lock is. */
  readonly skewMs: number;
}

export class TcClock {
  readonly fps: FpsName;
  readonly drop: boolean;
  private _anchor: Anchor;
  private _rate: number;

  constructor(opts: TcClockOptions) {
    this.fps = opts.fps;
    this.drop = opts.drop;
    this._anchor = opts.anchor;
    this._rate = clampRate(opts.rate ?? 1.0);
  }

  get anchor(): Anchor {
    return this._anchor;
  }

  get rate(): number {
    return this._rate;
  }

  /** Re-lock (§4). A new anchor replaces the old one outright. */
  setAnchor(anchor: Anchor): void {
    this._anchor = anchor;
  }

  setRate(rate: number): void {
    this._rate = clampRate(rate);
  }

  /** §3.4: dWall - dMono. Near zero while the monotonic counter is running. */
  skewMsAt(now: ClockReading): number {
    return now.wall - this._anchor.wall - (now.mono - this._anchor.mono);
  }

  /**
   * §3.3 / §3.4:
   *   frame = anchor.tcFrame + round(elapsed / 1000 * realFps * rate)
   * where `elapsed` is the monotonic delta normally, and the wall delta when the
   * monotonic counter has demonstrably paused.
   */
  readAt(now: ClockReading): TcReading {
    const dMono = now.mono - this._anchor.mono;
    const dWall = now.wall - this._anchor.wall;
    const skewMs = dWall - dMono;
    const stale = Math.abs(skewMs) > STALE_SKEW_MS;

    const elapsedMs = (stale ? dWall : dMono) * this._rate;
    const frames = Math.round((elapsedMs / 1000) * realFps(this.fps));
    return {
      frame: wrapFrame(this._anchor.tcFrame + frames, this.fps, this.drop),
      stale,
      clock: stale ? 'wall-fallback' : 'mono',
      skewMs,
    };
  }

  /** The frame alone, for callers that have already decided they do not care why. */
  tcFrameAt(now: ClockReading): number {
    return this.readAt(now).frame;
  }

  /** The label the operator glances at (§9). */
  tcAt(now: ClockReading): string {
    return framesToTc(this.readAt(now).frame, this.fps, this.drop);
  }

  /**
   * Re-derive a frame from a wall-clock instant against this anchor (§3.4). Used after a
   * re-lock to correct markers that were taken while the lock was stale.
   */
  frameAtWall(wallMs: number): number {
    const elapsedMs = (wallMs - this._anchor.wall) * this._rate;
    const frames = Math.round((elapsedMs / 1000) * realFps(this.fps));
    return wrapFrame(this._anchor.tcFrame + frames, this.fps, this.drop);
  }

  /** Milliseconds since the anchor was set — drives the "locked 47m ago" nudge (§5). */
  msSinceLock(now: ClockReading): number {
    const dMono = now.mono - this._anchor.mono;
    // A paused counter would under-report how long ago the lock was, which is exactly
    // the number the operator is being nudged by. Use the witness when it is stale.
    return Math.abs(this.skewMsAt(now)) > STALE_SKEW_MS ? now.wall - this._anchor.wall : dMono;
  }
}

/**
 * §6: offsetFrames(B -> A) = tcFrameA(t) - tcFrameB(t), evaluated at any t after both
 * locks. Two cameras against the same phone clock; no hardware, no cable.
 *
 * Semantics, fixed and written into the file, the log and the docs:
 *   A_frame = B_frame + offset_frames
 * To make camera B's clips read in camera A's timecode, add offset_frames to every B
 * clip's start timecode.
 */
export const OFFSET_MEANING = 'A_frame = B_frame + offset_frames';

export function measureOffsetFrames(
  reference: TcClock,
  other: TcClock,
  now: ClockReading,
): number {
  if (reference.fps !== other.fps || reference.drop !== other.drop) {
    throw new Error(
      `refusing to measure an offset across rates: reference is ${reference.fps}` +
        `${reference.drop ? ' DF' : ' NDF'}, other is ${other.fps}${other.drop ? ' DF' : ' NDF'}`,
    );
  }
  return reference.tcFrameAt(now) - other.tcFrameAt(now);
}
