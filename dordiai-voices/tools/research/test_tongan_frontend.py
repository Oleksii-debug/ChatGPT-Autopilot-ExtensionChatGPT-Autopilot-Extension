"""Primary-source contrasts for the isolated, unregistered phonemic prototype."""
import unittest
import json
from pathlib import Path
import tongan_frontend as t


class TonganTests(unittest.TestCase):
    def test_glottal_is_consonant_not_discarded_quote(self):
        self.assertEqual(t.word("ʻuma").ipa, "ˈʔuma")
        self.assertEqual(t.word("uma").ipa, "ˈuma")
        self.assertEqual(t.word("ʻalu").ipa, "ˈʔalu")
        for variant in ("'", "‘", "’", "ʻ", "ʼ", "ʔ"):
            self.assertEqual(t.word(variant + "alu").segments[0], "ʔ")

    def test_primary_length_minimal_triple(self):
        self.assertEqual(t.word("kaka").ipa, "ˈkaka")
        self.assertEqual(t.word("kakā").ipa, "kaˈkaa")
        self.assertEqual(t.word("kākā").ipa, "kaaˈkaa")
        self.assertEqual(len(t.word("kākā").mora_positions), 4)

    def test_definitive_copies_final_vowel_instead_of_stress_only(self):
        self.assertEqual(t.word("tangata").ipa, "taˈŋata")
        self.assertEqual(t.word("tangatá").ipa, "taŋaˈtaa")
        self.assertEqual(t.word("koté").ipa, "koˈtee")
        self.assertEqual(t.word("puhí").ipa, "puˈhii")
        self.assertEqual(t.word("kāká").ipa, "kaaˈkaa")
        self.assertEqual(t.word("kākā́").ipa, "kaakaˈaa")

    def test_trailing_accent_and_unicode_equivalents(self):
        self.assertEqual(t.word("fale´").ipa, t.word("falé").ipa)
        self.assertEqual(t.word("a\u0304").ipa, t.word("Ā").ipa)
        self.assertEqual(t.word("kākā").graphemes, ("k", "ā", "k", "ā"))
        self.assertNotEqual(t.word("kaa").graphemes, t.word("kā").graphemes)

    def test_marked_enclitic_has_no_fabricated_definitive_vowel(self):
        self.assertEqual(t.word("Kuo´", accent_kind="enclitic").ipa, "kuˈo")
        parts = t.text_words("Kuo´ u fiu, mālō.")
        self.assertEqual(parts[0].marked_accent, "enclitic")
        self.assertEqual(parts[0].ipa, "kuˈou")
        self.assertEqual(t.encoded("Kuo´ u"), "[[k|u|'o|u]]")
        self.assertEqual(t.text_words("kuo´, u")[0].marked_accent, "definitive")

    def test_no_written_glottal_or_length_is_invented(self):
        self.assertNotIn("ʔ", t.word("uma").segments)
        self.assertEqual(len(t.word("fale").mora_positions), 2)
        self.assertEqual(t.word("ngatu").segments, ("ŋ", "a", "t", "u"))
        self.assertEqual(t.word("siti").segments, ("s", "i", "t", "i"))

    def test_digit_names_are_explicit_not_cardinal_claim(self):
        with self.assertRaises(t.UnsupportedTonganInput): t.encoded("12")
        self.assertIn(t.word("taha").encoded, t.encoded("1", digits=True))
        self.assertIn(t.word("fā").encoded, t.encoded("4", digits=True))

    def test_rejects_foreign_unknown_or_invalid_sequences(self):
        for text in ("hello", "Tonga2026", "ā̀", "tánga", "ng", "xyz", "mā́´"):
            with self.subTest(text=text), self.assertRaises(t.UnsupportedTonganInput): t.word(text)

    def test_separators_prevent_accidental_diphthong_mnemonic(self):
        self.assertEqual(t.word("ngatu").encoded, "[['N|a|t|u]]")
        self.assertIn("a|u", t.word("tau").encoded)
        self.assertTrue(all(ord(c) < 128 for c in t.encoded("Mālō e lelei.")))

    def test_all_17_ordinary_names_are_explicit_names_not_example_words(self):
        data = json.loads(Path(__file__).with_name("tongan_letter_names.json").read_text())
        names = data["letter_names"]
        self.assertEqual(len(names), 17)
        self.assertEqual(names["f"], "fa")
        self.assertNotEqual(names["f"], "fale")
        self.assertEqual(names["ng"], "nga")
        self.assertEqual(names["ʻ"], "fakauʻa")
        for name in names.values():
            self.assertTrue(t.word(name).mora_positions)


if __name__ == "__main__": unittest.main()
