"""
Runs every automated check of the project:

  1. C++ vehicle-simulation unit tests          (native/bin/sim_tests)
  2. Godot/Jolt vehicle integration test        (game/tests/vehicle_test.gd)
  3. End-to-end exam driven by the autopilot    (must pass with 0 points)
  4. Rule-detection tests with deliberate faults (the right penalties must appear)
  5. Practice "Namuna" demonstrations of every exercise (must pass with 0 points)

    python scripts/run_tests.py            # everything
    python scripts/run_tests.py --quick    # skip the long end-to-end drives
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from host import EXE, ROOT, godot

GODOT = godot()
GAME = ROOT / "game"
NATIVE = ROOT / "native"


def run(cmd, cwd, timeout=1800):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout)
    return p.returncode, p.stdout + p.stderr


def godot_drive(extra, timeout=1800):
    cmd = [str(GODOT), "--headless", "--path", str(GAME), "res://scenes/drive.tscn", "--fixed-fps", "120", "--",
           "--autopilot-test", "--quit-after-s=1500"] + extra
    return run(cmd, GAME, timeout)


def main() -> int:
    quick = "--quick" in sys.argv
    failures = []

    print("== 1. C++ simulation tests")
    code, out = run([sys.executable, "-m", "SCons", "tests=yes", "-j8"], NATIVE)
    if code != 0:
        print(out)
        failures.append("build sim_tests")
    else:
        code, out = run([str(NATIVE / "bin" / ("sim_tests" + EXE))], NATIVE)
        print(out.strip().splitlines()[-1])
        if code != 0:
            print(out)
            failures.append("sim_tests")

    if not GODOT.exists():
        print(f"\nGodot not found at {GODOT}; set GODOT=/path/to/godot (see scripts/host.py)")
        print("FAILED:", ", ".join(failures + ["godot missing"]))
        return 1

    print("== 2. Godot vehicle integration test")
    run([str(GODOT), "--headless", "--path", str(GAME), "--import"], GAME)
    code, out = run([str(GODOT), "--headless", "--path", str(GAME), "--script", "res://tests/vehicle_test.gd"], GAME)
    summary = [l for l in out.splitlines() if "checks," in l]
    print(summary[-1] if summary else out[-2000:])
    if code != 0:
        failures.append("vehicle_test")

    if not quick:
        print("== 3. End-to-end exam (autopilot, expect 0 points), every car")
        for car in ("nexia2", "cobalt_at"):
            code, out = godot_drive(["--car=" + car])
            res = [l for l in out.splitlines() if l.startswith("RESULT")]
            print(f"   {car:10s}", res[-1] if res else out[-3000:])
            for l in out.splitlines():
                if l.startswith("PENALTY"):
                    print("      ", l[:160])
            if code != 0:
                failures.append("e2e_exam " + car)

        print("== 3b. End-to-end exam at the phones' 60 Hz physics tick")
        code, out = run([str(GODOT), "--headless", "--path", str(GAME), "res://scenes/drive.tscn", "--fixed-fps", "60",
                         "--", "--physics-hz=60", "--car=nexia2", "--seed=3", "--autopilot-test",
                         "--quit-after-s=1500"], GAME)
        res = [l for l in out.splitlines() if l.startswith("RESULT")]
        print("   nexia2 60 Hz", res[-1] if res else out[-2000:])
        if code != 0:
            failures.append("e2e_exam 60 Hz")

        print("== 4. Rule detection with deliberate faults")
        # fault: (penalties that must appear, penalties that must not)
        expectations = {
            "nobelt": ({1}, set()),
            "nostop": ({11, 25}, set()),
            "redlight": ({24}, set()),
            "nosignal": ({2, 5, 7}, set()),
            "speed": ({8}, {31}),
            "boxdeep": ({17}, {27}),
            "parkoff": ({17}, {27}),
        }
        for fault, (expected, forbidden) in expectations.items():
            code, out = godot_drive(["--car=nexia2", "--faults=" + fault])
            got = {int(m) for m in re.findall(r"PENALTY №(\d+)", out)}
            ok = expected.issubset(got) and not (forbidden & got)
            print(f"   {fault:9s} expected {sorted(expected)} got {sorted(got)} -> {'ok' if ok else 'FAIL'}")
            if not ok:
                failures.append("fault " + fault)

        print("== 5. Practice demonstrations (each exercise alone, expect 0 points), every car")
        course = json.loads((GAME / "data" / "course.json").read_text(encoding="utf-8"))
        for car in ("nexia2", "cobalt_at"):
            for ex in [e["id"] for e in course["exercises"]]:
                code, out = godot_drive(["--car=" + car, "--mode=practice", "--exercise=" + ex, "--demo"], timeout=600)
                res = [l for l in out.splitlines() if l.startswith("RESULT")]
                print(f"   {car:10s} {ex:14s} {res[-1][7:] if res else 'no result'}")
                if code != 0:
                    failures.append(f"demo {car} {ex}")

    print()
    if failures:
        print("FAILED:", ", ".join(failures))
        return 1
    print("ALL TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
