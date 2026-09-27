"""
Host-platform details shared by build.py and run_tests.py (Windows, Linux, macOS).

Godot is looked up in this order:
  1. the GODOT environment variable (full path to the binary)
  2. the bundled binary in tools/godot/ for this host
  3. on Linux/macOS, `godot` / `godot4` on PATH
"""
import os
import platform
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GODOT_VERSION = "4.7.2-stable"

WINDOWS = sys.platform == "win32"
MACOS = sys.platform == "darwin"
LINUX = sys.platform.startswith("linux")

EXE = ".exe" if WINDOWS else ""


def _bundled_godot():
    tools = ROOT / "tools" / "godot"
    if WINDOWS:
        return tools / f"Godot_v{GODOT_VERSION}_win64_console.exe"
    if MACOS:
        return tools / "Godot.app" / "Contents" / "MacOS" / "Godot"
    arch = "arm64" if platform.machine().lower() in ("aarch64", "arm64") else "x86_64"
    return tools / f"Godot_v{GODOT_VERSION}_linux.{arch}"


def godot():
    if os.environ.get("GODOT"):
        return Path(os.environ["GODOT"])
    bundled = _bundled_godot()
    if WINDOWS or bundled.exists():
        return bundled
    for name in ("godot", "godot4"):
        found = shutil.which(name)
        if found:
            return Path(found)
    return bundled
