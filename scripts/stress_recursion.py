"""Damage every correct document, format the damaged copy, score the excess error.

    excess = distance(format(damaged), correct) - distance(format(correct), correct)

so only error caused by the damage counts, not author quirks the formatter
never reproduces.  Each correct document is damaged by every operator in
stress_damage.py alone, then by all of them together with several seeds.

    MUNWORD_FIXTURE_ROOT=/path/to/测试 .venv/bin/python scripts/stress_recursion.py . out.json [--only NAME] [--detail VARIANT]
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import docx_compare as docxcmp  # noqa: E402
import stress_damage as stressgen  # noqa: E402
from reference_regression import CLEAN, F, PAIRS, weighted  # noqa: E402

GOOD = [(n, t, r) for n, t, _, r in PAIRS] + [(n, t, s) for n, t, s in CLEAN]
BLOCK_PENALTY = 100


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--only")
    ap.add_argument("--detail")
    ap.add_argument("--save", type=Path)
    args = ap.parse_args()
    sys.path.insert(0, str(args.root / "backend"))
    from app.pipelines import PIPELINES
    templates = args.root / "templates" / "pkunmun2026"

    def run(doc_type, content):
        result = PIPELINES[doc_type](templates).run(content)
        return result.content, [v.code for v in result.validations if v.status == "error"]

    rows = []
    for name, doc_type, path in GOOD:
        if args.only and args.only != name:
            continue
        good = (F / path).read_bytes()
        ref = docxcmp.load(good)
        base_out, _ = run(doc_type, good)
        base = weighted(docxcmp.compare(docxcmp.load(base_out), ref)[0])
        ops = stressgen.plan(doc_type)
        variants = [(op, [op], 1) for op in ops + stressgen.GEN2]
        variants += [(f"max#{seed}", ops, seed) for seed in (1, 2, 3)]
        variants += [("max+emphasis", ops + ["emphasis_noise"], 7)]
        variants += [(f"max2#{seed}", ops + stressgen.GEN2, seed) for seed in (1, 2)]
        for label, op_list, seed in variants:
            bad = stressgen.damage(good, op_list, seed)
            try:
                out, errors = run(doc_type, bad)
                score, rep = docxcmp.compare(docxcmp.load(out), ref)
                w = weighted(score)
            except Exception as exc:  # noqa: BLE001
                errors, score, rep, w = [f"EXC {type(exc).__name__}: {exc}"], {}, None, 9999
            excess = round(w - base + (BLOCK_PENALTY if errors else 0), 1)
            damaged = weighted(docxcmp.compare(docxcmp.load(bad), ref)[0])
            rows.append({"doc": name, "variant": label, "excess": excess, "damage": damaged, "parts": score, "errors": errors})
            if args.detail and label == args.detail and rep:
                print(f"--- {name} {label} excess {excess} errors {errors}")
                print(docxcmp.summarize(rep, limit=4))
            if args.save:
                args.save.mkdir(parents=True, exist_ok=True)
                (args.save / f"{name}-{label}-bad.docx").write_bytes(bad)
    args.out.write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    by_variant = {}
    for r in rows:
        key = r["variant"]
        if key.startswith("max#"):
            key = "max(3 seeds)"
        elif key.startswith("max2#"):
            key = "max2 (gen1+gen2)"
        by_variant.setdefault(key, []).append(r["excess"])
    print(f"{'variant':22s} {'mean':>8s} {'max':>8s}")
    for key, vals in sorted(by_variant.items(), key=lambda kv: -statistics.mean(kv[1])):
        print(f"{key:22s} {statistics.mean(vals):8.1f} {max(vals):8.1f}")
    blocked = [(r["doc"], r["variant"], r["errors"]) for r in rows if r["errors"]]
    print(f"blocked/crashed: {len(blocked)}")
    for b in blocked[:12]:
        print("   ", b)
    total = sum(r["excess"] for r in rows)
    print(f"TOTAL EXCESS {round(total, 1)} over {len(rows)} cases")


if __name__ == "__main__":
    main()
