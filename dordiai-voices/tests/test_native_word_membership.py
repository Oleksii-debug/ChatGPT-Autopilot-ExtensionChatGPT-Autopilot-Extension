"""Exact finite lookup/format integrity tests; fixtures are not language accuracy claims."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import gzip
import io
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zlib

ROOT = Path(__file__).resolve().parents[1]


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runtime=load("native_membership_runtime_test",ROOT/"source/0.12.2/kx47Runtime/native_word_membership.py")
builder=load("native_membership_builder_test",ROOT/"tools/build_native_word_membership.py")


class NativeMembershipTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.words={"мови":1,"п'ять":1,"сёмга":2,"кошками":2,"мама":3,"голос":3,
                    "kůň":4,"kôň":8,"café":16}
        self.codes=("uk","ru","cs","sk","en")

    def create(self,words=None,codes=None,filename="lexicon.bin",**kwargs):
        values=self.words if words is None else words
        path=self.root/filename
        result=builder.write_memberships(path,sorted((word.encode(),mask) for word,mask in values.items()),
            codes=codes or self.codes,**kwargs)
        return path,result

    def record(self,prefix,suffix,mask,mask_bytes=1):
        return runtime.WORD_ITEM.pack(prefix,suffix)+mask.to_bytes(mask_bytes,"little")

    def acquisition_fixture(self):
        folder=self.root/"source"
        folder.mkdir()
        files={}
        for code,words in (("uk",("мама","мови")),("ru",("кошка","мама"))):
            raw=("".join(word+"\n" for word in sorted(words))).encode()
            data=gzip.compress(raw,mtime=0)
            name=code+"-native-words.txt.gz"
            (folder/name).write_bytes(data)
            files[code]={"filename":name,"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest(),
                "word_count":len(words),"expanded_bytes":len(raw),"expanded_sha256":hashlib.sha256(raw).hexdigest()}
        document={"format":"dordiai-primary-native-word-membership","status":"source-membership-acquired",
            "normalization":runtime.NORMALIZATION,"source_manifest_sha256":"0"*64,
            "sources":{"uk":{"scope":"unit fixture only"},"ru":{"scope":"unit fixture only"}},
            "word_files":files,"counts":{"union":3},
            "non_initial_forms_not_in_frequency_sample":{"uk":[{"word":"мови","memberships":["uk"]}]},
            "ambiguous_membership_sample":["мама"]}
        path=folder/"acquisition-report.json"
        path.write_text(json.dumps(document,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        return path,hashlib.sha256(path.read_bytes()).hexdigest(),files

    def malformed(self,raw,*,first=b"a",count=1,raw_size=None,codes=("uk","ru"),metadata_changes=None):
        metadata={"format":"dordiai-native-word-membership","format_version":1,
                  "normalization":runtime.NORMALIZATION,"codes":list(codes),"word_count":count,
                  "membership_mask_bytes":(len(codes)+7)//8}
        metadata.update(metadata_changes or {})
        encoded=json.dumps(metadata,separators=(",",":")).encode()
        compressed=zlib.compress(raw)
        index=runtime.KEY_LENGTH.pack(len(first))+first+runtime.INDEX_ITEM.pack(
            0,len(compressed),len(raw) if raw_size is None else raw_size,count)
        path=self.root/"malformed.bin"
        path.write_bytes(runtime.HEADER.pack(runtime.MAGIC,len(encoded),len(index),1)+encoded+index+compressed)
        return path,hashlib.sha256(path.read_bytes()).hexdigest()

    def test_all_memberships_preserved_and_unknown_does_not_force_a_language(self):
        path,receipt=self.create()
        with runtime.MembershipLexicon(path,receipt["sha256"]) as lexicon:
            self.assertEqual(lexicon.candidates("мама"),frozenset(("uk","ru")))
            self.assertEqual(lexicon.candidates("мови"),frozenset(("uk",)))
            self.assertEqual(lexicon.candidates("кошками"),frozenset(("ru",)))
            self.assertEqual(lexicon.candidates("невідомий-тестовий-запит"),frozenset())
            self.assertEqual(lexicon.candidates(""),frozenset())
            self.assertEqual(lexicon.candidates("два слова"),frozenset())

    def test_cyrillic_stress_apostrophe_and_yo_normalization(self):
        path,receipt=self.create()
        with runtime.MembershipLexicon(path,receipt["sha256"]) as lexicon:
            self.assertEqual(lexicon.lookup("МО́ВИ"),{"uk"})
            self.assertEqual(lexicon.lookup("пʼять"),{"uk"})
            self.assertEqual(lexicon.lookup("СЁ́МГА"),{"ru"})
            self.assertEqual(lexicon.lookup("семга"),set(),"No unrecorded е/ё substitution")

    def test_latin_diacritics_are_not_folded_into_other_native_languages(self):
        path,receipt=self.create()
        with runtime.MembershipLexicon(path,receipt["sha256"]) as lexicon:
            self.assertEqual(lexicon.lookup("KŮŇ"),{"cs"})
            self.assertEqual(lexicon.lookup("KÔŇ"),{"sk"})
            self.assertEqual(lexicon.lookup("CAFE\u0301"),{"en"})
            self.assertEqual(lexicon.lookup("kun"),set())
            self.assertEqual(lexicon.lookup("cafe"),set())

    def test_exact_writer_is_deterministic_and_authenticated(self):
        one,first=self.create(filename="one.bin")
        two,second=self.create(filename="two.bin")
        self.assertEqual(one.read_bytes(),two.read_bytes())
        self.assertEqual(first["sha256"],second["sha256"])
        with self.assertRaises(runtime.LexiconError):
            runtime.MembershipLexicon(one,"0"*64)

    def test_failed_constructor_releases_its_file_handle(self):
        path,receipt=self.create()
        with self.assertRaises(runtime.LexiconError):
            runtime.MembershipLexicon(path,"0"*64)
        replacement=self.root/"replacement.bin"
        replacement.write_bytes(path.read_bytes())
        os.replace(replacement,path)  # Also meaningful on Windows's open-file sharing rules.
        with runtime.MembershipLexicon(path,receipt["sha256"]) as lexicon:
            self.assertEqual(lexicon.lookup("мама"),{"uk","ru"})

    def test_bad_prefix_is_rejected_instead_of_creating_a_word(self):
        path,digest=self.malformed(self.record(9,1,1)+b"a")
        with runtime.MembershipLexicon(path,digest) as lexicon:
            with self.assertRaises(runtime.LexiconError):
                lexicon.lookup("a")

    def test_invalid_membership_bits_are_rejected(self):
        path,digest=self.malformed(self.record(0,1,4)+b"a")
        with runtime.MembershipLexicon(path,digest) as lexicon:
            with self.assertRaises(runtime.LexiconError):
                lexicon.lookup("a")

    def test_non_utf8_word_payload_is_rejected(self):
        path,digest=self.malformed(self.record(0,1,1)+b"\xff")
        with runtime.MembershipLexicon(path,digest) as lexicon:
            with self.assertRaises(ValueError):
                lexicon.lookup("a")

    def test_decompression_is_limited_to_the_declared_bounded_block(self):
        path,digest=self.malformed(b"x"*(1024*1024),raw_size=runtime.WORD_ITEM.size+1)
        with runtime.MembershipLexicon(path,digest) as lexicon:
            with self.assertRaises(runtime.LexiconError):
                lexicon.lookup("a")
            self.assertEqual(lexicon.statistics()["cached_blocks"],0)

    def test_duplicate_codes_and_boolean_counts_are_rejected(self):
        for changes in ({"codes":["uk","uk"]},{"word_count":True}):
            path,digest=self.malformed(runtime.WORD_ITEM.pack(0,1,1)+b"a",metadata_changes=changes)
            with self.assertRaises(runtime.LexiconError):
                runtime.MembershipLexicon(path,digest)
            path.unlink()

    def test_header_index_offset_and_resource_size_bounds_are_enforced(self):
        path,receipt=self.create()
        data=bytearray(path.read_bytes())
        magic,meta_size,index_size,count=runtime.HEADER.unpack_from(data)
        start=runtime.HEADER.size+meta_size
        first_length=runtime.KEY_LENGTH.unpack_from(data,start)[0]
        cursor=start+runtime.KEY_LENGTH.size+first_length
        offset,compressed,raw_size,words=runtime.INDEX_ITEM.unpack_from(data,cursor)
        runtime.INDEX_ITEM.pack_into(data,cursor,1,compressed,raw_size,words)
        path.write_bytes(data)
        with self.assertRaises(runtime.LexiconError):
            runtime.MembershipLexicon(path,hashlib.sha256(data).hexdigest())
        with patch.object(runtime,"MAX_FILE_BYTES",runtime.HEADER.size):
            with self.assertRaises(runtime.LexiconError):
                runtime.MembershipLexicon(path,hashlib.sha256(data).hexdigest())

    def many_words(self):
        return {"слово"+chr(1072+i//32)+chr(1072+i%32):1 for i in range(512)}

    def test_block_cache_is_bounded_by_count_and_charged_bytes(self):
        words=self.many_words()
        path,receipt=self.create(words=words,codes=("uk",),block_words=8)
        with runtime.MembershipLexicon(path,receipt["sha256"],cache_blocks=2,cache_bytes=4000) as lexicon:
            for word in words:
                self.assertEqual(lexicon.lookup(word),{"uk"})
            info=lexicon.statistics()
            self.assertLessEqual(info["cached_blocks"],2)
            self.assertLessEqual(info["cache_bytes_charged"],4000)
            self.assertEqual(info["word_count"],512)

    def test_full_build_scan_is_semantic_and_keeps_the_same_cache_bounds(self):
        words=self.many_words()
        path,receipt=self.create(words=words,codes=("uk",),block_words=8)
        self.assertEqual(receipt["full_validation"]["validated_words"],512)
        with runtime.MembershipLexicon(path,receipt["sha256"],cache_blocks=2,cache_bytes=4000) as lexicon:
            validation=lexicon.validate_all()
            self.assertEqual(validation["validated_words"],512)
            self.assertEqual(validation["validated_blocks"],64)
            self.assertLessEqual(lexicon.statistics()["cached_blocks"],2)
            self.assertLessEqual(lexicon.statistics()["cache_bytes_charged"],4000)

    def test_lookup_works_with_no_decoded_cache(self):
        path,receipt=self.create()
        with runtime.MembershipLexicon(path,receipt["sha256"],cache_blocks=0,cache_bytes=0) as lexicon:
            self.assertEqual(lexicon.lookup("мама"),{"uk","ru"})
            self.assertEqual(lexicon.statistics()["cached_blocks"],0)

    def test_path_and_descriptor_ctime_are_compared_to_their_own_snapshots(self):
        path,receipt=self.create()
        real_fstat=os.fstat
        delta={"value":1000}
        def separate_ctime(fd):
            value=real_fstat(fd)
            return SimpleNamespace(st_mode=value.st_mode,st_dev=value.st_dev,st_ino=value.st_ino,
                st_size=value.st_size,st_mtime_ns=value.st_mtime_ns,st_ctime_ns=value.st_ctime_ns+delta["value"])
        with patch.object(runtime.os,"fstat",side_effect=separate_ctime):
            with runtime.MembershipLexicon(path,receipt["sha256"]) as lexicon:
                self.assertEqual(lexicon.lookup("мама"),{"uk","ru"})
                delta["value"]=2000
                with self.assertRaises(runtime.StaleLexiconError):
                    lexicon.lookup("мама")

    def test_changed_resource_is_rejected_even_when_the_word_block_was_cached(self):
        path,receipt=self.create()
        with runtime.MembershipLexicon(path,receipt["sha256"]) as lexicon:
            self.assertEqual(lexicon.lookup("мама"),{"uk","ru"})
            info=path.stat()
            os.utime(path,ns=(info.st_atime_ns,info.st_mtime_ns+2000000000))
            with self.assertRaises(runtime.StaleLexiconError):
                lexicon.lookup("мама")

    def test_same_filename_new_dataset_requires_new_authenticated_instance(self):
        path,first=self.create(words={"мама":3},codes=("uk","ru"))
        old=runtime.MembershipLexicon(path,first["sha256"])
        old.close()  # Real managed replacement must quiesce/close mapped readers first.
        replacement,second=self.create(words={"мама":1},codes=("uk","ru"),filename="new.bin")
        os.replace(replacement,path)
        with self.assertRaises(runtime.LexiconError):
            old.lookup("мама")
        with self.assertRaises(runtime.LexiconError):
            runtime.MembershipLexicon(path,first["sha256"])
        with runtime.MembershipLexicon(path,second["sha256"]) as new:
            self.assertEqual(new.lookup("мама"),{"uk"})
            self.assertNotEqual(new.dataset_sha256,old.dataset_sha256)

    def test_cancelled_open_is_not_unknown_membership_and_releases_file(self):
        path,receipt=self.create()
        with self.assertRaises(runtime.LexiconCancelled):
            runtime.MembershipLexicon(path,receipt["sha256"],cancelled=lambda:True)
        replacement=self.root/"replacement.bin"
        replacement.write_bytes(path.read_bytes())
        os.replace(replacement,path)

    def test_cancellation_during_block_decode_does_not_commit_new_cache_data(self):
        path,receipt=self.create()
        with runtime.MembershipLexicon(path,receipt["sha256"]) as lexicon:
            calls=iter((False,False,True))
            with self.assertRaises(runtime.LexiconCancelled):
                lexicon.lookup("мама",cancelled=lambda:next(calls))
            self.assertEqual(lexicon.statistics()["cached_blocks"],0)
            self.assertEqual(lexicon.lookup("мама"),{"uk","ru"})

    def test_parallel_queries_do_not_corrupt_cache_or_membership(self):
        path,receipt=self.create()
        with runtime.MembershipLexicon(path,receipt["sha256"]) as lexicon:
            with ThreadPoolExecutor(max_workers=4) as workers:
                results=list(workers.map(lexicon.lookup,["мама","мови","сёмга","kůň"]*25))
            self.assertEqual(results,[{"uk","ru"},{"uk"},{"ru"},{"cs"}]*25)

    def test_writer_rejects_unsorted_and_out_of_range_masks_without_partial_artifact(self):
        for records in ([(b"b",1),(b"a",1)],[(b"a",4)]):
            path=self.root/"refused.bin"
            with self.assertRaises(ValueError):
                builder.write_memberships(path,records,codes=("uk","ru"))
            self.assertFalse(path.exists())
            self.assertFalse(list(self.root.glob("refused.bin.payload-*")))

    def test_writer_cannot_replace_an_existing_artifact(self):
        path=self.root/"existing.bin"
        path.write_bytes(b"owned pre-existing artifact")
        with self.assertRaises(FileExistsError):
            builder.write_memberships(path,[(b"a",1)],codes=("uk",))
        self.assertEqual(path.read_bytes(),b"owned pre-existing artifact")

    def test_benchmark_percentiles_use_even_median_and_nearest_rank_tail(self):
        probe=load("membership_probe_statistics_test",ROOT/"tools/probe_native_membership.py")
        summary=probe.percentiles([4.,1.,3.,2.])
        self.assertEqual(summary["median_ms"],2.5)
        self.assertEqual(summary["p95_ms"],4.)
        self.assertEqual(summary["p99_ms"],4.)
        self.assertIsNone(probe.percentiles([]))

    def test_benchmark_rejects_an_unproven_source_query_receipt(self):
        probe=load("membership_probe_receipt_test",ROOT/"tools/probe_native_membership.py")
        with self.assertRaises(ValueError):
            probe.queries_from_source({"status":"fixture-only","non_initial_forms_not_in_frequency_sample":{}})

    def test_language_table_roundtrip_preserves_membership_above_64_and_135_languages(self):
        codes=tuple("x"+chr(97+i//26)+chr(97+i%26) for i in range(135))
        mask=1|(1<<134)
        path,receipt=self.create(words={"мама":mask},codes=codes)
        with runtime.MembershipLexicon(path,receipt["sha256"]) as lexicon:
            self.assertEqual(lexicon.lookup("мама"),{codes[0],codes[134]})
            self.assertEqual(lexicon.statistics()["membership_mask_bytes"],17)
            self.assertEqual(lexicon.statistics()["language_table_limit"],1024)

    def test_cancellation_during_index_parse_closes_partial_instance(self):
        path,receipt=self.create(words=self.many_words(),codes=("uk",),block_words=1)
        original=runtime.MembershipLexicon._read_index
        phase={"active":False,"calls":0}
        def cancelled():
            if not phase["active"]:
                return False
            phase["calls"]+=1
            return phase["calls"]>=3
        def parsing(instance,callback=None):
            phase["active"]=True
            return original(instance,callback)
        with patch.object(runtime.MembershipLexicon,"_read_index",parsing):
            with self.assertRaises(runtime.LexiconCancelled):
                runtime.MembershipLexicon(path,receipt["sha256"],cancelled=cancelled)
        self.assertLessEqual(phase["calls"],3)
        replacement=self.root/"closed-index.bin"
        replacement.write_bytes(path.read_bytes())
        os.replace(replacement,path)

    def test_cancellation_after_complete_index_cannot_publish_a_live_instance(self):
        path,receipt=self.create()
        original=runtime.MembershipLexicon._read_index
        phase={"cancelled":False}
        def parsing(instance,callback=None):
            result=original(instance,callback)
            phase["cancelled"]=True
            return result
        with patch.object(runtime.MembershipLexicon,"_read_index",parsing):
            with self.assertRaises(runtime.LexiconCancelled):
                runtime.MembershipLexicon(path,receipt["sha256"],cancelled=lambda:phase["cancelled"])

    def test_cli_report_output_alias_is_rejected_before_build_or_source_changes(self):
        acquisition,digest,files=self.acquisition_fixture()
        output=self.root/"new.bin"
        alias=self.root/"not-created"/".."/"new.bin"
        before={path:path.read_bytes() for path in acquisition.parent.iterdir()}
        with self.assertRaises(ValueError):
            builder.main(["--acquisition-report",str(acquisition),"--expected-report-sha256",digest,
                          "--output",str(output),"--report",str(alias)])
        self.assertFalse(output.exists())
        self.assertFalse((self.root/"not-created").exists())
        for path,raw in before.items():
            self.assertEqual(path.read_bytes(),raw)

    def test_cli_cannot_overwrite_authenticated_receipt_or_normalized_source_gzip(self):
        acquisition,digest,files=self.acquisition_fixture()
        before={path:path.read_bytes() for path in acquisition.parent.iterdir()}
        for target in (acquisition,acquisition.parent/files["uk"]["filename"]):
            with self.subTest(target=target.name):
                output=self.root/"new.bin"
                with self.assertRaises((ValueError,FileExistsError)):
                    builder.main(["--acquisition-report",str(acquisition),"--expected-report-sha256",digest,
                                  "--output",str(output),"--report",str(target)])
                self.assertFalse(output.exists())
        for path,raw in before.items():
            self.assertEqual(path.read_bytes(),raw)

    def test_existing_report_is_preserved_without_building_an_artifact(self):
        acquisition,digest,files=self.acquisition_fixture()
        report=self.root/"owned-report.json"
        report.write_bytes(b"existing user report")
        output=self.root/"new.bin"
        with self.assertRaises(FileExistsError):
            builder.main(["--acquisition-report",str(acquisition),"--expected-report-sha256",digest,
                          "--output",str(output),"--report",str(report)])
        self.assertFalse(output.exists())
        self.assertEqual(report.read_bytes(),b"existing user report")

    def test_owned_report_is_atomic_no_clobber_and_successful_cli_receipt_matches_binary(self):
        acquisition,digest,files=self.acquisition_fixture()
        output,report=self.root/"new.bin",self.root/"new-report.json"
        with redirect_stdout(io.StringIO()):
            self.assertEqual(builder.main(["--acquisition-report",str(acquisition),
                "--expected-report-sha256",digest,"--output",str(output),"--report",str(report)]),0)
        receipt=json.loads(report.read_text(encoding="utf-8"))
        self.assertEqual(receipt["artifact"]["sha256"],hashlib.sha256(output.read_bytes()).hexdigest())
        original=report.read_bytes()
        with self.assertRaises(FileExistsError):
            builder.publish_owned_report(report,{"would":"overwrite"})
        self.assertEqual(report.read_bytes(),original)
        self.assertFalse(list(self.root.glob("new-report.json.writing-*")))
        with runtime.MembershipLexicon(output,receipt["artifact"]["sha256"]) as lexicon:
            self.assertEqual(lexicon.lookup("мама"),{"uk","ru"})

    def test_cache_limits_and_non_word_inputs_fail_explicitly(self):
        path,receipt=self.create()
        for kwargs in ({"cache_blocks":129},{"cache_bytes":17000000},{"cache_blocks":True}):
            with self.assertRaises(runtime.LexiconError):
                runtime.MembershipLexicon(path,receipt["sha256"],**kwargs)
        with runtime.MembershipLexicon(path,receipt["sha256"]) as lexicon:
            with self.assertRaises(TypeError):
                lexicon.lookup(None)
            self.assertEqual(lexicon.lookup("а"*100000),set())
        self.assertEqual(lexicon.statistics()["cached_blocks"],0)


if __name__=="__main__":
    unittest.main()
