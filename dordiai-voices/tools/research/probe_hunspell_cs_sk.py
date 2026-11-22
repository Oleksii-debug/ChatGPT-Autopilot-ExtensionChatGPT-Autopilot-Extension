"""Finite Czech/Slovak dictionary-root experiment; never an intent classifier.

Both original Hunspell dictionaries check EVERY retained spelling, so a shared
form keeps both labels. This deliberately does not enumerate all inflections,
infer absence in other languages, modify production resources or call a TTS.
"""
from __future__ import annotations

import argparse
import ctypes
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import time

ROOT = Path(__file__).resolve().parents[2]
REVISION = "c0865a85eb67dc377f2cf8e8fe2c4fa9e53f0dcb"
SOURCE = "https://github.com/LibreOffice/dictionaries/tree/" + REVISION
PINS = {
    "cs_CZ/cs_CZ.aff": (111575, "9ebd2c44607cb515a1f69d96c3215cd27ccb523c"),
    "cs_CZ/cs_CZ.dic": (3656362, "eef8d834994a592926e0e2aed005f38beaed7deb"),
    "cs_CZ/README_en.txt": (13105, "7d4266ad66f7a45846845baf1a8abb8926612985"),
    "sk_SK/sk_SK.aff": (225271, "a1a9eaab1e519059c4c4667486805bbbf2d6144b"),
    "sk_SK/sk_SK.dic": (3362212, "7ce548b22afc2644a1e5f16b830e71ac147070b6"),
    "sk_SK/README_en.txt": (2027, "a3edf6a5dc5094eba7d591308577ac8e6ed7949a"),
    "sk_SK/LICENSE.txt": (67574, "28a351fb4ca7606471af428c257b0786bcd608d9"),
}


def fingerprint(path):
    path = Path(path)
    if any(p.is_symlink() or getattr(p, "is_junction", lambda: False)()
           for p in (path, *path.parents)) or not path.is_file():
        raise ValueError("A primary input must be an ordinary unlinked file")
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"bytes": path.stat().st_size, "sha256": digest}


def verify_sources(directory):
    result = {}
    for name, (size, blob) in PINS.items():
        path = directory / name
        observed = fingerprint(path)
        raw = path.read_bytes()
        actual_blob = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
        if len(raw) != size or actual_blob != blob:
            raise ValueError("Pinned primary source differs: " + name)
        result[name] = {**observed, "git_blob": actual_blob}
    return result


def dictionary_stem(line):
    """Decode one bounded .dic entry; flags/morphology never become word text."""
    if len(line) > 4096:
        raise ValueError("Dictionary entry exceeds the audited bound")
    text = line.split(maxsplit=1)[0] if line.strip() else ""
    result = []
    i = 0
    while i < len(text):
        if text[i] == "/":
            break
        if text[i] == "\\":
            i += 1
            if i == len(text) or text[i] not in ("/", "\\"):
                raise ValueError("Unsupported dictionary escape")
        result.append(text[i])
        i += 1
    return "".join(result)


def load_format():
    path = ROOT / "source/0.12.2/kx47Runtime/native_word_membership.py"
    spec = importlib.util.spec_from_file_location("_dordiai_hunspell_finite_format", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, fingerprint(path)


def compact_memberships(output, sources, counts, fmt):
    """Reuse the existing stdlib format and compare EVERY native-checked row."""
    path = ROOT / "tools/build_native_word_membership.py"
    spec = importlib.util.spec_from_file_location("_dordiai_cs_sk_membership_builder", path)
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    inputs = output / "memberships.jsonl.gz"
    pin = fingerprint(inputs)
    expected_count = counts["cs"] + counts["sk"] - counts["shared"]

    def records():
        count, expanded = 0, 0
        with gzip.open(inputs, "rb") as stream:
            for line in stream:
                expanded += len(line)
                if len(line) > 4096 or expanded > 64 * 1024 * 1024:
                    raise ValueError("Finite native membership stream exceeds bounds")
                row = json.loads(line)
                labels = row.get("labels")
                if (set(row) != {"word", "labels"} or not isinstance(labels, list)
                        or not labels or labels != sorted(set(labels))
                        or not set(labels) <= {"cs", "sk"}):
                    raise ValueError("Malformed native-checked membership row")
                mask = sum(1 << index for index, code in enumerate(("cs", "sk")) if code in labels)
                count += 1
                if count > expected_count:
                    raise ValueError("Finite source count exceeded")
                yield row["word"].encode("utf-8"), mask
        if count != expected_count or fingerprint(inputs) != pin:
            raise ValueError("Native-checked membership source changed")

    target = output / "native-word-cs-sk.bin"
    result = builder.write_memberships(target, records(), codes=("cs", "sk"), source_metadata={
        "source": SOURCE, "input_files": sources, "native_memberships": pin,
        "all_inflections_enumerated": False, "source_scope": "Native-accepted finite dictionary-root candidates only"})
    counts_after = {"cs": 0, "sk": 0, "shared": 0}
    with fmt.MembershipLexicon(target, result["sha256"]) as reader:
        compared = 0
        for raw, mask in records():
            expected = frozenset(code for index, code in enumerate(("cs", "sk")) if mask & (1 << index))
            actual = reader.candidates(raw.decode("utf-8"))
            if actual != expected:
                raise ValueError("Full native source comparison differs after compaction")
            for code in actual:
                counts_after[code] += 1
            counts_after["shared"] += len(actual) == 2
            compared += 1
        statistics = reader.statistics()
    if counts_after != {key: counts[key] for key in counts_after}:
        raise ValueError("Per-language native membership counts changed")
    return {"artifact": result, "all_native_source_rows_compared": compared,
            "all_memberships_equal": True, "per_language_counts": counts_after,
            "stdlib_reader_closed": reader.statistics()["closed"],
            "reader_statistics_before_close": statistics, "builder": fingerprint(path),
            "runtime_third_party_library_required": False, "runtime_network_required": False,
            "nvda_integrated": False}


class NativeDictionaries:
    def __init__(self, library, directory):
        self.library_pin = fingerprint(library)
        self.dll = ctypes.CDLL(str(library))
        self.dll.Hunspell_create.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        self.dll.Hunspell_create.restype = ctypes.c_void_p
        self.dll.Hunspell_destroy.argtypes = [ctypes.c_void_p]
        self.dll.Hunspell_destroy.restype = None
        self.dll.Hunspell_spell.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        self.dll.Hunspell_spell.restype = ctypes.c_int
        self.dll.Hunspell_get_dic_encoding.argtypes = [ctypes.c_void_p]
        self.dll.Hunspell_get_dic_encoding.restype = ctypes.c_char_p
        self.handles = {}
        try:
            for code, locale in (("cs", "cs_CZ"), ("sk", "sk_SK")):
                prefix = directory / locale / locale
                handle = self.dll.Hunspell_create(str(prefix.with_suffix(".aff")).encode(),
                                                 str(prefix.with_suffix(".dic")).encode())
                if not handle:
                    raise RuntimeError("Original native dictionary could not be loaded")
                self.handles[code] = handle
                if self.dll.Hunspell_get_dic_encoding(handle) != b"UTF-8":
                    raise ValueError("This experiment requires the pinned UTF-8 dictionaries")
        except BaseException:
            self.close()
            raise

    def candidates(self, word):
        if not self.handles:
            raise RuntimeError("Native dictionary experiment is closed")
        raw = word.encode("utf-8")
        return frozenset(code for code, handle in self.handles.items()
                         if self.dll.Hunspell_spell(handle, raw) != 0)

    def close(self):
        for handle in self.handles.values():
            self.dll.Hunspell_destroy(handle)
        self.handles.clear()


def run(directory, library, output):
    directory = Path(directory).absolute()
    library = Path(library).resolve(strict=True)
    output = Path(output).absolute()
    if (output.exists() or any(p.is_symlink() or getattr(p, "is_junction", lambda: False)()
                              for p in (output, *output.parents))
            or output.is_relative_to(directory) or directory.is_relative_to(output)
            or output.is_relative_to(ROOT)):
        raise ValueError("Use a fresh external experiment output")
    before = verify_sources(directory)
    fmt, format_pin = load_format()
    words, source_counts = set(), {}
    for locale in ("cs_CZ", "sk_SK"):
        lines = (directory / locale / (locale + ".dic")).read_text(encoding="utf-8").splitlines()
        declared = int(lines.pop(0))
        if len(lines) != declared:
            raise ValueError("Original dictionary entry count differs")
        valid = 0
        for line in lines:
            word = fmt.normalize_word(dictionary_stem(line))
            if fmt.valid_word(word) and len(word.encode("utf-8")) <= fmt.MAX_KEY_BYTES:
                words.add(word)
                valid += 1
        source_counts[locale] = {"declared_entries": declared, "canonical_entry_candidates": valid}
    output.mkdir()
    native = NativeDictionaries(library, directory)
    counts = {"cs": 0, "sk": 0, "shared": 0, "rejected_by_both": 0}
    started = time.perf_counter()
    examples = {}
    try:
        with (output / "memberships.jsonl.gz").open("xb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as stream:
                for word in sorted(words, key=lambda s: s.encode("utf-8")):
                    labels = native.candidates(word)
                    if not labels:
                        counts["rejected_by_both"] += 1
                        continue
                    for code in labels:
                        counts[code] += 1
                    counts["shared"] += len(labels) == 2
                    stream.write((json.dumps({"word": word, "labels": sorted(labels)},
                                              ensure_ascii=False, separators=(",", ":")) + "\n").encode())
        for word in ("žena", "škola", "český", "slovenský", "kůň", "kôň", "řeka", "rieka",
                     "příliš", "príliš", "najkrajší", "nejkrásnější", "qzxqzxqzx"):
            examples[word] = sorted(native.candidates(word))
        if verify_sources(directory) != before or fingerprint(library) != native.library_pin:
            raise ValueError("Original inputs changed during the native experiment")
    finally:
        native.close()
    compact = compact_memberships(output, before, counts, fmt)
    report = {"format": "dordiai-finite-cs-sk-native-dictionary-stem-experiment", "format_version": 1,
              "source": SOURCE, "source_revision": REVISION, "input_files": before,
              "source_licences": {
                  "cs": "GNU GPL, version unspecified in original spellchecker notice",
                  "sk": "Publisher alternatives: GPL-2.0 OR LGPL-2.1 OR MPL-1.1"},
              "executed_tool": fingerprint(Path(__file__)),
              "library": {"path": str(library), **native.library_pin},
              "platform": platform.platform(), "reader_format": format_pin,
              "source_counts": source_counts, "candidate_union": len(words), "counts": counts,
              "compact": compact,
              "examples": examples, "seconds": time.perf_counter() - started,
              "output": fingerprint(output / "memberships.jsonl.gz"),
              "both_native_dictionaries_check_every_candidate": True,
              "native_handles_closed": not native.handles,
              "all_inflections_enumerated": False, "other_language_absence_inferred": False,
              "production_changed": False, "pronunciation_verified": False,
              "nvda_verified": False, "product_ready": False,
              "scope": "Finite original dictionary-root candidates and native spell memberships, not author intent or language correctness for unseen words"}
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source-directory", required=True)
    p.add_argument("--library", required=True)
    p.add_argument("--output", required=True)
    args = p.parse_args()
    print(json.dumps(run(args.source_directory, args.library, args.output), ensure_ascii=False))
