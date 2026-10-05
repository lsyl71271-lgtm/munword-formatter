"""Import the public UNTERM country-name XLSX, joined to UNGEGN M49 IDs.

Download inputs separately from the documented official URLs. This script
never infers a formal name. Review the diff, especially changed/removed IDs,
before committing an update. Existing curated aliases/review terms survive.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
EXPORT = "https://conferences.unite.un.org/untermapi/api/term/downloadCountries"
UNGEGN = "https://ungegn-api.azurewebsites.net/API/GetAllCountries"
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def clean(value):
    return re.sub(r"\s*\*+\s*$", "", value).strip()


def short_en(value):
    return re.sub(r"\s*\(the\)$", "", clean(value))


def import_table(export, geography, checked_on, target):
    with ZipFile(export) as archive:
        strings = ["".join(node.itertext()) for node in ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("s:si", NS)]
        rows = []
        for row in ET.fromstring(archive.read("xl/worksheets/sheet1.xml")).findall("s:sheetData/s:row", NS):
            cells = [""] * 12
            for cell in row:
                column = re.match(r"[A-Z]+", cell.get("r")).group()
                index = 0
                for char in column:
                    index = index * 26 + ord(char) - ord("A") + 1
                value = cell.find("s:v", NS)
                if index <= 12 and value is not None:
                    cells[index - 1] = strings[int(value.text)] if cell.get("t") == "s" else value.text
            rows.append(cells)
    assert rows[0][0] == "English short" and rows[0][10] == "Chinese formal"
    features = json.loads(geography.read_text())["features"]
    ids = {}
    for feature in features:
        names = feature["properties"]["toponyms"]
        for item in names:
            if item["language"] in ("Chinese", "English"):
                ids[short_en(item.get("nameShort", "")).casefold()] = item["crM49"]
                ids[clean(item.get("nameLong", "")).casefold().removeprefix("the ")] = item["crM49"]
    previous = json.loads(target.read_text()) if target.exists() else {}
    old = {record["id"]: record for record in previous.get("records", [])}
    records = []
    # UNTERM marks these separately; they are NOT ordinary UN member states.
    special_ids = {"Holy See": (336, "observer-state"), "State of Palestine": (275, "observer-state"),
                   "Cook Islands": (184, "specialized-agency-member"), "Niue": (570, "specialized-agency-member")}
    for row in rows[1:]:
        if row[0].startswith("*") or not row[0]:
            continue
        english, chinese = short_en(row[0]), clean(row[4])
        if english in special_ids:
            m49, kind = special_ids[english]
        else:
            m49 = ids.get(english.casefold()) or ids.get(chinese.casefold()) or ids.get(clean(row[6]).casefold().removeprefix("the "))
            kind = "member-state"
        if not m49 or not row[6] or not row[10]:
            raise ValueError(f"Missing ID / formal name: {english}; inspect the official sources, do not guess")
        identifier = f"UN-M49-{m49:03d}"
        official = {"zh": clean(row[10]), "en": re.sub(r"^the ", "", clean(row[6]))}
        records.append({"id": identifier, "kind": kind, "formal": official,
                        "source_formal": {"zh": clean(row[10]), "en": clean(row[6])},
                        "short": {"zh": chinese, "en": english}, "sort_name": official.copy(),
                        "aliases": old.get(identifier, {}).get("aliases", []),
                        "source": "https://unterm.un.org/unterm2/en/country", "checked_on": checked_on})
    assert len(records) == 197 and len({item["id"] for item in records}) == len(records)
    result = {"schema_version": 1, "checked_on": checked_on,
              "sources": [{"url": EXPORT, "sha256": hashlib.sha256(export.read_bytes()).hexdigest()},
                          {"url": UNGEGN, "sha256": hashlib.sha256(geography.read_bytes()).hexdigest()}],
              "policy": {"match": "whole-name-nfkc-case-insensitive", "english_article": "omit initial grammatical 'the' in expanded field names; preserve supplied official forms",
                         "sort": "formal sort_name, Chinese pinyin / English alphabetical; independent of displayed spelling",
                         "entities": "preserve and request manual confirmation, never silently treat as member states",
                         "ambiguous": ["刚果", "Congo", "Congo (the)", "Korea", "朝鲜半岛", "朝鲜半岛国家", "高丽", "科里亚"],
                         "historical": ["苏联", "苏维埃社会主义共和国联盟", "USSR", "Soviet Union", "南斯拉夫", "南斯拉夫社会主义联邦共和国", "Yugoslavia", "捷克斯洛伐克", "Czechoslovakia", "南非联邦", "暹罗", "暹罗王国", "Siam", "扎伊尔", "Zaire"],
                         "organizations": ["联合国", "United Nations", "UN", "欧盟", "欧洲联盟", "European Union", "EU", "非盟", "非洲联盟", "African Union", "AU", "北约", "NATO", "红十字国际委员会", "International Committee of the Red Cross", "ICRC"]},
              "records": sorted(records, key=lambda item: item["id"])}
    if previous:
        result["policy"] = previous["policy"]
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unterm-export", type=Path, required=True)
    parser.add_argument("--ungegn-json", type=Path, required=True)
    parser.add_argument("--checked-on", required=True, help="Actual date the downloaded inputs were checked (YYYY-MM-DD)")
    args = parser.parse_args()
    import_table(args.unterm_export, args.ungegn_json, args.checked_on, ROOT / "shared" / "country-names.json")
