"""Reproducible source/desktop ZIP from explicit source inventory, not a directory dump."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def package(output: Path, desktop: bool = False) -> dict:
    spec = importlib.util.spec_from_file_location("source_audit", ROOT / "scripts" / "audit-source.py")
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)
    result = audit.audit(ROOT, False)
    if result["findings"]:
        raise ValueError("Source audit failed; inspect scripts/audit-source.py output before packaging")
    names = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT).decode().split("\0")
    names = sorted(set(names) - {""})
    if desktop:
        # These exact generated assets are required for offline local tools.
        names += ["public/studio-tools.js", "public/licenses/docx-preview.txt", "public/licenses/docxtemplater.txt", "public/licenses/pizzip.txt", "public/licenses/jszip.txt", "public/licenses/@xmldom-xmldom.txt", "public/licenses/fflate.txt"]
    files = {}
    for name in names:
        path = ROOT / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Unexpected source entry: {name}")
        files[name] = path.read_bytes()
    manifest = {"version": (ROOT / "VERSION").read_text().strip(), "kind": "desktop-source" if desktop else "source", "requires_python": True,
                "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}}
    files["PACKAGE-MANIFEST.json"] = json.dumps(manifest, indent=2, ensure_ascii=False).encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".zip", delete=False) as stream:
        temporary = Path(stream.name)
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in sorted(files.items()):
                entry = zipfile.ZipInfo("Munword/" + name, date_time=(2026, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.external_attr = (0o755 if name.endswith((".sh", ".command")) or name.endswith("/MacOS/launcher") else 0o644) << 16
                archive.writestr(entry, data)
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None:
                raise ValueError("Package CRC check failed")
            for name, digest in manifest["files"].items():
                if hashlib.sha256(archive.read("Munword/" + name)).hexdigest() != digest:
                    raise ValueError("Package readback failed")
        if output.exists():
            raise ValueError("Output already exists; choose a new filename")
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return {"version": manifest["version"], "files": len(files), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "path": str(output)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--desktop", action="store_true", help="Include the prebuilt offline browser-tools asset")
    args = parser.parse_args()
    print(json.dumps(package(args.output, args.desktop), ensure_ascii=False))
