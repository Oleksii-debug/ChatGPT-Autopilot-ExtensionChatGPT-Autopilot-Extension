"""Synthetic source/range/partition fixtures; no model or real-corpus claim."""
from collections import Counter
from copy import deepcopy
from hashlib import sha256
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("word_acquisition_v3", ROOT / "tools/acquire_word_lid_v3.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
runtime_spec = importlib.util.spec_from_file_location("native_policy_fixture", ROOT / "tools/vendor/word_classifier_native_policy_5e532.py")
runtime = importlib.util.module_from_spec(runtime_spec)
runtime_spec.loader.exec_module(runtime)


class Response(io.BytesIO):
    def __init__(self, payload, start, end, total, status=206):
        super().__init__(payload)
        self.status = status
        self.headers = {"Content-Range": "bytes %d-%d/%d" % (start, end, total)}
    def geturl(self):
        return "https://cdn-lfs.hf.co/public-synthetic-source"
    def getcode(self):
        return self.status


class Helper:
    @staticmethod
    def verify_source(path, row):
        raw = path.read_bytes()
        if len(raw) != row["bytes"] or sha256(raw).hexdigest() != row["sha256"]:
            raise ValueError("Source checksum differs")
        return {"id": row["id"], "sha256": row["sha256"], "bytes": len(raw)}


class AcquisitionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cache = self.root / "cache"
        self.cache.mkdir()
        self.payload = b"synthetic immutable source bytes"
        self.row = {"id": "synthetic", "bytes": len(self.payload),
                    "sha256": sha256(self.payload).hexdigest(),
                    "url": "https://huggingface.co/datasets/wikimedia/wikipedia/resolve/" + "a"*40 + "/source"}
        self.calls = []

    def opener(self, request, timeout):
        start, end = map(int, request.headers["Range"].removeprefix("bytes=").split("-"))
        self.calls.append((start, end))
        return Response(self.payload[start:end+1], start, end, len(self.payload))

    def test_real_range_bytes_and_whole_checksum_are_both_recorded(self):
        path, receipt = m.acquire_wikipedia(self.row, self.cache, Helper, self.opener)
        self.assertEqual(path.read_bytes(), self.payload)
        self.assertEqual(self.calls, [(0, len(self.payload)-1)])
        self.assertEqual(receipt["transfer"]["network_bytes"], len(self.payload))
        self.assertTrue(receipt["transfer"]["whole_shard_sha256_verified"])
        self.assertEqual(receipt["transfer"]["ranges"][0]["sha256"], self.row["sha256"])

    def test_verified_cache_reuse_does_not_repeat_download(self):
        m.acquire_wikipedia(self.row, self.cache, Helper, self.opener)
        _, receipt = m.acquire_wikipedia(self.row, self.cache, Helper, lambda *a, **k: self.fail("Network repeated"))
        self.assertEqual(receipt["transfer"]["network_bytes"], 0)
        self.assertEqual(receipt["transfer"]["mode"], "verified-cache")

    def test_content_range_mismatch_fails_without_publishing(self):
        def wrong(request, timeout):
            response = self.opener(request, timeout)
            response.headers["Content-Range"] = "bytes 1-4/100"
            return response
        with self.assertRaisesRegex(ValueError, "range identity"):
            m.acquire_wikipedia(self.row, self.cache, Helper, wrong)
        self.assertFalse((self.cache / "synthetic.source").exists())

    def test_partial_bytes_do_not_establish_full_shard_identity(self):
        def truncated(request, timeout):
            response = self.opener(request, timeout)
            return Response(self.payload[:-1], 0, len(self.payload)-1, len(self.payload))
        with self.assertRaisesRegex(ValueError, "Truncated"):
            m.acquire_wikipedia(self.row, self.cache, Helper, truncated)
        self.assertFalse((self.cache / "synthetic.source").exists())

    def test_wrong_hash_never_enters_cache(self):
        self.row["sha256"] = "0"*64
        with self.assertRaisesRegex(ValueError, "checksum"):
            m.acquire_wikipedia(self.row, self.cache, Helper, self.opener)
        self.assertFalse((self.cache / "synthetic.source").exists())

    def test_bounded_server_full_response_is_honest_and_verified(self):
        def full(request, timeout):
            return Response(self.payload, 0, len(self.payload)-1, len(self.payload), status=200)
        _, receipt = m.acquire_wikipedia(self.row, self.cache, Helper, full)
        self.assertEqual(receipt["transfer"]["ranges"][0]["response_mode"], "server-full-response")

    def test_non_primary_redirect_and_oversized_response_rejected(self):
        def foreign(request, timeout):
            response = self.opener(request, timeout)
            response.geturl = lambda: "https://example.com/unknown"
            return response
        with self.assertRaisesRegex(ValueError, "left public"):
            m.acquire_wikipedia(self.row, self.cache, Helper, foreign)
        def oversized(request, timeout):
            return Response(self.payload + b"x", 0, len(self.payload)-1, len(self.payload))
        with self.assertRaisesRegex(ValueError, "exceeded"):
            m.acquire_wikipedia(self.row, self.cache, Helper, oversized)

    def test_native_family_separate_from_historical_other(self):
        row = {"native_families": ["ORIYA"], "expected_scripts": ["OTHER"]}
        counts = Counter()
        self.assertEqual(m.accepted_word("ଓଡ଼ିଆ", row, runtime, counts), runtime.normalize_word("ଓଡ଼ିଆ"))
        self.assertEqual(counts["legacy_script:OTHER"], 1)
        self.assertIsNone(m.accepted_word("தமிழ்", row, runtime, counts))
        self.assertEqual(counts["wrong_actual_native_family"], 1)

    def test_guarani_accents_and_creole_words_remain_native_latin(self):
        row = {"native_families": ["LATIN"], "expected_scripts": ["LATIN"]}
        for word in ("ñe’ẽ", "guaraníme", "kreyòl", "ayisyen"):
            with self.subTest(word=word):
                self.assertIsNotNone(m.accepted_word(word, row, runtime, Counter()))
        self.assertIsNone(m.accepted_word("слово", row, runtime, Counter()))

    def test_tokens_preserve_native_combining_marks_and_apostrophe(self):
        self.assertEqual(list(m.tokens("ñande, ñe’ẽ; ଓଡ଼ିଆ!")), ["ñande", "ñe’ẽ", "ଓଡ଼ିଆ"])

    def test_global_publisher_test_overrides_other_language_train(self):
        database = sqlite3.connect(":memory:")
        self.addCleanup(database.close)
        database.execute("CREATE TABLE evidence(word TEXT,language TEXT,role TEXT,PRIMARY KEY(word,language,role)) WITHOUT ROWID")
        m.add_rows(database, [("shared", "train"), ("nativeword", "train")], "gn")
        m.add_rows(database, [("shared", "test")], "ht")
        out = self.root / "output"
        out.mkdir()
        corpus, stats = m.write_corpus(database, out, lambda word: "train")
        import gzip
        with gzip.open(out / corpus["filename"], "rt", encoding="utf-8") as stream:
            header, *rows = [json.loads(line) for line in stream]
        shared = next(row for row in rows if row["word"] == "shared")
        self.assertEqual(shared["labels"], ["gn", "ht"])
        self.assertEqual(shared["publisher_role"], "test")
        self.assertEqual(shared["effective_pilot_split"], "test")
        self.assertEqual(stats["gn"]["effective_train_words_min4"], 1)
        self.assertEqual(stats["gn"]["effective_test_words_min4"], 1)
        self.assertTrue(header["not_consumable_as_current_v2_training_lock"])

    def test_short_words_do_not_count_towards_100_training_gate(self):
        database = sqlite3.connect(":memory:")
        self.addCleanup(database.close)
        database.execute("CREATE TABLE evidence(word TEXT,language TEXT,role TEXT,PRIMARY KEY(word,language,role)) WITHOUT ROWID")
        m.add_rows(database, [("a", "train"), ("ab", "train"), ("abc", "train"), ("native", "train")], "gn")
        out = self.root / "short"
        out.mkdir()
        _, stats = m.write_corpus(database, out, lambda word: "train")
        self.assertEqual(stats["gn"]["effective_train_words_min4"], 1)

    def test_split_is_globally_spelling_based_with_same_old_seed(self):
        self.assertEqual(m.split_word("KREYÒL", runtime), m.split_word("kreyòl", runtime))
        seed = "dordiai-word-split-v1:"
        bucket = int.from_bytes(sha256((seed+"kreyòl").encode("utf-8")).digest()[:4], "big") % 100
        self.assertEqual(m.split_word("kreyòl", runtime), "train" if bucket < 80 else "validation" if bucket < 90 else "test")

    def test_new_output_and_protected_source_paths(self):
        manifest = self.root / "manifest.json"
        manifest.write_text("{}", encoding="utf-8")
        with self.assertRaises(ValueError):
            m.safe_destinations(self.cache, ROOT / "source/generated", manifest)
        out = self.root / "already"
        out.mkdir()
        with self.assertRaises(FileExistsError):
            m.safe_destinations(self.cache, out, manifest)
        with self.assertRaises(ValueError):
            m.safe_destinations(self.cache, self.cache / "nested-output", manifest)

    def test_actual_locked_policy_and_preparer_git_objects(self):
        document = json.loads((ROOT / "tools/data/word_lid_sources_v3_acquisition.json").read_text(encoding="utf-8"))
        m.load_pinned(ROOT / "tools/vendor/word_classifier_native_policy_5e532.py",
                      "_test_v3_policy", document["runtime_git_blob"])
        m.load_pinned(ROOT / "tools/vendor/prepare_word_lid_sources_a6c01.py",
                      "_test_v3_preparer", document["preparer_git_blob"])
        self.assertEqual({row["language"] for row in m.validate_manifest(document)}, {"gn", "ht", "mni", "ks", "as", "or"})
        self.assertNotIn("sd", document["pilot_languages"])

    def test_custom_manifest_source_id_cannot_escape_the_source_cache(self):
        original = json.loads((ROOT / "tools/data/word_lid_sources_v3_acquisition.json").read_text(encoding="utf-8"))
        for value in ("../outside", "/absolute", "a/b", "a\\b", "x" * 81):
            document = deepcopy(original)
            document["sources"][0]["id"] = value
            with self.subTest(source_id=value), self.assertRaisesRegex(ValueError, "safe cache basename"):
                m.validate_manifest(document)

    def test_native_wikipedia_parquet_first_rows_and_min_document_frequency(self):
        try:
            import pyarrow as arrow
            import pyarrow.parquet as parquet
        except ImportError:
            self.skipTest("PyArrow only required by isolated acquisition job")
        path = self.root / "fixture.parquet"
        parquet.write_table(arrow.table({"id": ["1","2","3"], "url": [
            "https://ht.wikipedia.org/wiki/A", "https://ht.wikipedia.org/wiki/B", "https://ht.wikipedia.org/wiki/C"],
            "text": ["kreyòl ayisyen sèlman", "kreyòl ayisyen lang", "pa dwe parèt"]}), path, row_group_size=2)
        rows, receipt = m.wikipedia_rows(path, {"language": "ht", "native_families": ["LATIN"],
            "expected_scripts": ["LATIN"]}, runtime, 2, 2)
        words = dict(rows)
        self.assertEqual(set(words), {"kreyòl", "ayisyen"})
        self.assertEqual(receipt["article_count"], 2)
        self.assertEqual([r["index"] for r in receipt["selected_row_groups"]], [0])
        self.assertTrue(all(role == "train" for role in words.values()))


if __name__ == "__main__":
    unittest.main()
