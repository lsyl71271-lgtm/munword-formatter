from __future__ import annotations

import re

from ..docx_view import visible_runs, visible_text
from ..models import ValidationItem
from ..parser import MANUAL_NUMBER_RE
from ..semantic_policy import OPERATIVE_ZH, PREAMBLE_ZH, clause_prefixes
from .base import MAX_INDENT_PT, BaseFormatter, ContentSnapshot, longest_prefix, role_prefix
from .handbook import role_pitch
from .mixins import OperativeClausesMixin


_ARTICLE_HEADING_RE = re.compile(r"\s*第[一二三四五六七八九十百]+条\s*")


def _is_heading_like(text: str) -> bool:
    """A bare "第X条" line or a clause that only introduces subclauses."""

    return bool(_ARTICLE_HEADING_RE.fullmatch(text) or text.rstrip().endswith(("：", ":")))


class DraftResolutionFormatter(OperativeClausesMixin, BaseFormatter):
    """Chinese resolutions have their own role-based flow; English ones share the directive flow."""

    document_type = "draft-resolution"
    title_zh = "决议草案"
    title_en = "Draft Resolution"

    def _format_document(self, document, model, preserve_country_order, normalize_punctuation):
        if model.language != "zh":
            return self._format_operative_document(document, model, preserve_country_order, normalize_punctuation)
        # Chinese articles keep their literal "第一条" / "（一）" markers.
        self._apply_common_roles(document, model, preserve_country_order)
        self._clear_formatting_noise(document, "zh")
        for clause, paragraph in self._clause_paragraphs(document, model.preambulatory_clauses):
            if not role_prefix(visible_text(paragraph), PREAMBLE_ZH)[1]:
                model.warnings.append(f"第 {clause.paragraph_index + 1} 段疑似缺少序言性动词。")
        for clause, paragraph in self._clause_paragraphs(document, model.operative_clauses):
            if clause.level != 0:
                continue
            # An article that only introduces its subclauses ("…：") still
            # opens with an operative verb.
            if not role_prefix(visible_text(paragraph), OPERATIVE_ZH)[1] and not _is_heading_like(visible_text(paragraph)):
                model.warnings.append(f"第 {clause.paragraph_index + 1} 段疑似缺少行动动词。")

    # ----------------------------------------------------------- validation

    def _validate(self, document, model, before: ContentSnapshot, after: ContentSnapshot, preserve_country_order):
        items = super()._validate(document, model, before, after, preserve_country_order)
        preamble_words, operative_words = clause_prefixes(model.language)
        preamble_ok = bool(model.preambulatory_clauses) and all(
            self._role_prefix_emphasis_ok(document, clause, preamble_words, "underline")
            for clause in model.preambulatory_clauses
        )
        operative_top = [
            clause
            for clause, paragraph in self._clause_paragraphs(document, model.operative_clauses)
            if clause.level == 0 and (not _is_heading_like(visible_text(paragraph)) or _verb(visible_text(paragraph), operative_words)[1])
        ]
        operative_ok = bool(operative_top) and all(
            self._role_prefix_emphasis_ok(document, clause, operative_words, "italic")
            for clause in operative_top
        )
        geometry_errors = self._resolution_geometry_errors(document, model)
        items.extend([
            ValidationItem("preamble-numbering", "序言性条款无编号", "pass"),
            ValidationItem("preamble-emphasis", "序言性动词已下划线", "pass" if preamble_ok else "warning", "未识别到序言性条款或强调格式不完整。" if not preamble_ok else ""),
            ValidationItem("signature-layout", "起草国和附议国按范例留白签字（无表格、无下划线）", "pass" if not document.tables else "warning"),
            ValidationItem("operative-numbering", "行动性条款层级和悬挂缩进已规范", "pass" if model.operative_clauses and not geometry_errors else "warning", "；".join(geometry_errors[:6])),
            ValidationItem("operative-emphasis", "行动性动词已斜体", "pass" if operative_ok else "warning"),
        ])
        return items

    def _role_prefix_emphasis_ok(self, document, clause, phrases, mode) -> bool:
        paragraph = self._paragraph_at(document, clause.paragraph_index)
        if paragraph is None:
            return False
        start, phrase = _verb(visible_text(paragraph), phrases)
        if not phrase:
            return False
        end = start + len(phrase)
        cursor = 0
        covered = 0
        for run in visible_runs(paragraph):
            run_start, run_end = cursor, cursor + len(run.text)
            cursor = run_end
            overlap = max(0, min(end, run_end) - max(start, run_start))
            if not overlap:
                continue
            covered += overlap
            if mode == "italic" and run.italic is not True:
                return False
            if mode == "underline" and run.underline is not True:
                return False
        return covered == len(phrase)

    def _resolution_geometry_errors(self, document, model) -> list[str]:
        errors: list[str] = []
        clauses = model.body_clauses + model.preambulatory_clauses + model.operative_clauses
        for clause, paragraph in self._clause_paragraphs(document, clauses):
            if clause.kind == "heading":
                continue
            number = clause.paragraph_index + 1
            if paragraph.paragraph_format.page_break_before:
                errors.append(f"第 {number} 段仍含强制分页")
            role = "preamble" if clause.kind == "preambulatory" else "body"
            expected = role_pitch(self.document_type, model.language, role)
            actual = paragraph.paragraph_format.line_spacing
            if actual is None or isinstance(actual, float) or abs(actual.pt - expected) > 0.05:
                errors.append(f"第 {number} 段行距异常")
            left = paragraph.paragraph_format.left_indent
            if left is not None and abs(left.pt) > MAX_INDENT_PT:
                errors.append(f"第 {number} 段缩进异常")
        return errors


def _verb(text: str, phrases) -> tuple[int, str]:
    """``role_prefix`` matched case-insensitively (English clauses are capitalized)."""

    marker = MANUAL_NUMBER_RE.match(text)
    start = marker.end() if marker else len(text) - len(text.lstrip())
    return start, longest_prefix(text[start:], phrases, casefold=True)
