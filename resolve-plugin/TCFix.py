"""
TCFix — apply a timecode-marker fix file inside DaVinci Resolve.

Install: copy this file to the Scripts folder and it appears under
Workspace > Scripts. Works in the FREE version because it runs from the menu;
external (standalone) scripting is what needs Studio.

  Windows  %APPDATA%\\Blackmagic Design\\DaVinci Resolve\\Support\\Fusion\\Scripts\\Utility\\
  macOS    ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/

Two jobs, both driven by one .tcfix.json written by the phone app:

  1. Camera offset — shift Start TC on every clip in the CURRENT media pool bin
     so that camera's timecode matches the reference camera. Do this BEFORE the
     clips go into a timeline or multicam: changing Start TC on a clip that is
     already in a timeline is known to break that timeline clip's relationship.

  2. Import markers — put the session's markers on the CURRENT timeline, with
     real Resolve colours (FCPXML can't carry colour; EDL can, but this is
     one fewer file). The timeline's start timecode must be in the reference
     camera's timecode, same as it would for the EDL route.

Nothing here touches files on disk. Everything is a Media Pool property or a
timeline marker, and all of it is undoable.

Run outside Resolve with `python TCFix.py --selftest` to exercise the math.
"""

import glob
import json
import os
import sys

# ----------------------------------------------------------------- settings

# Where the phone app's exports land (AirDrop / Files / Syncthing). The dialog
# pre-fills the newest *.tcfix.json found here.
TCFIX_DIR = os.path.expanduser("~/Documents/tcfix")

MARKER_COLOURS = {
    "Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia",
    "Rose", "Lavender", "Sky", "Mint", "Lemon", "Sand", "Cocoa", "Cream",
}

# --------------------------------------------------------------- timecode

RATES = {
    #  name     nominal  ntsc
    "23.976": (24, True),
    "24":     (24, False),
    "25":     (25, False),
    "29.97":  (30, True),
    "30":     (30, False),
    "50":     (50, False),
    "59.94":  (60, True),
    "60":     (60, False),
}


def nominal_of(fps_name):
    try:
        return RATES[str(fps_name)]
    except KeyError:
        raise ValueError("unsupported fps %r (want one of %s)" % (fps_name, ", ".join(RATES)))


def frames_to_tc(frame, fps_name, drop):
    n, ntsc = nominal_of(fps_name)
    if drop:
        if not (ntsc and n in (30, 60)):
            raise ValueError("drop-frame only exists at 29.97 / 59.94")
        dropped = 2 if n == 30 else 4
        per_10min = int(round(n * 1000.0 / 1001.0 * 600))   # 17982 @ 29.97
        per_min = int(round(n * 1000.0 / 1001.0 * 60))      #  1798 @ 29.97  (NOT 1796)
        d, m = divmod(frame, per_10min)
        if m > dropped:
            frame += dropped * 9 * d + dropped * ((m - dropped) // per_min)
        else:
            frame += dropped * 9 * d
    ff = frame % n
    ss = (frame // n) % 60
    mm = (frame // (n * 60)) % 60
    hh = (frame // (n * 3600)) % 24
    return "%02d:%02d:%02d%s%02d" % (hh, mm, ss, ";" if drop else ":", ff)


def tc_to_frames(tc, fps_name, drop):
    n, _ = nominal_of(fps_name)
    parts = tc.replace(";", ":").replace(".", ":").split(":")
    if len(parts) != 4:
        raise ValueError("bad timecode %r" % tc)
    hh, mm, ss, ff = (int(p) for p in parts)
    frame = ((hh * 60 + mm) * 60 + ss) * n + ff
    if drop:
        dropped = 2 if n == 30 else 4
        total_min = hh * 60 + mm
        frame -= dropped * (total_min - total_min // 10)
    return frame


def resolve_tc(tc_string, drop):
    """Resolve wants ':' separators in SetClipProperty even for drop-frame; the
    clip's own 'Drop frame' property carries that fact."""
    return tc_string.replace(";", ":")


# ---------------------------------------------------------------- fix file

def load_fixfile(path):
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if data.get("format") != "tcfix":
        raise ValueError("not a tcfix file (format=%r)" % data.get("format"))
    if int(data.get("version", 0)) != 1:
        raise ValueError("tcfix version %r not supported by this script" % data.get("version"))
    cams = data.get("cameras") or {}
    ref = data.get("reference_camera")
    if ref not in cams:
        raise ValueError("reference_camera %r is not in cameras" % ref)
    for cid, cam in cams.items():
        nominal_of(cam["fps"])
        int(cam.get("offset_frames", 0))
    return data


def newest_fixfile(directory=TCFIX_DIR):
    hits = glob.glob(os.path.join(directory, "*.tcfix.json"))
    return max(hits, key=os.path.getmtime) if hits else ""


# ------------------------------------------------------------- the two jobs

def plan_offsets(clips, cam):
    """Return [(clip, old_tc, new_tc, note)] for every clip in the bin.
    Pure function - nothing is written here."""
    fps, drop, offset = str(cam["fps"]), bool(cam.get("drop")), int(cam.get("offset_frames", 0))
    plan = []
    for clip in clips:
        old = clip.GetClipProperty("Start TC") or ""
        clip_fps = str(clip.GetClipProperty("FPS") or "")
        note = ""
        if not old:
            note = "skip: no Start TC (audio-only or still?)"
            plan.append((clip, old, old, note))
            continue
        if clip_fps and _fps_key(clip_fps) != fps:
            note = "skip: clip is %s fps, fix file says %s" % (clip_fps, fps)
            plan.append((clip, old, old, note))
            continue
        new = frames_to_tc(tc_to_frames(old, fps, drop) + offset, fps, drop)
        plan.append((clip, old, new, note))
    return plan


def _fps_key(fps_string):
    """Resolve reports FPS as e.g. '29.97', '29.970', '23.976', '25'. Normalise."""
    try:
        v = float(fps_string)
    except ValueError:
        return fps_string
    for name in RATES:
        if abs(float(name) - v) < 0.01:
            return name
    return ("%g" % v)


def apply_offsets(plan, dry_run, log):
    done = skipped = failed = 0
    for clip, old, new, note in plan:
        name = clip.GetName() if hasattr(clip, "GetName") else "?"
        if note:
            log("  - %-40s %s" % (name, note)); skipped += 1; continue
        if old == new:
            log("  = %-40s %s (no change)" % (name, old)); skipped += 1; continue
        log("  %s %-40s %s -> %s" % ("~" if dry_run else ">", name, old, new))
        if dry_run:
            continue
        ok = clip.SetClipProperty("Start TC", resolve_tc(new, False))
        if ok:
            done += 1
        else:
            failed += 1
            log("    ! SetClipProperty returned False")
    return done, skipped, failed


def plan_markers(data, timeline_start_frame, timeline_fps, timeline_drop, camera=None):
    """Markers are stored in the reference camera's TC. frameId for
    Timeline.AddMarker is relative to the timeline's own first frame."""
    ref = data["reference_camera"]
    cam = data["cameras"][ref]
    fps, drop = str(cam["fps"]), bool(cam.get("drop"))
    if timeline_fps and _fps_key(timeline_fps) != fps:
        raise ValueError("timeline is %s fps, markers are %s fps" % (timeline_fps, fps))
    out = []
    for m in data.get("markers", []):
        if camera and m.get("camera", ref) != camera:
            continue
        frame = int(m["frame"]) if "frame" in m else tc_to_frames(m["tc"], fps, drop)
        rel = frame - timeline_start_frame
        colour = m.get("color") or "Blue"
        if colour not in MARKER_COLOURS:
            colour = "Blue"
        label = (m.get("type") or "marker").upper()
        note = m.get("note") or ""
        name = note if note else label
        out.append((rel, colour, name, "%s · %s · %s" % (label, m.get("tc", ""), m.get("source", "")), m))
    return out


def apply_markers(timeline, plan, dry_run, log):
    added = skipped = 0
    dur_frames = 1
    for rel, colour, name, note, m in plan:
        if rel < 0:
            log("  - %s before timeline start (rel %d) - skipped" % (m.get("tc"), rel)); skipped += 1; continue
        log("  %s frame %-8d %-7s %s" % ("~" if dry_run else ">", rel, colour, name))
        if dry_run:
            continue
        ok = timeline.AddMarker(rel, colour, name, note, dur_frames, m.get("id", ""))
        if ok:
            added += 1
        else:
            skipped += 1
            log("    ! AddMarker returned False (marker already at that frame?)")
    return added, skipped


# ------------------------------------------------------------------- Resolve

def run_in_resolve(resolve, fusion, bmd):
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    if not project:
        print("TCFix: open a project first."); return
    mp = project.GetMediaPool()
    ui = fusion.UIManager
    disp = bmd.UIDispatcher(ui)

    default_path = newest_fixfile()
    win = disp.AddWindow({
        "ID": "TCFixWin", "WindowTitle": "TCFix — camera offset & markers",
        "Geometry": [200, 200, 640, 360],
    }, [
        ui.VGroup({"Spacing": 8}, [
            ui.Label({"Text": "Fix file (.tcfix.json)"}),
            ui.HGroup([
                ui.LineEdit({"ID": "Path", "Text": default_path}),
                ui.Button({"ID": "Browse", "Text": "Browse…", "Weight": 0}),
            ]),
            ui.HGroup([
                ui.Label({"Text": "Camera to fix (current bin):", "Weight": 0}),
                ui.ComboBox({"ID": "Camera"}),
            ]),
            ui.CheckBox({"ID": "DoOffset", "Text": "Shift Start TC on every clip in the current bin", "Checked": True}),
            ui.CheckBox({"ID": "DoMarkers", "Text": "Import markers onto the current timeline", "Checked": True}),
            ui.CheckBox({"ID": "DryRun", "Text": "Dry run — print what would change, change nothing", "Checked": True}),
            ui.TextEdit({"ID": "Log", "ReadOnly": True}),
            ui.HGroup([
                ui.Button({"ID": "Run", "Text": "Run"}),
                ui.Button({"ID": "Close", "Text": "Close"}),
            ]),
        ]),
    ])
    items = win.GetItems()
    state = {"data": None}

    def log(line):
        items["Log"].Append(line)
        print(line)

    def load(path):
        items["Camera"].Clear()
        state["data"] = None
        if not path or not os.path.exists(path):
            log("No fix file at %r" % path); return
        try:
            data = load_fixfile(path)
        except Exception as e:  # noqa: BLE001 - show anything to the operator
            log("Could not read fix file: %s" % e); return
        state["data"] = data
        ref = data["reference_camera"]
        for cid, cam in data["cameras"].items():
            tag = "%s  (offset %+d frames%s)" % (cid, int(cam.get("offset_frames", 0)), ", reference" if cid == ref else "")
            items["Camera"].AddItem(tag)
        log("Loaded %s — %d camera(s), %d marker(s), reference %s" % (
            os.path.basename(path), len(data["cameras"]), len(data.get("markers", [])), ref))

    def on_browse(ev):
        path = fusion.RequestFile(TCFIX_DIR if os.path.isdir(TCFIX_DIR) else os.path.expanduser("~"))
        if path:
            items["Path"].Text = path
            load(path)

    def on_run(ev):
        data = state["data"]
        if not data:
            load(items["Path"].Text); data = state["data"]
            if not data: return
        dry = items["DryRun"].Checked
        cam_ids = list(data["cameras"].keys())
        cam_id = cam_ids[items["Camera"].CurrentIndex] if cam_ids else None

        if items["DoOffset"].Checked and cam_id:
            cam = data["cameras"][cam_id]
            folder = mp.GetCurrentFolder()
            clips = folder.GetClipList() if folder else []
            log("— Offset %s by %+d frames in bin '%s' (%d clips)%s" % (
                cam_id, int(cam.get("offset_frames", 0)), folder.GetName() if folder else "?", len(clips),
                "  [DRY RUN]" if dry else ""))
            if int(cam.get("offset_frames", 0)) == 0:
                log("  offset is 0 — nothing to do")
            else:
                done, skipped, failed = apply_offsets(plan_offsets(clips, cam), dry, log)
                log("  %d changed, %d skipped, %d failed" % (done, skipped, failed))

        if items["DoMarkers"].Checked:
            tl = project.GetCurrentTimeline()
            if not tl:
                log("— No current timeline; open one to import markers."); return
            try:
                start = int(tl.GetStartFrame())
                fps = project.GetSetting("timelineFrameRate")
                drop = str(project.GetSetting("timelineDropFrameTimecode")) == "1"
                plan = plan_markers(data, start, fps, drop)
            except Exception as e:  # noqa: BLE001
                log("— Marker plan failed: %s" % e); return
            log("— Markers onto '%s' (start TC %s, %d markers)%s" % (
                tl.GetName(), tl.GetStartTimecode(), len(plan), "  [DRY RUN]" if dry else ""))
            added, skipped = apply_markers(tl, plan, dry, log)
            log("  %d added, %d skipped" % (added, skipped))
        log("Done.")

    def on_close(ev):
        disp.ExitLoop()

    win.On.Browse.Clicked = on_browse
    win.On.Run.Clicked = on_run
    win.On.Close.Clicked = on_close
    win.On.TCFixWin.Close = on_close
    load(default_path)
    win.Show()
    disp.RunLoop()
    win.Hide()


# ------------------------------------------------------------------ selftest

def _selftest():
    assert frames_to_tc(tc_to_frames("00:00:59;29", "29.97", True) + 1, "29.97", True) == "00:01:00;02"
    assert frames_to_tc(tc_to_frames("00:09:59;29", "29.97", True) + 1, "29.97", True) == "00:10:00;00"
    for fr in range(0, 2589408, 1009):
        assert tc_to_frames(frames_to_tc(fr, "29.97", True), "29.97", True) == fr
    assert frames_to_tc(107892, "29.97", True) == "01:00:00;00"
    assert frames_to_tc(107892, "29.97", False) == "00:59:56:12"

    class Clip:
        def __init__(self, name, tc, fps="29.97"):
            self.name, self.props = name, {"Start TC": tc, "FPS": fps}
        def GetName(self): return self.name
        def GetClipProperty(self, k): return self.props.get(k)
        def SetClipProperty(self, k, v): self.props[k] = v; return True

    cam = {"fps": "29.97", "drop": True, "offset_frames": -4471}
    clips = [Clip("B001", "10:14:22:07"), Clip("B002", "11:00:00:00"), Clip("B003", "10:00:00:00", fps="25")]
    plan = plan_offsets(clips, cam)
    assert plan[0][2] == frames_to_tc(tc_to_frames("10:14:22;07", "29.97", True) - 4471, "29.97", True)
    assert "skip" in plan[2][3]
    logs = []
    done, skipped, failed = apply_offsets(plan, dry_run=False, log=logs.append)
    assert (done, skipped, failed) == (2, 1, 0), (done, skipped, failed)
    assert clips[0].props["Start TC"].count(":") == 3 and ";" not in clips[0].props["Start TC"]

    data = {
        "format": "tcfix", "version": 1, "reference_camera": "A",
        "cameras": {"A": {"fps": "29.97", "drop": True, "offset_frames": 0}, "B": cam},
        "markers": [
            {"id": "m1", "camera": "A", "tc": "10:14:22;07", "frame": 1104761, "type": "great", "color": "Green", "note": "hair flip", "source": "voice"},
            {"id": "m2", "camera": "A", "tc": "10:00:00;00", "type": "note", "color": "Cream", "note": "", "source": "tap"},
        ],
    }
    start = tc_to_frames("10:00:00;00", "29.97", True)
    mplan = plan_markers(data, start, "29.97", True)
    assert mplan[0][0] == 1104761 - start and mplan[0][1] == "Green" and mplan[0][2] == "hair flip"
    assert mplan[1][0] == 0 and mplan[1][2] == "NOTE"

    class TL:
        def __init__(self): self.markers = {}
        def AddMarker(self, f, c, n, note, d, cd): self.markers[f] = (c, n); return f not in ()
    tl = TL()
    added, skipped = apply_markers(tl, mplan, dry_run=False, log=logs.append)
    assert added == 2 and 0 in tl.markers
    print("TCFix selftest OK — %d log lines" % len(logs))


if __name__ == "__main__" and "--selftest" in sys.argv:
    _selftest()
elif "resolve" in globals():          # launched from Workspace > Scripts
    run_in_resolve(resolve, fusion, bmd)  # noqa: F821 - injected by Resolve
elif __name__ == "__main__":
    print(__doc__)
    print("Not inside Resolve. Use --selftest to run the checks.")
