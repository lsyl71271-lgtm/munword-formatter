from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass
from io import BytesIO

from docx import Document
from docx.text.paragraph import Paragraph
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn

from . import content_guard
from .docx_view import (
    active_num_id, all_paragraphs, body_paragraphs, default_style_id, invalidate as invalidate_paragraph_cache, own_runs,
    style_chain, style_index, visible_text,
)
from .fonts import rpr_child
from .ooxml_edit import SEMANTIC_MARKS, edit_visible_text, has_complex_content, run_has
from .parser import MANUAL_NUMBER_RE, detect_language
from .semantic_policy import EMBEDDED_SUBCLAUSE, META_LABELS, label_value, starts_body


POSITION_KEYS = ("committee", "topic", "country", "delegate")
POSITION_SECTION_RE = re.compile(r"^\s*[（(]([一二三四五六七八九十百]+)[）)]")
# Shared policy ``embeddedSubclause``: the browser engine applies the same rule.
_SUBCLAUSE_MARKER_RE = re.compile(EMBEDDED_SUBCLAUSE["marker"])
_FIRST_LEVEL_RE = re.compile(EMBEDDED_SUBCLAUSE["firstLevel"])
_ARTICLE_RE = re.compile(EMBEDDED_SUBCLAUSE["article"])
_CLAUSE_RE = re.compile(EMBEDDED_SUBCLAUSE["clause"])
REPAIR_THRESHOLD = 0.9
_LIST_ITEM_END_RE = re.compile(r"[；;。.]$")


@dataclass(frozen=True)
class RepairAction:
    code: str
    paragraph_index: int
    confidence: float
    before: str
    after: str
    applied: bool

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "paragraph_index": self.paragraph_index,
            "confidence": self.confidence,
            "before": self.before,
            "after": self.after,
            "applied": self.applied,
        }


@dataclass(frozen=True)
class StructureRepairResult:
    content: bytes
    actions: tuple[RepairAction, ...] = ()

    @property
    def warnings(self) -> list[str]:
        warnings: list[str] = []
        for action in self.actions:
            if action.applied:
                warnings.append(
                    f"已自动修复结构：{action.code}（第 {action.paragraph_index + 1} 段，置信度 {action.confidence:.0%}）。"
                )
            else:
                warnings.append(
                    f"发现疑似结构问题但未自动修改：{action.code}（第 {action.paragraph_index + 1} 段，置信度 {action.confidence:.0%}）。"
                )
        return warnings


def repair_structure_with_report(content: bytes, document_type: str) -> StructureRepairResult:
    """Repair only high-confidence structural loss, independent of document content.

    The rules deliberately do not use filenames, countries, topics or stored
    reference documents.  If no repair is needed the original bytes are
    returned unchanged.
    """

    document = Document(BytesIO(content))
    # Not a repair: list numbering kept in a paragraph style is made explicit
    # so that parsing sees it and resetting styles later cannot drop it.
    normalized = _materialize_style_list_format(document)
    normalized = _materialize_style_emphasis(document) or normalized
    actions: list[RepairAction] = []
    if document_type == "position-paper":
        actions.extend(_repair_position_header(document))
        actions.extend(_repair_first_position_section(document))
    if document_type in EMBEDDED_SUBCLAUSE["documentTypes"]:
        actions.extend(_split_embedded_subclauses(document))
    if document_type in ("draft-resolution", "working-paper"):
        actions.extend(_restore_dropped_first_list_item(document))
    if not normalized and not any(action.applied for action in actions):
        return StructureRepairResult(content, tuple(actions))
    stream = BytesIO()
    document.save(stream)
    return StructureRepairResult(stream.getvalue(), tuple(actions))


_SEMANTIC_STYLE_TAGS = ("vanish", "webHidden", "specVanish", "strike", "dstrike")
_STYLE_EMPHASIS_TAGS = ("b", "i", "u", "vertAlign", *_SEMANTIC_STYLE_TAGS)


def _materialize_style_emphasis(document) -> bool:
    """Copy emphasis a run inherits from a character or a named paragraph style.

    Formatting resets every paragraph to Normal and drops run styles, so
    emphasis that only lived in a style ("Strong", "Emphasis", a bold
    heading style, a superscript citation style) disappeared.  The default
    paragraph style and the document defaults are not copied: a damaged bold
    Normal style would otherwise turn a whole document bold.
    """

    styles = style_index(document)
    default_paragraph = default_style_id(styles, "paragraph") or "Normal"
    defaults = {default_paragraph, "Normal"}

    def inherited(style_id, tag):
        seen = set()
        while style_id and style_id in styles and style_id not in seen and (tag in _SEMANTIC_STYLE_TAGS or style_id not in defaults):
            seen.add(style_id)
            found = styles[style_id].find(f"{qn('w:rPr')}/{qn(f'w:{tag}')}")
            if found is not None:
                return found
            based = styles[style_id].find(qn("w:basedOn"))
            style_id = based.get(qn("w:val")) if based is not None else None
        return None

    changed = False
    # Every paragraph: fonts are normalized in table cells and text boxes too,
    # which drops their run styles (the browser engine does the same).
    for paragraph in all_paragraphs(document):
        ppr = paragraph._p.pPr
        style = ppr.find(qn("w:pStyle")) if ppr is not None else None
        paragraph_style = style.get(qn("w:val")) if style is not None else None
        # A text box's paragraphs inherit from their own styles.
        for run in own_runs(paragraph._p):
            rpr = run.find(qn("w:rPr"))
            run_style = rpr.find(qn("w:rStyle")) if rpr is not None else None
            character_style = run_style.get(qn("w:val")) if run_style is not None else None
            for tag in _STYLE_EMPHASIS_TAGS:
                if rpr is not None and rpr.find(qn(f"w:{tag}")) is not None:
                    continue
                found = inherited(character_style, tag)
                if found is None and tag != "vertAlign":
                    found = inherited(paragraph_style, tag)
                if found is None and tag in _SEMANTIC_STYLE_TAGS:
                    found = inherited(default_paragraph, tag)
                    if found is None:
                        found = document.styles.element.find(f"{qn('w:docDefaults')}/{qn('w:rPrDefault')}/{qn('w:rPr')}/{qn(f'w:{tag}')}")
                if found is None:
                    continue
                if rpr is None:
                    rpr = run.get_or_add_rPr()
                # The schema fixes the order of rPr children; the generated
                # inserter puts the copy in its legal position.
                target = rpr_child(rpr, tag)
                for name, value in found.attrib.items():
                    target.set(name, value)
                changed = True
    return changed


def _materialize_style_list_format(document) -> bool:
    """Copy list numbering and indentation inherited from a paragraph style.

    Documents built on Word's list styles ("List Number" and the like) carry
    their numbering in the style.  Formatting resets paragraphs to Normal, so
    without this the automatic numbers vanished from the output.
    """

    styles = style_index(document)
    definitions = _numbering_definitions(document)

    def chain(style_id):
        return [item for _, item in style_chain(styles, style_id)]

    changed = False
    for paragraph in body_paragraphs(document):
        ppr = paragraph._p.pPr
        style = ppr.find(qn("w:pStyle")) if ppr is not None else None
        if style is None:
            continue
        numbering = next((item.find(f"{qn('w:pPr')}/{qn('w:numPr')}") for item in chain(style.get(qn("w:val")))
                          if item.find(f"{qn('w:pPr')}/{qn('w:numPr')}") is not None), None)
        if numbering is None or ppr.numPr is not None or numbering.find(qn("w:numId")) is None:
            continue
        num_pr = deepcopy(numbering)
        level = num_pr.find(qn("w:ilvl"))
        if level is None:
            level = OxmlElement("w:ilvl")
            level.set(qn("w:val"), "0")
            num_pr.insert(0, level)
        # ECMA-376 §17.9.23: a level that names the paragraph style is that
        # style's level, whatever the style's own numPr says.
        linked = _linked_level(definitions, numbering.find(qn("w:numId")).get(qn("w:val")),
                               [style_id for style_id, _ in style_chain(styles, style.get(qn("w:val")))])
        if linked is not None:
            level.set(qn("w:val"), linked)
        ppr._insert_numPr(num_pr)
        if ppr.find(qn("w:ind")) is None:
            indent = next((item.find(f"{qn('w:pPr')}/{qn('w:ind')}") for item in chain(style.get(qn("w:val")))
                           if item.find(f"{qn('w:pPr')}/{qn('w:ind')}") is not None), None)
            if indent is not None:
                ppr._insert_ind(deepcopy(indent))
        changed = True
    return changed


def _numbering_definitions(document):
    """The numbering part's root, or ``None``; never creates the part."""

    try:
        part = document.part.part_related_by(RT.NUMBERING)
    except KeyError:
        return None
    return part.element if hasattr(part, "element") else parse_xml(part.blob)


def _linked_level(definitions, num_id: str, style_ids: list[str]) -> str | None:
    """The ``w:ilvl`` of the level whose ``w:pStyle`` names one of ``style_ids`` (nearest style first)."""

    if definitions is None:
        return None
    num = next((item for item in definitions.findall(qn("w:num")) if item.get(qn("w:numId")) == num_id), None)
    reference = num.find(qn("w:abstractNumId")) if num is not None else None
    if reference is None:
        return None
    abstract = next((item for item in definitions.findall(qn("w:abstractNum"))
                     if item.get(qn("w:abstractNumId")) == reference.get(qn("w:val"))), None)
    if abstract is None:
        return None
    linked: dict = {}
    for level in abstract.findall(qn("w:lvl")):
        style = level.find(qn("w:pStyle"))
        if style is not None:
            linked.setdefault(style.get(qn("w:val")), level.get(qn("w:ilvl")) or "0")
    return next((linked[style_id] for style_id in style_ids if style_id in linked), None)


def _repair_position_header(document) -> list[RepairAction]:
    paragraphs = body_paragraphs(document)
    nonempty = [index for index, paragraph in enumerate(paragraphs) if visible_text(paragraph).strip()]
    if not nonempty:
        return []
    title_index = next(
        (index for index in nonempty if "立场文件" in visible_text(paragraphs[index]) or "position paper" in visible_text(paragraphs[index]).lower()),
        None,
    )
    if title_index is None:
        return []
    candidates = [index for index in nonempty if index > title_index][:4]
    if len(candidates) < 4:
        return []
    recognized = [label_value(visible_text(paragraphs[index]).strip())[0] for index in candidates]
    # The repair targets a completely stripped four-line metadata block.  A
    # partially labeled header is ambiguous (a missing optional topic could
    # otherwise make the first body paragraph look like a delegate value).
    if any(recognized):
        return []
    candidate_texts = [visible_text(paragraphs[index]).strip() for index in candidates]
    # A numbered heading or a sentence is body text (shared headerBoundary):
    # labeling it would turn "一、问题背景" into the delegate.
    if any(starts_body(text) for text in candidate_texts):
        return []
    has_body_punctuation = any(re.search(r"[。；;！？!?]", text) for text in candidate_texts)
    language = detect_language("\n".join(visible_text(paragraph) for paragraph in paragraphs))
    lengths_ok = all(1 <= len(text) <= 80 for text in candidate_texts)
    confidence = 0.97 if lengths_ok and not has_body_punctuation else 0.58
    actions: list[RepairAction] = []
    for slot, index in enumerate(candidates):
        paragraph = paragraphs[index]
        key, _ = label_value(visible_text(paragraph).strip())
        if key:
            continue
        value = visible_text(paragraph).strip().lstrip("：:").strip()
        label = META_LABELS[language][POSITION_KEYS[slot]]
        replacement = f"{label}: {value}" if language == "en" else f"{label}：{value}"
        original = visible_text(paragraph)
        applied = confidence >= REPAIR_THRESHOLD and _rewrite_text(paragraph, replacement)
        actions.append(RepairAction("立场文件四行页首标签", index, confidence, original if not applied else value, replacement, applied))
    return actions


def _repair_first_position_section(document) -> list[RepairAction]:
    paragraphs = body_paragraphs(document)
    texts = [visible_text(paragraph).strip() for paragraph in paragraphs]
    markers = [(index, match.group(1)) for index, text in enumerate(texts) if (match := POSITION_SECTION_RE.match(text))]
    if not markers:
        return []
    second_index = next((index for index, value in markers if value == "二"), None)
    if second_index is None:
        return []
    if any(value == "一" and index < second_index for index, value in markers):
        return []

    # A missing first section marker is repaired only on a short heading that
    # is immediately followed by substantial prose.  This avoids prefixing an
    # introductory sentence or an arbitrary short line.
    for index in range(second_index - 1, -1, -1):
        text = texts[index]
        if not text or len(text) > 30 or re.search(r"[。；;！？!?]$", text):
            continue
        if label_value(text)[0] or "立场文件" in text or "position paper" in text.lower():
            continue
        next_text = next((texts[next_index] for next_index in range(index + 1, second_index) if texts[next_index]), "")
        if len(next_text) < 25:
            continue
        confidence = 0.94 if second_index - index <= 3 else 0.72
        if confidence < REPAIR_THRESHOLD:
            # A long first section is still recognizable by its structure: the
            # line before it announces a list ("…概述：") and the "（二）" line
            # is a short heading of the same shape as the candidate.
            previous = next((texts[prior] for prior in range(index - 1, -1, -1) if texts[prior]), "")
            second_heading = POSITION_SECTION_RE.sub("", texts[second_index], count=1).strip()
            if previous.endswith(("：", ":")):
                confidence += 0.12
            if second_heading and len(second_heading) <= 30 and not re.search(r"[。；;！？!?：:]$", second_heading):
                confidence += 0.08
        replacement = f"（一）{text}"
        applied = confidence >= REPAIR_THRESHOLD and _rewrite_text(paragraphs[index], replacement)
        return [RepairAction("立场文件缺失首节序号", index, confidence, text, replacement, applied)]
    return []


def _split_embedded_subclauses(document) -> list[RepairAction]:
    """Split subclauses flattened into one paragraph (shared policy ``embeddedSubclause``)."""

    actions: list[RepairAction] = []
    # Work on a snapshot so reports name the paragraph as numbered in the upload.
    for original_index, paragraph in enumerate(list(body_paragraphs(document))):
        current = paragraph
        position = 0
        while True:
            text = visible_text(current)
            match = _SUBCLAUSE_MARKER_RE.search(text, position)
            if not match:
                break
            marker_start = match.start(3)
            # Tabs and manual line breaks are deliberate visible structure in
            # several valid reference files.  They are not evidence that a
            # marker was accidentally flattened into prose; a later marker in
            # the same paragraph still can be.
            if "\t" in match.group(2) or "\n" in match.group(2):
                position = match.end()
                continue
            keep = len(text[:marker_start].rstrip())
            before = text
            # An automatically numbered clause is a clause even though its
            # marker is not part of the text.
            if not (_CLAUSE_RE.match(text) or active_num_id(current) is not None):
                actions.append(RepairAction(CONTEXT_CODE, original_index, 0.62, before, before, False))
                break
            if not _can_cut(current):
                actions.append(RepairAction(FIELD_CODE, original_index, 0.96, before, before, False))
                break
            marker = match.group(3)
            after = f"{text[:keep]}\n{text[marker_start:]}"
            try:
                if _FIRST_LEVEL_RE.match(marker) and current is paragraph and _ARTICLE_RE.match(text):
                    # First-level subclauses in the reference convention begin
                    # on a new visual line inside the article paragraph.
                    _break_line_before(current, keep, marker_start)
                    position = keep + 1 + len(marker)
                    code = "内嵌一级条款标记"
                else:
                    current = _move_to_new_paragraph(current, keep, marker_start)
                    position = 0
                    code = "内嵌深层条款标记"
            except _Unsplittable:
                actions.append(RepairAction(UNSPLIT_CODE, original_index, 0.96, before, before, False))
                break
            actions.append(RepairAction(code, original_index, 0.96, before, after, True))
    return actions


def _restore_dropped_first_list_item(document) -> list[RepairAction]:
    """Report ambiguity; never infer list membership from appearance alone.

    An unnumbered introduction can have the same indentation and punctuation
    as a damaged first item. Adding it shifts original numbers and references.
    """

    paragraphs = body_paragraphs(document)
    nonempty = [index for index, paragraph in enumerate(paragraphs) if visible_text(paragraph).strip()]
    actions: list[RepairAction] = []
    for position, index in enumerate(nonempty[1:-1], start=1):
        paragraph = paragraphs[index]
        text = visible_text(paragraph).strip()
        if active_num_id(paragraph) is not None or MANUAL_NUMBER_RE.match(text) or not _LIST_ITEM_END_RE.search(text):
            continue
        if not visible_text(paragraphs[nonempty[position - 1]]).strip().endswith(("：", ":")):
            continue
        following = paragraphs[nonempty[position + 1]]
        num_id = active_num_id(following)
        if num_id is None:
            continue
        level = following._p.pPr.numPr.ilvl
        level = level.val if level is not None else 0
        earlier = next(
            (paragraphs[prior] for prior in range(index - 1, -1, -1) if active_num_id(paragraphs[prior]) == num_id),
            None,
        )
        if earlier is not None:
            earlier_level = earlier._p.pPr.numPr.ilvl
            if (earlier_level.val if earlier_level is not None else 0) >= level:
                continue
        actions.append(RepairAction("自动编号首项疑似丢失，保留原条号及交叉引用", index, 0.5, text, text, False))
    return actions


# Run children that contribute visible text, as python-docx's Run.text reads them.
_RUN_TEXT_TAGS = frozenset(qn(tag) for tag in ("w:t", "w:tab", "w:br", "w:cr", "w:noBreakHyphen", "w:ptab"))
# Inline wrappers a split may cut through; the cut copies the wrapper.  A link
# or a tracked change is not cut: a copied hyperlink or revision is new
# structure the repair check refuses, which withheld the whole document.  The
# paragraph is kept as written and reported, as the browser engine does.
_SPLITTABLE = frozenset(qn(tag) for tag in ("w:smartTag", "w:customXml"))
UNSPLIT_CODE = "内嵌条款标记（位于链接或修订中，未拆分）"
CONTEXT_CODE = "内嵌条款标记（所在段落不是条款，未拆分）"
FIELD_CODE = "内嵌条款标记（段落含域或内容控件，未拆分）"
# Wrappers whose content is not shown.
_NOT_SHOWN = frozenset(qn(tag) for tag in ("w:del", "w:moveFrom"))


class _Unsplittable(Exception):
    """The split point falls inside a link, a tracked change or another wrapper that is not copied."""


def _visible_length(element) -> int:
    if element.tag == qn("w:r"):
        return sum(len(str(child)) for child in element if child.tag in _RUN_TEXT_TAGS)
    if element.tag in _NOT_SHOWN:
        return 0
    return sum(_visible_length(child) for child in element if child.tag not in (qn("w:pPr"), qn("w:rPr")))


def _split_run(run, offset: int):
    """Cut a run at ``offset``; the second half becomes a new run right after it."""

    tail = OxmlElement("w:r")
    properties = run.find(qn("w:rPr"))
    if properties is not None:
        tail.append(deepcopy(properties))
    position = 0
    moving = False
    for child in list(run):
        if child.tag == qn("w:rPr"):
            continue
        if moving:
            tail.append(child)
            continue
        length = len(str(child)) if child.tag in _RUN_TEXT_TAGS else 0
        if position + length <= offset:
            position += length
            if position == offset:
                moving = True
            continue
        # The cut falls inside this text node.
        cut = offset - position
        rest = OxmlElement("w:t")
        rest.text = (child.text or "")[cut:]
        rest.set(qn("xml:space"), "preserve")
        child.text = (child.text or "")[:cut]
        child.set(qn("xml:space"), "preserve")
        tail.append(rest)
        moving = True
    run.addnext(tail)
    return tail


def _split_at(parent, offset: int) -> int:
    """Make a child boundary at visible ``offset``; return the first child index after it."""

    position = 0
    for child in list(parent):
        if child.tag in (qn("w:pPr"), qn("w:rPr")):
            continue
        if position == offset:
            return parent.index(child)
        length = _visible_length(child)
        if position < offset < position + length:
            if child.tag == qn("w:r"):
                tail = _split_run(child, offset - position)
            elif child.tag in _SPLITTABLE:
                tail = child.makeelement(child.tag, dict(child.attrib))
                index = _split_at(child, offset - position)
                for moving in list(child)[index:]:
                    tail.append(moving)
                if tail.get(qn("w:id")) is not None:
                    tail.set(qn("w:id"), str(_next_revision_id(parent)))
                child.addnext(tail)
            else:
                raise _Unsplittable(child.tag)
            return parent.index(tail)
        position += length
    return len(parent)


def _next_revision_id(element) -> int:
    root = element.getroottree().getroot()
    used = [int(node.get(qn("w:id"))) for node in root.iter() if (node.get(qn("w:id")) or "").isdigit()]
    return max(used, default=0) + 1


def _run_plain_text(run) -> str:
    return "".join(child.text or "" for child in run if child.tag == qn("w:t"))


_UNCUTTABLE = frozenset(qn(tag) for tag in ("w:fldChar", "w:instrText", "w:fldSimple", "w:sdt"))


def _can_cut(paragraph) -> bool:
    """Fields and content controls span runs in ways a text cut would break."""

    return not any(node.tag in _UNCUTTABLE for node in paragraph._p.iter())


def _cut_at_resume(paragraph, keep: int, resume_at: int) -> int:
    """Cut at ``keep`` and at ``resume_at``, dropping plain whitespace between.

    Returns the child index where the text resumed at ``resume_at`` starts.
    Only whitespace-only text runs without hidden or struck marks are
    removed; anything else between the cuts (a bookmark, a wrapper) stays.
    """

    p = paragraph._p
    _split_at(p, resume_at)
    middle = _split_at(p, keep)
    resume = _split_at(p, resume_at)
    children = list(p)
    resumed = children[resume] if resume < len(children) else None
    for child in children[middle:resume]:
        # Hidden or struck whitespace is the author's mark, not separator noise.
        if (child.tag == qn("w:r") and all(item.tag in (qn("w:rPr"), qn("w:t")) for item in child)
                and not _run_plain_text(child).strip() and not any(run_has(child, tag) for tag in SEMANTIC_MARKS)):
            p.remove(child)
    return p.index(resumed) if resumed is not None else len(p)


def _break_line_before(paragraph, keep: int, resume_at: int) -> None:
    """Start the text at ``resume_at`` on a new line of the same paragraph, in place."""

    index = _cut_at_resume(paragraph, keep, resume_at)
    p = paragraph._p
    anchor = next((child for child in reversed(list(p)[:index]) if child.tag == qn("w:r")), None)
    line_break = OxmlElement("w:r")
    if anchor is not None and anchor.find(qn("w:rPr")) is not None:
        line_break.append(deepcopy(anchor.find(qn("w:rPr"))))
    line_break.append(OxmlElement("w:br"))
    p.insert(index, line_break)


def _move_to_new_paragraph(paragraph, keep: int, resume_at: int):
    """Move the text from ``resume_at`` on into a new paragraph right after this one."""

    index = _cut_at_resume(paragraph, keep, resume_at)
    p = OxmlElement("w:p")
    if paragraph._p.pPr is not None:
        p.append(deepcopy(paragraph._p.pPr))
        # The split-off text is a deeper subclause: neither the parent's list
        # membership nor its indentation applies to it.
        for tag in ("w:numPr", "w:ind"):
            for node in list(p.iter(qn(tag))):
                node.getparent().remove(node)
        # A section break belongs to the paragraph that ends the section, now
        # the new one; a copy left behind would start an extra section.
        section = paragraph._p.pPr.find(qn("w:sectPr"))
        if section is not None:
            paragraph._p.pPr.remove(section)
    for child in list(paragraph._p)[index:]:
        if child.tag == qn("w:pPr"):
            continue
        p.append(child)
    paragraph._p.addnext(p)
    invalidate_paragraph_cache()
    return Paragraph(p, paragraph._parent)


def _rewrite_text(paragraph, text: str) -> bool:
    """Change a paragraph's text, editing in place where possible.

    Inserting a missing label or section marker only touches the first text
    node, so links, revisions and the author's run formatting survive.  A
    plain paragraph that cannot be edited that way is rebuilt; anything else
    is left alone.
    """

    stripped = visible_text(paragraph).strip()
    leading = len(visible_text(paragraph)) - len(visible_text(paragraph).lstrip())
    target = visible_text(paragraph)[:leading] + text + visible_text(paragraph)[leading + len(stripped):]
    backup = deepcopy(paragraph._p)
    before = content_guard.signature(paragraph._p)
    if edit_visible_text(paragraph, target):
        if content_guard.rewrite_keeps_structure("repair", before, content_guard.signature(paragraph._p)):
            return True
        # The inserted label or marker landed inside a tracked revision (or
        # moved text across a link): restore in place and skip the repair.
        for child in list(paragraph._p):
            paragraph._p.remove(child)
        for child in list(backup):
            paragraph._p.append(child)
        invalidate_paragraph_cache()
        return False
    if has_complex_content(paragraph):
        return False
    _replace_paragraph_text(paragraph, text)
    return True


def _replace_paragraph_text(paragraph, text: str) -> None:
    if has_complex_content(paragraph):
        raise ValueError("结构修复段落包含图片、域或书签，已中止以保护内容。")
    inherited_rpr = None
    for run in paragraph.runs:
        if run.text:
            inherited_rpr = deepcopy(run._r.rPr) if run._r.rPr is not None else None
            break
    paragraph.clear()
    run = paragraph.add_run(text)
    if inherited_rpr is not None:
        run._r.insert(0, inherited_rpr)
