"""Build a compact exact lookup file from an authenticated acquisition receipt.

Only trusted normalized source word streams create entries. No classifier,
frequency label, suffix guess or manually added evaluation word enters a file.
The resulting reader requires no third-party package in the NVDA host.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import heapq
import importlib.util
from itertools import groupby
import json
import os
from pathlib import Path
import tempfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("_dordiai_membership_build_format",
    ROOT/"source/0.12.2/kx47Runtime/native_word_membership.py")
format = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(format)


def sha256_file(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_words(root, receipt, mask):
    name = receipt["filename"]
    if Path(name).name != name or "\\" in name or ":" in name:
        raise ValueError("Unsafe source word filename")
    path = root/name
    if path.stat().st_size != receipt["bytes"] or sha256_file(path) != receipt["sha256"]:
        raise ValueError("Normalized source file differs from its authenticated receipt")
    before = path.stat()
    digest, size, count, previous = hashlib.sha256(), 0, 0, b""
    with gzip.open(path, "rb") as stream:
        for raw in stream:
            if not raw.endswith(b"\n") or len(raw) > format.MAX_KEY_BYTES+1:
                raise ValueError("Normalized source word line exceeds format bounds")
            digest.update(raw)
            size += len(raw)
            key = raw[:-1]
            if not key or key <= previous:
                raise ValueError("Normalized source words are not strictly sorted and unique")
            word = key.decode("utf-8")
            if format.normalize_word(word) != word or not format.valid_word(word):
                raise ValueError("Source word is not canonical single-word membership")
            count += 1
            if count > receipt["word_count"] or size > receipt["expanded_bytes"]:
                raise ValueError("Normalized source exceeds its expanded receipt")
            previous = key
            yield key, mask
    after = path.stat()
    if ((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns) !=
            (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or
            count != receipt["word_count"] or size != receipt["expanded_bytes"] or
            digest.hexdigest() != receipt["expanded_sha256"]):
        raise ValueError("Normalized source identity or expanded content changed")


def merged_memberships(root, word_files, codes):
    streams = [source_words(root, word_files[code], 1 << index) for index,code in enumerate(codes)]
    for key, records in groupby(heapq.merge(*streams), key=lambda value:value[0]):
        mask = 0
        for _, membership in records:
            mask |= membership
        yield key, mask


def encode_block(rows, mask_bytes):
    raw, previous = bytearray(), b""
    for key, mask in rows:
        prefix = 0
        while prefix < min(len(previous),len(key)) and previous[prefix] == key[prefix]:
            prefix += 1
        suffix = key[prefix:]
        raw.extend(format.WORD_ITEM.pack(prefix,len(suffix)))
        raw.extend(mask.to_bytes(mask_bytes,"little"))
        raw.extend(suffix)
        previous = key
    if not 0 < len(raw) <= format.MAX_RAW_BLOCK_BYTES:
        raise ValueError("Encoded block exceeds the fixed decompression bound")
    return bytes(raw)


def write_memberships(output, records, *, codes, source_metadata=None, block_words=256):
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise FileExistsError("Refusing to overwrite a membership artifact")
    if (not isinstance(codes,(list,tuple)) or not 1 <= len(codes) <= format.MAX_CODES or
            len(set(codes)) != len(codes) or not 1 <= block_words <= format.MAX_BLOCK_WORDS):
        raise ValueError("Invalid finite language/code block selection")
    mask_bytes = (len(codes)+7)//8
    output.parent.mkdir(parents=True,exist_ok=True)
    payload_path = None
    created_output = False
    entries, total, previous = [], 0, b""
    try:
        with tempfile.NamedTemporaryFile(prefix=output.name+".payload-",dir=output.parent,
                                         mode="w+b",delete=False) as payload:
            payload_path = Path(payload.name)
            block, block_upper = [], 0
            def flush():
                nonlocal block, block_upper
                if not block:
                    return
                raw = encode_block(block,mask_bytes)
                compressed = zlib.compress(raw,9)
                offset = payload.tell()
                payload.write(compressed)
                entries.append((block[0][0],offset,len(compressed),len(raw),len(block)))
                block, block_upper = [], 0
                if len(entries) > format.MAX_BLOCKS or payload.tell() > format.MAX_FILE_BYTES:
                    raise ValueError("Membership payload exceeds its resource budget")
            for key, mask in records:
                if (not isinstance(key,bytes) or not 0 < len(key) <= format.MAX_KEY_BYTES or key <= previous
                        or type(mask) is not int or not 0 < mask < (1 << len(codes))):
                    raise ValueError("Membership stream is not sorted unique canonical word evidence")
                text = key.decode("utf-8")
                if format.normalize_word(text) != text or not format.valid_word(text):
                    raise ValueError("Membership stream contains a non-canonical word")
                if block and block_upper+len(key)+format.WORD_ITEM.size+mask_bytes > format.MAX_RAW_BLOCK_BYTES:
                    flush()
                block.append((key,mask))
                block_upper += len(key)+format.WORD_ITEM.size+mask_bytes
                previous, total = key, total+1
                if len(block) >= block_words:
                    flush()
            flush()
            if not total:
                raise ValueError("A native dictionary cannot be empty")
            metadata = {"format":"dordiai-native-word-membership","format_version":1,
                "normalization":format.NORMALIZATION,"codes":list(codes),"word_count":total,
                "block_words":block_words,"membership_mask_bytes":mask_bytes,"compression":"independent-zlib/front-coded-UTF8",
                "scope":"finite primary-source exact memberships; shared spellings retain every source language",
                "source":source_metadata or {}}
            raw_metadata = json.dumps(metadata,ensure_ascii=False,sort_keys=True,
                                      separators=(",",":")).encode("utf-8")
            index = bytearray()
            for first,offset,compressed,raw_size,count in entries:
                index.extend(format.KEY_LENGTH.pack(len(first)))
                index.extend(first)
                index.extend(format.INDEX_ITEM.pack(offset,compressed,raw_size,count))
            size = format.HEADER.size+len(raw_metadata)+len(index)+payload.tell()
            if (len(raw_metadata)>format.MAX_META_BYTES or len(index)>format.MAX_INDEX_BYTES
                    or size>format.MAX_FILE_BYTES):
                raise ValueError("Membership metadata/index/file exceeds the NVDA resource bounds")
            payload.seek(0)
            with output.open("xb") as target:
                created_output = True
                target.write(format.HEADER.pack(format.MAGIC,len(raw_metadata),len(index),len(entries)))
                target.write(raw_metadata)
                target.write(index)
                while chunk := payload.read(1024*1024):
                    target.write(chunk)
        digest = sha256_file(output)
        # Open the exact output using the same pure-stdlib authenticated reader.
        with format.MembershipLexicon(output,digest) as reader:
            if reader.word_count != total or reader.codes != tuple(codes):
                raise ValueError("Generated resource identity/count differs")
            full_validation = reader.validate_all()
            statistics = reader.statistics()
        return {"filename":output.name,"bytes":output.stat().st_size,"sha256":digest,
                "word_count":total,"codes":list(codes),"block_count":len(entries),
                "index_bytes":len(index),"metadata_bytes":len(raw_metadata),
                "reader_validation":"actual pure-stdlib authenticated full-index/full-block semantic validation",
                "full_validation":full_validation,
                "statistics":statistics}
    except BaseException:
        if created_output:
            output.unlink(missing_ok=True)
        raise
    finally:
        if payload_path is not None:
            payload_path.unlink(missing_ok=True)


def build(acquisition, output, expected_report_sha256):
    acquisition, output = Path(acquisition), Path(output)
    if sha256_file(acquisition) != expected_report_sha256:
        raise ValueError("Acquisition report differs from the trusted artifact receipt")
    report = json.loads(acquisition.read_text(encoding="utf-8"))
    if (report.get("format")!="dordiai-primary-native-word-membership" or
            report.get("status")!="source-membership-acquired" or
            report.get("normalization")!=format.NORMALIZATION):
        raise ValueError("No completed authentic primary morphology acquisition")
    codes = tuple(report["word_files"])
    metadata = {"acquisition_report_sha256":expected_report_sha256,
        "source_manifest_sha256":report["source_manifest_sha256"],"sources":report["sources"],
        "word_files":report["word_files"],"licenses_preserved":True,
        "build_reader_shipped_to_nvda":False,"frequency_resource_used_as_labels":False}
    result = write_memberships(output,merged_memberships(acquisition.parent,report["word_files"],codes),
                               codes=codes,source_metadata=metadata)
    expected_count = report["counts"]["union"]
    if result["word_count"] != expected_count:
        output.unlink(missing_ok=True)
        raise ValueError("Resource union count differs from the actual source receipt")
    # Independent source-wide samples, not manually inserted evaluation words.
    checks = []
    with format.MembershipLexicon(output,result["sha256"]) as reader:
        for rows in report.get("non_initial_forms_not_in_frequency_sample",{}).values():
            for sample in rows:
                got = reader.candidates(sample["word"])
                expected = frozenset(sample["memberships"])
                if got != expected:
                    raise ValueError("Native source sample changed membership during compaction")
                checks.append({"word":sample["word"],"memberships":sorted(got)})
        for word in report.get("ambiguous_membership_sample",[]):
            if reader.candidates(word) != frozenset(("uk","ru")):
                raise ValueError("Shared attested spelling lost a language during compaction")
    return {"format":"dordiai-compact-native-word-membership-build","format_version":1,
        "status":"built-and-source-sample-checked","artifact":result,
        "acquisition_report_sha256":expected_report_sha256,
        "source_union_count":expected_count,"actual_source_sample_checks":len(checks)+len(report.get("ambiguous_membership_sample",[])),
        "runtime_third_party_extension_required":False,"private_python_abi_extension_required":False,"runtime_network_required":False,
        "language_identification_infallible":False,
        "scope":"actual finite source compaction and stdlib lookup proof; NVDA integration and pronunciation remain separate"}


def preflight_report_paths(acquisition, output, report_path, expected_report_sha256):
    acquisition, output, report_path = Path(acquisition), Path(output), Path(report_path)
    if acquisition.stat().st_size > 4*1024*1024 or sha256_file(acquisition) != expected_report_sha256:
        raise ValueError("Acquisition report differs or exceeds its bounded receipt")
    document = json.loads(acquisition.read_text(encoding="utf-8"))
    protected = {acquisition.resolve()}
    for item in document.get("word_files", {}).values():
        name = item["filename"]
        if Path(name).name != name or chr(92) in name or ":" in name:
            raise ValueError("Unsafe source word filename")
        protected.add((acquisition.parent/name).resolve())
    canonical_report, canonical_output = report_path.resolve(), output.resolve()
    if canonical_report == canonical_output or canonical_report in protected or canonical_output in protected:
        raise ValueError("Report, artifact and authenticated source paths must be distinct")
    if report_path.exists() or report_path.is_symlink():
        raise FileExistsError("Refusing to overwrite an existing membership report")


def publish_owned_report(path, document):
    """Publish complete JSON without replacing even a concurrently created file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=path.name+".writing-",dir=path.parent,
                                         mode="wb",delete=False) as stream:
            temporary = Path(stream.name)
            stream.write((json.dumps(document,ensure_ascii=False,indent=2)+"\n").encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        # Same-directory hard-link publication is atomic and fails if target
        # already exists; it does not have os.replace's overwrite semantics.
        os.link(temporary,path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--acquisition-report",type=Path,required=True)
    parser.add_argument("--expected-report-sha256",required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--report",type=Path,required=True)
    args = parser.parse_args(argv)
    preflight_report_paths(args.acquisition_report,args.output,args.report,args.expected_report_sha256)
    report = build(args.acquisition_report,args.output,args.expected_report_sha256)
    publish_owned_report(args.report, report)
    print(json.dumps(report,ensure_ascii=True),flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
