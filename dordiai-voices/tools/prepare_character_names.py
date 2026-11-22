#!/usr/bin/env python3
"""Acquire pinned primary character resources without inventing native letter names.

NVDA characterDescriptions are phonetic examples, not ordinary alphabet names.
CLDR exemplar sets define glyph repertoires, not their spoken names. Only actual
symbol-name records become preparation jobs; missing ordinary letter names stay
explicitly open. No English fallback is introduced for another language.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import re
import unicodedata
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
NVDA_REVISION = "c295c817dae5f44f9fe9f9f7e8ce1ed8cd6bb350"
CLDR_REVISION = "7d2b9cb11cec08f4d333ad73209deb3df0711c3b"
ALIASES_NVDA = {"nb": "nb_NO", "no": "nb_NO", "pt": "pt_PT", "zh": "zh_CN", "cmn": "zh_CN"}
ALIASES_CLDR = {"nb": "nb", "fil": "fil", "kab": "kab"}
ESCAPES = {"0": "\0", "t": "\t", "n": "\n", "r": "\r", "f": "\f", "v": "\v", "#": "#", "\\": "\\"}
MAX_SYMBOL_SEQUENCE = 16
DEFAULT_SYMBOL_BANK_BUDGET = 512
COMMON_EMOJI = frozenset("😀 😃 😄 😁 😆 😅 😂 🤣 🙂 🙃 😉 😊 😍 🥰 😎 🤔 😢 😭 😡 😠 😴 😷 👍 👎 👏 🙏 ❤ ❤️ 💔 ✅ ❌ ⚠ ⚠️ ℹ ℹ️ ☑ ☑️".split())


def fetch(url, destination):
    destination = Path(destination)
    missing = destination.with_name(destination.name + ".missing")
    if missing.is_file() and missing.read_text(encoding="utf-8") == url:
        return None
    if not destination.is_file():
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "dordiai-voices-character-data/1"}), timeout=30) as source:
                data = source.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise ValueError("Unexpectedly large character resource")
            temporary = destination.with_suffix(destination.suffix + ".part")
            temporary.write_bytes(data)
            temporary.replace(destination)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                missing.write_text(url, encoding="utf-8")
                return None
            raise
    data = destination.read_bytes()
    return {"bytes": data, "sha256": hashlib.sha256(data).hexdigest(), "url": url}


def phonetic_descriptions(text):
    output, duplicates = {}, []
    for line in text.lstrip("\ufeff").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) < 2 or not fields[0]:
            continue
        key = fields[0]
        names = [name.strip() for name in fields[1:] if name.strip() and name.strip() != key]
        if key in output:
            duplicates.append(key)
        if names:
            output[key] = names
    return output, duplicates


def nvda_symbols(text):
    """Parse only literal symbols, never complex regex replacements or inheritance."""
    output = {}
    active = False
    for line in text.lstrip("\ufeff").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        if line == "symbols:":
            active = True
            continue
        if line == "complexSymbols:":
            active = False
            continue
        if not active:
            continue
        fields = line.split("\t")
        if len(fields) < 2:
            continue
        key, name = fields[:2]
        if key.startswith("\\") and len(key) >= 2:
            key = ESCAPES.get(key[1], key[1]) + key[2:]
        if len(key) != 1 or not name or name == "-" or name == key:
            continue
        if unicodedata.category(key).startswith(("L", "N")):
            # A symbol dictionary is not a source of alphabet/digit names.
            continue
        output[key] = name
    return output


def is_symbol_key(key):
    """Accept source-listed symbols/emoji, never alphabet/digit name guesses.

    The sequence bound covers ordinary ZWJ families and subdivision flags.
    Format controls other than emoji joiners/tags and presentation selectors
    are excluded, even if a malformed upstream record supplies a label.
    """
    if not isinstance(key, str) or not 1 <= len(key) <= MAX_SYMBOL_SEQUENCE:
        return False
    if re.fullmatch(r"[0-9#*]\ufe0f?\u20e3", key):
        return True
    has_symbol = False
    for char in key:
        if unicodedata.category(char).startswith(("P", "S")):
            has_symbol = True
        elif char in {"\u200d", "\ufe0e", "\ufe0f"} or 0xE0020 <= ord(char) <= 0xE007F:
            continue
        else:
            return False
    return has_symbol and not key.startswith("\u200d") and not key.endswith("\u200d")


def cldr_symbols(document):
    output = {}
    values = document.get("annotations", {}).get("annotations", {})
    for key, entry in values.items():
        if not is_symbol_key(key):
            continue
        candidates = entry.get("tts", [])
        if isinstance(candidates, str):
            candidates = [candidates]
        if candidates and candidates[0] not in {key, "↑↑↑", "∅∅∅", "", "-"}:
            output[key] = candidates[0]
    return output


def symbol_bank_keys(mapping, origins, curated=(), budget=DEFAULT_SYMBOL_BANK_BUDGET):
    """Bound default precomputation, retaining full runtime name lookup.

    This per-language budget does not replace the bank builder's global index
    byte limit. Large installations must select a language subset or explicitly
    plan several separate compatible banks; omitted jobs remain pending.
    """
    curated = set(curated)
    def priority(key):
        if key in curated:
            return 0, key
        if key in COMMON_EMOJI:
            return 1, key
        if origins.get(key) == "nvda_symbols":
            return 2, key
        if len(key) == 1 and ord(key) <= 0x2FFF:
            return 3, key
        return 4, key
    return sorted(mapping, key=priority)[:max(0, int(budget))]


def disambiguate_bank_aliases(entries):
    """Keep glyph keys authoritative when names collide after bank hashing.

    Two source labels may differ only in capitalisation/spacing. Both glyph
    entries keep their own exact spoken text; a conflicting convenience name
    alias is reported and omitted rather than overwriting another recording.
    """
    def key(text):
        return unicodedata.normalize("NFC", text).strip().casefold()
    primary = {key(row["lookup_text"]): row for row in entries}
    claimed = dict(primary)
    conflicts = []
    for row in entries:
        accepted = []
        for alias in row["aliases"]:
            previous = claimed.get(key(alias))
            if previous is not None and previous["text"] != row["text"]:
                conflicts.append({"lookup_text": row["lookup_text"], "alias": alias,
                                  "conflicts_with_lookup": previous["lookup_text"],
                                  "reason": "Same casefolded/trimmed name key for different exact source labels; glyph keys retained"})
                continue
            claimed[key(alias)] = row
            accepted.append(alias)
        row["aliases"] = accepted
    return conflicts


def exemplar_units(pattern):
    """Parse the basic ICU exemplar syntax while preserving multi-codepoint units.

    This returns glyphs only. It intentionally never turns them into spoken names.
    Unsupported UnicodeSet operations are rejected, not guessed.
    """
    if not isinstance(pattern, str) or not pattern.startswith("[") or not pattern.endswith("]"):
        return []
    value = pattern[1:-1]
    if "[:" in value or "&&" in value:
        raise ValueError("Unsupported UnicodeSet exemplar operation")
    value = re.sub(r"\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})", lambda match: chr(int(match.group(1) or match.group(2), 16)), value)
    units, index = [], 0
    while index < len(value):
        char = value[index]
        if char.isspace():
            index += 1
            continue
        if char == "{" and "}" in value[index + 1:]:
            end = value.index("}", index + 1)
            units.append(value[index + 1:end])
            index = end + 1
            continue
        if char == "\\" and index + 1 < len(value):
            units.append(value[index + 1])
            index += 2
            continue
        if index + 2 < len(value) and value[index + 1] == "-" and ord(value[index + 2]) >= ord(char):
            high = value[index + 2]
            if ord(high) - ord(char) > 512:
                raise ValueError("Unexpectedly large exemplar range")
            units.extend(chr(code) for code in range(ord(char), ord(high) + 1))
            index += 3
            continue
        units.append(char)
        index += 1
    return list(dict.fromkeys(units))


def load_language(code, cache):
    locale_nvda = ALIASES_NVDA.get(code, code)
    locale_cldr = ALIASES_CLDR.get(code, code)
    paths = {
        "nvda_symbols": (f"https://raw.githubusercontent.com/nvaccess/nvda/{NVDA_REVISION}/source/locale/{locale_nvda}/symbols.dic", cache / "nvda" / NVDA_REVISION / locale_nvda / "symbols.dic", "GPL-2.0-or-later"),
        "nvda_descriptions": (f"https://raw.githubusercontent.com/nvaccess/nvda/{NVDA_REVISION}/source/locale/{locale_nvda}/characterDescriptions.dic", cache / "nvda" / NVDA_REVISION / locale_nvda / "characterDescriptions.dic", "GPL-2.0-or-later"),
        "cldr_annotations": (f"https://raw.githubusercontent.com/unicode-org/cldr-json/{CLDR_REVISION}/cldr-json/cldr-annotations-full/annotations/{locale_cldr}/annotations.json", cache / "cldr" / CLDR_REVISION / locale_cldr / "annotations.json", "Unicode-3.0"),
        "cldr_characters": (f"https://raw.githubusercontent.com/unicode-org/cldr-json/{CLDR_REVISION}/cldr-json/cldr-misc-full/main/{locale_cldr}/characters.json", cache / "cldr" / CLDR_REVISION / locale_cldr / "characters.json", "Unicode-3.0"),
    }
    sources, missing, raw = {}, [], {}
    for kind, (url, path, license_name) in paths.items():
        result = fetch(url, path)
        if result is None:
            missing.append(kind)
        else:
            sources[kind] = {"url": url, "sha256": result["sha256"], "license": license_name}
            raw[kind] = result["bytes"].decode("utf-8-sig")
    symbol_names, origins = {}, {}
    if "cldr_annotations" in raw:
        for key, value in cldr_symbols(json.loads(raw["cldr_annotations"])).items():
            symbol_names[key], origins[key] = value, "cldr_annotations"
    if "nvda_symbols" in raw:
        for key, value in nvda_symbols(raw["nvda_symbols"]).items():
            symbol_names[key], origins[key] = value, "nvda_symbols"
    phonetic, duplicate_descriptions = phonetic_descriptions(raw.get("nvda_descriptions", ""))
    repertoire = []
    if "cldr_characters" in raw:
        data = json.loads(raw["cldr_characters"])
        main = next(iter(data.get("main", {}).values()), {})
        repertoire = exemplar_units(main.get("characters", {}).get("exemplarCharacters", "[]"))
    entries = []
    for key, text in symbol_names.items():
        if len(text) > 160 or "<|" in text:
            continue
        entries.append({"kind": "letter", "language": code, "lookup_text": key,
                        "text": text, "semantic_kind": "spoken_name", "source_kind": "symbol_name",
                        "source_id": origins[key], "acoustic_validation": "pending"})
    return {
        "format": "dordiai-character-name-sources", "format_version": 1, "language": code,
        "sources": sources, "missing_sources": missing,
        "letter_names": {}, "symbol_names": symbol_names,
        "phonetic_descriptions": phonetic, "duplicate_phonetic_keys": duplicate_descriptions,
        "exemplar_units": repertoire, "missing_ordinary_letter_names": repertoire,
        "bank_entries": entries,
        "semantics": {
            "symbol_names": "Upstream explicit native-locale symbol replacements, requiring acoustic/frontend validation",
            "phonetic_descriptions": "Spelling examples only; never promoted to ordinary alphabet names",
            "exemplar_units": "Glyph repertoire only; never assumed to be spoken names",
            "ordinary_letter_names_status": "not-established-by-these-sources",
            "runtime_enabled": False,
            "native_pronunciation_verified": False,
        },
    }


def prepare(codes, output, cache):
    output, cache = Path(output), Path(cache)
    output.mkdir(parents=True, exist_ok=True)
    report = {"format_version": 1, "nvda_revision": NVDA_REVISION, "cldr_revision": CLDR_REVISION,
              "scope": "Pinned-source character metadata, not generated or accepted audio banks", "languages": {}}
    with ThreadPoolExecutor(max_workers=6) as pool:
        jobs = {pool.submit(load_language, code, cache): code for code in codes}
        for future in as_completed(jobs):
            code = jobs[future]
            try:
                record = future.result()
            except Exception as error:
                report["languages"][code] = {"status": "source-fetch-or-parse-blocked", "error": str(error)}
                print(code, "blocked", str(error), flush=True)
                continue
            output.joinpath(code + ".json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            report["languages"][code] = {"status": "metadata-prepared", "symbol_names": len(record["symbol_names"]),
                                         "phonetic_descriptions": len(record["phonetic_descriptions"]),
                                         "ordinary_letter_names": 0, "exemplar_units": len(record["exemplar_units"]),
                                         "bank_entries_pending_acoustic_validation": len(record["bank_entries"]),
                                         "missing_sources": record["missing_sources"]}
            print(code, report["languages"][code], flush=True)
    from prepare_voice_banks import _core_letter_maps
    core_file = ROOT / "source/0.12.2/synthDrivers/kx47Preview.py"
    core = _core_letter_maps(core_file)
    english_file = output / "en.json"
    english = json.loads(english_file.read_text(encoding="utf-8"))["symbol_names"] if english_file.is_file() else {}
    overrides_path = Path(__file__).with_name("character_name_overrides.json")
    overrides = json.loads(overrides_path.read_text(encoding="utf-8")).get("languages", {}) if overrides_path.is_file() else {}
    report["blocked_english_identical_symbol_candidates"] = 0
    for code, summary in report["languages"].items():
        if summary["status"] != "metadata-prepared":
            continue
        path = output / (code + ".json")
        record = json.loads(path.read_text(encoding="utf-8"))
        candidates = {}
        if code != "en":
            for glyph, name in list(record["symbol_names"].items()):
                if name == english.get(glyph):
                    candidates[glyph] = {"name": name, "reason": "Identical to English reference; possible untranslated text or loanword requires local review"}
                    del record["symbol_names"][glyph]
        override = overrides.get(code, {})
        for glyph, name in override.get("symbol_names", {}).items():
            record["symbol_names"][glyph] = name
        if override:
            source_id = "curated_primary_alphabet_names" if override.get("letter_names") else "curated_primary_modifier_names"
            record["sources"][source_id] = override["source"]
            record["curated_modifier_names"] = list(override.get("symbol_names", {}))
        record["unreviewed_symbol_candidates"] = candidates
        report["blocked_english_identical_symbol_candidates"] += len(candidates)
        record["letter_names"] = {}
        for glyph, name in override.get("letter_names", {}).items():
            if not isinstance(glyph, str) or not glyph or not isinstance(name, str) or not name.strip():
                raise ValueError("Invalid curated ordinary letter name for " + code)
            record["letter_names"][glyph] = name
            # A documented grapheme such as Filipino ng also has title/upper
            # forms. These are case aliases of the same source name.
            for variant in (glyph.upper(), glyph.title()):
                record["letter_names"][variant] = name
        record["ordinary_alphabet_source_complete"] = override.get("ordinary_alphabet_complete") is True
        record["ordinary_alphabet_source_repertoire"] = list(override.get("letter_names", {}))
        if override.get("alternatives"):
            # Documented regional/lexical alternatives are provenance only.
            # One chosen native name remains the ordinary runtime spelling.
            record["ordinary_letter_name_alternatives"] = override["alternatives"]
        if override.get("exclusions"):
            record["curation_exclusions"] = override["exclusions"]
        if code in core:
            for glyph, name in core[code].items():
                record["letter_names"][glyph] = name
                if len(glyph.upper()) == 1:
                    record["letter_names"][glyph.upper()] = name
            record["sources"]["project_core_alphabet"] = {
                "path": str(core_file.relative_to(ROOT)),
                "sha256": hashlib.sha256(core_file.read_bytes()).hexdigest(),
                "license": "Existing project source terms", "meaning": "Existing three core alphabet name tables, not a new multilingual validation claim",
            }
        # Source completeness alone is not a native acoustic/frontend acceptance
        # result. Individual reviewed names can nevertheless be looked up and
        # rendered for tests/bank preparation without claiming the whole feature.
        record["letter_names_ready"] = code in core
        record["missing_ordinary_letter_names"] = [glyph for glyph in record["exemplar_units"]
                                                    if glyph not in record["letter_names"] and glyph not in record["symbol_names"]]
        origins = {entry["lookup_text"]: entry["source_id"] for entry in record["bank_entries"]}
        selected_symbols = symbol_bank_keys(record["symbol_names"], origins, override.get("symbol_names", {}))
        selected_symbol_names = {glyph: record["symbol_names"][glyph] for glyph in selected_symbols}
        record["symbol_bank_preparation"] = {
            "default_symbol_budget": DEFAULT_SYMBOL_BANK_BUDGET,
            "native_symbol_names_available": len(record["symbol_names"]),
            "symbol_jobs_scheduled": len(selected_symbols),
            "symbol_jobs_pending_budget": len(record["symbol_names"]) - len(selected_symbols),
            "pending_symbol_keys": sorted(set(record["symbol_names"]) - set(selected_symbols)),
            "scope": "Full native symbol_names remain available at runtime. This is a bounded preparation plan, not existing PCM. The voice bank builder must also enforce its global index byte limit across selected languages.",
        }
        record["bank_entries"] = []
        for kind, mapping in (("letter_name", record["letter_names"]), ("symbol_name", selected_symbol_names)):
            for glyph, text in mapping.items():
                if not text.strip() or len(text) > 160 or "<|" in text:
                    continue
                # Existing bank hashes trim lookup strings. Preserve literal
                # whitespace names through the reviewed spoken-name key instead.
                key = glyph if glyph.strip() else text
                aliases = [text] if text != key else []
                record["bank_entries"].append({"kind": "letter", "language": code, "lookup_text": key,
                                               "aliases": aliases, "text": text, "semantic_kind": "spoken_name",
                                               "source_kind": kind, "source_id": ("project_core_alphabet" if code in core else "curated_primary_alphabet_names") if kind == "letter_name" else source_id if glyph in override.get("symbol_names", {}) else origins.get(glyph, "native_symbol_source"),
                                               "acoustic_validation": "pending"})
        record["symbol_bank_preparation"]["conflicting_name_aliases_omitted"] = disambiguate_bank_aliases(record["bank_entries"])
        record["semantics"]["ordinary_letter_names_status"] = "existing-core-alphabet" if code in core else "source-complete-acoustic-acceptance-pending" if record["ordinary_alphabet_source_complete"] else "source-partial-acoustic-acceptance-pending" if record["letter_names"] else "not-established-by-these-sources"
        record["semantics"]["symbol_keys"] = "Pinned explicit CLDR/NVDA native names; supplementary symbols and bounded emoji sequences stay symbol_names, never ordinary alphabet names"
        record["semantics"]["bank_storage_kind"] = "The letters bank stores short navigation clips for both symbols and letters; source_kind distinguishes their linguistic semantics"
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        summary.update(symbol_names=len(record["symbol_names"]), ordinary_letter_names=len(record["letter_names"]),
                       letter_names_ready=record["letter_names_ready"],
                       english_identical_candidates_excluded=len(candidates),
                       symbol_jobs_pending_budget=record["symbol_bank_preparation"]["symbol_jobs_pending_budget"],
                       bank_entries_pending_acoustic_validation=len(record["bank_entries"]))
    licenses = {
        "NVDA-GPL.txt": f"https://raw.githubusercontent.com/nvaccess/nvda/{NVDA_REVISION}/copying.txt",
        "CLDR-Unicode-3.0.txt": f"https://raw.githubusercontent.com/unicode-org/cldr-json/{CLDR_REVISION}/LICENSE",
    }
    for name, url in licenses.items():
        result = fetch(url, cache / (NVDA_REVISION if name.startswith("NVDA") else CLDR_REVISION) / name)
        if result:
            output.joinpath(name).write_bytes(result["bytes"])
    output.joinpath("SOURCE-NOTICE.txt").write_text(
        "Character symbol replacements and phonetic examples derive from pinned official NVDA locale data (GPL-2.0-or-later), copyright NVDA Contributors.\n"
        "Additional explicit symbol annotations and exemplar glyph sets derive from pinned Unicode CLDR JSON (Unicode-3.0), copyright Unicode, Inc.\n"
        "Curated ordinary alphabet names and Santali modifier names are factual transcriptions attributed in each language manifest; original books/PDFs/fonts are not redistributed.\n"
        "Each language JSON retains source URLs, SHA-256 and semantic type. No English fallback or inferred alphabet names.\n"
        "Ordinary alphabet names, acoustic correctness and model frontend support require separate validation.\n", encoding="utf-8")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--languages", help="Comma-separated exact languages; default new model languages, source-curated alphabets and three existing core languages")
    parser.add_argument("--output", type=Path, default=ROOT / "source/0.12.2/kx47Runtime/models/CharacterNames")
    parser.add_argument("--cache", type=Path, default=ROOT.parent.parent / "character-source-cache")
    parser.add_argument("--evidence", type=Path, default=ROOT / "evidence/character_name_sources.json")
    args = parser.parse_args(argv)
    if args.languages:
        codes = sorted(set(args.languages.split(",")))
    else:
        registry = json.loads((ROOT / "source/0.12.2/kx47Runtime/wide_voice_index.json").read_text(encoding="utf-8"))
        codes = sorted({"uk", "en", "ru"} | {code for code, value in registry.items() if value.get("backend") in {"mms-onnx", "extra-onnx", "omni-onnx"}})
        # Source-backed tables for existing European/American engines are useful
        # too. Adding metadata never registers a model or marks its audio ready.
        curated = json.loads(Path(__file__).with_name("character_name_overrides.json").read_text(encoding="utf-8"))
        existing = {path.stem for path in args.output.glob("*.json") if re.fullmatch(r"[a-z][a-z0-9]{1,11}", path.stem)}
        codes = sorted(set(codes) | set(curated.get("languages", {})) | existing)
    # The English reference is used only to flag untranslated candidate labels.
    # It does not enable a language or provide a fallback for another locale.
    codes = sorted(set(codes) | {"en"})
    result = prepare(codes, args.output, args.cache)
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
