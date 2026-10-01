"""Safe single-file/batch formatting. No step-03 overrides, no network or installs."""
from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

from app.diagnostics import build_diagnostic_report
from app.docx_package import validate_docx_package
from app.pipelines import PIPELINES

ROOT = Path(__file__).resolve().parents[1]


def write_atomic(path: Path, content: bytes) -> None:
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(content)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--type", required=True, choices=PIPELINES)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--diagnose-only", action="store_true")
    parser.add_argument("--preserve-country-order", action="store_true")
    parser.add_argument("--keep-punctuation", action="store_true")
    parser.add_argument("--overwrite", action="store_true", help="Replace previously generated outputs, never inputs")
    args = parser.parse_args(argv)
    source = args.source.resolve()
    # Word leaves "~$name.docx" owner files beside documents that are open.
    files = sorted(
        path for path in source.iterdir()
        if path.is_file() and path.suffix.lower() == ".docx" and not path.name.startswith("~$")
    ) if source.is_dir() else [source]
    if not files or any(not file.is_file() or file.suffix.lower() != ".docx" for file in files):
        parser.error("Provide a DOCX file or a directory containing DOCX files")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    destinations = {file.resolve() for file in files}
    planned: set[str] = set()  # outputs of this run, case-folded: two inputs never share one
    failures = 0
    for file in files:
        try:
            if file.stat().st_size > 20 * 1024 * 1024:
                raise ValueError("File exceeds 20 MB")
            content = file.read_bytes()
            validate_docx_package(content)
            pipeline = PIPELINES[args.type](ROOT / "templates" / "pkunmun2026")
            result = None if args.diagnose_only else pipeline.run(content, preserve_country_order=args.preserve_country_order, normalize_punctuation=not args.keep_punctuation)
            report = build_diagnostic_report(result.model if result else pipeline.parse(content), result.validations if result else None)
            report["source_name"] = file.name
            output = args.output_dir / (file.stem + "_formatted.docx")
            report_path = args.output_dir / (file.stem + "_diagnostics.json")
            targets = [report_path] + ([output] if result else [])
            if any(path.resolve() in destinations or (path.exists() and not args.overwrite) for path in targets):
                raise ValueError("Output exists or would overwrite an input; choose a new output directory")
            if any(str(path.resolve()).casefold() in planned for path in targets):
                raise ValueError("Another input in this run already writes this output name")
            planned.update(str(path.resolve()).casefold() for path in targets)
            if result and any(item.status == "error" for item in result.validations):
                write_atomic(report_path, json.dumps(report, ensure_ascii=False, indent=2).encode())
                raise ValueError("Content/format protection failed; no DOCX was written")
            write_atomic(report_path, json.dumps(report, ensure_ascii=False, indent=2).encode())
            if result:
                write_atomic(output, result.content)
            print(f"OK {file.name}")
        except Exception as error:
            failures += 1
            print(f"FAILED {file.name}: {type(error).__name__}: {error}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(run())
