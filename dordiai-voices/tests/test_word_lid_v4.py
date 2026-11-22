"""Synthetic v4 merge/calibration policies; no real language-accuracy claim."""
from array import array
import base64
from collections import Counter
from copy import deepcopy
import gzip
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load(ROOT/"tools/train_word_lid_v4.py", "v4_train_fixture")
runtime = load(ROOT/"tools/vendor/word_classifier_candidate_v4.py", "v4_runtime_fixture")


def model_document(codes=("or","mni"), scripts=None, families=None, thresholds=None):
    weights = array("h", [0]*(256*len(codes)))
    if sys.byteorder != "little":
        weights.byteswap()
    return {"format": runtime.FORMAT, "codes": list(codes),
        "scripts": scripts or {"or":["OTHER"],"mni":["OTHER"]},
        "native_families": families or {"or":["ORIYA"],"mni":["MEETEI"]},
        "per_predicted_class_thresholds": thresholds or {code:.5 for code in codes},
        "dimensions":256,"quantization":256,"temperature":1.,"minimum_confidence":.5,
        "default_weights":[-1]*len(codes),"weights":base64.b64encode(weights.tobytes()).decode(),
        "native_combining_marks":True, "known_ambiguous_spellings":[]}


class CandidateRuntimeTests(unittest.TestCase):
    def test_actual_native_family_prevents_other_bucket_cross_script_competition(self):
        model = runtime.WordClassifier(model_document())
        self.assertEqual([row[0] for row in model.scores("ଓଡ଼ିଆ")], ["or"])
        self.assertEqual([row[0] for row in model.scores("ꯃꯤꯇꯩ")], ["mni"])
        self.assertEqual(runtime.word_script("ଓଡ଼ିଆ"), "OTHER")
        self.assertEqual(runtime.word_script("ꯃꯤꯇꯩ"), "OTHER")
        self.assertEqual(model.predict("ଓଡ଼ିଆ")[0], "or")

    def test_missing_or_untrusted_class_never_replaces_with_another_enabled_label(self):
        doc = model_document(codes=("hi","mr"),
            scripts={"hi":["DEVANAGARI"],"mr":["DEVANAGARI"]},
            families={"hi":["DEVANAGARI"],"mr":["DEVANAGARI"]},
            thresholds={"hi":None,"mr":.5})
        model = runtime.WordClassifier(doc)
        self.assertEqual(model.rank("हिन्दी")[0], "hi")
        self.assertEqual(model.predict("हिन्दी"), (None,0.))
        self.assertEqual(model.predict("हिन्दी", {"mr"}), (None,0.))

    def test_enabled_filter_follows_full_competitor_ranking(self):
        doc = model_document(codes=("hi","mr"),
            scripts={"hi":["DEVANAGARI"],"mr":["DEVANAGARI"]},
            families={"hi":["DEVANAGARI"],"mr":["DEVANAGARI"]})
        model = runtime.WordClassifier(doc)
        self.assertEqual(model.rank("हिन्दी")[1], .5)
        self.assertEqual(model.predict("हिन्दी", {"mr"}), (None,0.))
        self.assertEqual(model.predict("हिन्दी", {"hi"}), ("hi",.5))

    def test_calibration_schema_requires_every_class_and_finite_numeric_thresholds(self):
        for field,value in (("native_families",{}),("per_predicted_class_thresholds",{"or":.5}),
                            ("per_predicted_class_thresholds",{"or":True,"mni":.5}),
                            ("per_predicted_class_thresholds",{"or":float("nan"),"mni":.5})):
            doc = model_document()
            doc[field] = value
            with self.subTest(field=field,value=value), self.assertRaises(ValueError):
                runtime.WordClassifier(doc)

    def test_distinct_candidate_format_cannot_be_mistaken_for_production_model(self):
        self.assertNotEqual(runtime.FORMAT, "dordiai-word-lid-v1")
        doc = model_document()
        doc["format"] = "dordiai-word-lid-v1"
        with self.assertRaises(ValueError):
            runtime.WordClassifier(doc)


class GlobalMergeTests(unittest.TestCase):
    def test_all_source_labels_share_strongest_publisher_role(self):
        corpus, overrides = m.merge_corpora({"shared":{"en"}},{"shared":{"hi"}},
            {"shared":{"mr"}},{"shared":"validation"},{"shared":"test"})
        self.assertEqual(corpus["shared"], {"en","hi","mr"})
        self.assertEqual(overrides["shared"], "test")
        _, reverse = m.merge_corpora({},{"shared":{"hi"}},{},
            {"shared":"test"},{"shared":"validation"})
        self.assertEqual(reverse["shared"], "test")

    def test_publisher_train_never_erases_another_sources_holdout(self):
        _, overrides = m.merge_corpora({},{"shared":{"gn"}},{},
            {"shared":"validation"},{"shared":"train"})
        self.assertEqual(overrides, {"shared":"validation"})

    def test_insufficient_original_class_is_fatal_instead_of_silently_dropped(self):
        corpus={"nativeone":{"gn"},"nativetwo":{"gn"},"otherone":{"ht"}}
        with patch.object(m,"MINIMUM_WORDS",2):
            with self.assertRaisesRegex(ValueError,"loses original"):
                m.choose_codes(corpus,lambda word:"train",runtime,{"gn","ht"})

    def test_original_labels_can_be_preserved_by_genuine_new_native_training_words(self):
        corpus={"nativeone":{"gn"},"nativetwo":{"gn"},"otherone":{"ht"},"othertwo":{"ht"}}
        with patch.object(m,"MINIMUM_WORDS",2):
            codes,support=m.choose_codes(corpus,lambda word:"train",runtime,{"gn","ht"})
        self.assertEqual(codes,["gn","ht"])
        self.assertEqual(support["gn","LATIN"],2)

    def test_sampling_cannot_move_publisher_holdout_to_fit_or_lose_native_family_minimum(self):
        corpus={"nativeone":{"gn"},"nativetwo":{"gn"},"heldword":{"gn"},
                "ଓଡ଼ିଆ":{"gn"},"ଓଡ଼ିଆର":{"gn"}}
        assignment=lambda word:"test" if word=="heldword" else "train"
        with patch.object(m,"MINIMUM_WORDS",2):
            codes,support=m.choose_codes(corpus,assignment,runtime,{"gn"})
            selected=m.sample_training(corpus,assignment,runtime,codes,support,4)
        self.assertNotIn(("heldword","gn"),selected)
        self.assertEqual(len(selected),4)
        self.assertEqual({runtime.actual_native_family(word) for word,_ in selected},{"LATIN","ORIYA"})


class ValidationCalibrationTests(unittest.TestCase):
    def test_high_pooled_precision_cannot_hide_one_untrusted_predicted_class(self):
        records=[("good",.99,1.,True)]*1000+[("bad",.99,1.,False)]*200
        thresholds,details=m.calibrate_predicted_classes(records,["good","bad"])
        self.assertEqual(thresholds["good"],.5)
        self.assertIsNone(thresholds["bad"])
        self.assertEqual(details["bad"]["status"],"untrusted-class-abstain")

    def test_tiny_perfect_validation_class_is_still_untrusted(self):
        thresholds,_=m.calibrate_predicted_classes([("tiny",1.,1.,True)]*20,["tiny"])
        self.assertIsNone(thresholds["tiny"])

    def test_threshold_search_uses_predicted_class_validation_precision(self):
        records=[("lang",.99,1.,True)]*250+[("lang",.6,1.,False)]*250
        thresholds,details=m.calibrate_predicted_classes(records,["lang"])
        self.assertEqual(thresholds["lang"],.7)
        self.assertEqual(next(row for row in details["lang"]["validation_threshold_search"]
                              if row["threshold"]==.7)["accepted"],250)

    def test_zero_seen_grams_never_count_as_calibration_evidence(self):
        thresholds,_=m.calibrate_predicted_classes([("lang",1.,0.,True)]*1000,["lang"])
        self.assertIsNone(thresholds["lang"])

    def test_shared_script_single_class_certainty_is_not_native_competition(self):
        thresholds={"ks":.5,"or":.5}
        details={code:{"selected_threshold":.5} for code in thresholds}
        competitors=m.with_native_competition_guard(thresholds,details,
            {"ks":["ARABIC"],"or":["ORIYA"]})
        self.assertIsNone(thresholds["ks"])
        self.assertEqual(thresholds["or"],.5)
        self.assertEqual(competitors["ARABIC"],["ks"])
        self.assertIn("untrained-native",details["ks"]["status"])

    def test_genuine_shared_script_competitors_preserve_validation_decision(self):
        thresholds={"hi":.9,"mr":None}
        details={code:{"selected_threshold":value} for code,value in thresholds.items()}
        m.with_native_competition_guard(thresholds,details,
            {"hi":["DEVANAGARI"],"mr":["DEVANAGARI"]})
        self.assertEqual(thresholds,{"hi":.9,"mr":None})


class FrozenV3DecoderTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.corpus=self.root/"pilot.gz"
        self.report=self.root/"report.json"
        self.manifest=self.root/"manifest.json"
        self.source={"id":"synthetic","pilot":True,"language":"hi","source_language":"hin",
            "revision":"a"*40,"url":"https://huggingface.co/synthetic","license":"fixture",
            "license_url":"https://example.invalid/license","attribution":"synthetic",
            "sha256":"b"*64,"native_families":["DEVANAGARI"],"expected_scripts":["DEVANAGARI"]}
        self.document={"pilot_languages":["hi"],"sources":[self.source]}
        self.manifest.write_bytes(m.json_bytes(self.document))
        self.rows=[{"word":"हिन्दी","labels":["hi"],"publisher_role":"train","effective_pilot_split":"train"}]
        self.header={"format":"dordiai-word-lid-native-pilot-v3",
            "not_consumable_as_current_v2_training_lock":True}

    def write_fixtures(self):
        raw=("\n".join(json.dumps(row,ensure_ascii=False) for row in [self.header,*self.rows])+"\n").encode("utf-8")
        self.corpus.write_bytes(gzip.compress(raw,mtime=0))
        receipt={key:self.source[key] for key in ("id","language","source_language","revision",
            "url","license","license_url","attribution","sha256")}
        report={"format":"dordiai-word-lid-native-pilot-v3","status":"acquired-not-trained",
            "model_trained":False,"model_installed":False,"insufficient_labels":[],
            "corpus_lock_sha256":m.digest(self.manifest),"source_receipts":[receipt],
            "corpus":{"sha256":m.digest(self.corpus),"size_bytes":self.corpus.stat().st_size},
            "per_language":{"hi":{"effective_train_words_min4":1,
                "effective_validation_words_min4":0,"effective_test_words_min4":0}}}
        self.report.write_bytes(m.json_bytes(report))
        return m.digest(self.corpus),m.git_blob(self.report.read_bytes())

    def decode(self):
        corpus_hash,report_blob=self.write_fixtures()
        with patch.object(m,"V3_CORPUS_SHA256",corpus_hash),patch.object(m,"V3_REPORT_GIT_BLOB",report_blob):
            return m.load_v3(self.corpus,self.report,self.manifest,runtime,lambda word:"train")

    def test_explicit_decoder_preserves_raw_publisher_role_and_actual_family(self):
        corpus,overrides,receipt=self.decode()
        self.assertEqual(corpus,{"हिन्दी":{"hi"}})
        self.assertEqual(overrides,{})
        self.assertEqual(receipt["native_actual_family_word_counts"],{"hi":{"DEVANAGARI":1}})

    def test_v2_format_is_not_accidentally_accepted_as_v3(self):
        self.header["format"]="dordiai-word-lid-extra-v1"
        with self.assertRaisesRegex(ValueError,"another corpus format"):
            self.decode()

    def test_tampered_pilot_assignment_is_rejected_and_never_promoted_to_publisher_role(self):
        self.rows[0]["effective_pilot_split"]="test"
        with self.assertRaisesRegex(ValueError,"pilot partition"):
            self.decode()

    def test_wrong_actual_native_family_is_rejected_despite_other_legacy_label(self):
        self.rows[0]["word"]="ଓଡ଼ିଆ"
        with self.assertRaisesRegex(ValueError,"actual native-script"):
            self.decode()

    def test_frozen_corpus_byte_change_fails_before_decode(self):
        expected,_=self.write_fixtures()
        self.corpus.write_bytes(self.corpus.read_bytes()+b"x")
        with patch.object(m,"V3_CORPUS_SHA256",expected),self.assertRaisesRegex(ValueError,"checksum"):
            m.load_v3(self.corpus,self.report,self.manifest,runtime,lambda word:"train")

    def test_source_report_change_fails_before_its_metadata_is_used(self):
        corpus_hash,expected=self.write_fixtures()
        self.report.write_bytes(self.report.read_bytes()+b"\n")
        with patch.object(m,"V3_CORPUS_SHA256",corpus_hash),patch.object(m,"V3_REPORT_GIT_BLOB",expected):
            with self.assertRaisesRegex(ValueError,"acquisition report"):
                m.load_v3(self.corpus,self.report,self.manifest,runtime,lambda word:"train")


class OutputAndPinTests(unittest.TestCase):
    def test_only_new_unlinked_owned_output_can_be_used(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            self.assertEqual(m.output_directory(root/"new"),root/"new")
            existing=root/"existing"
            existing.mkdir()
            with self.assertRaises(FileExistsError):
                m.output_directory(existing)
            with self.assertRaises(ValueError):
                m.output_directory(ROOT/"source/future-candidate")
            with self.assertRaises(ValueError):
                m.output_directory(root/"input/candidate",[root/"input"])

    def test_unpinned_module_is_never_executed(self):
        with tempfile.TemporaryDirectory() as directory:
            script=Path(directory)/"unsafe.py"
            script.write_text("raise AssertionError('must not execute')\n",encoding="utf-8")
            with self.assertRaisesRegex(ValueError,"Pinned"):
                m.pinned_module(script,"0"*40,"must_not_load")

    def test_pinned_candidate_runtime_and_unchanged_trainer_are_reproducible(self):
        m.pinned_module(ROOT/"tools/vendor/word_classifier_candidate_v4.py",m.RUNTIME_GIT_BLOB,"v4_pin_check")
        m.pinned_module(ROOT/"tools/train_word_classifier.py",m.TRAINER_GIT_BLOB,"v4_trainer_pin_check")


if __name__=="__main__":
    unittest.main()
