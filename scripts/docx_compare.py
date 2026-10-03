"""Effective-format model of a DOCX and a comparison against a reference.

Everything is resolved to what Word would display: docDefaults -> style chain
-> numbering level -> direct formatting, and automatic list markers are
rendered from numbering.xml so a literal "1." and an automatic "1." compare
equal.
"""
from __future__ import annotations

import difflib
import re
import zipfile
from dataclasses import dataclass, field
from io import BytesIO

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS = {"w": W, "a": A}
# Compared files may come from anywhere: no entities, no network (as the engines parse).
PARSER = etree.XMLParser(resolve_entities=False, no_network=True)


def q(tag):
    return f"{{{W}}}{tag}"


def wval(node, name="val"):
    if node is None:
        return None
    return node.get(q(name))


def on(node):
    if node is None:
        return None
    v = wval(node)
    return v is None or v.lower() not in ("0", "false", "off", "none")


# ---------------------------------------------------------------- numbering
CN = "〇一二三四五六七八九"


def chinese_counting(n):
    if n <= 0:
        return str(n)
    if n < 10:
        return CN[n]
    if n < 20:
        return "十" + (CN[n % 10] if n % 10 else "")
    if n < 100:
        return CN[n // 10] + "十" + (CN[n % 10] if n % 10 else "")
    return str(n)


def roman(n):
    vals = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")]
    out = ""
    for v, s in vals:
        while n >= v:
            out += s
            n -= v
    return out


def letters(n):
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(97 + r) + s
    return s


def fmt_number(n, fmt):
    if fmt in (None, "decimal"):
        return str(n)
    if fmt == "decimalZero":
        return f"{n:02d}"
    if fmt == "lowerLetter":
        return letters(n)
    if fmt == "upperLetter":
        return letters(n).upper()
    if fmt == "lowerRoman":
        return roman(n)
    if fmt == "upperRoman":
        return roman(n).upper()
    if fmt in ("chineseCounting", "chineseCountingThousand", "chineseLegalSimplified", "japaneseCounting", "ideographDigital"):
        return chinese_counting(n)
    if fmt == "ideographTraditional":
        return "甲乙丙丁戊己庚辛壬癸"[(n - 1) % 10]
    if fmt == "ideographZodiac":
        return "子丑寅卯辰巳午未申酉戌亥"[(n - 1) % 12]
    if fmt == "decimalEnclosedCircle":
        return chr(0x2460 + n - 1) if 1 <= n <= 20 else str(n)
    if fmt == "none":
        return ""
    return str(n)


class Numbering:
    def __init__(self, root):
        self.abstract = {}
        self.nums = {}
        if root is None:
            return
        for ab in root.findall(q("abstractNum")):
            self.abstract[ab.get(q("abstractNumId"))] = ab
        for num in root.findall(q("num")):
            self.nums[num.get(q("numId"))] = num
        self.counters = {}

    def level(self, num_id, ilvl):
        num = self.nums.get(num_id)
        if num is None:
            return None, None, {}
        ab_id = wval(num.find(q("abstractNumId")))
        ab = self.abstract.get(ab_id)
        overrides = {}
        for ov in num.findall(q("lvlOverride")):
            lv = ov.get(q("ilvl"))
            so = ov.find(q("startOverride"))
            overrides[lv] = (int(wval(so)) if so is not None else None, ov.find(q("lvl")))
        if ab is None:
            return None, None, overrides
        lvls = {l.get(q("ilvl")): l for l in ab.findall(q("lvl"))}
        return ab_id, lvls, overrides

    def label(self, num_id, ilvl):
        if num_id in (None, "0"):
            return ""
        ab_id, lvls, overrides = self.level(num_id, ilvl)
        if not lvls:
            return ""
        key = num_id if any(v[0] is not None for v in overrides.values()) else f"ab{ab_id}"
        counters = self.counters.setdefault(key, {})
        ilvl = int(ilvl or 0)

        def lvl_node(i):
            ov = overrides.get(str(i))
            if ov and ov[1] is not None:
                return ov[1]
            return lvls.get(str(i))

        def start_of(i):
            ov = overrides.get(str(i))
            if ov and ov[0] is not None:
                return ov[0]
            node = lvl_node(i)
            s = node.find(q("start")) if node is not None else None
            return int(wval(s)) if s is not None else 1

        counters[ilvl] = counters.get(ilvl, start_of(ilvl) - 1) + 1
        for deeper in range(ilvl + 1, 9):
            node = lvl_node(deeper)
            restart = node.find(q("lvlRestart")) if node is not None else None
            if restart is not None and wval(restart) == "0":
                continue
            counters.pop(deeper, None)
        node = lvl_node(ilvl)
        if node is None:
            return ""
        text = wval(node.find(q("lvlText"))) or ""
        fmt = wval(node.find(q("numFmt")))
        if fmt == "bullet":
            label = "•"
        else:
            def sub(m):
                i = int(m.group(1)) - 1
                n = counters.get(i, start_of(i))
                ln = lvl_node(i)
                f = wval(ln.find(q("numFmt"))) if ln is not None else None
                if node.find(q("isLgl")) is not None:
                    f = "decimal"
                return fmt_number(n, f)
            label = re.sub(r"%(\d)", sub, text)
        suff = wval(node.find(q("suff"))) or "tab"
        return label + {"tab": "\t", "space": " ", "nothing": ""}.get(suff, "\t")

    def level_ppr(self, num_id, ilvl):
        if num_id in (None, "0"):
            return None
        _, lvls, overrides = self.level(num_id, ilvl)
        ov = overrides.get(str(int(ilvl or 0)))
        node = ov[1] if ov and ov[1] is not None else (lvls or {}).get(str(int(ilvl or 0)))
        return node.find(q("pPr")) if node is not None else None

    def level_rpr(self, num_id, ilvl):
        if num_id in (None, "0"):
            return None
        _, lvls, overrides = self.level(num_id, ilvl)
        node = (lvls or {}).get(str(int(ilvl or 0)))
        return node.find(q("rPr")) if node is not None else None


# ---------------------------------------------------------------- styles
RUN_PROPS = ("sz", "b", "i", "u", "ascii", "eastAsia", "hAnsi")
PARA_PROPS = ("jc", "left", "right", "firstLine", "hanging", "before", "after", "line", "lineRule")


def apply_rpr(props, rpr, theme):
    if rpr is None:
        return
    fonts = rpr.find(q("rFonts"))
    if fonts is not None:
        for slot in ("ascii", "eastAsia", "hAnsi"):
            v = fonts.get(q(slot))
            tv = fonts.get(q(slot + "Theme")) if slot != "hAnsi" else fonts.get(q("hAnsiTheme"))
            if tv:
                props[slot] = theme.get(tv, "theme:" + tv)
            elif v:
                props[slot] = v
    sz = rpr.find(q("sz"))
    if sz is not None and wval(sz):
        props["sz"] = int(wval(sz)) / 2
    for tag in ("b", "i"):
        n = rpr.find(q(tag))
        if n is not None:
            props[tag] = bool(on(n))
    u = rpr.find(q("u"))
    if u is not None:
        props["u"] = (wval(u) or "single") != "none"


def apply_ppr(props, ppr):
    if ppr is None:
        return
    jc = ppr.find(q("jc"))
    if jc is not None:
        v = wval(jc)
        props["jc"] = {"both": "justify", "start": "left", "end": "right", "distribute": "justify"}.get(v, v)
    ind = ppr.find(q("ind"))
    if ind is not None:
        for a, b in (("left", "left"), ("start", "left"), ("right", "right"), ("end", "right")):
            if ind.get(q(a)) is not None:
                props[b] = int(float(ind.get(q(a))))
        if ind.get(q("firstLine")) is not None:
            props["firstLine"] = int(float(ind.get(q("firstLine"))))
            props["hanging"] = 0
        if ind.get(q("hanging")) is not None:
            props["hanging"] = int(float(ind.get(q("hanging"))))
            props["firstLine"] = 0
    sp = ppr.find(q("spacing"))
    if sp is not None:
        for a in ("before", "after", "line", "lineRule"):
            if sp.get(q(a)) is not None:
                v = sp.get(q(a))
                props[a] = v if a == "lineRule" else int(v)


class Styles:
    def __init__(self, root, theme):
        self.theme = theme
        self.by_id = {}
        self.default_para = None
        self.rdefault = {}
        self.pdefault = {}
        if root is None:
            return
        dd = root.find(q("docDefaults"))
        if dd is not None:
            apply_rpr(self.rdefault, dd.find(f"{q('rPrDefault')}/{q('rPr')}"), theme)
            apply_ppr(self.pdefault, dd.find(f"{q('pPrDefault')}/{q('pPr')}"))
        for st in root.findall(q("style")):
            self.by_id[st.get(q("styleId"))] = st
            if st.get(q("type")) == "paragraph" and st.get(q("default")) in ("1", "true"):
                self.default_para = st.get(q("styleId"))

    def chain(self, sid):
        out = []
        seen = set()
        while sid and sid in self.by_id and sid not in seen:
            seen.add(sid)
            st = self.by_id[sid]
            out.append(st)
            sid = wval(st.find(q("basedOn")))
        return list(reversed(out))

    def para_numpr(self, sid):
        num = None
        for st in self.chain(sid):
            np_ = st.find(f"{q('pPr')}/{q('numPr')}")
            if np_ is not None:
                num = np_
        return num


def theme_fonts(zf):
    try:
        root = etree.fromstring(zf.read("word/theme/theme1.xml"), PARSER)
    except KeyError:
        return {}
    out = {}
    for kind in ("major", "minor"):
        font = root.find(f".//a:{kind}Font", NS)
        if font is None:
            continue
        latin = font.find("a:latin", NS)
        ea = font.find("a:ea", NS)
        hans = font.find("a:font[@script='Hans']", NS)
        out[f"{kind}HAnsi"] = out[f"{kind}Ascii"] = latin.get("typeface") if latin is not None else ""
        eav = ea.get("typeface") if ea is not None else ""
        if not eav and hans is not None:
            eav = hans.get("typeface")
        out[f"{kind}EastAsia"] = eav or "theme-ea"
        out[f"{kind}Bidi"] = out[f"{kind}Ascii"]
    return out


# ---------------------------------------------------------------- model
@dataclass
class Para:
    text: str
    marker: str
    auto: bool
    props: dict
    chars: list  # per visible char (text only) -> tuple of run props
    in_table: bool = False

    @property
    def display(self):
        return self.marker + self.text


@dataclass
class DocModel:
    paras: list
    sections: list
    raw: dict = field(default_factory=dict)


def _run_text(run):
    out = []
    for ch in run:
        if ch.tag == q("t"):
            out.append(ch.text or "")
        elif ch.tag == q("tab"):
            out.append("\t")
        elif ch.tag in (q("br"), q("cr")):
            out.append("\n")
    return "".join(out)


def load(content: bytes) -> DocModel:
    zf = zipfile.ZipFile(BytesIO(content))
    doc = etree.fromstring(zf.read("word/document.xml"), PARSER)
    theme = theme_fonts(zf)
    try:
        styles = Styles(etree.fromstring(zf.read("word/styles.xml"), PARSER), theme)
    except KeyError:
        styles = Styles(None, theme)
    try:
        numbering = Numbering(etree.fromstring(zf.read("word/numbering.xml"), PARSER))
    except KeyError:
        numbering = Numbering(None)
    body = doc.find(q("body"))
    paras = []
    for p in body.iter(q("p")):
        # skip paragraphs inside text boxes
        anc = p.getparent()
        skip = False
        in_table = False
        while anc is not None and anc is not body:
            if anc.tag in (q("txbxContent"),):
                skip = True
            if anc.tag == q("tc"):
                in_table = True
            anc = anc.getparent()
        if skip:
            continue
        ppr = p.find(q("pPr"))
        sid = wval(ppr.find(q("pStyle"))) if ppr is not None else None
        sid = sid or styles.default_para
        pprops = dict(styles.pdefault)
        rbase = dict(styles.rdefault)
        for st in styles.chain(sid):
            apply_ppr(pprops, st.find(q("pPr")))
            apply_rpr(rbase, st.find(q("rPr")), theme)
        numpr = ppr.find(q("numPr")) if ppr is not None else None
        if numpr is None:
            numpr = styles.para_numpr(sid)
        num_id = ilvl = None
        if numpr is not None:
            num_id = wval(numpr.find(q("numId")))
            ilvl = wval(numpr.find(q("ilvl"))) or "0"
        marker = ""
        if num_id not in (None, "0"):
            apply_ppr(pprops, numbering.level_ppr(num_id, ilvl))
            marker = numbering.label(num_id, ilvl)
        apply_ppr(pprops, ppr)
        chars = []
        text = []
        for r in p.iter(q("r")):
            # runs of nested paragraphs (text boxes) excluded
            owner = r.getparent()
            while owner is not None and owner.tag != q("p"):
                owner = owner.getparent()
            if owner is not p:
                continue
            if r.getparent().tag == q("del"):
                continue
            t = _run_text(r)
            if not t:
                continue
            props = dict(rbase)
            rpr = r.find(q("rPr"))
            if rpr is not None:
                rs = wval(rpr.find(q("rStyle")))
                for st in styles.chain(rs):
                    apply_rpr(props, st.find(q("rPr")), theme)
                apply_rpr(props, rpr, theme)
            key = tuple(props.get(k) for k in RUN_PROPS)
            text.append(t)
            chars.extend([key] * len(t))
        paras.append(Para("".join(text), marker, bool(marker), {k: pprops.get(k) for k in PARA_PROPS}, chars, in_table))
    sections = []
    for sect in body.iter(q("sectPr")):
        pg = sect.find(q("pgSz"))
        mar = sect.find(q("pgMar"))
        sections.append({
            "w": int(pg.get(q("w"))) if pg is not None else None,
            "h": int(pg.get(q("h"))) if pg is not None else None,
            **({k: int(float(mar.get(q(k)))) for k in ("top", "bottom", "left", "right") if mar is not None and mar.get(q(k)) is not None}),
        })
    noise_tags = [q(t) for t in ("vanish", "em", "fitText", "eastAsianLayout", "strike", "dstrike", "highlight", "shd", "bdr")]
    noise = sum(1 for r in body.iter(q("r")) if r.find(q("rPr")) is not None and any(r.find(q("rPr")).find(t) is not None for t in noise_tags))
    return DocModel(paras, sections, {"noise": noise})


# ---------------------------------------------------------------- compare
def norm(s):
    return re.sub(r"\s+", "", s)


def char_font(ch, key):
    sz, b, i, u, ascii_, ea, hansi = key
    if re.match(r"[⺀-鿿　-〿＀-￯]", ch):
        return canon_font(ea)
    return canon_font(ascii_)


def compare(out: DocModel, ref: DocModel, *, detail=False):
    """Return (score, report).  score 0 = identical in every compared respect."""
    a = [p for p in out.paras if p.display.strip() and not p.in_table]
    b = [p for p in ref.paras if p.display.strip() and not p.in_table]
    sm = difflib.SequenceMatcher(a=[norm(p.display) for p in a], b=[norm(p.display) for p in b], autojunk=False)
    rep = {"content": [], "marker_kind": [], "para": {}, "char": {}, "blank_paras": None, "page": [], "ws": 0}
    pairs = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            pairs.extend(zip(a[i1:i2], b[j1:j2]))
        else:
            # try to pair replaced paragraphs 1:1 for formatting stats
            for k in range(max(i2 - i1, j2 - j1)):
                x = a[i1 + k] if i1 + k < i2 else None
                y = b[j1 + k] if j1 + k < j2 else None
                rep["content"].append((x.display if x else None, y.display if y else None))
    for x, y in pairs:
        if x.display != y.display:
            rep["ws"] += 1
        if x.auto != y.auto:
            rep["marker_kind"].append((x.display[:30], "auto" if x.auto else "literal", "auto" if y.auto else "literal"))
        for k in PARA_PROPS:
            xv, yv = x.props.get(k), y.props.get(k)
            if k == "jc":
                xv, yv = xv or "left", yv or "left"
            if k in ("left", "right", "firstLine", "hanging", "before", "after"):
                xv, yv = xv or 0, yv or 0
                if abs(xv - yv) <= 10:
                    continue
            if k == "line":
                xr, yr = x.props.get("lineRule") or "auto", y.props.get("lineRule") or "auto"
                xv, yv = xv or 240, yv or 240
                if xr == yr and abs(xv - yv) <= 5:
                    continue
            if k == "lineRule":
                xv, yv = xv or "auto", yv or "auto"
            if xv != yv:
                rep["para"].setdefault(k, []).append((y.display[:24], xv, yv))
        # char compare on text body (align by non-space chars)
        xt = [(c, key) for c, key in zip(x.text, x.chars) if not c.isspace()]
        yt = [(c, key) for c, key in zip(y.text, y.chars) if not c.isspace()]
        if [c for c, _ in xt] != [c for c, _ in yt]:
            continue  # marker/text split differs; skip char stats
        for (c, kx), (_, ky) in zip(xt, yt):
            for idx, name in ((0, "sz"), (1, "b"), (2, "i"), (3, "u")):
                vx, vy = kx[idx], ky[idx]
                if name != "sz":
                    vx, vy = bool(vx), bool(vy)
                if vx != vy:
                    rep["char"].setdefault(name, []).append((y.display[:24], c, vx, vy))
            fx, fy = char_font(c, kx), char_font(c, ky)
            if (fx or "") != (fy or ""):
                rep["char"].setdefault("font", []).append((y.display[:24], c, fx, fy))
    rep["blank_paras"] = (sum(1 for p in out.paras if not p.display.strip()), sum(1 for p in ref.paras if not p.display.strip()))
    rep["noise"] = max(0, out.raw.get("noise", 0) - ref.raw.get("noise", 0))
    for sx, sy in zip(out.sections, ref.sections):
        for k in ("w", "h", "top", "bottom", "left", "right"):
            if abs((sx.get(k) or 0) - (sy.get(k) or 0)) > 20:
                rep["page"].append((k, sx.get(k), sy.get(k)))
    if len(out.sections) != len(ref.sections):
        rep["page"].append(("sections", len(out.sections), len(ref.sections)))
    score = {
        "content": len(rep["content"]),
        "ws": rep["ws"],
        "marker_kind": len(rep["marker_kind"]),
        "para": sum(len(v) for v in rep["para"].values()),
        "char": sum(len(v) for v in rep["char"].values()),
        "blank": abs(rep["blank_paras"][0] - rep["blank_paras"][1]),
        "page": len(rep["page"]),
        "noise": rep["noise"],
    }
    return score, rep


def summarize(rep, limit=4):
    lines = []
    for x, y in rep["content"][:limit * 2]:
        lines.append(f"  内容  输出={x!r:.70}  正确={y!r:.70}")
    for item in rep["marker_kind"][:limit]:
        lines.append(f"  编号方式 {item}")
    for k, v in rep["para"].items():
        lines.append(f"  段落.{k} ×{len(v)}  例：{v[:limit]}")
    for k, v in rep["char"].items():
        # aggregate by (out,ref) value pair
        agg = {}
        for para, c, vx, vy in v:
            agg.setdefault((vx, vy), [0, para])[0] += 1
        top = sorted(agg.items(), key=lambda kv: -kv[1][0])[:limit]
        lines.append(f"  字符.{k} ×{len(v)}  " + "; ".join(f"{vx}→应为{vy}:{n}字(如「{p}」)" for (vx, vy), (n, p) in top))
    if rep["blank_paras"][0] != rep["blank_paras"][1]:
        lines.append(f"  空段落  输出{rep['blank_paras'][0]} 正确{rep['blank_paras'][1]}")
    for item in rep["page"]:
        lines.append(f"  页面 {item}")
    return "\n".join(lines)


FONT_ALIASES = {
    "宋体": "SimSun", "simsun": "SimSun", "黑体": "SimHei", "楷体": "KaiTi", "楷体_gb2312": "KaiTi",
    "仿宋": "FangSong", "仿宋_gb2312": "FangSong", "微软雅黑": "Microsoft YaHei", "等线": "DengXian",
}


def canon_font(name):
    if not name:
        return name
    return FONT_ALIASES.get(name, FONT_ALIASES.get(name.lower(), name))


def segments(p):
    """Runs of identical char props -> 'text[sz b i u font]' summary."""
    out = []
    cur = None
    buf = ""
    for c, key in zip(p.text, p.chars):
        sz, b, i, u, a, ea, h = key
        tag = f"{sz or '-'}{'B' if b else ''}{'I' if i else ''}{'U' if u else ''}/{canon_font(ea)}/{canon_font(a)}"
        if tag != cur and buf:
            out.append(f"「{buf[:14]}」{cur}")
            buf = ""
        cur = tag
        buf += c
    if buf:
        out.append(f"「{buf[:14]}」{cur}")
    return " ".join(out)


def dump(model, limit=None):
    lines = []
    for s in model.sections:
        lines.append(f"[页面] {s}")
    for idx, p in enumerate(model.paras[:limit]):
        pr = p.props
        ind = f"L{pr.get('left') or 0} F{pr.get('firstLine') or 0} H{pr.get('hanging') or 0}"
        sp = f"b{pr.get('before') or 0} a{pr.get('after') or 0} line{pr.get('line')}/{pr.get('lineRule')}"
        mk = f"<{p.marker.strip()}>" if p.marker else ""
        lines.append(f"{idx:3d} {pr.get('jc') or 'left':7s} {ind:18s} {sp:26s} {'T' if p.in_table else ''}{mk}{segments(p) or '(空)'}")
    return "\n".join(lines)
