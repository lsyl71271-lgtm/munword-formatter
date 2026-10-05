"""Reproducible source/desktop ZIP from explicit source inventory, not a directory dump."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
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
    # Only files Git tracks are source.  An untracked file that is not ignored
    # (a private DOCX or the handbook PDF dropped into the folder) would
    # otherwise ship in the package; it is refused by name instead of being
    # skipped silently, because it may also be a new source file not yet added.
    untracked = [name for name in subprocess.check_output(["git", "ls-files", "-z", "--others", "--exclude-standard"], cwd=ROOT).decode().split("\0") if name]
    if untracked:
        raise ValueError("Untracked files are neither source nor ignored; add or remove them before packaging: " + ", ".join(sorted(untracked)[:20]))
    # An unstaged edit to a tracked file (a fixture replaced by a real document
    # for a local test) must not ship as if it were reviewed source: contents
    # come from the Git index, and a working copy that differs is refused.
    modified = [name for name in subprocess.check_output(
        ["git", "-c", "core.fileMode=false", "diff", "--name-only", "-z"], cwd=ROOT).decode().split("\0") if name]
    if modified:
        raise ValueError("Tracked files have unstaged changes; commit, stage or restore them before packaging: " + ", ".join(sorted(modified)[:20]))
    entries = subprocess.check_output(["git", "ls-files", "--stage", "-z"], cwd=ROOT).decode().split("\0")
    modes = {}
    for entry in filter(None, entries):
        metadata, _, name = entry.partition("\t")
        mode, _, stage = metadata.split()
        if stage != "0" or mode not in ("100644", "100755"):
            raise ValueError(f"Unresolved or unsupported Git entry: {name}")
        modes[name] = 0o755 if mode == "100755" else 0o644
    names = sorted(modes)
    if desktop:
        build_spec = importlib.util.spec_from_file_location("local_build", ROOT / "scripts" / "verify-local-build.py")
        build_check = importlib.util.module_from_spec(build_spec)
        build_spec.loader.exec_module(build_check)
        build_check.verify(ROOT, index=True)
        # These exact generated assets are required for offline local tools.
        names += json.loads((ROOT / "shared/local-build-policy.json").read_text())["assets"] + ["public/local-build.json"]
    files = {}
    for name in names:
        path = ROOT / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Unexpected source entry: {name}")
        # Tracked files from the index; generated desktop assets from disk.
        files[name] = subprocess.check_output(["git", "show", f":{name}"], cwd=ROOT) if name in modes else path.read_bytes()
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
                # Git modes are portable even when packaging on Windows.
                # Filename guesses lost executable bits on the macOS app entry.
                entry.create_system = 3
                entry.external_attr = modes.get(name, 0o644) << 16
                archive.writestr(entry, data)
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None:
                raise ValueError("Package CRC check failed")
            for name, digest in manifest["files"].items():
                if hashlib.sha256(archive.read("Munword/" + name)).hexdigest() != digest:
                    raise ValueError("Package readback failed")
        if output.exists():
            raise ValueError("Output already exists; choose a new filename")
        os.link(temporary, output)  # Atomic create-if-absent; never overwrite a concurrent output.
    finally:
        temporary.unlink(missing_ok=True)
    return {"version": manifest["version"], "files": len(files), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "path": str(output)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--desktop", action="store_true", help="Include the prebuilt offline browser-tools asset")
    args = parser.parse_args()
    print(json.dumps(package(args.output, args.desktop), ensure_ascii=False))
