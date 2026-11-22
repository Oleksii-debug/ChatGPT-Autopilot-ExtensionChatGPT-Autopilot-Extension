"""Posthoc metric/accounting tests; no native-language quality claim."""
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("tested_word_posthoc", ROOT / "tools/evaluate_word_classifier_candidate.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class FrozenPredictions:
    codes = ("en", "ha", "mr")
    def __init__(self, values):
        self.values = values
        self.calls = []
    def predict(self, word, enabled=None):
        self.calls.append((word, enabled))
        code, confidence = self.values[word]
        return (None, 0.) if enabled is not None and code not in enabled else (code, confidence)


class PredictionAccountingTests(unittest.TestCase):
    def test_precision_groups_predictions_not_each_reference_membership(self):
        classifier = FrozenPredictions({"shared": ("en", .99), "wrong": ("en", .99), "rejected": (None, 0.)})
        result = audit.evaluate_rows(classifier, [
            ("shared", {"en", "ha"}), ("wrong", {"ha"}), ("rejected", {"mr"})])
        self.assertEqual(result["overall"]["words"], 3)
        self.assertEqual(result["overall"]["accepted"], 2)
        self.assertEqual(result["per_predicted_class"]["en"]["accepted"], 2)
        self.assertEqual(result["per_predicted_class"]["en"]["reference_membership_matches"], 1)
        self.assertEqual(result["per_predicted_class"]["en"]["accepted_reference_membership_precision"], .5)
        self.assertEqual(result["per_predicted_class"]["ha"]["accepted"], 0)
        self.assertNotIn("coverage", result["per_predicted_class"]["en"])
        self.assertEqual(result["per_predicted_class"]["en"]["emitted_words"], 2)

    def test_single_and_multiple_reference_breakdowns_keep_ambiguous_intent_unresolved(self):
        classifier = FrozenPredictions({"shared": ("en", .99), "single": ("ha", .99)})
        result = audit.evaluate_rows(classifier, [("shared", {"en", "ha"}), ("single", {"ha"})])
        self.assertEqual(result["reference_groups"]["single_label_reference"]["words"], 1)
        self.assertEqual(result["reference_groups"]["multiple_label_reference"]["words"], 1)
        self.assertTrue(result["multiple_label_reference_intention_is_unresolved"])
        self.assertTrue(result["membership_precision_is_not_native_language_or_author_intent_accuracy"])

    def test_enabled_targets_are_passed_without_reference_informed_pruning(self):
        classifier = FrozenPredictions({"word": ("ha", .99)})
        enabled = frozenset({"en"})
        result = audit.evaluate_rows(classifier, [("word", {"en"})], enabled=enabled)
        self.assertEqual(classifier.calls, [("word", enabled)])
        self.assertEqual(result["overall"]["accepted"], 0)
        self.assertEqual(set(result["per_predicted_class"]), {"en"})

    def test_empty_or_small_output_classes_are_not_marked_empirically_accepted(self):
        classifier = FrozenPredictions({"word": ("en", .99)})
        result = audit.evaluate_rows(classifier, [("word", {"en"})])
        self.assertTrue(result["per_predicted_class"]["en"]["fewer_than_20_accepted_examples"])
        self.assertFalse(result["per_predicted_class"]["en"]["meets_existing_98_percent_empirical_reference_gate"])
        self.assertIsNone(result["per_predicted_class"]["ha"]["accepted_reference_membership_precision"])

    def test_incorrect_examples_are_bounded(self):
        rows = [("word" + str(index), {"ha"}) for index in range(10)]
        classifier = FrozenPredictions({word: ("en", .99) for word, labels in rows})
        result = audit.evaluate_rows(classifier, rows, examples_limit=2)
        self.assertEqual(len(result["incorrect_accepted_examples"]), 2)
        self.assertEqual(result["per_predicted_class"]["en"]["incorrect_accepted"], 10)


class PartitionAndPinTests(unittest.TestCase):
    def test_partition_digests_use_identical_sorted_spelling_join_convention(self):
        result = audit.partition_digest_report({"shared": {"en"}, "beta": {"ha"}, "alpha": {"en"}},
                                               {"shared": "test"}, lambda word: "train")
        self.assertEqual(result["counts"], {"train": 2, "validation": 0, "test": 1})
        self.assertEqual(result["digests"]["train"], sha256(b"alpha\nbeta").hexdigest())
        self.assertEqual(result["digests"]["validation"], sha256(b"").hexdigest())
        self.assertEqual(result["test_words"], ["shared"])

    def test_legacy_comparison_requires_both_test_assignments(self):
        corpus = {word: {"en"} for word in ("oldtrain", "oldvalid", "newvalid", "bothblind")}
        old_roles = {"oldtrain": "train", "oldvalid": "validation", "newvalid": "test", "bothblind": "test"}
        rows = list(audit.comparison_rows(corpus, {"newvalid": "validation"}, old_roles.__getitem__, {"en"}))
        self.assertEqual(rows, [("bothblind", {"en"})])

    def test_comparison_does_not_hide_a_baseline_label_lost_by_candidate(self):
        rows = list(audit.comparison_rows({"word": {"en"}}, {}, lambda word: "test", {"en"}))
        self.assertEqual(rows, [("word", {"en"})])


    def test_historical_runtime_is_an_exact_pinned_source_object(self):
        path = ROOT / "training-data/word-lid/audited-baseline/word_classifier_runtime_v1.py"
        runtime = audit.baseline_runtime_from_file(path)
        self.assertEqual(runtime.FORMAT, "dordiai-word-lid-v1")
        self.assertFalse(hasattr(runtime, "is_valid_word"))
        with tempfile.TemporaryDirectory() as temporary:
            changed = Path(temporary) / "changed.py"
            changed.write_bytes(path.read_bytes() + b"\n")
            with self.assertRaises(ValueError):
                audit.baseline_runtime_from_file(changed)

    def test_digest_reads_exact_bytes_without_mutating_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "frozen-candidate"
            original = b"frozen unit bytes"
            path.write_bytes(original)
            self.assertEqual(audit.digest(path), sha256(original).hexdigest())
            self.assertEqual(path.read_bytes(), original)


class NamedEntityCaseImpactTests(unittest.TestCase):
    def lock(self):
        return {"sources": [{"id": "source", "kind": "aksharantar-jsonl-zip",
                             "exclude_sources": ["AK-NEI", "AK-NEF"]}]}

    def test_actual_raw_tag_counts_quantify_only_previously_kept_variants(self):
        header = {"sources": [{"id": "source", "parser_counts": {
            "publisher_source:AK-NEI": 7, "publisher_source:Ak-NEI": 3,
            "publisher_source: ak-nef ": 2, "publisher_source:Ak-Freq": 10}}]}
        report = audit.named_entity_tag_case_impact(header, self.lock())
        self.assertTrue(report["complete_original_tag_evidence"])
        self.assertEqual(report["affected_rows"], 5)
        self.assertFalse(report["same_prepared_corpus_can_be_bound_to_casefix_without_retraining"])
        self.assertEqual(header["sources"][0]["parser_counts"]["publisher_source:AK-NEI"], 7)

    def test_case_variant_frequency_tags_alone_do_not_require_new_corpus_or_training(self):
        header = {"sources": [{"id": "source", "parser_counts": {
            "publisher_source:AK-NEI": 7, "publisher_source:Ak-Freq": 10}}]}
        report = audit.named_entity_tag_case_impact(header, self.lock())
        self.assertEqual(report["affected_rows"], 0)
        self.assertTrue(report["same_prepared_corpus_can_be_bound_to_casefix_without_retraining"])

    def test_missing_or_malformed_original_counts_remain_unknown(self):
        for counts in (None, [], {"accepted_rows": 3}, {"publisher_source:Ak-NEI": "3"}):
            with self.subTest(counts=counts):
                report = audit.named_entity_tag_case_impact({"sources": [{"id": "source", "parser_counts": counts}]}, self.lock())
                self.assertFalse(report["complete_original_tag_evidence"])
                self.assertIsNone(report["affected_rows"])
                self.assertFalse(report["same_prepared_corpus_can_be_bound_to_casefix_without_retraining"])

    def test_omitting_a_locked_archive_cannot_prove_zero_effect(self):
        lock = self.lock()
        lock["sources"].append({"id": "second", "kind": "aksharantar-jsonl-zip", "exclude_sources": ["AK-NEI"]})
        report = audit.named_entity_tag_case_impact({"sources": [{"id": "source", "parser_counts": {
            "publisher_source:Ak-Freq": 10}}]}, lock)
        self.assertFalse(report["complete_original_tag_evidence"])
        self.assertIsNone(report["affected_rows"])


class EvaluationOutputSafetyTests(unittest.TestCase):
    def test_input_overlap_and_hardlink_alias_are_refused_without_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "model"
            source.write_bytes(b"frozen model sentinel")
            with self.assertRaises(ValueError):
                audit.validate_output_path(source, [source])
            alias = root / "alias"
            audit.os.link(source, alias)
            with self.assertRaises(ValueError):
                audit.validate_output_path(alias, [source])
            self.assertEqual(source.read_bytes(), b"frozen model sentinel")

    def test_new_output_inside_audited_source_tree_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            protected = Path(temporary) / "audited-source"
            output = protected / "new-module.py"
            with self.assertRaises(ValueError):
                audit.validate_output_path(output, protected_roots=[protected])
            self.assertFalse(protected.exists())

    def test_symlink_output_cannot_point_to_a_protected_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, alias = root / "model", root / "alias"
            source.write_bytes(b"frozen model sentinel")
            try:
                alias.symlink_to(source)
            except OSError as error:
                self.skipTest("Host cannot create a symlink fixture: " + type(error).__name__)
            with self.assertRaises(ValueError):
                audit.validate_output_path(alias, [source])
            self.assertEqual(source.read_bytes(), b"frozen model sentinel")

    def test_report_is_atomic_new_output_and_never_clobbers_existing_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, output = root / "model", root / "reports/audit.json"
            source.write_bytes(b"frozen model sentinel")
            result = audit.write_atomic_report(output, {"model_installed": False}, [source])
            self.assertEqual(json.loads(result.read_text(encoding="utf-8")), {"model_installed": False})
            with self.assertRaises(FileExistsError):
                audit.write_atomic_report(output, {"changed": True}, [source])
            self.assertEqual(json.loads(result.read_text(encoding="utf-8")), {"model_installed": False})
            self.assertEqual(source.read_bytes(), b"frozen model sentinel")
            self.assertEqual(list(output.parent.glob("*.tmp")), [])

    def test_concurrent_destination_appearance_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "audit.json"
            def occupied_destination(source, destination):
                Path(destination).write_bytes(b"concurrent writer sentinel")
                raise FileExistsError("controlled publication race")
            with patch.object(audit.os, "link", side_effect=occupied_destination):
                with self.assertRaises(FileExistsError):
                    audit.write_atomic_report(output, {"model_installed": False})
            self.assertEqual(output.read_bytes(), b"concurrent writer sentinel")
            self.assertEqual(list(root.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
