"""Recent exact-word cache safety; fixtures are finite-set, not language accuracy claims."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import os
from pathlib import Path
from threading import Event
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runtime=load("recent_word_runtime_test",ROOT/"experiments/native-word-cache/native_word_membership.py")
builder=load("recent_word_builder_test",ROOT/"tools/build_native_word_membership.py")


class RecentWordCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name)
        self.path=self.root/"resource.bin"
        self.words={"голос":3,"кошками":2,"мама":3,"мови":1,"п'ять":1,"сёмга":2,"café":4}
        self.receipt=builder.write_memberships(self.path,
            sorted((word.encode("utf-8"),mask) for word,mask in self.words.items()),
            codes=("uk","ru","en"),block_words=1)

    def open(self,**kwargs):
        reader=runtime.MembershipLexicon(self.path,self.receipt["sha256"],**kwargs)
        self.addCleanup(reader.close)
        return reader

    def change(self):
        raw=self.path.read_bytes()
        # Never truncate/resize an actively mapped file: Windows correctly
        # rejects that operation. Modify one existing byte without resizing.
        with self.path.open("r+b") as stream:
            stream.seek(-1,os.SEEK_END)
            stream.write(bytes([raw[-1]^1]))
            stream.flush()
        info=self.path.stat()
        os.utime(self.path,ns=(info.st_atime_ns,info.st_mtime_ns+10000000))

    def test_hit_retains_all_shared_memberships_and_avoids_block_lookup(self):
        reader=self.open()
        expected=reader.candidates("мама")
        self.assertEqual(expected,frozenset(("uk","ru")))
        with patch.object(reader,"_block",side_effect=AssertionError("Repeated word inflated a block")):
            actual=reader.candidates("МАМА")
        self.assertIs(actual,expected)
        self.assertIsInstance(actual,frozenset)
        self.assertEqual(reader.statistics()["word_cache_hits"],1)

    def test_valid_unknown_empty_set_is_cached_without_becoming_a_guess(self):
        reader=self.open()
        self.assertEqual(reader.candidates("мовиб"),frozenset())
        with patch.object(reader,"_block",side_effect=AssertionError("Unknown hit decoded again")):
            self.assertEqual(reader.candidates("мовиб"),frozenset())
        self.assertEqual(reader.statistics()["word_cache_hits"],1)

    def test_cyrillic_acute_case_normalization_keeps_yo_and_latin_accents_distinct(self):
        reader=self.open()
        self.assertEqual(reader.candidates("СЁМГА"),frozenset(("ru",)))
        self.assertEqual(reader.candidates("сё\u0301мга"),frozenset(("ru",)))
        self.assertEqual(reader.statistics()["word_cache_hits"],1)
        self.assertEqual(reader.candidates("семга"),frozenset())
        self.assertEqual(reader.candidates("café"),frozenset(("en",)))
        self.assertEqual(reader.candidates("cafe"),frozenset())

    def test_entry_and_byte_budgets_evict_least_recent_words(self):
        reader=self.open(word_cache_entries=2,word_cache_bytes=2000)
        for word in ("голос","мама","голос","мови"):
            self.assertTrue(reader.candidates(word))
        info=reader.statistics()
        self.assertEqual(info["cached_words"],2)
        self.assertGreaterEqual(info["word_cache_evictions"],1)
        self.assertLessEqual(info["word_cache_bytes_charged"],2000)
        self.assertIn("голос".encode(),reader._word_cache)
        self.assertNotIn("мама".encode(),reader._word_cache)

    def test_small_byte_budget_does_not_cache_oversized_entry_or_change_result(self):
        reader=self.open(word_cache_bytes=1)
        self.assertEqual(reader.candidates("мама"),frozenset(("uk","ru")))
        self.assertEqual(reader.statistics()["cached_words"],0)
        self.assertEqual(reader.statistics()["word_cache_bytes_charged"],0)

    def test_zero_entry_control_repeats_real_lookup_without_word_hits(self):
        reader=self.open(word_cache_entries=0)
        with patch.object(reader,"_block",wraps=reader._block) as block:
            for _ in range(4):
                self.assertEqual(reader.candidates("мама"),frozenset(("uk","ru")))
        self.assertEqual(block.call_count,4)
        self.assertEqual(reader.statistics()["cached_words"],0)
        self.assertEqual(reader.statistics()["word_cache_hits"],0)
        self.assertEqual(reader.statistics()["word_cache_misses"],4)

    def test_zero_byte_control_disables_word_cache(self):
        reader=self.open(word_cache_bytes=0)
        reader.candidates("мама")
        reader.candidates("мама")
        self.assertEqual(reader.statistics()["cached_words"],0)
        self.assertEqual(reader.statistics()["word_cache_hits"],0)

    def test_cancellation_on_hit_cannot_publish_cached_result(self):
        reader=self.open()
        reader.candidates("мама")
        calls=[]
        def cancelled():
            calls.append(None)
            return len(calls)>=2
        with self.assertRaises(runtime.LexiconCancelled):
            reader.candidates("мама",cancelled=cancelled)
        self.assertEqual(len(calls),2)
        self.assertEqual(reader.statistics()["word_cache_hits"],0)

    def test_changed_resource_on_hit_raises_and_clears_word_cache(self):
        reader=self.open()
        reader.candidates("мама")
        self.change()
        with self.assertRaises(runtime.StaleLexiconError):
            reader.candidates("мама")
        self.assertEqual(reader.statistics()["cached_words"],0)
        self.assertEqual(reader.statistics()["word_cache_bytes_charged"],0)

    def test_second_epoch_check_on_hit_catches_change_during_callback(self):
        reader=self.open()
        reader.candidates("мама")
        calls=[]
        def cancelled():
            calls.append(None)
            if len(calls)==2:
                self.change()
            return False
        with self.assertRaises(runtime.StaleLexiconError):
            reader.candidates("мама",cancelled=cancelled)
        self.assertEqual(reader.statistics()["word_cache_hits"],0)
        self.assertEqual(reader.statistics()["cached_words"],0)

    def test_replacement_is_rejected_or_os_prevents_replacing_live_mapping(self):
        reader=self.open()
        reader.candidates("мама")
        replacement=self.root/"replacement.bin"
        replacement.write_bytes(self.path.read_bytes())
        try:
            os.replace(replacement,self.path)
        except PermissionError:
            self.assertEqual(os.name,"nt")
            self.assertEqual(reader.candidates("мама"),frozenset(("uk","ru")))
        else:
            with self.assertRaises(runtime.StaleLexiconError):
                reader.candidates("мама")
            self.assertEqual(reader.statistics()["cached_words"],0)

    def test_close_clears_cache_and_never_returns_old_hit(self):
        reader=self.open()
        reader.candidates("мама")
        self.assertEqual(reader.statistics()["cached_words"],1)
        reader.close()
        reader.close()
        self.assertEqual(reader.statistics()["cached_words"],0)
        self.assertEqual(reader.statistics()["word_cache_bytes_charged"],0)
        with self.assertRaises(runtime.LexiconError):
            reader.candidates("мама")

    def test_concurrent_close_waits_for_owned_hit_then_releases_cache(self):
        reader=self.open()
        expected=reader.candidates("мама")
        entered,release,closing=Event(),Event(),Event()
        def cancelled():
            if not entered.is_set():
                entered.set()
                if not release.wait(3):
                    raise AssertionError("Controlled cache-hit wait timed out")
            return False
        def close():
            closing.set()
            reader.close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            hit=pool.submit(reader.candidates,"мама",cancelled=cancelled)
            self.assertTrue(entered.wait(3))
            stop=pool.submit(close)
            self.assertTrue(closing.wait(3))
            self.assertFalse(stop.done())
            release.set()
            self.assertEqual(hit.result(timeout=3),expected)
            stop.result(timeout=3)
        self.assertTrue(reader.statistics()["closed"])
        self.assertEqual(reader.statistics()["cached_words"],0)

    def test_limits_are_explicit_and_oversized_invalid_input_is_not_retained(self):
        for kwargs in ({"word_cache_entries":True},{"word_cache_entries":4097},
                       {"word_cache_bytes":True},{"word_cache_bytes":4194305}):
            with self.subTest(kwargs=kwargs),self.assertRaises(runtime.LexiconError):
                self.open(**kwargs)
        reader=self.open()
        for word in ("with spaces","x"*10000,""):
            self.assertEqual(reader.candidates(word),frozenset())
        self.assertEqual(reader.statistics()["cached_words"],0)


if __name__=="__main__":
    unittest.main()
