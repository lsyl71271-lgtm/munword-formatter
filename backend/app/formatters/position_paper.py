from __future__ import annotations

import re
from typing import Callable

from docx.document import Document as DocumentObject
from docx.oxml.ns import qn

from ..docx_view import body_paragraphs, visible_runs, visible_text
from ..fonts import rpr_child
from ..models import IntermediateDocument, ValidationItem
from ..semantic_policy import label_value
from .base import SIZE_TOLERANCE_PT, BaseFormatter, ContentSnapshot
from .handbook import NOTE_SIZE_PT


HEADER_FIELDS = ("committee", "topic", "country", "delegate")
# Reference notes are set like the handbook's footnotes: 9 pt, no indent.
REFERENCE_SIZE_PT = NOTE_SIZE_PT
REFERENCE_START_RE = re.compile(r"^\s*\[1\]")


class PositionPaperFormatter(BaseFormatter):
    document_type = "position-paper"
    title_zh = "立场文件"
    title_en = "Position Paper"

    _SECTION_MARKER_RE = re.compile(
        r"^\s*([（(][一二三四五六七八九十百]+[）)])"
    )
    _VISIBLE_DECIMAL_RE = re.compile(r"^\s*(\d+)[.、．)]\s*(?:\t\s*)?(.*)$", re.S)

    def _format_document(self, document, model, preserve_country_order, normalize_punctuation):
        self._apply_common_roles(document, model, preserve_country_order)
        body_start = self._body_start(document)
        numbered_count = 0
        for paragraph in body_paragraphs(document)[body_start:]:
            text = visible_text(paragraph).strip()
            if text and self._format_visible_numbered(paragraph, text, model.language):
                numbered_count += 1
        if numbered_count:
            model.max_numbering_level = max(model.max_numbering_level, 2)
        self._format_sources(document, body_start, model.language)

    def _format_visible_numbered(self, paragraph, text: str, language: str) -> bool:
        match = self._VISIBLE_DECIMAL_RE.match(text)
        if not match:
            return False
        num_pr = paragraph._p.pPr.numPr if paragraph._p.pPr is not None else None
        if num_pr is not None and num_pr.numId is not None and num_pr.numId.val != 0:
            self._protect(paragraph, "该段同时含手动标记和原生编号，已保留原条号，请人工确认")
            return False
        # The handbook samples type their markers ("1、" / "1.") followed by a
        # tab to the hanging indent.  Do not replace them with OOXML-only
        # numbering: doing so made a lost marker invisible to text-level QA
        # and rendered differently in WPS.
        marker, clause_text = match.groups()
        punctuation = "、" if language == "zh" else "."
        expected = f"{marker}{punctuation}\t{clause_text}"
        if visible_text(paragraph) != expected:
            self._rewrite_logged(paragraph, expected, language, "marker")
        ppr = paragraph._p.get_or_add_pPr()
        if ppr.numPr is not None:
            ppr.remove(ppr.numPr)
        return True

    def _reference_start(self, document: DocumentObject, start: int = 0) -> int | None:
        """Index of the "[1] ..." paragraph that opens the reference list."""

        paragraphs = body_paragraphs(document)
        return next(
            (index for index in range(start, len(paragraphs)) if REFERENCE_START_RE.match(visible_text(paragraphs[index]))),
            None,
        )

    def _format_sources(self, document, body_start, language):
        source_start = self._reference_start(document, body_start)
        if source_start is None:
            return
        for paragraph in body_paragraphs(document)[source_start:]:
            for run in visible_runs(paragraph):
                # Underlined URLs in a reference entry are the author's; only
                # bold and italic are cleared.
                self._format_run(run, language, bold=False, italic=False)
                rpr = run._r.get_or_add_rPr()
                for tag in ("sz", "szCs"):
                    rpr_child(rpr, tag).set(qn("w:val"), str(int(round(REFERENCE_SIZE_PT * 2))))

    # ----------------------------------------------------------- validation

    def _expected_run_size(self, document: DocumentObject, model: IntermediateDocument) -> Callable[[int], float]:
        source_start = self._reference_start(document)
        if source_start is None:
            source_start = len(body_paragraphs(document))
        body = self._body_size_pt(model.language)
        return lambda index: REFERENCE_SIZE_PT if index >= source_start else body

    def _validate(self, document, model, before: ContentSnapshot, after: ContentSnapshot, preserve_country_order):
        items = super()._validate(document, model, before, after, preserve_country_order)
        items.append(self._validate_header_fields(document, model))
        items.append(self._validate_section_markers(document, model))
        items.append(self._validate_sizes(document, model))
        return items

    def _validate_header_fields(self, document, model) -> ValidationItem:
        # Every labeled line keeps its label and value, in order; a header line
        # confirmed in step 03 carries the confirmed value instead.
        source_metadata: dict[str, list[str]] = {}
        for index, text in enumerate(model.paragraphs):
            key, value = label_value(text.strip())
            if key in HEADER_FIELDS:
                if key in self._changed_fields and model.header_paragraph_indices.get(key) == index:
                    value = str(getattr(model, key)).strip()
                source_metadata.setdefault(key, []).append(value)
        output_metadata: dict[str, list[str]] = {}
        for paragraph in body_paragraphs(document):
            key, value = label_value(visible_text(paragraph).strip())
            if key in HEADER_FIELDS:
                output_metadata.setdefault(key, []).append(value)
        metadata_ok = all(output_metadata.get(key) == values for key, values in source_metadata.items())
        return ValidationItem(
            "position-metadata",
            "委员会、议题、国家、代表标签和值完整保留",
            "pass" if metadata_ok else "error",
            "检测到页首标签或对应内容缺失。" if not metadata_ok else "",
        )

    def _validate_section_markers(self, document, model) -> ValidationItem:
        source_markers = [
            match.group(1)
            for text in model.paragraphs
            if (match := self._SECTION_MARKER_RE.match(text))
        ]
        output_markers = [
            match.group(1)
            for paragraph in body_paragraphs(document)
            if (match := self._SECTION_MARKER_RE.match(visible_text(paragraph)))
        ]
        # Structure repair may restore a missing first marker before a "（二）";
        # it skips the repair when the heading's text is a tracked revision.
        allowed = [source_markers]
        if source_markers and source_markers[0] == "（二）":
            allowed.append(["（一）", *source_markers])
        marker_ok = output_markers in allowed
        return ValidationItem(
            "position-section-markers",
            "（一）、（二）等分节序号完整保留",
            "pass" if marker_ok else "error",
            f"输入序号 {source_markers}；输出序号 {output_markers}。" if not marker_ok else "",
        )

    def _validate_sizes(self, document, model) -> ValidationItem:
        expected_for = self._expected_run_size(document, model)
        wrong_sizes: list[str] = []
        for index, paragraph in enumerate(body_paragraphs(document)):
            if not visible_text(paragraph).strip():
                continue
            expected_size = expected_for(index)
            for run in visible_runs(paragraph):
                if not run.text or run.font.size is None:
                    continue
                if abs(run.font.size.pt - expected_size) > SIZE_TOLERANCE_PT:
                    wrong_sizes.append(f"第 {index + 1} 段 {run.font.size.pt:g} pt")
                    break
        return ValidationItem(
            "position-font-size",
            f"正文 {self._body_size_pt(model.language):g} pt、参考文献 {REFERENCE_SIZE_PT:g} pt",
            "pass" if not wrong_sizes else "error",
            "；".join(wrong_sizes[:6]),
        )
