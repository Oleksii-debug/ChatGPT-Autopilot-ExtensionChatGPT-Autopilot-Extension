"""Data-only Arabic ordinary names: native facts do not imply typing readiness."""
import importlib.util
import json
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
RUNTIME=ROOT/'source/0.12.2/kx47Runtime';DIRECTORY=RUNTIME/'models/CharacterNames'
spec=importlib.util.spec_from_file_location('_ar_ordinary_dispatch',RUNTIME/'character_names.py');names=importlib.util.module_from_spec(spec);spec.loader.exec_module(names)

class ArabicOrdinaryDispatch(unittest.TestCase):
    def setUp(self):names.clear_cache()
    def tearDown(self):names.clear_cache()
    def candidate(self):return json.loads((ROOT/'tools/research/ar_ordinary_name_candidate.json').read_text(encoding='utf-8'))
    def test_all29_primary_names_resolve_as_ordinary_names_in_actual_runtime(self):
        expected=self.candidate()['letter_names'];self.assertEqual(len(expected),29)
        for glyph,text in expected.items():
            with self.subTest(glyph=glyph):
                self.assertEqual(names.spoken_name('ar',glyph,directory=DIRECTORY),text)
                self.assertEqual(names.spoken_name('ar-EG',glyph,directory=DIRECTORY),text)
        self.assertEqual(names.spoken_name('ar','ل',directory=DIRECTORY),'لام')
    def test_29_bank_plans_keep_exact_glyph_and_spoken_name_semantics(self):
        d=names.data('ar',DIRECTORY);entries={r['lookup_text']:r for r in d['bank_entries']}
        self.assertEqual(len(d['ordinary_alphabet_source_repertoire']),29)
        self.assertTrue(d['ordinary_alphabet_source_complete'])
        for glyph,text in self.candidate()['letter_names'].items():
            with self.subTest(glyph=glyph):
                row=entries[glyph];self.assertEqual(row['text'],text)
                self.assertEqual(row['semantic_kind'],'spoken_name');self.assertEqual(row['source_kind'],'letter_name')
                self.assertEqual(row['source_id'],'curated_primary_alphabet_names');self.assertEqual(row['acoustic_validation'],'pending')
    def test_upstream_ampersand_alias_cannot_overwrite_waw_ordinary_name(self):
        d=names.data('ar',DIRECTORY);entries={r['lookup_text']:r for r in d['bank_entries']}
        self.assertEqual(entries['و']['text'],'واو')
        self.assertEqual(d['symbol_names']['&'],'و')
        self.assertNotIn('و',entries['&']['aliases'])
        self.assertEqual(names.spoken_name('ar','و',directory=DIRECTORY),'واو')
        self.assertEqual(names.spoken_name('ar','&',directory=DIRECTORY),'و')
    def test_phonetic_examples_unknown_forms_and_english_candidates_never_become_alphabet_names(self):
        d=names.data('ar',DIRECTORY)
        for glyph in ['أ','إ','آ','ؤ','ئ','ة','ى','ـ','a','qq']:
            self.assertNotIn(glyph,d['letter_names'])
            with self.subTest(glyph=glyph),self.assertRaises(LookupError):names.spoken_name('ar',glyph,directory=DIRECTORY)
        self.assertIn('أرنب',d['phonetic_descriptions']['أ'])
        self.assertNotEqual(names.spoken_name('ar','ا',directory=DIRECTORY),'أرنب')
        self.assertNotIn('@',d['symbol_names']);self.assertEqual(d['unreviewed_symbol_candidates']['@']['name'],'at')
    def test_pinned_native_symbol_sources_preserved_and_english_only_candidates_excluded(self):
        d=names.data('ar',DIRECTORY)
        self.assertEqual(len(d['symbol_names']),1967)
        self.assertEqual(d['sources']['cldr_annotations']['sha256'],'f6f32e3b3352162e435fa1e26141d2508990fef17ac74d9fa120feaa9b6957ff')
        self.assertEqual(d['sources']['cldr_characters']['sha256'],'1f6837bfe1aa1443b04f5588cc841fb5975cf1965f85c83b25d3a7aa70ff98d5')
        self.assertEqual(d['sources']['nvda_symbols']['sha256'],'e07a1458871b33b5faaf3a4bd60ee6384639b6f55d50a4920f245ca8e69d34cf')
        self.assertEqual(len(d['unreviewed_symbol_candidates']),5)
    def test_full_source_and_actual_pcm_do_not_promote_listener_nvda_typing_or_bank_readiness(self):
        d=names.data('ar',DIRECTORY);source=d['sources']['curated_primary_alphabet_names']
        self.assertEqual(source['sha256'],'940efb9723bab5f877c08dbb1f8bddfd8c79cfb62430c6e5874335406d91a385')
        proof=source['technical_name_pcm_proof'];self.assertEqual(proof['source_names_rendered'],29)
        self.assertEqual(proof['raw_report_git_blob'],'870e6d96d091e83f275b0666de2ef074ad6ca053')
        self.assertTrue(proof['native_and_viktoriia_finite_pcm'])
        for field in ['native_pronunciation_verified','listener_pronunciation_verified','windows_nvda_verified','typing_verified','physical_audio_verified']:self.assertFalse(proof[field])
        self.assertFalse(d['letter_names_ready']);self.assertFalse(d['semantics']['native_pronunciation_verified'])
if __name__=='__main__':unittest.main()
