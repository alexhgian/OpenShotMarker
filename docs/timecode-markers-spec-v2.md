# Timecode Markers — technical spec, v2 (standalone app)

Earwig-style shot marking as its own phone app: read the camera's timecode off its LCD once,
free-run a local clock from there, log moments by button, text or voice, measure the offset
between cameras, and hand DaVinci Resolve one file that fixes camera timecode and imports
the markers with colours.

**What changed from v1.** This is no longer a section of the vMix control panel. It is a
Capacitor-wrapped web app that runs anywhere the camera does. That deletes the TLS
prerequisite entirely, lets voice recognition run on-device, and makes the tool useful on
shoots with no vMix box in sight. Shared state moves from the panel's JSON files to a
local-first store that syncs to Supabase — beside the clips it describes.

Sections 3–5 and 10.1–10.3 are carried over from v1 unchanged; the maths in them was
verified in code and the verification is repeated in the shipped Resolve plugin's
`--selftest`.

---

## 1. The one prerequisite

### The camera must be in Free Run

`MENU → TC/UB → Time Code Run → Free Run`.

The whole architecture rests on the camera's timecode advancing at a constant rate whether
or not it is rolling. In **Rec Run** the timecode advances *only while recording*, so a
free-running local clock is wrong the moment you stop — and wrong by the length of every
gap, cumulatively. No drift correction saves this.

| Setting | Value | Why |
|---|---|---|
| `Time Code Run` | **Free Run** | Required, as above. |
| `Time Code Make` | `Preset` | `Regenerate` reads the card and can jump the TC between cards. |
| `Time Code Format` | DF or NDF, your call | Fixed to `[-]` at 23.98p/24.00p — the camera won't let you choose. |
| `TC/UB Disp. Setting` | Time Code | Otherwise the readout shows user bits and the OCR reads the wrong number. |

The app detects a Rec Run mistake: during the lock burst the timecode either advances at the
expected rate or it doesn't. A static readout means Rec Run with the camera stopped, or the
TC display off. Refuse the lock and say which.

**On multi-camera shoots, do this too:** set every camera to Free Run and preset them to the
same value on a count. Two people pressing Set together lands within a frame or two. The
offset measurement in §6 is the fix for when that didn't happen — it is not a reason to skip
it.

---

## 2. Architecture

```
  Phone — Capacitor app  (capacitor://localhost is a secure context: no TLS needed)
  ┌──────────────────────────────────────────────────────────────────┐
  │  core/            pure TypeScript, zero DOM, unit-tested          │
  │    timecode.ts    rates, DF/NDF, frames ⇄ TC                     │
  │    clock.ts       anchor + performance.now() → running TC        │
  │    lockfit.ts     burst reads → least-squares fit → anchor/gate  │
  │    offsets.ts     anchor(camA) − anchor(camB) → offset_frames    │
  │    export/        edl.ts · fcpxml.ts · csv.ts · tcfix.ts         │
  │                                                                  │
  │  platform/        Capacitor plugins behind thin interfaces       │
  │    camera         getUserMedia in WKWebView (v1) · native (v2)   │
  │    speech         native on-device recogniser                    │
  │    store          SQLite, local-first                            │
  │    share          native share sheet for exports                 │
  │                                                                  │
  │  ui/              React + Tailwind. Pad, clock, lock, sessions   │
  └────────────────────────────┬─────────────────────────────────────┘
                               │  background sync when there's signal
                               ▼
  Supabase  — sessions · cameras · markers   (next to the existing clips table)
                               │
                               ▼  .tcfix.json  (AirDrop / Files / Syncthing)
  DaVinci Resolve  — TCFix.py under Workspace › Scripts
                     shifts Start TC on cam B's bin · imports coloured markers
```

**Anchors never leave the phone.** Each camera lock produces `{tcFrame₀, t₀}` against the
phone's monotonic clock. Markers are resolved to timecode strings at tap time and stored as
strings plus frame numbers. Offsets between cameras are resolved to a frame count. The
server and Resolve only ever see timecode and frames — nothing about the phone's clock.

**Local-first is not optional.** The phone is the only device in the room that is guaranteed
to exist. Every marker is durable in SQLite the instant it is tapped; Supabase is a mirror
that catches up when it can. If the venue has no signal all day, nothing is lost and the
export still works from the phone.

---

## 3. The timecode clock

### 3.1 Rates

Timecode labels always advance at the *nominal integer* rate. For the NTSC family, real time
runs slower by exactly 1000/1001.

| Name | Label rate | Real fps | DF allowed |
|---|---|---|---|
| 23.976 | 24 | 23.9760 | no (camera fixes it to `[-]`) |
| 24 | 24 | 24.0000 | no |
| 25 | 25 | 25.0000 | no |
| 29.97 | 30 | 29.9700 | yes |
| 30 | 30 | 30.0000 | no |
| 50 | 50 | 50.0000 | no |
| 59.94 | 60 | 59.9401 | yes |
| 60 | 60 | 60.0000 | no |

`realFps = nominal × (isNTSC ? 1000/1001 : 1)`; frames elapsed over `Δt` real seconds is
`Δt × realFps`. Getting this wrong at 29.97 costs 3.6 seconds per hour — 108 frames — which
is not a rounding error, it is a different take.

### 3.2 Frames → timecode

```ts
export function framesToTc(frame: number, nominal: number, isNtsc: boolean, drop: boolean): string {
  if (drop) {
    const dropped  = nominal === 30 ? 2 : 4;
    const per10Min = Math.round(nominal * (1000 / 1001) * 600);  // 17982 @ 29.97
    const perMin   = Math.round(nominal * (1000 / 1001) * 60);   //  1798 @ 29.97
    const d = Math.floor(frame / per10Min);
    const m = frame % per10Min;
    frame += m > dropped
      ? dropped * 9 * d + dropped * Math.floor((m - dropped) / perMin)
      : dropped * 9 * d;
  }
  const ff =  frame % nominal;
  const ss =  Math.floor(frame /  nominal)         % 60;
  const mm =  Math.floor(frame / (nominal * 60))   % 60;
  const hh =  Math.floor(frame / (nominal * 3600)) % 24;
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}${drop ? ';' : ':'}${p2(ff)}`;
}

export function tcToFrames(tc: string, nominal: number, drop: boolean): number {
  const [hh, mm, ss, ff] = tc.replace(';', ':').split(':').map(Number);
  let frame = ((hh * 60 + mm) * 60 + ss) * nominal + ff;
  if (drop) {
    const dropped  = nominal === 30 ? 2 : 4;
    const totalMin = hh * 60 + mm;
    frame -= dropped * (totalMin - Math.floor(totalMin / 10));
  }
  return frame;
}
```

**The `perMin` divisor is 1798, not 1796.** `perMin − dropped` is the classic bug: it
round-trips correctly almost everywhere and fails 13 times per 24 hours, always at a minute
boundary. Verified against both known discontinuities, a full 24-hour round-trip at 29.97 DF
(0 mismatches), and NDF round-trips at all eight rates. The same checks live in
`TCFix.py --selftest` so the phone and the Resolve plugin can never disagree silently.

```
00:00:59;29 → next 00:01:00;02      ✓ (frames 00 and 01 dropped)
00:09:59;29 → next 00:10:00;00      ✓ (no drop on the tenth minute)
3600s of 29.97 = 107892 frames → DF 01:00:00;00, NDF 00:59:56:12   ✓
```

### 3.3 The clock itself

```ts
tcFrame(tNow) = anchor.tcFrame + Math.round((tNow - anchor.t) / 1000 * realFps * rate)
```

`performance.now()` only — never `Date.now()`. An NTP correction or a timezone change during
a show would otherwise jump every marker after it. `rate` defaults to `1.0` and is the drift
term (§5).

This is also why backgrounding is harmless: iOS throttling timers while the screen is off
changes nothing, because nothing is counting ticks. Wake the phone, read `performance.now()`,
the number is right. (Verify on device that `performance.now()` keeps advancing across a
lock/unlock — it does on current iOS and Android, but it is the one assumption here that a
platform could break.)

**An anchor does not survive a process restart, and must not be persisted as if it did.**
`anchor.t` is meaningful only within the `performance.now()` epoch it was taken in, and that
epoch ends when the page or the app is killed. Restoring one across a restart would produce
confidently wrong timecode rather than an obvious failure, so markers persist and the lock
does not: on relaunch the camera shows as unlocked and the operator re-locks. This is cheap
(§4: a re-lock is point-and-hold once the ROI is stored) and it is the safe direction to be
wrong in. The browser harness asserts it after a reload.

---

## 4. The OCR lock

### 4.1 Why a burst, not a read

A single OCR of an LCD can be confidently wrong — `8` for `0`, `5` for `6`. Confidence scores
do not reliably catch it. Temporal consistency does: a *correct* sequence of reads must
increase monotonically, by exactly one frame per frame period, at a known rate. Random errors
do not land on that line.

1. **Calibrate once per camera.** Drag a box over the timecode readout. The normalized ROI
   is stored on the camera record, so a re-lock later in the day is point-and-hold.
2. **Burst.** ~2 seconds via `video.requestVideoFrameCallback()`. Timestamp each frame from
   its metadata, **not** from when OCR finished.
3. **Recognize.** Tesseract.js on the ROI only, whitelist `0123456789:;`, single-line mode.
   Crop → 3–4× upscale → greyscale → local threshold. The FX30's readout is an ordinary
   sans-serif face on a dark bar, not seven-segment; stock `eng` traineddata handles it.
4. **Fit and gate.** Least-squares `tcFrames` against `captureTime`. Accept only if ≥ 8
   inliers, slope within ±0.5% of expected `realFps`, all residuals < 1 frame, monotonic.
   The **intercept is the anchor** — better than any single read. Rejections carry a reason:
   "hold steadier", "move closer", "timecode isn't running — check Free Run".

Do not derive `rate` from this fit; over 2 seconds the slope is good to ±2%, far worse than
assuming nominal. Slope is a validity check, not a measurement.

### 4.2 Native upgrade path

Tesseract in the WebView is fine for v1 because the burst approach doesn't need speed. If it
struggles in dark venues, the upgrade is a small Capacitor plugin calling iOS Vision's
`VNRecognizeTextRequest` (ML Kit Text Recognition on Android) — both are very good at exactly
this, and both run entirely on-device. Same burst-and-fit on top; only the recognizer swaps.

A native camera plugin also brings focus lock, exposure lock, torch and zoom, none of which
web `getUserMedia` reliably exposes on iOS. Lock focus and exposure once the ROI is framed;
the LCD is a fixed-brightness target and auto-exposure hunting is the main cause of
inconsistent reads.

---

## 5. Error budget

| Source | Magnitude | Notes |
|---|---|---|
| Operator reaction time | **500–2000 ms** | Dominates everything else by an order of magnitude. |
| Lock intercept (after fit) | ~±1 frame | The accurate part. |
| Camera LCD render lag | 1–3 frames | Systematic; folds into pre-roll calibration. |
| Frame capture timestamp | ~±1 frame | With `requestVideoFrameCallback` metadata. |
| Oscillator drift | see below | Grows with time since lock. |

Drift, phone crystal against camera crystal, at 25 fps:

| Offset | Per hour | In frames |
|---|---|---|
| 10 ppm | 36 ms | 0.9 |
| 30 ppm | 108 ms | 2.7 |
| 50 ppm | 180 ms | 4.5 |
| 100 ppm | 360 ms | 9.0 |

**Re-lock once an hour and drift never becomes the limiting factor.** Show "locked 47 min
ago" and nudge past 60 minutes. Only update `rate` from two locks more than 30 minutes apart
(±11 ppm at an hour; ±67 ppm at ten minutes, which is worse than assuming 1.0), and clamp it
to ±200 ppm so a bad lock cannot poison the clock.

### Pre-roll

Because reaction time dominates, markers should land *before* the tap. A configurable pre-roll
(default **−1.5 s**, per marker type) is the single highest-value accuracy feature in this
document. "Great" wants more pre-roll than "Cutaway".

---

## 6. Multi-camera: measuring the offset

Two cameras with different timecode are two anchors against the same phone clock:

```
offsetFrames(B→A) = tcFrameA(t) − tcFrameB(t)       evaluated at any t after both locks
```

Precision is the sum of the two lock intercepts — about ±1 frame. No hardware, no cable,
no second app. The measurement is stored on camera B's record with the timestamp it was taken
and the quality of both locks that produced it.

**Semantics, fixed and written into the file:** `A_frame = B_frame + offset_frames`. To make
camera B's clips read in camera A's timecode, add `offset_frames` to every B clip's start
timecode. The Resolve plugin does exactly that and nothing else.

Rules:

- Both cameras must share a frame rate and DF/NDF setting or the offset is refused. A
  cross-rate offset is expressible in real seconds, but Resolve applies timecode in frames,
  and mixing the two is how you end up two frames off with no idea why.
- The reference camera is chosen per session, once. Markers are stored in its timecode.
- Re-locking either camera re-derives the offset. Show the new value beside the old one; a
  jump larger than a few frames means a lock was bad or somebody touched TC Preset.

**Where it goes.** Everything else — the fix file, the plugin, the exports — consumes this
one number. The app does not attempt to rewrite the camera's timecode in the field.

---

## 7. Voice notes

Native speech recognition via a Capacitor plugin (iOS `SFSpeechRecognizer`, Android
`SpeechRecognizer`). Both support on-device recognition; request it and fall back to the
server path only if the device says on-device is unavailable for the locale.

- **The marker's time comes from the button press, never from the transcript.** The row
  exists at `pointerdown`; the text attaches later, asynchronously, and may arrive after the
  row is already on screen.
- Interim results on screen so the operator sees it heard them without looking away from the
  shot.
- **A failed transcript never loses the marker.** Timeout or error leaves the row with an
  empty note and a "tap to type" affordance.
- Keep the raw audio for the utterance (a few seconds, compressed) attached to the marker.
  A garbled note can be re-transcribed later; a missing one can't. Purge audio on successful
  Supabase sync if storage matters.

---

## 8. Data model

Local SQLite is the truth; Supabase mirrors it. Same shape in both.

```sql
create table sessions (
  id           text primary key,          -- ULID
  label        text not null,
  fps          text not null,             -- '29.97'
  drop_frame   boolean not null,
  reference_camera text not null,         -- camera id
  device       text not null,
  created_at   timestamptz not null,
  updated_at   timestamptz not null
);

create table cameras (
  id           text primary key,          -- ULID
  session_id   text not null references sessions(id) on delete cascade,
  key          text not null,             -- 'A', 'B' — what the operator sees
  label        text,                      -- 'FX30 main'
  fps          text not null,
  drop_frame   boolean not null,
  roi          jsonb,                     -- normalized {x,y,w,h}, per camera
  offset_frames integer not null default 0,   -- this_frame + offset = reference_frame
  offset_measured_at timestamptz,
  offset_confidence_frames real,
  bin_hint     text,                      -- Resolve bin name, optional
  last_locked_at timestamptz,
  lock_quality jsonb,                     -- {inliers, residual_frames}
  unique (session_id, key)
);

create table markers (
  id           text primary key,          -- ULID, client-generated: idempotent sync
  session_id   text not null references sessions(id) on delete cascade,
  camera_id    text not null references cameras(id),   -- always the reference camera in v1
  tc           text not null,             -- '10:14:22;07'
  frame        integer not null,          -- what every export computes from
  type         text not null,             -- earmark | great | cutaway | inout | note
  color        text not null,             -- Resolve colour name
  note         text not null default '',
  source       text not null,             -- tap | voice | typed
  preroll_ms   integer not null,
  audio_path   text,                      -- local only, never synced
  device       text not null,
  created_at   timestamptz not null,
  updated_at   timestamptz not null,
  deleted_at   timestamptz                -- soft delete; sync is append/merge, not diff
);
```

`frame` is stored alongside `tc` deliberately: it is what every export computes from, and
recomputing it from the string later means re-deriving drop-frame state you already knew.

The operator-facing "recent markers, newest first" (§9) is indexed on `created_at`, not on
`frame`: a re-lock can move the timecode backwards, and the list has to stay in the order the
operator tapped. Exports walk a session in timeline order instead, which has its own index on
`frame`.

Marker types map to Resolve colours:

| Type | Label | Resolve colour |
|---|---|---|
| `earmark` | Earmark | `Red` |
| `great` | Great | `Green` |
| `cutaway` | Cutaway | `Yellow` |
| `inout` | In / Out | `Blue` |
| `note` | Note | `Cream` |

**Sync rules.** Client-generated ULIDs make every upsert idempotent, so retries after a
flaky radio can't duplicate. Soft-delete via `deleted_at` so a delete on the phone reaches
the server as a row, not as an absence. Last-writer-wins on `updated_at` is sufficient — two
people editing the same marker's note at once is not a real scenario. Row-level security:
sessions are visible to the org; a marker's `device` is informational, not an ACL.

---

## 9. UI

Single-screen tool, portrait, one hand. Top to bottom:

- **Session strip.** Label, fps, camera chips: `A · LOCKED 47m` / `B · LOCKED 12m · −4471f`.
  Tap a chip to (re)lock that camera. Amber past 60 minutes, red if never locked.
- **Running timecode**, large, monospace, in the reference camera's TC. What the operator
  glances at.
- **Marker pad.** Five big targets. Tapped by someone not looking at the phone.
- **Voice**, press-and-hold. Interim transcript appears under the pad.
- **Recent markers**, newest first, inline-editable, sync state visible per row (local ·
  queued · synced).
- **Export** in the overflow menu: `.tcfix.json` · EDL · FCPXML · CSV → native share sheet.

Two rules that matter more than the layout:

1. **Capture the timestamp synchronously in `pointerdown`** — before any `await`, any
   store write, any DOM work. Nothing after that is allowed to move the number.
2. **The pad never waits on anything.** SQLite write is the commit; sync and transcript
   are background details. Show queue depth so the operator knows the phone is holding
   markers the server hasn't seen.

Camera lock flow is a full-screen sheet: viewfinder with the saved ROI drawn on it, "hold
steady" ring that fills over the 2-second burst, then either a green `LOCKED 10:14:22;07`
or a red reason. First time for a camera, the sheet starts with ROI drag.

---

## 10. Export

### 10.1 DaVinci Resolve — EDL

Imported with **Timeline → Import → Timeline Markers from EDL**:

```
TITLE: elfyou 2026-09-15
FCM: DROP FRAME

001  001      V     C        10:14:22:07 10:14:22:08 10:14:22:07 10:14:22:08
 |C:ResolveColorGreen |M:second chorus, the hair flip |D:1

002  001      V     C        10:18:04:11 10:18:04:12 10:18:04:11 10:18:04:12
 |C:ResolveColorYellow |M:crowd wide |D:1
```

- `FCM:` is `DROP FRAME` or `NON-DROP FRAME` and must match the timeline.
- Event lines use `:` even for drop-frame; the `FCM:` line carries that fact.
- `|D:` is duration in frames; `1` for a point marker. Out point is in + 1 frame.
- Colours: `Blue Cyan Green Yellow Red Pink Purple Fuchsia Rose Lavender Sky Mint Lemon Sand Cocoa Cream`, prefixed `ResolveColor`.
- Strip `|` from note text — it is the field separator.

The timeline's start timecode must be in the reference camera's timecode, or every marker
lands in the wrong place. Say so in the export UI.

### 10.2 FCPXML

Markers hang off a single `<gap>` spanning the session:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.11">
  <resources>
    <format id="r1" name="FFVideoFormat1080p2997"
            frameDuration="1001/30000s" width="1920" height="1080"/>
  </resources>
  <event name="elfyou 2026-09-15">
    <project name="Markers">
      <sequence format="r1" tcStart="1105865761/30000s" tcFormat="DF" duration="…">
        <spine>
          <gap name="Markers" offset="1105865761/30000s" start="1105865761/30000s" duration="…">
            <marker start="1105865761/30000s" duration="1001/30000s"
                    value="[GREAT] second chorus, the hair flip"/>
          </gap>
        </spine>
      </sequence>
    </project>
  </event>
</fcpxml>
```

- All times rational, `numerator/denominators`, `s` mandatory. Frame `n` at 29.97 is
  `n×1001/30000s` — integer arithmetic throughout, never floats, or FCP rejects
  non-frame-aligned values. `10:14:22;07` DF is frame 1104761 → `1105865761/30000s`,
  verified round-trip.
- `tcFormat` is `DF` or `NDF`.
- FCPXML has no marker colour; prefix the type into `value`.

### 10.3 CSV

`timecode,frame,camera,type,note,source,created,device`. The sanity check when an import
looks wrong.

### 10.4 The fix file — `.tcfix.json`

One file per session, the thing the Resolve plugin consumes. It carries the camera offsets
*and* the markers, so one AirDrop does both jobs.

```json
{
  "format": "tcfix",
  "version": 1,
  "generator": "tc-marker-app 0.1.0",
  "session": { "id": "…", "label": "elfyou — Tuesday", "created": "…", "device": "alex-iphone" },
  "reference_camera": "A",
  "cameras": {
    "A": { "label": "FX30 main", "fps": "29.97", "drop": true, "offset_frames": 0,
           "locked_at": "…", "lock_quality": { "inliers": 14, "residual_frames": 0.4 } },
    "B": { "label": "FX30 wide", "fps": "29.97", "drop": true, "offset_frames": -4471,
           "offset_meaning": "A_frame = B_frame + offset_frames",
           "measured_at": "…", "confidence_frames": 1, "bin_hint": "CAM B",
           "lock_quality": { "inliers": 11, "residual_frames": 0.6 } }
  },
  "markers": [
    { "id": "m_01JB7Q8Z0K", "camera": "A", "tc": "10:14:22;07", "frame": 1104761,
      "type": "great", "color": "Green", "note": "second chorus, the hair flip",
      "source": "voice", "preroll_ms": 1500, "created": "…" }
  ]
}
```

Design notes:

- `format` + `version` up front so the plugin can refuse what it doesn't understand instead
  of guessing.
- `offset_meaning` is redundant with this document on purpose. The file will outlive the
  reader's memory of which direction the sign goes.
- `lock_quality` and `confidence_frames` are there so that, six months on, a suspicious
  sync can be traced to a marginal lock rather than debugged from scratch.
- `bin_hint` is advisory. The plugin operates on whatever bin is current; the hint is shown
  so the operator can check they're in the right one.
- Markers carry both `tc` and `frame`; the plugin prefers `frame` and falls back to `tc`.

A full example ships as `resolve-plugin/example.tcfix.json`; it validates against the
plugin and its frame numbers are checked in the plugin's self-test.

---

## 11. The Resolve plugin — `TCFix.py`

Ships in `resolve-plugin/`. Reference implementation, self-tested, not yet run against a live
Resolve — first run on the real machine is Phase 4's first task.

### 11.1 Install and run

Copy to the Scripts folder; it appears under **Workspace → Scripts**:

| | |
|---|---|
| Windows | `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\` |
| macOS | `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/` |

**Works in the free version.** Scripts launched from the Workspace menu get `resolve`,
`fusion` and `bmd` injected and run in both Free and Studio. What Studio gates is *external*
scripting — a standalone Python process connecting to Resolve. This plugin never needs that.

Defaults to `~/Documents/tcfix/` and pre-fills the newest `*.tcfix.json` there. Point the
phone's export (AirDrop, Files, or the Syncthing folder you already run) at that directory.

### 11.2 What it does

A small dialog (Fusion `UIManager`) with a file path, a camera dropdown, two checkboxes and a
**dry run** toggle that is on by default.

**Job 1 — camera offset.** For every clip in the **current Media Pool bin**: read
`Start TC` and `FPS`, skip clips with no timecode (stills, audio) or a mismatched rate,
compute `new = old + offset_frames` in the camera's DF/NDF arithmetic, and
`SetClipProperty("Start TC", new)`. Non-destructive — this is the same field as Clip
Attributes → Timecode, it lives in the project database, and the source file is untouched.

**Job 2 — markers.** For every marker: `frameId = marker.frame − timeline.GetStartFrame()`,
then `Timeline.AddMarker(frameId, colour, name, note, 1, marker.id)`. Colour is a real Resolve
colour; `name` is the note (or the type, if the note is empty); `note` carries type, TC and
source for later. Markers before the timeline start are skipped and reported.

Everything prints to the dialog and to the console, dry run or not, so the record of what
changed is on screen before and after.

### 11.3 Rules the plugin encodes

**Apply offsets before the clips are in a timeline.** Changing `Start TC` on a clip that is
already used in a timeline is known to break that timeline clip's relationship to its media.
The docstring says so; the workflow is *import → TCFix → multicam*.

**Rate mismatch is a skip, not a conversion.** A 25 fps clip in a 29.97 bin gets a line in
the log and no change.

**Dry run is the default.** The Run button changes nothing until the operator unticks it,
having read the plan.

**`Start TC` goes in with `:` separators even for drop-frame.** The clip's own `Drop frame`
property carries DF-ness; Resolve does not want `;` in the string.

**The self-test is the same maths as the phone.** `python TCFix.py --selftest` outside
Resolve runs the discontinuity checks, the 24-hour DF round-trip, a mocked offset pass and a
mocked marker import. If the TypeScript `core/timecode.ts` and this file ever disagree, one
of them is wrong and the test says which.

### 11.4 Two things to verify on first live run

1. `Timeline.AddMarker`'s `frameId` is treated here as relative to the timeline's first frame
   (`GetStartFrame()`). Add one marker in dry-run-off mode, then `GetMarkers()` and confirm
   the key matches. If Resolve wants absolute frames on your version, the fix is one
   subtraction.
2. `project.GetSetting("timelineDropFrameTimecode")` returns `"1"`/`"0"` — confirm the
   string form on your version.

---

## 12. Traps worth encoding

**Drop-frame `perMin` is 1798.** Fails 13 times per 24 hours if you get it wrong, always at a
minute boundary, and passes every casual test.

**`performance.now()`, never `Date.now()`.** A clock correction mid-show silently shifts
every subsequent marker.

**Timestamp the video frame, not the OCR result.** `requestVideoFrameCallback` metadata
exists for this.

**Rec Run silently produces plausible-looking nonsense.** Real timecode, real clock, wrong
markers. Detect it at lock time and refuse.

**Offsets are signed and the sign will be got wrong once.** `A_frame = B_frame + offset`.
It is in the file, the plugin's log, and this document. Keep it in all three.

**Changing Start TC under a timeline breaks the timeline.** TCFix before multicam, never
after.

**Phone camera against an LCD beats against the panel refresh.** Rolling shutter tears digits
mid-frame. Burst-and-fit rejects these rather than trusting them.

**iOS kills the WebView's camera stream when backgrounded.** The clock survives (§3.3); the
lock sheet does not. Make the sheet re-acquire on foreground rather than showing a frozen
frame as if it were live.

---

## 13. Project layout and stack

```
tc-marker/
  package.json              Vite + React + TypeScript + Tailwind, Capacitor 6
  capacitor.config.ts
  src/
    core/                   pure TS, no DOM, vitest
      timecode.ts  clock.ts  lockfit.ts  offsets.ts
      export/edl.ts  fcpxml.ts  csv.ts  tcfix.ts
    platform/               plugin adapters behind interfaces
      camera.ts  speech.ts  store.ts  share.ts  sync.ts
    ui/
  ios/  android/            generated by Capacitor
  supabase/
    migrations/0001_markers.sql
resolve-plugin/
  TCFix.py
  example.tcfix.json
```

**Plugins (v1):** `@capacitor-community/sqlite`, `@capacitor-community/speech-recognition`,
`@capacitor/share`, `@capacitor/filesystem`. Camera via `getUserMedia` in the WebView for
v1 (needs `NSCameraUsageDescription`); a camera-preview plugin only if focus/exposure lock
proves necessary.

**Distribution:** TestFlight internal testing for iOS (no App Store review; up to 100
testers), sideloaded APK or internal track for Android. An eGen Apple Developer account is the
only new account this needs.

**The honest cost over the v1 plan:** a Mac with Xcode for iOS builds, and each native
plugin is a small ongoing maintenance surface that a Flask template wasn't.

---

## 14. Build order

**Phase 1 — core + pad, manual TC.** `core/` with full tests. Manual timecode entry, running
clock, marker pad, typed notes, SQLite, CSV export via share sheet. Runs in a browser tab
first; wrap in Capacitor at the end of the phase. Fully useful on its own.

**Phase 2 — voice + sync.** Native speech plugin, Supabase schema and background sync.

**Phase 3 — OCR lock + offsets.** ROI calibration, burst, fit and gate, per-camera locks,
offset derivation, re-lock reminders.

**Phase 4 — exports + TCFix.** `.tcfix.json`, EDL, FCPXML. First live run of `TCFix.py`
against a real project; verify §11.4; round-trip a multicam.

**Phase 5 — the nice ones.** Native Vision/ML Kit recognizer, camera focus/exposure lock,
per-type pre-roll tuning, drift `rate` learning across long-baseline locks, session
auto-start from vMix record state when the panel is reachable.

Phase 1 is a real tool. If Phase 3 turns out miserable in a dark venue, Phase 1 plus one typed
timecode per camera per session — and Phase 4's plugin — is still most of the value.

---

## 15. Open questions

1. **Sessions per show or per card?** With `Time Code Make: Preset` a card change keeps
   running; `Regenerate` may not. Per-show is the assumption here.
2. **Should markers ever be stored in a non-reference camera's TC?** The model allows it
   (`camera_id`); v1 always uses the reference. Worth keeping the column.
3. **Supabase or the panel as the shared store on show days?** This spec says Supabase and
   treats the panel as an optional trigger (Phase 5). If show-day operators live in the
   panel, a read-only markers view there is cheap once the data is in Supabase.
4. **If you outgrow OCR:** the FX30 takes external timecode over the shoe (Tentacle,
   UltraSync, Deity, Røde). That fixes the cameras to each other and makes §6 unnecessary.
   The app still earns its place for the marking.

---

## Sources

- [Sony ILME-FX30 Help Guide — TC/UB](https://helpguide.sony.net/ilc/2220/v1/en/contents/TP1000876474.html)
- [MDN — SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)
- [Resolve scripting API reference (community, v20.3)](https://gist.github.com/mhadifilms/2b84d469135315793220dbf2226cbe63)
- [Working example of `SetClipProperty("Start TC", …)` from the Resolve console](https://github.com/GuillaumeHullin/davinci-resolve-scripts/blob/main/CurrentFolder%20Clips%20TC%20Start%200.py)
- [Scripting in the free version of Resolve — Workspace › Scripts menu](https://dev.to/depsir/unlock-the-secrets-of-automating-davinci-resolve-with-python-free-version-edition-1fkn)
- [Resolve marker EDL format — reference implementation](https://github.com/X-Raym/REAPER-ReaScripts/blob/master/Regions/X-Raym_Export%20markers%20and%20regions%20as%20Davinci%20Resolve%20EDL%20file.lua)
- [FCPXML format reference](https://github.com/elliotttate/FCPBridge/blob/main/docs/FCPXML_FORMAT_REFERENCE.md)
- [Blackmagic forum — changing a MediaPoolItem's timecode breaks timeline clips](https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=146213)
