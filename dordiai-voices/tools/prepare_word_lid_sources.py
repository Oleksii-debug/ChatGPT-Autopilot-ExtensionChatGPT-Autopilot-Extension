#!/usr/bin/env python3
"""Acquire pinned native-word evidence; no TTS models or production files change.

Uses only the standard library. Publisher dev/test spellings are retained as
global exclusions for subsequent training, including other source languages.
Sentence-language membership remains weak word-language evidence.
"""
import argparse
from collections import Counter
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import tempfile
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "tools/data/word_lid_sources_v2.json"
FORMAT = "dordiai-word-lid-extra-v1"
MAX_EXPANDED = 2 * 1024 ** 3
MAX_LINE = 256 * 1024
MAX_SOURCE_BYTES = 128 * 1024 ** 2
ROLES = {"train", "validation", "test"}


def runtime_module():
    path = ROOT / "source/0.12.2/kx47Runtime/word_classifier.py"
    spec = importlib.util.spec_from_file_location("_prepared_word_policy", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, "is_valid_word"):
        raise RuntimeError("Install the source candidate's Unicode word policy before preparing expanded corpora")
    return module


def validate_source(row):
    if not isinstance(row, dict) or re.fullmatch(r"[a-z0-9_-]{1,80}", row.get("id", "")) is None:
        raise ValueError("Invalid source identifier")
    parsed = urllib.parse.urlsplit(row["url"])
    if (parsed.scheme != "https" or parsed.hostname not in {"raw.githubusercontent.com", "huggingface.co"}
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise ValueError("Only pinned public primary-source HTTPS URLs are allowed")
    revision = row.get("revision", "")
    if re.fullmatch(r"[0-9a-f]{40}", revision) is None or "/" + revision + "/" not in parsed.path:
        raise ValueError("Source URL is not pinned to an immutable revision")
    if not any(re.fullmatch(pattern, str(row.get(field, ""))) for field, pattern in
               (("sha256", r"[0-9a-f]{64}"), ("git_blob_sha1", r"[0-9a-f]{40}"))):
        raise ValueError("Source lacks a content checksum pin")
    if row.get("kind") not in {"pos", "conllu", "aksharantar-jsonl-zip"}:
        raise ValueError("Unknown native-word source format")
    if not row.get("license") or not row.get("license_url") or not row.get("attribution"):
        raise ValueError("Dataset license/attribution must be explicit")
    if row["kind"] != "aksharantar-jsonl-zip" and row.get("publisher_role") not in ROLES:
        raise ValueError("Invalid publisher split")
    return row


def verify_source(path, row):
    size = path.stat().st_size
    if not 0 < size <= min(MAX_SOURCE_BYTES, row.get("max_bytes", MAX_SOURCE_BYTES)):
        raise ValueError("Native-word source exceeds byte limit")
    if "bytes" in row and size != row["bytes"]:
        raise ValueError("Native-word source byte count differs from pin")
    digest = hashlib.sha256()
    git = hashlib.sha1(b"blob " + str(size).encode("ascii") + b"\0")
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
            git.update(chunk)
    if "sha256" in row and digest.hexdigest() != row["sha256"]:
        raise ValueError("Native-word source SHA256 differs from pin")
    if "git_blob_sha1" in row and git.hexdigest() != row["git_blob_sha1"]:
        raise ValueError("Native-word source Git object hash differs from pin")
    return {"id": row["id"], "language": row["language"], "source_language": row["source_language"],
            "url": row["url"], "revision": row["revision"], "bytes": size, "sha256": digest.hexdigest(),
            "license": row["license"], "license_url": row["license_url"], "attribution": row["attribution"]}


def acquire(row, cache, *, opener=urllib.request.urlopen):
    validate_source(row)
    path = cache / (row["id"] + ".source")
    if path.exists():
        return path, verify_source(path, row)
    cache.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(row["url"], headers={"User-Agent": "dordiai-word-source-audit/1"})
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=cache, prefix=row["id"] + "-", delete=False) as output:
            temporary = Path(output.name)
            with opener(request, timeout=120) as response:
                total = 0
                for chunk in iter(lambda: response.read(1024 * 1024), b""):
                    total += len(chunk)
                    if total > min(MAX_SOURCE_BYTES, row.get("max_bytes", MAX_SOURCE_BYTES)):
                        raise ValueError("Native-word source exceeded download limit")
                    output.write(chunk)
        receipt = verify_source(temporary, row)
        os.replace(temporary, path)
        return path, receipt
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def bounded_lines(stream):
    while True:
        line = stream.readline(MAX_LINE + 1)
        if not line:
            return
        if len(line) > MAX_LINE:
            raise ValueError("Native-word source has an oversized row")
        yield line.decode("utf-8").rstrip("\r\n")


def text_rows(path, row):
    with path.open("rb") as stream:
        for line in bounded_lines(stream):
            if not line or line.startswith("#"):
                continue
            if row["kind"] == "pos":
                fields = line.rsplit(None, 1)
                if len(fields) != 2:
                    raise ValueError("Malformed native POS token row")
                word, tag = fields
            else:
                fields = line.split("\t")
                if len(fields) != 10:
                    raise ValueError("Malformed CoNLL-U token row")
                if not fields[0].isdigit():
                    continue
                word, tag = fields[1], fields[3]
                if "Foreign=Yes" in fields[5].split("|"):
                    continue
            if tag not in row.get("exclude_upos", ()):
                yield word, row["publisher_role"]


def zip_rows(path, row, counts):
    source_code = row["source_language"]
    pattern = re.compile(re.escape(source_code) + r"_(train|test|valid|val|dev)\.jsonl?$")
    seen = set()
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if len(members) > 64 or sum(item.file_size for item in members) > MAX_EXPANDED:
            raise ValueError("Native-word ZIP exceeds expansion/member limits")
        for member in members:
            name = PurePosixPath(member.filename)
            if "\\" in member.filename or name.is_absolute() or ".." in name.parts:
                raise ValueError("Unsafe native-word ZIP member")
            if member.is_dir():
                continue
            match = pattern.fullmatch(name.name)
            if match is None:
                counts["ignored_archive_members"] += 1
                continue
            if len(name.parts) > 2 or len(name.parts) == 2 and name.parts[0] != source_code:
                raise ValueError("Unexpected native-word ZIP member directory")
            role = {"valid": "validation", "val": "validation", "dev": "validation"}.get(match[1], match[1])
            if role in seen:
                raise ValueError("Duplicate publisher split in native-word ZIP")
            seen.add(role)
            with archive.open(member) as stream:
                for line in bounded_lines(stream):
                    if not line:
                        continue
                    item = json.loads(line)
                    if not isinstance(item, dict) or not isinstance(item.get("native word"), str):
                        raise ValueError("Native-word ZIP row does not use the attested publisher schema")
                    identifier = item.get("unique_identifier")
                    if not isinstance(identifier, str) or not identifier.startswith(source_code):
                        raise ValueError("Native-word row language identifier differs from pinned source")
                    provenance = item.get("source")
                    if not isinstance(provenance, str):
                        raise ValueError("Native-word row lacks its original source field")
                    counts["publisher_source:" + provenance] += 1
                    if provenance.strip().casefold() in {value.strip().casefold()
                            for value in row.get("exclude_sources", ())}:
                        counts["excluded_named_entities"] += 1
                        continue
                    yield item["native word"], role
    if "train" not in seen or "test" not in seen:
        raise ValueError("Pinned native-word ZIP lacks distinct publisher train/test files")


def prepare(manifest, cache, output, languages=None):
    if manifest.get("format") != "dordiai-word-lid-source-lock-v2":
        raise ValueError("Unknown native-word source lock")
    rows = [validate_source(row) for row in manifest["sources"]]
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Duplicate native-word source identifiers")
    if languages:
        requested = set(languages)
        unknown = requested - {row["language"] for row in rows}
        if unknown:
            raise ValueError("Requested languages have no pinned source: " + ", ".join(sorted(unknown)))
        rows = [row for row in rows if row["language"] in requested]
    runtime = runtime_module()
    cache, output = Path(cache), Path(output)
    output.mkdir(parents=True, exist_ok=True)
    receipts = []
    descriptor, database_path = tempfile.mkstemp(prefix="word-source-index-", suffix=".sqlite3", dir=output)
    os.close(descriptor)
    database_path = Path(database_path)
    try:
        with sqlite3.connect(database_path) as database:
            database.execute("CREATE TABLE evidence(word TEXT, language TEXT, role TEXT, PRIMARY KEY(word, language, role)) WITHOUT ROWID")
            for row in rows:
                path, receipt = acquire(row, cache)
                counts = Counter()
                tokens = zip_rows(path, row, counts) if row["kind"] == "aksharantar-jsonl-zip" else text_rows(path, row)
                batch = []
                for raw_word, role in tokens:
                    counts["parsed_rows"] += 1
                    word = runtime.normalize_word(raw_word)
                    if not runtime.is_valid_word(word):
                        counts["invalid_or_unsupported_spelling"] += 1
                        continue
                    if runtime.word_script(word) not in row["expected_scripts"]:
                        counts["wrong_native_script"] += 1
                        continue
                    batch.append((word, row["language"], role))
                    counts["accepted_rows"] += 1
                    if len(batch) >= 2000:
                        database.executemany("INSERT OR IGNORE INTO evidence VALUES(?,?,?)", batch)
                        batch.clear()
                if batch:
                    database.executemany("INSERT OR IGNORE INTO evidence VALUES(?,?,?)", batch)
                database.commit()
                receipt["parser_counts"] = dict(sorted(counts.items()))
                if not counts["accepted_rows"]:
                    raise ValueError("Pinned native-word source produced no usable native words: " + row["id"])
                receipts.append(receipt)
                print(json.dumps({"source": row["id"], "accepted_rows": counts["accepted_rows"]}), flush=True)
            word_count = database.execute("SELECT COUNT(DISTINCT word) FROM evidence").fetchone()[0]
            header = {"format": FORMAT, "normalised_words": word_count, "sources": receipts,
                      "source_lock_sha256": hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
                      "label_quality": "Weak native-word or sentence-language membership; shared labels retained",
                      "publisher_holdout_policy": "test overrides validation and train globally; validation overrides train"}
            target = output / "extra-corpus.jsonl.gz"
            temporary = target.with_suffix(".tmp")
            try:
                with temporary.open("wb") as raw:
                    with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as compressed:
                        compressed.write((json.dumps(header, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
                        query = """SELECT word, GROUP_CONCAT(DISTINCT language),
                            MAX(CASE role WHEN 'test' THEN 2 WHEN 'validation' THEN 1 ELSE 0 END)
                            FROM evidence GROUP BY word ORDER BY word"""
                        for word, labels, priority in database.execute(query):
                            item = {"word": word, "labels": sorted(labels.split(",")),
                                    "publisher_role": ("train", "validation", "test")[priority]}
                            compressed.write((json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        checksum = hashlib.sha256(target.read_bytes()).hexdigest()
        receipt = dict(header, corpus_sha256=checksum, corpus_bytes=target.stat().st_size,
                       trained=False, classifier_language_coverage_verified=False)
        Path(str(target) + ".receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return receipt
    finally:
        database_path.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--languages", nargs="+")
    args = parser.parse_args(argv)
    document = json.loads(args.manifest.read_text(encoding="utf-8"))
    receipt = prepare(document, args.cache, args.output, args.languages)
    print(json.dumps({"status": "prepared-not-trained", "normalised_words": receipt["normalised_words"],
                      "corpus_bytes": receipt["corpus_bytes"], "corpus_sha256": receipt["corpus_sha256"]}))


if __name__ == "__main__":
    main()
