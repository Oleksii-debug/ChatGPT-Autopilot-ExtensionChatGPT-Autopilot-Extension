"""Matched benchmark helper contracts; fixtures are not actual performance evidence."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location("matched_word_cache_tool",ROOT/"tools/probe_native_word_cache.py")
TOOL=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)


def receipt():
    return {"format":"dordiai-primary-native-word-membership","status":"source-membership-acquired",
        "non_initial_forms_not_in_frequency_sample":{
            "uk":[{"word":"uk"+str(i),"memberships":["uk"]} for i in range(32)],
            "ru":[{"word":"ru"+str(i),"memberships":["ru"]} for i in range(32)]},
        "ambiguous_membership_sample":["both"+str(i) for i in range(32)]}


class MatchedWordCacheToolTests(unittest.TestCase):
    def test_even_median_and_nearest_rank_tail(self):
        values=TOOL.percentiles([4,1,3,2])
        self.assertEqual(values["median_ms"],2.5)
        self.assertEqual(values["p95_ms"],4)
        self.assertEqual(values["p99_ms"],4)
        with self.assertRaises(ValueError):
            TOOL.percentiles([])

    def test_source_stream_preserves_shared_sets_and_explicit_unknown_control(self):
        cases=TOOL.queries(receipt())
        self.assertEqual(len(cases),97)
        self.assertEqual(sum(value==frozenset(("uk","ru")) for _,value in cases),32)
        word,value=cases[-1]
        self.assertEqual(word,"я"*96)
        self.assertEqual(value,frozenset())

    def test_unproven_or_incomplete_source_stream_rejected(self):
        source=receipt()
        source["ambiguous_membership_sample"].pop()
        with self.assertRaises(ValueError):
            TOOL.queries(source)
        source=receipt()
        source["status"]="unverified"
        with self.assertRaises(ValueError):
            TOOL.queries(source)

    def test_control_changes_only_word_entry_cache(self):
        self.assertEqual(TOOL.variant_options("original"),{})
        self.assertEqual(TOOL.variant_options("candidate-default"),{})
        self.assertEqual(TOOL.variant_options("candidate-cache0"),{"word_cache_entries":0})
        with self.assertRaises(ValueError):
            TOOL.variant_options("invented")

    def test_source_identity_hash_is_git_blob_not_only_file_sha(self):
        with tempfile.TemporaryDirectory() as name:
            path=Path(name)/"module.py"
            raw=b"# trusted test source\n"
            path.write_bytes(raw)
            info=TOOL.module_source(path)
            self.assertEqual(info["git_blob"],hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest())
            self.assertEqual(info["sha256"],hashlib.sha256(raw).hexdigest())

    def test_report_publication_is_no_clobber(self):
        with tempfile.TemporaryDirectory() as name:
            path=Path(name)/"receipt.json"
            TOOL.publish_report(path,{"status":"unit fixture"})
            original=path.read_bytes()
            with self.assertRaises(FileExistsError):
                TOOL.publish_report(path,{"status":"overwritten"})
            self.assertEqual(path.read_bytes(),original)
            self.assertEqual(len(list(Path(name).iterdir())),1)

    def test_report_cannot_alias_any_protected_input(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name)
            inputs=[root/name for name in ("data.bin","source.json","baseline.py","candidate.py")]
            for path in inputs:
                path.write_bytes(b"unchanged fixture")
            for output in inputs:
                with self.subTest(output=output),self.assertRaises(FileExistsError):
                    TOOL.main(["--lexicon",str(inputs[0]),"--acquisition-report",str(inputs[1]),
                        "--baseline-module",str(inputs[2]),"--candidate-module",str(inputs[3]),
                        "--candidate-git-blob","0"*40,"--output",str(output)])
            self.assertTrue(all(path.read_bytes()==b"unchanged fixture" for path in inputs))

    def test_child_refuses_wrong_source_before_importing_code(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name)
            module=root/"untrusted.py"
            module.write_text("raise AssertionError('must not execute')\n",encoding="utf-8")
            args=SimpleNamespace(baseline_module=module,candidate_module=module,candidate_git_blob="0"*40)
            with self.assertRaisesRegex(ValueError,"Original source11 baseline"):
                TOOL.child(args)


if __name__=="__main__":
    unittest.main()
