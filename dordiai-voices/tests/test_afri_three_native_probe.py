import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location("afri_three_tested",Path(__file__).resolve().parents[1]/"tools/research/afri_three_native_probe.py")
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)

class ThreeNativeTests(unittest.TestCase):
    def fixture(self):
        return "\n".join(code+"\tWord"+str(i)+" text\tipa"+str(i)+" suffix"
                         for code in ("zul","nso","wol") for i in range(4))

    def test_nine_cases_exact_three_languages_without_neighbour_alias(self):
        rows=mod.select_cases(self.fixture())
        self.assertEqual(len(rows),9)
        self.assertEqual([row["language"] for row in rows],["zul"]*3+["nso"]*3+["wol"]*3)
        self.assertEqual(rows[2]["text"],"Word2 text")
        self.assertNotIn("ssw",{row["language"] for row in rows})

    def test_missing_native_fixtures_fail(self):
        with self.assertRaisesRegex(ValueError,"wol"):
            mod.select_cases("\n".join(line for line in self.fixture().splitlines() if not line.startswith("wol\t")))

    def test_native_word_requires_whole_fixture_and_exact_aligned_ipa(self):
        row={"language":"zul","text":"Usizo lomoya","expected_training_ipa":"usizo lomoja"}
        word=mod.first_word(row)
        def g2p(text,language,output):
            return {"Usizo lomoya":"usizo lomoja","Usizo":"usizo"}[text]
        self.assertEqual(mod.check_ipa(word,g2p),"usizo")
        with self.assertRaises(ValueError):
            mod.check_ipa(word,lambda text,language,output:"English fallback")
        self.assertEqual(word["source_fixture_text"],row["text"])

    def test_native_metadata_hours_and_explicit_pending_scope(self):
        self.assertEqual(mod.LANGUAGES["wol"]["trained_hours"],0.56)
        self.assertEqual(mod.LANGUAGES["nso"]["selected_code"],"nso")
        self.assertIn("Wolof",mod.CAUTIONS[0])
        self.assertIn("below2h",mod.CAUTIONS[0])

    def test_no_ambiguous_punctuated_first_token(self):
        with self.assertRaises(ValueError):
            mod.first_word({"language":"wol","text":"Bul, yem","expected_training_ipa":"bul jɛm"})

if __name__=="__main__":unittest.main()
