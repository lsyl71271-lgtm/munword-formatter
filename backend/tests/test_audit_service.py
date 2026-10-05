"""Local engine service checks from the v1.7.1 audit (2026-10): request origin and error classes."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.main import app  # noqa: E402
from test_audit_regressions import ZH_DR, line, lines, package  # noqa: E402


class ServiceTests(unittest.TestCase):
    def test_too_deep_xml_is_reported_as_a_file_problem(self):
        inner = line("第一条 决定继续审议。")
        for index in range(300):
            inner = f'<w:sdt><w:sdtPr><w:id w:val="{index}"/></w:sdtPr><w:sdtContent>{inner}</w:sdtContent></w:sdt>'
        client = TestClient(app, base_url="http://127.0.0.1:8000")
        response = client.post("/api/parse/draft-resolution", files={"file": ("deep.docx", package(lines(["决议草案"]) + inner), "application/octet-stream")})
        self.assertEqual(response.status_code, 422)
        self.assertIn("嵌套层级过深", response.json()["detail"])

    def test_api_refuses_requests_from_unlisted_origins(self):
        client = TestClient(app, base_url="http://127.0.0.1:8000")
        content = package(lines(ZH_DR))
        refused = client.post("/api/parse/draft-resolution", headers={"Origin": "https://evil.example"}, files={"file": ("a.docx", content, "application/octet-stream")})
        self.assertEqual(refused.status_code, 403)
        for origin in ("http://127.0.0.1:8000", "https://munword.lsyl71271.chatgpt.site"):
            allowed = client.post("/api/parse/draft-resolution", headers={"Origin": origin}, files={"file": ("a.docx", content, "application/octet-stream")})
            self.assertEqual(allowed.status_code, 200, origin)
        self.assertEqual(client.post("/api/parse/draft-resolution", files={"file": ("a.docx", content, "application/octet-stream")}).status_code, 200)



if __name__ == "__main__":
    unittest.main()
