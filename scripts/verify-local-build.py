"""Reject stale or tampered offline assets, including in an extracted release ZIP."""
from __future__ import annotations
import hashlib
import json
import subprocess
from pathlib import Path


def verify(root: Path, index: bool = False):
    policy = json.loads((root / "shared/local-build-policy.json").read_text(encoding="utf-8"))
    manifest = json.loads((root / "public/local-build.json").read_text(encoding="utf-8"))
    if (root / "PACKAGE-MANIFEST.json").is_file() and not (root / ".git").exists():
        names = list(json.loads((root / "PACKAGE-MANIFEST.json").read_text(encoding="utf-8"))["files"])
    else:
        names = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
    names = sorted(name for name in names if name and name not in policy["assets"] and name != "public/local-build.json"
                   and (name in policy["sourceFiles"] or any(name.startswith(prefix) for prefix in policy["sourceDirectories"])))
    def hashed(name, staged=False):
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Missing or unsafe build entry: {name}")
        data = subprocess.check_output(["git", "show", ":" + name], cwd=root) if staged else path.read_bytes()
        return hashlib.sha256(data).hexdigest()
    sources = {name: hashed(name, index) for name in names}
    version = subprocess.check_output(["git", "show", ":VERSION"], cwd=root).decode().strip() if index else (root / "VERSION").read_text().strip()
    if manifest.get("schema") != 1 or manifest.get("version") != version or manifest.get("sources") != sources:
        raise ValueError("Offline UI is stale or lacks provenance. Run pnpm build:local-tools after the final source changes.")
    if manifest.get("assets") != {name: hashed(name) for name in policy["assets"]}:
        raise ValueError("Offline UI assets changed since build. Run pnpm build:local-tools again.")
    return manifest


if __name__ == "__main__":
    verify(Path(__file__).resolve().parents[1])
    print("Offline UI source and asset hashes verified.")
