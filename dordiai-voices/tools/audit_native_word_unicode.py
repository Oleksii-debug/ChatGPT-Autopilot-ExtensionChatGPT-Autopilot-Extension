"""Differentially audit Unicode fast paths against the frozen word-cache leaf.

Every Unicode code point is checked in six strings, including acute contexts,
then deterministic mixed strings and custom string subclasses are compared.
The complete reader/cache/block-validation class must remain AST-identical.
This audit itself makes no native language, NVDA, speech or timing claim.
"""
from __future__ import annotations
import argparse
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import struct
import sys
import time
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
BASELINE_BLOB = "1738de70c9a81fab54eddde9f1e3442b9d962813"
MAX_CODEPOINT = 0x110000
DATA_SHA = "21208748a50ebf3f5dd3e2feb94f0f3caf3490c2be784aaca2209462380e6689"
CONTEXTS = (
    lambda c: c,
    lambda c: c+"\u0301",
    lambda c: "а"+c+"\u0301",
    lambda c: c+"\u0301я",
    lambda c: "\u0301"+c,
    lambda c: "A"+c+"\u0301'Б",
)


def source(path, expected):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size < 1024*1024:
        raise ValueError("Bounded reviewed regular module source required")
    raw = path.read_bytes()
    blob = hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest()
    if blob != expected:
        raise ValueError("Reviewed Unicode module Git identity differs")
    return raw


def unchanged_reader_class(original, candidate):
    def rest(raw):
        tree = ast.parse(raw)
        values = []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in ("normalize_word", "valid_word"):
                continue
            if (isinstance(node, ast.Assign) and len(node.targets) == 1
                    and isinstance(node.targets[0], ast.Name)
                    and node.targets[0].id == "_APOSTROPHE_TRANSLATION"):
                continue
            values.append(node)
        return ast.dump(ast.Module(body=values, type_ignores=[]), include_attributes=False)
    if rest(original) != rest(candidate):
        raise ValueError("Changes outside reviewed normalization/word-validity fast paths")
    return True


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def compare(value, original, candidate, digest):
    expected, actual = original.normalize_word(value), candidate.normalize_word(value)
    if expected != actual or type(expected) is not type(actual):
        raise ValueError("Unicode normalization differs for "+ascii(value))
    raw_expected, raw_actual = original.valid_word(value), candidate.valid_word(value)
    normalized_expected = original.valid_word(expected)
    normalized_actual = candidate.valid_word(actual)
    if raw_expected != raw_actual or normalized_expected != normalized_actual:
        raise ValueError("Unicode word validity differs for "+ascii(value))
    encoded = expected.encode("utf-8", errors="surrogatepass")
    digest.update(struct.pack("<I", len(encoded)))
    digest.update(encoded)
    digest.update(bytes((raw_expected, normalized_expected)))


def exhaustive(original, candidate, *, stop=MAX_CODEPOINT, progress=False):
    if type(stop) is not int or not 0 <= stop <= MAX_CODEPOINT:
        raise ValueError("Invalid bounded Unicode range")
    digest = hashlib.sha256()
    for point in range(stop):
        char = chr(point)
        for context in CONTEXTS:
            compare(context(char), original, candidate, digest)
        if progress and point and point % 0x20000 == 0:
            print("UNICODE_FASTPATH_PROGRESS "+str(point), flush=True)
    return {"codepoints": stop, "contexts_each": len(CONTEXTS),
            "string_comparisons": stop*len(CONTEXTS),
            "full_unicode_range": stop == MAX_CODEPOINT,
            "ordered_result_sha256": digest.hexdigest()}


def random_and_special(original, candidate, *, count=50000):
    generator = random.Random(0xD04D1A1)
    pool = ("АБВГҐДЄЁІЇЙЪЬЫЭЯабвгґдеєёіїйыэя"+
            "ABCDEİßŉÉÅΩǅɑ𞤀𐐀汉字ー"+"\u0301\u0304\u0327\u0345\u200c\u200d"+
            "'’‘ʼ-—\0\n\t0123456789_")
    digest = hashlib.sha256()
    for index in range(count):
        length = generator.randrange(141)
        text = "".join(generator.choice(pool) if generator.randrange(4)
            else chr(generator.randrange(MAX_CODEPOINT)) for unused in range(length))
        compare(text, original, candidate, digest)
    # Explicit exact-boundary, marked and apostrophe forms are retained even
    # when deterministic random sampling changes in a later tool revision.
    specials = ("", "а"*96, "а"*97, "-а", "а-", "'а", "а'", "\u0301",
        "\u0301а", "а\u0301\u0301", "a\u0301", "q\u0301", "п‘я́ть", "ПʼЯ́ТЬ",
        "й\u0301", "ъ\u0301", "ч‘ч", "І\u0301", "Ё\u0301", "café", "а-a", "аб—в", "а\0б")
    for text in specials:
        compare(text, original, candidate, digest)
    class LyingAlpha(str):
        def isalpha(self):
            return True
    class FalseAlpha(str):
        def isalpha(self):
            return False
    class OddIteration(str):
        def casefold(self):
            return self
        def translate(self, table):
            return self
        def __iter__(self):
            return iter("а\u0301")
    class MutatingTranslate(str):
        def casefold(self):
            return self
        def translate(self, table):
            table[ord("’")] = "POISON"
            return str.translate(self, table)
    subclasses = (LyingAlpha("123"), FalseAlpha("абв"), OddIteration("abc"), MutatingTranslate("п’ять"))
    for text in subclasses:
        compare(text, original, candidate, digest)
    # A subclass must never poison the shared map used by later ordinary
    # text. The frozen implementation constructs an independent table.
    compare("п’ять", original, candidate, digest)
    return {"random_strings": count, "seed": 0xD04D1A1, "max_string_length": 140,
            "special_strings": len(specials), "custom_str_subclasses": len(subclasses),
            "ordinary_text_after_mutating_subclass_preserved": True,
            "ordered_result_sha256": digest.hexdigest()}


def validate_actual_data(module, path):
    path = Path(path)
    if path.is_symlink() or path.stat().st_size != 18661227:
        raise ValueError("Exact unchanged authenticated native data required")
    with path.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != DATA_SHA:
            raise ValueError("Native source dataset identity differs")
    started = time.perf_counter()
    with module.MembershipLexicon(path, DATA_SHA) as reader:
        result = reader.validate_all()
        if result["validated_words"] != 6642550 or result["validated_blocks"] != 25948:
            raise ValueError("All actual native words/blocks were not validated")
    if not reader.statistics()["closed"] or reader.statistics()["cached_blocks"]:
        raise ValueError("Full audit did not release actual resource")
    return {**result, "seconds": time.perf_counter()-started,
            "reader_closed": True, "scope": "Full unchanged semantic reader validation; not inference or cold-start latency"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=ROOT/"experiments/native-word-cache/native_word_membership.py")
    parser.add_argument("--candidate", type=Path, default=ROOT/"experiments/native-word-unicode-fast/native_word_membership.py")
    parser.add_argument("--candidate-git-blob", required=True)
    parser.add_argument("--lexicon", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.output.exists() or args.output.is_symlink():
        raise FileExistsError("Fresh Unicode audit result required")
    original_raw = source(args.baseline, BASELINE_BLOB)
    candidate_raw = source(args.candidate, args.candidate_git_blob)
    unchanged_reader_class(original_raw, candidate_raw)
    original = load("unicode_frozen_original", args.baseline)
    candidate = load("unicode_fast_candidate", args.candidate)
    started = time.perf_counter()
    report = {"format": "dordiai-exhaustive-unicode-word-fastpath-audit", "format_version": 1,
        "status": "running", "baseline_git_blob": BASELINE_BLOB,
        "candidate_git_blob": args.candidate_git_blob, "python": sys.version,
        "unicode_database_version": unicodedata.unidata_version,
        "all_other_module_ast_identical": True, "reader_class_and_all_block_validations_unchanged": True,
        "nvda_verified": False, "production_integrated": False, "pronunciation_verified": False,
        "physical_audio_verified": False, "product_ready": False,
        "scope": "Finite exhaustive codepoint/context and deterministic string comparison; not a proof over infinitely many strings, native pronunciation or speed"}
    try:
        report["exhaustive"] = exhaustive(original, candidate, progress=True)
        report["random_and_special"] = random_and_special(original, candidate)
        if args.lexicon is not None:
            report["actual_source_semantic_scan"] = validate_actual_data(candidate, args.lexicon)
        report.update(status="passed-full-unicode-and-deterministic-string-equivalence",
                      seconds=time.perf_counter()-started)
    except Exception as error:
        report.update(status="failed", error_type=type(error).__name__, error=str(error),
                      seconds=time.perf_counter()-started)
        raise
    finally:
        with args.output.open("x", encoding="utf-8") as output:
            json.dump(report, output, indent=2)
            output.write("\n")
    print("UNICODE_FASTPATH_AUDIT "+json.dumps(report), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
