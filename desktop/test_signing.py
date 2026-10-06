"""Regression for the signature that passed CI but failed on a user's Mac."""
import unittest
from build import validate_macos_signature


class SigningTests(unittest.TestCase):
    def test_ad_hoc_without_hardened_runtime_can_load_its_python(self):
        signature = validate_macos_signature("CodeDirectory v=20400 flags=0x2(adhoc)\nTeamIdentifier=not set\n", "-")
        self.assertFalse(signature["hardened_runtime"])
        self.assertTrue(signature["ad_hoc"])

    def test_ad_hoc_hardened_runtime_is_rejected_even_with_valid_structure(self):
        with self.assertRaisesRegex(ValueError, "Ad-hoc builds must not"):
            validate_macos_signature("CodeDirectory v=20500 flags=0x10002(adhoc,runtime)\nTeamIdentifier=not set\n", "-")

    def test_developer_id_requires_the_same_team_for_embedded_libraries(self):
        text = "CodeDirectory v=20500 flags=0x10000(runtime)\nTeamIdentifier=ABCDE12345\n"
        self.assertTrue(validate_macos_signature(text, "Developer ID Application", "ABCDE12345")["hardened_runtime"])
        with self.assertRaisesRegex(ValueError, "same Team ID"):
            validate_macos_signature(text, "Developer ID Application", "DIFF123456")
        with self.assertRaisesRegex(ValueError, "same Team ID"):
            validate_macos_signature(text.replace("ABCDE12345", "not set"), "Developer ID Application")

    def test_incomplete_signature_metadata_cannot_pass(self):
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            validate_macos_signature("codesign succeeded", "-")


if __name__ == "__main__":
    unittest.main()
