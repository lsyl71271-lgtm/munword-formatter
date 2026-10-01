import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_SPEC = importlib.util.spec_from_file_location("export_engine_parity_fixture", ROOT / "scripts" / "export_engine_parity_fixture.py")
exporter = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(exporter)


class EngineParityFixtureTests(unittest.TestCase):
    def test_committed_fixture_matches_backend(self):
        # The browser engine is tested against this file; it must describe
        # what the backend recognizes today.
        committed = exporter.FIXTURE.read_text(encoding="utf-8")
        self.assertEqual(
            committed,
            exporter.render(exporter.build()),
            "tests/fixtures/engine-parity.json is stale: run scripts/export_engine_parity_fixture.py",
        )


if __name__ == "__main__":
    unittest.main()
