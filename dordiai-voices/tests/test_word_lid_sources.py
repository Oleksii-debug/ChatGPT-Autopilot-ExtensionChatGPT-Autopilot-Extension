"""Pinned source parsing and split guards; no real-data/model-quality claims."""
import gzip
from hashlib import sha1, sha256
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runtime = load(ROOT / "source/0.12.2/kx47Runtime/word_classifier.py", "expanded_word_runtime")
prepare = load(ROOT / "tools/prepare_word_lid_sources.py", "expanded_word_sources")
trainer = load(ROOT / "tools/train_word_classifier.py", "expanded_word_trainer")


def source_row(identifier, language, role="train", kind="pos"):
    return {"id": identifier, "kind": kind, "language": language, "source_language": language,
            "publisher_role": role, "expected_scripts": ["LATIN"], "revision": "a" * 40,
            "url": "https://raw.githubusercontent.com/owned/unit-fixtures/" + "a" * 40 + "/" + identifier,
            "license": "unit fixture only", "license_url": "https://example.invalid/unit-fixture",
            "attribution": "Synthetic parser fixture, not language evidence",
            "exclude_upos": ["PROPN", "X", "NUM", "PUNCT", "SYM"]}


class UnicodeNativeWordTests(unittest.TestCase):
    def test_native_devanagari_combining_marks_are_not_discarded(self):
        # Orthographic fixtures only, not claims that these identify a language.
        for word in ("हिन्दी", "मराठी", "नेपाली", "मैथिली", "डोगरी", "बड़ो"):
            with self.subTest(word=word):
                self.assertTrue(runtime.is_valid_word(word))
                self.assertEqual(runtime.word_script(word), "DEVANAGARI")


    def test_complex_native_families_preserve_legacy_other_labels_and_old_model_gate(self):
        for word in ("தமிழ்", "తెలుగు", "ગુજરાતી", "ಕನ್ನಡ", "മലയാളം", "සිංහල", "ꯃꯤꯇꯩ"):
            with self.subTest(word=word):
                self.assertTrue(runtime.is_valid_word(word))
                self.assertEqual(runtime.word_script(word), "OTHER")
                classifier = object.__new__(runtime.WordClassifier)
                classifier.scores = lambda word: self.fail("Old model must retain native-mark abstention")
                self.assertEqual(classifier.predict(word), (None, 0.))
        self.assertEqual(runtime.word_script("தமிழ"), "OTHER")

    def test_other_label_does_not_merge_unrelated_script_families(self):
        for word in ("தமிழ్", "தமிழ்తెలుగు", "ꯃꯤ\u0c3e"):
            with self.subTest(word=word):
                self.assertIsNone(runtime.word_script(word))
                self.assertFalse(runtime.is_valid_word(word))

    def test_yoruba_combining_tones_keep_their_native_spelling(self):
        self.assertTrue(runtime.is_valid_word(runtime.normalize_word("ọ̀rọ̀")))
        self.assertEqual(runtime.word_script("ọ̀rọ̀"), "LATIN")

    def test_leading_detached_foreign_marks_and_joiners_are_not_accepted(self):
        for word in ("\u093fहिन्दी", "hello\u093f", "hello\u0651", "word-\u0301", "अ\u200dक्षर",
                     "two words", "1234", "word-", "-word"):
            with self.subTest(word=word):
                self.assertFalse(runtime.is_valid_word(word))

    def test_nfc_nukta_variants_share_one_global_spelling_assignment(self):
        first, second = "क़लम", "क\u093cलम"
        self.assertEqual(runtime.normalize_word(first), runtime.normalize_word(second))
        self.assertEqual(trainer.split_word(first), trainer.split_word(second))

    def test_known_training_homographs_abstain_before_scoring(self):
        classifier = object.__new__(runtime.WordClassifier)
        classifier.ambiguous_words = frozenset({"sharedword"})
        classifier.scores = lambda word: self.fail("Known homograph must not be forced to one label")
        self.assertEqual(classifier.predict("SHAREDWORD", {"en"}), (None, 0.))


    def test_old_bundled_models_keep_abstaining_on_newly_accepted_marks(self):
        classifier = object.__new__(runtime.WordClassifier)
        classifier.scores = lambda word: self.fail("Old model must not classify newly accepted marked spellings")
        self.assertEqual(classifier.predict("हिन्दी"), (None, 0.))
        classifier.native_combining_marks = True
        classifier.threshold = .9
        classifier.temperature = 1.
        classifier.scores = lambda word: [("hi", 0., 1.), ("mr", -8., 1.)]
        self.assertEqual(classifier.predict("हिन्दी")[0], "hi")
        self.assertEqual(classifier.predict("हिन्दी", {"mr"}), (None, 0.))


class SourceAcquisitionTests(unittest.TestCase):
    def test_immutable_revision_checksum_and_dataset_license_are_required(self):
        row = source_row("unit-source", "ha")
        row["sha256"] = "b" * 64
        self.assertIs(prepare.validate_source(row), row)
        for field, value in (("url", "https://raw.githubusercontent.com/owned/repo/main/file"),
                             ("url", "https://unreviewed.invalid/" + "a" * 40 + "/file"),
                             ("id", "../escape"), ("license", ""), ("revision", "main")):
            with self.subTest(field=field, value=value):
                invalid = dict(row)
                invalid[field] = value
                with self.assertRaises(ValueError):
                    prepare.validate_source(invalid)

    def test_git_blob_pin_verifies_original_raw_bytes(self):
        raw = b"fixtureword NOUN\n"
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source"
            path.write_bytes(raw)
            row = source_row("unit-source", "ha")
            row.update(bytes=len(raw), git_blob_sha1=sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest())
            self.assertEqual(prepare.verify_source(path, row)["sha256"], sha256(raw).hexdigest())
            path.write_bytes(b"changed bytes")
            with self.assertRaises(ValueError):
                prepare.verify_source(path, row)

    def test_download_is_checked_before_atomic_cache_install(self):
        raw = b"fixtureword NOUN\n"
        row = source_row("unit-source", "ha")
        row.update(bytes=len(raw), sha256=sha256(raw).hexdigest())
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            path, receipt = prepare.acquire(row, cache, opener=lambda *args, **kwargs: io.BytesIO(raw))
            self.assertEqual(path.read_bytes(), raw)
            self.assertEqual(receipt["sha256"], row["sha256"])
            path.unlink()
            with self.assertRaises(ValueError):
                prepare.acquire(row, cache, opener=lambda *args, **kwargs: io.BytesIO(b"changed bytes"))
            self.assertFalse(path.exists())

    def test_pos_parser_excludes_proper_names_and_other_nonlexical_tokens(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source"
            path.write_text("nativeword NOUN\nPerson PROPN\n12 NUM\n, PUNCT\nforeign X\n", encoding="utf-8")
            self.assertEqual(list(prepare.text_rows(path, source_row("fixture", "ha"))),
                             [("nativeword", "train")])

    def test_conllu_parser_skips_foreign_names_multitokens_and_empty_nodes(self):
        text = ("1\tnativeword\t_\tNOUN\t_\t_\t0\troot\t_\t_\n"
                "2\tforeignword\t_\tNOUN\t_\tForeign=Yes\t1\tdep\t_\t_\n"
                "3\tPerson\t_\tPROPN\t_\t_\t1\tdep\t_\t_\n"
                "4-5\tmultitoken\t_\t_\t_\t_\t_\t_\t_\t_\n"
                "4.1\tempty\t_\tNOUN\t_\t_\t1\tdep\t_\t_\n")
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source"
            path.write_text(text, encoding="utf-8")
            self.assertEqual(list(prepare.text_rows(path, source_row("fixture", "hr", kind="conllu"))),
                             [("nativeword", "train")])

    def zip_fixture(self, path, *, identifier="brx1", include_test=True, unsafe=False):
        row = source_row("fixture", "brx", kind="aksharantar-jsonl-zip")
        row.update(source_language="brx", expected_scripts=["DEVANAGARI"], exclude_sources=["AK-NEI"])
        item = {"unique_identifier": identifier, "native word": "बरफोर", "english word": "parser-fixture",
                "source": "IndicCorp"}
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("../escape" if unsafe else "brx_train.json", json.dumps(item) + "\n")
            if include_test:
                archive.writestr("brx_test.json", json.dumps(dict(item, unique_identifier="brx2")) + "\n")
        return row

    def test_native_zip_keeps_original_language_and_publisher_split(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source.zip"
            row = self.zip_fixture(path)
            records = list(prepare.zip_rows(path, row, prepare.Counter()))
            self.assertEqual(records, [("बरफोर", "train"), ("बरफोर", "test")])

    def test_native_zip_does_not_relabel_neighbor_language_or_absent_holdout(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source.zip"
            row = self.zip_fixture(path, identifier="hin1")
            with self.assertRaises(ValueError):
                list(prepare.zip_rows(path, row, prepare.Counter()))
            row = self.zip_fixture(path, include_test=False)
            with self.assertRaises(ValueError):
                list(prepare.zip_rows(path, row, prepare.Counter()))

    def test_native_zip_never_extracts_unsafe_members(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source.zip"
            row = self.zip_fixture(path, unsafe=True)
            with self.assertRaises(ValueError):
                list(prepare.zip_rows(path, row, prepare.Counter()))
            self.assertEqual(sorted(item.name for item in Path(temporary).iterdir()), ["source.zip"])

    def test_source_line_limit_is_enforced(self):
        with self.assertRaises(ValueError):
            list(prepare.bounded_lines(io.BytesIO(b"a" * (prepare.MAX_LINE + 1))))


class GlobalPublisherHoldoutTests(unittest.TestCase):
    def fixture(self, root, content):
        root = Path(root)
        cache, output = root / "cache", root / "prepared"
        cache.mkdir()
        rows = []
        for identifier, language, role, text in content:
            row = source_row(identifier, language, role)
            raw = text.encode("utf-8")
            row.update(sha256=sha256(raw).hexdigest(), bytes=len(raw))
            (cache / (identifier + ".source")).write_bytes(raw)
            rows.append(row)
        manifest = {"format": "dordiai-word-lid-source-lock-v2", "sources": rows}
        (root / "tools/data").mkdir(parents=True)
        (root / "tools/data/word_lid_sources_v2.json").write_text(json.dumps(manifest), encoding="utf-8")
        (root / "selected_languages.json").write_text(json.dumps({"languages": [{"id": code}
            for code in ("ha", "ig", "en")]}), encoding="utf-8")
        with patch("sys.stdout", new=io.StringIO()):
            receipt = prepare.prepare(manifest, cache, output)
        return output / "extra-corpus.jsonl.gz", receipt

    def test_all_language_labels_survive_and_test_wins_globally(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, receipt = self.fixture(temporary, [
                ("ha-train", "ha", "train", "sharedword NOUN\nhausaform NOUN\n"),
                ("ig-test", "ig", "test", "SHAREDWORD NOUN\nigboform NOUN\n")])
            with patch.object(trainer, "ROOT", Path(temporary)):
                corpus, overrides, header = trainer.additional_word_corpus(path, runtime)
            self.assertEqual(corpus["sharedword"], {"ha", "ig"})
            self.assertEqual(overrides["sharedword"], "test")
            self.assertFalse(receipt["trained"])
            self.assertFalse(receipt["classifier_language_coverage_verified"])

    def test_prepared_corpus_corruption_is_rejected_before_training(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, receipt = self.fixture(temporary, [("ha-train", "ha", "train", "nativeword NOUN\n")])
            path.write_bytes(path.read_bytes() + b"changed")
            with patch.object(trainer, "ROOT", Path(temporary)), self.assertRaises(ValueError):
                trainer.additional_word_corpus(path, runtime)

    def test_receipt_must_match_the_pinned_source_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, receipt = self.fixture(temporary, [("ha-train", "ha", "train", "nativeword NOUN\n")])
            rows = gzip.decompress(path.read_bytes()).decode("utf-8").splitlines()
            header = json.loads(rows[0])
            header["sources"][0]["language"] = "ig"
            rows[0] = json.dumps(header)
            raw = gzip.compress(("\n".join(rows) + "\n").encode(), mtime=0)
            path.write_bytes(raw)
            receipt["sources"] = header["sources"]
            receipt["corpus_sha256"] = sha256(raw).hexdigest()
            Path(str(path) + ".receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
            with patch.object(trainer, "ROOT", Path(temporary)), self.assertRaises(ValueError):
                trainer.additional_word_corpus(path, runtime)

    def test_publisher_test_spelling_cannot_train_through_a_baseline_label(self):
        def training_word(prefix):
            return next(prefix + chr(letter) for letter in range(ord("a"), ord("z") + 1)
                        if trainer.split_word(prefix + chr(letter)) == "train")
        shared, ambiguous = training_word("sharedword"), training_word("commonword")
        english, hausa, igbo = training_word("englishword"), training_word("hausaword"), training_word("igboword")
        with tempfile.TemporaryDirectory() as temporary:
            path, receipt = self.fixture(temporary, [
                ("ha-train", "ha", "train", shared + " NOUN\n" + ambiguous + " NOUN\n" + hausa + " NOUN\n"),
                ("ig-train", "ig", "train", ambiguous + " NOUN\n" + igbo + " NOUN\n"),
                ("ig-test", "ig", "test", shared + " NOUN\n")])
            root = Path(temporary)
            args = SimpleNamespace(baseline=root / "absent", training_data=root / "absent",
                additional_corpus=path, minimum_words=1, max_words_per_language=100, dimensions=256,
                target_precision=.98, output=root / "model.gz", lexicon_output=root / "lexicon.gz",
                report=root / "evaluation.json")
            baseline = {shared: {"en"}, ambiguous: {"en"}, english: {"en"}}
            with patch.object(trainer, "ROOT", root), patch.object(trainer, "load_runtime", return_value=runtime), \
                    patch.object(trainer, "gather", return_value=(baseline, [], {})), patch("sys.stdout", new=io.StringIO()):
                trainer.train(args)
            report = json.loads(args.report.read_text(encoding="utf-8"))
            model = json.loads(gzip.decompress(args.output.read_bytes()))
            self.assertEqual(report["split_words"]["test"], 1)
            self.assertEqual(report["split_digests_sha256"]["test"], sha256(shared.encode()).hexdigest())
            self.assertEqual(report["word_overlap_train_validation_test"], 0)
            self.assertNotIn(shared, model["known_ambiguous_spellings"])
            self.assertIn(ambiguous, model["known_ambiguous_spellings"])
            self.assertEqual(runtime.WordClassifier(model).predict(ambiguous), (None, 0.))
            self.assertFalse(report["additional_corpus"]["integrated_router_holdout_verified"])


if __name__ == "__main__":
    unittest.main()
