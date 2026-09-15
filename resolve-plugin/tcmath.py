"""
tcmath — the timecode maths, in Python. One source of truth.

Imported by `TCFix.py` (the Resolve plugin) and, when it exists, by `pi-tracker/`
(spec §16.2). The TypeScript half of the same maths is `src/core/timecode.ts`; the
vectors below are its vectors too. If any of the three disagree, one of them is wrong
and the self-test says which.

Run `python3 tcmath.py --selftest` to check this file alone.

No dependencies beyond the standard library, deliberately: it has to import cleanly
inside DaVinci Resolve's embedded interpreter and on a Raspberry Pi.
"""

import sys

# Spec §3.1. Labels always advance at the nominal integer rate; for the NTSC family
# real time runs slower by exactly 1000/1001.
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

# Explicit, source-ordered. Python dicts preserve insertion order, but the TypeScript
# side cannot derive this from its object keys (numeric-looking keys are hoisted), so
# the list is written out in both places and pinned by a test in both.
RATE_NAMES = ["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"]


def nominal_of(fps_name):
    try:
        return RATES[str(fps_name)]
    except KeyError:
        raise ValueError("unsupported fps %r (want one of %s)" % (fps_name, ", ".join(RATE_NAMES)))


def real_fps(fps_name):
    """Frames of real time per second (§3.1)."""
    n, ntsc = nominal_of(fps_name)
    return n * 1000.0 / 1001.0 if ntsc else float(n)


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


def frames_per_day(fps_name, drop):
    n, _ = nominal_of(fps_name)
    per_day = n * 3600 * 24
    if not drop:
        return per_day
    return per_day - (2 if n == 30 else 4) * (1440 - 144)


def selftest():
    """The HANDOFF.md vectors. Identical to tests/unit/timecode.test.ts."""
    assert frames_to_tc(tc_to_frames("00:00:59;29", "29.97", True) + 1, "29.97", True) == "00:01:00;02"
    assert frames_to_tc(tc_to_frames("00:09:59;29", "29.97", True) + 1, "29.97", True) == "00:10:00;00"
    assert frames_to_tc(107892, "29.97", True) == "01:00:00;00"
    assert frames_to_tc(107892, "29.97", False) == "00:59:56:12"
    assert tc_to_frames("10:14:22;07", "29.97", True) == 1104761
    assert tc_to_frames("10:18:04;11", "29.97", True) == 1111417
    assert frames_to_tc(1104761 - 4471, "29.97", True) == "10:11:53;00"

    # A full 24 hours of drop-frame, which is what catches perMin = 1796.
    assert frames_per_day("29.97", True) == 2589408
    for fr in range(0, frames_per_day("29.97", True), 1009):
        assert tc_to_frames(frames_to_tc(fr, "29.97", True), "29.97", True) == fr

    # NDF at all eight rates.
    for name in RATE_NAMES:
        total = frames_per_day(name, False)
        for fr in range(0, total, 997):
            assert tc_to_frames(frames_to_tc(fr, name, False), name, False) == fr

    assert abs(real_fps("29.97") - 29.97002997) < 1e-8
    assert real_fps("25") == 25.0
    assert sorted(RATES) == sorted(RATE_NAMES)
    return "tcmath selftest OK — vectors, 24h DF round-trip, NDF at all eight rates"


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        print(selftest())
    else:
        print(__doc__)
