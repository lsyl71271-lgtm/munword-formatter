"""Temporary diagnostic: what Safari shows when the offline page is opened the way users open it."""
import base64
import json
import os
import plistlib
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DMG = ROOT / "downloads" / "PKUNMUN2026-Formatter-macOS.dmg"
OPENER = "直接用浏览器打开.html"
SITE = Path("Contents/Resources/site")
HOME = Path.home()
SHOTS = os.environ.get("PROBE_SHOTS") == "1"


def run(*command, timeout=30, env=None):
    try:
        r = subprocess.run([str(c) for c in command], capture_output=True, text=True, timeout=timeout, env=env)
        return r.returncode, (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return -1, "timeout"


def say(**data):
    print(json.dumps(data, ensure_ascii=False), flush=True)


TEXT = '''
tell application "System Events"
  tell process "Safari"
    set out to (name of every window) as text
    set out to out & linefeed & "---" & linefeed
    try
      repeat with e in (entire contents of front window)
        try
          if role of e is "AXStaticText" then set out to out & (value of e) & " | "
        end try
      end repeat
    end try
    return out
  end tell
end tell
'''


def safari_text():
    return run("osascript", "-e", TEXT, timeout=40)


def quit_safari():
    run("pkill", "-x", "Safari")
    time.sleep(2)


def shot(label):
    if not SHOTS:
        return
    png = Path(f"/tmp/probe-{label}.png")
    code, out = run("screencapture", "-x", png)
    if code == 0 and png.exists():
        jpg = png.with_suffix(".jpg")
        run("sips", "-Z", "1000", "-s", "format", "jpeg", "-s", "formatOptions", "35", png, "--out", jpg)
        say(shot=label, b64=base64.b64encode(jpg.read_bytes()).decode())
    else:
        say(shot=label, error=out)


def main():
    say(sw=run("sw_vers")[1], safari=run("defaults", "read", "/Applications/Safari.app/Contents/Info", "CFBundleShortVersionString")[1])
    chain, pid = [], os.getpid()
    for _ in range(12):
        code, out = run("ps", "-o", "ppid=,comm=", "-p", str(pid))
        if code or not out:
            break
        ppid, comm = out.split(None, 1)
        chain.append(comm)
        pid = int(ppid)
        if pid <= 1:
            break
    say(ancestors=chain)
    say(system_events=run("osascript", "-e", 'tell application "System Events" to get name of every process whose frontmost is true', timeout=20))
    say(ax_trusted=run("osascript", "-l", "JavaScript", "-e", 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()', timeout=20))

    attached = plistlib.loads(subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-plist", str(DMG)], capture_output=True, check=True).stdout)
    mount = Path(next(e["mount-point"] for e in attached["system-entities"] if "mount-point" in e))
    system_app = Path("/Applications/PKUNMUN2026.app")
    run("ditto", mount / "PKUNMUN2026.app", system_app)
    home_opener = HOME / "PKUNMUN probe" / OPENER
    home_opener.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(mount / OPENER, home_opener)
    desktop_opener = HOME / "Desktop" / OPENER
    shutil.copy(mount / OPENER, desktop_opener)
    empty = HOME / "PKUNMUN probe" / "no-browsers"
    empty.mkdir(exist_ok=True)

    cases = [
        ("installed page", ["open", "-a", "Safari", system_app / SITE / "index.html"], None),
        ("app launcher choosing Safari", [system_app / "Contents/MacOS/PKUNMUN2026"], {**os.environ, "MUNWORD_APPLICATIONS": str(empty)}),
        ("opener on the image", ["open", "-a", "Safari", mount / OPENER], None),
        ("opener in home folder", ["open", "-a", "Safari", home_opener], None),
        ("opener on Desktop", ["open", "-a", "Safari", desktop_opener], None),
    ]
    for label, command, env in cases:
        quit_safari()
        code, out = run(*command, env=env)
        text = ""
        for _ in range(6):
            time.sleep(4)
            _, text = safari_text()
            if "立场文件" in text or "没有找到" in text or "Can’t" in text or "timeout" in text:
                break
        say(case=label, start=code, start_out=out[:200], safari=text[:1500])
        shot(label.replace(" ", "_"))
    quit_safari()
    for path in (system_app, HOME / "PKUNMUN probe"):
        shutil.rmtree(path, ignore_errors=True)
    desktop_opener.unlink(missing_ok=True)
    run("hdiutil", "detach", mount, "-force")


if __name__ == "__main__":
    main()
