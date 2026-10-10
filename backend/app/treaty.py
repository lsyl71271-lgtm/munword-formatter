"""Diplomatic agreements and joint statements (``shared/document-policy.json`` → ``treaties``).

Mirror of the treaty section of ``app/docx-browser.ts``.  These documents have no
header fields: the title names the parties, and the signature block at the end
carries one representative per party.  This module reads the title and the
signature block; ``formatters/treaty.py`` lays the document out.
"""

from __future__ import annotations

import math
import re

from .countries import resolve_country
from .models import Clause, IntermediateDocument
from .semantic_policy import TREATIES

TREATY_TYPES = tuple(TREATIES["types"])
PARTIES = TREATIES["parties"]
SIGNATURE = TREATIES["signature"]
TITLE_RE = {
    "zh": re.compile(f"(?:{'|'.join(TREATIES['titleWords']['zh'])})[”\"」』）)]*$"),
    "en": re.compile(rf"\b(?:{'|'.join(TREATIES['titleWords']['en'])})\b", re.I),
}
SENTENCE_MARK = re.compile(r"[。；;！？!?]")
LABEL_RE = {"zh": re.compile(SIGNATURE["labelPattern"]["zh"]), "en": re.compile(SIGNATURE["labelPattern"]["en"], re.I)}


def is_treaty(document_type: str) -> bool:
    return document_type in TREATY_TYPES


def _title_like(text: str) -> bool:
    return len(text) <= 160 and not SENTENCE_MARK.search(text) and not re.match(r"^(?:鉴于|whereas\b)", text, re.I)


def title_indices(non_empty: list[tuple[str, int]], language: str) -> list[int]:
    """Leading title paragraphs: up to three short lines ending (Chinese) or containing (English) a title word."""

    lines: list[int] = []
    for text, index in non_empty[:3]:
        if not _title_like(text):
            break
        lines.append(index)
        if TITLE_RE[language].search(text):
            return lines
    return lines[:1]


def _known_name(name: str, language: str) -> bool:
    return resolve_country(name, language)["status"] != "unknown"


def _clean_party(value: str, language: str) -> str:
    if language == "zh":
        return re.sub(PARTIES["zhTrailing"], "", value.strip()).strip()
    return re.sub(r"[,，]+$", "", value.strip()).strip()


def split_parties(head: str, language: str) -> list[str]:
    """Party names in a title's party list; a separator inside a known name
    ("大不列颠及北爱尔兰联合王国", "Trinidad and Tobago") does not split it."""

    separators_re = PARTIES["zhSeparators"] if language == "zh" else PARTIES["enSeparators"]
    parts = re.split(f"({separators_re})", head, flags=re.I if language == "en" else 0)
    pieces, separators = parts[0::2], parts[1::2]
    parties: list[str] = []
    index = 0
    while index < len(pieces):
        current = pieces[index]
        while (index + 1 < len(pieces) and not _known_name(_clean_party(current, language), language)
               and _known_name(_clean_party(current + separators[index] + pieces[index + 1], language), language)):
            current += separators[index] + pieces[index + 1]
            index += 1
        if _clean_party(current, language):
            parties.append(_clean_party(current, language))
        index += 1
    return parties


def treaty_parties(titles: list[str], language: str) -> list[str]:
    """The parties named by the title (shared policy ``treaties.parties``)."""

    if not titles:
        return []
    if language == "zh":
        if len(titles) > 1 and re.match(f"^(?:{PARTIES['zhSubjectStart']})", titles[1].strip()):
            head = titles[0]
        else:
            joined = "".join(titles)
            # No "关于 / 就": the parties are what precedes the title word ("…和美利坚合众国联合声明").
            match = re.match(f"^(.*?)(?:{PARTIES['zhSubjectStart']})", joined, re.S)
            # A title without a treaty word ("工作文件") names no parties.
            head = match.group(1) if match else TITLE_RE["zh"].sub("", joined, count=1) if TITLE_RE["zh"].search(joined) else ""
    else:
        text = re.sub(r"\s+", " ", " ".join(titles)).strip()
        listed = re.search(f"{PARTIES['enLead']}(.+?)(?:{PARTIES['enSubjectStart']}|$)", text, re.I)
        word = TITLE_RE["en"].search(text)
        head = listed.group(1) if listed else text[: word.start()] if word and word.start() > 0 else ""
    return split_parties(head, language)


def signature_tokens(text: str, language: str) -> list[str]:
    pattern = r"[\s　]+" if language == "zh" else r"\t+|\s{2,}|　+"
    return [token for token in re.split(pattern, text.strip()) if token]


def label_tokens(text: str, language: str) -> list[str] | None:
    tokens = signature_tokens(text, language)
    return tokens if tokens and all(LABEL_RE[language].search(token) for token in tokens) else None


def _signature_like(text: str) -> bool:
    return len(text) <= 160 and not SENTENCE_MARK.search(text) and not re.search(r"[，,]$", text)


def signature_start(texts: list[str], language: str) -> int:
    """Index of the first representatives' line of the closing signature block, or -1."""

    start, seen = -1, 0
    for index in range(len(texts) - 1, -1, -1):
        text = texts[index].strip()
        if not text:
            continue
        seen += 1
        if seen > SIGNATURE["scanParagraphs"] or not _signature_like(text):
            break
        if label_tokens(text, language):
            start = index
    return start


def recognize(texts: list[str], document_type: str, language: str) -> IntermediateDocument:
    """``texts`` are the flow paragraphs' visible text, untrimmed (browser ``recognizeTreaty``)."""

    non_empty = [(text.strip(), index) for index, text in enumerate(texts) if text.strip()]
    indices = title_indices(non_empty, language)
    titles = [texts[index].strip() for index in indices]
    parties = treaty_parties(titles, language)
    closing = signature_start(texts, language)
    body = [Clause(text=text, level=0, kind="body", paragraph_index=index, confidence=0.9)
            for text, index in non_empty if index not in indices and (closing < 0 or index < closing)]
    warnings: list[str] = []
    if not titles:
        warnings.append("未识别到标题；请确认原稿第一段是标题。")
    if len(parties) < 2:
        warnings.append("未能从标题识别出至少两个签署方；请在第 03 步填写签署方，签字栏按填写的签署方生成。")
    return IntermediateDocument(
        document_type=document_type, language=language, title=("" if language == "zh" else " ").join(titles),
        sponsors=parties, body_clauses=body, warnings=warnings, paragraphs=texts,
    )


# ------------------------------------------------------------ signature block

def width_em(text: str) -> float:
    """Advance width at the body size (browser ``widthEm``; handbook_pass ``_width_em``)."""

    total = 0.0
    for char in text:
        if ord(char) > 0x2E7F:
            total += 1.0
        elif "A" <= char <= "Z":
            total += 0.7
        elif char in " ,.;:'’-()":
            total += 0.3
        else:
            total += 0.5
    return total


def _tab_width_em(text: str) -> float:
    return sum(2 if char == "\t" else width_em(char) for char in text)


def token_centres(text: str, tokens: list[str], align: str | None, line_em: float) -> list[float]:
    """Centre (in em from the left margin) of each token of a line as Word would place it."""

    centres: list[float] = []
    cursor, position = 0, 0.0
    for token in tokens:
        at = text.index(token, cursor)
        position += _tab_width_em(text[cursor:at])
        centres.append(position + _tab_width_em(token) / 2)
        position += _tab_width_em(token)
        cursor = at + len(token)
    total = position + _tab_width_em(text[cursor:])
    offset = (line_em - total) / 2 if align == "center" else line_em - total if align in ("right", "end") else 0
    return [centre + offset for centre in centres]


def read_signature_block(lines: list[tuple[str, str | None]], language: str, line_em: float):
    """Labels and names of the original block (``lines``: text and alignment), each name under the
    label it was written beneath; ``None`` when names cannot be matched to labels."""

    entries: list[dict] = []
    group = None
    inferred = False
    for text, align in lines:
        if not text.strip():
            continue
        labels = label_tokens(text, language)
        if labels:
            group = {"labels": labels, "centres": token_centres(text, labels, align, line_em), "named": False}
            entries.extend({"label": label, "name": ""} for label in labels)
            continue
        names = signature_tokens(text, language)
        if group is None or group["named"] or len(names) > len(group["labels"]):
            return None
        first = len(entries) - len(group["labels"])
        if len(names) == len(group["labels"]):
            for index, name in enumerate(names):
                entries[first + index]["name"] = name
        else:
            # Fewer names than representatives: each goes under the nearest label, in order.
            inferred = True
            centres = token_centres(text, names, align, line_em)
            following = 0
            for index, name in enumerate(names):
                best = following
                for column in range(following, len(group["labels"]) - (len(names) - index) + 1):
                    if abs(group["centres"][column] - centres[index]) < abs(group["centres"][best] - centres[index]):
                        best = column
                entries[first + best]["name"] = name
                following = best + 1
        group["named"] = True
    return entries, inferred


def party_key(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"^the\s+", "", value.strip(), flags=re.I)).lower()


def label_party(label: str, language: str) -> str:
    if language == "zh":
        return re.sub(r"代表[:：]?$", "", label)
    return re.sub(r"\s*Representative[:：]?$", "", re.sub(r"^(?:Representative of|On behalf of|For)\s+", "", label, flags=re.I), flags=re.I)


def signature_entries(parties: list[str], original: list[dict], language: str) -> list[dict]:
    """One entry per party, in the parties' order; the original's labels and names are kept, and a
    representative the original names for no listed party is kept after them."""

    used: set[int] = set()
    entries = []
    for party in parties:
        found = next((index for index, entry in enumerate(original)
                      if index not in used and party_key(label_party(entry["label"], language)) == party_key(party)), -1)
        if found >= 0:
            used.add(found)
            entries.append(dict(original[found]))
        else:
            entries.append({"label": SIGNATURE["label"][language].replace("{party}", party), "name": ""})
    return entries + [entry for index, entry in enumerate(original) if index not in used]


def signature_rows(entries: list[dict], line_em: float) -> list[list[dict]]:
    """Rows of at most maxPerRow representatives, as even as possible (4 → 2+2, 5 → 3+2), with a row more when one does not fit."""

    def width(entry):
        return max(width_em(entry["label"]), width_em(entry["name"]))

    def fits(row):
        return sum(width(entry) for entry in row) + (len(row) - 1) * SIGNATURE["minGapEm"] <= line_em

    for count in range(math.ceil(len(entries) / SIGNATURE["maxPerRow"]), len(entries) + 1):
        base, extra = divmod(len(entries), count)
        rows, start = [], 0
        for row in range(count):
            size = base + (1 if row < extra else 0)
            rows.append(entries[start:start + size])
            start += size
        if all(fits(row) for row in rows):
            return rows
    return [[entry] for entry in entries]


def column_stops(row: list[dict], line_em: float, body_pt: float) -> list[int]:
    """Tab stops (twips) centring each column, the free width shared out evenly around the columns."""

    widths = [max(width_em(entry["label"]), width_em(entry["name"])) for entry in row]
    gap = max(0.0, line_em - sum(widths)) / len(row)
    start = gap / 2
    stops = []
    for width in widths:
        stops.append(_js_round((start + width / 2) * body_pt * 20))
        start += width + gap
    return stops


def _js_round(value: float) -> int:
    """``Math.round``: halves go up, as in the browser engine."""

    return math.floor(value + 0.5)
