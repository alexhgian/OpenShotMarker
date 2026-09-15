/**
 * Timecode maths (§3).
 *
 * This file is the TypeScript half of a pair: `resolve-plugin/TCFix.py` holds the
 * Python half, and the two must agree exactly. The self-test vectors in TCFix.py
 * are the test vectors in `tests/unit/timecode.test.ts`. Change one, change both.
 *
 * Pure. No DOM, no Capacitor, no React.
 */

/** Fps names the app and the Resolve plugin both understand (§3.1). */
export const RATES = {
  '23.976': { nominal: 24, ntsc: true },
  '24': { nominal: 24, ntsc: false },
  '25': { nominal: 25, ntsc: false },
  '29.97': { nominal: 30, ntsc: true },
  '30': { nominal: 30, ntsc: false },
  '50': { nominal: 50, ntsc: false },
  '59.94': { nominal: 60, ntsc: true },
  '60': { nominal: 60, ntsc: false },
} as const;

export type FpsName = keyof typeof RATES;

/**
 * Explicit, source-ordered. NOT `Object.keys(RATES)`: '24', '25', '30', '50' and '60'
 * are canonical array indices, so V8 hoists them ahead of the string keys and the
 * table iterates 24,25,30,50,60,23.976,29.97,59.94. Anything user-facing that walks
 * the rates (a picker, an error message) would come out shuffled.
 */
export const FPS_NAMES: FpsName[] = [
  '23.976',
  '24',
  '25',
  '29.97',
  '30',
  '50',
  '59.94',
  '60',
];

export function isFpsName(value: string): value is FpsName {
  return Object.prototype.hasOwnProperty.call(RATES, value);
}

/** `{nominal, ntsc}` for an fps name, or a useful error listing the valid ones. */
export function rateOf(fps: string): { nominal: number; ntsc: boolean } {
  if (!isFpsName(fps)) {
    throw new Error(`unsupported fps ${JSON.stringify(fps)} (want one of ${FPS_NAMES.join(', ')})`);
  }
  return RATES[fps];
}

/**
 * Real frames per second (§3.1). Labels advance at the nominal integer rate; for the
 * NTSC family real time runs slower by exactly 1000/1001. Getting this wrong at 29.97
 * costs 3.6 s per hour — 108 frames — which is a different take, not a rounding error.
 */
export function realFps(fps: string): number {
  const { nominal, ntsc } = rateOf(fps);
  return ntsc ? (nominal * 1000) / 1001 : nominal;
}

/** Drop-frame only exists at 29.97 and 59.94 (§3.1). */
export function dropAllowed(fps: string): boolean {
  const { nominal, ntsc } = rateOf(fps);
  return ntsc && (nominal === 30 || nominal === 60);
}

function droppedPerMinute(nominal: number): number {
  return nominal === 30 ? 2 : 4;
}

function assertDropOk(fps: string, drop: boolean): void {
  if (drop && !dropAllowed(fps)) {
    throw new Error('drop-frame only exists at 29.97 / 59.94');
  }
}

const p2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Frame number → timecode label (§3.2).
 *
 * The drop-frame `perMin` divisor is 1798 at 29.97, NOT 1796. `perMin - dropped`
 * round-trips correctly almost everywhere and fails 13 times per 24 hours, always at
 * a minute boundary. The 24-hour round-trip test is what catches it.
 */
export function framesToTc(frame: number, fps: string, drop: boolean): string {
  const { nominal } = rateOf(fps);
  assertDropOk(fps, drop);
  if (!Number.isInteger(frame)) throw new Error(`frame must be an integer, got ${frame}`);

  let f = frame;
  if (drop) {
    const dropped = droppedPerMinute(nominal);
    const per10Min = Math.round(((nominal * 1000) / 1001) * 600); // 17982 @ 29.97
    const perMin = Math.round(((nominal * 1000) / 1001) * 60); //  1798 @ 29.97
    const d = Math.floor(f / per10Min);
    const m = f % per10Min;
    f +=
      m > dropped
        ? dropped * 9 * d + dropped * Math.floor((m - dropped) / perMin)
        : dropped * 9 * d;
  }

  const ff = f % nominal;
  const ss = Math.floor(f / nominal) % 60;
  const mm = Math.floor(f / (nominal * 60)) % 60;
  const hh = Math.floor(f / (nominal * 3600)) % 24;
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}${drop ? ';' : ':'}${p2(ff)}`;
}

/** Timecode label → frame number (§3.2). Accepts ':' , ';' or '.' as the frame separator. */
export function tcToFrames(tc: string, fps: string, drop: boolean): number {
  const { nominal } = rateOf(fps);
  assertDropOk(fps, drop);

  const parts = tc.trim().replace(/;/g, ':').replace(/\./g, ':').split(':');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) {
    throw new Error(`bad timecode ${JSON.stringify(tc)}`);
  }
  const [hh, mm, ss, ff] = parts.map(Number) as [number, number, number, number];
  if (mm > 59 || ss > 59 || ff >= nominal || hh > 23) {
    throw new Error(`bad timecode ${JSON.stringify(tc)} for ${fps}`);
  }

  let frame = ((hh * 60 + mm) * 60 + ss) * nominal + ff;
  if (drop) {
    const dropped = droppedPerMinute(nominal);
    const totalMin = hh * 60 + mm;
    frame -= dropped * (totalMin - Math.floor(totalMin / 10));
  }
  return frame;
}

/** Total frames in 24 hours of labels at this rate — the wrap point for the clock. */
export function framesPerDay(fps: string, drop: boolean): number {
  const { nominal } = rateOf(fps);
  assertDropOk(fps, drop);
  const nominalPerDay = nominal * 3600 * 24;
  if (!drop) return nominalPerDay;
  // 24h has 1440 minutes; every minute drops except every tenth.
  return nominalPerDay - droppedPerMinute(nominal) * (1440 - 144);
}

/** Wrap a frame number into [0, framesPerDay) so a session can cross midnight. */
export function wrapFrame(frame: number, fps: string, drop: boolean): number {
  const per = framesPerDay(fps, drop);
  return ((frame % per) + per) % per;
}

/**
 * FCPXML rational time for a frame at this rate (§10.2). NTSC rates are exact only as
 * a fraction: n/1001 over 1000×nominal. Integer arithmetic only — a float here loses
 * the last digit and Final Cut silently rounds the marker onto the wrong frame.
 *
 * The writer itself is Phase 4; this is the maths the handoff's test vector pins down.
 */
export function fcpxmlRational(frame: number, fps: string): string {
  const { nominal, ntsc } = rateOf(fps);
  if (!Number.isInteger(frame)) throw new Error(`frame must be an integer, got ${frame}`);
  if (!ntsc) return `${frame}/${nominal}s`;
  return `${frame * 1001}/${nominal * 1000}s`;
}
