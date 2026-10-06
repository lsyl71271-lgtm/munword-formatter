"""Native Windows acceptance of downloads/PKUNMUN2026-Formatter-Windows-Setup.exe (GitHub Actions VMs).

    python desktop/acceptance/windows.py --out <dir> [--browsers edge,chrome,firefox]

1. Silent install of the previous release (1.8.4, from git history) into a folder whose path has Chinese,
   spaces and "#"; then the current installer over it: the old page is replaced completely.
2. Files, desktop and Start-menu shortcuts, the per-user uninstall entry (no machine-wide one).
3. The launcher starts a real browser with an app window on the correctly escaped file:/// URL.
4. The full flow (browser_flow.py) in every installed browser, on the installed page.
5. Silent uninstall removes files, shortcuts and the uninstall entry.
Writes <out>/windows.json; exit code 1 when a check fails.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
import traceback
import winreg
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SETUP = ROOT / "downloads" / "PKUNMUN2026-Formatter-Windows-Setup.exe"
PREVIOUS = "e5ea0c3"  # commit that published the 1.8.4 installers
APP_NAME = "PKUNMUN 2026 文件排版系统"
UNINSTALL_KEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\PKUNMUN2026Formatter"
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()


def powershell(script: str) -> str:
    return subprocess.run(["powershell", "-NoProfile", "-Command", script], check=True, capture_output=True, text=True, encoding="utf-8").stdout


def known_folder(name: str) -> Path:
    return Path(powershell(f"[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('{name}')").strip())


def install(installer: Path, target: Path):
    # NSIS takes /D= unquoted and last on the command line; a list would quote it and be ignored.
    subprocess.run(f'"{installer}" /S /D={target}', check=True, timeout=180)


def version_of(target: Path) -> str:
    return json.loads((target / "site" / "version.json").read_text(encoding="utf-8"))["version"]


def registry(root=winreg.HKEY_CURRENT_USER, view: int = 0) -> dict | None:
    try:
        with winreg.OpenKey(root, UNINSTALL_KEY, 0, winreg.KEY_READ | view) as key:
            return {name: winreg.QueryValueEx(key, name)[0] for name in ("DisplayName", "DisplayVersion", "UninstallString", "QuietUninstallString", "InstallLocation")}
    except FileNotFoundError:
        return None


def browser_processes() -> list[dict]:
    out = powershell("[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
                     "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*site/index.html*' } | "
                     "Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress")
    data = json.loads(out) if out.strip() else []
    return data if isinstance(data, list) else [data]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--browsers", default="edge,chrome,firefox")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    report = {"platform": platform.platform(), "machine": platform.machine(), "installer": SETUP.name, "checks": [], "passed": False}

    def check(name: str, ok: bool, detail=None):
        report["checks"].append({"check": name, "ok": bool(ok), **({"detail": detail} if detail is not None else {})})
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail is not None and not ok else ""))
        if not ok:
            raise AssertionError(name)

    work = Path(tempfile.mkdtemp(prefix="PKUNMUN 验收 "))
    target = work / "中文 空格#1" / "App"
    try:
        old = work / "setup-1.8.4.exe"
        old.write_bytes(subprocess.run(["git", "show", f"{PREVIOUS}:downloads/{SETUP.name}"], cwd=ROOT, check=True, capture_output=True).stdout)
        install(old, target)
        check("previous release installs silently", version_of(target) == "1.8.4", version_of(target))
        (target / "site" / "stale-from-1.8.4.txt").write_text("old", encoding="utf-8")
        install(SETUP, target)
        check(f"upgrade installs {VERSION}", version_of(target) == VERSION, version_of(target))
        check("upgrade removes the old page completely", not (target / "site" / "stale-from-1.8.4.txt").exists())
        for name in ("site/index.html", "site/app.js", "site/styles.css", "PKUNMUN2026Formatter.exe", "uninstall.exe", "app.ico", "使用说明.txt"):
            check(f"installed {name}", (target / name).is_file())
        desktop, programs = known_folder("Desktop"), known_folder("Programs")
        check("desktop shortcut", (desktop / f"{APP_NAME}.lnk").is_file(), str(desktop))
        check("Start-menu shortcut", (programs / f"{APP_NAME}.lnk").is_file(), str(programs))
        entry = registry()
        report["uninstall_entry"] = entry
        check("per-user uninstall entry", entry and entry["DisplayName"] == APP_NAME and entry["DisplayVersion"] == VERSION, entry)
        check("no machine-wide uninstall entry", all(registry(winreg.HKEY_LOCAL_MACHINE, view) is None for view in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY)))

        # The launcher picks a browser by itself; the page must open as an app window on the escaped URL.
        before = {p["ProcessId"] for p in browser_processes()}
        subprocess.run([str(target / "PKUNMUN2026Formatter.exe")], check=True, timeout=60)
        expected = "file:///" + str(target / "site" / "index.html").replace("%", "%25").replace("\\", "/").replace(" ", "%20").replace("#", "%23")
        started = []
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not started:
            started = [p for p in browser_processes() if p["ProcessId"] not in before]
            time.sleep(0.5)
        report["launched"] = started
        main_process = next((p for p in started if "--type=" not in (p["CommandLine"] or "")), started[0] if started else None)
        check("launcher starts a browser on the installed page", bool(main_process), started)
        command = main_process["CommandLine"]
        check("browser gets the escaped file URL", expected in command, {"expected": expected, "command": command})
        check("Chromium browsers open an app window without first-run pages",
              "-new-window" in command or ("--app=" in command and "--no-first-run" in command), command)
        for process in started:
            subprocess.run(["taskkill", "/PID", str(process["ProcessId"]), "/T", "/F"], capture_output=True)

        report["browsers"] = {}
        for browser in [b for b in args.browsers.split(",") if b]:
            result = subprocess.run([sys.executable, str(ROOT / "desktop" / "acceptance" / "browser_flow.py"), "--browser", browser,
                                     "--page", str(target / "site" / "index.html"), "--out", str(args.out)], timeout=1200)
            data = json.loads((args.out / f"{browser}.json").read_text(encoding="utf-8"))
            report["browsers"][browser] = {k: data.get(k) for k in ("available", "version", "passed", "error", "seconds")}
            if result.returncode == 3:
                print(f"SKIP {browser}: not installed on this machine")
                continue
            check(f"full flow in {browser} {data.get('version')}", result.returncode == 0, data.get("error"))
        check("full flow ran in at least one system browser", any(v.get("passed") for v in report["browsers"].values()))

        subprocess.run([str(target / "uninstall.exe"), "/S"], check=True, timeout=120)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and (target / "PKUNMUN2026Formatter.exe").exists():
            time.sleep(0.5)
        time.sleep(2)
        check("uninstall removes the program", not (target / "PKUNMUN2026Formatter.exe").exists() and not (target / "site").exists())
        check("uninstall removes the shortcuts", not (desktop / f"{APP_NAME}.lnk").exists() and not (programs / f"{APP_NAME}.lnk").exists())
        check("uninstall removes the uninstall entry", registry() is None)
        report["passed"] = True
    except Exception as exc:  # noqa: BLE001 - reported, then exit 1
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["traceback"] = traceback.format_exc()
    (args.out / "windows.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Windows acceptance:", "PASS" if report["passed"] else f"FAIL ({report.get('error')})")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
