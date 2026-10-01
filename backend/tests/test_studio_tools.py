import importlib.util
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.models import IntermediateDocument, Clause
from app.diagnostics import build_diagnostic_report
from cli import run

spec = importlib.util.spec_from_file_location("visual_qa", ROOT / "scripts" / "visual-qa.py")
visual = importlib.util.module_from_spec(spec)
spec.loader.exec_module(visual)


class StudioToolsTests(unittest.TestCase):
    def test_diagnostics_is_read_only_and_not_a_visual_score(self):
        model = IntermediateDocument("draft-resolution", "en", paragraphs=["", "1. Requests action"], operative_clauses=[Clause("1. Requests action", kind="operative", paragraph_index=1)])
        before = model.to_dict()
        report = build_diagnostic_report(model)
        self.assertEqual(model.to_dict(), before)
        self.assertEqual(report["visual_status"], "not_run")
        self.assertEqual(report["structure_status"], "not_run")
        self.assertEqual(report["clauses"][0]["paragraph"], 2)
        self.assertEqual(len(report["missing_fields"]), 4)

    def test_cli_formats_without_step03_and_refuses_overwrite(self):
        source = ROOT / "examples" / "acceptance-inputs" / "08_English_Draft_Resolution.docx"
        with tempfile.TemporaryDirectory() as folder:
            argv = [str(source), "--type", "draft-resolution", "--output-dir", folder]
            self.assertEqual(run(argv), 0)
            outputs = list(Path(folder).glob("*.docx"))
            self.assertEqual(len(outputs), 1)
            self.assertEqual(run(argv), 1)
            report = json.loads(next(Path(folder).glob("*.json")).read_text())
            self.assertEqual(report["structure_status"], "checked")

    def test_renderer_only_connects_to_explicit_loopback_origins(self):
        for url in ["https://example.com", "http://example.com", "http://127.0.0.1@example.invalid", "http://127.0.0.1:3000/other", "http://127.0.0.1:3000?token=value"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                visual.validate_origin(url)
        self.assertEqual(visual.validate_origin("http://127.0.0.1:3000/"), "http://127.0.0.1:3000")

    def test_renderer_rejects_linked_resources_before_any_request(self):
        source = ROOT / "examples" / "acceptance-inputs" / "08_English_Draft_Resolution.docx"
        output = io.BytesIO()
        with zipfile.ZipFile(source) as original, zipfile.ZipFile(output, "w") as modified:
            for entry in original.infolist():
                if entry.filename != "word/_rels/document.xml.rels":
                    modified.writestr(entry, original.read(entry))
            modified.writestr("word/_rels/document.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" TargetMode="External" Type="image" Target="https://example.invalid/image.png"/></Relationships>')
        with patch.object(visual, "build_opener") as opener, self.assertRaises(ValueError):
            visual.render_gotenberg(output.getvalue(), "http://127.0.0.1:3000")
        opener.assert_not_called()

    def test_gotenberg_adapter_contract_and_pdf_validation(self):
        source = (ROOT / "examples" / "acceptance-inputs" / "08_English_Draft_Resolution.docx").read_bytes()
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = b"%PDF-1.7\nmock"
        with patch.object(visual, "build_opener") as opener:
            opener.return_value.open.return_value = response
            self.assertTrue(visual.render_gotenberg(source, "http://127.0.0.1:3000").startswith(b"%PDF"))
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, "http://127.0.0.1:3000/forms/libreoffice/convert")
            self.assertIn(b'name="files"', request.data)
            response.__enter__.return_value.read.return_value = b"<html>failed</html>"
            with self.assertRaises(ValueError):
                visual.render_gotenberg(source, "http://127.0.0.1:3000")


if __name__ == "__main__":
    unittest.main()
