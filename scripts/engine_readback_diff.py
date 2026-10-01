"""Read back two engines' outputs for the same inputs and list every difference.

Usage:
    python scripts/engine_readback_diff.py cases.json OUT_A OUT_B [--report report.md] [--json diff.json]

``OUT_A`` / ``OUT_B`` hold ``<case id>.docx`` and ``results.json`` as written
by ``runner.py`` (Python engine) and ``xeval-browser.mjs`` (browser engine).
Compared per paragraph, in order, blank lines included:

* visible text;
* displayed list number (Word numbering rendered from numbering.xml:
  numFmt, lvlText, start, startOverride, lvlRestart);
* alignment, indentation, line pitch and rule, space before / after;
* per character: bold, italic, underline, size, East Asian and Latin font;
* page size and margins; which cases each engine blocked.

Nothing is normalized away: an empty report means the two outputs read back
the same in every compared property.
"""

from __future__ import annotations

import argparse
import json
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

from lxml import etree

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
PARSER = etree.XMLParser(resolve_entities=False, no_network=True)
ZODIAC = "子丑寅卯辰巳午未申酉戌亥"
STEMS = "甲乙丙丁戊己庚辛壬癸"
CN_DIGITS = "〇一二三四五六七八九"


def _cn(n: int) -> str:
    if n < 10:
        return CN_DIGITS[n]
    tens, ones = divmod(n, 10)
    return ("" if tens == 1 else CN_DIGITS[tens]) + "十" + (CN_DIGITS[ones] if ones else "")


def _roman(n: int) -> str:
    table = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")]
    out = ""
    for value, text in table:
        while n >= value:
            out += text
            n -= value
    return out


def _format(n: int, fmt: str) -> str:
    if fmt == "decimal":
        return str(n)
    if fmt == "lowerLetter":
        return chr(ord("a") + (n - 1) % 26) * ((n - 1) // 26 + 1)
    if fmt == "upperLetter":
        return chr(ord("A") + (n - 1) % 26) * ((n - 1) // 26 + 1)
    if fmt == "lowerRoman":
        return _roman(n)
    if fmt == "upperRoman":
        return _roman(n).upper()
    if fmt in ("chineseCounting", "chineseCountingThousand", "ideographDigital"):
        return _cn(n)
    if fmt == "ideographZodiac":
        return ZODIAC[(n - 1) % 12]
    if fmt == "ideographTraditional":
        return STEMS[(n - 1) % 10]
    if fmt == "bullet":
        return "•"
    return f"{fmt}:{n}"


class Numbering:
    """Word's list counters, enough to name the number each paragraph displays."""

    def __init__(self, archive: zipfile.ZipFile):
        self.levels: dict = {}
        self.counters: dict = defaultdict(dict)
        if "word/numbering.xml" not in archive.namelist():
            return
        root = etree.fromstring(archive.read("word/numbering.xml"), PARSER)
        abstracts = {a.get(W + "abstractNumId"): a for a in root.findall(W + "abstractNum")}
        for num in root.findall(W + "num"):
            ref = num.find(W + "abstractNumId")
            abstract = abstracts.get(ref.get(W + "val")) if ref is not None else None
            levels = {}
            for lvl in abstract.findall(W + "lvl") if abstract is not None else []:
                levels[lvl.get(W + "ilvl")] = self._level(lvl)
            for override in num.findall(W + "lvlOverride"):
                ilvl = override.get(W + "ilvl")
                level = override.find(W + "lvl")
                if level is not None:
                    levels[ilvl] = self._level(level, levels.get(ilvl))
                start = override.find(W + "startOverride")
                if start is not None and ilvl in levels:
                    levels[ilvl] = {**levels[ilvl], "start": int(start.get(W + "val"))}
            self.levels[num.get(W + "numId")] = levels

    @staticmethod
    def _level(lvl, base=None) -> dict:
        def val(tag, default=None):
            node = lvl.find(W + tag)
            return node.get(W + "val") if node is not None else default
        base = base or {}
        return {
            "fmt": val("numFmt", base.get("fmt", "decimal")),
            "text": val("lvlText", base.get("text", "%1.")),
            "start": int(val("start", base.get("start", 1))),
            "restart": val("lvlRestart", base.get("restart")),
        }

    def label(self, num_id: str, ilvl: int) -> str:
        levels = self.levels.get(num_id)
        if not levels or str(ilvl) not in levels:
            return f"?{num_id}:{ilvl}"
        counters = self.counters[num_id]
        level = levels[str(ilvl)]
        counters[ilvl] = counters.get(ilvl, level["start"] - 1) + 1
        for deeper in [key for key in counters if key > ilvl]:
            restart = levels.get(str(deeper), {}).get("restart")
            if restart != "0":
                counters.pop(deeper)
        text = level["text"]
        for depth in range(ilvl + 1):
            info = levels.get(str(depth), {"fmt": "decimal", "start": 1})
            value = counters.get(depth, info["start"])
            text = text.replace(f"%{depth + 1}", _format(value, info["fmt"]))
        return text


def _visible(p) -> str:
    out = []
    for node in p.iter(W + "t", W + "tab", W + "br"):
        anc, hidden = node.getparent(), False
        while anc is not None and anc is not p:
            if anc.tag in (W + "del", W + "moveFrom", W + "pPr", W + "rPr"):
                hidden = True
                break
            anc = anc.getparent()
        if not hidden:
            out.append(node.text or "" if node.tag == W + "t" else "\t" if node.tag == W + "tab" else "\n")
    return "".join(out)


def _attr(node, tag, name="val"):
    child = node.find(W + tag) if node is not None else None
    return child.get(W + name) if child is not None else None


def _flag(rpr, tag):
    value = _attr(rpr, tag)
    if value is None:
        return tag in ("b", "i") and rpr is not None and rpr.find(W + tag) is not None
    return value not in ("0", "false", "none")


def read(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        root = etree.fromstring(archive.read("word/document.xml"), PARSER)
        numbering = Numbering(archive)
    body = root.find(W + "body")
    rows = []
    for p in body.findall(W + "p"):
        ppr = p.find(W + "pPr")
        num = ppr.find(W + "numPr") if ppr is not None else None
        label = ""
        if num is not None and _attr(num, "numId") not in (None, "0"):
            label = numbering.label(_attr(num, "numId"), int(_attr(num, "ilvl") or 0))
        spacing = ppr.find(W + "spacing") if ppr is not None else None
        ind = ppr.find(W + "ind") if ppr is not None else None
        chars = []
        for run in p.iter(W + "r"):
            anc, hidden = run.getparent(), False
            while anc is not None and anc is not p:
                if anc.tag in (W + "del", W + "moveFrom"):
                    hidden = True
                anc = anc.getparent()
            if hidden:
                continue
            rpr = run.find(W + "rPr")
            fonts = rpr.find(W + "rFonts") if rpr is not None else None
            style = (
                _flag(rpr, "b"), _flag(rpr, "i"), (_attr(rpr, "u") or "none") != "none",
                _attr(rpr, "sz"), fonts.get(W + "eastAsia") if fonts is not None else None,
                fonts.get(W + "ascii") if fonts is not None else None,
            )
            for node in run:
                if node.tag == W + "t":
                    chars.extend((ch, style) for ch in node.text or "")
        rows.append({
            "text": _visible(p),
            "number": label,
            "jc": _attr(ppr, "jc"),
            "ind": tuple((name, ind.get(W + name)) for name in ("left", "hanging", "firstLine") if ind is not None and ind.get(W + name) not in (None, "0")),
            "spacing": tuple(spacing.get(W + name) for name in ("line", "lineRule", "before", "after")) if spacing is not None else None,
            "chars": chars,
        })
    sect = body.find(W + "sectPr")
    page = (_attr(sect, "pgSz", "w"), _attr(sect, "pgSz", "h"), tuple(_attr(sect, "pgMar", k) for k in ("top", "bottom", "left", "right")))
    return {"rows": rows, "page": page}


def compare(a: dict, b: dict) -> list[tuple[str, str]]:
    diffs = []
    if a["page"] != b["page"]:
        diffs.append(("page", f"{a['page']} ≠ {b['page']}"))
    ra, rb = a["rows"], b["rows"]
    if [r["text"] for r in ra] != [r["text"] for r in rb]:
        blank_a, blank_b = [r["text"] for r in ra if r["text"].strip()], [r["text"] for r in rb if r["text"].strip()]
        kind = "text" if blank_a != blank_b else "blank-lines"
        first = next((i for i, (x, y) in enumerate(zip(ra, rb)) if x["text"] != y["text"]), min(len(ra), len(rb)))
        detail = f"段 {first + 1}: “{ra[first]['text'][:30] if first < len(ra) else '∅'}” ≠ “{rb[first]['text'][:30] if first < len(rb) else '∅'}”"
        diffs.append((kind, detail))
        if kind == "text":
            return diffs
        ra = [r for r in ra if r["text"].strip()]
        rb = [r for r in rb if r["text"].strip()]
    for index, (x, y) in enumerate(zip(ra, rb)):
        where = f"“{x['text'][:24]}”"
        for key, name in (("number", "number"), ("jc", "alignment"), ("ind", "indent"), ("spacing", "spacing")):
            if x[key] != y[key]:
                diffs.append((name, f"{where}: {x[key]} ≠ {y[key]}"))
        if [c[1] for c in x["chars"]] != [c[1] for c in y["chars"]]:
            position = next((i for i, (p, q) in enumerate(zip(x["chars"], y["chars"])) if p[1] != q[1]), 0)
            fields = ("bold", "italic", "underline", "size", "eastAsia", "latin")
            p, q = x["chars"][position][1], y["chars"][position][1]
            changed = ", ".join(f"{f} {pa}≠{qa}" for f, pa, qa in zip(fields, p, q) if pa != qa)
            diffs.append(("run-style", f"{where} 第 {position + 1} 字“{x['chars'][position][0]}”: {changed}"))
    return diffs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("cases", type=Path)
    parser.add_argument("a", type=Path)
    parser.add_argument("b", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    res_a = json.loads((args.a / "results.json").read_text(encoding="utf-8"))
    res_b = json.loads((args.b / "results.json").read_text(encoding="utf-8"))
    per_case = {}
    categories = Counter()
    examples = defaultdict(list)
    for case in cases:
        cid = case["id"]
        a_ok = "exception" not in res_a[cid] and not res_a[cid].get("errors")
        b_ok = "exception" not in res_b[cid] and not res_b[cid].get("errors")
        if a_ok != b_ok:
            per_case[cid] = [("blocked", f"A {'ok' if a_ok else 'blocked'} / B {'ok' if b_ok else 'blocked'}")]
        elif not a_ok:
            continue
        else:
            per_case[cid] = compare(read(args.a / f"{cid}.docx"), read(args.b / f"{cid}.docx"))
        for kind, detail in per_case[cid]:
            categories[kind] += 1
            if len(examples[kind]) < 6:
                examples[kind].append(f"{cid}: {detail}")
    same = sum(1 for v in per_case.values() if not v)
    lines = [f"# 两引擎读回差异报告", "", f"用例 {len(cases)}；读回完全一致 {same}；存在差异 {len(per_case) - same}。", ""]
    for kind, count in categories.most_common():
        lines.append(f"## {kind}（{count} 处）")
        lines.extend(f"- {example}" for example in examples[kind])
        lines.append("")
    text = "\n".join(lines)
    print(text)
    if args.report:
        args.report.write_text(text, encoding="utf-8")
    if args.json:
        args.json.write_text(json.dumps({k: v for k, v in per_case.items() if v}, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
