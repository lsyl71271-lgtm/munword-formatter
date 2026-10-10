"""Diplomatic agreements and joint statements (mirror of ``formatTreaty`` in ``app/docx-browser.ts``).

The layouts follow the two reference documents (``shared/document-policy.json`` →
``treaties.layouts``); the text is never rewritten except for the signature
labels a party lacks and, in a joint statement without numbering, the "N. "
before each paragraph.
"""

from __future__ import annotations

import copy
import json
import re
from io import BytesIO

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Twips
from docx.text.paragraph import Paragraph

from .. import content_guard
from .. import treaty
from ..docx_view import (
    active_num_id,
    all_paragraphs,
    body_paragraphs,
    carries_hidden_structure,
    holds_inline_object,
    invalidate as invalidate_paragraph_cache,
    visible_runs,
    visible_text,
)
from ..fonts import normalize_font_parts, rpr_child
from ..models import IntermediateDocument, ValidationItem
from ..ooxml_edit import carries_semantic_marks, edit_visible_text, has_complex_content
from ..semantic_policy import HANDBOOK, TITLES, TREATIES
from . import handbook
from .base import BaseFormatter, _remove_safe_run_noise, _strip_uniform_damage

_PAGE = HANDBOOK["page"]
BODY_PT = handbook.BODY_SIZE_PT
# Text-block width in ems at the body size (browser LINE_EM = LINE_WIDTH_EM + 1).
LINE_EM = (_PAGE["widthTwips"] - _PAGE["leftTwips"] - _PAGE["rightTwips"]) / 20 / BODY_PT
_PARAGRAPH_CLEAN = ("pStyle", "bidi", "textDirection", "shd", "pBdr", "framePr", "contextualSpacing", "snapToGrid", "tabs", "outlineLvl", "textAlignment")
_ALIGN = {"center": WD_ALIGN_PARAGRAPH.CENTER, "both": WD_ALIGN_PARAGRAPH.JUSTIFY, "left": WD_ALIGN_PARAGRAPH.LEFT}
_NUMBERED_RE = re.compile(r"^\s*\d{1,3}\s*[.、．)]")
_OPEN_QUOTES = re.compile(r"[“「『\"]")
_CLOSE_QUOTES = re.compile(r"[”」』\"]")


class TreatyFormatter(BaseFormatter):
    document_type = "diplomatic-agreement"

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
        language = model.language
        self.document_type = model.document_type
        self._language = language
        self._layout_policy = TREATIES["layouts"][model.document_type]
        self._model = model
        self._active_body_size = BODY_PT
        self._east_asia = handbook.FONTS["zh" if language == "zh" else "en"]
        self._edit_log = {}
        self._protected_warnings = []
        self._warnings: list[str] = []
        self._titles: set = set()
        self._source_paragraphs = list(body_paragraphs(document))
        recognized = treaty.recognize([visible_text(p) for p in self._source_paragraphs], model.document_type, language)
        self._warnings = [w for w in recognized.warnings if not w.startswith("未能从标题识别") or len(model.sponsors) < 2]

        from .base import ContentSnapshot
        before = ContentSnapshot.take(document)
        strict_before = content_guard.Snapshot.take(document)
        kept_hidden = _strip_uniform_damage(document)
        marks_before = content_guard.semantic_marks(document)
        self._configure_page(document, language)
        self._configure_styles(document, language)
        for paragraph in all_paragraphs(document):
            for run in visible_runs(paragraph):
                _remove_safe_run_noise(run)
                self._format_run(run, language)
        notes = self._layout_document(document)
        invalidate_paragraph_cache()
        after = ContentSnapshot.take(document)
        problems = content_guard.verify_format(
            strict_before, document, self._edit_log, allowed_titles=TITLES[model.document_type], labels=(),
        ) + content_guard.verify_marks(marks_before, document)
        size_issues = self._size_issues(document)
        output = BytesIO()
        document.save(output)
        content_out = normalize_font_parts(output.getvalue(), language, east_asia=self._east_asia, note_size_pt=handbook.NOTE_SIZE_PT)
        package_problems = content_guard.verify_package(content, content_out)
        layout = self._layout_policy
        title = HANDBOOK["outputTitles"][model.document_type]["zh"]
        validations = [
            ValidationItem("docx_package", "DOCX 包结构", "pass", "必要的 Word 部件完整。"),
            ValidationItem("structural_edits", "结构与人工修改记录", "warning" if notes else "pass", "；".join(notes) or "未改写正文文字。"),
            ValidationItem(
                "content", "逐段严格内容校验（文字、域、链接、书签、脚注、修订、隐藏与删除线）", "error" if problems else "pass",
                "；".join(problems[:6]) or f"正文文字未改动；只允许签字栏补上缺少的代表{'和联合声明段落编号' if layout['numberStatements'] else ''}。",
            ),
            ValidationItem(
                "package", "链接目标、关系与嵌入资源逐项保留", "error" if package_problems else "pass",
                "；".join(package_problems[:6]) or "每个关系的目标、类型、模式及每个图片 / 嵌入对象的字节均与原稿一致。",
            ),
            ValidationItem(
                "font_size", "标题与正文字号", "error" if size_issues else "pass",
                f"仍有 {size_issues} 个文本片段未达到规定字号。" if size_issues
                else f"标题 {layout['titleSizePt']:g} 磅加粗居中、正文 {BODY_PT:g} 磅（{title}版式）。",
            ),
        ]
        validations += [ValidationItem("hidden-text", "隐藏文字与删除线按原稿保留", "warning", note) for note in kept_hidden]
        validations += [ValidationItem("content-protected", "为保护原有内容，部分段落未自动改写", "warning", note) for note in self._protected_warnings]
        validations += [ValidationItem("structure_review", "结构识别待确认", "warning", detail) for detail in self._warnings]
        self._source_paragraphs = []
        return content_out, validations, before.canonical, after.canonical

    # --------------------------------------------------------------- layout

    def _line(self, paragraph: Paragraph, role: str, extra_before: int = 0) -> None:
        spacing = paragraph._p.get_or_add_pPr().get_or_add_spacing()
        for name in ("beforeAutospacing", "afterAutospacing", "beforeLines", "afterLines"):
            spacing.attrib.pop(qn(f"w:{name}"), None)
        before, after = self._layout_policy["spacingTwips"][role]
        spacing.set(qn("w:before"), str(before + extra_before))
        spacing.set(qn("w:after"), str(after))
        line = self._layout_policy["line"]
        if line["rule"] == "exact":
            spacing.set(qn("w:line"), str(treaty._js_round(line["pitchPt"][self._language]["title" if role == "title" else "body"] * 20)))
            spacing.set(qn("w:lineRule"), "atLeast" if holds_inline_object(paragraph._p) else "exact")
        else:
            spacing.set(qn("w:line"), str(line[role]))
            spacing.set(qn("w:lineRule"), "auto")

    @staticmethod
    def _indent(paragraph: Paragraph, left: int, first_line: int) -> None:
        ind = paragraph._p.get_or_add_pPr().get_or_add_ind()
        ind.attrib.clear()
        ind.set(qn("w:left"), str(left))
        ind.set(qn("w:right"), "0")
        ind.set(qn("w:firstLine"), str(first_line))

    def _paragraph(self, paragraph: Paragraph, role: str, align: str, left: int = 0, first_line: int = 0) -> None:
        ppr = paragraph._p.get_or_add_pPr()
        for tag in _PARAGRAPH_CLEAN:
            for node in ppr.findall(qn(f"w:{tag}")):
                ppr.remove(node)
        fmt = paragraph.paragraph_format
        fmt.page_break_before = False
        fmt.keep_together = False
        fmt.keep_with_next = role == "title"
        self._line(paragraph, role)
        paragraph.alignment = _ALIGN[align]
        self._indent(paragraph, left, first_line)

    def _sized(self, run, size_pt: float) -> None:
        rpr = run._r.get_or_add_rPr()
        for tag in ("sz", "szCs"):
            rpr_child(rpr, tag).set(qn("w:val"), str(int(round(size_pt * 2))))

    def _layout_document(self, document) -> list[str]:
        notes: list[str] = []
        paragraphs = list(body_paragraphs(document))
        texts = [visible_text(p) for p in paragraphs]
        non_empty = [(text.strip(), index) for index, text in enumerate(texts) if text.strip()]
        indices = treaty.title_indices(non_empty, self._language)
        closing = treaty.signature_start(texts, self._language)
        end = closing if closing >= 0 else len(texts)
        layout = self._layout_policy
        for index in indices:
            paragraph = paragraphs[index]
            self._titles.add(paragraph._p)
            self._paragraph(paragraph, "title", "center")
            for run in visible_runs(paragraph):
                self._format_run(run, self._language, bold=True)
                self._sized(run, layout["titleSizePt"])
        chapter = re.compile(layout["chapter"], re.I) if layout.get("chapter") else None
        opening = re.compile(layout["opening"], re.I) if layout.get("opening") else None
        quote = layout.get("quote")
        body = [p for index, p in enumerate(paragraphs[:end]) if index not in indices and texts[index].strip()]
        statement_items: list[Paragraph] = []
        quote_depth = 0
        for position, paragraph in enumerate(body):
            text = visible_text(paragraph).strip()
            opens, closes = len(_OPEN_QUOTES.findall(text)), len(_CLOSE_QUOTES.findall(text))
            quoted = bool(quote) and (quote_depth > 0 or bool(re.match(r"^[“「『\"]", text)))
            quote_depth = max(0, quote_depth + opens - closes)
            if chapter and chapter.search(text) and len(text) <= 80 and not treaty.SENTENCE_MARK.search(text):
                self._paragraph(paragraph, "body", "center")
                for run in visible_runs(paragraph):
                    self._format_run(run, self._language, bold=True)
            elif quoted:
                self._paragraph(paragraph, "body", layout["bodyAlign"], treaty._js_round(quote["indentPt"] * 20), 0)
                if quote["italic"]:
                    for run in visible_runs(paragraph):
                        self._format_run(run, self._language, italic=True)
            elif layout["numberStatements"] and position == 0 and opening and opening.search(text):
                self._paragraph(paragraph, "body", layout["bodyAlign"])
            else:
                self._paragraph(paragraph, "body", layout["bodyAlign"], 0, treaty._js_round(layout["bodyFirstLinePt"] * 20))
                if layout["numberStatements"]:
                    statement_items.append(paragraph)
        if layout["numberStatements"]:
            note = self._statement_numbers(statement_items)
            if note:
                notes.append(note)
        # Empty paragraphs between the title and the signature block are dropped, as in both references.
        root = document.element.body
        for index, paragraph in enumerate(paragraphs[:end]):
            element = paragraph._p
            if (texts[index].strip() or element.getparent() is not root or carries_hidden_structure(paragraph)
                    or active_num_id(paragraph) is not None or not content_guard.is_whitespace(content_guard.signature(element))):
                continue
            self._log_edit(paragraph, "empty-line")
            root.remove(element)
        invalidate_paragraph_cache()
        notes.extend(self._signature(document, paragraphs, texts))
        return notes

    def _statement_numbers(self, items: list[Paragraph]) -> str | None:
        """Joint statement numbering: "N. " before each statement paragraph when the original numbers none of them."""

        number_format = self._layout_policy.get("numberFormat") or "{n}. "
        numbered = [p for p in items if active_num_id(p) is not None or _NUMBERED_RE.match(visible_text(p))]
        if not items or len(numbered) == len(items):
            return None
        if numbered:
            self._warnings.append("联合声明的段落部分有编号、部分没有，已保留原样未补编号；请人工核对。")
            return None
        added = 0
        for index, paragraph in enumerate(items):
            new_text = number_format.replace("{n}", str(index + 1)) + visible_text(paragraph)
            marks = content_guard.paragraph_marks(paragraph._p)
            backup = copy.deepcopy(paragraph._p)
            if edit_visible_text(paragraph, new_text) and visible_text(paragraph) == new_text and content_guard.marks_kept(marks, paragraph._p):
                self._log_edit(paragraph, "statement-number", expected=new_text)
                added += 1
                continue
            for child in list(paragraph._p):
                paragraph._p.remove(child)
            for child in list(backup):
                paragraph._p.append(child)
            self._protect(paragraph, "该段无法安全加入编号，已保留原样")
        return f"联合声明 {added} 段按范例加上编号“1.”“2.”……" if added else None

    def _signature(self, document, paragraphs: list[Paragraph], texts: list[str]) -> list[str]:
        """The signature block rebuilt with one representative per party; the original block is replaced only when it is plain text."""

        notes: list[str] = []
        language = self._language
        parties = [party.strip() for party in self._model.sponsors if party.strip()]
        start = treaty.signature_start(texts, language)
        block = paragraphs[start:] if start >= 0 else []
        if any(has_complex_content(p) or carries_semantic_marks(p) for p in block):
            for p in block:
                if visible_text(p).strip():
                    self._paragraph(p, "signature", "center")
            self._warnings.append("签字栏含有图片、域、链接、修订或隐藏文字，已保留原样未重建；请人工核对代表数量。")
            return notes
        lines = [(visible_text(p), _alignment(p)) for p in block]
        read = treaty.read_signature_block(lines, language, LINE_EM) if block else ([], False)
        if read is None:
            for p in block:
                if visible_text(p).strip():
                    self._paragraph(p, "signature", "center")
            self._warnings.append("签字栏的姓名行无法与代表行一一对应，已保留原样；请人工核对。")
            return notes
        original, inferred = read
        # Every treaty has at least two parties: with fewer (the warning asks for them in step 03) no block is added.
        if not original and len(parties) < 2:
            return notes
        entries = treaty.signature_entries(parties, original, language)
        added = [entry["label"] for entry in entries if not any(item["label"] == entry["label"] for item in original)]
        extra = [entry for entry in original if not any(treaty.party_key(treaty.label_party(entry["label"], language)) == treaty.party_key(party) for party in parties)]
        body = document.element.body
        anchor = block[0]._p if block else body.find(qn("w:sectPr"))
        line = self._layout_policy["line"]
        pitch = treaty._js_round(line["pitchPt"][language]["body"] * 20) if line["rule"] == "exact" else 312
        labels: list[str] = []
        created = []
        for row_index, row in enumerate(treaty.signature_rows(entries, LINE_EM)):
            stops = treaty.column_stops(row, LINE_EM, BODY_PT)
            for role in ("labels", "names"):
                element = OxmlElement("w:p")
                if anchor is not None:
                    anchor.addprevious(element)
                else:
                    body.append(element)
                paragraph = Paragraph(element, block[0]._parent if block else document._body)
                for stop in stops:
                    paragraph.paragraph_format.tab_stops.add_tab_stop(Twips(stop), WD_TAB_ALIGNMENT.CENTER)
                self._line(paragraph, "signature", pitch if role == "labels" and row_index > 0 else 0)
                paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
                self._indent(paragraph, 0, 0)
                values = [entry["label"] if role == "labels" else entry["name"] for entry in row]
                run = paragraph.add_run("".join(f"\t{value}" for value in values))
                self._format_run(run, language, bold=False, italic=False, underline=False)
                if role == "labels":
                    labels.extend(values)
                created.append(element)
        for p in block:
            self._log_edit(p, "signature", "signature")
            p._p.getparent().remove(p._p)
        for element in created:
            self._log_edit_element(element, "signature", "signature", expected=json.dumps(labels, ensure_ascii=False), new=True)
        invalidate_paragraph_cache()
        separator = "、" if language == "zh" else ", "
        notes.append(
            f"签字栏按{'签署方' if parties else '原稿'}排为 {len(entries)} 方：{separator.join(treaty.label_party(entry['label'], language) for entry in entries)}"
            + (f"；补上：{separator.join(added)}" if added else "")
            + ("；原稿已写的代表与姓名保留" if block else "；原稿没有签字栏，姓名处留空供签字")
        )
        if inferred:
            self._warnings.append("签字栏中原稿姓名少于代表，已按位置放在最近的代表下方；请核对姓名与代表是否对应。")
        if extra:
            self._warnings.append(f"原稿签字栏中的 {'、'.join(entry['label'] for entry in extra)} 与识别的签署方对不上，已保留在末尾；请核对第 03 步的签署方。")
        return notes

    def _size_issues(self, document) -> int:
        issues = 0
        for paragraph in all_paragraphs(document):
            expected = self._layout_policy["titleSizePt"] if paragraph._p in self._titles else BODY_PT
            for run in visible_runs(paragraph):
                if not run.text.strip():
                    continue
                size = run._r.find(f"{qn('w:rPr')}/{qn('w:sz')}")
                raw = size.get(qn("w:val")) if size is not None else None
                if not raw or abs(int(raw) / 2 - expected) > 0.05:
                    issues += 1
        return issues


def _alignment(paragraph: Paragraph) -> str | None:
    jc = paragraph._p.find(f"{qn('w:pPr')}/{qn('w:jc')}")
    return jc.get(qn("w:val")) if jc is not None else None


class DiplomaticAgreementFormatter(TreatyFormatter):
    document_type = "diplomatic-agreement"


class JointStatementFormatter(TreatyFormatter):
    document_type = "joint-statement"
