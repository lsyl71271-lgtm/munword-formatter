"""Native installer acceptance in disposable CI VMs; never modifies real documents."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def smoke(executable, report, module, browser):
    run(sys.executable, ROOT / "desktop/smoke.py", "--executable", executable, "--browser-module", module,
        "--browser", browser, "--report", report, cwd=ROOT)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--browser-module", required=True)
    parser.add_argument("--browser", default="chromium")
    args = parser.parse_args()
    artifact = args.installer.resolve()
    report = ROOT / "dist/desktop" / (artifact.name + ".acceptance.json")
    # Long-enough paths expose quoting/Unicode bugs without exceeding Windows limits.
    with tempfile.TemporaryDirectory(prefix="Munword 安装 验收 ") as temporary:
        folder = Path(temporary)
        install = folder / "中文 空格 Applications"
        if sys.platform == "win32":
            command = [str(artifact), "/S", "/D=" + str(install)]  # NSIS /D must be last, unquoted in its argument.
            run(*command, timeout=120)
            executable = install / "app/Munword.exe"
            assert executable.is_file()
            smoke(executable, report, args.browser_module, args.browser)
            # Reinstall/upgrade the exact same package, then test again.
            run(*command, timeout=120)
            smoke(executable, report, args.browser_module, args.browser)
            uninstaller = install / "Uninstall.exe"
            run(uninstaller, "/S", timeout=120)
            deadline = time.monotonic() + 15
            while executable.exists() and time.monotonic() < deadline:
                time.sleep(0.2)
            assert not executable.exists(), "Uninstall did not remove app"
        elif sys.platform == "darwin":
            run("hdiutil", "verify", artifact)
            result = subprocess.check_output(["hdiutil", "attach", "-readonly", "-nobrowse", "-plist", str(artifact)])
            import plistlib
            entities = plistlib.loads(result)["system-entities"]
            mount = Path(next(entry["mount-point"] for entry in entities if "mount-point" in entry))
            try:
                # DMG copy preserves symlinks/code signature; app runs outside build tree.
                install.mkdir()
                app = install / "Munword.app"
                run("ditto", mount / "Munword.app", app)
                run("codesign", "--verify", "--deep", "--strict", app)
            finally:
                run("hdiutil", "detach", mount)
            executable = app / "Contents/MacOS/Munword"
            smoke(executable, report, args.browser_module, args.browser)
            shutil.rmtree(app)
            assert not app.exists()
        else:
            raise ValueError("Native installers must be tested on their OS")
    record = json.loads(report.read_text())
    record["installer"] = artifact.name
    record["installation_checks"] = ["native-install", "installed-copy-launch", "unicode-space-location", "uninstall"]
    if sys.platform == "win32":
        record["installation_checks"].append("reinstall-upgrade")
    record["limitations"] = ["Automated tests do not prove every hardware/OS version or user security-dialog experience", "No Developer ID certificate/notarization unless configured separately"]
    report.write_text(json.dumps(record, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
