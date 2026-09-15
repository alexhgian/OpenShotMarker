# @egen/capacitor-continuous-clock

One method. Returns a monotonic timestamp in nanoseconds that **keeps counting while the
device is asleep**.

```ts
const { ns } = await ContinuousClock.now();
```

## Why this exists

`performance.now()`, `CLOCK_MONOTONIC` on Android and `mach_absolute_time()` on iOS all
pause in deep sleep. Pocket the phone for twenty minutes and the counter comes back twenty
minutes behind — silently. For a timecode tool that free-runs from a single anchor, every
marker after that point is wrong by exactly that much.

The counters that *do* advance through sleep are `mach_continuous_time()` on iOS and
`SystemClock.elapsedRealtimeNanos()` on Android. That is all this plugin returns.

See `docs/timecode-markers-spec-v2.md` §3.3 and §3.4, and
`docs/amendments/0001-clock-and-pi-tracker.md` Part A.

## Status

The native sources are written and committed but **have never been compiled** — Phase 1 ran
in a Linux cloud session with no Xcode and no Android SDK. Building them is a desktop step;
see `docs/phase-1-report.md`.

Both implementations are boot-relative, so values are only comparable within a single boot
of the device. Never persist one and compare it after a reboot.
