"""Score the backend against the user's correct documents.

For each damaged/correct pair the damaged file is formatted and compared with
the correct one; correct files are formatted and compared with themselves
(they should come out unchanged).  Distances are effective-format
differences (see docx_compare.py): 0 means identical in every respect
compared.

    MUNWORD_FIXTURE_ROOT=/path/to/测试 .venv/bin/python scripts/reference_regression.py . [--detail]

The fixture folder uses the layout of scripts/verify-browser-regressions.mjs.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import docx_compare as docxcmp  # noqa: E402

F = Path(os.environ.get("MUNWORD_FIXTURE_ROOT", HERE / "fixtures"))
PAIRS = [
    ("pp", "position-paper", "pp/瑞典立场文件-坏.docx", "pp/瑞典立场文件_副本.docx"),
    ("wp", "working-paper", "wp/工作文件5.2 (1)-坏.docx", "wp/工作文件5.2.docx"),
    ("dr6", "draft-resolution", "dr/决议草案6.1-坏.docx", "dr/决议草案6.1_副本.docx"),
    ("dr5", "draft-resolution", "dr/决议草案5.1 (1)-坏.docx", "dr/决议草案5.1 (1)_副本.docx"),
    ("ua", "unfriendly-amendment", "非友好修正案/非友好修正案1.3.2-坏.docx", "非友好修正案/非友好修正案1.3.2_副本.docx"),
]
CLEAN = [
    ("wp1.6", "working-paper", "用所选项目新建的文件夹/工作文件1.6 (1).docx"),
    ("wp1.7", "working-paper", "用所选项目新建的文件夹/工作文件1.7 (1).docx"),
    ("wp1.8", "working-paper", "用所选项目新建的文件夹/工作文件1.8 (1).docx"),
    ("dr1.2", "draft-resolution", "用所选项目新建的文件夹/决议草案1.2 终.docx"),
    ("dr1.3", "draft-resolution", "用所选项目新建的文件夹/决议草案1.3终.docx"),
    ("fa1.3.3", "friendly-amendment", "用所选项目新建的文件夹/友好修正案1.3.3.docx"),
]
WEIGHTS = {"content": 50, "ws": 2, "marker_kind": 1, "para": 3, "char": 0.2, "blank": 3, "page": 10, "noise": 1}


def weighted(score):
    return round(sum(WEIGHTS[k] * v for k, v in score.items()), 1)


def run(root: Path, doc_type: str, content: bytes):
    sys.path.insert(0, str(root / "backend"))
    from app.pipelines import PIPELINES
    result = PIPELINES[doc_type](root / "templates" / "pkunmun2026").run(content)
    errors = [f"{v.code}:{v.detail[:60]}" for v in result.validations if v.status == "error"]
    return result.content, errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=Path)
    ap.add_argument("--detail", action="store_true")
    ap.add_argument("--only")
    ap.add_argument("--save", type=Path)
    ap.add_argument("--json", type=Path)
    args = ap.parse_args()
    rows = []
    total = 0
    cases = [(n, t, i, r) for n, t, i, r in PAIRS] + [(n, t, s, s) for n, t, s in CLEAN]
    for name, doc_type, inp, refp in cases:
        if args.only and args.only != name:
            continue
        ref_bytes = (F / refp).read_bytes()
        ref = docxcmp.load(ref_bytes)
        in_bytes = (F / inp).read_bytes()
        damage, _ = docxcmp.compare(docxcmp.load(in_bytes), ref)
        try:
            out_bytes, errors = run(args.root, doc_type, in_bytes)
            score, rep = docxcmp.compare(docxcmp.load(out_bytes), ref)
        except Exception as exc:  # noqa: BLE001
            out_bytes, errors, score, rep = None, [f"EXC {type(exc).__name__}: {exc}"], {k: 99 for k in WEIGHTS}, None
        w = weighted(score)
        total += w
        rows.append({"name": name, "damage": weighted(damage), "score": w, "parts": score, "errors": errors})
        print(f"{name:8s} 损坏{weighted(damage):8.1f} → 输出差异{w:8.1f}  {score}  {'校验错误:' + str(errors) if errors else ''}")
        if args.detail and rep:
            print(docxcmp.summarize(rep))
        if args.save and out_bytes:
            args.save.mkdir(parents=True, exist_ok=True)
            (args.save / f"{name}.docx").write_bytes(out_bytes)
    print(f"TOTAL {round(total, 1)}")
    if args.json:
        args.json.write_text(json.dumps(rows, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
