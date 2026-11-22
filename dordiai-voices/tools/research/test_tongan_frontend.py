"""Source-backed contrasts for the isolated strict Tongan phonemic frontend."""
import json
from pathlib import Path
import unittest
import tongan_frontend as t

class TonganTests(unittest.TestCase):
    def test_glottal_is_real_consonant_and_ng_one_native_unit(self):
        self.assertEqual(t.word("ʻuma").ipa,"ˈʔuma")
        self.assertEqual(t.word("uma").ipa,"ˈuma")
        for variant in t.GLOTTALS:
            self.assertEqual(t.word(variant+"alu").segments[0],"ʔ")
        self.assertEqual(t.word("ngatu").segments,("ŋ","a","t","u"))

    def test_all_five_macrons_one_phone_two_moras_not_two_nuclei(self):
        for short,long in zip("aeiou","āēīōū"):
            with self.subTest(short=short):
                a=t.word("k"+long);b=t.word("k"+short+short)
                self.assertEqual(a.segments,("k",short+"ː"))
                self.assertEqual(a.mora_positions,(1,1))
                self.assertEqual(a.syllable_nuclei,(1,))
                self.assertEqual(b.segments,("k",short,short))
                self.assertEqual(b.mora_positions,(1,2))
                self.assertEqual(b.syllable_nuclei,(1,2))
                self.assertNotEqual(a.encoded,b.encoded)
                self.assertIn("|:",a.encoded)
                self.assertEqual(len(a.mora_positions),len(b.mora_positions))

    def test_previous_exact_macron_double_collision_is_removed(self):
        long=t.word("māma");double=t.word("maama")
        self.assertEqual(long.ipa,"ˈmaːma")
        self.assertEqual(double.ipa,"maˈama")
        self.assertNotEqual(long.encoded,double.encoded)
        self.assertEqual(long.mora_positions,(1,1,3))
        self.assertEqual(double.mora_positions,(1,2,4))

    def test_primary_2010_native_length_examples_stay_distinct(self):
        words=[t.word(text) for text in ("mama","māmā","maama")]
        self.assertEqual(len({word.encoded for word in words}),3)
        self.assertEqual([len(word.syllable_nuclei) for word in words],[2,2,3])
        self.assertEqual([len(word.mora_positions) for word in words],[2,4,3])

    def test_stress_maps_to_head_of_long_syllable(self):
        self.assertEqual(t.word("kaka").ipa,"ˈkaka")
        self.assertEqual(t.word("kakā").ipa,"kaˈkaː")
        self.assertEqual(t.word("kākā").ipa,"kaːˈkaː")
        self.assertEqual(t.word("kākā").stress_position,2)
        self.assertEqual(t.word("kākā").mora_positions,(1,1,3,3))

    def test_definitive_short_final_adds_distinct_mora(self):
        plain=t.word("tangata");marked=t.word("tangatá")
        self.assertEqual(marked.ipa,"taŋaˈta.a")
        self.assertEqual(len(marked.mora_positions),len(plain.mora_positions)+1)
        self.assertNotEqual(marked.encoded,t.word("tangatā").encoded)
        self.assertEqual(t.encoded("falé"),t.encoded("fale´"))

    def test_marked_already_long_final_is_explicitly_unresolved(self):
        value=t.word("kākā́")
        self.assertIn("definitive-accent-on-already-long-vowel",value.unresolved)
        with self.assertRaises(t.UnsupportedTonganInput) as got:t.encoded("kākā́")
        self.assertIn("definitive-accent-on-already-long-vowel",got.exception.reasons)

    def test_nfc_nfd_and_case_keep_exact_native_structure(self):
        self.assertEqual(t.word("a\u0304").segments,t.word("Ā").segments)
        self.assertEqual(t.word("kākā").graphemes,("k","ā","k","ā"))
        self.assertEqual(t.encoded("MĀMA"),t.encoded("māma"))

    def test_unmarked_different_vowel_grouping_fails_closed_by_default(self):
        for text in ("tau","lelei","fakauʻa"):
            with self.subTest(text=text):
                analysed=t.word(text)
                self.assertIn("unmarked-vowel-grouping",analysed.unresolved)
                with self.assertRaises(t.UnsupportedTonganInput) as got:t.encoded(text)
                self.assertIn("unmarked-vowel-grouping",got.exception.reasons)
                self.assertTrue(t.encoded(text,allow_ambiguous_phonology=True).startswith("[["))

    def test_research_opt_in_never_bypasses_native_character_guards(self):
        for text in ("hello","café","xyz","Tonga2026","ā̀","tánga","ng","mā́´","[english]","<voice>","a\0b","a_"):
            for allow in (False,True):
                with self.subTest(text=text,allow=allow),self.assertRaises(t.UnsupportedTonganInput):
                    t.encoded(text,allow_ambiguous_phonology=allow)

    def test_explicit_marked_enclitic_preserves_one_stress_domain(self):
        value=t.text_words("fale´ u")[0]
        self.assertEqual(value.marked_accent,"enclitic")
        self.assertEqual(value.mora_positions,(1,3,4))
        self.assertEqual(value.encoded,"[[f|a|'l|e|u]]")
        self.assertNotIn("unmarked-connected-clitic-domain",value.unresolved)

    def test_unmarked_connected_one_mora_domain_rejected(self):
        with self.assertRaises(t.UnsupportedTonganInput) as got:t.encoded("e fale")
        self.assertIn("unmarked-connected-clitic-domain",got.exception.reasons)
        self.assertTrue(t.encoded("e").startswith("[["))

    def test_digit_names_explicit_not_invented_cardinal_grammar(self):
        with self.assertRaises(t.UnsupportedTonganInput):t.encoded("12")
        self.assertEqual(t.encoded("1",digits=True).strip(),t.encoded("taha"))
        self.assertEqual(t.encoded("4",digits=True).strip(),t.encoded("fā"))
        with self.assertRaises(t.UnsupportedTonganInput):t.encoded("１",digits=True)

    def test_no_empty_oversized_or_implicit_nonstring_text(self):
        for text in ("","a"*(t.MAX_TEXT+1)):
            with self.assertRaises(t.UnsupportedTonganInput):t.encoded(text)
        for text in (None,123,["a"]):
            with self.assertRaises(TypeError):t.encoded(text)

    def test_ordinary_names_are_names_and_unresolved_capability_not_hidden(self):
        data=json.loads(Path(__file__).with_name("tongan_letter_names.json").read_text(encoding="utf-8"))
        names=data["letter_names"]
        self.assertEqual(len(names),17)
        self.assertEqual(names["f"],"fa");self.assertNotEqual(names["f"],"fale")
        self.assertEqual(names["ng"],"nga");self.assertEqual(names["ʻ"],"fakauʻa")
        ready=0
        for value in names.values():
            try:t.encoded(value);ready+=1
            except t.UnsupportedTonganInput:pass
        self.assertEqual(ready,16) # fakauʻa grouping remains explicitly unreviewed.

    def test_serialized_analysis_exposes_hypothesis_and_limits(self):
        doc=t.word("tau").describe()
        self.assertIn("encoded_hypothesis",doc)
        self.assertFalse(doc["strictly_renderable"])
        self.assertIn("unmarked-vowel-grouping",doc["unresolved"])

class ProjectionWaveRateTests(unittest.TestCase):
    def test_real_tone_export_keeps_decoder_samples_true_rate_pitch_and_duration(self):
        import importlib.util
        import tempfile
        import numpy as np
        import wave
        path=Path(__file__).with_name("probe_tongan_windows.py")
        spec=importlib.util.spec_from_file_location("tongan_projection_rate_test",path)
        probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
        frames=22050
        tone=(.125*np.sin(2*np.pi*440*np.arange(frames)/22050)).astype(np.float32)
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/"converter.wav"
            facts=probe.write_converted_wave(target,tone,np)
            with wave.open(str(target),"rb") as stream:
                self.assertEqual(stream.getframerate(),22050)
                self.assertEqual(stream.getnframes(),frames)
                self.assertEqual(stream.getnchannels(),1)
                self.assertEqual(stream.getsampwidth(),2)
            actual,rate=probe.read_wave(target,np)
            self.assertEqual(len(actual),len(tone))
            self.assertEqual(len(actual)/rate,1.)
            self.assertLessEqual(float(np.max(np.abs(actual-tone))),1/32768.)
            cycles=int(np.count_nonzero((actual[:-1]<=0)&(actual[1:]>0)))
            self.assertAlmostEqual(cycles/(len(actual)/rate),440,delta=1)
            self.assertEqual(facts["decoder_output_sample_rate"],rate)
            self.assertEqual(facts["projected_wav_sample_rate"],rate)
            self.assertFalse(facts["projection_resampled"])

if __name__=="__main__":unittest.main()
