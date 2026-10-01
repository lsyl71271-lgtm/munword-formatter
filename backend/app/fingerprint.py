from __future__ import annotations

import re

from docx.document import Document as DocumentObject

from .docx_view import active_num_id, all_paragraphs, body_paragraphs, table_paragraphs, visible_text
from .parser import MANUAL_NUMBER_RE
from .semantic_policy import ANY_LABEL_PATTERN, OPERATIVE_EN, OPERATIVE_ZH, PREAMBLE_EN, PREAMBLE_ZH, TITLES


_TITLE_NAMES = "|".join(re.escape(title) for titles in TITLES.values() for title in titles)
TITLE_RE = re.compile(rf"(?:{_TITLE_NAMES})", re.I)
_LIST_SEPARATORS = ("、", ",", "，", ";", "；")


def _canonical_fragment(text: str) -> str:
    text = MANUAL_NUMBER_RE.sub("", text, count=1)
    text = re.sub(r"[_＿]+", "", text)
    return re.sub(r"[\s\W_]+", "", text, flags=re.UNICODE).casefold()


def canonical_body(document: DocumentObject) -> str:
    parts: list[str] = []
    body = body_paragraphs(document)
    texts = [visible_text(paragraph).strip() for paragraph in body]
    country_labels = [
        index for index, text in enumerate(texts)
        if re.match(r"^(?:起草国|附议国|sponsors?|signatories)\s*[:：]", text, re.I)
    ]
    metadata_continuations: set[int] = set()
    if country_labels:
        last_label = country_labels[-1]
        clause_words = tuple(item.casefold() for item in PREAMBLE_ZH + OPERATIVE_ZH + PREAMBLE_EN + OPERATIVE_EN)
        first_clause = next(
            (
                index for index in range(last_label + 1, len(texts))
                if texts[index]
                and (
                    MANUAL_NUMBER_RE.match(texts[index])
                    or active_num_id(body[index]) is not None
                    or texts[index].casefold().lstrip().startswith(clause_words)
                )
            ),
            None,
        )
        if first_clause is not None:
            subject_index = next((index for index in range(first_clause - 1, last_label, -1) if texts[index]), first_clause)
            metadata_continuations.update(range(last_label + 1, subject_index))
        # A list line ending with a separator continues on the next line
        # (the handbook breaks lists between names to leave signing space).
        for label in country_labels:
            previous = texts[label]
            for index in range(label + 1, len(texts)):
                if not texts[index]:
                    continue
                if not previous.endswith(_LIST_SEPARATORS) or index in country_labels or ANY_LABEL_PATTERN.match(texts[index]):
                    break
                metadata_continuations.add(index)
                previous = texts[index]

    # Unlabeled header lines (committee, topic) sit between the title and the
    # first labeled field; the handbook prints them without labels, so they
    # are header, not body, whether or not a label is present.
    first_label = next((index for index, text in enumerate(texts) if ANY_LABEL_PATTERN.match(text)), None)
    if first_label is not None:
        metadata_continuations.update(index for index in range(first_label) if texts[index])

    for index, paragraph in enumerate(body):
        text = visible_text(paragraph).strip()
        if not text or index in metadata_continuations or ANY_LABEL_PATTERN.match(text) or TITLE_RE.search(text):
            continue
        parts.append(_canonical_fragment(text))
    # Text inside tables is body content too.  It used to be invisible to the
    # fingerprint, so a table could be reflowed or emptied without tripping the
    # content guard.
    for paragraph in table_paragraphs(document):
        text = visible_text(paragraph).strip()
        if text:
            parts.append(_canonical_fragment(text))
    return "".join(parts)


def visible_text_signature(document: DocumentObject) -> str:
    """Strict visible-text signature used for mutation detection.

    Whitespace and equivalent full/half-width structural punctuation are
    normalized, but metadata, numbering text and ordinary punctuation remain.
    This is intentionally stricter than ``canonical_body``.
    """

    text = "\n".join(visible_text(paragraph) for paragraph in all_paragraphs(document))
    text = text.translate(str.maketrans({"（": "(", "）": ")", "：": ":"}))
    return re.sub(r"\s+", "", text).casefold()
