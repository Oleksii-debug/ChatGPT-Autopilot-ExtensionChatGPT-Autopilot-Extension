#!/usr/bin/env python3
"""Acquire a small pinned native-word pilot; never train or install a model.

Wiki sources are tiny (3.8/22MB), so we verify COMPLETE shard SHA256 via
bounded HTTP ranges, then parse only the first500 articles' text with PyArrow.
A partial byte read alone cannot establish a whole-shard checksum.
"""
from __future__ import annotations
import argparse
import base64
from collections import Counter
from contextlib import closing
import gzip
from hashlib import sha1, sha256
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import unicodedata
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "tools/data/word_lid_sources_v3_acquisition.json"
ROLES = {"train": 0, "validation": 1, "test": 2}
RANGE_BYTES = 1024 * 1024
MAX_PAYLOAD = 128 * 1024**2
MAX_ARTICLES = 2000
FORMAT = "dordiai-word-lid-native-pilot-v3"
SPLIT_SEED = "dordiai-word-split-v1:"


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def write_report(path, report):
    descriptor, name = tempfile.mkstemp(prefix="acquisition-report-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(json_bytes(report))
            stream.flush()
            os.fsync(stream.fileno())
        if path.is_symlink() or path.exists() and not path.is_file():
            raise ValueError("Unsafe owned report destination")
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def split_word(word, runtime):
    normalized = runtime.normalize_word(word)
    bucket = int.from_bytes(sha256((SPLIT_SEED + normalized).encode("utf-8")).digest()[:4], "big") % 100
    return "train" if bucket < 80 else "validation" if bucket < 90 else "test"


def hash_file(path):
    state = sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(RANGE_BYTES), b""):
            state.update(block)
    return state.hexdigest()


def load_pinned(path, name, expected):
    raw = Path(path).read_bytes()
    actual = sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()
    if actual != expected:
        raise ValueError("Pinned preparation/Unicode source differs: " + Path(path).name)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_manifest(document):
    if (document.get("format") != "dordiai-word-lid-source-acquisition-v3"
            or document.get("format_version") != 1
            or document.get("minimum_effective_training_words") != 100
            or not 1 <= document.get("wiki_max_articles", 0) <= MAX_ARTICLES
            or not 1 <= document.get("wiki_min_document_frequency", 0) <= 10):
        raise ValueError("Unsupported bounded acquisition lock")
    rows = document.get("sources")
    if not isinstance(rows, list) or not rows:
        raise ValueError("Empty source lock")
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Duplicate source lock IDs")
    for row in rows:
        if row["kind"] not in {"aksharantar-jsonl-zip", "wikipedia-train-parquet"}:
            raise ValueError("Unsupported acquisition source kind")
        parts = urllib.parse.urlsplit(row["url"])
        if (parts.scheme != "https" or parts.hostname != "huggingface.co" or parts.query
                or parts.fragment or parts.username or parts.password
                or re.fullmatch("[a-f0-9]{40}", row["revision"]) is None
                or "/" + row["revision"] + "/" not in parts.path
                or re.fullmatch("[a-f0-9]{64}", row["sha256"]) is None):
            raise ValueError("Source must use an immutable public primary-source SHA pin")
        if not row.get("license") or not row.get("license_url") or not row.get("attribution"):
            raise ValueError("Source license and attribution are required")
        if not row.get("native_families") or not row.get("expected_scripts"):
            raise ValueError("Both actual native family and historical model-script policy are required")
        if row["kind"] == "wikipedia-train-parquet":
            expected = "/datasets/wikimedia/wikipedia/resolve/" + row["revision"] + "/20231101." + row["language"] + "/train-00000-of-00001.parquet"
            if (parts.path != expected or row["source_language"] != row["language"]
                    or row["language"] not in {"gn", "ht"} or row.get("publisher_role") != "train"
                    or type(row.get("bytes")) is not int or not 0 < row["bytes"] <= 32 * 1024**2):
                raise ValueError("Wikipedia pilot must be the exact native TRAIN shard")
    pilot = document.get("pilot_languages")
    if not isinstance(pilot, list) or len(set(pilot)) != len(pilot):
        raise ValueError("Invalid pilot language selection")
    selected = [row for row in rows if row.get("pilot") is True]
    if {row["language"] for row in selected} != set(pilot):
        raise ValueError("Pilot switches differ from the explicit language list")
    return selected


def _within(path, directory):
    return path == directory or directory in path.parents


def safe_destinations(cache, output, manifest):
    cache, output = Path(cache).absolute(), Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise FileExistsError("Acquisition output directory must be new")
    for path in (cache, output):
        for parent in (path, *path.parents):
            if parent.exists() and (parent.is_symlink() or getattr(parent, "is_junction", lambda: False)()):
                raise ValueError("Linked acquisition path")
    resolved_cache, resolved_output = cache.resolve(), output.resolve()
    protected = [ROOT / name for name in ("source", "tools", "tests", "training-data", "evidence", "packages")]
    protected.append(ROOT.parent / ".github")
    if any(_within(path, target.resolve()) or _within(target.resolve(), path)
           for path in (resolved_cache, resolved_output) for target in protected):
        raise ValueError("Acquisition destination overlaps protected project files")
    if (_within(resolved_cache, resolved_output) or _within(resolved_output, resolved_cache)
            or _within(Path(manifest).resolve(), resolved_output)
            or _within(Path(manifest).resolve(), resolved_cache)):
        raise ValueError("Source/cache/output paths overlap")
    return cache, output


def _public_final_url(response):
    parts = urllib.parse.urlsplit(response.geturl())
    host = (parts.hostname or "").lower()
    if (parts.scheme != "https" or parts.username or parts.password
            or not (host == "huggingface.co" or host.endswith(".hf.co")
                    or host.endswith(".huggingface.co"))):
        raise ValueError("Source response left public Hugging Face storage")
    # Signed redirect URLs are intentionally neither logged nor persisted.


def acquire_wikipedia(row, cache, helper, opener=urllib.request.urlopen):
    path = cache / (row["id"] + ".source")
    if path.is_symlink():
        raise ValueError("Linked source cache entry")
    if path.exists():
        return path, dict(helper.verify_source(path, row), transfer={
            "mode": "verified-cache", "whole_shard_sha256_verified": True,
            "network_bytes": 0, "ranges": []})
    descriptor, temporary = tempfile.mkstemp(prefix=row["id"] + "-", dir=cache)
    temporary = Path(temporary)
    ranges, network_bytes = [], 0
    try:
        with os.fdopen(descriptor, "wb") as destination:
            offset = 0
            while offset < row["bytes"]:
                end = min(offset + RANGE_BYTES, row["bytes"]) - 1
                request = urllib.request.Request(row["url"], headers={
                    "Range": "bytes=%d-%d" % (offset, end), "Accept-Encoding": "identity",
                    "User-Agent": "dordiai-word-acquisition-v3/1"})
                with opener(request, timeout=120) as response:
                    _public_final_url(response)
                    status = getattr(response, "status", None)
                    if status is None:
                        status = response.getcode()
                    if status == 206:
                        if response.headers.get("Content-Range") != "bytes %d-%d/%d" % (offset, end, row["bytes"]):
                            raise ValueError("HTTP range identity/length differs")
                        wanted = end - offset + 1
                        mode = "range"
                    elif status == 200 and offset == 0:
                        wanted, end, mode = row["bytes"], row["bytes"] - 1, "server-full-response"
                    else:
                        raise ValueError("Server did not honor a bounded source range")
                    state, received = sha256(), 0
                    while True:
                        block = response.read(min(RANGE_BYTES, wanted - received + 1))
                        if not block:
                            break
                        received += len(block)
                        network_bytes += len(block)
                        if received > wanted or network_bytes > row["bytes"]:
                            raise ValueError("Source transfer exceeded its pinned byte budget")
                        state.update(block)
                        destination.write(block)
                    if received != wanted:
                        raise ValueError("Truncated source range")
                    ranges.append({"offset_bytes": offset, "size_bytes": received,
                                   "sha256": state.hexdigest(), "response_mode": mode})
                    offset += received
        receipt = helper.verify_source(temporary, row)
        os.link(temporary, path)
        return path, dict(receipt, transfer={
            "mode": "whole-shard-bounded-http-ranges", "whole_shard_sha256_verified": True,
            "network_bytes": network_bytes, "ranges": ranges})
    finally:
        temporary.unlink(missing_ok=True)


def native_families(word):
    return {unicodedata.name(char, "").partition(" ")[0] for char in word if char.isalpha()}


def tokens(text):
    pending = []
    for char in text:
        if char.isalpha() or unicodedata.category(char).startswith("M") and pending or char in "'’-":
            pending.append(char)
        elif pending:
            yield "".join(pending)
            pending.clear()
    if pending:
        yield "".join(pending)


def accepted_word(raw, row, runtime, counts):
    word = runtime.normalize_word(raw)
    if not runtime.is_valid_word(word):
        counts["invalid_spelling"] += 1
        return None
    families = native_families(word)
    if not families or not families <= set(row["native_families"]):
        counts["wrong_actual_native_family"] += 1
        return None
    script = runtime.word_script(word)
    if script not in row["expected_scripts"]:
        counts["wrong_historical_model_script"] += 1
        return None
    counts["native_family:" + "+".join(sorted(families))] += 1
    counts["legacy_script:" + script] += 1
    counts["accepted_rows"] += 1
    return word


def wikipedia_rows(path, row, runtime, max_articles, min_df):
    import pyarrow.parquet as parquet
    file = parquet.ParquetFile(path)
    names = set(file.schema_arrow.names)
    if not {"id", "url", "text"} <= names:
        raise ValueError("Wikipedia Parquet schema differs from the pinned text corpus")
    remaining, group_records, selected = max_articles, [], []
    for index in range(file.metadata.num_row_groups):
        if remaining <= 0:
            break
        group = file.metadata.row_group(index)
        selected.append(index)
        group_records.append({"index": index, "rows": group.num_rows,
            "columns": [{"name": group.column(k).path_in_schema,
                         "data_page_offset": group.column(k).data_page_offset,
                         "dictionary_page_offset": group.column(k).dictionary_page_offset,
                         "compressed_bytes": group.column(k).total_compressed_size}
                        for k in range(group.num_columns)
                        if group.column(k).path_in_schema in {"id", "url", "text"}]})
        remaining -= group.num_rows
    counts, frequency, documents = Counter(), Counter(), []
    for batch in file.iter_batches(batch_size=min(500, max_articles), row_groups=selected,
                                   columns=["id", "url", "text"], use_threads=False):
        for item in batch.to_pylist():
            if len(documents) >= max_articles:
                break
            if any(not isinstance(item[name], str) for name in ("id", "url", "text")):
                raise ValueError("Wikipedia source row schema differs")
            if not item["url"].startswith("https://" + row["language"] + ".wikipedia.org/wiki/"):
                raise ValueError("Wikipedia native edition URL differs")
            if len(item["text"]) > 2 * 1024**2:
                raise ValueError("Wikipedia article exceeds bounded text size")
            documents.append({"id": item["id"], "url": item["url"],
                              "text_sha256": sha256(item["text"].encode("utf-8")).hexdigest()})
            seen = set()
            for raw in tokens(item["text"]):
                counts["parsed_tokens"] += 1
                word = accepted_word(raw, row, runtime, counts)
                if word:
                    seen.add(word)
            frequency.update(seen)
        if len(documents) >= max_articles:
            break
    kept = sorted(word for word, count in frequency.items() if count >= min_df)
    counts["distinct_words_before_document_frequency"] = len(frequency)
    counts["distinct_words_at_least_%d_documents" % min_df] = len(kept)
    receipt = {"articles": documents, "article_count": len(documents),
               "selected_row_groups": group_records, "columns_read": ["id", "url", "text"],
               "article_selection": "first bounded source rows; no evaluation-score selection",
               "minimum_document_frequency": min_df,
               "parser_counts": dict(sorted(counts.items()))}
    return ((word, "train") for word in kept), receipt


def add_rows(database, rows, language):
    batch = []
    for word, role in rows:
        if role not in ROLES:
            raise ValueError("Unknown original publisher split")
        batch.append((word, language, role))
        if len(batch) >= 2000:
            database.executemany("INSERT OR IGNORE INTO evidence VALUES(?,?,?)", batch)
            batch.clear()
    if batch:
        database.executemany("INSERT OR IGNORE INTO evidence VALUES(?,?,?)", batch)
    database.commit()


def write_corpus(database, output, split_word):
    filename = output / "pilot-corpus.jsonl.gz"
    stats = {}
    for language, in database.execute("SELECT DISTINCT language FROM evidence"):
        stats[language] = {"effective_train_words_min4": 0, "effective_validation_words_min4": 0,
                           "effective_test_words_min4": 0, "publisher_distinct_words": {}}
        stats[language]["publisher_distinct_words"] = dict(database.execute(
            "SELECT role,COUNT(DISTINCT word) FROM evidence WHERE language=? GROUP BY role", (language,)))
    query = """SELECT word,GROUP_CONCAT(DISTINCT language),
        MAX(CASE role WHEN 'test' THEN 2 WHEN 'validation' THEN 1 ELSE 0 END)
        FROM evidence GROUP BY word ORDER BY word"""
    with filename.open("xb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            compressed.write((json.dumps({"format": FORMAT,
                "not_consumable_as_current_v2_training_lock": True,
                "publisher_holdout_priority": "test > validation > train globally; train pools then use original word-hash split",
                "weak_source_labels_not_human_language_truth": True}, sort_keys=True) + "\n").encode("utf-8"))
            for word, labels, priority in database.execute(query):
                publisher_role = ("train", "validation", "test")[priority]
                effective = publisher_role if priority else split_word(word)
                values = sorted(labels.split(","))
                item = {"word": word, "labels": values, "publisher_role": publisher_role,
                        "effective_pilot_split": effective}
                compressed.write((json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
                if len(word) >= 4:
                    for language in values:
                        stats[language]["effective_" + effective + "_words_min4"] += 1
    return {"filename": filename.name, "sha256": hash_file(filename), "size_bytes": filename.stat().st_size}, stats


def acquire_pilot(manifest_path, cache, output):
    manifest_path = Path(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    rows = validate_manifest(manifest)
    cache, output = safe_destinations(cache, output, manifest_path)
    runtime_path = ROOT / "tools/vendor/word_classifier_native_policy_5e532.py"
    helper_path = ROOT / "tools/vendor/prepare_word_lid_sources_a6c01.py"
    runtime = load_pinned(runtime_path, "_v3_native_word_runtime", manifest["runtime_git_blob"])
    helper = load_pinned(helper_path, "_v3_pinned_word_preparer", manifest["preparer_git_blob"])
    cache.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=False)
    report = {"format": FORMAT, "status": "acquiring", "model_trained": False, "model_installed": False,
              "corpus_lock_sha256": hash_file(manifest_path), "source_receipts": [],
              "runtime_git_blob": manifest["runtime_git_blob"], "preparer_git_blob": manifest["preparer_git_blob"],
              "split_reference_trainer_git_blob": "407515f23d87acf9e74fb125ccaadc3177634c3a",
              "split_policy_seed": SPLIT_SEED,
              "minimum_effective_training_words": 100,
              "limits": {"wiki_articles": manifest["wiki_max_articles"], "pilot_languages": manifest["pilot_languages"]},
              "label_quality": "Weak publisher native-word / edition membership; borrowing, names and homographs remain",
              "pronunciation_and_tts_quality_verified": False,
              "future_merge_requirement": "Reapply ALL existingv2/baseline publisher holdouts globally before future model training"}
    database_path = output / "working.sqlite3"
    try:
        with closing(sqlite3.connect(database_path)) as database:
            database.execute("CREATE TABLE evidence(word TEXT,language TEXT,role TEXT,PRIMARY KEY(word,language,role)) WITHOUT ROWID")
            for row in rows:
                report["current_source"] = row["id"]
                if row["kind"] == "wikipedia-train-parquet":
                    path, receipt = acquire_wikipedia(row, cache, helper)
                    parsed, detail = wikipedia_rows(path, row, runtime, manifest["wiki_max_articles"],
                                                    manifest["wiki_min_document_frequency"])
                    add_rows(database, parsed, row["language"])
                    receipt.update(detail)
                else:
                    cached = cache / (row["id"] + ".source")
                    if cached.is_symlink() or cached.exists() and not cached.is_file():
                        raise ValueError("Unsafe native-word cache entry")
                    path, receipt = helper.acquire(row, cache)
                    counts = Counter()
                    def parsed():
                        for raw, role in helper.zip_rows(path, row, counts):
                            counts["parsed_rows"] += 1
                            word = accepted_word(raw, row, runtime, counts)
                            if word:
                                yield word, role
                    add_rows(database, parsed(), row["language"])
                    receipt["parser_counts"] = dict(sorted(counts.items()))
                report["source_receipts"].append(receipt)
                write_report(output / "acquisition-report.json", report)
                print(json.dumps({"source": row["id"], "acquired_and_parsed": True}), flush=True)
            corpus, stats = write_corpus(database, output, lambda word: split_word(word, runtime))
            report["corpus"], report["per_language"] = corpus, stats
            missing = sorted(set(manifest["pilot_languages"]) - set(stats))
            insufficient = sorted(code for code, values in stats.items()
                                  if values["effective_train_words_min4"] < 100)
            report["insufficient_labels"] = sorted(set(missing) | set(insufficient))
            report["status"] = "acquired-not-trained" if not report["insufficient_labels"] else "acquired-insufficient-native-training-words"
            return report
    except Exception as error:
        report.update(status="failed-not-trained", error_type=type(error).__name__)
        raise
    finally:
        database_path.unlink(missing_ok=True)
        (output / "acquisition-report.json").write_bytes(json_bytes(report))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        report = acquire_pilot(args.manifest, args.cache, args.output)
    except Exception as error:
        print("WORD_LID_V3_FAILED " + type(error).__name__, flush=True)
        return 1
    encoded = base64.b64encode(gzip.compress(json_bytes(report), mtime=0)).decode("ascii")
    parts = [encoded[offset:offset + 4096] for offset in range(0, len(encoded), 4096)]
    for number, part in enumerate(parts, 1):
        print("WORD_LID_V3_REPORT_GZIP_B64_PART %d/%d %s" % (number, len(parts), part), flush=True)
    print("WORD_LID_V3_RECEIPT " + json.dumps({"status": report["status"],
          "per_language": report["per_language"], "corpus": report["corpus"],
          "insufficient_labels": report["insufficient_labels"]}, ensure_ascii=True), flush=True)
    return 0 if report["status"] == "acquired-not-trained" else 2


if __name__ == "__main__":
    raise SystemExit(main())
