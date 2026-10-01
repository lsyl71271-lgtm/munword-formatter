"""Read-only import hygiene check. Reports locations/rules, never secret values.

Run after git add with --index to check exactly the proposed Git objects.
Heuristic scanning is not a substitute for manual review or secret rotation.
"""
from __future__ import annotations

import argparse
import io
import json
import re
import subprocess
import zipfile
from pathlib import Path


RULES = {
    "github-token": re.compile(r"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})"),
    "api-key": re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}"),
    "aws-access-key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}"),
    "credential-url": re.compile(r"(?:https?|postgres(?:ql)?|mysql|redis)://[^\s/:]+:[^\s/@]+@", re.I),
    "personal-path": re.compile(r"/(?:Users|home)/[A-Za-z0-9._-]+/|[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._-]+[\\/]"),
}
LITERAL = re.compile(
    r"\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)\b"
    r"\s*[=:]\s*[\"']([^\"'\n]{8,})[\"']", re.I
)
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")
GENERATED = {"node_modules", ".venv", "venv", ".local-runtime", "__pycache__", "dist", ".next", ".vinext", ".wrangler", "_CodeSignature"}


def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(root), *args])


def scan_text(label: str, text: str) -> list[dict]:
    findings = []
    for number, line in enumerate(text.splitlines(), 1):
        for name, pattern in RULES.items():
            if pattern.search(line):
                findings.append({"file": label, "line": number, "rule": name})
        for match in LITERAL.finditer(line):
            value = match.group(1)
            if not re.search(r"example|placeholder|change.?me|your[_ -]|dummy|test|process\.env|os\.environ|\$\{|/path/to", value, re.I):
                findings.append({"file": label, "line": number, "rule": "literal-credential-review"})
        for match in EMAIL.finditer(line):
            domain = match.group(1).lower()
            if domain not in {"example.com", "example.org", "example.net", "example.invalid", "users.noreply.github.com"}:
                findings.append({"file": label, "line": number, "rule": "personal-email-review"})
    return findings


def audit(root: Path, index: bool) -> dict:
    args = ["ls-files", "-z", "--cached"]
    if not index:
        args += ["--others", "--exclude-standard"]
    names = sorted(set(git(root, *args).decode().split("\0")) - {""})
    findings = []
    xml_parts = 0
    binary_files = []
    for name in names:
        path = Path(name)
        if (GENERATED.intersection(path.parts)
                or (path.name.startswith(".env") and path.name != ".env.example")
                or (name.startswith(".openai/") and path.name != "hosting.example.json")
                or name.startswith("examples/acceptance-outputs/")
                or name.startswith(("scripts/fixtures/", "fixtures/", "outputs/", "output/", "qa/", "work/"))
                or path.suffix in {".log", ".pid", ".pem", ".key", ".p12", ".pfx", ".zip", ".tar", ".pyc"}):
            findings.append({"file": name, "rule": "excluded-file-in-import"})
        if index:
            entry = git(root, "ls-files", "--stage", "--", name).decode().split()[0]
            if entry in {"120000", "160000"}:
                findings.append({"file": name, "rule": "symlink-or-submodule-review"})
            data = git(root, "show", ":" + name)
        else:
            full = root / name
            if full.is_symlink():
                findings.append({"file": name, "rule": "symlink-review"})
                continue
            if not full.is_file():
                findings.append({"file": name, "rule": "missing-file"})
                continue
            data = full.read_bytes()
        if path.suffix == ".docx":
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    parts = archive.infolist()
                    if sum(part.file_size for part in parts) > 64 * 1024 * 1024:
                        findings.append({"file": name, "rule": "archive-review-size"})
                        continue
                    for part in parts:
                        if part.filename.endswith((".xml", ".rels")):
                            findings += scan_text(name + "!" + part.filename, archive.read(part).decode("utf-8"))
                            xml_parts += 1
                        elif not part.is_dir():
                            # Committed fixtures should contain no unexplained binary attachments.
                            binary_files.append(name + "!" + part.filename)
                    corrupt = archive.testzip()
                    if corrupt:
                        findings.append({"file": name, "rule": "archive-crc-error"})
            except (ValueError, UnicodeError, zipfile.BadZipFile):
                findings.append({"file": name, "rule": "archive-read-error"})
        else:
            try:
                findings += scan_text(name, data.decode("utf-8"))
            except UnicodeDecodeError:
                binary_files.append(name)
    return {"mode": "index" if index else "working-tree", "files": len(names), "docx_xml_parts": xml_parts,
            "binary_files_requiring_review": binary_files, "findings": findings}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", action="store_true", help="Scan staged Git objects, not working files")
    options = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    result = audit(repo, options.index)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["files"] and not result["findings"] else 1)
