/**
 * The clock source (§3.3, §3.4).
 *
 * `performance.now()` is backed by a counter that pauses in deep sleep on both iOS and
 * Android. Pocket the phone for twenty minutes and it comes back twenty minutes behind,
 * silently, and every marker after that is wrong by exactly that much. On device we
 * therefore read `mach_continuous_time()` / `SystemClock.elapsedRealtimeNanos()` through
 * the in-repo continuous-clock plugin; both advance through sleep.
 *
 * The web implementation is still `performance.now()`, because a browser exposes nothing
 * better. That is what the §3.4 stale-lock guard is for: the harness cannot avoid the
 * paused counter, so it detects it instead of trusting it.
 *
 * mono and wall are always sampled together. Reading them apart makes the skew a
 * measurement of the gap between the two reads, which is not what it is for.
 */

import type { ClockReading } from '../core/clock';

export interface ClockSource {
  /** Monotonic milliseconds. Must advance through device sleep where the platform allows. */
  monoMs(): number;
  /** True when monoMs() survives deep sleep. False for the browser fallback. */
  readonly continuous: boolean;
  readonly name: string;
}

/** Browser fallback. Document-relative and pauses in deep sleep — hence §3.4. */
export const performanceClock: ClockSource = {
  monoMs: () => performance.now(),
  continuous: false,
  name: 'performance.now',
};

/** Shape of the native plugin (ios/android). Kept structural so no import is needed here. */
export interface ContinuousClockPlugin {
  now(): Promise<{ ns: number }>;
}

/**
 * Native clock, driven by a value the caller refreshes. The plugin bridge is async and
 * the pointerdown path must not await anything (§9), so the last native reading is held
 * with the performance.now() offset at which it was taken, and reads are computed from
 * that synchronously. A refresh every few seconds keeps it honest; between refreshes the
 * two counters only diverge if the device slept, which is precisely what §3.4 catches.
 */
export class ContinuousClockSource implements ClockSource {
  readonly continuous = true;
  readonly name = 'continuous-clock';

  private baseNativeMs = 0;
  private basePerfMs = 0;
  private primed = false;

  constructor(private readonly plugin: ContinuousClockPlugin) {}

  /** Call at startup and periodically. Safe to call often; it is one bridge round-trip. */
  async refresh(): Promise<void> {
    const perfBefore = performance.now();
    const { ns } = await this.plugin.now();
    const perfAfter = performance.now();
    // Charge half the round trip to each direction, as in any clock handshake.
    this.baseNativeMs = ns / 1e6;
    this.basePerfMs = (perfBefore + perfAfter) / 2;
    this.primed = true;
  }

  monoMs(): number {
    if (!this.primed) return performance.now();
    return this.baseNativeMs + (performance.now() - this.basePerfMs);
  }
}

/**
 * Reads both clocks at the same instant (§3.4). This is the only place Date.now() is
 * allowed to reach the timecode path, and only as the witness.
 */
export function readClock(source: ClockSource = performanceClock): ClockReading {
  return { mono: source.monoMs(), wall: Date.now() };
}

/** Picks the native source when the plugin is present, the browser fallback otherwise. */
export async function resolveClockSource(
  plugin?: ContinuousClockPlugin | null,
): Promise<ClockSource> {
  if (!plugin) return performanceClock;
  const source = new ContinuousClockSource(plugin);
  try {
    await source.refresh();
    return source;
  } catch {
    // A plugin that is registered but failing is worse than no plugin: fall back
    // rather than serve a never-primed clock that silently reads performance.now().
    return performanceClock;
  }
}
