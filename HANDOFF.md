# Handoff — tc-marker, Phase 1 in Claude Code (cloud)

This bundle is meant to be committed to a fresh repository and handed to Claude Code running
in a cloud environment. It contains the spec, the project conventions (`CLAUDE.md`), a
finished Resolve plugin, and this brief. Nothing else exists yet.

## What the cloud can and cannot do

| Works in a cloud Linux session | Needs a Mac / a real device / Resolve |
|---|---|
| All of `src/core/` with full tests | iOS build and TestFlight upload (Xcode) |
| React UI + browser dev harness, Playwright checks | Camera lock on a real LCD |
| `sql.js` local store, Supabase schema and sync code | Native speech recognition on device |
| Capacitor project scaffold, `npx cap add android` / `add ios` (folders only) | First live run of `TCFix.py` inside Resolve (§11.4) |
| Android debug APK, if the SDK is installed (optional) | Focus/exposure lock (Phase 5 native plugin) |

**Phases 1 and 2 are cloud-complete.** Phase 3's OCR pipeline can be written and unit-tested
in the cloud against recorded frames, but its acceptance is on a phone pointed at the FX30.
Phase 4's exports are cloud-complete; the plugin's first live run is not.

## Setup

1. Create an empty repo (e.g. `egen-co/tc-marker`). Commit the contents of this bundle at
   the root: `CLAUDE.md`, `HANDOFF.md`, `docs/`, `resolve-plugin/`.
2. Start a Claude Code cloud session on that repo.
3. Paste the kickoff prompt at the bottom of this file.

The cloud session will not have your local MCP tools (the orchestrator bridge, Resolve,
device access). It does not need them for Phase 1.

## Phase 1 — scope

Build the tool that works with **no camera, no microphone and no network**:

1. `src/core/timecode.ts` — rates table, `framesToTc`, `tcToFrames`, `realFps`. Tested
   against the vectors below.
2. `src/core/clock.ts` — anchor `{tcFrame, t}`, `rate`, `tcFrameAt(tNow)`. Injectable clock
   for tests; production uses `performance.now()`.
3. `src/core/markers.ts` — marker creation with pre-roll, type→colour map, ULIDs.
4. `src/core/export/csv.ts` and `src/core/export/tcfix.ts` — the latter must produce a file
   that `python resolve-plugin/TCFix.py --selftest`'s loader accepts, and whose frame
   numbers match `example.tcfix.json` for the same inputs.
5. `src/platform/store.ts` — the store interface, `sql.js` implementation for the browser,
   schema per §8 (SQLite dialect of the Postgres shown there).
6. `src/ui/` — one screen (§9): session strip with manual-TC "lock" for each camera, running
   timecode, five-button pad, typed note, recent markers list, export via download in the
   browser (share sheet comes with Capacitor).
7. Capacitor scaffold: `capacitor.config.ts`, `npx cap add android`, `npx cap add ios`
   (folders committed, not built). `NSCameraUsageDescription` and
   `NSMicrophoneUsageDescription` placeholders in `Info.plist` for later phases.
8. `supabase/migrations/0001_markers.sql` — the §8 schema in Postgres, with RLS enabled and
   a permissive org policy stub. Not applied from the cloud; committed for the desktop step.

## Phase 1 — acceptance

- `npm test` green; `src/core/` at 100% line coverage.
- Test vectors below all pass, plus a 24-hour DF round-trip at 29.97 stepping by 1009 frames
  with 0 mismatches, and NDF round-trips at all eight rates.
- Playwright (headless Chromium is available in the environment): open the dev harness,
  enter manual TC `10:00:00;00` at 29.97 DF, tap **Great**, assert a marker row appears with
  a timecode ≤ 1.5 s before the running clock (default pre-roll), reload the page, assert
  the marker is still there (sql.js persisted to IndexedDB).
- Export `.tcfix.json`; run `python resolve-plugin/TCFix.py --selftest` and a tiny extra
  check that loads the exported file with `TCFix.load_fixfile` and re-derives every
  marker's `frame` from its `tc` with `TCFix.tc_to_frames` — must match exactly.
- The pointerdown handler that creates a marker contains no `await` before the timestamp
  is captured. Add a lint rule or a unit test that proves the timestamp is taken before
  the store write resolves.

## Test vectors (the same ones `TCFix.py --selftest` uses)

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

## Out of scope for Phase 1 — do not start these

- Any OCR, `getUserMedia`, or Tesseract code.
- Speech recognition.
- Supabase sync at runtime (schema only).
- EDL and FCPXML writers (Phase 4; the maths is in §10 when you get there).
- iOS or Android builds.

## What comes back to the desktop afterwards

1. Clone, `npm i`, `npx cap sync`, open `ios/` in Xcode, sign with the eGen team, run on a
   phone. Confirm `performance.now()` keeps advancing across a lock/unlock (§3.3).
2. `supabase db push` for the migration.
3. Copy `resolve-plugin/TCFix.py` into Resolve's Scripts folder (§11.1), run it against a
   throwaway project in dry-run, then live, and check the two items in §11.4.

---

## Kickoff prompt (paste into Claude Code)

> Read `CLAUDE.md`, then `HANDOFF.md`, then `docs/timecode-markers-spec-v2.md` in full.
> Build Phase 1 exactly as scoped in `HANDOFF.md`. Start with `src/core/timecode.ts` and
> its tests using the vectors in the handoff — do not write any UI until the core tests are
> green and `python resolve-plugin/TCFix.py --selftest` passes in this environment. Then the
> clock, markers, store, exports, and finally the single-screen UI with a Playwright check.
> Do not begin anything listed under "Out of scope". Commit in small steps with messages
> that reference spec sections. If the spec turns out to be wrong about something, fix the
> spec in the same commit and explain what you learned. When Phase 1 acceptance is met,
> stop and write `docs/phase-1-report.md`: what was built, what the tests prove, and the
> exact desktop steps remaining.
