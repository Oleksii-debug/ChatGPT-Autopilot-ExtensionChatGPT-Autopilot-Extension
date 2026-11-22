import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
sys.path.insert(0, str(RUNTIME))
import voice_catalog
import voice_policy


class VoicePolicyTests(unittest.TestCase):
    def test_both_catalogs_have_the_same_45_allowed_profiles(self):
        names = json.loads((RUNTIME / "models/voices/catalog.json").read_text(encoding="utf-8"))
        self.assertEqual(len(names), 45)
        self.assertEqual(set(names), set(voice_catalog.PROFILES))
        self.assertFalse(set(names) & voice_policy.EXCLUDED_VOICE_IDS)
        self.assertTrue({"viktoriia", "oksana", "olena", "oleksii"} <= names.keys())

    def test_removed_profile_cannot_return_through_saved_alias(self):
        voices = {"sara": "Sara", "kostia": "Removed", "olena": "Olena"}
        self.assertEqual(voice_policy.resolve_voice(voices, "kostia", {"kostia": "olena"}), "sara")
        self.assertEqual(voice_policy.resolve_voice(voices, "old", {"old": "kostia"}), "sara")
        self.assertEqual(voice_policy.resolve_voice(voices, "old", {"old": "olena"}), "olena")
        self.assertEqual(list(voice_policy.filter_voice_catalog(voices)), ["sara", "olena"])

    def test_all_removed_identities_are_rejected_at_request_boundary(self):
        for voice in voice_policy.EXCLUDED_VOICE_IDS:
            with self.subTest(voice=voice), self.assertRaises(ValueError):
                voice_policy.require_voice_allowed(voice)
        self.assertFalse(voice_policy.is_voice_allowed(" KOSTIA "))
        self.assertFalse(voice_policy.is_voice_allowed(None))
        self.assertFalse(voice_policy.is_voice_allowed(""))
        self.assertEqual(voice_policy.require_voice_allowed("oleksii"), "oleksii")

    def test_no_allowed_fallback_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "No allowed"):
            voice_policy.resolve_voice({"kostia": "Removed"}, "kostia")


if __name__ == "__main__":
    unittest.main()
