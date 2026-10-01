"""Document vocabulary shared with the browser engine (``shared/document-policy.json``).

Every metadata-label regex used by the parser, the formatters and the content
fingerprint is compiled here once, so the three stages cannot drift apart and
no hot loop recompiles a pattern per paragraph.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


_POLICY_PATH = Path(__file__).resolve().parents[2] / "shared" / "document-policy.json"
_POLICY = json.loads(_POLICY_PATH.read_text(encoding="utf-8"))
DOCUMENT_PROFILES = _POLICY["documents"]
HANDBOOK = _POLICY["handbook"]
ENGLISH_REGIONS = frozenset(
    name.casefold() for name in json.loads((_POLICY_PATH.parent / "region-names-en.json").read_text(encoding="utf-8"))
)

# Source titles and the handbook's output titles ("修正案", "WORKING PAPER"),
# so an already formatted document is recognized again.
TITLES = {
    document_type: tuple(dict.fromkeys([*values.values(), *HANDBOOK["outputTitles"][document_type].values()]))
    for document_type, values in _POLICY["titles"].items()
}
META_ALIASES = {
    key: tuple(spec["aliases"])
    for key, spec in _POLICY["metadata"].items()
}
META_LABELS = {
    language: {
        key: spec["output"][language]
        for key, spec in _POLICY["metadata"].items()
    }
    for language in ("zh", "en")
}
PREAMBLE_ZH = tuple(_POLICY["prefixes"]["zh"]["preambulatory"])
PREAMBLE_EN = tuple(_POLICY["prefixes"]["en"]["preambulatory"])
OPERATIVE_ZH = tuple(_POLICY["prefixes"]["zh"]["operative"])
OPERATIVE_EN = tuple(_POLICY["prefixes"]["en"]["operative"])


def _alternation(aliases) -> str:
    # Longest alias first so "国家/席位" wins over "国家".
    return "|".join(re.escape(alias) for alias in sorted(aliases, key=len, reverse=True))


# ``label: value`` for one metadata key; group 1 is the value.
_LABEL_VALUE_PATTERNS = {
    key: re.compile(rf"^(?:{_alternation(aliases)})\s*[:：]\s*(.*)$", re.I)
    for key, aliases in META_ALIASES.items()
}
# Label prefix only, per key (iteration order follows the policy file).
LABEL_PATTERNS = {
    key: re.compile(rf"^(?:{_alternation(aliases)})\s*[:：]", re.I)
    for key, aliases in META_ALIASES.items()
}
# Label prefix of any metadata key.
ANY_LABEL_PATTERN = re.compile(
    rf"^(?:{_alternation(dict.fromkeys(alias for aliases in META_ALIASES.values() for alias in aliases))})\s*[:：]",
    re.I,
)


def label_value(text: str) -> tuple[str, str]:
    """Return ``(key, value)`` for a labeled metadata line, or ``("", "")``."""

    for key, pattern in _LABEL_VALUE_PATTERNS.items():
        match = pattern.match(text)
        if match:
            return key, match.group(1).strip()
    return "", ""


_TITLE_PATTERNS = {
    document_type: re.compile(
        rf"^(?:{_alternation(titles)})(?:\s*(?:[\d.．]+|\[(?:编号|number)\]))?(?:\s*(?:终|最终稿|Final))?$", re.I
    )
    for document_type, titles in TITLES.items()
}


def looks_like_title(text: str, document_type: str) -> bool:
    """The whole line is the document title, optionally followed by its number.

    A clause that merely mentions "决议草案" (an amendment citing the
    resolution) is not a title.
    """

    return bool(_TITLE_PATTERNS[document_type].match(text.strip()))


def title_parts(text: str, document_type: str) -> tuple[str, str] | None:
    """``(title word, rest)`` of a title line, e.g. ``("友好修正案", " 1.2.1")``."""

    stripped = text.strip()
    if not looks_like_title(stripped, document_type):
        return None
    word = next(
        title for title in sorted(TITLES[document_type], key=len, reverse=True)
        if stripped.casefold().startswith(title.casefold())
    )
    return stripped[: len(word)], stripped[len(word):]


def clause_prefixes(language: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """``(preambulatory, operative)`` verb prefixes for a language."""

    if language == "zh":
        return PREAMBLE_ZH, OPERATIVE_ZH
    return PREAMBLE_EN, OPERATIVE_EN
