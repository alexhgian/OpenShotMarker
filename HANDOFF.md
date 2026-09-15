# Handoff — tc-marker, cloud → desktop

**Phase 1 is built, tested and pushed. This file is now the brief for the desktop.**

The cloud session did everything a Linux box can do. What is left needs a Mac, a phone, a
Supabase project or a copy of DaVinci Resolve — nothing that remains is blocked on more
coding, only on hardware the cloud does not have.

- Code: branch `claude/new-session-sum5cr` on `alexhgian/OpenShotMarker`.
- What was built and what the tests prove: `docs/phase-1-report.md`.
- The spec: `docs/timecode-markers-spec-v2.md`, with amendment `0001` applied.

Read `docs/phase-1-report.md` before starting. This file says what to *do*; the report says
what already exists and why it is the way it is.

---

## Start here

```sh
git clone https://github.com/alexhgian/OpenShotMarker
cd OpenShotMarker
git checkout claude/new-session-sum5cr
npm i
npm run verify          # unit + cross-language + browser. Must be green before you touch anything.
```

`npm run verify` is the regression contract. If it is red on a fresh clone, stop and fix
that first — every step below assumes it is green.

| Command | What it does |
|---|---|
| `npm run dev` | The browser harness. Works with no camera, no mic, no network. |
| `npm test` | 126 unit tests. |
| `npm run coverage` | Same, plus the 100% gate on `src/core/`. |
| `npm run e2e` | 7 Playwright checks against the harness. |
| `npm run selftest:py` | `tcmath.py` and `TCFix.py` self-tests. |
| `npm run verify:crosslang` | TS writes a `.tcfix.json`; Python loads it and re-derives every frame. |
| `npm run verify` | All of the above. |
| `npm run build` / `npm run typecheck` | Production build; strict typecheck. |

Built and verified on Node 22.22, npm 10.9, Python 3.11. Nothing depends on a newer Node.

**One environment note that will bite on a Mac.** `playwright.config.ts` pins Chromium to
`/opt/pw-browsers`, which only exists in the cloud image; it falls back to normal Playwright
resolution when that path is absent, so `npm run e2e` should just work after
`npx playwright install chromium`. `CHROMIUM_PATH` overrides if you need it to.

---

## The desktop steps, in order

### 1. Build the continuous-clock plugin and prove it survives a pocket

This is the most important one, and the only step where the answer is not already known.

Amendment 0001 corrected a wrong claim in §3.3: the monotonic counter browsers expose
**pauses in deep sleep**. Pocket the phone for twenty minutes and the running timecode comes
back twenty minutes behind, silently, and every marker after that is wrong by exactly that
much. `plugins/continuous-clock/` reads `mach_continuous_time()` on iOS and
`SystemClock.elapsedRealtimeNanos()` on Android, both of which keep counting. **Those native
sources have never been compiled** — there was no Xcode and no Android SDK in the cloud.

The plugin is **installed** (`@egen/capacitor-continuous-clock`, a local `file:` dependency
on `plugins/continuous-clock/`), so `npx cap sync` already carries the native sources into
both platforms. It is deliberately **not wired**: `src/ui/App.tsx` hardcodes the browser
fallback so the harness keeps working with no device. Only that last connection is left.

In `src/ui/App.tsx`, replace the hardcoded source (around line 54):

```ts
const CLOCK: ClockSource = performanceClock;          // ← what it says now
```

with `resolveClockSource(ContinuousClock)` from `src/platform/clock.ts`, awaited during
boot — the plugin's TypeScript entry point resolves today, and `resolveClockSource` already
falls back to `performanceClock` if the plugin is absent or throws, so the harness stays
working either way. Then:

```sh
npm run build && npx cap sync
```

Expect the **first compile of the native sources to be the first compile ever**. They were
written against the documented APIs and have never been near a compiler, so budget for a
typo in the Swift or the Java; the logic is about ten lines each.

The plugin has no bundler step on purpose: its `package.json` points `main`/`module`/`types`
straight at `src/index.ts`, which Vite consumes directly. That is why there is no `dist/`
and no rollup config to maintain for an in-repo plugin.

**Then actually test it, on a phone, with your hands:** lock camera A, lock the phone, put
it in a pocket for twenty minutes, wake it, and look at the running timecode.

- Still correct, chip still green → the native clock works. This is the goal.
- Chip red, reading `STALE — re-lock` → the plugin is not being used, or is not returning a
  continuous counter. Both are informative; the guard is doing its job.
- Wrong but *green* → this is the bad one. The guard failed to notice, which means
  `STALE_SKEW_MS` or the wall-clock witness needs rethinking. Treat as spec-level.

### 2. iOS build and TestFlight

Open `ios/App/App.xcworkspace` in Xcode, sign with the eGen team, run on a device.

- CocoaPods never ran in the cloud (`npx cap sync` skipped it and said so). The first sync
  on the Mac does it.
- `Info.plist` already carries `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`
  and `NSSpeechRecognitionUsageDescription`. Nothing in Phase 1 triggers them; they are
  there for §4 and §7.
- The generated `Info.plist` permits all four orientations. §9 describes a portrait,
  one-handed tool — decide that with the app in your hand, then pin it.
- TestFlight internal testing, per §13. An eGen Apple Developer account is the only new
  account this project needs.

### 3. Supabase

```sh
supabase db push        # applies supabase/migrations/0001_markers.sql
```

It has never been applied anywhere. **Read it before you run it.** The RLS policy calls
`current_org_ids()`, which reads a `members (user_id, org_id)` table that this migration
does not create, because membership belongs to whatever auth model you settle on. Until that
table exists the policies deny everything — the safe direction to be wrong in, but it does
mean the schema is not usable until you decide. Sync itself is Phase 2 and is not written.

### 4. Resolve — the plugin's first live run

Copy **both** `resolve-plugin/TCFix.py` **and** `resolve-plugin/tcmath.py` into Resolve's
Scripts folder (§11.1). The maths was factored into `tcmath.py` so the plugin, `pi-tracker/`
and `src/core/timecode.ts` cannot drift apart; `TCFix.py` exits with an instruction rather
than a traceback if its sibling is missing.

| | |
|---|---|
| Windows | `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\` |
| macOS | `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/` |

Open a **throwaway** project, run in dry-run first, then live, and check the two items in
§11.4 — they are the point of the exercise:

1. Whether `Timeline.AddMarker`'s `frameId` is relative to `GetStartFrame()` or absolute on
   your version. If absolute, the fix is one subtraction.
2. Whether `project.GetSetting("timelineDropFrameTimecode")` returns `"1"`/`"0"` as a string
   on your version.

The self-test passes and exported files load, but nothing here has ever seen a live Resolve.

### 5. Android (optional, not a gate)

`npx cap add android` already ran and the project is committed. A debug APK needs the SDK.
Nothing in Phase 1 depends on it.

---

## What the cloud can still do, once you are back

Hand any of these to a cloud session; none of them need hardware.

| Cloud-buildable next | Needs the desktop or a rig |
|---|---|
| Phase 2 Supabase sync code and background queue | Applying the migration, deciding the auth model |
| Phase 4 EDL and FCPXML writers (§10.1, §10.2) | First live Resolve run (§11.4) |
| Phase 3a: `pi-tracker/` reader, tracker and server against recorded fixtures (§17) | `picamera2` capture, calibration on the real LCD, chrony |
| Native speech plugin wiring, with a fake recognizer in tests | Speech recognition on a real device |

**Phase 3a is the one worth queueing now.** Per §17 it only needs a short video of the
FX30's LCD, shot on a phone and committed under `pi-tracker/fixtures/` — with that, the
rectification, lock, track and discontinuity detection can all be built and tested in the
cloud with no Pi present. Shooting that clip is a five-minute desktop job that unblocks a
large cloud job.

---

## Test vectors (unchanged — the contract between all three implementations)

`src/core/timecode.ts`, `resolve-plugin/tcmath.py` and, later, `pi-tracker/` must all agree.
These are asserted in both languages today.

```
29.97 DF
  tcToFrames("00:00:59;29") + 1 → "00:01:00;02"     frames 00 and 01 dropped
  tcToFrames("00:09:59;29") + 1 → "00:10:00;00"     no drop on the tenth minute
  framesToTc(107892, drop)      → "01:00:00;00"     3600 s of 29.97 is 107892 frames
  framesToTc(107892, ndf)       → "00:59:56:12"
  tcToFrames("10:14:22;07")     → 1104761
  tcToFrames("10:18:04;11")     → 1111417
  framesToTc(1104761 − 4471)    → "10:11:53;00"     camera B offset example

Real fps
  23.976 → 23.976023…   29.97 → 29.970029…   59.94 → 59.940059…
  25, 24, 30, 50, 60 exact

FCPXML rational at 29.97
  frame 1104761 → "1105865761/30000s"               1104761 × 1001, integer only
```

Plus a 24-hour DF round-trip at 29.97 stepping by 1009 frames with 0 mismatches, and NDF
round-trips at all eight rates. `npm run verify:crosslang` walks all 24 hours — 2,569
markers — through the real Python loader.

---

## Amendments

`docs/amendments/` holds numbered changes to the spec and to this file, written after the
spec was frozen. Each says exactly what to replace or add. **Apply them in order**; the spec
on disk is authoritative only once they are applied.

- `0001-clock-and-pi-tracker.md` — **applied.** Sleep-safe clock (Part A: three-value
  anchor, `platform/clock.ts`, `continuous-clock` plugin, sleep-simulation test) and the
  Raspberry Pi tracker (Part B: §16–17, later phases). Of Part B only the `tcmath.py`
  factoring was in scope for Phase 1 and it is done; there is no `pi-tracker/` yet.

A new amendment lands the same way: write `docs/amendments/000N-*.md`, then have a session
apply it to the spec and this file in its own commit before writing any code.

---

## Kickoff prompt for the desktop session

> Read `CLAUDE.md`, then `HANDOFF.md`, then `docs/phase-1-report.md`. The spec is
> `docs/timecode-markers-spec-v2.md` with amendment 0001 applied; read the sections you
> need. Phase 1 is built and pushed — do not rebuild it.
>
> First run `npm i && npm run verify` and confirm it is green on this machine; if it is not,
> fix that before anything else and say what differed from the cloud.
>
> Then work "The desktop steps, in order" in `HANDOFF.md`, starting with step 1: install and
> wire the continuous-clock plugin, build for a device, and report what the twenty-minute
> pocket test actually showed. That result decides whether §3.4's guard stays a safety net
> or becomes the primary mechanism, so report it plainly either way — including if the
> timecode came back wrong while the chip stayed green, which is the failure the guard is
> supposed to catch and would mean the spec needs revisiting.
>
> Commit in small steps with messages that reference spec sections. If reality disagrees
> with the spec, change the spec in the same commit and say what you learned.
