# Amendment 0001 — sleep-safe clock, and the Pi tracker

Amends `docs/timecode-markers-spec-v2.md` and `HANDOFF.md`. Apply as written: where this
document says *replace*, replace the paragraph; where it says *add*, append at the end of the
named section; new sections go at the end of the spec before **Sources**. Commit this file at
`docs/amendments/0001-clock-and-pi-tracker.md` and reference it from the spec's header.

Two changes. The first corrects a wrong claim in the spec. The second adds a hardware path
that reuses everything already specified.

---

## Part A — the clock is not sleep-safe as written

### What was wrong

§3.3 says backgrounding is harmless because the clock counts nothing — read `performance.now()`
on wake and the number is right. That is true for *backgrounding* (app not in front, screen
on). It is false for *device sleep*. The monotonic clock browsers expose stops during deep
sleep on both platforms: `mach_absolute_time` on iOS, `CLOCK_MONOTONIC` on Android. Pocket
the phone for twenty minutes and the running timecode comes back twenty minutes behind,
silently, and every marker after that is wrong by exactly that much.

The phone's oscillator itself is fine — usually the modem's TCXO, a few ppm, better than the
camera's. The problem is only which counter we read.

### A1. Replace §3.3 "The clock itself", final paragraph

Delete the paragraph beginning "This is also why backgrounding is harmless" and replace with:

> **The clock must keep counting through device sleep.** `performance.now()` does not — it is
> backed by a counter that pauses in deep sleep on both iOS and Android. Production reads
> time through `platform/clock.ts`, which on device calls a small native plugin returning
> `mach_continuous_time()` (iOS) or `SystemClock.elapsedRealtimeNanos()` (Android). Both
> advance through sleep. In the browser harness the fallback is `performance.now()` plus the
> dual-anchor guard in §3.4, which detects a paused counter rather than trusting it.

### A2. Add §3.4 "Dual anchor and the stale-lock guard"

> Every anchor stores three values, not two:
>
> ```ts
> interface Anchor { tcFrame: number; mono: number /* ns */; wall: number /* ms epoch */ }
> ```
>
> On every read of the running clock:
>
> ```ts
> const dMono = (monoNow - anchor.mono) / 1e6;   // ms
> const dWall =  wallNow - anchor.wall;          // ms
> const skew  =  dWall - dMono;
> ```
>
> `wall` is `Date.now()` — the thing §3.3 forbids for computing timecode. It is used here only
> as a witness. Under normal running, `|skew|` stays within a few hundred milliseconds (network
> time corrections are small and rare). If `|skew| > 1000 ms`, the monotonic counter paused
> while wall time kept going: the lock is **stale**.
>
> When a lock is stale:
>
> - The camera chip turns red: `STALE — re-lock`.
> - Markers are **still accepted** — losing the operator's intent is worse than an imprecise
>   time. Their timecode is computed from `dWall` instead of `dMono`, and the marker carries
>   `clock: "wall-fallback"` (default `"mono"`). Wall time is typically within ~100 ms, so the
>   marker is usable and honestly labelled.
> - On the next successful lock, markers flagged `wall-fallback` since the previous lock are
>   re-derived from their `wall` timestamp against the new anchor and the flag is cleared to
>   `"corrected"`. Store `wall` on every marker for this reason.
>
> With the native clock plugin in place, skew stays near zero and the guard never fires. It
> stays in the code as the thing that catches the day it does.

### A3. Add to §8 "Data model" — `markers` table

Add two columns:

```sql
  wall_ms      bigint not null,             -- Date.now() at pointerdown; witness + fallback
  clock        text not null default 'mono' -- mono | wall-fallback | corrected
```

Add `mono` and `wall` to the stored camera lock (`cameras.lock_quality` or a new `anchor jsonb`).

### A4. Add to §12 "Traps worth encoding"

> **`performance.now()` stops in deep sleep.** So does `CLOCK_MONOTONIC` on Linux and Android
> and `mach_absolute_time` on iOS. Read `mach_continuous_time` / `elapsedRealtimeNanos` /
> `CLOCK_BOOTTIME` for anything that must survive a pocket. Keep the wall-clock witness.

### A5. Add to §13 "Project layout" — plugins

`@egen/capacitor-continuous-clock` — in-repo Capacitor plugin, ~15 lines per platform, one
method `now(): { ns: number }`. Web implementation returns `performance.now() * 1e6`.

### A6. Amend `HANDOFF.md` — Phase 1 scope

Item 2 becomes:

> 2. `src/core/clock.ts` — anchor `{tcFrame, mono, wall}`, `rate`, `tcFrameAt(monoNow,
>    wallNow)` returning `{ frame, stale, clock }`. The clock source is injected; tests use a
>    fake. Production wires `platform/clock.ts`.

Add item 9:

> 9. `src/platform/clock.ts` and the in-repo Capacitor plugin `continuous-clock` with iOS,
>    Android and web implementations. The native files are written and committed but not
>    built in the cloud.

### A7. Amend `HANDOFF.md` — Phase 1 acceptance

Add:

> - Sleep simulation test: lock at `10:00:00;00`, advance the fake wall clock 20 minutes while
>   the fake monotonic clock advances 0, read the clock → `stale === true`,
>   `clock === "wall-fallback"`, frame equals 20 minutes of 29.97 DF frames from the anchor.
>   Then re-lock and assert the marker placed during the stale window is re-derived and
>   flagged `"corrected"`.
> - The exported `.tcfix.json` carries `clock` per marker; `TCFix.py` ignores it (no change
>   needed there — it is informational).

---

## Part B — the Pi tracker (option A: a Pi watching the LCD)

### Why this shape

A dedicated unit that does what the phone does — points a camera at the LCD and reads the
timecode — but never sleeps, never moves once mounted, has real exposure and focus control,
and can afford to run OCR continuously. Those four properties turn the phone's one-shot
"lock" into a running track:

- **No sleep problem.** Part A's guard exists because phones sleep. The Pi doesn't.
- **Fixed framing** means the ROI is calibrated once at mount time, not once per camera per
  day, and re-locks are automatic.
- **`picamera2` exposes manual exposure, gain and focus.** Lock all three for the LCD once.
  Auto-exposure hunting is the main cause of inconsistent reads on a phone; here it's off.
- **Continuous reads** mean drift is re-anchored every couple of seconds, discontinuities
  (card change under `Regenerate`, someone touching TC Preset, Rec Run stopping) are detected
  the moment they happen and logged, and with a long baseline the `rate` term from §5 becomes
  a real measurement instead of a clamp.

One Pi per camera. Several Pis on the same LAN share a clock via chrony (sub-millisecond on a
wired or good WiFi LAN), so **inter-camera offsets fall out continuously** with no phone
involvement — the §6 measurement, always current.

The phone app doesn't change its job. It gains a second way to get an anchor.

### B1. Add §16 "Pi tracker"

> #### 16.1 Hardware
>
> | Part | Choice | Why |
> |---|---|---|
> | Board | Raspberry Pi 4 (2 GB) or Pi 5 | Tesseract at 2–4 reads/s plus OpenCV template matching at frame rate. A Zero 2 W handles template matching but not continuous Tesseract; treat it as a stretch target. |
> | Camera | Camera Module 3 (standard or Wide) | Autofocus that can be **locked**; manual exposure and gain via `picamera2`. Wide helps at the short distances a rig allows. |
> | Mount | Cold-shoe → 1/4"-20 mini arm, printed enclosure | The FX30 has no EVF — the LCD is the operator's monitor. The module sits at a top corner on a short arm, looking down at ~30°, so it sees the readout without blocking the operator. Perspective is handled in software (16.3). |
> | Power | D-tap → 5 V 3 A USB-C step-down, off the rig battery | ~3 W. Same battery the camera runs on; the Pi comes up and goes down with the rig. |
> | Network | Rig WiFi or a small travel router; wired if there's a cart | Phones reach it at `tracker-<cam>.local`. |
>
> #### 16.2 Software
>
> A Python service, `pi-tracker/`, alongside the app. Python because `picamera2`, OpenCV and
> Tesseract are all native there, and because the timecode maths already exists in Python in
> `resolve-plugin/TCFix.py` — factor `frames_to_tc`, `tc_to_frames`, `RATES` into
> `tcmath.py` shared by both. Same self-test vectors, third implementation, same rule: the
> vectors are the contract.
>
> ```
> pi-tracker/
>   tracker.py        capture loop, ROI rectify, read, fit, anchor, discontinuity log
>   reader.py         Tesseract (validation) + learned-glyph template matching (per frame)
>   tcmath.py         shared with resolve-plugin/
>   server.py         HTTP + WebSocket on :8600
>   calibrate.py      one-time ROI quad + exposure/focus lock, via the same web page
>   tracker.service   systemd, restart=always
>   config.yaml       camera key, fps, drop, ROI quad, exposure, gain, focus, chrony peers
> ```
>
> Clock: `time.clock_gettime(time.CLOCK_BOOTTIME)` for the anchor, so it's the same class of
> counter as the phone's native plugin. Frame timestamps come from `picamera2`'s per-frame
> `SensorTimestamp` metadata — the exact analogue of `requestVideoFrameCallback`, and the same
> rule applies: timestamp the frame, never the read.
>
> #### 16.3 Read pipeline
>
> 1. **ROI is a quad, not a rectangle.** The module looks at the LCD off-axis; four corners
>    dragged once in the calibration page give a homography, and every frame is rectified to a
>    flat strip before reading. Calibration stores the quad and the locked exposure/gain/focus.
> 2. **Lock** is §4.1 unchanged: a 2-second burst through Tesseract, least-squares fit, the
>    same acceptance gate, the intercept is the anchor. Runs at boot and after any
>    discontinuity.
> 3. **Track** is §4.2 made real: the digits read during the lock become templates for 0–9,
>    and every subsequent frame is read by normalized cross-correlation over the eight cells —
>    cheap enough for frame rate on a Pi 4. Tesseract re-validates one frame every few seconds
>    so a drifting template can't quietly go wrong.
> 4. **Re-anchor** on a sliding 2-second window every 2 seconds. Drift against the Pi's clock
>    is therefore always under a frame, and the measured slope over ≥ 30 minutes is the
>    camera's real `rate` — logged, and exported on the camera record.
> 5. **Discontinuity** = a read more than 2 frames from the prediction, confirmed on the next
>    frame. Log it with wall time and both values (`10:14:22;07 → 00:00:00;00`), mark the
>    anchor invalid, re-lock. A **static** readout for > 2 seconds is reported as
>    `not-running` — the Rec Run / display-off case from §1 — and the chip goes red on every
>    phone.
>
> #### 16.4 Protocol
>
> `GET /tc` and a WebSocket at `/tc/stream` (one message per second) both return:
>
> ```json
> {
>   "camera": "A", "fps": "29.97", "drop": true,
>   "state": "tracking",                      // locking | tracking | not-running | lost
>   "anchor": { "tcFrame": 1104761, "boot_ns": 812345678901234 },
>   "rate": 1.0000123, "rate_baseline_s": 5400,
>   "quality": { "inliers": 58, "residual_frames": 0.3, "last_tesseract_ok": true },
>   "locked_at": "2026-09-15T18:03:40Z",
>   "events": [ { "at": "…", "kind": "discontinuity", "from": "…", "to": "…" } ]
> }
> ```
>
> `POST /time` echoes for the handshake: the phone sends `{ t0 }` (its monotonic ns); the Pi
> replies `{ t0, t1, t2 }` with its `CLOCK_BOOTTIME` at receipt and at send.
>
> #### 16.5 Phone ↔ Pi handshake
>
> The phone needs the Pi's anchor expressed in its own clock. Standard NTP arithmetic, eight
> samples, keep the one with the smallest round trip:
>
> ```
> phone sends t0        Pi receives at t1, replies at t2        phone receives at t3
> delay  = (t3 − t0) − (t2 − t1)
> offset = ((t1 − t0) + (t2 − t3)) / 2        // Pi_clock − phone_clock
> phoneAnchor.mono = piAnchor.boot_ns − offset
> phoneAnchor.tcFrame = piAnchor.tcFrame
> ```
>
> On a LAN this lands well under 5 ms — a small fraction of a frame. The phone then runs
> exactly the §3.3 clock from that anchor and re-handshakes every time the Pi's anchor changes
> (the WebSocket message carries it). If the Pi goes unreachable, the phone keeps running on
> its last anchor with the Part A guard, and the chip says `TRACKER LOST · running on last
> lock 12m`.
>
> Implementation: `platform/locksource.ts` defines `LockSource { lock(): Promise<Anchor>;
> watch(cb) }` with two implementations, `PhoneCameraLock` (§4) and `PiTrackerLock` (this
> section). The UI does not know which one it has.
>
> #### 16.6 Multi-camera without a phone
>
> Every Pi runs chrony against the same peer (the router, or one Pi elected master). Their
> `CLOCK_BOOTTIME` values differ, but each publishes its anchor alongside a chrony-disciplined
> wall time, so any client — or one Pi acting as aggregator — computes
> `offset(B→A) = tcFrameA(t) − tcFrameB(t)` at the same `t`, continuously. This is the §6
> measurement without the two manual locks, and it writes straight into the `.tcfix.json`
> camera records. `TCFix.py` is unchanged.
>
> #### 16.7 What the Pi does not fix
>
> - **Free Run is still mandatory** (§1). The tracker detects Rec Run faster and louder; it
>   cannot work around it.
> - It watches the LCD, so the LCD must show timecode. An operator cycling DISP to a clean view
>   takes the readout away; the tracker reports `lost` until it comes back. The calibration
>   page should say this in large type.
> - Reaction time (§5) is unchanged. Pre-roll still matters more than any of this.

### B2. Add §17 "Pi tracker — build order"

> Sits after Phase 2 and replaces most of Phase 3's phone-camera work, which becomes the
> fallback rather than the primary path.
>
> **Phase 3a — tracker core (cloud-buildable).** `tcmath.py` factored out of `TCFix.py` with
> the shared self-test; `reader.py` and `tracker.py` developed against **recorded frames** —
> a short video of the FX30's LCD shot with a phone, committed under `pi-tracker/fixtures/`,
> is enough to develop rectification, lock, track and discontinuity detection with no Pi
> present. `server.py` with the protocol above, tested with a fake tracker.
>
> **Phase 3b — on the Pi (desktop).** `picamera2` capture, exposure/focus lock, calibration
> page, systemd unit, chrony. One evening with the FX30 on the desk.
>
> **Phase 3c — phone client.** `PiTrackerLock`, the handshake, the `TRACKER LOST` state.
>
> **Phase 3d — phone camera lock (optional).** §4 as originally specified, now the path for
> days with no Pi on the rig.

### B3. Amend `HANDOFF.md` — "What the cloud can and cannot do"

Add to the left column: `pi-tracker/` reader, tracker and server against recorded fixtures;
`tcmath.py` and its shared self-test. Add to the right column: `picamera2` capture,
calibration on the real LCD, chrony on the rig network.

### B4. Amend §13 "Project layout"

Add at top level:

```
pi-tracker/           Python service for the Pi. See §16.
  tcmath.py           shared with resolve-plugin/ (symlink or package; one source of truth)
  fixtures/           recorded LCD footage for tests
```

### B5. Amend §15 "Open questions"

Replace item 4 with:

> 4. **Pi tracker vs. HDMI capture.** §16 reads the LCD to stay similar to the phone and to
>    leave the HDMI port alone. If the LCD read proves unreliable at rig angles, the same
>    `tracker.py` can take frames from a TC358743 HDMI-to-CSI bridge with HDMI info display
>    on — cleaner digits, no glare, at the cost of an HDMI splitter. The pipeline from step 2
>    onward is identical; only the capture source and the ROI change.

---

## Prompt for the running Claude Code session

> A new file has landed at `docs/amendments/0001-clock-and-pi-tracker.md`. Read it in full,
> then apply it: edit `docs/timecode-markers-spec-v2.md` and `HANDOFF.md` exactly as the
> amendment specifies (replace / add where it says so, new sections before **Sources**), and
> add a line under the spec's title noting that amendment 0001 has been applied. Then bring
> Phase 1 into line with Part A: the three-value anchor, `platform/clock.ts` with an injected
> clock source, the `continuous-clock` Capacitor plugin (native files written, not built), the
> `wall_ms` and `clock` columns, and the sleep-simulation acceptance test. Do not start Part B
> in this phase beyond factoring `tcmath.py` out of `resolve-plugin/TCFix.py` so both import it
> and both self-tests still pass. Commit the amendment application and the code changes
> separately, referencing `0001` in both messages.
