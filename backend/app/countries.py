from __future__ import annotations

import json
import re
from pathlib import Path


COUNTRY_ALIASES = {
    "中国": "中华人民共和国",
    "美国": "美利坚合众国",
    "英国": "大不列颠及北爱尔兰联合王国",
    "俄罗斯": "俄罗斯联邦",
    "韩国": "大韩民国",
    "朝鲜": "朝鲜民主主义人民共和国",
}


def normalize_country(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())


_PINYIN = json.loads((Path(__file__).resolve().parents[2] / "shared" / "country-pinyin.json").read_text(encoding="utf-8"))
_PHRASES = {phrase: reading.split() for phrase, reading in _PINYIN["phrases"].items()}
_LONGEST_PHRASE = max(map(len, _PHRASES))


def country_sort_key(value: str, language: str):
    """Pinyin order for Chinese names (页41), case-insensitive alphabetical otherwise.

    Readings come from ``shared/country-pinyin.json``, which the browser
    engine uses too, so both engines sort alike: at each position the
    longest listed phrase ("秘鲁" → bi lu), else the character's reading,
    else the character itself.  Syllable boundaries stay in the key, so
    "阿(a)拉" sorts before "埃(ai)".
    """

    if language != "zh":
        return (value.casefold(),)
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
            syllables.append(_PINYIN["chars"].get(value[index], value[index].casefold()))
            index += 1
    return tuple(syllables)


def sort_countries(countries: list[str], language: str, preserve_order: bool = False) -> list[str]:
    cleaned = list(dict.fromkeys(normalize_country(value) for value in countries if normalize_country(value)))
    if preserve_order:
        return cleaned
    return sorted(cleaned, key=lambda value: country_sort_key(value, language))


def informal_country_warnings(countries: list[str]) -> list[str]:
    return [f"“{name}”可能不是正式中文国名；建议确认是否应为“{COUNTRY_ALIASES[name]}”。" for name in countries if name in COUNTRY_ALIASES]
