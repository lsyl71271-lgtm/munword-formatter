from __future__ import annotations

import re
from io import BytesIO

from docx import Document
from docx.document import Document as DocumentObject
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml.ns import qn

from .docx_view import active_num_id, body_paragraphs, visible_text
from .models import Clause, DocumentType, IntermediateDocument
from .semantic_policy import DOCUMENT_PROFILES, clause_prefixes, label_value, looks_like_title


ZH_RE = re.compile(r"[\u3400-\u9fff]")
MANUAL_NUMBER_RE = re.compile(
    r"^\s*(?:第[一二三四五六七八九十百]+条|[0-9]+[.、)]|[0-9]+(?=\s{2,})|[a-z][.)）](?=\s|[^\x00-\x7f])|[（(][a-zivx]+[）)]|[（(][一二三四五六七八九十子丑寅卯辰巳午未申酉戌亥甲乙丙丁戊己庚辛壬癸]+[）)])\s*",
    re.I,
)
TOP_LEVEL_NUMBER_RE = re.compile(r"^\s*(?:第[一二三四五六七八九十百]+条|[0-9]+[.、)])", re.I)
PART_RE = re.compile(r"^PART\s+[IVXLC]+\b", re.I)
SCALAR_FIELDS = ("committee", "topic", "country", "delegate")
COUNTRY_FIELDS = ("sponsors", "signatories")
MAX_NESTING_INDENT_PT = 96


def detect_language(text: str) -> str:
    zh_count = len(ZH_RE.findall(text))
    latin_count = len(re.findall(r"[A-Za-z]", text))
    return "zh" if zh_count >= max(2, latin_count // 4) else "en"


def split_countries(value: str) -> list[str]:
    value = re.sub(r"^[^:：]+[:：]\s*", "", value.strip())
    parts = re.split(r"[,，、;；/|\n]+", value)
    return [part.strip() for part in parts if part.strip()]


def strip_manual_number(text: str) -> str:
    return MANUAL_NUMBER_RE.sub("", text, count=1)


def infer_level(text: str, paragraph, previous_level: int = 0) -> int:
    # Visible markers are authoritative.  Committee files often carry stale
    # list metadata after authors manually typed a different marker.
    if re.match(r"^\s*[（(][ivxlcdm]+[）)]", text, re.I):
        return 2 if previous_level >= 1 else 1
    matchers = [
        (r"^\s*(?:第[一二三四五六七八九十百]+条|\d+[.、])", 0),
        (r"^\s*[（(](?:[a-z]|[一二三四五六七八九十]+)[）)]", 1),
        # "a)" / "b." items under a numbered clause (页18, 页37).
        (r"^\s*[a-hj-uw-z][.)）]", 1),
        # "（子子）" nests under "（子）".
        (r"^\s*[（(][子丑寅卯辰巳午未申酉戌亥]{2,3}[）)]", 3),
        (r"^\s*[（(][子丑寅卯辰巳午未申酉戌亥][）)]", 2),
        (r"^\s*(?:[ivxlcdm]+\.|[（(][甲乙丙丁戊己庚辛壬癸]+[）)])", 3),
    ]
    for pattern, level in matchers:
        if re.match(pattern, text, re.I):
            return level
    ppr = paragraph._p.pPr
    if active_num_id(paragraph) is not None:
        semantic = _numbering_semantic_level(paragraph)
        if semantic is not None:
            return semantic
        ilvl = ppr.numPr.ilvl
        if ilvl is not None and ilvl.val is not None:
            return int(ilvl.val)
    left = paragraph.paragraph_format.left_indent
    # An indent beyond the damage threshold (96 pt) is copy-paste noise, not
    # nesting: it would push a top-level clause to the deepest level.
    if left and 0 < left.pt <= MAX_NESTING_INDENT_PT:
        return min(3, max(0, round(left.inches / 0.3)))
    return 0


def _numbering_semantic_level(paragraph) -> int | None:
    """Translate a source list marker into the handbook's semantic levels."""

    ppr = paragraph._p.pPr
    num_id = active_num_id(paragraph)
    if num_id is None:
        return None
    try:
        # ``part.numbering_part`` tries to create a missing numbering part and
        # raises NotImplementedError; a document can reference list numbering
        # without shipping numbering.xml (seen in WPS / online-editor exports).
        numbering = paragraph.part.part_related_by(RT.NUMBERING).element
        num = next(
            item for item in numbering.findall(qn("w:num"))
            if item.get(qn("w:numId")) == num_id
        )
        abstract_id = num.find(qn("w:abstractNumId")).get(qn("w:val"))
        abstract = next(
            item for item in numbering.findall(qn("w:abstractNum"))
            if item.get(qn("w:abstractNumId")) == abstract_id
        )
        source_level = str(ppr.numPr.ilvl.val if ppr.numPr.ilvl is not None else 0)
        level = next(
            item for item in abstract.findall(qn("w:lvl"))
            if item.get(qn("w:ilvl")) == source_level
        )
        marker = level.find(qn("w:lvlText")).get(qn("w:val"))
        number_format = level.find(qn("w:numFmt"))
        number_format = number_format.get(qn("w:val")) if number_format is not None else ""
    except (AttributeError, KeyError, StopIteration, ValueError):
        return None
    # The marker style says which handbook level a Word list level prints.
    if number_format == "ideographZodiac":
        return 2
    if number_format == "ideographTraditional":
        return 3
    if number_format == "lowerRoman":
        return 2 if marker.startswith(("(", "（")) else 3
    if "第%" in marker and "条" in marker:
        return 0
    if marker.startswith(("（%", "(%")):
        return 1
    return int(source_level)


class DocxParser:
    def load(self, content: bytes) -> DocumentObject:
        return Document(BytesIO(content))

    def parse(self, content: bytes, document_type: DocumentType) -> IntermediateDocument:
        document = self.load(content)
        texts = [visible_text(p).strip() for p in body_paragraphs(document)]
        joined = "\n".join(texts)
        language = detect_language(joined)
        model = IntermediateDocument(
            document_type=document_type,
            language=language,
            paragraphs=texts,
            title=next((text for text in texts if text), ""),
        )

        body_start = 0
        committee_subject_seen = False
        previous_level = 0
        nonempty_indices = [index for index, text in enumerate(texts) if text]
        title_index = next((index for index in nonempty_indices if looks_like_title(texts[index].lower(), document_type)), None)
        first_labeled_metadata = next((index for index in nonempty_indices if label_value(texts[index])[0]), len(texts))
        if title_index is not None:
            fields = DOCUMENT_PROFILES[document_type].get("unlabeledHeaderFields", [])
            preamble_words = clause_prefixes(language)[0]
            # A header line is short, unnumbered and not a sentence; a
            # preambulatory clause or the committee subject line is not one.
            header_candidates = [
                index for index in nonempty_indices
                if title_index < index < first_labeled_metadata
                and not MANUAL_NUMBER_RE.match(texts[index])
                and len(texts[index]) <= 80
                and not re.search(r"[。！？!?；;]", texts[index])
                and not texts[index].endswith((",", "，"))
                and not any(texts[index].casefold().startswith(word.casefold()) for word in preamble_words)
            ][:len(fields)]
            single_committee = (
                len(header_candidates) == 1
                and first_labeled_metadata < len(texts)
                and re.search(r"委员会|理事会|大会|议会|\b(?:committee|council|assembly|commission)\b", texts[header_candidates[0]], re.I)
            )
            if not (
                len(header_candidates) == len(fields)
                or (document_type == "draft-directive" and len(header_candidates) == 1)
                or single_committee
            ):
                header_candidates = []
            for key, index in zip(fields, header_candidates):
                value = re.sub(r"^\s*[:：]\s*", "", texts[index]).strip()
                setattr(model, key, value)
                model.header_paragraph_indices[key] = index
            if header_candidates:
                body_start = max(body_start, max(header_candidates) + 1)

        for index, text in enumerate(texts):
            if not text:
                continue
            label, value = label_value(text)
            if label in SCALAR_FIELDS:
                setattr(model, label, value)
                model.header_paragraph_indices[label] = index
                body_start = max(body_start, index + 1)
            elif label in COUNTRY_FIELDS:
                values, indices = self._collect_multiline_countries(texts, index, value, model, language)
                setattr(model, label, values)
                model.metadata_paragraph_indices[label] = indices
                body_start = max(body_start, max(indices) + 1)
            elif looks_like_title(text.lower(), document_type):
                model.title = text
                body_start = max(body_start, index + 1)

        metadata_indices = {item for indices in model.metadata_paragraph_indices.values() for item in indices}
        first_top_level = None
        if document_type == "draft-resolution":
            first_top_level = next(
                (index for index, text in enumerate(texts) if index >= body_start and TOP_LEVEL_NUMBER_RE.match(text)),
                None,
            )
            # Some committee examples omit the literal "第一条" while later
            # articles start with "第二条".  In that pattern the first
            # operative heading is the action-verb paragraph immediately
            # followed by a parenthesized subclause.  Treat it as the true
            # boundary instead of incorrectly formatting the whole first
            # article as preambulatory text.
            if first_top_level is not None:
                inferred = self._inferred_first_operative(texts, body_start, first_top_level, language)
                if inferred is not None:
                    first_top_level = inferred

        for index, paragraph in enumerate(body_paragraphs(document)):
            text = texts[index]
            if not text or index < body_start or index in metadata_indices:
                continue
            if PART_RE.match(text):
                model.body_clauses.append(Clause(text=text, kind="heading", paragraph_index=index))
                continue
            if self._is_committee_subject(text, model.committee, language):
                committee_subject_seen = True
                model.body_clauses.append(Clause(text=text, kind="heading", paragraph_index=index))
                continue
            clean = strip_manual_number(text)
            level = infer_level(text, paragraph, previous_level)
            previous_level = level
            model.max_numbering_level = max(model.max_numbering_level, level + 1)
            if document_type == "draft-resolution" and committee_subject_seen and first_top_level is not None:
                if index < first_top_level:
                    kind, confidence = "preambulatory", 0.98
                    level = 0
                else:
                    kind, confidence = "operative", 0.98
            else:
                kind, confidence = self._classify_clause(clean, document_type, language, committee_subject_seen)
            clause = Clause(text=clean, level=level, kind=kind, paragraph_index=index, confidence=confidence)
            if kind == "preambulatory":
                model.preambulatory_clauses.append(clause)
            elif kind == "operative":
                model.operative_clauses.append(clause)
            else:
                model.body_clauses.append(clause)
                if document_type in ("draft-resolution", "draft-directive"):
                    model.warnings.append(f"第 {index + 1} 段无法可靠判定条款类型，请确认。")

        if document_type in ("draft-resolution", "draft-directive", "friendly-amendment", "unfriendly-amendment"):
            if not model.sponsors:
                model.warnings.append("未识别到起草国 / Sponsors。")
            if not model.signatories:
                model.warnings.append("未识别到附议国 / Signatories。")
        if document_type == "working-paper" and model.signatories:
            model.warnings.append("工作文件不应包含附议国；系统不会自动生成该字段。")
        return model

    @staticmethod
    def _inferred_first_operative(
        texts: list[str],
        body_start: int,
        first_explicit_top: int,
        language: str,
    ) -> int | None:
        operative_words = clause_prefixes(language)[1]
        subclause = re.compile(r"^\s*(?:\([a-zivx]+\)|[（(][一二三四五六七八九十]+[）)])", re.I)
        nonempty = [index for index in range(body_start, first_explicit_top) if texts[index].strip()]
        for position, index in enumerate(nonempty[:-1]):
            clean = strip_manual_number(texts[index]).strip().lower()
            next_text = texts[nonempty[position + 1]]
            if any(clean.startswith(word.lower()) for word in operative_words) and subclause.match(next_text):
                return index
        return None

    def _collect_multiline_countries(
        self,
        texts: list[str],
        start_index: int,
        first_value: str,
        model: IntermediateDocument,
        language: str,
    ) -> tuple[list[str], list[int]]:
        values = split_countries(first_value)
        indices = [start_index]
        clause_words = sum(clause_prefixes(language), ())
        for index in range(start_index + 1, len(texts)):
            text = texts[index].strip()
            if not text:
                continue
            if label_value(text)[0] or looks_like_title(text.lower(), model.document_type):
                break
            if self._is_committee_subject(text, model.committee, language):
                break
            if MANUAL_NUMBER_RE.match(text) or PART_RE.match(text):
                break
            low = text.lower().lstrip()
            if any(low.startswith(item.lower()) for item in clause_words):
                break
            if language == "zh" and not self._looks_like_country_continuation(text):
                break
            values.extend(split_countries(text))
            indices.append(index)
        return values, indices

    @staticmethod
    def _looks_like_country_continuation(text: str) -> bool:
        """Reject body prose that follows a country field without a blank label.

        The previous parser treated any unlabeled paragraph as another country,
        which swallowed an entire unfriendly-amendment body.  Chinese country
        continuations are short formal names separated by list punctuation and
        do not contain clause punctuation, digits or colons.
        """

        if re.search(r"[：:。！？!?；;\d]", text):
            return False
        values = split_countries(text.rstrip("、，, "))
        if not values:
            return False
        endings = ("国", "联邦", "联盟", "教廷")
        return all(len(value) <= 24 and value.endswith(endings) for value in values)

    @staticmethod
    def _is_committee_subject(text: str, committee: str, language: str) -> bool:
        clean = text.rstrip("，,").strip().lower()
        if committee and clean == committee.rstrip("，,").strip().lower():
            return True
        if clean in ("联合国大会", "the committee", "the general assembly"):
            return True
        # "The OPCW," — an English body addressed by its abbreviation (页37).
        return bool(re.fullmatch(r"The [A-Z][A-Z\s]*,", text.strip()))

    @staticmethod
    def _classify_clause(text: str, document_type: DocumentType, language: str, subject_seen: bool) -> tuple[str, float]:
        low = text.casefold().lstrip()
        preambles, operatives = clause_prefixes(language)
        if any(low.startswith(item.casefold()) for item in preambles):
            return "preambulatory", 0.94
        if any(low.startswith(item.casefold()) for item in operatives):
            return "operative", 0.94
        if document_type in ("working-paper", "draft-directive", "friendly-amendment", "unfriendly-amendment"):
            return "operative" if document_type != "working-paper" else "body", 0.72
        if document_type == "draft-resolution" and subject_seen:
            return "unknown", 0.35
        return "body", 0.8
