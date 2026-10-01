#!/usr/bin/env python3
"""Write the backend's metadata recognition for every sample and document type.

``tests/engine-parity.test.mjs`` asserts that the browser engine recognizes the
same values, so the two engines are held to one set of expectations instead of
merely sharing ``shared/document-policy.json``.  Re-run after changing parser
behaviour; ``backend/tests/test_engine_parity_fixture.py`` fails while the
committed file is stale.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.pipelines import PIPELINES  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "engine-parity.json"
SAMPLES = ROOT / "examples" / "acceptance-inputs"
# ``title`` is deliberately absent: the backend keeps the source title
# ("工作文件 [编号]") while the browser writes the canonical one.
FIELDS = ("language", "committee", "topic", "country", "delegate", "sponsors", "signatories")


def build() -> dict:
    templates = ROOT / "templates" / "pkunmun2026"
    cases: dict[str, dict[str, dict]] = {}
    for path in sorted(SAMPLES.glob("*.docx")):
        content = path.read_bytes()
        cases[path.name] = {}
        for document_type, pipeline_class in PIPELINES.items():
            model = pipeline_class(templates).parse(content).to_dict()
            cases[path.name][document_type] = {field: model[field] for field in FIELDS}
    return {"fields": list(FIELDS), "cases": cases}


def render(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


if __name__ == "__main__":
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(render(build()), encoding="utf-8")
    print(f"wrote {FIXTURE.relative_to(ROOT)}")
