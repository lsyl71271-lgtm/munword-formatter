"""Shared, exact whitelist for flattening ordinary field separators only."""
import json
import re
from pathlib import Path

POLICY = json.loads((Path(__file__).resolve().parents[2] / "shared" / "field-edit-policy.json").read_text(encoding="utf-8"))
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
ALLOWED = {(W + tag, tuple(sorted((W + key, value) for key, value in attrs.items())))
           for tag, variants in POLICY["plainSeparators"].items() for attrs in variants}


def is_plain_field(sig):
    index = 0
    while index < len(sig):
        token = sig[index]
        if token[0] == "t":
            index += 1
            continue
        if (token[0] != "s" or (token[1], token[2]) not in ALLOWED
                or index + 1 >= len(sig) or sig[index + 1] != ("e", token[1])):
            return False
        index += 2
    return True


def trim_country(value):
    return value.strip(POLICY["countryWhitespace"])


def normalize_country_whitespace(value):
    return re.sub(" +", " ", "".join(" " if ch in POLICY["countryWhitespace"] else ch for ch in value)).strip(" ")


def split_country_list(value):
    return [trim_country(item) for item in re.split("[" + re.escape(POLICY["countryListSeparators"]) + "]", value) if trim_country(item)]
