"""Release packaging check from the v1.7.1 audit (2026-10)."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class ReleaseTests(unittest.TestCase):
    def test_release_package_refuses_uncommitted_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            clone = Path(directory) / "clone"
            subprocess.run(["git", "clone", "-q", str(ROOT), str(clone)], check=True)
            # The packager under test, not the committed copy.
            shutil.copy(ROOT / "scripts" / "package-release.py", clone / "scripts" / "package-release.py")
            subprocess.run(["git", "-C", str(clone), "commit", "-qam", "packager under test", "--allow-empty",
                            "-c", "user.name=test", "-c", "user.email=test@example.invalid"], capture_output=True)
            (clone / "README.md").write_text((clone / "README.md").read_text(encoding="utf-8") + "\nlocal edit\n", encoding="utf-8")
            completed = subprocess.run([sys.executable, str(clone / "scripts" / "package-release.py"), "--output", str(Path(directory) / "out.zip")],
                                       capture_output=True, text=True, cwd=clone)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("README.md", completed.stderr)
            self.assertFalse((Path(directory) / "out.zip").exists())




if __name__ == "__main__":
    unittest.main()
