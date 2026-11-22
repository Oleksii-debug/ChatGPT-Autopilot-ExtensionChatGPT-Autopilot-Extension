"""Independently reconstruct every source stream from a compiled DMLX resource.

The reference is the authenticated acquisition's exact expanded UTF-8 stream
SHA256, byte count and word count for each language. No builder merge generator,
frequency model, handpicked word, or whole-dictionary Python set is used.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("_dordiai_native_membership_full_audit",
    ROOT/"source/0.12.2/kx47Runtime/native_word_membership.py")
runtime=importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def sha256_file(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream,"sha256").hexdigest()


def audit(lexicon,expected_sha256,acquisition,expected_report_sha256,*,cancelled=None):
    acquisition=Path(acquisition)
    if acquisition.stat().st_size>4*1024*1024 or sha256_file(acquisition)!=expected_report_sha256:
        raise ValueError("Acquisition source receipt differs")
    document=json.loads(acquisition.read_text(encoding="utf-8"))
    if (document.get("format")!="dordiai-primary-native-word-membership" or
            document.get("status")!="source-membership-acquired" or
            document.get("normalization")!=runtime.NORMALIZATION):
        raise ValueError("No authenticated completed source acquisition")
    started=time.perf_counter()
    total,shared=0,0
    with runtime.MembershipLexicon(lexicon,expected_sha256,cancelled=cancelled) as reader:
        if set(reader.codes)!=set(document["word_files"]):
            raise ValueError("Compiled/source language tables differ")
        states={code:{"digest":hashlib.sha256(),"words":0,"bytes":0} for code in reader.codes}
        blocks=reader.statistics()["blocks"]
        for number in range(blocks):
            runtime._check_cancel(cancelled)
            reader.verify_current()
            keys,masks=reader._block(number,cancelled)
            for key,mask in zip(keys,masks):
                total+=1
                if mask.bit_count()>1:
                    shared+=1
                raw=key+b"\n"
                remaining=mask
                while remaining:
                    bit=remaining & -remaining
                    index=bit.bit_length()-1
                    item=states[reader.codes[index]]
                    item["digest"].update(raw)
                    item["words"]+=1
                    item["bytes"]+=len(raw)
                    remaining-=bit
            if (number+1)%4096==0:
                print(json.dumps({"stage":"independent-full-native-source-audit",
                    "decoded_blocks":number+1,"decoded_union_words":total}),flush=True)
        runtime._check_cancel(cancelled)
        reader.verify_current()
        results={}
        for code,value in states.items():
            expected=document["word_files"][code]
            actual={"word_count":value["words"],"expanded_bytes":value["bytes"],
                    "expanded_sha256":value["digest"].hexdigest()}
            if any(actual[key]!=expected[key] for key in actual):
                raise ValueError("Complete reconstructed source membership differs for "+code)
            results[code]={**actual,"matches_authenticated_source":True}
        if total!=document["counts"]["union"] or shared!=document["counts"]["shared_spellings"]:
            raise ValueError("Complete union/shared membership counts differ")
        statistics=reader.statistics()
    return {"format":"dordiai-complete-native-membership-source-equality","format_version":1,
        "status":"passed-full-source-membership-equality","artifact_sha256":expected_sha256,
        "acquisition_report_sha256":expected_report_sha256,
        "normalization":runtime.NORMALIZATION,"validated_blocks":blocks,"validated_union_words":total,
        "shared_spellings":shared,"source_equality":results,"elapsed_seconds":time.perf_counter()-started,
        "statistics":statistics,
        "reference":"Exact per-language UTF-8 word+LF expanded SHA256/bytes/counts from authenticated actual primary acquisition",
        "method":"Read/decode every compiled block once; hash each raw key into all recorded language streams; bounded reader cache only",
        "builder_merge_used_as_reference":False,"whole_dictionary_set_loaded":False,
        "nvda_verified":False,"pronunciation_verified":False,"author_intent_infallible":False}


def publish(path,document):
    path=Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=None
    try:
        with tempfile.NamedTemporaryFile(prefix=path.name+".writing-",dir=path.parent,mode="wb",delete=False) as stream:
            temporary=Path(stream.name)
            stream.write((json.dumps(document,ensure_ascii=False,indent=2)+"\n").encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary,path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lexicon",type=Path,required=True)
    parser.add_argument("--sha256",required=True)
    parser.add_argument("--acquisition-report",type=Path,required=True)
    parser.add_argument("--expected-report-sha256",required=True)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args(argv)
    if args.output.resolve() in {args.lexicon.resolve(),args.acquisition_report.resolve()}:
        raise ValueError("Audit report must not alias a protected source or binary")
    if args.output.exists() or args.output.is_symlink():
        raise FileExistsError("Refusing to overwrite an audit report")
    result=audit(args.lexicon,args.sha256,args.acquisition_report,args.expected_report_sha256)
    publish(args.output,result)
    print(json.dumps(result,ensure_ascii=True),flush=True)
    return 0


if __name__=="__main__":
    raise SystemExit(main())
