import unittest
import sys
from pathlib import Path

from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.main import app, failure_detail


class LocalAppTests(unittest.TestCase):
    def test_empty_exception_message_is_still_readable(self):
        self.assertEqual(
            failure_detail("格式化失败", NotImplementedError()),
            "格式化失败：内部处理异常（NotImplementedError）",
        )

    def test_local_html_app_is_served_from_same_origin(self):
        client = TestClient(app)
        page = client.get("/")
        script = client.get("/app.js")
        styles = client.get("/styles.css")
        icon = client.get("/favicon.svg")

        self.assertEqual(page.status_code, 200)
        self.assertIn("本机单机版", page.text)
        self.assertIn('src="/app.js"', page.text)
        self.assertEqual(script.status_code, 200)
        self.assertIn('fetch(`${API_URL}/api/parse/', script.text)
        self.assertEqual(styles.status_code, 200)
        self.assertIn(".dropzone", styles.text)
        self.assertNotIn('@import "tailwindcss"', styles.text)
        self.assertEqual(icon.status_code, 200)
