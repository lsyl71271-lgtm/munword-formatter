"""The last formatting step: lay every paragraph out as the handbook samples do.

The document-type formatters recognize roles, repair structure, number
clauses and protect content.  This pass then gives each role exactly the
geometry, emphasis, punctuation and blank lines measured from the handbook
(``handbook.py``), so the final layout does not depend on what the source
happened to look like.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass

from docx.document import Document as DocumentObject
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph

from ..docx_view import active_num_id, carries_hidden_structure, invalidate as invalidate_paragraph_cache
from ..docx_view import flow_paragraph_elements, holds_inline_object, visible_runs, visible_text
from ..errors import ProtectedContentError
from ..fonts import rpr_child
from ..models import IntermediateDocument
from ..ooxml_edit import SEMANTIC_MARKS, carries_semantic_marks, has_complex_content, removes_marked_text, run_has, style_text_range
from ..parser import (
    MANUAL_NUMBER_RE,
    PAREN_DIGIT_RE,
    DocxParser,
    handbook_list_indents,
    infer_level,
    opens_or_continues_list,
    paren_token,
)
from ..semantic_policy import OPERATIVE_EN, OPERATIVE_ZH, PREAMBLE_EN, PREAMBLE_ZH, label_value, title_parts
from . import handbook
from .handbook import HandbookSpec, spec_for
from ..dr_numbering import apply_native_rules, marker_of, marker_text, native_family, native_level, native_range_reason, plan_hierarchy
from ..content_guard import signature

HEADER_ROLES = ("title", "committee", "topic", "country", "delegate", "sponsors", "signatories", "header")
BODY_ROLES = ("preamble", "item", "prose", "reference")
_LABEL_RE = re.compile(r"^(\s*[^:：]{1,20}[:：])")
# Position-paper proposals: "1、" / "1." at level 0, "a)" at level 1, "i)" at level 2.
_PP_LEVEL_RES = (
    re.compile(r"^\s*\d+\s*[.、．)]"),
    re.compile(r"^\s*(?:[a-h]|[j-u]|[w-z])\s*[.)]", re.I),
    re.compile(r"^\s*[ivx]+\s*[.)]", re.I),
)
_BARE_ARTICLE_RE = re.compile(r"\s*第[一二三四五六七八九十百]+条\s*")
_ENDING_PUNCTUATION = "，,；;。.:：、"
_OPERATIVE_TYPES = ("draft-directive", "draft-resolution")
_PARAGRAPH_CLEAN_TAGS = ("pStyle", "bidi", "textDirection", "shd", "pBdr", "framePr", "contextualSpacing", "snapToGrid", "tabs", "outlineLvl", "textAlignment")
_KEEP_WITH_NEXT_ROLES = ("title", "committee", "topic", "country", "delegate", "sponsors", "signatories", "header", "subject", "part")
# Copy-paste damage a list marker must not keep.
# A hidden list number stays hidden (Word hides heading numbers this way).
_MARKER_NOISE_TAGS = ("strike", "dstrike", "shd", "highlight", "position", "spacing", "w", "caps", "smallCaps", "color")

_CN_DIGITS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def _chinese_number(text: str) -> int | None:
    """一 … 九十九 (and 百) as an integer."""

    if text == "百":
        return 100
    if "十" in text:
        tens, _, ones = text.partition("十")
        value = (_CN_DIGITS.get(tens, 0) if tens else 1) * 10 + (_CN_DIGITS.get(ones, 0) if ones else 0)
        return value if (not tens or tens in _CN_DIGITS) and (not ones or ones in _CN_DIGITS) else None
    return _CN_DIGITS.get(text)


def _series(alphabet: str):
    return lambda value: alphabet.index(value) + 1 if value in alphabet else None


# Typed clause-number series checked for gaps, most specific first.
_SEQUENCES = (
    ("article", re.compile(r"^\s*(?:第)([一二三四五六七八九十百]+)条"), _chinese_number),
    ("zodiac", re.compile(r"^\s*[（(]([子丑寅卯辰巳午未申酉戌亥])[）)]"), _series("子丑寅卯辰巳午未申酉戌亥")),
    ("stem", re.compile(r"^\s*[（(]([甲乙丙丁戊己庚辛壬癸])[）)]"), _series("甲乙丙丁戊己庚辛壬癸")),
    ("paren-chinese", re.compile(r"^\s*[（(]([一二三四五六七八九十]+)[）)]"), _chinese_number),
    ("paren-decimal", re.compile(r"^\s*[（(](\d{1,2})[）)]"), int),
    ("decimal", re.compile(r"^\s*(\d{1,3})[.、．)）]"), int),
    ("paren-letter", re.compile(r"^\s*[（(]([a-hj-uw-z])[）)]"), _series("abcdefghjklmnopqrstuwxyz")),
    ("letter", re.compile(r"^\s*([a-hj-uw-z])[.)）]"), _series("abcdefghjklmnopqrstuwxyz")),
)


@dataclass
class Block:
    paragraph: Paragraph
    role: str
    level: int = 0
    group: str = ""
    operative: bool = False
    uncertain_numbering: bool = False

    @property
    def attached(self) -> bool:
        return self.paragraph._p.getparent() is not None


def _twips(points: float) -> str:
    return str(int(round(points * 20)))


class HandbookPassMixin:
    """Mixed into ``BaseFormatter``; relies on its run-formatting helpers."""

    def _apply_handbook(self, document: DocumentObject, model: IntermediateDocument, normalize_punctuation: bool) -> None:
        spec = spec_for(self.document_type, model.language)
        blocks = self._handbook_blocks(model, spec)
        apply_numbering = self._resolution_numbering(document, blocks, model.language)
        self._handbook_header_text(blocks, spec, model)
        if normalize_punctuation and spec.clause_punctuation:
            self._handbook_punctuation(blocks, model.language)
        apply_numbering()
        for block in blocks:
            self._handbook_geometry(block, spec, model.language)
            self._handbook_emphasis(block, spec, model.language)
        if spec.signature_lines:
            blocks = self._signature_lines(blocks, spec, model)
        self._handbook_numbering_markers(document, model.language)
        self._numbering_continuity(blocks, model)
        self._normalize_blank_lines(document, blocks, spec, model.language)

    def _resolution_numbering(self, document, blocks, language):
        if self.document_type != 'draft-resolution':
            return lambda: None
        try:
            xml = document.part.part_related_by(RT.NUMBERING).element
        except KeyError:
            xml = None
        def membership(p):
            identifier = active_num_id(p)
            if identifier is None:
                return None
            ilvl = p._p.pPr.numPr.ilvl
            return identifier, str(ilvl.val if ilvl is not None else 0)
        items = []
        for block in blocks:
            text = visible_text(block.paragraph)
            active = membership(block.paragraph)
            marker = marker_of(text, language == 'en' and block.level >= 2) if block.role == 'item' else None
            family = marker['family'] if marker else native_family(xml,*active) if block.role == 'item' and active and xml is not None else ''
            items.append(dict(text=text,family=family,value=marker['value'] if marker else None,level=block.level,
                              key=':'.join(active) if active else None,top=family == 'article' or family == 'decimal' and not text.strip().startswith(('（','(')) and block.level == 0))
        plan = plan_hierarchy(items,language)
        def uncertain(index):
            blocks[index].uncertain_numbering = True
            blocks[index].level = items[index]['level']
            if index and items[index-1]['text'].rstrip().endswith(('：',':')):
                blocks[index-1].uncertain_numbering = True
        rewrites, candidates = [], {}
        notes = self._dr_numbering_notes
        def unsafe(p):
            return any(t[0] != 't' for t in signature(p._p)) or carries_semantic_marks(p)
        for index, (block, item, decision) in enumerate(zip(blocks,items,plan)):
            paragraph = block.paragraph
            active = membership(paragraph)
            number = self._source_number(paragraph)
            if not item['family']:
                if block.role == 'item':
                    uncertain(index)
                    notes.append(f'第 {number} 段：编号类型无法可靠识别，保留原样，请人工确认。')
                continue
            if decision['reason']:
                uncertain(index)
                notes.append(f"第 {number} 段：{decision['reason']}，保留原编号，请人工确认。")
                continue
            marker = marker_of(item['text'], language == 'en' and block.level >= 2)
            if marker and active:
                uncertain(index)
                notes.append(f'第 {number} 段：同时含手打与原生编号，保留原样，请人工确认。')
                continue
            block.level = decision['level']
            if marker:
                target = marker_text(language,block.level,marker['value'])
                if target and item['text'][:marker['length']].strip() != target:
                    if unsafe(paragraph):
                        uncertain(index)
                        self._protect(paragraph,'编号段含链接、域、修订、隐藏或其他复杂结构，未自动转换编号')
                        continue
                    rewrites.append((block,marker))
            elif active and xml is not None:
                key = ':'.join(active)
                candidate = candidates.setdefault(key,dict(rule=dict(id=active[0],ilvl=active[1],level=block.level,language=language),blocks=[],levels=set()))
                candidate['blocks'].append(block)
                candidate['levels'].add(block.level)
        for key, candidate in candidates.items():
            selected = {b.paragraph._p for b in candidate['blocks']}
            outside = any(membership(p) and ':'.join(membership(p)) == key and p._p not in selected for p in self._source_paragraphs)
            # Headers, notes, tables, revisions and text boxes must not inherit
            # an instance override intended only for operative clauses.
            for part in document.part.package.parts:
                if not re.fullmatch(r'/word/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml',str(part.partname)):
                    continue
                root = getattr(part,'element',None)
                if root is None:
                    from lxml import etree
                    root = etree.fromstring(part.blob,etree.XMLParser(resolve_entities=False,no_network=True))
                for p in root.iter(qn('w:p')):
                    if p in selected:
                        continue
                    num = p.find('./'+qn('w:pPr')+'/'+qn('w:numPr'))
                    if num is not None and native_family(xml, candidate['rule']['id'],candidate['rule']['ilvl']):
                        identifier, level = num.find(qn('w:numId')), num.find(qn('w:ilvl'))
                        if identifier is not None and (identifier.get(qn('w:val'))+':'+(level.get(qn('w:val')) if level is not None else '0')) == key:
                            outside = True
            if outside or len(candidate['levels']) != 1 or any(unsafe(b.paragraph) for b in candidate['blocks']):
                for b in candidate['blocks']:
                    uncertain(blocks.index(b))
                notes.append(f'原生列表 {key} 的用途或层级存在冲突/受保护内容，未转换，请人工确认。')
                continue
            rule = candidate['rule']
            lvl = native_level(xml,rule['id'],rule['ilvl'])
            if lvl is None or lvl.find(qn('w:numFmt')) is None or lvl.find(qn('w:lvlText')) is None or lvl.find(qn('w:isLgl')) is not None or ''.join(re.findall(r'%[1-9]',lvl.find(qn('w:lvlText')).get(qn('w:val'),''))) != '%'+str(int(rule['ilvl'])+1):
                for b in candidate['blocks']:
                    uncertain(blocks.index(b))
                notes.append(f'原生列表 {key} 使用复合编号或定义不完整，未转换，请人工确认。')
                continue
            range_reason = native_range_reason(xml,rule,len(candidate['blocks']))
            if range_reason:
                for b in candidate['blocks']:
                    uncertain(blocks.index(b))
                notes.append(f'原生列表 {key}：{range_reason}，保留原编号，请人工确认。')
                continue
            self._dr_numbering_rules.append(rule)
        def apply():
            for block, marker in rewrites:
                p = block.paragraph
                old = visible_text(p)
                target = marker_text(language,block.level,marker['value'])
                if self._rewrite_logged(p,target+old[marker['length']:],language,'dr-marker'):
                    notes.append(f"第 {self._source_number(p)} 段：编号“{old[:marker['length']].strip()}” → “{target}”，序号数值不变。")
            if xml is not None and self._dr_numbering_rules:
                from lxml import etree
                before = etree.tostring(xml)
                apply_native_rules(xml,self._dr_numbering_rules)
                if before != etree.tostring(xml):
                    notes.append('按父子层级纠正原生决议编号样式；保留列表标识、序号、起始值与重启规则。')
        return apply

    # ----------------------------------------------------------- header text

    def _handbook_header_text(self, blocks: list[Block], spec: HandbookSpec, model: IntermediateDocument) -> None:
        """Title word and header labels as printed in the samples.

        The title keeps its own number ("友好修正案 1.2.1" → "修正案 1.2.1");
        committee and topic lines lose their "委员会：/议题：" labels where the
        sample prints them without one.
        """

        for block in blocks:
            paragraph = block.paragraph
            text = visible_text(paragraph).strip()
            if block.role == "title":
                # A title confirmed in step 03 supplies the number; the title
                # word is always the handbook's.
                source = model.title if "title" in self._changed_fields else text
                parts = title_parts(source, self.document_type)
                if parts:
                    target = handbook.output_title(self.document_type, model.language) + parts[1]
                    if "title" in self._changed_fields and target != text:
                        if not self._rewrite_logged(paragraph, target, model.language, "field", "title"):
                            raise ProtectedContentError(
                                self._source_number(paragraph), "第 03 步修改了标题，但标题含链接、域、修订、隐藏或删除线文字，不能安全改写"
                            )
                    elif target != text:
                        self._rewrite_logged(paragraph, target, model.language, "title")
            elif block.role in ("committee", "topic") and spec.committee_topic_labels == "drop":
                key, value = label_value(text)
                if key in ("committee", "topic") and value:
                    if removes_marked_text(paragraph, value):
                        # Dropping the label would delete hidden or struck words.
                        self._protect(paragraph, "委员会/议题标签含隐藏或删除线文字，未按范例删除标签")
                    else:
                        self._rewrite_logged(paragraph, value, model.language, "label-drop")

    # -------------------------------------------------------- numbering check

    def _numbering_continuity(self, blocks: list[Block], model: IntermediateDocument) -> None:
        """Warn where typed clause numbers skip or repeat; never renumber.

        Typed numbers are the author's and may be cited elsewhere ("第五条"),
        so a gap is reported for a person to decide, not filled in.  A
        sequence may restart at 1 under a new parent, or continue across
        parents as the handbook's resolution sample does (页42 "第五条" is
        followed by "（五）").
        """

        last: dict[str, int] = {}
        findings: list[str] = []
        for block in blocks:
            if block.role not in ("item", "prose", "preamble") or not block.attached:
                continue
            text = visible_text(block.paragraph)
            for name, pattern, value_of in _SEQUENCES:
                match = pattern.match(text)
                if not match:
                    continue
                value = value_of(match.group(1))
                if value is None:
                    break
                previous = last.get(name)
                if previous is not None and value != 1 and value != previous + 1:
                    number = self._source_number(block.paragraph)
                    findings.append(f"第 {number} 段“{match.group(0).strip()}”（前一个为第 {previous} 项）")
                last[name] = value
                break
        if findings:
            model.warnings.append("编号不连续，已保留原文、未自动改号，请确认：" + "；".join(findings[:8]) + ("……" if len(findings) > 8 else ""))

    def _source_number(self, paragraph: Paragraph) -> int:
        """1-based place of ``paragraph`` in the source, 0 for a new one."""

        element = paragraph._p
        return next((number for number, item in enumerate(self._source_paragraphs or (), 1) if item._p is element), 0)

    # ---------------------------------------------------------------- roles

    def _handbook_blocks(self, model: IntermediateDocument, spec: HandbookSpec) -> list[Block]:
        paragraphs = self._source_paragraphs
        texts = [visible_text(paragraph).strip() for paragraph in paragraphs]
        roles: dict[int, Block] = {}

        def assign(index, role, **extra):
            if index is not None and 0 <= index < len(paragraphs) and texts[index]:
                roles[index] = Block(paragraphs[index], role, **extra)

        title = next(
            (index for index, text in enumerate(texts[:40]) if text and (text == model.title or self._title_matches(text))),
            None,
        )
        assign(title, "title")
        for key in ("committee", "topic", "country", "delegate"):
            assign(model.header_paragraph_indices.get(key), key)
        for key in ("sponsors", "signatories"):
            for position, index in enumerate(model.metadata_paragraph_indices.get(key, [])):
                assign(index, key if position == 0 else "header", group=key)
        if title is not None:
            # Unlabeled lines between the title and the first labeled field
            # are the committee and the topic, in that order (页38, 页52–53).
            first_field = min((index for index, block in roles.items() if block.role != "title"), default=None)
            used = {block.role for block in roles.values()}
            free = [key for key in ("committee", "topic") if key not in used]
            for index in range(title + 1, first_field if first_field is not None else title + 1):
                if free and texts[index] and index not in roles:
                    assign(index, free.pop(0))
        header_end = max(list(roles) + [-1]) + 1

        operative_types = self.document_type in _OPERATIVE_TYPES or "amendment" in self.document_type
        references = self._reference_index(texts, header_end)
        for index in range(references if references is not None else len(texts), len(texts)):
            assign(index, "reference")
        for clause in sorted(
            model.body_clauses + model.preambulatory_clauses + model.operative_clauses,
            key=lambda item: item.paragraph_index,
        ):
            index = clause.paragraph_index
            if index in roles or index >= len(paragraphs):
                continue
            if clause.kind == "heading":
                committee_line = DocxParser._is_committee_subject(texts[index], model.committee, model.language)
                if committee_line and spec.subject is not None:
                    assign(index, "subject")
                elif committee_line:
                    # No subject line in this sample (working papers, amendments):
                    # an ordinary paragraph, not a bold heading.
                    assign(index, "prose", operative=False)
                else:
                    assign(index, "part")
            elif clause.kind == "preambulatory" and self.document_type == "draft-resolution":
                # Only resolutions have preambulatory clauses; elsewhere a
                # clause starting with "支持" / "Noting" is an ordinary one.
                assign(index, "preamble")
            else:
                level = self._list_level(paragraphs[index], texts[index], clause.level)
                if level is not None:
                    assign(index, "item", level=level, operative=operative_types)
                else:
                    assign(index, "prose", level=clause.level, operative=operative_types and clause.kind == "operative")

        previous_level = 0
        indents = handbook_list_indents(self.document_type, model.language)
        in_list = False
        previous_token = None
        previous_paren_digit = False
        for index, text in enumerate(texts):
            if not text and index not in roles and carries_hidden_structure(paragraphs[index]):
                # A picture, formula, page break or bookmark on its own line is
                # kept: handbook geometry, and a minimum pitch around objects.
                roles[index] = Block(paragraphs[index], "object")
                continue
            if not text:
                continue
            if index in roles:
                block = roles[index]
                in_list = block.role == "item" or text.endswith(("：", ":"))
                previous_token = paren_token(text) or previous_token
                previous_paren_digit = bool(PAREN_DIGIT_RE.match(text))
                continue
            if index < header_end:
                assign(index, "header")
                continue
            previous_level = infer_level(
                text, paragraphs[index], previous_level, in_list=in_list, indents=indents,
                previous_token=previous_token, previous_paren_digit=previous_paren_digit,
            )
            in_list = opens_or_continues_list(text, paragraphs[index], previous_level)
            previous_token = paren_token(text) or previous_token
            previous_paren_digit = bool(PAREN_DIGIT_RE.match(text))
            level = self._list_level(paragraphs[index], text, previous_level)
            if level is None:
                assign(index, "prose", level=previous_level)
            else:
                assign(index, "item", level=level, operative=operative_types)
        self._nest_unmarked_items(roles, texts)
        return [roles[index] for index in sorted(roles)]

    def _nest_unmarked_items(self, roles: dict[int, Block], texts: list[str]) -> None:
        """Level of list items that carry Word numbering but no typed marker.

        Typed markers ("（子）", "(a)") fix their level.  A list numbered only
        by Word that starts right after a clause ending in a colon is that
        clause's subclauses, and every later item of the same list and list
        level stays at that level.  Otherwise a numbered list under "（丑）…：" came out
        shallower than its own parent.
        """

        list_levels: dict[tuple[str, int], int] = {}
        parent_level: int | None = None
        parent_key: tuple[str, int] | None = None
        for index in sorted(roles):
            block = roles[index]
            if block.role != "item":
                parent_level = parent_key = None
                continue
            num_id = active_num_id(block.paragraph)
            key = None
            if num_id is not None:
                ilvl = block.paragraph._p.pPr.numPr.ilvl
                key = (num_id, int(ilvl.val) if ilvl is not None and ilvl.val is not None else 0)
            if key is not None and not MANUAL_NUMBER_RE.match(texts[index]):
                if key in list_levels:
                    block.level = list_levels[key]
                elif parent_level is not None and key != parent_key:
                    # The next item of the clause's own list and level is its
                    # sibling: a colon alone does not prove subclauses exist.
                    block.level = parent_level + 1
                    list_levels[key] = block.level
            opens = texts[index].endswith(("：", ":"))
            parent_level = block.level if opens else None
            parent_key = key if opens else None

    def _list_level(self, paragraph: Paragraph, text: str, level: int) -> int | None:
        """The list level of ``paragraph``, or ``None`` when it is not a list item."""

        if self.document_type == "position-paper":
            # Position papers type their markers: "1、" / "1." then "a)" (页16, 页18).
            return next((number for number, pattern in enumerate(_PP_LEVEL_RES) if pattern.match(text)), None)
        if level > 0 or active_num_id(paragraph) is not None or MANUAL_NUMBER_RE.match(text):
            return level
        return None

    def _reference_index(self, texts: list[str], start: int) -> int | None:
        if self.document_type != "position-paper":
            return None
        from .position_paper import REFERENCE_START_RE

        return next((index for index in range(start, len(texts)) if REFERENCE_START_RE.match(texts[index])), None)

    # ------------------------------------------------------------- geometry

    def _handbook_geometry(self, block: Block, spec: HandbookSpec, language: str) -> None:
        paragraph = block.paragraph
        if not block.attached:
            return
        ppr = paragraph._p.get_or_add_pPr()
        # The handbook decides a paragraph's look: its style, borders,
        # shading, custom tab stops and outline level go (shared policy).
        for tag in _PARAGRAPH_CLEAN_TAGS:
            for node in ppr.findall(qn(f"w:{tag}")):
                ppr.remove(node)
        fmt = paragraph.paragraph_format
        fmt.page_break_before = False
        fmt.keep_together = False
        fmt.keep_with_next = block.role in _KEEP_WITH_NEXT_ROLES
        self._apply_pitch(paragraph, self._block_pitch(block, language))
        paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT if block.role == "title" else WD_ALIGN_PARAGRAPH.JUSTIFY
        # Every source attribute goes first: character-unit indents
        # (leftChars, hangingChars, ...) take precedence over twips in Word.
        ind = ppr.get_or_add_ind()
        ind.attrib.clear()
        ind.set(qn("w:right"), "0")
        if block.role == "item":
            indent = spec.list_indents[min(block.level, len(spec.list_indents) - 1)]
            ind.set(qn("w:left"), _twips(indent.left))
            if indent.hanging:
                ind.set(qn("w:hanging"), _twips(indent.hanging))
            else:
                ind.set(qn("w:firstLine"), _twips(indent.first_line))
        else:
            ind.set(qn("w:left"), "0")
            ind.set(qn("w:firstLine"), _twips(spec.prose_first_line if block.role == "prose" else 0))

    def _block_pitch(self, block: Block, language: str) -> float:
        if block.role == "preamble":
            role = "preamble"
        elif block.group or block.role in ("sponsors", "signatories"):
            role = "signature"
        else:
            role = "body"
        return handbook.role_pitch(self.document_type, language, role)

    @staticmethod
    def _apply_pitch(paragraph: Paragraph, pitch: float) -> None:
        """The handbook's baseline distance: exact for text, a minimum around objects.

        An exact line height clips an inline picture, text box or formula
        taller than the line, so such a paragraph gets the same value as a
        minimum instead (shared policy ``handbook.lineSpacing.rule``).
        """

        # Autospacing and line-unit spacing take precedence over the values.
        spacing = paragraph._p.get_or_add_pPr().get_or_add_spacing()
        spacing.attrib.clear()
        spacing.set(qn("w:before"), "0")
        spacing.set(qn("w:after"), "0")
        spacing.set(qn("w:line"), _twips(pitch))
        spacing.set(qn("w:lineRule"), "atLeast" if holds_inline_object(paragraph._p) else "exact")

    # ------------------------------------------------------------- emphasis

    def _handbook_emphasis(self, block: Block, spec: HandbookSpec, language: str) -> None:
        paragraph = block.paragraph
        if block.attached and block.role == "object":
            # A page break or picture line: no emphasis on its spaces.
            self._format_runs(paragraph, language, bold=False, italic=False, underline=False)
            return
        if not block.attached or not visible_text(paragraph).strip():
            return
        role = block.role
        if role == "title":
            # The output title is already written as printed ("DRAFT
            # RESOLUTION"); a caps property left by the source is cleared.
            self._format_runs(paragraph, language, bold=True, italic=False, underline=False)
            for run in visible_runs(paragraph):
                run.font.all_caps = None
        elif role in ("committee", "topic", "country", "delegate") or (role == "header" and not block.group):
            if spec.header_fields == "bold":
                self._format_runs(paragraph, language, bold=True, italic=False, underline=False)
            else:
                self._style_labeled_paragraph(paragraph, role, language, value_emphasis=False, value_bold=False)
        elif role in ("sponsors", "signatories"):
            self._style_labeled_paragraph(paragraph, role, language, value_emphasis=True)
            label = re.match(r"^(\s*[^:：]{1,20}[:：]\s*)", visible_text(paragraph))
            if label:
                style_text_range(paragraph, 0, label.end(), bold=True, italic=spec.country_label_italic, underline=False)
        elif role == "header":
            self._format_runs(paragraph, language, bold=True, italic=True, underline=False)
        elif role == "subject":
            bold, italic = spec.subject or (True, False)
            self._format_runs(paragraph, language, bold=bold, italic=italic, underline=False)
        elif role == "part":
            self._format_runs(paragraph, language, bold=True, italic=False, underline=False)
        elif role in ("preamble", "item", "prose"):
            if spec.clear_clause_emphasis:
                self._format_runs(paragraph, language, bold=False, italic=False, underline=False)
            if role == "preamble" and spec.preamble_verb_underline:
                self._emphasize_verb(paragraph, PREAMBLE_ZH if language == "zh" else PREAMBLE_EN, language, underline=True)
            elif block.operative and block.level == 0 and spec.top_level_verb_italic:
                self._emphasize_verb(paragraph, self._top_level_verbs(language), language, italic=True)

    def _top_level_verbs(self, language: str) -> tuple[str, ...]:
        if "amendment" in self.document_type:
            return handbook.AMENDMENT_VERBS_ZH if language == "zh" else handbook.AMENDMENT_VERBS_EN
        return OPERATIVE_ZH if language == "zh" else OPERATIVE_EN

    @staticmethod
    def _emphasize_verb(paragraph: Paragraph, phrases, language: str, *, italic=None, underline=None) -> bool:
        text = visible_text(paragraph)
        marker = MANUAL_NUMBER_RE.match(text)
        start = marker.end() if marker else len(text) - len(text.lstrip())
        rest = text[start:]
        folded = rest.casefold()
        for phrase in sorted(phrases, key=len, reverse=True):
            if not folded.startswith(phrase.casefold()):
                continue
            end = start + len(phrase)
            if language == "en" and end < len(text) and text[end].isalpha():
                continue
            return style_text_range(paragraph, start, end, italic=italic, underline=underline)
        return False

    # ------------------------------------------------------ signature lines

    def _signature_lines(self, blocks: list[Block], spec: HandbookSpec, model: IntermediateDocument) -> list[Block]:
        """Break each country list between names into lines that fit the page.

        Every line then gets its own empty line to sign in (页41, 页52).  Only
        a list already in the handbook's inline form is broken up; a list kept
        with the author's own separators stays as written.
        """

        language = model.language
        result = list(blocks)
        for key in ("sponsors", "signatories"):
            group = [block for block in blocks if block.group == key and block.attached]
            # The same order the metadata step wrote (sorted unless kept).
            values = self._country_order(list(getattr(model, key)), language)
            if not group or group[0].role != key or not values:
                continue
            expected = self._country_line_text(key, values, language)
            written = "".join(visible_text(block.paragraph) for block in group)
            if re.sub(r"\s+", "", written) != re.sub(r"\s+", "", expected):
                continue
            if any(has_complex_content(block.paragraph) or carries_semantic_marks(block.paragraph) for block in group):
                continue
            lines = _break_country_list(expected[: len(expected) - len(handbook.COUNTRY_SEPARATOR[language].join(values))], values, language)
            if len(lines) == 1 and len(group) == 1:
                continue
            first = group[0].paragraph
            for block in group[1:]:
                block.paragraph.clear()
                self._log_edit(block.paragraph, "countries", key, expected=expected)
            self._log_edit(first, "countries", key, expected=expected)
            added = []
            anchor = first._p
            for number, pieces in enumerate(lines):
                paragraph = first if number == 0 else self._paragraph_after(anchor, first)
                self._write_country_pieces(paragraph, pieces, spec, language, labeled=number == 0)
                if number:
                    self._log_edit(paragraph, "countries", key, expected=expected, new=True)
                anchor = paragraph._p
                if number:
                    added.append(Block(paragraph, "header", group=key))
            position = result.index(group[0]) + 1
            result[position:position] = added
        return result

    @staticmethod
    def _paragraph_after(anchor, template: Paragraph) -> Paragraph:
        element = OxmlElement("w:p")
        if template._p.pPr is not None:
            element.append(copy.deepcopy(template._p.pPr))
        anchor.addnext(element)
        return Paragraph(element, template._parent)

    def _write_country_pieces(self, paragraph: Paragraph, pieces: list[str], spec: HandbookSpec, language: str, *, labeled: bool) -> None:
        paragraph.clear()
        for index, piece in enumerate(pieces):
            run = paragraph.add_run(piece)
            if labeled and index == 0:
                self._format_run(run, language, bold=True, italic=spec.country_label_italic, underline=False)
            else:
                self._format_run(run, language, bold=True, italic=True, underline=False)

    # ---------------------------------------------------------- punctuation

    def _handbook_punctuation(self, blocks: list[Block], language: str) -> None:
        """Clause endings of the resolution and directive samples.

        Preambulatory clauses end with a comma.  An operative clause that
        introduces subclauses ends with a colon, the very last clause with a
        full stop and every other clause with a semicolon (页42–43).
        """

        zh = language == "zh"
        for block in blocks:
            if block.role == "subject":
                self._set_ending(block.paragraph, "，" if zh else ",", language)
            elif block.role == "preamble":
                self._set_ending(block.paragraph, "，" if zh else ",", language)
        clauses = [
            block for block in blocks
            if block.operative and block.role in ("item", "prose")
            and not _BARE_ARTICLE_RE.fullmatch(visible_text(block.paragraph))
        ]
        for position, block in enumerate(clauses):
            if block.uncertain_numbering:
                continue
            following = clauses[position + 1] if position + 1 < len(clauses) else None
            if following is not None and following.level > block.level:
                ending = "：" if zh else ":"
            elif following is None:
                ending = "。" if zh else "."
            else:
                ending = "；" if zh else ";"
            self._set_ending(block.paragraph, ending, language)

    def _set_ending(self, paragraph: Paragraph, ending: str, language: str) -> None:
        text = visible_text(paragraph)
        # Only the final punctuation is replaced: trailing spaces at the very
        # end go, but a space inside the sentence (before a field or a link)
        # stays.  A closing quotation mark or bracket stays too.  Line breaks
        # after the sentence stay after its new ending.
        sentence = text.rstrip(" \t\n")
        breaks = "\n" * text[len(sentence):].count("\n")
        stripped = sentence.rstrip(_ENDING_PUNCTUATION)
        if not stripped.strip():
            return
        if text == stripped + ending + breaks:
            return
        if _ending_in_revision(paragraph._p):
            # Changing punctuation inside a tracked insertion or deletion
            # would rewrite what a reviewer did; leave it for a person.
            self._protect(paragraph, "句末标点位于修订痕迹中，未自动规范")
            return
        tail = _ending_tail(paragraph)
        # Hidden or struck words are not what the reader sees end the sentence.
        if any(run_has(node.getparent(), tag) for node in tail for tag in SEMANTIC_MARKS):
            self._protect(paragraph, "句末文字为隐藏或删除线文字，未自动规范标点")
            return
        container = _ending_container(paragraph._p, tail[0]) if tail else None
        if container is not None:
            # A field result is regenerated by Word and a link's text is the
            # link: punctuation goes after them, nothing inside is changed.
            if text.rstrip("\n") != stripped:
                self._protect(paragraph, "句末位于域结果或超链接中，未自动规范标点")
                return
            source = tail[0].getparent()
            added = OxmlElement("w:r")
            properties = source.find(qn("w:rPr"))
            if properties is not None:
                copy_ = copy.deepcopy(properties)
                for node in copy_.findall(qn("w:rStyle")):
                    copy_.remove(node)
                added.append(copy_)
            node = OxmlElement("w:t")
            node.text = ending
            added.append(node)
            container.addnext(added)
            self._log_edit(paragraph, "ending")
            return
        self._rewrite_logged(paragraph, stripped + ending + breaks, language, "ending")

    # ------------------------------------------------------------ numbering

    def _handbook_numbering_markers(self, document: DocumentObject, language: str) -> None:
        """Every list marker at the body size in the house fonts.

        A marker's look can be set in the list definition (``abstractNum/lvl``)
        and again in a list instance's override (``num/lvlOverride/lvl``); an
        8 pt override made numbers tiny even when the definition was right.
        Both layers are normalized.  Values and meaning — ``start``,
        ``startOverride``, ``lvlRestart``, ``numFmt``, ``lvlText`` — are not
        touched, and a bullet keeps its symbol font.
        """

        try:
            numbering = document.part.part_related_by(RT.NUMBERING).element
        except KeyError:
            return
        abstracts = {node.get(qn("w:abstractNumId")): node for node in numbering.findall(qn("w:abstractNum"))}
        # Every list the document defines, used or not: a list pasted in later
        # must not bring back tiny numbers.
        for abstract in abstracts.values():
            for level in abstract.findall(qn("w:lvl")):
                self._normalize_marker_level(level, level, language)
        for num in numbering.findall(qn("w:num")):
            reference = num.find(qn("w:abstractNumId"))
            abstract = abstracts.get(reference.get(qn("w:val"))) if reference is not None else None
            base_levels = {lvl.get(qn("w:ilvl")): lvl for lvl in abstract.findall(qn("w:lvl"))} if abstract is not None else {}
            for override in num.findall(qn("w:lvlOverride")):
                for level in override.findall(qn("w:lvl")):
                    self._normalize_marker_level(level, base_levels.get(level.get(qn("w:ilvl"))), language)

    def _normalize_marker_level(self, level, base_level, language: str) -> None:
        number_format = level.find(qn("w:numFmt"))
        if number_format is None and base_level is not None:
            number_format = base_level.find(qn("w:numFmt"))
        bullet = number_format is not None and number_format.get(qn("w:val")) == "bullet"
        rpr = level.find(qn("w:rPr"))
        if rpr is None:
            rpr = OxmlElement("w:rPr")
            level.append(rpr)  # rPr is the last child of w:lvl
        for tag in _MARKER_NOISE_TAGS:
            for node in rpr.findall(qn(f"w:{tag}")):
                rpr.remove(node)
        if not bullet:
            self._house_fonts(rpr_child(rpr, "rFonts"), language, complex_script=True)
            for tag in ("b", "bCs", "i", "iCs"):
                rpr_child(rpr, tag).set(qn("w:val"), "0")
            rpr_child(rpr, "u").set(qn("w:val"), "none")
        half_points = str(int(round(handbook.BODY_SIZE_PT * 2)))
        for tag in ("sz", "szCs"):
            rpr_child(rpr, tag).set(qn("w:val"), half_points)

    # ---------------------------------------------------------- blank lines

    def _normalize_blank_lines(self, document: DocumentObject, blocks: list[Block], spec: HandbookSpec, language: str) -> None:
        """Exactly the handbook's empty lines: every other empty paragraph goes."""

        body = document.element.body
        parent = document._body
        for element in flow_paragraph_elements(body):
            paragraph = Paragraph(element, parent)
            container = element.getparent()
            # A content control keeps at least one paragraph.
            if container is not body and len(container) == 1:
                continue
            if not visible_text(paragraph).strip() and not carries_hidden_structure(paragraph):
                # Logged so the content check can confirm it held only
                # whitespace, tabs or line breaks.
                if element not in self._edit_log:
                    self._log_edit_element(element, "empty-line")
                container.remove(element)
        live = [block for block in blocks if block.attached and visible_text(block.paragraph).strip()]
        after: list = []

        def last(predicate):
            return next((block.paragraph._p for block in reversed(live) if predicate(block)), None)

        for role in spec.blank_after:
            if role == "title_block":
                after.append(last(lambda block: block.role in ("title", "committee", "topic")))
            elif role == "header":
                after.append(last(lambda block: block.role in HEADER_ROLES))
            elif role in ("sponsors", "signatories"):
                after.extend(block.paragraph._p for block in live if block.group == role)
            else:
                after.append(last(lambda block, role=role: block.role == role))
        if spec.blank_before_operative:
            first = next((block for block in live if block.operative and block.role in ("item", "prose")), None)
            if first is not None:
                after.append(first.paragraph._p.getprevious())
        if spec.blank_between_prose:
            body_blocks = [block for block in live if block.role in BODY_ROLES + ("part",)]
            for current, following in zip(body_blocks, body_blocks[1:]):
                if current.role == following.role and current.role in ("item", "reference"):
                    continue
                after.append(current.paragraph._p)
        # An empty line has the body pitch, except a signing line under a
        # country name, which is as tall as that name's line (页52).  A blank
        # after the 18 pt preamble is still a 15.5 pt line (页42: 31.5 pt
        # from the last preambulatory line to 第一条).
        pitch_of = {
            id(block.paragraph._p): handbook.role_pitch(self.document_type, language, "signature")
            for block in live if block.group or block.role in ("sponsors", "signatories")
        }
        body_pitch = handbook.body_pitch(self.document_type, language)
        seen = set()
        for element in after:
            if element is None or id(element) in seen or element.getparent() is None:
                continue
            seen.add(id(element))
            blank = self._blank_paragraph(language, pitch_of.get(id(element), body_pitch))
            element.addnext(blank)
            self._log_edit_element(blank, "blank", new=True)
        invalidate_paragraph_cache()

    def _blank_paragraph(self, language: str, pitch: float):
        paragraph = OxmlElement("w:p")
        ppr = OxmlElement("w:pPr")
        spacing = OxmlElement("w:spacing")
        spacing.set(qn("w:before"), "0")
        spacing.set(qn("w:after"), "0")
        spacing.set(qn("w:line"), str(int(round(pitch * 20))))
        spacing.set(qn("w:lineRule"), "exact")
        ppr.append(spacing)
        rpr = OxmlElement("w:rPr")
        fonts = OxmlElement("w:rFonts")
        self._house_fonts(fonts, language, complex_script=True)
        rpr.append(fonts)
        half_points = str(int(round(handbook.BODY_SIZE_PT * 2)))
        for tag in ("w:sz", "w:szCs"):
            size = OxmlElement(tag)
            size.set(qn("w:val"), half_points)
            rpr.append(size)
        ppr.append(rpr)
        paragraph.append(ppr)
        return paragraph


_REVISIONS = frozenset(qn(tag) for tag in ("w:ins", "w:del", "w:moveTo", "w:moveFrom"))


def _ending_tail(paragraph: Paragraph) -> list:
    """Text nodes from the end of the paragraph back to the last one with words in it."""

    nodes = [child for run in visible_runs(paragraph) for child in run._r if child.tag == qn("w:t")]
    tail = []
    for node in reversed(nodes):
        if not node.text:
            continue
        tail.append(node)
        if node.text.rstrip("，,；;。.:：、 \t"):
            break
    return tail


def _field_result_end(paragraph_element, run_element):
    """The run closing the complex field whose result holds ``run_element``, or ``None``."""

    stack: list[str] = []
    inside = False
    for candidate in paragraph_element.iter(qn("w:r")):
        if candidate is run_element:
            inside = "result" in stack
        for mark in candidate.iter(qn("w:fldChar")):
            kind = mark.get(qn("w:fldCharType"))
            if kind == "begin":
                stack.append("code")
            elif kind == "separate" and stack:
                stack[-1] = "result"
            elif kind == "end" and stack:
                stack.pop()
                if inside and not stack:
                    return candidate
    return None


def _ending_container(paragraph_element, node):
    """A field result or link holding ``node``: the element after which new text must go."""

    ancestor = node.getparent()
    while ancestor is not None and ancestor is not paragraph_element:
        if ancestor.tag in (qn("w:hyperlink"), qn("w:fldSimple")):
            return ancestor
        ancestor = ancestor.getparent()
    return _field_result_end(paragraph_element, node.getparent())


def _ending_in_revision(paragraph_element) -> bool:
    """True when the last visible characters of a paragraph sit in a revision."""

    texts = [node for node in paragraph_element.iter(qn("w:t")) if node.text]
    for node in reversed(texts):
        ancestor = node.getparent()
        in_revision = False
        while ancestor is not None and ancestor is not paragraph_element:
            if ancestor.tag in _REVISIONS:
                in_revision = True
                break
            ancestor = ancestor.getparent()
        if in_revision:
            return True
        if node.text.rstrip("，,；;。.:：、 \t"):
            return False
    return False


def _break_country_list(label: str, values: list[str], language: str) -> list[list[str]]:
    """Lines of ``label`` + country names, broken only between names.

    Each line is a list of pieces: the label (first line only) and the
    names, every name but the last followed by the separator.
    """

    separator = handbook.COUNTRY_SEPARATOR[language].rstrip() if language == "en" else handbook.COUNTRY_SEPARATOR[language]
    lines: list[list[str]] = [[label]]
    width = _width_em(label)
    for index, value in enumerate(values):
        piece = value + (separator if index < len(values) - 1 else "")
        lead = " " if language == "en" and width and lines[-1] != [label] else ""
        if len(lines[-1]) > (1 if len(lines) == 1 else 0) and width + _width_em(lead + piece) > handbook.LINE_WIDTH_EM:
            lines.append([piece])
            width = _width_em(piece)
            continue
        lines[-1].append(lead + piece)
        width += _width_em(lead + piece)
    return lines


def _width_em(text: str) -> float:
    """Rough advance width at the body size: CJK 1 em, Latin by letter class."""

    total = 0.0
    for char in text:
        if ord(char) > 0x2E7F:
            total += 1.0
        elif char.isupper():
            total += 0.7
        elif char in " ,.;:'’-()":
            total += 0.3
        else:
            total += 0.5
    return total
