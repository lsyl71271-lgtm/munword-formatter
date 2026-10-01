"""House fonts and the package-level font clean-up applied after saving."""

from __future__ import annotations

import zipfile
from io import BytesIO

from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from lxml import etree


ZH_FONT = "SimSun"
LATIN_FONT = "Times New Roman"
# Office theme defaults that must not survive into a PKUNMUN document.
# "Calibri Light" is listed so the theme gets "Times New Roman", not the
# non-existent "Times New Roman Light".  Shared with the browser engine
# (docx-browser.ts normalizeFontParts).
_FORBIDDEN_FONTS = {"Calibri", "Calibri Light", "Cambria", "Aptos", "Aptos Display"}


def east_asian_font(language: str) -> str:
    return ZH_FONT if language == "zh" else LATIN_FONT


def set_house_fonts(fonts, language: str, *, complex_script: bool = False, east_asia: str | None = None) -> None:
    """Point a ``w:rFonts`` element at the house fonts for ``language``.

    ``east_asia`` overrides the Chinese face (Chinese amendments are printed
    in Arial Unicode MS).  Theme font slots are removed: they would take
    precedence over the explicit names.  Attribute order is part of the
    serialized output, so the slots are always written in the same sequence.
    """

    for slot in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
        fonts.attrib.pop(qn(f"w:{slot}"), None)
    fonts.set(qn("w:ascii"), LATIN_FONT)
    fonts.set(qn("w:hAnsi"), LATIN_FONT)
    if complex_script:
        fonts.set(qn("w:cs"), LATIN_FONT)
    fonts.set(qn("w:eastAsia"), east_asia or east_asian_font(language))
    fonts.set(qn("w:hint"), "eastAsia" if language == "zh" else "default")


# Schema order of w:rPr children (ECMA-376 CT_RPr), for inserting properties.
_RPR_ORDER = (
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow",
    "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern",
    "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs",
    "em", "lang", "eastAsianLayout", "specVanish", "oMath",
)


def rpr_child(rpr, tag: str):
    """The ``w:<tag>`` child of ``rpr``, created in its schema position."""

    found = rpr.find(qn(f"w:{tag}"))
    if found is not None:
        return found
    node = OxmlElement(f"w:{tag}")
    rank = _RPR_ORDER.index(tag)
    for position, child in enumerate(rpr):
        name = child.tag.rsplit("}", 1)[-1]
        if name in _RPR_ORDER and _RPR_ORDER.index(name) > rank:
            rpr.insert(position, node)
            return node
    rpr.append(node)
    return node


def _normalize_note_part(data: bytes, language: str, east_asia: str | None, size_pt: float) -> bytes:
    """Footnote / endnote text in the house fonts at the note size (页16, 页18)."""

    try:
        root = etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))
    except etree.XMLSyntaxError:
        return data
    half_points = str(int(round(size_pt * 2)))
    for run in root.iter(qn("w:r")):
        rpr = run.find(qn("w:rPr"))
        if rpr is None:
            rpr = OxmlElement("w:rPr")
            run.insert(0, rpr)
        set_house_fonts(rpr_child(rpr, "rFonts"), language, complex_script=True, east_asia=east_asia)
        for tag in ("sz", "szCs"):
            rpr_child(rpr, tag).set(qn("w:val"), half_points)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def normalize_font_parts(content: bytes, language: str, *, east_asia: str | None = None, note_size_pt: float | None = None) -> bytes:
    """Remove unused Office defaults and declare cross-platform Song fonts.

    With ``note_size_pt`` footnotes and endnotes are also set in the house
    fonts at that size.
    """

    source = BytesIO(content)
    target = BytesIO()
    with zipfile.ZipFile(source, "r") as input_zip, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as output_zip:
        for item in input_zip.infolist():
            data = input_zip.read(item.filename)
            if note_size_pt is not None and item.filename in ("word/footnotes.xml", "word/endnotes.xml"):
                data = _normalize_note_part(data, language, east_asia, note_size_pt)
            elif item.filename == "word/fontTable.xml":
                data = _normalize_font_table(data, language)
            elif item.filename == "word/theme/theme1.xml":
                data = _normalize_theme_fonts(data)
            elif item.filename == "word/settings.xml":
                # The math font stays: Times New Roman has no math table, so
                # replacing Cambria Math broke the rendering of equations.
                if language == "zh":
                    data = data.replace(b'w:eastAsia="ja-JP"', b'w:eastAsia="zh-CN"')
            output_zip.writestr(item, data)
    return target.getvalue()


def _normalize_theme_fonts(data: bytes) -> bytes:
    """Change font faces only, never a theme label or Cambria Math substring."""
    try:
        root = etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))
    except etree.XMLSyntaxError:
        return data
    for node in root.iter():
        if isinstance(node.tag, str) and node.tag.startswith("{http://schemas.openxmlformats.org/drawingml/2006/main}") and node.get("typeface") in _FORBIDDEN_FONTS:
            node.set("typeface", LATIN_FONT)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def _normalize_font_table(data: bytes, language: str) -> bytes:
    try:
        root = etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))
    except etree.XMLSyntaxError:
        # A damaged font table is not worth failing the run for, but anything
        # else is a real bug and must surface.
        return data
    for node in list(root.findall(qn("w:font"))):
        if node.get(qn("w:name")) in _FORBIDDEN_FONTS:
            root.remove(node)
    if language == "zh":
        font = next((node for node in root.findall(qn("w:font")) if node.get(qn("w:name")) == ZH_FONT), None)
        if font is None:
            font = OxmlElement("w:font")
            font.set(qn("w:name"), ZH_FONT)
            root.insert(0, font)
        alt = font.find(qn("w:altName"))
        if alt is None:
            alt = OxmlElement("w:altName")
            font.insert(0, alt)
        alt.set(qn("w:val"), "Songti SC")
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
