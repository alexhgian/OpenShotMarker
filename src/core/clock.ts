/**
 * The free-running timecode clock (§3.3).
 *
 * Nothing counts ticks. A clock is an anchor — one known (tcFrame, t) pair — plus a
 * rate, and any later timecode is arithmetic on `t`. That is why backgrounding is
 * harmless: iOS throttling timers while the screen is off changes nothing. Wake the
 * phone, read the monotonic clock, the number is right.
 *
 * Pure. The caller supplies `t`; production reads `performance.now()` (§3.3 —
 * never Date.now(), an NTP correction mid-show would jump every marker after it).
 */

import { framesToTc, realFps, wrapFrame, type FpsName } from './timecode';

/** A monotonic millisecond source. Injectable so tests need no real time. */
export type MonotonicNow = () => number;

export interface Anchor {
  /** Timecode frame number that was true at `t`. */
  readonly tcFrame: number;
  /** Monotonic ms reading (performance.now()) at which `tcFrame` was true. */
  readonly t: number;
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

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) throw new Error(`rate must be finite, got ${rate}`);
  const lo = 1 - MAX_DRIFT_PPM / 1e6;
  const hi = 1 + MAX_DRIFT_PPM / 1e6;
  return Math.min(hi, Math.max(lo, rate));
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

  /**
   * §3.3: tcFrame(tNow) = anchor.tcFrame + round((tNow - anchor.t) / 1000 * realFps * rate)
   * Wrapped into a 24-hour day so a session that crosses midnight keeps counting.
   */
  tcFrameAt(tNow: number): number {
    const elapsedMs = (tNow - this._anchor.t) * this._rate;
    const frames = Math.round((elapsedMs / 1000) * realFps(this.fps));
    return wrapFrame(this._anchor.tcFrame + frames, this.fps, this.drop);
  }

  /** The label the operator glances at (§9). */
  tcAt(tNow: number): string {
    return framesToTc(this.tcFrameAt(tNow), this.fps, this.drop);
  }

  /** Milliseconds since the anchor was set — drives the "locked 47m ago" nudge (§5). */
  msSinceLock(tNow: number): number {
    return tNow - this._anchor.t;
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

export function measureOffsetFrames(reference: TcClock, other: TcClock, tNow: number): number {
  if (reference.fps !== other.fps || reference.drop !== other.drop) {
    throw new Error(
      `refusing to measure an offset across rates: reference is ${reference.fps}` +
        `${reference.drop ? ' DF' : ' NDF'}, other is ${other.fps}${other.drop ? ' DF' : ' NDF'}`,
    );
  }
  return reference.tcFrameAt(tNow) - other.tcFrameAt(tNow);
}

/** Production clock source. §3.3: performance.now() only, never Date.now(). */
export const performanceNow: MonotonicNow = () => performance.now();
