"""Provenance checks work without Git in the handed-off ZIP, and fail closed."""
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("verify_local_build", ROOT / "scripts/verify-local-build.py")
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class LocalBuildTests(unittest.TestCase):
    def fixture(self, root):
        policy = {"sourceDirectories": ["app/", "shared/"], "sourceFiles": ["VERSION"], "assets": ["public/local-app.js"]}
        files = {"VERSION": b"1.8.2\n", "app/main.ts": b"export const ready = true;", "shared/local-build-policy.json": json.dumps(policy).encode(), "public/local-app.js": b"ready=true;"}
        for name, data in files.items():
            path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        hashes = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
        (root / "PACKAGE-MANIFEST.json").write_text(json.dumps({"files": hashes}))
        manifest = {"schema": 1, "version": "1.8.2", "sources": {name: digest for name, digest in hashes.items() if name not in policy["assets"]}, "assets": {name: hashes[name] for name in policy["assets"]}}
        (root / "public/local-build.json").write_text(json.dumps(manifest))

    def test_valid_extracted_package_and_stale_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); self.fixture(root)
            self.assertEqual(BUILD.verify(root)["version"], "1.8.2")
            (root / "app/main.ts").write_text("changed source")
            with self.assertRaisesRegex(ValueError, "stale"):
                BUILD.verify(root)

    def test_tampered_or_missing_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); self.fixture(root)
            (root / "public/local-app.js").write_text("stale UI")
            with self.assertRaisesRegex(ValueError, "assets changed"):
                BUILD.verify(root)
            (root / "public/local-app.js").unlink()
            with self.assertRaisesRegex(ValueError, "Missing"):
                BUILD.verify(root)
