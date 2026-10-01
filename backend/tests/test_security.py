import sys
import unittest
import warnings
import zipfile
from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.main import app
from app.docx_package import validate_docx_package
from app.pipelines import PIPELINES


class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (ROOT / "examples/acceptance-inputs/03_中文工作文件.docx").read_bytes()
        cls.pipeline = PIPELINES["working-paper"](ROOT / "templates/pkunmun2026")

    def test_overrides_only_allow_typed_editable_fields(self):
        for override in ([], "text", {"max_numbering_level": 99}, {"country": []},
                         {"sponsors": "甲国"}, {"signatories": [12]}, {"language": "xx"},
                         {"topic": "x" * 5001}):
            with self.subTest(override=repr(override)[:80]), self.assertRaises(ValueError):
                self.pipeline.run(self.source, overrides=override)

    def test_api_rejects_invalid_type_without_masking_404(self):
        response = TestClient(app, base_url="http://127.0.0.1:8000").post("/api/parse/unknown", files={"file": ("test.docx", self.source)})
        self.assertEqual(response.status_code, 404)

    def test_api_rejects_non_object_override(self):
        response = TestClient(app, base_url="http://127.0.0.1:8000").post("/api/format/working-paper", files={"file": ("test.docx", self.source)}, data={"overrides_json": "[]"})
        self.assertEqual(response.status_code, 422)
        self.assertIn("JSON 对象", response.json()["detail"])

    def test_package_rejects_duplicate_parts_and_entities(self):
        for name, payload in (("word/document.xml", b"<x/>"), ("word/extra.xml", b'<!DOCTYPE x [<!ENTITY a "b">]><x/>')):
            stream = BytesIO(self.source)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(stream, "a") as target:
                    target.writestr(name, payload)
            with self.assertRaises(ValueError):
                validate_docx_package(stream.getvalue())

    def test_public_origin_is_recognized_and_filename_has_no_control_chars(self):
        response = TestClient(app, base_url="http://127.0.0.1:8000").options("/api/parse/working-paper", headers={"Origin": "https://munword.lsyl71271.chatgpt.site", "Access-Control-Request-Method": "POST"})
        self.assertEqual(response.status_code, 200)
        model = self.pipeline.parse(self.source)
        name = self.pipeline.filename(model, "S1\n", "甲\r国", "v1")
        self.assertNotIn("\n", name)
        self.assertNotIn("\r", name)
