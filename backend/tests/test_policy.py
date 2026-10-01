"""The shared policy is the only copy of the handbook rules; check its shape.

Both engines read ``shared/document-policy.json``.  A missing key or an
out-of-range value would make one engine fail or silently fall back, so the
file is validated here instead of being duplicated as constants.
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.formatters import handbook  # noqa: E402

POLICY = json.loads((ROOT / "shared" / "document-policy.json").read_text(encoding="utf-8"))
HANDBOOK = POLICY["handbook"]
KINDS = ("position-paper", "working-paper", "draft-directive", "draft-resolution", "amendment")
TYPE_KEYS = {
    "pages", "headerFields", "committeeTopicLabels", "countryLabelItalic", "subject", "proseFirstLinePt",
    "listIndentsPt", "topLevelVerbItalic", "preambleVerbUnderline", "clearClauseEmphasis", "signatureLines",
    "blankAfter", "blankBetweenProse", "blankBeforeOperative", "clausePunctuation",
}
BLANK_ROLES = {"title", "committee", "topic", "title_block", "header", "sponsors", "signatories", "subject"}


class PolicyTests(unittest.TestCase):
    def test_every_document_type_has_both_languages_and_every_key(self):
        self.assertEqual(set(HANDBOOK["types"]), set(KINDS))
        for kind in KINDS:
            for language in ("zh", "en"):
                with self.subTest(kind=kind, language=language):
                    spec = HANDBOOK["types"][kind][language]
                    self.assertEqual(set(spec), TYPE_KEYS)
                    self.assertTrue(spec["pages"], "every rule cites the handbook page it was measured on")
                    self.assertIn(spec["headerFields"], ("bold", "label-bold"))
                    self.assertIn(spec["committeeTopicLabels"], ("keep", "drop"))
                    self.assertLessEqual(set(spec["blankAfter"]), BLANK_ROLES)
                    self.assertTrue(1 <= len(spec["listIndentsPt"]) <= 4)
                    for left, hanging in spec["listIndentsPt"]:
                        self.assertTrue(0 <= hanging <= left <= 100 or (left == 0 and hanging == 0))

    def test_measured_values_are_in_range(self):
        self.assertEqual(HANDBOOK["bodySizePt"], 12)
        self.assertEqual(HANDBOOK["noteSizePt"], 9)
        for key, pitch in HANDBOOK["lineSpacing"]["pitchPt"].items():
            with self.subTest(pitch=key):
                self.assertTrue(12 <= pitch <= 24)
                self.assertIn(key, HANDBOOK["lineSpacing"]["evidence"])
        page = HANDBOOK["page"]
        self.assertEqual((page["widthTwips"], page["heightTwips"]), (11906, 16838))
        self.assertEqual(HANDBOOK["fonts"]["amendmentZh"], "Arial Unicode MS")

    def test_python_reads_the_same_values(self):
        self.assertEqual(handbook.body_pitch("draft-resolution", "zh"), HANDBOOK["lineSpacing"]["pitchPt"]["zh"])
        self.assertEqual(handbook.role_pitch("draft-resolution", "zh", "preamble"), HANDBOOK["lineSpacing"]["pitchPt"]["preambleZh"])
        self.assertEqual(handbook.body_pitch("friendly-amendment", "zh"), HANDBOOK["lineSpacing"]["pitchPt"]["amendmentZh"])
        self.assertEqual(handbook.east_asian_font("unfriendly-amendment", "zh"), "Arial Unicode MS")
        self.assertEqual(handbook.east_asian_font("draft-resolution", "zh"), "SimSun")
        for (kind, language), spec in handbook.SPECS.items():
            raw = HANDBOOK["types"][kind][language]
            self.assertEqual([[i.left, i.hanging] for i in spec.list_indents], raw["listIndentsPt"])
            self.assertEqual(set(spec.blank_after), set(raw["blankAfter"]))


if __name__ == "__main__":
    unittest.main()
