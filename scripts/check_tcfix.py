#!/usr/bin/env python3
"""
Cross-language check (HANDOFF.md Phase 1 acceptance).

Loads a .tcfix.json produced by the TypeScript exporter using the real
TCFix.load_fixfile, then re-derives every marker's `frame` from its `tc` with the real
TCFix.tc_to_frames and requires an exact match. Also renders each frame back to a label
with TCFix.frames_to_tc, which is what catches a timecode that parses but does not exist
(00:01:00;00 at 29.97 DF).

Usage: python3 scripts/check_tcfix.py <file.tcfix.json>
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resolve-plugin"))
import TCFix  # noqa: E402


def main(path):
    data = TCFix.load_fixfile(path)          # refuses an unknown format/version
    cams = data["cameras"]
    markers = data["markers"]
    if not markers:
        print("FAIL: no markers in %s" % path)
        return 1

    bad = []
    for m in markers:
        cam = cams[m["camera"]]
        fps, drop = cam["fps"], bool(cam["drop"])
        derived = TCFix.tc_to_frames(m["tc"], fps, drop)
        if derived != m["frame"]:
            bad.append("%s: tc %s derives %d, file says %d" % (m["id"], m["tc"], derived, m["frame"]))
            continue
        rendered = TCFix.frames_to_tc(m["frame"], fps, drop)
        if rendered != m["tc"]:
            bad.append("%s: frame %d renders %s, file says %s" % (m["id"], m["frame"], rendered, m["tc"]))

    # The colours the app writes must be colours Resolve knows (§8).
    for m in markers:
        if m["color"] not in TCFix.MARKER_COLOURS:
            bad.append("%s: colour %r is not a Resolve marker colour" % (m["id"], m["color"]))

    if bad:
        print("FAIL: %d of %d markers disagree between TypeScript and TCFix.py" % (len(bad), len(markers)))
        for line in bad[:20]:
            print("  " + line)
        return 1

    print("OK: %d markers round-trip identically through TCFix.py (%s)" % (len(markers), os.path.basename(path)))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
