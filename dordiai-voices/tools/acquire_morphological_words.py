"""Acquire exact primary native morphological word forms for isolated research/builds.

This tool never routes speech and never guesses an unknown word. The only code
executed from upstream is the pinned pure-Python DAWG reader in this build's
owned directory. NVDA receives neither pymorphy nor a native Python extension.
"""
from __future__ import annotations

import argparse
import bz2
import gzip
from functools import lru_cache
import hashlib
import importlib
import json
from pathlib import Path, PurePosixPath
import sys
import unicodedata
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NORMALIZATION = "nfc-casefold-cyrillic-acute-apostrophes-v1"
MAX_SOURCE_BYTES = 48 * 1024 * 1024
MAX_EXPANDED_BYTES = 1024 * 1024 * 1024
MAX_RECORDS = 40000000


@lru_cache(maxsize=4096)
def normalize_word(value):
    value = unicodedata.normalize("NFC", value.casefold().translate(
        str.maketrans({"’": "'", "‘": "'", "ʼ": "'"})))
    output = []
    for char in value:
        if char == "\u0301" and output and unicodedata.name(output[-1], "").startswith("CYRILLIC"):
            continue
        output.append(char)
    return "".join(output)


@lru_cache(maxsize=4096)
def native_cyrillic_word(value):
    if not 1 <= len(value) <= 96 or value[0] in "'-" or value[-1] in "'-":
        return False
    return any(char.isalpha() for char in value) and all(
        (char.isalpha() and unicodedata.name(char, "").startswith("CYRILLIC"))
        or char in "'-" for char in value)


def sha256_file(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git_blob_sha1(data):
    return hashlib.sha1(("blob " + str(len(data)) + "\0").encode("ascii") + data).hexdigest()


def download(url, target, *, size, digest=None, git_digest=None):
    target = Path(target)
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in {
        "github.com", "raw.githubusercontent.com", "files.pythonhosted.org"}:
        raise ValueError("Source URL is outside the pinned primary publishers")
    if not 0 < size <= MAX_SOURCE_BYTES:
        raise ValueError("Source size exceeds the acquisition bound")
    if target.exists():
        raise FileExistsError("A fresh acquisition directory is required")
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "Dordiai-primary-word-membership/1"})
    data = bytearray()
    with urllib.request.urlopen(request, timeout=60) as response:
        if urllib.parse.urlsplit(response.geturl()).scheme != "https":
            raise ValueError("Primary source redirected outside HTTPS")
        while chunk := response.read(1024 * 1024):
            data.extend(chunk)
            if len(data) > size:
                raise ValueError("Source exceeds its pinned byte count")
    if len(data) != size:
        raise ValueError("Source byte count differs from its immutable receipt")
    actual = hashlib.sha256(data).hexdigest()
    if digest is not None and actual != digest:
        raise ValueError("Primary source SHA256 differs")
    if git_digest is not None and git_blob_sha1(data) != git_digest:
        raise ValueError("Pinned build-reader Git blob differs")
    target.write_bytes(data)
    return {"bytes": len(data), "sha256": actual, "url": url}


def vesum_records(lines):
    """Yield normalized spelling, genuinely non-lemma form, bad-analysis flag."""
    lemma, inherited_bad = None, False
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        fields = line.split()
        if len(fields) < 2:
            raise ValueError("Unrecognized VESUM full-form record")
        word, tag = normalize_word(fields[0]), fields[1]
        bad = bool({"bad", "err"} & set(tag.split(":")))
        indented = line[0].isspace()
        if not indented:
            lemma, inherited_bad = word, bad
        yield word, bool(indented and lemma is not None and word != lemma), bool(bad or inherited_bad)


def russian_records(dictionary):
    """Stored exact WordsDawg records, never analyzer guesses or substitutions."""
    for word, record in dictionary.iteritems():
        if not isinstance(record, tuple) or len(record) != 2:
            raise ValueError("Unexpected WordsDawg >HH record")
        yield normalize_word(word), bool(record[1] != 0), False


class StableSample:
    """Deterministic source-wide sample, without hand-selected evaluation words."""
    def __init__(self, code, excluded=(), maximum=32):
        self.code, self.excluded, self.maximum = code, excluded, maximum
        self.values = {}
        self.largest = None

    def offer(self, word):
        if word in self.excluded or word in self.values:
            return
        digest = hashlib.sha256((self.code + "\0" + word).encode("utf-8")).hexdigest()
        if len(self.values) < self.maximum:
            self.values[word] = digest
            if len(self.values) == self.maximum:
                self.largest = max(self.values, key=lambda key: (self.values[key], key))
        elif (digest, word) < (self.values[self.largest], self.largest):
            del self.values[self.largest]
            self.values[word] = digest
            self.largest = max(self.values, key=lambda key: (self.values[key], key))

    def words(self):
        return sorted(self.values, key=lambda word: (self.values[word], word))


def collect_records(records, code, frequency):
    words, sample = set(), StableSample(code, frequency)
    counts = {"records": 0, "excluded_bad_analysis": 0, "excluded_non_native_token": 0,
              "accepted_records": 0, "non_initial_forms": 0}
    for word, inflected, bad in records:
        counts["records"] += 1
        if counts["records"] % 1000000 == 0:
            print(json.dumps({"stage":"enumerating-primary-forms","language":code,"records":counts["records"],"unique_words_so_far":len(words)}),flush=True)
        if counts["records"] > MAX_RECORDS:
            raise ValueError("Primary morphology record count exceeds quota")
        if bad:
            counts["excluded_bad_analysis"] += 1
            continue
        if not native_cyrillic_word(word):
            counts["excluded_non_native_token"] += 1
            continue
        words.add(word)
        counts["accepted_records"] += 1
        if inflected:
            counts["non_initial_forms"] += 1
            sample.offer(word)
    counts["unique_words"] = len(words)
    return words, counts, sample.words()


def write_words(path, words):
    path = Path(path)
    raw_hash, raw_bytes = hashlib.sha256(), 0
    with path.open("xb") as target:
        with gzip.GzipFile(filename="", fileobj=target, mode="wb", mtime=0, compresslevel=9) as stream:
            for word in sorted(words):
                raw = (word + "\n").encode("utf-8")
                raw_hash.update(raw)
                raw_bytes += len(raw)
                stream.write(raw)
    return {"filename": path.name, "word_count": len(words), "bytes": path.stat().st_size,
            "sha256": sha256_file(path), "expanded_sha256": raw_hash.hexdigest(),
            "expanded_bytes": raw_bytes}


def load_frequency(path):
    path = Path(path)
    if not path.is_file():
        return {}, {"available": False}
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        document = json.load(stream)
    if document.get("format") != "dordiai-cyrillic-lexicon-v1" or document.get("codes") != ["uk", "ru"]:
        raise ValueError("Unexpected existing frequency lexicon")
    values = document["words"]
    if not isinstance(values, dict) or any(not isinstance(word, str) or type(mask) is not int or mask not in (1, 2, 3)
                                           for word, mask in values.items()):
        raise ValueError("Malformed existing frequency lexicon")
    return values, {"available": True, "sha256": sha256_file(path),
                    "bytes": path.stat().st_size, "unique_words": len(values),
                    "scope": "existing finite frequency resource; not native morphology"}


def install_build_reader(manifest, root):
    reader = manifest["build_reader"]
    receipts = {}
    vendor = root / "build-reader"
    for name, item in reader["files"].items():
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name or ":" in name:
            raise ValueError("Unsafe fixed build-reader path")
        url = ("https://raw.githubusercontent.com/" + reader["repository"] + "/" +
               reader["commit"] + "/" + name)
        receipts[name] = download(url, vendor.joinpath(*relative.parts),
            size=item["size_bytes"], git_digest=item["git_blob_sha1"])
    if "dawg_python" in sys.modules:
        raise ValueError("An unpinned DAWG reader was already imported")
    sys.path.insert(0, str(vendor))
    module = importlib.import_module("dawg_python")
    if not Path(module.__file__).resolve().is_relative_to(vendor.resolve()):
        raise ValueError("Build reader resolved outside the verified source tree")
    return module, receipts


def russian_dictionary(path, reader, root):
    with zipfile.ZipFile(path) as archive:
        if len(archive.infolist()) > 1024:
            raise ValueError("Dictionary wheel has too many members")
        for info in archive.infolist():
            value = PurePosixPath(info.orig_filename)
            if (info.orig_filename != info.filename or value.is_absolute() or ".." in value.parts
                    or "\\" in info.orig_filename or ":" in info.orig_filename):
                raise ValueError("Unsafe dictionary wheel member")
        name = "pymorphy3_dicts_ru/data/words.dawg"
        info = archive.getinfo(name)
        if not 0 < info.file_size <= 128 * 1024 * 1024:
            raise ValueError("WordsDawg exceeds the expanded quota")
        data = archive.read(name)
        dictionary_path = root / "source-words.dawg"
        dictionary_path.write_bytes(data)
        if archive.getinfo("pymorphy3_dicts_ru/data/meta.json").file_size > 1024 * 1024:
            raise ValueError("Russian source metadata exceeds quota")
        metadata = archive.read("pymorphy3_dicts_ru/data/meta.json")
        meta = dict(json.loads(metadata))
        for info in archive.infolist():
            if info.filename.endswith(".dist-info/METADATA") and info.file_size <= 65536:
                (root / "RU-PUBLISHER-METADATA.txt").write_bytes(archive.read(info))
        receipt = {"words_dawg_bytes": len(data), "words_dawg_sha256": hashlib.sha256(data).hexdigest(),
                   "metadata": meta}
    return reader.RecordDAWG(">HH").load(str(dictionary_path)), receipt


def acquire(manifest_path, output, frequency_path):
    manifest_path, output = Path(manifest_path), Path(output)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format") != "dordiai-native-morphology-sources" or manifest.get("normalization") != NORMALIZATION:
        raise ValueError("Unknown primary-source manifest")
    output.mkdir(parents=True, exist_ok=False)
    frequency, old_receipt = load_frequency(frequency_path)
    report = {"format": "dordiai-primary-native-word-membership", "format_version": 1,
        "normalization": NORMALIZATION, "source_manifest_sha256": sha256_file(manifest_path),
        "sources": manifest["sources"], "frequency_baseline": old_receipt,
        "scope": "Actual finite primary full-form lexicons; no neural guessing or per-word network",
        "runtime_lookup_verified": False, "language_identification_infallible": False,
        "build_reader_shipped_to_nvda": False, "status": "acquiring"}
    report_path = output / "acquisition-report.json"
    def save():
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    save()
    try:
        cache = output / "source-cache"
        receipts = {}
        for code in ("uk", "ru"):
            item = manifest["sources"][code]
            name = "vesum-full-forms.bz2" if code == "uk" else "opencorpora-compiled.whl"
            receipts[code] = download(item["url"], cache / name, size=item["size_bytes"], digest=item["sha256"])
        reader, reader_receipts = install_build_reader(manifest, output)
        report["source_receipts"], report["build_reader_receipts"] = receipts, reader_receipts
        # The expanded source stays streaming. No frequency ranking creates a label.
        expanded = 0
        def lines():
            nonlocal expanded
            with bz2.open(cache / "vesum-full-forms.bz2", "rt", encoding="utf-8") as stream:
                for line in stream:
                    expanded += len(line.encode("utf-8"))
                    if expanded > MAX_EXPANDED_BYTES:
                        raise ValueError("Expanded VESUM exceeds quota")
                    yield line
        uk, uk_counts, uk_sample = collect_records(vesum_records(lines()), "uk", frequency)
        dictionary, ru_receipt = russian_dictionary(cache / "opencorpora-compiled.whl", reader, output)
        if str(ru_receipt["metadata"].get("source_revision")) != str(manifest["sources"]["ru"]["source_revision"]):
            raise ValueError("Published Russian dictionary source revision differs")
        ru, ru_counts, ru_sample = collect_records(russian_records(dictionary), "ru", frequency)
        if min(len(uk), len(ru)) < 100000:
            raise ValueError("Primary full-form source unexpectedly small")
        common = uk & ru
        if not common:
            raise ValueError("No shared spellings found; primary parser requires investigation")
        report["counts"] = {"uk": uk_counts, "ru": ru_counts, "uk_only": len(uk)-len(common),
                            "ru_only": len(ru)-len(common), "shared_spellings": len(common),
                            "union": len(uk)+len(ru)-len(common)}
        report["uk_expanded_source_bytes"], report["ru_dictionary_receipt"] = expanded, ru_receipt
        report["word_files"] = {code: write_words(output / (code+"-native-words.txt.gz"), words)
                                for code, words in (("uk", uk), ("ru", ru))}
        def memberships(word):
            return [code for code, values in (("uk", uk), ("ru", ru)) if word in values]
        report["non_initial_forms_not_in_frequency_sample"] = {
            code: [{"word": word, "memberships": memberships(word), "source": code,
                    "old_frequency_mask": frequency.get(word, 0)} for word in sample]
            for code, sample in (("uk", uk_sample), ("ru", ru_sample))}
        shared_sample = StableSample("shared")
        for word in common:
            shared_sample.offer(word)
        report["ambiguous_membership_sample"] = shared_sample.words()
        disagreements, disagreement_sample = 0, StableSample("frequency-disagreement")
        for word, old_mask in frequency.items():
            native_mask = int(word in uk) | (int(word in ru) << 1)
            if native_mask and native_mask != old_mask:
                disagreements += 1
                disagreement_sample.offer(word)
        report["existing_frequency_comparison"] = {
            "disagreement_count": disagreements,
            "scope": "Finite dictionaries can themselves omit or mark variants; disagreement is not a proof of author intent.",
            "sample": [{"word": word, "old_frequency_mask": frequency[word], "native_memberships": memberships(word)}
                       for word in disagreement_sample.words()]}
        report["status"] = "source-membership-acquired"
        (output / "SOURCE-NOTICES.json").write_text(json.dumps({
            "normalization": NORMALIZATION, "sources": manifest["sources"],
            "build_reader": manifest["build_reader"], "changes": [
                "Enumerated exact source forms, casefolded/NFC-normalized; Cyrillic acute stress removed.",
                "Folded typographic apostrophes; excluded non-Cyrillic/multiword tokens and VESUM bad/err analyses.",
                "Retained all attested cross-language memberships; no automatic e/yo merging or guessed forms."]},
            ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
        save()
        return report
    except Exception as error:
        report.update(status="failed", error_type=type(error).__name__)
        save()
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, default=ROOT/"training-data/native-word-membership/sources.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--frequency", type=Path,
        default=ROOT/"source/0.12.2/kx47Runtime/models/WordLanguage/cyrillic-lexicon.json.gz")
    args = parser.parse_args(argv)
    report = acquire(args.sources, args.output, args.frequency)
    print(json.dumps({key:report.get(key) for key in ("status","counts","word_files","runtime_lookup_verified")},
                     ensure_ascii=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
