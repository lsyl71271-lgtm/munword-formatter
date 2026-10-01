"""Maximum-pressure damage for correct documents.

Every operator keeps the document's words and their order; what it destroys
is formatting, structure markers and the metadata cues the formatter relies
on - the kinds of damage seen in the user's own broken files, taken further.
"""
from __future__ import annotations

import random
import re
from copy import deepcopy
from io import BytesIO

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_COLOR_INDEX
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
FONTS = ("苹方", "Comic Sans MS", "Arial", "楷体", "Courier New", "黑体")
SIZES = (5.5, 6.5, 9, 18, 26, 28)
LABEL_RE = re.compile(r"^(委员会|议题|国家/席位|国家|代表)\s*[:：]\s*")
SUBCLAUSE_RE = re.compile(r"^[（(](?:[一二三四五六七八九十]+|[子丑寅卯辰巳午未申酉戌亥]{1,3}|[甲乙丙丁戊己庚辛壬癸])[）)]")
DEEP_RE = re.compile(r"^[（(](?:[子丑寅卯辰巳午未申酉戌亥]{1,3}|[甲乙丙丁戊己庚辛壬癸])[）)]")


def _paras(doc):
    return list(doc.paragraphs)


def _num_id(p):
    ppr = p._p.pPr
    if ppr is None or ppr.numPr is None or ppr.numPr.numId is None:
        return None
    v = str(ppr.numPr.numId.val)
    return None if v == "0" else v


def _first_clause_index(doc):
    for i, p in enumerate(_paras(doc)):
        t = p.text.strip()
        if re.match(r"^(第[一二三四五六七八九十]+条|\d+[.、．])", t) or (_num_id(p) and i > 3):
            return i
        if t.endswith(("，", ",")) and len(t) < 30 and i > 2:
            return i
    return 5


# ---------------------------------------------------------------- structure
def op_strip_labels(doc, rng):
    """Remove the labels of the position-paper header (\"委员会：\" ...)."""
    for p in _paras(doc)[:8]:
        m = LABEL_RE.match(p.text.strip())
        if m and p.runs:
            _delete_prefix(p, len(p.text) - len(p.text.lstrip()) + m.end())


def op_drop_first_section(doc, rng):
    ps = _paras(doc)
    seen_two = next((i for i, p in enumerate(ps) if re.match(r"^\s*[（(]二[）)]", p.text)), None)
    if seen_two is None:
        return
    for i in range(seen_two - 1, -1, -1):
        m = re.match(r"^\s*[（(]一[）)]", ps[i].text)
        if m:
            _delete_prefix(ps[i], m.end())
            return


def op_merge_subclauses(doc, rng):
    """Flatten a deeper subclause back into the line that introduces it."""
    ps = _paras(doc)
    merged = 0
    i = 1
    while i < len(ps) and merged < 3:
        cur, prev = ps[i], ps[i - 1]
        if DEEP_RE.match(cur.text) and prev.text.rstrip().endswith("：") and not _has_complex(cur) and not _has_complex(prev):
            for r in list(cur._p.iterchildren(W + "r")):
                prev._p.append(r)
            cur._p.getparent().remove(cur._p)
            merged += 1
            ps = _paras(doc)
        i += 1


def op_backspace_number(doc, rng):
    """Remove the automatic number of a list's first item, as Backspace does."""
    ps = _paras(doc)
    done = 0
    for i in range(1, len(ps) - 1):
        p, prev, nxt = ps[i], ps[i - 1], ps[i + 1]
        nid = _num_id(p)
        if not nid or not prev.text.rstrip().endswith("：") or _num_id(nxt) != nid:
            continue
        if any(_num_id(q) == nid for q in ps[:i]):
            continue
        ind = p._p.pPr.find(W + "ind")
        source = ind if ind is not None else _level_ind(doc, nid, p._p.pPr.numPr.ilvl.val if p._p.pPr.numPr.ilvl is not None else 0)
        left = int(source.get(W + "left") or 0) if source is not None else 0
        first = int(source.get(W + "firstLine") or 0) - int(source.get(W + "hanging") or 0) if source is not None else 0
        p._p.pPr.remove(p._p.pPr.numPr)
        if ind is None:
            ind = OxmlElement("w:ind")
            p._p.pPr.append(ind)
        for a in list(ind.attrib):
            del ind.attrib[a]
        # Word keeps the text where it was: the old number's text position.
        ind.set(qn("w:left"), str(max(left + first, 0)))
        done += 1
        if done >= 2:
            return


def op_zero_indent(doc, rng):
    for p in _paras(doc):
        if SUBCLAUSE_RE.match(p.text) and not _num_id(p) and rng.random() < 0.6:
            p.paragraph_format.left_indent = Pt(0)
            p.paragraph_format.first_line_indent = Pt(0)


def op_numid0(doc, rng):
    for p in _paras(doc):
        if p.text.strip() and not _num_id(p) and rng.random() < 0.4:
            ppr = p._p.get_or_add_pPr()
            num = ppr.get_or_add_numPr()
            num.get_or_add_ilvl().val = 0
            num.get_or_add_numId().val = 0


# ---------------------------------------------------------------- paragraph
def op_extreme_indent(doc, rng):
    for p in _paras(doc):
        if p.text.strip() and rng.random() < 0.25:
            p.paragraph_format.left_indent = Pt(rng.choice((150, 220, 300, -40)))
            p.paragraph_format.first_line_indent = Pt(rng.choice((-90, 110, 0)))


def op_paragraph_noise(doc, rng):
    for p in _paras(doc):
        if not p.text.strip():
            continue
        if rng.random() < 0.5:
            p.alignment = rng.choice((WD_ALIGN_PARAGRAPH.CENTER, WD_ALIGN_PARAGRAPH.RIGHT, WD_ALIGN_PARAGRAPH.DISTRIBUTE))
        f = p.paragraph_format
        if rng.random() < 0.4:
            f.space_before = Pt(rng.choice((30, 48, 60)))
            f.space_after = Pt(rng.choice((30, 48, 60)))
        if rng.random() < 0.4:
            f.line_spacing = rng.choice((Pt(8), 3.0))
        if rng.random() < 0.15:
            f.page_break_before = True
        if rng.random() < 0.3:
            f.keep_with_next = True
        if rng.random() < 0.2:
            ppr = p._p.get_or_add_pPr()
            shd = OxmlElement("w:shd")
            shd.set(qn("w:val"), "clear")
            shd.set(qn("w:fill"), "FFFF00")
            ppr.append(shd)


def op_page(doc, rng):
    for s in doc.sections:
        s.orientation = WD_ORIENT.LANDSCAPE
        s.page_width, s.page_height = Mm(420), Mm(297)
        s.left_margin = s.right_margin = Mm(2)
        s.top_margin = s.bottom_margin = Mm(100)


def op_style_damage(doc, rng):
    normal = doc.styles["Normal"]
    normal.font.name = "Comic Sans MS"
    normal.font.size = Pt(20)
    normal.font.bold = True
    for name in ("Heading 1", "Title"):
        if name in doc.styles:
            for p in _paras(doc)[:2]:
                p.style = doc.styles[name]
            break


# ---------------------------------------------------------------- runs
def op_fragment(doc, rng):
    """Split every text run into 1-4 character fragments."""
    for p in _paras(doc):
        if _has_complex(p):
            continue
        for r in list(p._p.iterchildren(W + "r")):
            kids = [c for c in r if c.tag != W + "rPr"]
            if len(kids) != 1 or kids[0].tag != W + "t":
                continue
            text = kids[0].text or ""
            if len(text) < 3:
                continue
            pieces, i = [], 0
            while i < len(text):
                n = rng.randint(1, 4)
                pieces.append(text[i:i + n])
                i += n
            for piece in pieces:
                clone = deepcopy(r)
                t = clone.find(W + "t")
                t.text = piece
                t.set(qn("xml:space"), "preserve")
                r.addprevious(clone)
            r.getparent().remove(r)


def op_font_chaos(doc, rng):
    for p in _paras(doc):
        for r in p.runs:
            if not r.text:
                continue
            r.font.size = Pt(rng.choice(SIZES))
            f = rng.choice(FONTS)
            r.font.name = f
            rf = r._r.get_or_add_rPr().get_or_add_rFonts()
            rf.set(qn("w:eastAsia"), rng.choice(FONTS))
            r.font.color.rgb = RGBColor(rng.randint(0, 255), 0, rng.randint(0, 255))
            if rng.random() < 0.3:
                r.font.highlight_color = WD_COLOR_INDEX.YELLOW


def op_header_emphasis_flip(doc, rng):
    """Header lines lose bold and gain italic (the damage in 决议草案5.1-坏)."""
    ps = _paras(doc)
    stop = next((i for i, p in enumerate(ps) if len(p.text.strip()) > 40), len(ps))
    for p in ps[:stop]:
        for r in p.runs:
            r.bold = False
            r.italic = True


def op_emphasis_noise(doc, rng):
    for p in _paras(doc):
        for r in p.runs:
            v = rng.random()
            r.bold = v < 0.3
            r.italic = 0.2 < v < 0.55
            r.underline = v > 0.8


# ---------------------------------------------------------------- helpers
def _level_ind(doc, num_id, ilvl):
    try:
        numbering = doc.part.numbering_part.element
    except Exception:  # noqa: BLE001
        return None
    num = next((n for n in numbering.findall(W + "num") if n.get(W + "numId") == str(num_id)), None)
    if num is None:
        return None
    abstract_id = num.find(W + "abstractNumId").get(W + "val")
    abstract = next((a for a in numbering.findall(W + "abstractNum") if a.get(W + "abstractNumId") == abstract_id), None)
    lvl = next((l for l in abstract.findall(W + "lvl") if l.get(W + "ilvl") == str(ilvl)), None) if abstract is not None else None
    return lvl.find(f"{W}pPr/{W}ind") if lvl is not None else None


def _has_complex(p):
    return any(c.tag not in (W + "pPr", W + "r") for c in p._p) or any(
        k.tag not in (W + "rPr", W + "t", W + "tab", W + "br") for r in p._p.iterchildren(W + "r") for k in r
    )


def _delete_prefix(p, n):
    """Remove the first n visible characters in place."""
    for r in list(p._p.iterchildren(W + "r")):
        if n <= 0:
            return
        t = r.find(W + "t")
        if t is None or not t.text:
            continue
        take = min(n, len(t.text))
        t.text = t.text[take:]
        t.set(qn("xml:space"), "preserve")
        n -= take
        if not t.text and len([c for c in r if c.tag != W + "rPr"]) == 1:
            r.getparent().remove(r)


STRUCTURAL = {
    "position-paper": ["strip_labels", "drop_first_section"],
    "draft-resolution": ["merge_subclauses", "backspace_number"],
    "working-paper": ["backspace_number"],
}
COMMON = ["zero_indent", "numid0", "extreme_indent", "paragraph_noise", "page", "style_damage",
          "fragment", "font_chaos", "header_emphasis_flip"]
OPS = {name[3:]: fn for name, fn in globals().items() if name.startswith("op_")}


def plan(doc_type):
    return STRUCTURAL.get(doc_type, []) + COMMON


def damage(content: bytes, ops, seed: int) -> bytes:
    rng = random.Random(seed)
    doc = Document(BytesIO(content))
    for name in ops:
        OPS[name](doc, rng)
    out = BytesIO()
    doc.save(out)
    return out.getvalue()


# ---------------------------------------------------------------- generation 2
def _text_runs(p):
    return [r for r in p._p.iterchildren(W + "r") if r.find(W + "t") is not None and (r.find(W + "t").text or "").strip()]


def op_tracked_insertions(doc, rng):
    """Wrap runs in unaccepted tracked insertions (w:ins)."""
    rid = 100
    for p in _paras(doc):
        for r in _text_runs(p):
            if rng.random() < 0.25:
                ins = OxmlElement("w:ins")
                ins.set(qn("w:id"), str(rid))
                ins.set(qn("w:author"), "Reviewer")
                ins.set(qn("w:date"), "2026-01-01T00:00:00Z")
                rid += 1
                r.addprevious(ins)
                ins.append(r)


def op_numbering_in_style(doc, rng):
    """Move direct list numbering into a numbered paragraph style."""
    styles = doc.styles.element
    made = {}
    for p in _paras(doc):
        ppr = p._p.pPr
        if ppr is None or ppr.numPr is None or _num_id(p) is None:
            continue
        key = (_num_id(p), ppr.numPr.ilvl.val if ppr.numPr.ilvl is not None else 0)
        if key not in made:
            sid = f"ListStyle{len(made) + 1}"
            st = OxmlElement("w:style")
            st.set(qn("w:type"), "paragraph")
            st.set(qn("w:styleId"), sid)
            name = OxmlElement("w:name")
            name.set(qn("w:val"), f"List Style {len(made) + 1}")
            st.append(name)
            based = OxmlElement("w:basedOn")
            based.set(qn("w:val"), "a" if "a" in [s.get(qn("w:styleId")) for s in styles.findall(W + "style")] else "Normal")
            st.append(based)
            sppr = OxmlElement("w:pPr")
            sppr.append(deepcopy(ppr.numPr))
            st.append(sppr)
            styles.append(st)
            made[key] = sid
        ppr.remove(ppr.numPr)
        pstyle = ppr.find(W + "pStyle")
        if pstyle is None:
            pstyle = OxmlElement("w:pStyle")
            ppr.insert(0, pstyle)
        pstyle.set(qn("w:val"), made[key])


def op_style_emphasis(doc, rng):
    """Replace direct italic/bold with character styles."""
    styles = doc.styles.element
    for sid, tag in (("EmphasisX", "i"), ("StrongX", "b")):
        st = OxmlElement("w:style")
        st.set(qn("w:type"), "character")
        st.set(qn("w:styleId"), sid)
        name = OxmlElement("w:name")
        name.set(qn("w:val"), sid)
        st.append(name)
        rpr = OxmlElement("w:rPr")
        rpr.append(OxmlElement(f"w:{tag}"))
        st.append(rpr)
        styles.append(st)
    for p in _paras(doc):
        for r in p.runs:
            rpr = r._r.rPr
            if rpr is None:
                continue
            for tag, sid in (("i", "EmphasisX"), ("b", "StrongX")):
                node = rpr.find(W + tag)
                if node is not None and node.get(qn("w:val")) not in ("0", "false"):
                    rpr.remove(node)
                    cs = rpr.find(W + tag + "Cs")
                    if cs is not None:
                        rpr.remove(cs)
                    if rpr.find(W + "rStyle") is None:
                        rs = OxmlElement("w:rStyle")
                        rs.set(qn("w:val"), sid)
                        rpr.insert(0, rs)


def op_exotic_run_noise(doc, rng):
    """Emphasis dots, fit-text squeezing, scaling and hidden text."""
    for p in _paras(doc):
        for r in p.runs:
            if not r.text.strip():
                continue
            rpr = r._r.get_or_add_rPr()
            roll = rng.random()
            if roll < 0.2:
                em = OxmlElement("w:em")
                em.set(qn("w:val"), "dot")
                rpr.append(em)
            elif roll < 0.35:
                fit = OxmlElement("w:fitText")
                fit.set(qn("w:val"), "600")
                fit.set(qn("w:id"), str(rng.randint(1, 10**6)))
                rpr.append(fit)
            elif roll < 0.5:
                eal = OxmlElement("w:eastAsianLayout")
                eal.set(qn("w:id"), str(rng.randint(1, 10**6)))
                eal.set(qn("w:combine"), "1")
                rpr.append(eal)
            elif roll < 0.6:
                rpr.append(OxmlElement("w:vanish"))


def op_hyperlink_wrap(doc, rng):
    """Wrap the first runs of some clauses in hyperlinks."""
    part = doc.part
    for p in _paras(doc):
        runs = _text_runs(p)
        if not runs or rng.random() > 0.3 or _has_complex(p):
            continue
        rid = part.relate_to("https://example.org/x", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True)
        link = OxmlElement("w:hyperlink")
        link.set(qn("r:id"), rid)
        runs[0].addprevious(link)
        for r in runs[: rng.randint(1, min(3, len(runs)))]:
            link.append(r)


GEN2 = ["tracked_insertions", "numbering_in_style", "style_emphasis", "exotic_run_noise", "hyperlink_wrap"]
OPS.update({name[3:]: fn for name, fn in globals().items() if name.startswith("op_")})
