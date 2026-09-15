# tc-marker

Phone app for marking moments against camera timecode. Reads the camera's LCD once to lock
a timecode anchor, free-runs a local clock, logs markers by tap / text / voice, measures the
offset between cameras, and exports to DaVinci Resolve (EDL, FCPXML, and a `.tcfix.json`
consumed by `resolve-plugin/TCFix.py`).

**The spec is `docs/timecode-markers-spec-v2.md`. Read it before touching anything.** Section
numbers below refer to it.

## Stack

Vite · React · TypeScript (strict) · Tailwind · Capacitor 6 · vitest · Playwright.
Local-first SQLite (`@capacitor-community/sqlite`; `sql.js` in the browser) mirrored to
Supabase. Native speech via `@capacitor-community/speech-recognition`.

## Layout

```
src/core/       pure TS. NO DOM, NO Capacitor, NO React imports. 100% unit-tested.
src/platform/   Capacitor plugins behind interfaces; browser fallbacks for dev.
src/ui/         React. Thin. All logic lives in core/.
resolve-plugin/ TCFix.py — Python for DaVinci Resolve. Self-tested; see its docstring.
docs/           the spec.
supabase/       migrations.
```

`core/` must build and test with zero platform dependencies. If a `core/` file imports from
`platform/` or `ui/`, that is a bug.

## Non-negotiables (from the spec — do not relitigate)

- **Timecode maths** (§3): labels advance at the nominal integer rate; real fps for NTSC
  rates is `nominal × 1000/1001`. Drop-frame `perMin` divisor is **1798** at 29.97 (not
  1796). Tests must include the vectors in `HANDOFF.md`.
- **Clock** (§3.3): `performance.now()` only. Never `Date.now()` for anything that becomes
  a timecode.
- **Marker timestamp is captured synchronously in `pointerdown`** (§9), before any await,
  store write or render. Nothing after that may change it.
- **Local-first** (§2, §8): SQLite write is the commit. Sync and transcription are
  background. The marker pad never waits on the network.
- **IDs are client-generated ULIDs** (§8). Upserts are idempotent. Deletes are soft
  (`deleted_at`).
- **Offset semantics** (§6): `A_frame = B_frame + offset_frames`. Same rate and DF/NDF
  required, otherwise refuse. Keep the sentence in the file, the log, and the docs.
- **`frame` is stored alongside `tc`** on every marker (§8). Exports compute from `frame`.
- **`TCFix.py` and `core/timecode.ts` must agree.** The Python self-test vectors are the
  TypeScript test vectors. If you change one, change both, and say so in the commit.

## Working here

- Run `npm test` (vitest) before every commit. `core/` coverage stays at 100% lines.
- The browser dev harness (`npm run dev`) must always work with no device and no camera:
  manual TC entry replaces the lock, `sql.js` replaces SQLite, typed notes replace voice.
- Do **not** attempt an iOS build in a Linux environment. `npx cap add ios` (generating the
  folder) is fine; building is a Mac step, listed in `HANDOFF.md`.
- An Android debug APK is buildable on Linux if the SDK is present; it is optional, not a
  gate.
- Write copies, never mutate an operator's exported file. Exports are new files.
- Commit messages: what changed and why, one paragraph. Reference spec sections (`§3.2`).
- Prefer editing the spec over drifting from it. If reality disagrees with the spec, change
  the spec in the same PR and say what you learned.

## Things that have already gone wrong once

- Drop-frame with `perMin = 1796`: round-trips almost everywhere, fails 13× per 24h at
  minute boundaries. The test vectors catch it.
- Marker frame numbers in the example file were initially wrong by hand-calculation. Every
  example number in docs must be produced by the code, never typed.
- `Object.keys(RATES)` does not return the rates in source order. `'24'`, `'25'`, `'30'`,
  `'50'` and `'60'` are canonical array indices, so V8 emits them ahead of `'23.976'`,
  `'29.97'` and `'59.94'`. `FPS_NAMES` is written out explicitly and a test pins the order;
  do not "simplify" it back to `Object.keys`.
- `sql.js` must stay inside Vite's dependency pre-bundle (`optimizeDeps.include`). Its
  browser entry is CJS/UMD, and excluding it makes the dev server serve a file with no ESM
  default export — which builds fine for production and fails only under `npm run dev`.
- Phase 1 ran on a cloud Linux box where `npx playwright install` is blocked and the
  preinstalled Chromium is a different build from whatever `@playwright/test` resolves to.
  `playwright.config.ts` points at `/opt/pw-browsers` when it exists and falls back to
  normal resolution otherwise, so the same config works on a Mac. `CHROMIUM_PATH` overrides.
