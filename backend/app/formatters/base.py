"""Shared formatting pipeline for every document type.

A formatter run is: load → snapshot content → page → styles → document-type
specific roles → handbook layout pass → snapshot again → validate → save.
Concrete formatters only override ``_format_document`` (and, where a document
type has extra rules, the validation and size hooks).  They build on the
shared steps by calling them explicitly, never by skipping a parent class.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Callable, Iterable, Iterator

from docx import Document
from docx.document import Document as DocumentObject
from docx.enum.section import WD_ORIENT
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt
from docx.text.paragraph import Paragraph

from .. import content_guard
from ..errors import ProtectedContentError
from ..countries import COUNTRY_DATA_DATE, country_warnings, plan_countries, resolve_country
from ..docx_view import (
    all_paragraphs,
    body_paragraphs,
    default_style_id,
    invalidate as invalidate_paragraph_cache,
    structure_losses,
    structure_signature,
    style_chain,
    style_index,
    table_paragraphs,
    visible_runs,
    visible_text,
)
from ..fingerprint import canonical_body, visible_text_signature
from ..fonts import LATIN_FONT, normalize_font_parts, rpr_child, set_house_fonts
from ..models import Clause, IntermediateDocument, ValidationItem
from ..ooxml_edit import carries_semantic_marks, edit_visible_text, flattening_is_lossless, has_complex_content, style_text_range
from ..parser import MANUAL_NUMBER_RE
from ..semantic_policy import (
    ANY_LABEL_PATTERN,
    DOCUMENT_PROFILES,
    LABEL_PATTERNS,
    META_ALIASES,
    META_LABELS,
    TITLES,
    label_value,
    looks_like_title,
)
from . import handbook
from .handbook_pass import HandbookPassMixin


STYLED_STYLE_NAMES = ("Normal", "Title", "Subtitle", "Heading 1", "Heading 2", "Heading 3")
SIZE_TOLERANCE_PT = 0.05
# Geometry beyond these limits is treated as copy-paste damage and reset.
MAX_PARAGRAPH_SPACING_PT = 24
MAX_INDENT_PT = 96
MAX_FIRST_LINE_INDENT_PT = 72
VALID_MARGIN_MM = (5, 80)

SECTION_NOISE_TAGS = ("cols", "lnNumType", "pgBorders", "docGrid")
PARAGRAPH_NOISE_TAGS = ("bidi", "textDirection", "shd", "pBdr", "framePr", "contextualSpacing", "snapToGrid")
# Formatting never changes what a reader sees or what it means: hidden text
# (w:vanish, webHidden, specVanish) stays hidden, and strikethrough (a deletion
# shown in an amendment) stays struck.  Removing them printed text the author
# had hidden ("内部备注：勿公开") and erased the deletion marks.
RUN_NOISE_TAGS = (
    "outline", "shadow",
    "emboss", "imprint", "caps", "smallCaps", "position",
    "spacing", "w", "kern", "color", "highlight", "shd", "bdr",
    "effect", "glow", "reflection", "em", "fitText", "eastAsianLayout",
)
# Purely typographic distortions removed in every document type: emphasis
# dots, squeezed or combined characters, horizontal scaling, raised text.
TYPOGRAPHIC_NOISE_TAGS = ("em", "fitText", "eastAsianLayout", "w", "position")
# Copy-paste debris removed from every document type.  Superscript (citation
# markers), capitals and text colour (blue links) can be meaningful and are
# only reset where the whole body is normalized.
SAFE_RUN_NOISE_TAGS = (
    "outline", "shadow",
    "emboss", "imprint", "highlight", "shd", "bdr", "effect", "glow", "reflection",
    "spacing", "kern", "color", "rStyle", "caps", "smallCaps",
)
# Superscript / subscript (citation markers) is content and always kept.
EMPHASIS_TAGS = ("b", "bCs", "i", "iCs", "u")
_LABELED_LINE_RE = re.compile(r"^(.*?[:：])\s*(.*)$", re.S)


@dataclass(frozen=True)
class Layout:
    """Page and typography of the handbook samples."""

    page_width_mm: float = handbook.PAGE_WIDTH_MM
    page_height_mm: float = handbook.PAGE_HEIGHT_MM
    margin_top_mm: float = handbook.MARGIN_TOP_MM
    margin_bottom_mm: float = handbook.MARGIN_BOTTOM_MM
    margin_left_mm: float = handbook.MARGIN_LEFT_MM
    margin_right_mm: float = handbook.MARGIN_RIGHT_MM
    header_distance_mm: float | None = handbook.HEADER_DISTANCE_MM
    footer_distance_mm: float | None = handbook.FOOTER_DISTANCE_MM
    body_size_pt: float = handbook.BODY_SIZE_PT
    line_spacing: float | None = handbook.SINGLE
    exact_line_spacing_pt: float | None = None


# Every document type and language uses the handbook page and type.
HANDBOOK_LAYOUT = Layout()


@dataclass(frozen=True)
class ContentSnapshot:
    """What formatting must preserve, captured before and after the run."""

    canonical: str
    visible: str
    structure: dict[str, int]

    @classmethod
    def take(cls, document: DocumentObject) -> "ContentSnapshot":
        return cls(canonical_body(document), visible_text_signature(document), structure_signature(document))


def role_prefix(text: str, phrases: Iterable[str]) -> tuple[int, str]:
    """Start offset (after any visible list marker) and the verb phrase found there."""

    marker = MANUAL_NUMBER_RE.match(text)
    start = marker.end() if marker else len(text) - len(text.lstrip())
    return start, longest_prefix(text[start:], phrases)


def longest_prefix(text: str, phrases: Iterable[str], *, casefold: bool = False) -> str:
    """The longest phrase that ``text`` starts with, or ``""``."""

    candidates = sorted(phrases, key=len, reverse=True)
    if casefold:
        folded = text.casefold()
        return next((item for item in candidates if folded.startswith(item.casefold())), "")
    return next((item for item in candidates if text.startswith(item)), "")


def _within(value: float, bounds: tuple[float, float]) -> bool:
    return bounds[0] <= value <= bounds[1]


def _margins_valid(section) -> bool:
    return all(
        _within(margin.mm, VALID_MARGIN_MM)
        for margin in (section.top_margin, section.bottom_margin, section.left_margin, section.right_margin)
    )


class BaseFormatter(HandbookPassMixin):
    document_type = ""
    title_zh = ""
    title_en = ""

    def __init__(self, template_dir: Path):
        self.template_dir = template_dir
        self._active_body_size: float | None = None
        self._changed_fields: set[str] = set()
        self._normalize_punctuation_requested = False
        self._protected_warnings: list[str] = []
        self._country_changes: list[str] = []
        self._language = "zh"
        self._source_paragraphs: list[Paragraph] = []
        self._east_asia = handbook.FONTS["zh"]
        self._preserve_country_order = False
        # Every text edit: paragraph element -> (kind, detail, created).  The
        # strict content check allows a difference only where it is logged.
        self._edit_log: dict = {}

    # ------------------------------------------------------------------ run

    def format(
        self,
        content: bytes,
        model: IntermediateDocument,
        preserve_country_order: bool = False,
        normalize_punctuation: bool = True,
        changed_fields: set[str] | None = None,
    ) -> tuple[bytes, list[ValidationItem], str, str]:
        invalidate_paragraph_cache()
        document = Document(BytesIO(content))
        self._active_body_size = self._infer_body_size(document, model.language)
        self._changed_fields = changed_fields or set()
        self._normalize_punctuation_requested = normalize_punctuation
        self._preserve_country_order = preserve_country_order
        self._language = model.language
        self._edit_log = {}
        self._east_asia = handbook.east_asian_font(self.document_type, model.language)
        self._protected_warnings = []
        self._country_changes = []
        # The model's paragraph indices refer to this list.  The final pass
        # adds and removes empty paragraphs, so later lookups go through it.
        self._source_paragraphs = list(body_paragraphs(document))
        before = ContentSnapshot.take(document)
        strict_before = content_guard.Snapshot.take(document)
        self._kept_hidden = _strip_uniform_damage(document)
        # After the whole-document damage is cleared: what stays hidden or struck must stay so.
        marks_before = content_guard.semantic_marks(document)
        self._configure_page(document, model.language)
        self._configure_styles(document, model.language)
        self._format_document(
            document,
            model,
            preserve_country_order=preserve_country_order,
            normalize_punctuation=normalize_punctuation,
        )
        self._apply_handbook(document, model, normalize_punctuation)
        after = ContentSnapshot.take(document)
        self._content_problems = content_guard.verify_format(
            strict_before,
            document,
            self._edit_log,
            allowed_titles=TITLES[self.document_type],
            labels=META_ALIASES["committee"] + META_ALIASES["topic"],
        ) + content_guard.verify_marks(marks_before, document)
        validations = self._validate(document, model, before, after, preserve_country_order)
        output = BytesIO()
        document.save(output)
        content_out = normalize_font_parts(
            output.getvalue(), model.language, east_asia=self._east_asia, note_size_pt=handbook.NOTE_SIZE_PT
        )
        package_problems = content_guard.verify_package(content, content_out)
        validations.append(ValidationItem(
            "package",
            "链接目标、关系与嵌入资源逐项保留",
            "pass" if not package_problems else "error",
            "；".join(package_problems[:6]) if package_problems else "每个关系的目标、类型、模式及每个图片 / 嵌入对象的字节均与原稿一致。",
        ))
        content = content_out
        invalidate_paragraph_cache()
        self._source_paragraphs = []
        return content, validations, before.canonical, after.canonical

    def _format_document(
        self,
        document: DocumentObject,
        model: IntermediateDocument,
        preserve_country_order: bool,
        normalize_punctuation: bool,
    ) -> None:
        self._apply_common_roles(document, model, preserve_country_order)

    def _apply_common_roles(self, document: DocumentObject, model: IntermediateDocument, preserve_country_order: bool) -> None:
        """House fonts on every run, then title and metadata roles."""

        self._format_all_runs(document, model.language)
        self._format_title(document, model)
        self._format_metadata(document, model, preserve_country_order)

    # --------------------------------------------------------------- layout

    def _layout(self, language: str) -> Layout:
        return HANDBOOK_LAYOUT

    def _body_size_pt(self, language: str) -> float:
        if self._active_body_size is not None:
            return self._active_body_size
        return self._layout(language).body_size_pt

    def _infer_body_size(self, document: DocumentObject, language: str) -> float:
        return handbook.BODY_SIZE_PT

    def _line_spacing(self, language: str):
        layout = self._layout(language)
        if layout.exact_line_spacing_pt is not None:
            return Pt(layout.exact_line_spacing_pt)
        return layout.line_spacing

    def _configure_page(self, document: DocumentObject, language: str) -> None:
        """Every section on the handbook's A4 page (页15–53 all share it)."""

        layout = self._layout(language)
        for section in document.sections:
            section.orientation = WD_ORIENT.PORTRAIT
            section.page_width = Mm(layout.page_width_mm)
            section.page_height = Mm(layout.page_height_mm)
            section.top_margin = Mm(layout.margin_top_mm)
            section.bottom_margin = Mm(layout.margin_bottom_mm)
            section.left_margin = Mm(layout.margin_left_mm)
            section.right_margin = Mm(layout.margin_right_mm)
            section.gutter = Mm(0)
            # Every document type, as in the browser engine: a source document
            # grid ("lines", 312) snapped the lines of amendments and position
            # papers, which only working papers and resolutions used to clear.
            _remove_children(section._sectPr, SECTION_NOISE_TAGS)
            if layout.header_distance_mm is not None:
                section.header_distance = Mm(layout.header_distance_mm)
            if layout.footer_distance_mm is not None:
                section.footer_distance = Mm(layout.footer_distance_mm)

    def _configure_styles(self, document: DocumentObject, language: str) -> None:
        body_size = Pt(self._body_size_pt(language))
        # The source may carry Office's Calibri defaults even when every
        # visible run is reformatted.  Normalize docDefaults as well so newly
        # typed text and empty signature cells inherit the intended fonts.
        styles_root = document.styles.element
        doc_defaults = styles_root.find(qn("w:docDefaults"))
        if doc_defaults is None:
            doc_defaults = OxmlElement("w:docDefaults")
            styles_root.insert(0, doc_defaults)
        rpr_default = doc_defaults.find(qn("w:rPrDefault"))
        if rpr_default is None:
            rpr_default = OxmlElement("w:rPrDefault")
            doc_defaults.insert(0, rpr_default)
        rpr = rpr_default.find(qn("w:rPr"))
        if rpr is None:
            rpr = OxmlElement("w:rPr")
            rpr_default.append(rpr)
        fonts = rpr.find(qn("w:rFonts"))
        if fonts is None:
            fonts = OxmlElement("w:rFonts")
            rpr.insert(0, fonts)
        self._house_fonts(fonts, language, complex_script=True)

        for style_name in STYLED_STYLE_NAMES:
            if style_name not in document.styles:
                continue
            style = document.styles[style_name]
            style.font.name = LATIN_FONT
            style.font.size = body_size
            style.font.color.rgb = None
            # The complex-script slot too, as the browser engine writes it:
            # paragraph marks take their font from these styles.
            self._house_fonts(style.element.get_or_add_rPr().get_or_add_rFonts(), language, complex_script=True)
        normal = document.styles["Normal"]
        normal.font.bold = False
        normal.font.italic = False
        normal.font.underline = False
        normal_rpr = normal.element.get_or_add_rPr()
        for tag in ("bCs", "iCs"):
            rpr_child(normal_rpr, tag).set(qn("w:val"), "0")
        # Paragraph defaults: no space around paragraphs, single lines.
        # Office's own defaults (8 pt after, 1.08 lines) would reach every
        # paragraph, including the blank lines the handbook pass inserts.
        ppr_default = doc_defaults.find(qn("w:pPrDefault"))
        if ppr_default is not None:
            doc_defaults.remove(ppr_default)
        normal.paragraph_format.space_before = Pt(0)
        normal.paragraph_format.space_after = Pt(0)
        normal.paragraph_format.line_spacing = handbook.SINGLE
        # Footnotes and endnotes are set at the handbook's note size.
        for style_name in ("footnote text", "endnote text"):
            if style_name in document.styles:
                note = document.styles[style_name]
                note.font.size = Pt(handbook.NOTE_SIZE_PT)
                note.font.name = LATIN_FONT
                self._house_fonts(note.element.get_or_add_rPr().get_or_add_rFonts(), language)

    # ----------------------------------------------------------------- runs

    def _format_all_runs(self, document: DocumentObject, language: str) -> None:
        # Table cells hold body text too.  They used to keep the source's
        # Calibri / 11 pt defaults because ``document.paragraphs`` never
        # returns them, and the font check never looked at them either.
        for paragraph in all_paragraphs(document):
            for run in visible_runs(paragraph):
                _remove_safe_run_noise(run)
                # Normalize the font without erasing meaningful source
                # emphasis.  Role-specific methods below may still set an
                # explicit bold/italic/underline state.
                self._format_run(run, language, bold=None, italic=None, underline=None)

    def _format_run(self, run, language: str, *, bold=None, italic=None, underline=None) -> None:
        # Written exactly as the browser engine writes it: the complex-script
        # twins (cs font, szCs, bCs, iCs) follow the visible values, so a
        # character Word treats as complex script gets the same face and size.
        _remove_typographic_noise(run)
        rpr = run._r.get_or_add_rPr()
        self._house_fonts(rpr_child(rpr, "rFonts"), language, complex_script=True)
        half_points = str(int(round(self._body_size_pt(language) * 2)))
        for tag in ("sz", "szCs"):
            rpr_child(rpr, tag).set(qn("w:val"), half_points)
        self._set_emphasis(run, bold=bold, italic=italic, underline=underline)

    def _house_fonts(self, fonts, language: str, *, complex_script: bool = False) -> None:
        set_house_fonts(fonts, language, complex_script=complex_script, east_asia=self._east_asia)

    @staticmethod
    def _set_emphasis(run, *, bold=None, italic=None, underline=None) -> None:
        rpr = run._r.get_or_add_rPr()
        for tags, value in ((("b", "bCs"), bold), (("i", "iCs"), italic)):
            if value is not None:
                for tag in tags:
                    rpr_child(rpr, tag).set(qn("w:val"), "1" if value else "0")
        if underline is not None:
            rpr_child(rpr, "u").set(qn("w:val"), "single" if underline else "none")

    def _format_runs(self, paragraph: Paragraph, language: str, **emphasis) -> None:
        for run in visible_runs(paragraph):
            self._format_run(run, language, **emphasis)

    def _clear_formatting_noise(
        self,
        document: DocumentObject,
        language: str,
        *,
        clear_emphasis: bool = False,
    ) -> None:
        """Remove non-semantic OOXML properties used by bad copy-pastes.

        Bold, italic, underline and numbering are retained because they carry
        document-role and list semantics in the academic formats.
        """

        for section in document.sections:
            _remove_children(section._sectPr, SECTION_NOISE_TAGS)
        run_noise_tags = RUN_NOISE_TAGS + EMPHASIS_TAGS if clear_emphasis else RUN_NOISE_TAGS
        # ``paragraph.style = document.styles["Normal"]`` re-resolves the
        # default style (a full scan of styles.xml) for every paragraph.
        # Resolve the id once and assign it directly.
        normal_style_id = document.part.get_style_id(document.styles["Normal"], WD_STYLE_TYPE.PARAGRAPH)
        for paragraph in body_paragraphs(document):
            paragraph._p.style = normal_style_id
            ppr = paragraph._p.pPr
            if ppr is not None:
                _remove_children(ppr, PARAGRAPH_NOISE_TAGS)
                tabs = ppr.find(qn("w:tabs"))
                if tabs is not None:
                    ppr.remove(tabs)
            fmt = paragraph.paragraph_format
            fmt.page_break_before = False
            fmt.keep_together = False
            fmt.keep_with_next = False
            if fmt.space_before is not None and fmt.space_before.pt > MAX_PARAGRAPH_SPACING_PT:
                fmt.space_before = Pt(0)
            if fmt.space_after is not None and fmt.space_after.pt > MAX_PARAGRAPH_SPACING_PT:
                fmt.space_after = Pt(0)
            left = fmt.left_indent
            right = fmt.right_indent
            first = fmt.first_line_indent
            if left is not None and (left.pt < 0 or left.pt > MAX_INDENT_PT):
                fmt.left_indent = None
            if right is not None and abs(right.pt) > MAX_INDENT_PT:
                fmt.right_indent = Pt(0)
            if first is not None and abs(first.pt) > MAX_FIRST_LINE_INDENT_PT:
                fmt.first_line_indent = None
            for run in paragraph._p.iter(qn("w:r")):
                rpr = run.find(qn("w:rPr"))
                if rpr is not None:
                    _remove_children(rpr, run_noise_tags)

    # -------------------------------------------------------- title / header

    def _format_title(self, document: DocumentObject, model: IntermediateDocument) -> None:
        for paragraph in body_paragraphs(document):
            text = visible_text(paragraph).strip()
            if not text:
                continue
            if text == model.title or self._title_matches(text):
                paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
                paragraph.paragraph_format.first_line_indent = None
                paragraph.paragraph_format.keep_with_next = True
                for run in visible_runs(paragraph):
                    self._format_run(run, model.language, bold=True, italic=False, underline=False)
                    run.font.size = Pt(self._body_size_pt(model.language))
                return

    def _title_matches(self, text: str) -> bool:
        return looks_like_title(text, self.document_type)

    def _format_metadata(self, document: DocumentObject, model: IntermediateDocument, preserve_country_order: bool) -> None:
        data = {
            "committee": model.committee,
            "topic": model.topic,
            "country": resolve_country(model.country, model.language)["display"],
            "delegate": model.delegate,
            "sponsors": self._country_order(model.sponsors, model.language),
            "signatories": self._country_order(model.signatories, model.language),
        }
        paragraphs = body_paragraphs(document)
        self._apply_unlabeled_overrides(paragraphs, model, data)
        self._restore_missing_header_labels(paragraphs, model, data)
        # Step 03 is surgical: only an actually changed field is rewritten.
        # With no overrides, text, paragraph boundaries and country order are
        # retained exactly and only role styling is applied.
        # Only the header lines the parser recognized: a body paragraph that
        # starts like "议题：" is the author's text, never rewritten as a field.
        recognized = set(model.header_paragraph_indices.values()) | {
            indices[0] for indices in model.metadata_paragraph_indices.values() if indices
        }
        header_end = max(recognized, default=-1) + 1
        repeated = {key for key in ("country", "sponsors", "signatories")
                    if sum(label_value(visible_text(item).strip())[0] == key for item in paragraphs[:header_end]) > 1}
        for index, paragraph in enumerate(paragraphs):
            if index not in recognized:
                continue
            text = visible_text(paragraph).strip()
            key = next((key for key, pattern in LABEL_PATTERNS.items() if pattern.match(text)), None)
            if key is None:
                continue
            if key in repeated:
                if key in self._changed_fields:
                    raise ProtectedContentError(index + 1, "页首存在多个同名国家字段，不能确定第 03 步修改的目标，请先在原稿中确认")
                self._protect(paragraph, "页首存在多个同名国家字段，未自动展开或合并，请人工确认")
                continue
            if key in ("sponsors", "signatories"):
                continuations = [
                    paragraphs[position]
                    for position in model.metadata_paragraph_indices.get(key, [index])[1:]
                    if position < len(paragraphs)
                ]
                self._format_country_field(paragraph, continuations, key, data[key], model.language, getattr(model, key))
            elif key == "country" and (data[key] != model.country or key in self._changed_fields):
                if self._write_label_value(paragraph, key, str(data[key]), model.language):
                    self._log_edit(paragraph, "field" if key in self._changed_fields else "country-name", key, expected=self._label_value_text(key, str(data[key]), model.language))
                    self._record_country_names(paragraph, key, [model.country], model.language)
            elif key in self._changed_fields:
                if self._write_label_value(paragraph, key, str(data[key]), model.language):
                    self._log_edit(paragraph, "field", key, expected=self._label_value_text(key, str(data[key]), model.language))
            # Emphasis of the header lines is set by the handbook pass.

    def _apply_unlabeled_overrides(self, paragraphs: list[Paragraph], model: IntermediateDocument, data: dict) -> None:
        """A value confirmed in step 03 for a header line printed without a label."""

        for key in ("committee", "topic", "country", "delegate"):
            index = model.header_paragraph_indices.get(key)
            automatic = key == "country" and data[key] != model.country
            if (key not in self._changed_fields and not automatic) or index is None or index >= len(paragraphs):
                continue
            paragraph = paragraphs[index]
            if label_value(visible_text(paragraph).strip())[0]:
                continue  # labeled lines are rewritten with their label below
            value = str(data[key])
            if has_complex_content(paragraph) or carries_semantic_marks(paragraph) or any(token[0] != "t" for token in content_guard.signature(paragraph._p)):
                if key in self._changed_fields:
                    raise ProtectedContentError(index + 1, f"第 03 步修改了{META_LABELS[model.language][key]}，但该段含图片、域或修订痕迹，不能安全改写")
                self._protect(paragraph, "国家字段含链接、域、修订、书签或隐藏/删除线文字，未自动展开全称")
                continue
            if self._set_text(paragraph, value, model.language):
                self._log_edit(paragraph, "field" if key in self._changed_fields else "country-name", key, expected=value)
                if key == "country":
                    self._record_country_names(paragraph, key, [model.country], model.language)

    def _restore_missing_header_labels(self, paragraphs: list[Paragraph], model: IntermediateDocument, data: dict) -> None:
        # Header repair is schema-driven: if a recognized document type uses
        # positional header fields, restore only the missing label for the
        # already-recognized value. This is not tied to a filename or fixture.
        profile = DOCUMENT_PROFILES[model.document_type]
        if not profile.get("restoreMissingHeaderLabels"):
            return
        for key in profile.get("unlabeledHeaderFields", []):
            index = model.header_paragraph_indices.get(key)
            value = data.get(key)
            if index is None or index >= len(paragraphs) or not isinstance(value, str) or not value:
                continue
            paragraph = paragraphs[index]
            if label_value(visible_text(paragraph).strip())[0]:
                continue
            current = re.sub(r"^\s*[:：]\s*", "", visible_text(paragraph)).strip()
            if current == value and self._write_label_value(paragraph, key, value, model.language):
                self._log_edit(paragraph, "label-restore", key, expected=self._label_value_text(key, value, model.language))

    def _format_country_field(
        self,
        paragraph: Paragraph,
        continuations: list[Paragraph],
        key: str,
        values: list[str],
        language: str,
        source_values: list[str] | None = None,
    ) -> None:
        reordered = source_values is not None and list(values) != list(source_values)
        if key in self._changed_fields or self._country_line_differs(paragraph, continuations, key, values, language, reordered):
            # The list is rewritten as one line, so every paragraph it spans
            # must be plain text.  Rewriting the first line while a complex
            # continuation stayed would duplicate names; clearing plain
            # continuations after a refused rewrite would delete them.
            complex_part = next((item for item in [paragraph, *continuations] if has_complex_content(item) or carries_semantic_marks(item) or any(token[0] != "t" for token in content_guard.signature(item._p))), None)
            if complex_part is None:
                self._write_country_line(paragraph, key, list(values), language)
                expected = self._country_line_text(key, list(values), language)
                self._log_edit(paragraph, "countries", key, expected=expected)
                for continuation in continuations:
                    continuation.clear()
                    self._log_edit(continuation, "countries", key, expected=expected)
                self._record_country_names(paragraph, key, source_values or [], language)
                return
            if key in self._changed_fields:
                raise ProtectedContentError(
                    self._source_number(complex_part), "第 03 步修改了国家名单，但名单含图片、域、修订痕迹或隐藏/删除线文字，不能安全改写"
                )
            self._protect(complex_part, "国家列表含图片、域、修订痕迹或隐藏/删除线文字，未重写")
        self._style_labeled_paragraph(paragraph, key, language, value_emphasis=True)
        for continuation in continuations:
            self._format_runs(continuation, language, bold=True, italic=True, underline=False)

    def _country_order(self, values: list[str], language: str) -> list[str]:
        """Pinyin / alphabetical order (页41, 页53) unless the user keeps the source order."""

        return plan_countries(values, language, self._preserve_country_order)["values"]

    def _record_country_names(self, paragraph, key, values, language):
        plan = plan_countries(values, language, True)
        for item in plan["resolutions"]:
            if item["changed"]:
                self._country_changes.append(f"第 {self._source_number(paragraph)} 段 {key}：国家名称“{item['input']}” → “{item['display']}”（{item['id']}；UNTERM 核对 {COUNTRY_DATA_DATE}）。")
        if plan["removedDuplicates"]:
            self._country_changes.append(f"第 {self._source_number(paragraph)} 段 {key}：按国家标识去重 {plan['removedDuplicates']} 项（不合并未知或歧义名称）。")

    def _country_line_differs(
        self, paragraph, continuations, key: str, values: list[str], language: str, reordered: bool = False
    ) -> bool:
        """True when the list should be rewritten as one inline line.

        The handbook lists countries inline after the label, separated by
        "、" (Chinese) or ", " (English), in pinyin / alphabetical order.
        Other separators, a label alias or a list continued over several
        paragraphs is rewritten when punctuation normalization is on; a list
        out of order is rewritten unless the source order is kept.
        """

        if not values or not (self._normalize_punctuation_requested or reordered):
            return False
        if reordered:
            return True
        if any(visible_text(item).strip() for item in continuations):
            return True
        expected = self._country_line_text(key, values, language)
        return visible_text(paragraph).strip() != expected.strip()

    @staticmethod
    def _country_line_text(key: str, values: list[str], language: str) -> str:
        label = META_LABELS[language][key]
        prefix = f"{label}: " if language == "en" else f"{label}："
        return prefix + handbook.COUNTRY_SEPARATOR[language].join(values)

    def _style_labeled_paragraph(
        self, paragraph: Paragraph, key: str, language: str, value_emphasis: bool, value_bold: bool = False
    ) -> None:
        text = visible_text(paragraph)
        match = _LABELED_LINE_RE.match(text)
        if not match:
            self._format_runs(paragraph, language, bold=True, italic=value_emphasis, underline=False)
            return
        label_text, value_text = match.groups()
        value_start = text.find(value_text, len(label_text)) if value_text else len(text)
        # The label run includes the space after the colon (as in the browser engine).
        label_ok = style_text_range(paragraph, 0, value_start, bold=True, italic=False, underline=False)
        value_ok = not value_text or style_text_range(
            paragraph,
            value_start,
            value_start + len(value_text),
            bold=value_emphasis or value_bold,
            italic=value_emphasis,
            underline=False,
        )
        if not (label_ok and value_ok):
            # Complex fields or drawings are preserved rather than rebuilt.
            self._format_runs(paragraph, language, bold=None, italic=None, underline=None)

    @staticmethod
    def _label_value_text(key: str, value: str, language: str) -> str:
        label = META_LABELS[language][key]
        return f"{label}: {value}" if language == "en" else f"{label}：{value}"

    def _add_label_run(self, paragraph: Paragraph, key: str, language: str) -> None:
        label = META_LABELS[language][key]
        label_run = paragraph.add_run(f"{label}: " if language == "en" else f"{label}：")
        self._format_run(label_run, language, bold=True)

    def _write_label_value(self, paragraph: Paragraph, key: str, value: str, language: str) -> bool:
        if has_complex_content(paragraph) or carries_semantic_marks(paragraph) or any(token[0] != "t" for token in content_guard.signature(paragraph._p)):
            reason = "元数据段含链接、图片、域、修订或隐藏/删除线文字，不能安全改写"
            if key in self._changed_fields:
                raise ProtectedContentError(self._source_number(paragraph), f"第 03 步修改了{META_LABELS[language][key]}，但{reason}")
            self._protect(paragraph, reason)
            return False
        paragraph.clear()
        run = paragraph.add_run(self._label_value_text(key, value, language))
        self._format_run(run, language, bold=False, italic=False, underline=False)
        return True

    def _write_country_line(self, paragraph: Paragraph, key: str, values: list[str], language: str) -> None:
        if has_complex_content(paragraph) or carries_semantic_marks(paragraph):
            self._protect(paragraph, "国家列表段含图片、域或隐藏/删除线文字，未重写")
            return
        paragraph.clear()
        self._add_label_run(paragraph, key, language)
        # One run for the whole list, as the browser engine writes it.
        countries = paragraph.add_run(handbook.COUNTRY_SEPARATOR[language].join(values))
        self._format_run(countries, language, bold=True, italic=True, underline=False)

    # ------------------------------------------------------ content editing

    def _paragraph_at(self, document: DocumentObject, index: int) -> Paragraph | None:
        """The paragraph the model's ``index`` refers to, if still in the body."""

        paragraphs = self._source_paragraphs or body_paragraphs(document)
        if not 0 <= index < len(paragraphs):
            return None
        paragraph = paragraphs[index]
        return paragraph if paragraph._p.getparent() is not None else None

    def _clause_paragraphs(self, document: DocumentObject, clauses: Iterable[Clause]) -> Iterator[tuple[Clause, Paragraph]]:
        """Pair each clause with its paragraph, skipping stale indices."""

        for clause in clauses:
            paragraph = self._paragraph_at(document, clause.paragraph_index)
            if paragraph is not None:
                yield clause, paragraph

    def _set_text(self, paragraph: Paragraph, text: str, language: str) -> bool:
        """Rewrite a paragraph's text without destroying what it contains.

        The old implementation always used ``clear()`` + ``add_run()``.  For a
        clause that held an inline image, a hyperlink, a footnote marker or the
        author's own emphasis, normalizing the trailing punctuation therefore
        deleted that content — and because the fingerprints only compare plain
        text, every validation still reported ``pass``.
        """

        if visible_text(paragraph) == text:
            return True
        if flattening_is_lossless(paragraph):
            paragraph.clear()
            run = paragraph.add_run(text)
            self._format_run(run, language, bold=False, italic=False, underline=False)
            return True
        if edit_visible_text(paragraph, text):
            return True
        self._protect(paragraph, "该段包含图片、域或复杂结构，已保留原样未改写")
        return False

    def _log_edit(self, paragraph: Paragraph, kind: str, key: str = "", *, expected: str | None = None, new: bool = False) -> None:
        self._log_edit_element(paragraph._p, kind, key, expected=expected, new=new)

    def _log_edit_element(self, element, kind: str, key: str = "", *, expected: str | None = None, new: bool = False) -> None:
        previous = self._edit_log.get(element)
        if kind == "label-restore" and previous and previous.kind == "country-name":
            kind = "country-name"
        # A paragraph created by the pass stays "created" whatever is done to it later.
        country = {"language": self._language, "preserveOrder": self._preserve_country_order, "manual": key in self._changed_fields} if kind in ("countries", "country-name") else None
        self._edit_log[element] = content_guard.Edit(kind, key, expected, new or bool(previous and previous.created), country)

    def _rewrite_logged(self, paragraph: Paragraph, text: str, language: str, kind: str, key: str = "") -> bool:
        """``_set_text`` for an allowed edit, recorded for the strict content check.

        Label and field edits record their exact result, which the check
        compares against; the other kinds are checked by their own rule.
        """

        if visible_text(paragraph) == text:
            return True
        previous = self._edit_log.get(paragraph._p)
        # An edit may change text only.  If rewriting would drop or reshape a
        # hyperlink, field, bookmark or revision (a label inside a link, a
        # title inside a field), the paragraph is restored and left as is.
        backup = copy.deepcopy(paragraph._p)
        old_signature = content_guard.signature(paragraph._p)
        old_marks = content_guard.paragraph_marks(paragraph._p)

        def restore(reason: str) -> bool:
            # Restore in place: the element keeps its identity for the check.
            for child in list(paragraph._p):
                paragraph._p.remove(child)
            for child in list(backup):
                paragraph._p.append(child)
            self._protect(paragraph, reason)
            return False

        written = self._set_text(paragraph, text, language)
        if written and not content_guard.rewrite_keeps_structure(kind, old_signature, content_guard.signature(paragraph._p)):
            return restore("改写会改变该段中的链接、域、书签或修订结构，已保留原样")
        if written and not content_guard.marks_kept(old_marks, paragraph._p):
            # Any automatic rewrite (title word, label, marker, ending) that
            # would delete hidden or struck characters, or drop their mark,
            # is undone here, for this paragraph only; the final guard stays strict.
            return restore("改写会删除隐藏或删除线文字或去掉其标记，已保留原样")
        if visible_text(paragraph) == text:
            expected = text if kind in ("label-restore", "field") else None
            if previous is not None and previous.kind == "field" and kind in ("label-drop", "title"):
                # A handbook rule applied on top of a step-03 value: the
                # authorized result is still exact, now without the label /
                # with the handbook title word.
                kind, key, expected = "field", previous.key, text
            self._log_edit(paragraph, kind, key, expected=expected)
            return True
        return False

    def _protect(self, paragraph: Paragraph, reason: str) -> None:
        """Record a place where content protection stopped a rewrite."""

        # Numbered like every other report: the paragraph's place in the source.
        self._protected_warnings.append(f"第 {self._source_number(paragraph) or '?'} 段：{reason}。")

    # ----------------------------------------------------------- validation

    def _validate(
        self,
        document: DocumentObject,
        model: IntermediateDocument,
        before: ContentSnapshot,
        after: ContentSnapshot,
        preserve_country_order: bool,
    ) -> list[ValidationItem]:
        section = document.sections[0]
        page_ok = section.page_height.mm >= section.page_width.mm and _margins_valid(section)
        size = self._body_size_pt(model.language)
        page_label = "Letter" if abs(section.page_width.mm - 215.9) < 0.3 else "A4" if abs(section.page_width.mm - 210) < 0.3 else "原稿"
        font_errors = self._font_errors(document, model) + self._table_font_errors(document, model)
        problems = getattr(self, "_content_problems", [])
        losses = structure_losses(before.structure, after.structure)
        items = [
            ValidationItem("page", f"保留有效的 {page_label} 纵向页面", "pass" if page_ok else "error"),
            ValidationItem("font", f"中文宋体 / 拉丁字符 Times New Roman，{size:g} pt", "pass" if not font_errors else "error", "；".join(font_errors[:6])),
            # Strict per-paragraph check: text, fields, links, bookmarks,
            # footnote references and revisions; only logged, whitelisted
            # edits (clause endings, title word, header labels, country order
            # and signing lines) may differ.
            ValidationItem(
                "content",
                "逐段严格内容校验（文字、域、链接、书签、脚注、修订、隐藏与删除线）",
                "pass" if not problems else "error",
                "；".join(problems[:6]) if problems else "只允许句末标点、标题用词、页首标签和国家名单顺序/断行等记录在案的修改。",
            ),
            # Text-only fingerprints cannot see an image, a hyperlink, a
            # footnote or a section break disappearing.  This item does.
            ValidationItem(
                "structure",
                "图片、超链接、脚注、域、书签、表格与分节符完整保留",
                "pass" if not losses else "error",
                "；".join(losses[:6]),
            ),
        ]
        edits = edit_summary(self._edit_log)
        items.insert(1, ValidationItem("structural_edits", "结构与人工修改记录", "warning" if edits else "pass", "；".join(edits) or "未改写正文文字。"))
        for warning in self._protected_warnings:
            items.append(ValidationItem("content-protected", "为保护原有内容，部分段落未自动改写", "warning", warning))
        for detail in dict.fromkeys(self._country_changes):
            items.append(ValidationItem("country_names", "国家全称展开与身份去重记录", "pass", detail))
        for note in getattr(self, "_kept_hidden", []):
            items.append(ValidationItem("hidden-text", "隐藏文字与删除线按原稿保留", "warning", note))
        if model.sponsors:
            ok = self._metadata_value_emphasis_ok(document, "sponsors")
            items.append(ValidationItem("sponsors", "起草国顺序保留、值为粗斜体", "pass" if ok else "error"))
        if model.signatories:
            ok = self._metadata_value_emphasis_ok(document, "signatories")
            items.append(ValidationItem("signatories", "附议国顺序保留、值为粗斜体", "pass" if ok else "error"))
        for warning in country_warnings([model.country, *model.sponsors, *model.signatories], model.language):
            items.append(ValidationItem("country-formal-name", "国家正式名称待确认", "warning", warning))
        for warning in model.warnings:
            items.append(ValidationItem("parser", "结构识别待确认", "warning", warning))
        return items

    def _expected_run_size(self, document: DocumentObject, model: IntermediateDocument) -> Callable[[int], float]:
        """Map a body paragraph index to the point size its text must have."""

        size = self._body_size_pt(model.language)
        return lambda index: size

    def _font_errors(self, document: DocumentObject, model: IntermediateDocument) -> list[str]:
        expected_for = self._expected_run_size(document, model)
        errors: list[str] = []
        for index, paragraph in enumerate(body_paragraphs(document)):
            size = _first_wrong_size(paragraph, expected_for(index))
            if size is not False:
                errors.append(f"第 {index + 1} 段字号 {size if size is not None else '继承'}")
        return errors

    def _table_font_errors(self, document: DocumentObject, model: IntermediateDocument) -> list[str]:
        """Font check for table cells, which the paragraph-indexed check skips."""

        expected = self._body_size_pt(model.language)
        errors: list[str] = []
        for number, paragraph in enumerate(table_paragraphs(document), start=1):
            size = _first_wrong_size(paragraph, expected)
            if size is not False:
                errors.append(f"表格第 {number} 段字号 {size if size is not None else '继承'}")
            if len(errors) >= 6:
                break
        return errors

    def _metadata_value_emphasis_ok(self, document: DocumentObject, key: str) -> bool:
        for paragraph in body_paragraphs(document):
            full = visible_text(paragraph)
            text = full.strip()
            if not LABEL_PATTERNS[key].match(text):
                continue
            colon = max(text.find("："), text.find(":"))
            value_offset = len(full) - len(full.lstrip()) + colon + 1
            cursor = 0
            found = False
            for run in visible_runs(paragraph):
                start, end = cursor, cursor + len(run.text)
                cursor = end
                # Only the part of a run after the label counts ("Sponsors: "
                # carries the label's trailing space).
                if end <= value_offset or not run.text[max(0, value_offset - start):].strip():
                    continue
                found = True
                if run.bold is not True or run.italic is not True:
                    return False
            return found
        return False


_EDIT_NOTES = {
    "title": "按学标统一标题用词", "label-drop": "按范例删除委员会/议题标签", "label-restore": "补齐页首标签",
    "countries": "国家名单按顺序排列并按国名断行留签字空行", "ending": "按学标统一条款末尾标点", "marker": "统一立场文件建议编号写法",
    "blank": "按范例调整空行", "empty-line": "按范例调整空行",
    "country-name": "按共用 UNTERM 名称表展开明确国家字段的全称",
}


def edit_summary(edit_log: dict) -> list[str]:
    """User-facing record of every logged edit (same wording as the browser engine)."""

    notes: list[str] = []
    fields: list[str] = []
    for edit in edit_log.values():
        if edit.kind == "field":
            if edit.key not in fields:
                fields.append(edit.key)
        elif edit.kind in _EDIT_NOTES and _EDIT_NOTES[edit.kind] not in notes:
            notes.append(_EDIT_NOTES[edit.kind])
    if fields:
        names = "、".join("标题" if key == "title" else META_LABELS["zh"].get(key, key) for key in fields)
        notes.insert(0, f"应用第 03 步人工确认的修改（{names}）")
    return notes


def _first_wrong_size(paragraph: Paragraph, expected: float):
    """Size of the first visible run off ``expected`` (``None`` = inherited), else ``False``."""

    for run in visible_runs(paragraph):
        if not run.text.strip():
            continue
        size = run.font.size.pt if run.font.size is not None else None
        if size is None or abs(size - expected) > SIZE_TOLERANCE_PT:
            return size
    return False


# Hiding or striking through every character cannot be what the author meant;
# hiding or striking some of them can (a private note, a deletion shown in an
# amendment).  Only a property that covers the whole text is damage.
_UNIFORM_DAMAGE = ("vanish", "webHidden", "specVanish", "strike", "dstrike")


def _on(rpr, tag: str) -> bool:
    node = rpr.find(qn(f"w:{tag}")) if rpr is not None else None
    return node is not None and node.get(qn("w:val")) not in ("0", "false", "off")


def _styles_applied_to_body(document: DocumentObject) -> list:
    """Document defaults and every style the body text can take, with the styles they are based on."""

    styles = style_index(document)
    named = {node.get(qn("w:val")) for tag in ("w:pStyle", "w:rStyle", "w:tblStyle") for node in document.element.body.iter(qn(tag))}
    named |= {default_style_id(styles, kind) for kind in ("character", "table")}
    named.add(default_style_id(styles, "paragraph") or "Normal")
    applied = {id(element): element for style_id in named for _, element in style_chain(styles, style_id)}
    defaults = document.styles.element.find(qn("w:docDefaults"))
    return ([defaults] if defaults is not None else []) + list(applied.values())


def _strip_uniform_damage(document: DocumentObject) -> list[str]:
    """Remove hidden / struck formatting only when it covers every character.

    Returns a note for each paragraph that keeps hidden or struck text, so the
    user is told rather than it being shown or kept silently.
    """

    every = [run for paragraph in all_paragraphs(document) for run in visible_runs(paragraph)]
    runs = [run for run in every if run.text.strip()]
    if not runs:
        return []
    applied = None
    for tag in _UNIFORM_DAMAGE:
        if all(_on(run._r.rPr, tag) for run in runs):
            for run in every:  # spaces too
                if run._r.rPr is not None:
                    _remove_children(run._r.rPr, (tag,))
            # A damaged default style must not reapply the removed property
            # when the exported document is opened by an Office reader.  A
            # style only footnotes or headers use keeps it: their hidden
            # notes are not part of the damage.
            applied = _styles_applied_to_body(document) if applied is None else applied
            for root in applied:
                for node in list(root.iter(qn(f"w:{tag}"))):
                    node.getparent().remove(node)
    notes = []
    for number, paragraph in enumerate(all_paragraphs(document), 1):
        kept = [run for run in visible_runs(paragraph) if run.text.strip()]
        hidden = any(_on(run._r.rPr, tag) for run in kept for tag in ("vanish", "webHidden", "specVanish"))
        struck = any(_on(run._r.rPr, "strike") or _on(run._r.rPr, "dstrike") for run in kept)
        if hidden or struck:
            what = "隐藏文字" if hidden and not struck else "删除线文字" if struck and not hidden else "隐藏文字和删除线文字"
            notes.append(f"第 {number} 段含{what}，已保留原稿的显示、打印或删除标记，请确认是否需要。")
    return notes


def _remove_typographic_noise(run) -> None:
    rpr = run._r.rPr
    if rpr is not None:
        _remove_children(rpr, TYPOGRAPHIC_NOISE_TAGS)


def _remove_safe_run_noise(run) -> None:
    rpr = run._r.rPr
    if rpr is not None:
        _remove_children(rpr, SAFE_RUN_NOISE_TAGS)


def _remove_children(parent, tags: Iterable[str]) -> None:
    for tag in tags:
        for node in list(parent.findall(qn(f"w:{tag}"))):
            parent.remove(node)
