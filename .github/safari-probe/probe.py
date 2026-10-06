"""Temporary diagnostic: read what Safari shows (Accessibility) when pages are opened the way users open them."""
import json
import os
import plistlib
import shutil
import subprocess
import time
from pathlib import Path
from urllib.parse import unquote

from ApplicationServices import AXUIElementCopyAttributeValue, AXUIElementCreateApplication

ROOT = Path(__file__).resolve().parents[2]
DMG = ROOT / "downloads" / "PKUNMUN2026-Formatter-macOS.dmg"
SITE = Path("Contents/Resources/site")
HOME = Path.home()


def run(*command, timeout=30, env=None):
    try:
        r = subprocess.run([str(c) for c in command], capture_output=True, text=True, timeout=timeout, env=env)
        return r.returncode, (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return -1, "timeout"


def say(**data):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def safari_page():
    code, out = run("pgrep", "-x", "Safari")
    if code:
        return {"error": "Safari not running"}
    app = AXUIElementCreateApplication(int(out.split()[0]))
    found = {"url": None, "texts": [], "nodes": 0}
    stack = [(app, 0)]
    while stack and found["nodes"] < 8000:
        element, depth = stack.pop()
        found["nodes"] += 1

        def get(name):
            err, value = AXUIElementCopyAttributeValue(element, name, None)
            return value if err == 0 else None
        role = get("AXRole")
        if role == "AXWebArea" and found["url"] is None:
            url = get("AXURL")
            found["url"] = unquote(str(url.absoluteString() if hasattr(url, "absoluteString") else url)) if url is not None else None
        if role == "AXStaticText":
            value = get("AXValue")
            if value:
                found["texts"].append(str(value))
        if depth < 90:
            for child in reversed(list(get("AXChildren") or [])):
                stack.append((child, depth + 1))
    return found


def main():
    attached = plistlib.loads(subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-plist", str(DMG)], capture_output=True, check=True).stdout)
    mount = Path(next(e["mount-point"] for e in attached["system-entities"] if "mount-point" in e))
    system_app = Path("/Applications/PKUNMUN2026.app")
    run("ditto", mount / "PKUNMUN2026.app", system_app)
    single = HOME / "Desktop" / "直接用浏览器打开.html"
    shutil.copy(ROOT / ".github/safari-probe/single.html", single)
    cases = [("installed page", system_app / SITE / "index.html"), ("single-file page on Desktop", single)]
    for label, path in cases:
        run("pkill", "-x", "Safari")
        time.sleep(2)
        code, out = run("open", "-a", "Safari", path)
        started = time.monotonic()
        page = {}
        while time.monotonic() - started < 40:
            time.sleep(2)
            page = safari_page()
            if any("决议草案" in t for t in page.get("texts", [])):
                break
        texts = page.get("texts", [])
        say(case=label, seconds=round(time.monotonic() - started, 1), url=page.get("url"), nodes=page.get("nodes"),
            type_cards=[t for t in texts if t in ("立场文件", "工作文件", "指令草案", "决议草案", "友好修正案", "非友好修正案")],
            first_texts=texts[:25], error=page.get("error"))
    run("pkill", "-x", "Safari")
    shutil.rmtree(system_app, ignore_errors=True)
    single.unlink(missing_ok=True)
    run("hdiutil", "detach", mount, "-force")


if __name__ == "__main__":
    main()
