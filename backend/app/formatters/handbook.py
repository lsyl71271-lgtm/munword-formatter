"""Layout of the PKUNMUN 2026 Academic Standard Handbook samples.

The values live in ``shared/document-policy.json`` (section ``handbook``),
which the browser engine reads as well, so both engines apply one set of
measurements.  Every value there cites the handbook page it was measured on.
This module only turns that section into typed Python objects.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..semantic_policy import HANDBOOK

_PAGE = HANDBOOK["page"]
TWIPS_PER_MM = 1440 / 25.4
PAGE_WIDTH_MM = _PAGE["widthTwips"] / TWIPS_PER_MM
PAGE_HEIGHT_MM = _PAGE["heightTwips"] / TWIPS_PER_MM
MARGIN_TOP_MM = _PAGE["topTwips"] / TWIPS_PER_MM
MARGIN_BOTTOM_MM = _PAGE["bottomTwips"] / TWIPS_PER_MM
MARGIN_LEFT_MM = _PAGE["leftTwips"] / TWIPS_PER_MM
MARGIN_RIGHT_MM = _PAGE["rightTwips"] / TWIPS_PER_MM
HEADER_DISTANCE_MM = _PAGE["headerTwips"] / TWIPS_PER_MM
FOOTER_DISTANCE_MM = _PAGE["footerTwips"] / TWIPS_PER_MM

BODY_SIZE_PT = float(HANDBOOK["bodySizePt"])
NOTE_SIZE_PT = float(HANDBOOK["noteSizePt"])
FONTS = HANDBOOK["fonts"]
PITCH_PT = HANDBOOK["lineSpacing"]["pitchPt"]
OUTPUT_TITLES = HANDBOOK["outputTitles"]
COUNTRY_SEPARATOR = HANDBOOK["signatureLines"]["separator"]
# Width of the text block (A4 less both margins) in ems at the body size,
# less a little so a line never wraps by itself.
LINE_WIDTH_EM = (PAGE_WIDTH_MM - MARGIN_LEFT_MM - MARGIN_RIGHT_MM) / 25.4 * 72 / BODY_SIZE_PT - 1


@dataclass(frozen=True)
class Indent:
    left: float
    hanging: float = 0.0
    first_line: float = 0.0


NO_INDENT = Indent(0.0)


@dataclass(frozen=True)
class HandbookSpec:
    pages: str = ""
    # "label-bold": only the label is bold (position papers); "bold": the whole line.
    header_fields: str = "bold"
    # Committee and topic lines are printed without "委员会：/议题：" labels in
    # most samples ("drop"); English working papers and position papers keep them.
    committee_topic_labels: str = "keep"
    # Sponsors / signatories: label bold; names bold italic.  The Chinese
    # working paper sets the label italic as well.
    country_label_italic: bool = False
    # Committee subject line ("联合国大会，"): (bold, italic), or None.
    subject: tuple[bool, bool] | None = None
    prose_first_line: float = 0.0
    # Indentation of list levels 0, 1, 2, 3 (deeper levels repeat the last).
    list_indents: tuple[Indent, ...] = (NO_INDENT,)
    top_level_verb_italic: bool = False
    preamble_verb_underline: bool = False
    clear_clause_emphasis: bool = True
    signature_lines: bool = False
    # Exactly one empty paragraph after these roles, none anywhere else.
    blank_after: frozenset[str] = field(default_factory=frozenset)
    blank_between_prose: bool = False
    blank_before_operative: bool = False
    clause_punctuation: bool = False


def _spec(raw: dict) -> HandbookSpec:
    subject = raw.get("subject")
    return HandbookSpec(
        pages=raw.get("pages", ""),
        header_fields=raw["headerFields"],
        committee_topic_labels=raw["committeeTopicLabels"],
        country_label_italic=raw["countryLabelItalic"],
        subject=None if subject is None else (subject["bold"], subject["italic"]),
        prose_first_line=float(raw["proseFirstLinePt"]),
        list_indents=tuple(Indent(float(left), float(hanging)) for left, hanging in raw["listIndentsPt"]),
        top_level_verb_italic=raw["topLevelVerbItalic"],
        preamble_verb_underline=raw["preambleVerbUnderline"],
        clear_clause_emphasis=raw["clearClauseEmphasis"],
        signature_lines=raw["signatureLines"],
        blank_after=frozenset(raw["blankAfter"]),
        blank_between_prose=raw["blankBetweenProse"],
        blank_before_operative=raw["blankBeforeOperative"],
        clause_punctuation=raw["clausePunctuation"],
    )


SPECS: dict[tuple[str, str], HandbookSpec] = {
    (kind, language): _spec(raw)
    for kind, by_language in HANDBOOK["types"].items()
    for language, raw in by_language.items()
}

# Operation verbs that open an amendment instruction (页52 "加入", 页53 "Add").
AMENDMENT_VERBS_ZH = tuple(HANDBOOK["amendmentVerbs"]["zh"])
AMENDMENT_VERBS_EN = tuple(HANDBOOK["amendmentVerbs"]["en"])


def spec_kind(document_type: str) -> str:
    return "amendment" if document_type in ("friendly-amendment", "unfriendly-amendment") else document_type


def spec_for(document_type: str, language: str) -> HandbookSpec:
    return SPECS[(spec_kind(document_type), "zh" if language == "zh" else "en")]


def east_asian_font(document_type: str, language: str) -> str:
    """宋体 everywhere except Chinese amendments, printed in Arial Unicode MS (页52)."""

    if language != "zh":
        return FONTS["en"]
    return FONTS["amendmentZh"] if spec_kind(document_type) == "amendment" else FONTS["zh"]


def output_title(document_type: str, language: str) -> str:
    return OUTPUT_TITLES[document_type]["zh" if language == "zh" else "en"]


def body_pitch(document_type: str, language: str) -> float:
    if language != "zh":
        return float(PITCH_PT["en"])
    return float(PITCH_PT["amendmentZh"] if spec_kind(document_type) == "amendment" else PITCH_PT["zh"])


def role_pitch(document_type: str, language: str, role: str) -> float:
    """Baseline-to-baseline distance for a paragraph role, in points."""

    if language == "zh" and role == "preamble" and spec_kind(document_type) == "draft-resolution":
        return float(PITCH_PT["preambleZh"])
    if language == "zh" and role == "signature" and spec_kind(document_type) == "amendment":
        return float(PITCH_PT["amendmentZhSignature"])
    return body_pitch(document_type, language)

# Default spacing of the Normal style; every body paragraph gets its own
# handbook pitch in the final pass.
SINGLE = 1.0
