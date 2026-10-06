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
5. The full flow (browser_flow.py) in every installed browser on the installed page; Safari also opens the
   page through 直接用浏览器打开.html, both on the mounted image and copied to the Desktop next to an app in
   ~/Applications.
Writes <out>/macos.json; exit code 1 when a check fails.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
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

        # Full flow in each installed browser; Safari also walks through the opener page.
        user_app.parent.mkdir(exist_ok=True)
        if user_app.exists():
            shutil.rmtree(user_app)
        run("ditto", target, user_app)
        shutil.copy(mount / OPENER, desktop_opener)
        report["browsers"] = {}
        for browser in [b for b in args.browsers.split(",") if b]:
            command = [sys.executable, str(ROOT / "desktop/acceptance/browser_flow.py"), "--browser", browser,
                       "--page", str(target / SITE / "index.html"), "--out", str(args.out)]
            if browser == "safari":
                command += ["--opener", str(mount / OPENER), "--expect", str(mount / "PKUNMUN2026.app" / SITE)]
            result = subprocess.run(command, timeout=1500)
            data = json.loads((args.out / f"{browser}.json").read_text(encoding="utf-8"))
            report["browsers"][browser] = {k: data.get(k) for k in ("available", "version", "passed", "error", "opener", "seconds")}
            if result.returncode == 3:
                print(f"SKIP {browser}: not installed on this machine")
                continue
            check(f"full flow in {browser} {data.get('version')}", result.returncode == 0, data.get("error"))
            if browser == "safari":
                # Copied to the Desktop, the opener finds the app the user installed in ~/Applications.
                desktop_run = subprocess.run(command[:6] + ["--out", str(args.out / "desktop-opener"), "--quick", "--opener", str(desktop_opener),
                                                            "--expect", str(user_app / SITE)], timeout=600)
                check("opener on the Desktop reaches the app in ~/Applications", desktop_run.returncode == 0)
        check("full flow ran in at least one system browser", any(v.get("passed") for v in report["browsers"].values()))
        report["passed"] = True
    except Exception as exc:  # noqa: BLE001 - reported, then exit 1
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["traceback"] = traceback.format_exc()
    finally:
        if mount:
            run("hdiutil", "detach", mount, "-force", check=False)
        for leftover in (user_app,):
            shutil.rmtree(leftover, ignore_errors=True)
        desktop_opener.unlink(missing_ok=True)
    (args.out / "macos.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("macOS acceptance:", "PASS" if report["passed"] else f"FAIL ({report.get('error')})")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
