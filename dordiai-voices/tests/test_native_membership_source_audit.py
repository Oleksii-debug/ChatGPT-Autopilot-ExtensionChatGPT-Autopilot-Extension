"""Independent full-stream source equality tests; toy data are not linguistic accuracy evidence."""
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit_tool=load("native_membership_equality_audit",ROOT/"tools/audit_native_membership.py")
builder=load("native_membership_equality_fixture_builder",ROOT/"tools/build_native_word_membership.py")


class FullSourceEqualityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)

    def fixture(self,actual=None):
        reference={"uk":["мама","мови"],"ru":["кошка","мама"]}
        sources={}
        for code,words in reference.items():
            raw=("".join(word+"\n" for word in sorted(words))).encode()
            sources[code]={"word_count":len(words),"expanded_bytes":len(raw),
                           "expanded_sha256":hashlib.sha256(raw).hexdigest()}
        report={"format":"dordiai-primary-native-word-membership","status":"source-membership-acquired",
                "normalization":audit_tool.runtime.NORMALIZATION,"word_files":sources,
                "counts":{"union":3,"shared_spellings":1},"scope":"unit fixture only"}
        receipt=self.root/"acquisition.json"
        receipt.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        path=self.root/"native.bin"
        words={"кошка":2,"мама":3,"мови":1} if actual is None else actual
        result=builder.write_memberships(path,sorted((word.encode(),mask) for word,mask in words.items()),
                                         codes=("uk","ru"),block_words=1)
        return path,result["sha256"],receipt,hashlib.sha256(receipt.read_bytes()).hexdigest()

    def test_complete_reconstructed_streams_equal_both_source_digests(self):
        path,digest,receipt,source_digest=self.fixture()
        result=audit_tool.audit(path,digest,receipt,source_digest)
        self.assertEqual(result["status"],"passed-full-source-membership-equality")
        self.assertEqual(result["validated_union_words"],3)
        self.assertEqual(result["shared_spellings"],1)
        self.assertEqual(result["source_equality"]["uk"]["word_count"],2)
        self.assertEqual(result["source_equality"]["ru"]["word_count"],2)
        self.assertTrue(all(value["matches_authenticated_source"] for value in result["source_equality"].values()))
        self.assertFalse(result["builder_merge_used_as_reference"])
        self.assertFalse(result["whole_dictionary_set_loaded"])

    def test_a_valid_binary_that_loses_one_language_membership_is_rejected(self):
        path,digest,receipt,source_digest=self.fixture({"кошка":2,"мама":1,"мови":1})
        with self.assertRaises(ValueError):
            audit_tool.audit(path,digest,receipt,source_digest)

    def test_same_counts_and_byte_lengths_cannot_hide_a_changed_source_word(self):
        path,digest,receipt,source_digest=self.fixture({"кошка":2,"мама":3,"мова":1})
        with self.assertRaises(ValueError):
            audit_tool.audit(path,digest,receipt,source_digest)

    def test_tampered_acquisition_receipt_is_rejected(self):
        path,digest,receipt,source_digest=self.fixture()
        receipt.write_text(receipt.read_text(encoding="utf-8")+" ",encoding="utf-8")
        with self.assertRaises(ValueError):
            audit_tool.audit(path,digest,receipt,source_digest)

    def test_normal_cancellation_does_not_return_partial_equality_as_passed(self):
        path,digest,receipt,source_digest=self.fixture()
        with self.assertRaises(audit_tool.runtime.LexiconCancelled):
            audit_tool.audit(path,digest,receipt,source_digest,cancelled=lambda:True)

    def test_report_cannot_overwrite_binary_or_source_receipt(self):
        path,digest,receipt,source_digest=self.fixture()
        before={path:path.read_bytes(),receipt:receipt.read_bytes()}
        for target in (path,receipt):
            with self.assertRaises(ValueError):
                audit_tool.main(["--lexicon",str(path),"--sha256",digest,
                    "--acquisition-report",str(receipt),"--expected-report-sha256",source_digest,
                    "--output",str(target)])
        for file,data in before.items():
            self.assertEqual(file.read_bytes(),data)

    def test_complete_audit_report_is_published_without_clobber(self):
        path,digest,receipt,source_digest=self.fixture()
        report=self.root/"audit.json"
        arguments=["--lexicon",str(path),"--sha256",digest,"--acquisition-report",str(receipt),
                   "--expected-report-sha256",source_digest,"--output",str(report)]
        with redirect_stdout(io.StringIO()):
            self.assertEqual(audit_tool.main(arguments),0)
        data=report.read_bytes()
        self.assertEqual(json.loads(data)["status"],"passed-full-source-membership-equality")
        with self.assertRaises(FileExistsError):
            audit_tool.main(arguments)
        self.assertEqual(report.read_bytes(),data)
        self.assertFalse(list(self.root.glob("audit.json.writing-*")))


if __name__=="__main__":
    unittest.main()
