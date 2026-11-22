"""Finite dictionary provenance and ambiguity checks; no acoustic claim."""
import importlib.util
import os
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("_cs_sk_native_probe_test", ROOT / "tools/research/probe_hunspell_cs_sk.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FiniteInputTests(unittest.TestCase):
    def test_flags_and_morphology_cannot_leak_into_spelling(self):
        self.assertEqual(m.dictionary_stem("kůň/AB\tpo:noun st:kůň"), "kůň")
        self.assertEqual(m.dictionary_stem("žena po:noun"), "žena")
        self.assertEqual(m.dictionary_stem(""), "")

    def test_escaped_delimiters_do_not_change_word_boundary(self):
        self.assertEqual(m.dictionary_stem(r"word\/part/A"), "word/part")
        self.assertEqual(m.dictionary_stem(r"word\\/A"), "word\\")
        with self.assertRaises(ValueError):
            m.dictionary_stem("word\\")
        with self.assertRaises(ValueError):
            m.dictionary_stem(r"word\q/A")

    def test_oversized_entry_cannot_reach_native_engine(self):
        with self.assertRaises(ValueError):
            m.dictionary_stem("a" * 4097)

    def test_output_cannot_replace_source_tree_or_existing_work(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            sources = root / "sources"
            sources.mkdir()
            for output in (sources, sources / "result", root):
                with self.subTest(output=output), self.assertRaises(ValueError):
                    m.run(sources, Path(__file__), output)
            with self.assertRaises(ValueError):
                m.run(sources, Path(__file__), ROOT / "source" / "candidate")

    def test_linked_primary_source_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "real").write_bytes(b"not original dictionary bytes")
            try:
                (root / "linked").symlink_to(root / "real")
            except OSError:
                self.skipTest("This process cannot create symlinks")
            with self.assertRaises(ValueError):
                m.fingerprint(root / "linked")


@unittest.skipUnless(os.environ.get("CS_SK_SOURCE_DIRECTORY") and os.environ.get("CS_SK_HUNSPELL_LIBRARY"),
                     "Exact native library and original sources supplied to dedicated experiment")
class ActualNativePrimaryTests(unittest.TestCase):
    def test_actual_shared_exclusive_and_unknown_memberships(self):
        source = Path(os.environ["CS_SK_SOURCE_DIRECTORY"])
        before = m.verify_sources(source)
        native = m.NativeDictionaries(Path(os.environ["CS_SK_HUNSPELL_LIBRARY"]).resolve(), source)
        try:
            for word, labels in (("žena", {"cs", "sk"}), ("škola", {"cs", "sk"}),
                                 ("kůň", {"cs"}), ("kôň", {"sk"}), ("řeka", {"cs"}),
                                 ("rieka", {"sk"}), ("nejkrásnější", {"cs"}),
                                 ("najkrajší", {"sk"}), ("qzxqzxqzx", set())):
                with self.subTest(word=word):
                    self.assertEqual(native.candidates(word), frozenset(labels))
        finally:
            native.close()
        self.assertFalse(native.handles)
        self.assertEqual(m.verify_sources(source), before)

    def test_mutated_original_source_cannot_be_used(self):
        source = Path(os.environ["CS_SK_SOURCE_DIRECTORY"])
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            first = next(iter(m.PINS))
            target = root / first
            target.parent.mkdir()
            raw = (source / first).read_bytes()
            target.write_bytes(raw[:-1] + bytes([raw[-1] ^ 1]))
            with self.assertRaisesRegex(ValueError, "Pinned primary source differs"):
                m.verify_sources(root)
