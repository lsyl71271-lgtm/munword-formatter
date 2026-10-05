from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from .field_policy import normalize_country_whitespace, split_country_list, trim_country


SHARED = Path(__file__).resolve().parents[2] / "shared"
COUNTRY_DATA = json.loads((SHARED / "country-names.json").read_text(encoding="utf-8"))
COUNTRY_DATA_DATE = COUNTRY_DATA["checked_on"]
_POLICY = json.loads((SHARED / "document-policy.json").read_text(encoding="utf-8"))


def normalize_country(value: str) -> str:
    return normalize_country_whitespace(value)


_PINYIN = json.loads((SHARED / "country-pinyin.json").read_text(encoding="utf-8"))
_PHRASES = {phrase: reading.split() for phrase, reading in _PINYIN["phrases"].items()}
_LONGEST_PHRASE = max(map(len, _PHRASES))


def _name_key(value: str) -> str:
    return normalize_country(unicodedata.normalize("NFKC", value).replace("’", "'").replace("‘", "'")).lower()


_INDEX: dict = {}
for _record in COUNTRY_DATA["records"]:
    for _name in [*_record["formal"].values(), *_record["source_formal"].values(), *_record["short"].values(), *_record["aliases"]]:
        _matches = _INDEX.setdefault(_name_key(_name), [])
        if not any(item["id"] == _record["id"] for item in _matches):
            _matches.append(_record)
_REVIEW = {_name_key(name): status for category, status in (("ambiguous", "ambiguous"), ("historical", "historical"), ("organizations", "entity"))
           for name in COUNTRY_DATA["policy"][category]}


def resolve_country(value: str, language: str) -> dict:
    matches = _INDEX.get(_name_key(value), [])
    status = _REVIEW.get(_name_key(value)) or ("ambiguous" if len(matches) > 1 else "unknown" if not matches else "resolved" if matches[0]["kind"] == "member-state" else "entity")
    record = matches[0] if status == "resolved" else None
    display = value if not record or value in (record["formal"][language], record["source_formal"][language]) else record["formal"][language]
    return {"input": value, "display": display, "id": record["id"] if record else None, "status": status,
            "sortName": record["sort_name"][language] if record else value, "changed": display != value}


def country_sort_key(value: str, language: str):
    """Pinyin order for Chinese names (页41), case-insensitive alphabetical otherwise.

    Readings come from ``shared/country-pinyin.json``, which the browser
    engine uses too, so both engines sort alike: at each position the
    longest listed phrase ("秘鲁" → bi lu), else the character's reading,
    else the character itself.  Syllable boundaries stay in the key, so
    "阿(a)拉" sorts before "埃(ai)".
    """

    if language != "zh":
        return (value.lower(),)
    syllables: list[str] = []
    index = 0
    while index < len(value):
        for size in range(min(_LONGEST_PHRASE, len(value) - index), 0, -1):
            phrase = value[index:index + size]
            if phrase in _PHRASES:
                syllables.extend(_PHRASES[phrase])
                index += size
                break
        else:
            syllables.append(_PINYIN["chars"].get(value[index], value[index].lower()))
            index += 1
    return tuple(syllables)


def sort_countries(countries: list[str], language: str, preserve_order: bool = False) -> list[str]:
    return plan_countries(countries, language, preserve_order)["values"]


def plan_countries(values: list[str], language: str, preserve_order: bool = False) -> dict:
    resolutions = [resolve_country(value, language) for value in values if trim_country(value)]
    seen, kept = set(), []
    for item in resolutions:
        if item["id"]:
            if item["id"] in seen:
                continue
            seen.add(item["id"])
        kept.append(item)
    if not preserve_order:
        kept.sort(key=lambda item: country_sort_key(item["sortName"], language))
    return {"values": [item["display"] for item in kept], "resolutions": resolutions, "removedDuplicates": len(resolutions) - len(kept)}


def country_warnings(values: list[str], language: str) -> list[str]:
    reasons = {"ambiguous": "称呼有歧义", "historical": "历史国家或历史名称", "entity": "组织、观察员或其他非会员国实体", "unknown": "资料表未确认的名称"}
    warnings = [f"“{item['input']}”属于{reasons[item['status']]}；已保留原输入，请在第 03 步人工确认。"
                for item in map(lambda value: resolve_country(value, language), filter(trim_country, values)) if item["status"] != "resolved"]
    return list(dict.fromkeys(warnings))


def split_country_names(value: str) -> list[str]:
    if not trim_country(value):
        return []
    if _name_key(value) in _INDEX or _name_key(value) in _REVIEW:
        return [trim_country(value)]
    return split_country_list(value)


def country_field_value(text: str) -> str | None:
    match = re.match(r"^\s*([^:：]+)[:：]\s*([\s\S]*)$", text)
    if not match:
        return text.strip().lstrip(":： ")
    return match[2].strip() if any(_name_key(label).replace(" ", "") == _name_key(match[1]).replace(" ", "") for label in _POLICY["metadata"]["country"]["aliases"]) else None


def valid_country_field_change(before: str, after: str, language: str) -> bool:
    source, target = country_field_value(before), country_field_value(after)
    if source is None or target is None:
        return False
    resolved = resolve_country(source, language)
    return resolved["status"] == "resolved" and resolved["display"] == target
