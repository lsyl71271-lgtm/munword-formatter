"""Self-contained offline desktop host. Document processing stays in the shared UI.

No pip, Node, API backend, cloud URLs, administrator rights or fixed ports at
runtime. Only explicit, hash-checked public assets are served on IPv4 loopback.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import http.client
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

SERVICE = "munword-offline-desktop"
IDLE_SECONDS = 1800


def resource_root() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "site"


def state_root() -> Path:
    override = os.environ.get("MUNWORD_STATE_DIR")  # Test isolation, never an install path.
    if override:
        return Path(override)
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            raise RuntimeError("系统没有提供 LOCALAPPDATA，无法创建本机运行目录。")
        return Path(local) / "Munword" / "runtime"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Munword" / "runtime"
    return Path.home() / ".local" / "state" / "Munword"


class InstanceLock:
    """OS-owned lock: stale files cannot block launch, and no PID is ever killed."""

    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True)
        self.stream = (directory / "instance.lock").open("a+b")
        self.held = False

    def acquire(self) -> bool:
        self.stream.seek(0)
        try:
            if sys.platform == "win32":
                import msvcrt
                if not self.stream.read(1):
                    self.stream.write(b"0")
                    self.stream.flush()
                self.stream.seek(0)
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.held = True
        except OSError:
            return False
        return True

    def close(self):
        if self.held:
            if sys.platform == "win32":
                import msvcrt
                self.stream.seek(0)
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
        self.stream.close()


def load_assets(root: Path) -> tuple[dict, dict[str, bytes]]:
    manifest = json.loads((root / "desktop-manifest.json").read_text(encoding="utf-8"))
    assets = {}
    for route, entry in manifest["assets"].items():
        path = (root / entry["file"]).resolve()
        if not route.startswith("/") or root.resolve() not in path.parents or not path.is_file():
            raise ValueError("安装文件清单无效，请重新安装。")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError("安装文件校验失败，请重新下载并安装完整版本。")
        assets[route] = data
    for route in ("/", "/app.js", "/styles.css", "/desktop.js"):
        if not assets.get(route):
            raise ValueError("离线界面不完整，请重新安装。")
    return manifest, assets


class OfflineServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, root: Path, port: int = 0):
        self.manifest, self.assets = load_assets(root)
        self.token = secrets.token_hex(32)
        self.instance = secrets.token_hex(16)
        self.last_activity = time.monotonic()
        super().__init__(("127.0.0.1", port), Handler)
        self.origin = "http://127.0.0.1:%d" % self.server_address[1]


class Handler(BaseHTTPRequestHandler):
    # Avoid request/body/path logging: documents are never transmitted here.
    def log_message(self, *args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def send(self, status: int, body: bytes, mime: str = "application/json", cookie: bool = False):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; connect-src 'self'; frame-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        if cookie:
            self.send_header("Set-Cookie", "munword_session=%s; HttpOnly; SameSite=Strict; Path=/" % self.server.token)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def valid_host(self) -> bool:
        return self.headers.get("Host") == "127.0.0.1:%d" % self.server.server_address[1]

    def do_GET(self):
        if not self.valid_host():
            return self.send(403, b'{"error":"host"}')
        route = urlsplit(self.path).path
        if route == "/api/health":
            info = {"service": SERVICE, "status": "ok", "version": self.server.manifest["version"], "instance": self.server.instance,
                    "offline": True, "runtime_python": sys.version.split()[0], "runtime_bits": struct.calcsize("P") * 8}
            return self.send(200, json.dumps(info).encode())
        if route == "/__desktop/ping":
            if self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
                return self.send(403, b'{}')
            self.server.last_activity = time.monotonic()
            return self.send(200, b'{}')
        if route not in self.server.assets:
            return self.send(404, b'{"error":"not found"}')
        self.server.last_activity = time.monotonic()
        self.send(200, self.server.assets[route], self.server.manifest["assets"][route]["mime"], cookie=route == "/")

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        if not self.valid_host():
            return self.send(403, b'{}')
        route = urlsplit(self.path).path
        if route != "/__desktop/quit":
            return self.send(405, b'{}')
        native = hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.server.token)
        cookies = dict(part.strip().split("=", 1) for part in self.headers.get("Cookie", "").split(";") if "=" in part)
        browser = (self.headers.get("Origin") == self.server.origin
                   and self.headers.get("X-Munword-Action") == "quit"
                   and hmac.compare_digest(cookies.get("munword_session", ""), self.server.token))
        if not native and not browser:
            return self.send(403, b'{}')
        self.send(200, b'{"stopped":true}')
        threading.Thread(target=self.server.shutdown, daemon=True).start()


def existing_state(directory: Path) -> dict:
    state = json.loads((directory / "instance.json").read_text(encoding="utf-8"))
    if not isinstance(state.get("port"), int) or not 1 <= state["port"] <= 65535:
        raise ValueError("Invalid port")
    conn = http.client.HTTPConnection("127.0.0.1", state["port"], timeout=2)
    try:
        conn.request("GET", "/api/health")
        response = conn.getresponse()
        info = json.loads(response.read(4096))
        if response.status != 200 or info.get("service") != SERVICE or info.get("instance") != state["instance"]:
            raise ValueError("Not this desktop instance")
    finally:
        conn.close()
    return state


def quit_existing(directory: Path) -> bool:
    try:
        state = existing_state(directory)
    except (OSError, ValueError, KeyError, http.client.HTTPException):
        return False
    conn = http.client.HTTPConnection("127.0.0.1", state["port"], timeout=3)
    try:
        conn.request("POST", "/__desktop/quit", headers={"Authorization": "Bearer " + state["token"]})
        response = conn.getresponse()
        response.read()
        return response.status == 200
    finally:
        conn.close()


def open_browser(url: str):
    if sys.platform == "win32":
        os.startfile(url)
    elif sys.platform == "darwin":
        subprocess.run(["/usr/bin/open", url], check=True)
    else:
        import webbrowser
        if not webbrowser.open(url):
            raise RuntimeError("无法打开默认浏览器，请在浏览器中打开：" + url)


def message(text: str):
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, "Munword 本机排版", 0x10)
    elif sys.platform == "darwin":
        # JSON strings are also safely quoted AppleScript text literals.
        subprocess.run(["/usr/bin/osascript", "-e", "display dialog " + json.dumps(text, ensure_ascii=False) + ' with title "Munword 本机排版" buttons {"好"} default button 1'], check=False)
    else:
        print(text, file=sys.stderr)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-browser", action="store_true", help="For offline acceptance tests")
    parser.add_argument("--self-test", action="store_true", help="Verify bundled offline files and exit")
    parser.add_argument("--quit", action="store_true", help="Stop only our authenticated local instance")
    args = parser.parse_args(argv)
    directory = state_root()
    if args.quit:
        quit_existing(directory)
        return 0
    manifest, _ = load_assets(resource_root())
    if args.self_test:
        print(json.dumps({"ok": True, "version": manifest["version"], "offline": True}))
        return 0
    lock = InstanceLock(directory)
    server = None
    try:
        if not lock.acquire():
            state = None
            for _ in range(40):
                try:
                    state = existing_state(directory)
                    break
                except (OSError, ValueError, KeyError, http.client.HTTPException):
                    time.sleep(0.1)
            if state is None:
                raise RuntimeError("另一个排版程序正在启动，请稍后重试。")
            if state["version"] != manifest["version"]:
                raise RuntimeError("旧版本仍在运行，请点击页面顶部的“退出本机程序”后再打开新版。")
            if not args.no_browser:
                open_browser("http://127.0.0.1:%d/" % state["port"])
            return 0
        handler = RotatingFileHandler(directory / "launcher.log", maxBytes=1_000_000, backupCount=1, encoding="utf-8")
        logging.basicConfig(handlers=[handler], level=logging.WARNING)
        server = OfflineServer(resource_root())
        state = {"port": server.server_address[1], "instance": server.instance, "token": server.token,
                 "pid": os.getpid(), "version": manifest["version"]}
        temporary = directory / ("instance-" + server.instance + ".tmp")
        temporary.write_text(json.dumps(state), encoding="utf-8")
        if sys.platform != "win32":
            temporary.chmod(0o600)
        os.replace(temporary, directory / "instance.json")
        running = threading.Thread(target=server.serve_forever, daemon=True)
        running.start()
        try:
            if not args.no_browser:
                open_browser(server.origin + "/")
            while running.is_alive():
                running.join(timeout=1)
                if time.monotonic() - server.last_activity > IDLE_SECONDS:
                    server.shutdown()
        finally:
            server.shutdown()
            running.join(timeout=5)
        return 0
    finally:
        if server:
            server.server_close()
        if lock.held:
            (directory / "instance.json").unlink(missing_ok=True)
        lock.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        logging.exception("Desktop launch failed")
        message("程序无法启动：%s\n\n请重新安装完整版本；运行记录位于本机 Munword/runtime 目录。" % exc)
        raise SystemExit(1)
