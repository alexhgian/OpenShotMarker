import { describe, it, expect } from 'vitest';
import {
  RATES,
  FPS_NAMES,
  isFpsName,
  rateOf,
  realFps,
  dropAllowed,
  framesToTc,
  tcToFrames,
  framesPerDay,
  wrapFrame,
  fcpxmlRational,
} from '../../src/core/timecode';

/**
 * These are the vectors in HANDOFF.md, which are the vectors in
 * `resolve-plugin/TCFix.py --selftest`. The phone and the Resolve plugin cannot be
 * allowed to disagree silently, so the same numbers are asserted in both languages.
 */

describe('§3.1 rates', () => {
  it('knows the eight rates and nothing else', () => {
    expect(FPS_NAMES).toEqual(['23.976', '24', '25', '29.97', '30', '50', '59.94', '60']);
    expect(isFpsName('29.97')).toBe(true);
    expect(isFpsName('29.976')).toBe(false);
    expect(rateOf('29.97')).toEqual({ nominal: 30, ntsc: true });
    expect(() => rateOf('48')).toThrow(/unsupported fps/);
  });

  it('computes real fps as nominal x 1000/1001 for NTSC and exact otherwise', () => {
    expect(realFps('23.976')).toBeCloseTo(23.976023976, 9);
    expect(realFps('29.97')).toBeCloseTo(29.97002997, 9);
    expect(realFps('59.94')).toBeCloseTo(59.940059940, 9);
    for (const name of ['24', '25', '30', '50', '60'] as const) {
      expect(realFps(name)).toBe(RATES[name].nominal);
    }
  });

  it('allows drop-frame only at 29.97 and 59.94', () => {
    expect(dropAllowed('29.97')).toBe(true);
    expect(dropAllowed('59.94')).toBe(true);
    for (const name of ['23.976', '24', '25', '30', '50', '60'] as const) {
      expect(dropAllowed(name)).toBe(false);
    }
    expect(() => framesToTc(0, '25', true)).toThrow(/drop-frame only exists/);
    expect(() => tcToFrames('00:00:00:00', '25', true)).toThrow(/drop-frame only exists/);
  });
});

describe('§3.2 the handoff vectors', () => {
  it('drops frames 00 and 01 at an ordinary minute boundary', () => {
    expect(framesToTc(tcToFrames('00:00:59;29', '29.97', true) + 1, '29.97', true)).toBe(
      '00:01:00;02',
    );
  });

  it('drops nothing on the tenth minute', () => {
    expect(framesToTc(tcToFrames('00:09:59;29', '29.97', true) + 1, '29.97', true)).toBe(
      '00:10:00;00',
    );
  });

  it('puts 3600 s of 29.97 (107892 frames) at 01:00:00;00 DF and 00:59:56:12 NDF', () => {
    expect(framesToTc(107892, '29.97', true)).toBe('01:00:00;00');
    expect(framesToTc(107892, '29.97', false)).toBe('00:59:56:12');
  });

  it('converts the two example marker timecodes', () => {
    expect(tcToFrames('10:14:22;07', '29.97', true)).toBe(1104761);
    expect(tcToFrames('10:18:04;11', '29.97', true)).toBe(1111417);
  });

  it('applies the camera B offset example', () => {
    // §6: A_frame = B_frame + offset_frames, so B reads 4471 frames behind A here.
    expect(framesToTc(1104761 - 4471, '29.97', true)).toBe('10:11:53;00');
  });

  it('produces the FCPXML rational at 29.97 with integer arithmetic only', () => {
    expect(fcpxmlRational(1104761, '29.97')).toBe('1105865761/30000s');
    expect(fcpxmlRational(1104761, '30')).toBe('1104761/30s');
    expect(fcpxmlRational(100, '25')).toBe('100/25s');
    expect(() => fcpxmlRational(1.5, '25')).toThrow(/integer/);
  });
});

describe('§3.2 round-trips', () => {
  it('round-trips 24 hours of 29.97 drop-frame stepping by 1009 with 0 mismatches', () => {
    const total = framesPerDay('29.97', true);
    const mismatches: Array<{ frame: number; tc: string; back: number }> = [];
    for (let frame = 0; frame < total; frame += 1009) {
      const tc = framesToTc(frame, '29.97', true);
      const back = tcToFrames(tc, '29.97', true);
      if (back !== frame) mismatches.push({ frame, tc, back });
    }
    expect(mismatches).toEqual([]);
  });

  it('round-trips every single frame across the two known discontinuities', () => {
    // 00:00:59;29 -> 00:01:00;02 and 00:09:59;29 -> 00:10:00;00
    for (let frame = 1700; frame < 1900; frame++) {
      expect(tcToFrames(framesToTc(frame, '29.97', true), '29.97', true)).toBe(frame);
    }
    for (let frame = 17900; frame < 18100; frame++) {
      expect(tcToFrames(framesToTc(frame, '29.97', true), '29.97', true)).toBe(frame);
    }
  });

  it('round-trips 24 hours of 59.94 drop-frame', () => {
    const total = framesPerDay('59.94', true);
    for (let frame = 0; frame < total; frame += 2003) {
      expect(tcToFrames(framesToTc(frame, '59.94', true), '59.94', true)).toBe(frame);
    }
  });

  it('round-trips NDF at all eight rates', () => {
    for (const fps of FPS_NAMES) {
      const total = framesPerDay(fps, false);
      for (let frame = 0; frame < total; frame += 997) {
        const tc = framesToTc(frame, fps, false);
        expect(tcToFrames(tc, fps, false), `${fps} @ ${frame} -> ${tc}`).toBe(frame);
      }
    }
  });

  it('counts frames per day correctly', () => {
    expect(framesPerDay('29.97', false)).toBe(30 * 3600 * 24);
    expect(framesPerDay('29.97', true)).toBe(2589408);
    expect(framesPerDay('59.94', true)).toBe(5178816);
  });

  it('wraps across midnight in both directions', () => {
    const per = framesPerDay('29.97', true);
    expect(wrapFrame(per, '29.97', true)).toBe(0);
    expect(wrapFrame(per + 7, '29.97', true)).toBe(7);
    expect(wrapFrame(-1, '29.97', true)).toBe(per - 1);
    expect(framesToTc(wrapFrame(per - 1, '29.97', true), '29.97', true)).toBe('23:59:59;29');
  });
});

describe('§3.2 input validation', () => {
  it('accepts ; : and . as the frame separator', () => {
    expect(tcToFrames('10:14:22;07', '29.97', true)).toBe(1104761);
    expect(tcToFrames('10:14:22:07', '29.97', true)).toBe(1104761);
    expect(tcToFrames('10:14:22.07', '29.97', true)).toBe(1104761);
    expect(tcToFrames('  10:14:22;07 ', '29.97', true)).toBe(1104761);
  });

  it('refuses malformed timecode instead of guessing', () => {
    expect(() => tcToFrames('10:14:22', '29.97', true)).toThrow(/bad timecode/);
    expect(() => tcToFrames('aa:bb:cc:dd', '29.97', true)).toThrow(/bad timecode/);
    expect(() => tcToFrames('10:14:22;30', '29.97', true)).toThrow(/bad timecode/); // ff >= nominal
    expect(() => tcToFrames('10:60:22;07', '29.97', true)).toThrow(/bad timecode/);
    expect(() => tcToFrames('10:14:60;07', '29.97', true)).toThrow(/bad timecode/);
    expect(() => tcToFrames('24:00:00;00', '29.97', true)).toThrow(/bad timecode/);
    expect(() => framesToTc(1.5, '29.97', true)).toThrow(/integer/);
  });
});
