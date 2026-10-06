"""Where Safari can open the offline page from (diagnostic for the macOS CI jobs, never fails the job).

    python desktop/acceptance/safari_probe.py

Safari refuses file:// pages its own sandbox cannot read ("outside the sandbox"). This records, for the
places a user can have the app or the opener page, whether Safari shows the working page:
- opened the way users open it (LaunchServices: `open -a Safari <file>`), read back over Apple Events;
- opened by safaridriver (what the acceptance flow uses).
Prints one JSON line per attempt.
"""
from __future__ import annotations

import json
import os
import plistlib
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DMG = ROOT / "downloads" / "PKUNMUN2026-Formatter-macOS.dmg"
OPENER = "直接用浏览器打开.html"
SITE = Path("Contents/Resources/site")
HOME = Path.home()


def run(*command, timeout=60):
    try:
        result = subprocess.run([str(c) for c in command], capture_output=True, text=True, timeout=timeout)
        return result.returncode, (result.stdout + result.stderr).strip()
    except subprocess.TimeoutExpired:
        return -1, "timeout"


def osa(script: str):
    return run("osascript", "-e", script, timeout=20)


def quit_safari():
    osa('tell application "Safari" to quit')
    time.sleep(1)
    run("pkill", "-x", "Safari")
    time.sleep(1)


def main() -> int:
    work = Path(tempfile.mkdtemp(prefix="PKUNMUN probe "))
    attached = plistlib.loads(subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-plist", str(DMG)], capture_output=True, check=True).stdout)
    mount = Path(next(e["mount-point"] for e in attached["system-entities"] if "mount-point" in e))
    apps = {
        "temp folder": work / "PKUNMUN2026.app",
        "/Applications": Path("/Applications/PKUNMUN2026.app"),
        "~/Applications": HOME / "Applications" / "PKUNMUN2026.app",
        "home folder": HOME / "PKUNMUN probe" / "PKUNMUN2026.app",
        "mounted image": mount / "PKUNMUN2026.app",
    }
    openers = {
        "opener on the image": mount / OPENER,
        "opener in home folder (app in /Applications)": HOME / "PKUNMUN probe" / "opener" / OPENER,
        "opener on the Desktop (app in /Applications)": HOME / "Desktop" / OPENER,
    }
    made = []
    for label, app in apps.items():
        if label != "mounted image":
            app.parent.mkdir(parents=True, exist_ok=True)
            run("ditto", mount / "PKUNMUN2026.app", app)
            made.append(app)
    for label, opener in openers.items():
        if label != "opener on the image":
            opener.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(mount / OPENER, opener)
            made.append(opener)
    # The home-folder opener must not find the home-folder app next to it.
    targets = {**{k: v / SITE / "index.html" for k, v in apps.items()}, **openers}

    print(json.dumps({"safari": run("defaults", "read", "/Applications/Safari.app/Contents/Info", "CFBundleShortVersionString")[1]}))
    # 1. The way users open it.
    for label, path in targets.items():
        quit_safari()
        code, out = run("open", "-a", "Safari", path)
        time.sleep(6)
        name = osa('tell application "Safari" to get name of current tab of front window')
        url = osa('tell application "Safari" to get URL of current tab of front window')
        cards = osa('tell application "Safari" to do JavaScript "document.querySelectorAll(\'.typeCard\').length" in current tab of front window')
        print(json.dumps({"via": "open -a Safari", "where": label, "open": code, "title": name, "url": url, "type_cards": cards}, ensure_ascii=False))
    quit_safari()

    # 2. safaridriver.
    try:
        from selenium import webdriver
        from selenium.webdriver.common.by import By
        driver = webdriver.Safari()
        for label, path in targets.items():
            try:
                driver.get(path.as_uri())
                deadline = time.monotonic() + 10
                cards = 0
                while time.monotonic() < deadline and not cards:
                    cards = len(driver.find_elements(By.CSS_SELECTOR, ".typeCard"))
                    time.sleep(0.5)
                text = driver.execute_script("return document.body ? document.body.innerText.slice(0, 160) : ''")
                print(json.dumps({"via": "safaridriver", "where": label, "url": driver.current_url, "title": driver.title, "type_cards": cards, "text": text}, ensure_ascii=False))
            except Exception as exc:  # noqa: BLE001 - diagnostic
                print(json.dumps({"via": "safaridriver", "where": label, "error": repr(exc)[:300]}, ensure_ascii=False))
        driver.quit()
    except Exception as exc:  # noqa: BLE001 - diagnostic
        print(json.dumps({"via": "safaridriver", "error": repr(exc)[:300]}))

    for path in made:
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)
    shutil.rmtree(HOME / "PKUNMUN probe", ignore_errors=True)
    run("hdiutil", "detach", mount, "-force")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
