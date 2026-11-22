"""Synthetic metadata/PCM fixtures; not a native-model or source-corpus proof."""
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
import wave
import zipfile

PATH = Path(__file__).resolve().parents[1] / 'tools/research/audit_nbl_lwazi.py'
spec = importlib.util.spec_from_file_location('nbl_lwazi_audit_test', PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def grid(end=2.0):
    result = 'File type = "ooTextFile"\nObject class = "TextGrid"\nitem []:\n'
    for i, name in enumerate(['segment', 'word', 'text'], 1):
        label = 'a' if name != 'text' else 'Literal "quoted" source'
        result += (f' item [{i}]:\n class = "IntervalTier"\n name = "{name}"\n'
                   f' intervals: size = 1\n intervals [1]:\n xmin = 0\n xmax = {end}\n text = "{label}"\n')
    return result.encode('utf-8')


def pcm(seconds=2, zero=False):
    f = io.BytesIO()
    with wave.open(f, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes((b'\x00\x00' if zero else b'\x01\x00') * int(seconds * 16000))
    return f.getvalue()


def archive(path, text='Siyathokoza.', ident='data_0001', **kwargs):
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('transcriptions', f'( {ident} "{text}" )\n')
        z.writestr('recordings/' + ident + '.wav', pcm(**kwargs))
        z.writestr('alignments/' + ident + '.TextGrid', grid(kwargs.get('seconds', 2)))
        z.writestr('LICENSE.txt', 'Synthetic test fixture, not real corpus licensing.')


class AuditTests(unittest.TestCase):
    def test_exact_language_identity_pins(self):
        self.assertIn('nbl', m.PINS['lwazi1']['name'])
        self.assertEqual(m.PINS['lwazi2']['size_bytes'], 236594963)

    def test_source_hashes_reject_synthetic_data(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'fake.zip'; archive(p)
            with self.assertRaisesRegex(ValueError, 'Source differs'):
                m.verify(p, 'lwazi2')

    def test_transcript_inner_quotes_are_literal(self):
        self.assertEqual(m.transcripts(b'( data_1 "Igama \\"nbl\\"." )'.replace(b'\\"', b'"'))['data_1'], 'Igama "nbl".')

    def test_publisher_english_ids_remain_distinct(self):
        self.assertEqual(set(m.transcripts(b'( data_1 "A" )\n( eng_1 "|B" )')), {'data_1', 'eng_1'})

    def test_duplicate_transcripts_rejected(self):
        with self.assertRaises(ValueError):m.transcripts(b'( data_1 "A" )\n( data_1 "B" )')

    def test_unknown_id_prefix_rejected(self):
        with self.assertRaises(ValueError):m.transcripts(b'( nde_1 "A" )')

    def test_textgrid_literal_quote_tolerance(self):
        self.assertEqual(m.tiers(grid())['text'][0][2], 'Literal "quoted" source')

    def test_interval_count_is_checked(self):
        with self.assertRaises(ValueError):m.tiers(grid().replace(b'size = 1', b'size = 2'))

    def test_nonfinite_or_negative_bounds_rejected(self):
        for value in ['nan', 'inf', '-1']:
            with self.subTest(value=value), self.assertRaises(ValueError):m.tiers(grid(value))

    def test_missing_word_alignment_rejected(self):
        with self.assertRaises(ValueError):m.tiers(grid().replace(b'name = "word"', b'name = "other"'))

    def test_unsafe_archive_member_rejected(self):
        for name in ['../escape', '/escape', 'C:/escape', 'a\\escape']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as d:
                p = Path(d) / 'bad.zip'
                with zipfile.ZipFile(p, 'w') as z:z.writestr(name, b'x')
                with zipfile.ZipFile(p) as z,self.assertRaises(ValueError):m.checked_members(z)

    def test_paired_audio_and_alignment_checked(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'test.zip';archive(p)
            audit, rows = m.audit_tts(p)
            self.assertEqual(audit['paired_utterances'],1)
            self.assertEqual(audit['mechanically_eligible_utterances'],1)
            self.assertEqual(audit['seconds'],2)
            self.assertEqual(audit['textgrid_literal_unescaped_quote_lines'],1)
            self.assertEqual(rows[0]['text_key'],'siyathokoza.')
            self.assertNotIn('native_readiness',audit)

    def test_english_secondary_speech_not_native_training(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'test.zip';archive(p,text='|hello',ident='eng_001')
            audit,_=m.audit_tts(p)
            self.assertEqual(audit['mechanically_eligible_utterances'],0)
            self.assertEqual(audit['rejection_reason_counts']['publisher_marked_English_word'],1)

    def test_silent_and_too_short_source_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'test.zip';archive(p,seconds=.5,zero=True)
            audit,_=m.audit_tts(p)
            self.assertEqual(audit['mechanically_eligible_utterances'],0)
            self.assertEqual(set(audit['rejection_reason_counts']),{'outside_1_30_seconds','all_zero_pcm'})

    def test_unicode_number_not_sent_for_training(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'test.zip';archive(p,text='½')
            audit,_=m.audit_tts(p)
            self.assertEqual(audit['mechanically_eligible_utterances'],0)

    def test_case_punctuation_and_spacing_stay_same_holdout_group(self):
        self.assertEqual(m.word_sequence(' ISINdebele,  siyathokoza! '),m.word_sequence('isindebele siyathokoza.'))

    def test_partition_keeps_duplicate_groups_together(self):
        rows=[dict(split_key='a b',mechanically_eligible=True,seconds=2),
              dict(split_key='a b',mechanically_eligible=True,seconds=3),
              dict(split_key='english',mechanically_eligible=False,seconds=4)]
        result=m.prospective_partition(rows)
        self.assertEqual(result['distinct_native_word_sequence_groups'],1)
        nonempty=[x for x in result['partition'].values() if x['utterances']]
        self.assertEqual(nonempty,[dict(groups=1,utterances=2,seconds=5)])


if __name__ == '__main__':unittest.main()
