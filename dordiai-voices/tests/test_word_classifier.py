"""Train/evaluation separation and runtime abstention for compact word LID."""
import gzip
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runtime = load(RUNTIME / "word_classifier.py", "test_word_lid_runtime")
trainer = load(ROOT / "tools/train_word_classifier.py", "test_word_lid_trainer")


class RuntimePolicyTests(unittest.TestCase):
    def predictor(self, rows):
        classifier = object.__new__(runtime.WordClassifier)
        classifier.threshold = .9
        classifier.temperature = 1.
        classifier.scores = lambda word: rows
        return classifier

    def test_disabled_competitors_do_not_inflate_confidence(self):
        classifier = self.predictor([("de", 0., 1.), ("en", -8., 1.)])
        self.assertEqual(classifier.predict("unknownword", {"en"}), (None, 0.))
        self.assertEqual(classifier.predict("unknownword", {"de"})[0], "de")

    def test_low_margin_abstains_even_with_only_one_enabled_language(self):
        classifier = self.predictor([("en", 0., 1.), ("de", -.1, 1.)])
        self.assertEqual(classifier.predict("unknownword", {"en"}), (None, 0.))

    def test_short_words_and_letters_never_run_classifier(self):
        classifier = self.predictor([])
        classifier.scores = lambda word: self.fail("Short inputs must not be classified")
        for word in ("a", "и", "die", "що"):
            self.assertEqual(classifier.predict(word), (None, 0.))

    def test_low_feature_support_abstains(self):
        classifier = self.predictor([("en", 0., .1), ("de", -8., .1)])
        self.assertEqual(classifier.predict("unknownword"), (None, 0.))

    def test_normalized_spelling_has_one_global_split(self):
        self.assertEqual(trainer.split_word("Cafe\u0301"), trainer.split_word("CAFÉ"))
        self.assertEqual(trainer.split_word("П’Я\u0301ТЬ"), trainer.split_word("п'ять"))

    def test_runtime_handles_mixed_scripts_conservatively(self):
        classifier = runtime.model()
        self.assertIsNotNone(classifier)
        self.assertEqual(classifier.predict("helloпривіт"), (None, 0.))


class LexicalInputTests(unittest.TestCase):
    def test_bundled_lexical_inputs_are_checked_before_use(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundled = root / "bundled"
            bundled.mkdir()
            blob = b"audited lexical bytes"
            (bundled / "fixture.gz").write_bytes(blob)
            (bundled / "sources.json").write_text(json.dumps({"files": [{
                "path": "fixture.gz", "bytes": len(blob), "sha256": sha256(blob).hexdigest(),
            }]}), encoding="utf-8")
            self.assertEqual(trainer.lexical_source("fixture.gz", root / "absent", bundled), blob)
            (bundled / "fixture.gz").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                trainer.lexical_source("fixture.gz", root / "absent", bundled)


@unittest.skipUnless((RUNTIME / "models/WordLanguage/word-lid.json.gz").is_file(), "Train compact model first")
class ReproducibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.report = json.loads((ROOT / "evidence/word_classifier_evaluation.json").read_text(encoding="utf8"))

    def test_bundled_model_matches_evaluation_digest(self):
        path = RUNTIME / "models/WordLanguage/word-lid.json.gz"
        self.assertEqual(sha256(path.read_bytes()).hexdigest(), self.report["model_sha256"])
        self.assertLess(path.stat().st_size, 2 * 1024 * 1024)

    def test_sources_splits_and_shared_labels_reproduce(self):
        # A clean checkout has no multi-gigabyte restored speech package.
        # Reproduce using the small exact audited lexical inputs committed
        # with the trainer, even when a local baseline happens to exist.
        with tempfile.TemporaryDirectory() as absent_baseline:
            corpus, sources, lexicon = trainer.gather(runtime, baseline=Path(absent_baseline))
        self.assertTrue({"uk", "ru"} <= lexicon["голос"])
        partitions = {name: set() for name in ("train", "validation", "test")}
        trained_codes = set(self.report["languages"])
        for word, labels in corpus.items():
            if labels & trained_codes:
                partitions[trainer.split_word(word)].add(word)
        for first, second in (("train", "validation"), ("train", "test"), ("validation", "test")):
            self.assertFalse(partitions[first] & partitions[second])
        for name, words in partitions.items():
            self.assertEqual(len(words), self.report["split_words"][name])
            actual = sha256("\n".join(sorted(words)).encode("utf8")).hexdigest()
            self.assertEqual(actual, self.report["split_digests_sha256"][name])
        self.assertEqual(sources, self.report["sources"])

    def test_threshold_was_selected_from_validation(self):
        threshold = self.report["confidence_threshold_selected_on_validation"]
        accepted = [row for row in self.report["threshold_search"]
                    if row["accepted"] >= 20 and row["label_match"] >= .98]
        self.assertEqual(threshold, accepted[0]["threshold"] if accepted else 1.)
        self.assertEqual(runtime.model().threshold, threshold)

    def test_supplemental_lexicon_is_multilabel_and_matches_digest(self):
        path = RUNTIME / "models/WordLanguage/cyrillic-lexicon.json.gz"
        self.assertEqual(sha256(path.read_bytes()).hexdigest(), self.report["supplemental_cyrillic_lexicon"]["sha256"])
        document = json.loads(gzip.decompress(path.read_bytes()))
        self.assertEqual(document["words"]["голос"], 3)
        self.assertEqual(document["codes"], ["uk", "ru"])
        self.assertGreater(self.report["supplemental_cyrillic_lexicon"]["ambiguous_words"], 0)


if __name__ == "__main__":
    unittest.main()
