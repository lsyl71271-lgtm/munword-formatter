"""Native installer acceptance in disposable CI VMs; never modifies real documents."""
import argparse
import http.client
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
    suffix = os.environ.get("MUNWORD_ACCEPTANCE_SUFFIX", "")
    report = ROOT / "dist/desktop" / (artifact.name + suffix + ".acceptance.json")
    # Long-enough paths expose quoting/Unicode bugs without exceeding Windows limits.
    with tempfile.TemporaryDirectory(prefix="Munword 安装 验收 ") as temporary:
        folder = Path(temporary)
        install = folder / "中文 空格 Applications"
        if sys.platform == "win32":
            # NSIS parses /D as the unquoted *remainder* of its command line.
            # list2cmdline([..., '/D=path with spaces']) quotes the entire option
            # and NSIS silently falls back to its default directory. Pass the
            # native command line directly (shell=False; no cmd.exe execution).
            command = subprocess.list2cmdline([str(artifact), "/S"]) + " /D=" + str(install)
            subprocess.run(command, check=True, timeout=120)
            executable = install / "app/Munword.exe"
            assert executable.is_file()
            smoke(executable, report, args.browser_module, args.browser)
            # Reinstall while the old program holds its bundled DLLs open.
            # The installer must stop only our instance before replacing files.
            env = {**os.environ, "MUNWORD_STATE_DIR": str(folder / "升级中的 用户 状态")}
            state = Path(env["MUNWORD_STATE_DIR"]) / "instance.json"
            old = subprocess.Popen([str(executable), "--no-browser"], env=env)
            try:
                deadline = time.monotonic() + 15
                while not state.exists() and time.monotonic() < deadline:
                    time.sleep(0.1)
                assert state.exists(), "Installed old copy did not start"
                subprocess.run(command, check=True, timeout=120, env=env)
                assert old.wait(timeout=15) == 0, "Installer failed to stop old app"
            finally:
                if old.poll() is None:
                    old.terminate()
                    old.wait(timeout=10)
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
                from build import check_macos_signatures
                signatures = check_macos_signatures(app, os.environ.get("MUNWORD_MAC_SIGN_IDENTITY", "-"))
                (ROOT / "dist/desktop/macos-installed-signature-policy.json").write_text(json.dumps(signatures, indent=2), encoding="utf-8")
            finally:
                run("hdiutil", "detach", mount)
            executable = app / "Contents/MacOS/Munword"
            smoke(executable, report, args.browser_module, args.browser)
            # LaunchServices entry point used by Finder, including the default
            # browser launch (the other frozen smoke explicitly suppresses it).
            directory = folder / "系统入口 首次启动"
            state = directory / "instance.json"
            env = {**os.environ, "MUNWORD_STATE_DIR": str(directory)}
            try:
                run("/usr/bin/open", "-n", "--env", "MUNWORD_STATE_DIR=" + str(directory), app, timeout=30)
                deadline = time.monotonic() + 30
                while not state.exists() and time.monotonic() < deadline:
                    time.sleep(0.1)
                assert state.exists(), "LaunchServices did not start the installed app"
                info = json.loads(state.read_text(encoding="utf-8"))
                conn = http.client.HTTPConnection("127.0.0.1", info["port"], timeout=5)
                conn.request("GET", "/api/health")
                response = conn.getresponse()
                assert response.status == 200 and json.loads(response.read())["offline"] is True
                conn.close()
                # Allow the default-browser command to finish before shutdown.
                time.sleep(2)
                assert state.exists() and not (directory / "startup-error.txt").exists(), "Default browser launch failed"
            finally:
                run(executable, "--quit", env=env, timeout=15)
            deadline = time.monotonic() + 15
            while state.exists() and time.monotonic() < deadline:
                time.sleep(0.1)
            assert not state.exists(), "LaunchServices copy did not stop"
            shutil.rmtree(app)
            assert not app.exists()
        else:
            raise ValueError("Native installers must be tested on their OS")
    record = json.loads(report.read_text())
    record["installer"] = artifact.name
    record["installation_checks"] = ["native-install", "installed-copy-launch", "unicode-space-location", "uninstall"]
    if sys.platform == "win32":
        record["installation_checks"].append("reinstall-upgrade-while-old-app-running")
    if sys.platform == "darwin":
        record["installation_checks"].append("installed-copy-signature-flags-and-library-team-consistency")
        record["installation_checks"].append("launchservices-default-browser-start-and-quit")
    record["limitations"] = ["Automated tests do not prove every hardware/OS version or user security-dialog experience", "No Developer ID certificate/notarization unless configured separately"]
    report.write_text(json.dumps(record, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
