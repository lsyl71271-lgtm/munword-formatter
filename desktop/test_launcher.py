"""Portable acceptance of security/lifecycle behavior; native installers are tested separately."""
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("desktop_launcher", Path(__file__).with_name("launcher.py"))
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


def make_site(root):
    assets = {}
    for route, name in [("/", "index.html"), ("/app.js", "app.js"), ("/styles.css", "styles.css"), ("/desktop.js", "desktop.js")]:
        data = b"synthetic public asset"
        (root / name).write_bytes(data)
        assets[route] = {"file": name, "mime": "text/plain", "sha256": hashlib.sha256(data).hexdigest()}
    (root / "desktop-manifest.json").write_text(json.dumps({"version": "1.8.5", "assets": assets}))


class DesktopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="Munword 中文 空格 ")
        self.root = Path(self.temp.name)
        make_site(self.root)
        self.server = launcher.OfflineServer(self.root)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        self.temp.cleanup()

    def request(self, method, path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=3)
        try:
            conn.request(method, path, headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def test_chinese_paths_static_allowlist_and_offline_policy(self):
        status, headers, data = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("SameSite=Strict", headers["Set-Cookie"])
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("connect-src 'self'", headers["Content-Security-Policy"])
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        for route in ("/../launcher.py", "/%2e%2e/launcher.py", "/.env", "/desktop-manifest.json", "/instance.json"):
            self.assertEqual(self.request("GET", route)[0], 404)
        self.assertEqual(self.request("POST", "/api/parse/position-paper")[0], 405)

    def test_rebinding_and_foreign_shutdown_are_rejected(self):
        self.assertEqual(self.request("GET", "/", {"Host": "attacker.invalid"})[0], 403)
        self.assertEqual(self.request("POST", "/__desktop/quit")[0], 403)
        headers = {"Cookie": "munword_session=" + self.server.token, "X-Munword-Action": "quit", "Origin": "https://attacker.invalid"}
        self.assertEqual(self.request("POST", "/__desktop/quit", headers)[0], 403)
        self.assertEqual(self.request("GET", "/__desktop/ping", {"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.request("POST", "/__desktop/quit", {"Authorization": "Bearer wrong"})[0], 403)

    def test_authenticated_browser_shutdown(self):
        headers = {"Cookie": "munword_session=" + self.server.token, "X-Munword-Action": "quit", "Origin": self.server.origin}
        self.assertEqual(self.request("POST", "/__desktop/quit", headers)[0], 200)
        self.thread.join(timeout=5)
        self.assertFalse(self.thread.is_alive())

    def test_dynamic_ports_never_take_over_other_services(self):
        other = launcher.OfflineServer(self.root)
        try:
            self.assertNotEqual(other.server_address[1], self.server.server_address[1])
            self.assertEqual(self.server.server_address[0], "127.0.0.1")
        finally:
            other.server_close()

    def test_startup_never_uses_a_dns_resolver(self):
        with patch("socket.getfqdn", side_effect=RuntimeError("Offline DNS must not be invoked")) as resolver:
            other = launcher.OfflineServer(self.root)
            try:
                self.assertEqual(other.server_name, "127.0.0.1")
                resolver.assert_not_called()
            finally:
                other.server_close()

    def test_tampered_asset_is_not_started(self):
        (self.root / "app.js").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "校验失败"):
            launcher.load_assets(self.root)

    def test_state_authentication_and_native_shutdown(self):
        state = {"port": self.server.server_address[1], "instance": self.server.instance, "token": self.server.token}
        (self.root / "instance.json").write_text(json.dumps(state))
        self.assertEqual(launcher.existing_state(self.root), state)
        state["instance"] = "foreign-instance"
        (self.root / "instance.json").write_text(json.dumps(state))
        self.assertFalse(launcher.quit_existing(self.root))
        state["instance"] = self.server.instance
        (self.root / "instance.json").write_text(json.dumps(state))
        self.assertTrue(launcher.quit_existing(self.root))

    def test_os_lock_is_released_after_process_exit(self):
        lock = launcher.InstanceLock(self.root)
        self.assertTrue(lock.acquire())
        code = "import importlib.util,sys;from pathlib import Path;s=importlib.util.spec_from_file_location('l',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);l=m.InstanceLock(Path(sys.argv[2]));sys.exit(0 if l.acquire() else 3)"
        command = [sys.executable, "-c", code, str(Path(launcher.__file__)), str(self.root)]
        self.assertEqual(subprocess.run(command).returncode, 3)
        lock.close()
        self.assertEqual(subprocess.run(command).returncode, 0)


if __name__ == "__main__":
    unittest.main()
