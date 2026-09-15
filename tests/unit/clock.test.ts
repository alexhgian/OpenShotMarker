import { describe, it, expect } from 'vitest';
import {
  TcClock,
  clampRate,
  measureOffsetFrames,
  MAX_DRIFT_PPM,
  STALE_SKEW_MS,
  OFFSET_MEANING,
  type ClockReading,
} from '../../src/core/clock';
import { tcToFrames, framesPerDay, realFps } from '../../src/core/timecode';

/** Both clocks agree — the normal case, monotonic counter running. */
const running = (ms: number): ClockReading => ({ mono: ms, wall: 1_757_000_000_000 + ms });

const anchorAt = (tc: string, ms: number) => ({
  tcFrame: tcToFrames(tc, '29.97', true),
  ...running(ms),
});

describe('§3.3 the clock', () => {
  it('returns the anchor timecode at the anchor instant', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:14:22;07', 5000) });
    expect(c.tcAt(running(5000))).toBe('10:14:22;07');
    expect(c.tcFrameAt(running(5000))).toBe(1104761);
  });

  it('advances at real fps, not nominal — 3600 s of 29.97 is 107892 frames, not 108000', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('00:00:00;00', 0) });
    expect(c.tcFrameAt(running(3_600_000))).toBe(107892);
    expect(c.tcAt(running(3_600_000))).toBe('01:00:00;00');
  });

  it('advances at exactly nominal for the non-NTSC rates', () => {
    const c = new TcClock({
      fps: '25',
      drop: false,
      anchor: { tcFrame: 0, ...running(0) },
    });
    expect(c.tcFrameAt(running(3_600_000))).toBe(90_000);
    expect(c.tcAt(running(3_600_000))).toBe('01:00:00:00');
  });

  it('re-locks by replacing the anchor outright', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:00:00;00', 0) });
    c.setAnchor(anchorAt('11:00:00;00', 60_000));
    expect(c.tcAt(running(60_000))).toBe('11:00:00;00');
    expect(c.anchor.mono).toBe(60_000);
  });

  it('reports how long ago it locked, for the 60-minute nudge (§5)', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:00:00;00', 1000) });
    expect(c.msSinceLock(running(1000 + 47 * 60_000))).toBe(47 * 60_000);
  });

  it('wraps across midnight instead of running past 24 hours', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('23:59:59;29', 0) });
    const oneFrameMs = 1000 / realFps('29.97');
    expect(c.tcAt(running(oneFrameMs))).toBe('00:00:00;00');
    expect(framesPerDay('29.97', true)).toBe(2589408);
  });

  it('runs backwards sensibly for a pre-roll that predates the anchor', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:00:00;00', 10_000) });
    expect(c.tcFrameAt(running(8_500))).toBe(
      c.anchor.tcFrame - Math.round(1.5 * realFps('29.97')),
    );
  });
});

describe('§3.4 dual anchor and the stale-lock guard', () => {
  it('reports mono provenance and near-zero skew while the counter is running', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:00:00;00', 0) });
    const r = c.readAt(running(600_000));
    expect(r.clock).toBe('mono');
    expect(r.stale).toBe(false);
    expect(r.skewMs).toBe(0);
  });

  it('tolerates a small clock correction without calling the lock stale', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:00:00;00', 0) });
    // 400 ms of NTP correction: real, small, and not a paused counter.
    const r = c.readAt({ mono: 60_000, wall: 1_757_000_000_000 + 60_400 });
    expect(r.stale).toBe(false);
    expect(r.clock).toBe('mono');
    expect(STALE_SKEW_MS).toBe(1000);
  });

  /**
   * The acceptance test from amendment 0001 A7: the phone sleeps for 20 minutes, so the
   * monotonic counter does not move while wall time does.
   */
  it('detects a 20-minute sleep and falls back to wall time', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:00:00;00', 0) });
    const twentyMin = 20 * 60_000;

    const r = c.readAt({ mono: 0, wall: 1_757_000_000_000 + twentyMin });

    expect(r.stale).toBe(true);
    expect(r.clock).toBe('wall-fallback');
    expect(r.skewMs).toBe(twentyMin);
    // 20 minutes of 29.97 real frames from the anchor — not 20 minutes of nominal 30.
    expect(r.frame).toBe(
      tcToFrames('10:00:00;00', '29.97', true) + Math.round((twentyMin / 1000) * realFps('29.97')),
    );
  });

  it('does not silently under-report the age of a stale lock', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:00:00;00', 0) });
    const twentyMin = 20 * 60_000;
    // The counter says no time has passed; the operator needs the truth for the nudge.
    expect(c.msSinceLock({ mono: 0, wall: 1_757_000_000_000 + twentyMin })).toBe(twentyMin);
  });

  it('catches a backwards skew too — a counter that jumped ahead is equally untrustworthy', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:00:00;00', 0) });
    const r = c.readAt({ mono: 60_000, wall: 1_757_000_000_000 + 1_000 });
    expect(r.stale).toBe(true);
    expect(r.skewMs).toBe(-59_000);
  });

  it('re-derives a frame from a wall instant, for the post-re-lock correction', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:00:00;00', 0) });
    const tenMin = 10 * 60_000;
    expect(c.frameAtWall(1_757_000_000_000 + tenMin)).toBe(
      tcToFrames('10:00:00;00', '29.97', true) + Math.round((tenMin / 1000) * realFps('29.97')),
    );
  });

  it('exposes the raw skew so the UI can say how far gone a lock is', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:00:00;00', 0) });
    expect(c.skewMsAt({ mono: 1000, wall: 1_757_000_000_000 + 4000 })).toBe(3000);
  });
});

describe('§5 the drift term', () => {
  it('defaults to 1.0', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('00:00:00;00', 0) });
    expect(c.rate).toBe(1.0);
  });

  it('applies the rate to elapsed time', () => {
    const fast = new TcClock({
      fps: '30',
      drop: false,
      anchor: { tcFrame: 0, ...running(0) },
      rate: 1 + 100 / 1e6,
    });
    expect(fast.tcFrameAt(running(3_600_000)) - 108_000).toBe(11);
  });

  it('applies the rate to the wall fallback and to a wall re-derivation too', () => {
    const fast = new TcClock({
      fps: '30',
      drop: false,
      anchor: { tcFrame: 0, mono: 0, wall: 0 },
      rate: 1 + 100 / 1e6,
    });
    expect(fast.readAt({ mono: 0, wall: 3_600_000 }).frame - 108_000).toBe(11);
    expect(fast.frameAtWall(3_600_000) - 108_000).toBe(11);
  });

  it('clamps a bad lock to +/-200 ppm so it cannot poison the clock', () => {
    expect(clampRate(1.5)).toBeCloseTo(1 + MAX_DRIFT_PPM / 1e6, 12);
    expect(clampRate(0.5)).toBeCloseTo(1 - MAX_DRIFT_PPM / 1e6, 12);
    expect(clampRate(1 + 50 / 1e6)).toBeCloseTo(1 + 50 / 1e6, 12);
    expect(() => clampRate(NaN)).toThrow(/finite/);
    const c = new TcClock({
      fps: '30',
      drop: false,
      anchor: { tcFrame: 0, ...running(0) },
      rate: 99,
    });
    expect(c.rate).toBeCloseTo(1 + MAX_DRIFT_PPM / 1e6, 12);
    c.setRate(0.1);
    expect(c.rate).toBeCloseTo(1 - MAX_DRIFT_PPM / 1e6, 12);
  });
});

describe('§6 multi-camera offset', () => {
  it('measures B against A as A_frame - B_frame', () => {
    const a = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:14:22;07', 1000) });
    const b = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:11:53;00', 1000) });
    const offset = measureOffsetFrames(a, b, running(1000));
    expect(offset).toBe(4471);
    expect(b.tcFrameAt(running(1000)) + offset).toBe(a.tcFrameAt(running(1000)));
    expect(OFFSET_MEANING).toBe('A_frame = B_frame + offset_frames');
  });

  it('gives the same answer at any t after both locks', () => {
    const a = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:14:22;07', 1000) });
    const b = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:11:53;00', 1000) });
    for (const t of [1000, 60_000, 600_000, 3_600_000]) {
      expect(measureOffsetFrames(a, b, running(t))).toBe(4471);
    }
  });

  it('refuses to measure across different rates or drop-frame settings', () => {
    const a = new TcClock({ fps: '29.97', drop: true, anchor: { tcFrame: 0, ...running(0) } });
    const b = new TcClock({ fps: '25', drop: false, anchor: { tcFrame: 0, ...running(0) } });
    const cNdf = new TcClock({
      fps: '29.97',
      drop: false,
      anchor: { tcFrame: 0, ...running(0) },
    });
    expect(() => measureOffsetFrames(a, b, running(0))).toThrow(/refusing to measure an offset/);
    expect(() => measureOffsetFrames(a, cNdf, running(0))).toThrow(
      /reference is 29\.97 DF, other is 29\.97 NDF/,
    );
    expect(() => measureOffsetFrames(cNdf, a, running(0))).toThrow(
      /reference is 29\.97 NDF, other is 29\.97 DF/,
    );
  });
});
