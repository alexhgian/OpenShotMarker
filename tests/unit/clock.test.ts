import { describe, it, expect } from 'vitest';
import {
  TcClock,
  clampRate,
  measureOffsetFrames,
  MAX_DRIFT_PPM,
  OFFSET_MEANING,
  performanceNow,
} from '../../src/core/clock';
import { tcToFrames, framesPerDay, realFps } from '../../src/core/timecode';

const anchorAt = (tc: string, t: number) => ({ tcFrame: tcToFrames(tc, '29.97', true), t });

describe('§3.3 the clock', () => {
  it('returns the anchor timecode at the anchor instant', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:14:22;07', 5000) });
    expect(c.tcAt(5000)).toBe('10:14:22;07');
    expect(c.tcFrameAt(5000)).toBe(1104761);
  });

  it('advances at real fps, not nominal — 3600 s of 29.97 is 107892 frames, not 108000', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: { tcFrame: 0, t: 0 } });
    expect(c.tcFrameAt(3_600_000)).toBe(107892);
    expect(c.tcAt(3_600_000)).toBe('01:00:00;00');
  });

  it('advances at exactly nominal for the non-NTSC rates', () => {
    const c = new TcClock({ fps: '25', drop: false, anchor: { tcFrame: 0, t: 0 } });
    expect(c.tcFrameAt(3_600_000)).toBe(90_000);
    expect(c.tcAt(3_600_000)).toBe('01:00:00:00');
  });

  it('is unaffected by how long the phone was asleep — only by the reading on wake', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:00:00;00', 1000) });
    // One reading 40 minutes later is all it takes; no ticks were counted in between.
    const t = 1000 + 40 * 60 * 1000;
    expect(c.tcFrameAt(t)).toBe(c.anchor.tcFrame + Math.round(40 * 60 * realFps('29.97')));
  });

  it('re-locks by replacing the anchor outright', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:00:00;00', 0) });
    c.setAnchor(anchorAt('11:00:00;00', 60_000));
    expect(c.tcAt(60_000)).toBe('11:00:00;00');
    expect(c.anchor.t).toBe(60_000);
  });

  it('reports how long ago it locked, for the 60-minute nudge (§5)', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:00:00;00', 1000) });
    expect(c.msSinceLock(1000 + 47 * 60_000)).toBe(47 * 60_000);
  });

  it('wraps across midnight instead of running past 24 hours', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('23:59:59;29', 0) });
    const oneFrameMs = 1000 / realFps('29.97');
    expect(c.tcAt(oneFrameMs)).toBe('00:00:00;00');
    expect(c.tcFrameAt(oneFrameMs)).toBe(0);
    expect(framesPerDay('29.97', true)).toBe(2589408);
  });

  it('runs backwards sensibly for a pre-roll that predates the anchor', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:00:00;00', 10_000) });
    expect(c.tcFrameAt(8_500)).toBe(c.anchor.tcFrame - Math.round(1.5 * realFps('29.97')));
  });
});

describe('§5 the drift term', () => {
  it('defaults to 1.0', () => {
    const c = new TcClock({ fps: '29.97', drop: true, anchor: { tcFrame: 0, t: 0 } });
    expect(c.rate).toBe(1.0);
  });

  it('applies the rate to elapsed time', () => {
    const fast = new TcClock({
      fps: '30',
      drop: false,
      anchor: { tcFrame: 0, t: 0 },
      rate: 1 + 100 / 1e6, // 100 ppm fast
    });
    // 100 ppm over an hour is 360 ms, which at 30 fps is ~10.8 frames.
    expect(fast.tcFrameAt(3_600_000) - 108_000).toBe(11);
  });

  it('clamps a bad lock to +/-200 ppm so it cannot poison the clock', () => {
    expect(clampRate(1.5)).toBeCloseTo(1 + MAX_DRIFT_PPM / 1e6, 12);
    expect(clampRate(0.5)).toBeCloseTo(1 - MAX_DRIFT_PPM / 1e6, 12);
    expect(clampRate(1 + 50 / 1e6)).toBeCloseTo(1 + 50 / 1e6, 12);
    expect(() => clampRate(NaN)).toThrow(/finite/);
    const c = new TcClock({ fps: '30', drop: false, anchor: { tcFrame: 0, t: 0 }, rate: 99 });
    expect(c.rate).toBeCloseTo(1 + MAX_DRIFT_PPM / 1e6, 12);
    c.setRate(0.1);
    expect(c.rate).toBeCloseTo(1 - MAX_DRIFT_PPM / 1e6, 12);
  });
});

describe('§6 multi-camera offset', () => {
  it('measures B against A as A_frame - B_frame', () => {
    const a = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:14:22;07', 1000) });
    const b = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:11:53;00', 1000) });
    const offset = measureOffsetFrames(a, b, 1000);
    expect(offset).toBe(4471);
    // The sentence that outlives the reader's memory of which way the sign goes.
    expect(b.tcFrameAt(1000) + offset).toBe(a.tcFrameAt(1000));
    expect(OFFSET_MEANING).toBe('A_frame = B_frame + offset_frames');
  });

  it('gives the same answer at any t after both locks', () => {
    const a = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:14:22;07', 1000) });
    const b = new TcClock({ fps: '29.97', drop: true, anchor: anchorAt('10:11:53;00', 1000) });
    for (const t of [1000, 60_000, 600_000, 3_600_000]) {
      expect(measureOffsetFrames(a, b, t)).toBe(4471);
    }
  });

  it('refuses to measure across different rates or drop-frame settings', () => {
    const a = new TcClock({ fps: '29.97', drop: true, anchor: { tcFrame: 0, t: 0 } });
    const b = new TcClock({ fps: '25', drop: false, anchor: { tcFrame: 0, t: 0 } });
    const cNdf = new TcClock({ fps: '29.97', drop: false, anchor: { tcFrame: 0, t: 0 } });
    expect(() => measureOffsetFrames(a, b, 0)).toThrow(/refusing to measure an offset/);
    expect(() => measureOffsetFrames(a, cNdf, 0)).toThrow(/refusing to measure an offset/);
  });
});

describe('§3.3 the production clock source', () => {
  it('is performance.now(), monotonic and never Date.now()', () => {
    const a = performanceNow();
    const b = performanceNow();
    expect(typeof a).toBe('number');
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
