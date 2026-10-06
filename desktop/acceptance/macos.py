"""Native macOS acceptance of downloads/PKUNMUN2026-Formatter-macOS.dmg (GitHub Actions VMs).

    python desktop/acceptance/macos.py --out <dir> [--browsers safari,chrome,firefox]

1. hdiutil verifies the image's checksums, mounts it read-only; the volume shows the app, Applications,
   the readme and 直接用浏览器打开.html under their Chinese names.
2. The app, copied with ditto into a folder with Chinese and spaces, passes Apple's own
   `codesign --verify --deep --strict` (the check behind "is damaged"). Gatekeeper's verdict with and
   without the download quarantine is recorded; it must not be a broken-signature verdict.
3. The universal entry point runs natively on this machine's architecture (and the other one if Rosetta is
   present) and hands over to the launcher script; the launcher's browser choice is recorded.
4. LaunchServices opens the app for real; a browser must open the bundled page.
5. The full flow (browser_flow.py) in every installed browser. Chrome and Firefox run it on the installed
   page in the folder with Chinese and spaces, then on 直接用浏览器打开.html (the whole page in one file)
   copied on its own to another folder. Safari's driver refuses every file:// page ("outside the sandbox", wherever the
   file is), so Safari runs it on the page installed in /Applications served over http://127.0.0.1.
6. Safari the way users reach it: the app's launcher choosing Safari, 直接用浏览器打开.html on the mounted
   image and copied to the Desktop are opened through LaunchServices; the page Safari shows is read back
   through Accessibility (its file:// address and the rendered document-type cards) and screenshotted.
Writes <out>/macos.json; exit code 1 when a check fails.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import unicodedata
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
DMG = ROOT / "downloads" / "PKUNMUN2026-Formatter-macOS.dmg"
OPENER = "直接用浏览器打开.html"
SITE = Path("Contents/Resources/site")
BROKEN = ("damaged", "invalid", "modified", "not signed at all", "sealed resource", "corrupt")


def run(*command, check=True, **kwargs):
    result = subprocess.run([str(c) for c in command], capture_output=True, text=True, **kwargs)
    if check and result.returncode != 0:
        raise AssertionError(f"{' '.join(map(str, command))} failed ({result.returncode}): {result.stdout}{result.stderr}")
    return result


TYPES = ("立场文件", "工作文件", "指令草案", "决议草案", "友好修正案", "非友好修正案")


def type_cards(texts) -> list:
    """Document types whose card text Safari shows ("友好修正案" on its own, not inside "非友好修正案")."""
    return [t for t in TYPES if any(t in text and (t != "友好修正案" or text.replace("非友好修正案", "").count(t)) for text in texts)]


def safari_page() -> dict:
    """The page in Safari's front window as Accessibility exposes it: address and visible texts."""
    from ApplicationServices import AXUIElementCopyAttributeValue, AXUIElementCreateApplication

    pids = run("pgrep", "-x", "Safari", check=False).stdout.split()
    if not pids:
        return {"url": None, "texts": []}
    found = {"url": None, "texts": []}
    stack, visited = [(AXUIElementCreateApplication(int(pids[0])), 0)], 0
    while stack and visited < 8000:
        element, depth = stack.pop()
        visited += 1

        def get(name):
            err, value = AXUIElementCopyAttributeValue(element, name, None)
            return value if err == 0 else None
        if get("AXRole") == "AXWebArea" and found["url"] is None and get("AXURL") is not None:
            url = get("AXURL")
            found["url"] = unquote(str(url.absoluteString() if hasattr(url, "absoluteString") else url))
        # Text nodes carry AXValue; buttons such as the document-type cards carry their text as title/description.
        for name in ("AXValue", "AXTitle", "AXDescription"):
            value = get(name)
            if isinstance(value, str) and value.strip():
                found["texts"].append(value.strip())
        if depth < 90:
            stack.extend((child, depth + 1) for child in reversed(list(get("AXChildren") or [])))
    return found


def serve(directory: Path):
    """The installed page over http://127.0.0.1 for Safari's driver; returns (server, url)."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))
    handler.log_message = lambda *a: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/index.html"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--browsers", default="safari,chrome,firefox")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    report = {"platform": platform.platform(), "machine": platform.machine(), "image": DMG.name, "checks": [], "passed": False}

    def check(name: str, ok: bool, detail=None):
        report["checks"].append({"check": name, "ok": bool(ok), **({"detail": detail} if detail is not None else {})})
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail is not None and not ok else ""))
        if not ok:
            raise AssertionError(name)

    work = Path(tempfile.mkdtemp(prefix="PKUNMUN 验收 "))
    mount = None
    user_app = Path.home() / "Applications" / "PKUNMUN2026.app"
    system_app = Path("/Applications/PKUNMUN2026.app")
    installs = []
    desktop_opener = Path.home() / "Desktop" / OPENER
    try:
        verify = run("hdiutil", "verify", DMG, check=False)
        check("hdiutil verifies the image checksums", verify.returncode == 0, verify.stdout[-500:] + verify.stderr[-500:])
        info = plistlib.loads(run("hdiutil", "imageinfo", "-plist", DMG).stdout.encode())
        report["image_format"] = info.get("Format")
        check("compressed read-only image (UDZO)", info.get("Format") == "UDZO", info.get("Format"))
        attached = plistlib.loads(run("hdiutil", "attach", "-readonly", "-nobrowse", "-plist", DMG).stdout.encode())
        mount = Path(next(e["mount-point"] for e in attached["system-entities"] if "mount-point" in e))
        report["mount_point"] = str(mount)
        names = sorted(unicodedata.normalize("NFC", n) for n in os.listdir(mount))
        report["volume"] = names
        check("volume has the app, Applications, readme and browser page", {"PKUNMUN2026.app", "Applications", "安装说明.txt", OPENER} <= set(names), names)
        check("Applications is a link to /Applications", os.readlink(mount / "Applications") == "/Applications")

        target = work / "中文 空格" / "PKUNMUN2026.app"
        target.parent.mkdir(parents=True)
        run("ditto", mount / "PKUNMUN2026.app", target)
        verified = run("codesign", "--verify", "--deep", "--strict", "--verbose=4", target, check=False)
        report["codesign_verify"] = verified.stderr.strip()
        check("Apple codesign accepts the signature (no 'damaged' app)", verified.returncode == 0, verified.stderr)
        details = run("codesign", "-dvvv", target, check=False).stderr
        report["codesign_details"] = details
        check("one universal arm64 + x86_64 executable", "Mach-O universal (x86_64 arm64)" in details or "Mach-O universal (arm64 x86_64)" in details, details)
        archs = run("lipo", "-archs", target / "Contents/MacOS/PKUNMUN2026").stdout.split()
        report["archs"] = archs

        # Gatekeeper: an unsigned-by-Apple app is rejected for lack of a Developer ID, never for a broken signature.
        verdicts = {}
        for label, quarantined in (("local copy", False), ("downloaded copy", True)):
            copy = work / label / "PKUNMUN2026.app"
            copy.parent.mkdir()
            run("ditto", target, copy)
            if quarantined:
                run("xattr", "-w", "com.apple.quarantine", f"0081;{int(time.time()):x};Safari;", copy)
            assessed = run("spctl", "--assess", "--type", "execute", "-vv", copy, check=False)
            verdicts[label] = {"exit": assessed.returncode, "output": (assessed.stdout + assessed.stderr).strip()}
        if shutil.which("syspolicy_check"):
            policy = run("syspolicy_check", "distribution", work / "downloaded copy" / "PKUNMUN2026.app", check=False)
            verdicts["syspolicy_check distribution"] = {"exit": policy.returncode, "output": (policy.stdout + policy.stderr).strip()[-1500:]}
        report["gatekeeper"] = verdicts
        text = json.dumps(verdicts).lower()
        check("Gatekeeper's verdict is not a broken-signature verdict", not any(word in text for word in BROKEN), verdicts)

        # The entry point itself, natively, with open(1) replaced by a recorder.
        report["entry_point"] = {}
        machine = run("uname", "-m").stdout.strip()
        for arch in archs:
            if arch != machine and run("arch", f"-{arch}", "/usr/bin/true", check=False).returncode != 0:
                report["entry_point"][arch] = "not runnable here (no Rosetta)"
                continue
            log = work / f"open-{arch}.log"
            stub = work / f"open-{arch}"
            stub.write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{log}"\n', encoding="utf-8")
            stub.chmod(0o755)
            env = {**os.environ, "MUNWORD_OPEN": str(stub), "MUNWORD_ALERT": str(work / f"alert-{arch}.log")}
            started = run("arch", f"-{arch}", target / "Contents/MacOS/PKUNMUN2026", env=env, check=False)
            calls = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
            report["entry_point"][arch] = {"exit": started.returncode, "open_calls": calls}
            check(f"{arch} entry point runs the launcher", started.returncode == 0 and len(calls) == 1 and str(target / SITE) in unquote(calls[0]), report["entry_point"][arch])

        # LaunchServices for real (no quarantine on this copy): a browser opens the bundled page.
        page_marker = "PKUNMUN2026.app/Contents/Resources/site/index.html"
        before = set(run("pgrep", "-f", page_marker, check=False).stdout.split())
        run("open", "-n", target)
        found = ""
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline and not found:
            listing = run("ps", "-axo", "pid=,command=").stdout
            found = next((line for line in listing.splitlines() if page_marker.replace(" ", "%20") in line and line.split()[0] not in before), "")
            if not found and run("pgrep", "-x", "Safari", check=False).returncode == 0:
                found = "Safari (page opened as a document)"
            time.sleep(0.5)
        report["launch_services"] = found.strip()
        check("opening the app shows the page in a browser", bool(found), found)
        run("pkill", "-f", "--app=file://", check=False)

        # Full flow in each installed browser (see 5. above).
        user_app.parent.mkdir(exist_ok=True)
        for installed in (user_app, system_app):
            if installed.exists() and not os.environ.get("CI"):
                raise AssertionError(f"{installed} exists; run on a CI machine or remove it first")
            shutil.rmtree(installed, ignore_errors=True)
            installs.append(installed)
            run("ditto", target, installed)
        shutil.copy(mount / OPENER, desktop_opener)
        lone_page = work / "单独复制的 网页" / OPENER
        lone_page.parent.mkdir()
        shutil.copy(mount / OPENER, lone_page)
        report["browsers"] = {}
        flow = [sys.executable, str(ROOT / "desktop/acceptance/browser_flow.py")]
        for browser in [b for b in args.browsers.split(",") if b]:
            server = None
            if browser == "safari":
                server, url = serve(system_app / SITE)
                where = ["--url", url]
            else:
                where = ["--page", str(target / SITE / "index.html")]
            try:
                result = subprocess.run(flow + ["--browser", browser, *where, "--out", str(args.out)], timeout=1500)
            finally:
                if server:
                    server.shutdown()
            data = json.loads((args.out / f"{browser}.json").read_text(encoding="utf-8"))
            report["browsers"][browser] = {k: data.get(k) for k in ("available", "version", "passed", "error", "page_url", "seconds")}
            if result.returncode == 3:
                print(f"SKIP {browser}: not installed on this machine")
                continue
            check(f"full flow in {browser} {data.get('version')}" + (" (page served over http)" if server else ""), result.returncode == 0, data.get("error"))
            if browser != "safari":
                # A driver-opened browser would need the Desktop folder permission, so its copy stands alone elsewhere.
                single = subprocess.run(flow + ["--browser", browser, "--page", str(lone_page), "--out", str(args.out / "single-file"), "--quick"], timeout=600)
                check(f"{OPENER} copied on its own runs in {browser}", single.returncode == 0)

        # Safari the way users open it (see 6. above).
        if "safari" in report["browsers"] and report["browsers"]["safari"].get("available"):
            no_browsers = work / "no other browsers"
            no_browsers.mkdir()
            cases = [
                ("the app's launcher choosing Safari", [system_app / "Contents/MacOS/PKUNMUN2026"],
                 {**os.environ, "MUNWORD_APPLICATIONS": str(no_browsers)}, system_app / SITE / "index.html"),
                (f"{OPENER} on the disk image", ["open", "-a", "Safari", mount / OPENER], None, mount / OPENER),
                (f"{OPENER} copied to the Desktop", ["open", "-a", "Safari", desktop_opener], None, desktop_opener),
            ]
            report["safari_as_users_open_it"] = {}
            for label, command, env, page in cases:
                run("pkill", "-x", "Safari", check=False)
                time.sleep(2)
                run(*command, env=env)
                shown, deadline = {}, time.monotonic() + 45
                while time.monotonic() < deadline:
                    time.sleep(2)
                    shown = safari_page()
                    if len(type_cards(shown["texts"])) == len(TYPES):
                        break
                cards = type_cards(shown["texts"])
                run("screencapture", "-x", args.out / f"safari {label}.png", check=False)
                report["safari_as_users_open_it"][label] = {"url": shown.get("url"), "type_cards": cards, "texts": shown["texts"][:40]}
                check(f"Safari shows the app for {label}", shown.get("url") == unquote(page.as_uri()) and len(cards) == len(TYPES),
                      {"url": shown.get("url"), "expected": unquote(page.as_uri()), "type_cards": cards, "texts": shown["texts"][:20]})
            run("pkill", "-x", "Safari", check=False)
        check("full flow ran in at least one system browser", any(v.get("passed") for v in report["browsers"].values()))
        report["passed"] = True
    except Exception as exc:  # noqa: BLE001 - reported, then exit 1
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["traceback"] = traceback.format_exc()
    finally:
        if mount:
            run("hdiutil", "detach", mount, "-force", check=False)
        for leftover in installs:
            shutil.rmtree(leftover, ignore_errors=True)
        desktop_opener.unlink(missing_ok=True)
    (args.out / "macos.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("macOS acceptance:", "PASS" if report["passed"] else f"FAIL ({report.get('error')})")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
