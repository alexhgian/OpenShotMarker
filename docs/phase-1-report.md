# Phase 1 report — tc-marker

Built in a cloud Linux session, per `HANDOFF.md`. Everything below runs and is asserted
here; nothing in this file is a plan or an intention.

**Status: Phase 1 acceptance met.** 113 unit tests, 6 browser tests, `src/core/` at 100%
lines, functions, statements and branches, and the TypeScript and Python halves of the
timecode maths verified against each other on a file the UI actually produced.

Run everything with `npm run verify` (unit → cross-language → browser).

---

## What was built

| Area | Files | What it does |
|---|---|---|
| Timecode maths (§3.1–3.2) | `src/core/timecode.ts` | Rates table, `framesToTc`, `tcToFrames`, `realFps`, `framesPerDay`/`wrapFrame`, `fcpxmlRational` |
| The clock (§3.3, §5, §6) | `src/core/clock.ts` | Anchor + rate, `tcFrameAt`, drift clamp, offset measurement |
| Markers (§5, §8) | `src/core/markers.ts`, `src/core/ulid.ts` | Marker/session/camera creation, pre-roll, type→colour, soft delete, ULIDs |
| Exports (§10.3, §10.4) | `src/core/export/{csv,tcfix}.ts` | CSV and `.tcfix.json` |
| Schema (§8) | `src/core/schema.ts`, `supabase/migrations/0001_markers.sql` | SQLite and Postgres, same shape |
| Store (§2, §8) | `src/platform/{store,sqljs-store,blob}.ts` | Interface + sql.js over IndexedDB |
| UI (§9) | `src/ui/{App.tsx,recorder.ts}` | The single screen |
| Native shell | `capacitor.config.ts`, `android/`, `ios/` | Folders only, neither built |

`src/core/` imports nothing outside itself — no React, no Capacitor, no DOM. That is not a
convention here, it is `tests/unit/architecture.test.ts`, which fails the build otherwise.

## What the tests prove

**The timecode maths matches the Resolve plugin.** All seven `HANDOFF.md` vectors pass, and
each expected value was produced by `TCFix.py` before it was written into the test — no
number in this repo was hand-calculated. Beyond the vectors: a full 24-hour drop-frame
round-trip at 29.97 stepping by 1009 frames (0 mismatches), every single frame across both
known discontinuities, a 24-hour round-trip at 59.94 DF, and NDF round-trips at all eight
rates.

**The two implementations agree on a real file, not just on paper.** `npm run
verify:crosslang` has the TypeScript exporter write a `.tcfix.json` spanning all 24 hours at
29.97 DF — 2,569 markers, landing on and around every drop-frame discontinuity — then loads
it with the real `TCFix.load_fixfile` and re-derives every `frame` from its `tc` with the
real `TCFix.tc_to_frames`. 0 disagreements. It also renders each frame *back* to a label,
which is what catches a timecode that parses but does not exist (`00:01:00;00` at 29.97 DF).
The browser test repeats this on a file downloaded from the UI itself.

**The marker timestamp cannot drift behind the store write (§9).** This is structural, not
a comment: `MarkerRecorder.capture()` is not an `async` function, so it cannot contain an
`await` — the compiler enforces it, and changing that breaks every caller. Four tests pin
the behaviour, the sharpest being a store whose write never settles: the clock is advanced
ten seconds mid-flight and the frame that eventually lands is identical to the one returned
synchronously. A fifth test reads `App.tsx` and fails if the handler gains `async`/`await`,
if the capture moves after the first `setState`, or if the pad is rewired from `pointerdown`
to `click`.

**The local-first path works with no network and survives a restart.** The Playwright suite
locks camera A by typing `10:00:00;00` at 29.97 DF, taps **Great**, and asserts the marker
lands 40–75 frames behind the running clock — the 45 frames of default pre-roll (§5), plus
slack for the frames that pass between reading the clock and dispatching the event — then
reloads and finds the row still there, which is what proves sql.js reached IndexedDB rather
than living in memory. Deletes are soft: gone from the list, still present for sync.

## What changed in the spec, and why

Both changes came out of the build, and both are committed alongside the code that caused
them.

1. **§3.3 — an anchor must not be persisted across a process restart.** `anchor.t` is only
   meaningful inside the `performance.now()` epoch it was taken in, and that epoch dies with
   the page. Restoring one would give confidently wrong timecode instead of an obvious
   failure. Markers persist; the lock does not, and the operator re-locks, which §4 already
   makes cheap. Asserted after a reload in the browser test.
2. **§8 — "recent markers, newest first" is indexed on `created_at`, not `frame`.** A
   re-lock can move the timecode backwards, and the operator's list has to stay in the order
   they tapped. Exports still walk a session in frame order, which has its own index.

Three traps were added to `CLAUDE.md`: `Object.keys` on the rates table does not return
source order (`'24'`, `'25'`, `'30'`, `'50'`, `'60'` are canonical array indices, so V8
hoists them); `sql.js` must stay inside Vite's dependency pre-bundle or the dev server
serves a CJS file with no ESM default export — which builds fine for production and fails
only under `npm run dev`; and this environment's Playwright/Chromium version mismatch.

## Deliberately not done

Untouched, per "Out of scope for Phase 1": OCR, `getUserMedia`, Tesseract, speech
recognition, runtime Supabase sync, EDL and FCPXML writers, and iOS/Android builds.

One boundary call worth naming: `fcpxmlRational()` exists in `timecode.ts` because the
handoff lists the rational-time vector (`frame 1104761 → "1105865761/30000s"`) among the
Phase 1 test vectors. It is the integer-only §10.2 arithmetic and nothing else — there is no
FCPXML writer, which stays in Phase 4.

Two stubs are honest about being stubs. The Supabase RLS policy depends on a `members`
table the migration does not create, so as written it denies everything until the desktop
step settles the auth model — the safe direction to be wrong in, and noted in the file.
`queueDepth()` counts every local row, because Phase 1 has no sync and therefore no
watermark; the query shape is what the §9 badge needs.

---

## The desktop steps that remain

Nothing below can be done from a Linux cloud session.

1. **Clone and install.**
   ```sh
   git clone <repo> && cd tc-marker && npm i
   npm run verify          # unit + cross-language + browser, all green before you start
   npm run build && npx cap sync
   ```

2. **iOS on a real phone.** Open `ios/App/App.xcworkspace` in Xcode, sign with the eGen
   team, run on a device.
   - **Verify the one assumption this design rests on (§3.3):** that `performance.now()`
     keeps advancing across a lock/unlock. Lock camera A, lock the phone, wait a few
     minutes, wake it, and check the running timecode is still correct — not merely
     running. If it is not, the free-run clock needs a different monotonic source and that
     is a spec-level change, not a bug fix.
   - `Info.plist` already carries `NSCameraUsageDescription`,
     `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`. Nothing in
     Phase 1 triggers them; they are there for §4 and §7.
   - The generated `Info.plist` permits all four orientations. §9 describes a portrait,
     one-handed tool — decide this with the app in your hand, then pin it.
   - CocoaPods was not available in the cloud session, so `pod install` has never run. It
     will run on the first `npx cap sync` on the Mac.

3. **Supabase.** `supabase db push` applies `supabase/migrations/0001_markers.sql`. It has
   never been applied anywhere. Before it is useful, decide the auth model and create the
   `members (user_id, org_id)` table the RLS policy reads, or replace
   `current_org_ids()` with whatever you settle on — until then the policies deny
   everything.

4. **Resolve (§11.1, §11.4).** Copy `resolve-plugin/TCFix.py` into Resolve's Scripts
   folder, open a throwaway project, and run it in dry-run first. `python3
   resolve-plugin/TCFix.py --selftest` passes here and the exported files load, but the
   plugin has still never been run against a live Resolve. The two things §11.4 asks you
   to check on that first run are the point of the exercise.

5. **Android (optional, not a gate).** `npx cap add android` has already been run and the
   project is committed. A debug APK needs the SDK; nothing in Phase 1 depends on it.
