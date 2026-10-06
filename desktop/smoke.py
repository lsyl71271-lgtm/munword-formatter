"""Start a packaged executable in a fresh user state and exercise its lifecycle."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import subprocess
import shutil
import platform
import tempfile
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--browser-module")
    parser.add_argument("--browser", choices=("chromium", "webkit"), default="chromium")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    executable = args.executable.resolve()
    # All tests intentionally use non-ASCII paths, spaces and a clean state.
    with tempfile.TemporaryDirectory(prefix="Munword 验收 用户 空格 ") as temporary:
        env = {**os.environ, "MUNWORD_STATE_DIR": str(Path(temporary) / "中文 用户 运行目录")}
        child_env = {key: value for key, value in env.items() if key not in ("PYTHONHOME", "PYTHONPATH")}
        child_env["PATH"] = str(Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32") if os.name == "nt" else "/usr/bin:/bin"
        state_file = Path(env["MUNWORD_STATE_DIR"]) / "instance.json"
        subprocess.run([str(executable), "--self-test"], check=True, env=child_env, timeout=30)
        process = subprocess.Popen([str(executable), "--no-browser"], env=child_env)
        try:
            deadline = time.monotonic() + 30
            while not state_file.exists() and time.monotonic() < deadline:
                if process.poll() is not None:
                    error = state_file.parent / "startup-error.txt"
                    raise RuntimeError("Packaged app exited during startup: " + (error.read_text(encoding="utf-8") if error.exists() else str(process.returncode)))
                time.sleep(0.1)
            if not state_file.exists():
                error = state_file.parent / "startup-error.txt"
                raise RuntimeError("Startup timed out: " + (error.read_text(encoding="utf-8") if error.exists() else "no startup error file"))
            state = json.loads(state_file.read_text(encoding="utf-8"))
            origin = "http://127.0.0.1:%d" % state["port"]
            conn = http.client.HTTPConnection("127.0.0.1", state["port"], timeout=5)
            conn.request("GET", "/api/health")
            response = conn.getresponse()
            health = json.loads(response.read())
            assert response.status == 200 and health["offline"] is True
            conn.close()
            for route in ("/", "/app.js", "/desktop.js", "/styles.css", "/favicon.svg"):
                conn = http.client.HTTPConnection("127.0.0.1", state["port"], timeout=5)
                conn.request("GET", route)
                response = conn.getresponse()
                assert response.status == 200 and response.read(), route
                conn.close()
            subprocess.run([str(executable), "--no-browser"], check=True, env=child_env, timeout=15)
            assert json.loads(state_file.read_text(encoding="utf-8"))["instance"] == state["instance"]
            if args.browser_module:
                subprocess.run([shutil.which("node"), "desktop/browser-test.mjs"], check=True, timeout=180,
                               env={**env, "MUNWORD_SMOKE_ORIGIN": origin, "MUNWORD_PLAYWRIGHT_MODULE": args.browser_module, "MUNWORD_TEST_BROWSER": args.browser})
            subprocess.run([str(executable), "--quit"], check=True, env=child_env, timeout=15)
            assert process.wait(timeout=15) == 0
            assert not state_file.exists()
            # A fresh launch after clean shutdown must work too.
            process = subprocess.Popen([str(executable), "--no-browser"], env=child_env)
            deadline = time.monotonic() + 15
            while not state_file.exists() and time.monotonic() < deadline:
                time.sleep(0.1)
            assert state_file.exists()
            subprocess.run([str(executable), "--quit"], check=True, env=child_env, timeout=15)
            assert process.wait(timeout=15) == 0
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps({"executable": executable.name, "version": health["version"], "platform": platform.platform(),
            "runtime_python": health["runtime_python"], "runtime_bits": health["runtime_bits"],
            "sha256": hashlib.sha256(executable.read_bytes()).hexdigest(), "passed": True,
            "checks": ["bundled-asset-integrity", "clean-user-state", "chinese-and-space-paths", "dynamic-loopback-port", "repeat-launch", "authenticated-quit", "relaunch"] + (["browser-upload-recognition-export-preview-template-no-external-network"] if args.browser_module else [])}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
