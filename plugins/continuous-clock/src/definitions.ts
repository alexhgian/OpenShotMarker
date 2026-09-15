export interface ContinuousClockPlugin {
  /**
   * A monotonic timestamp in nanoseconds that advances while the device sleeps.
   *
   * iOS: `mach_continuous_time()`, converted with `mach_timebase_info`.
   * Android: `SystemClock.elapsedRealtimeNanos()`.
   * Web: `performance.now() * 1e6` — which does NOT survive sleep; the §3.4 stale-lock
   * guard exists to catch that.
   *
   * Boot-relative on every platform: comparable within one boot, meaningless across one.
   */
  now(): Promise<{ ns: number }>;
}
