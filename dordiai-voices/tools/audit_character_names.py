#!/usr/bin/env python3
"""Audit exact selected-language name coverage without claiming audio acceptance.

The staged resource inventory is an attributed input, not a fresh installation
check. Ordinary alphabet tables, spelling examples and audio readiness remain
separate, including for languages shared between continents.
"""
from __future__ import annotations
import argparse
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import re
from string import ascii_lowercase
from unicodedata import normalize

ROOT = Path(__file__).resolve().parents[1]


def _literal_table(node):
    """Read legacy literal tables without executing a runtime module."""
    if isinstance(node, ast.Dict):
        return {_literal_table(key): _literal_table(value) for key, value in zip(node.keys, node.values)}
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
        arguments = [_literal_table(value) for value in node.args]
        if node.func.id == "zip" and len(arguments) == 2:
            if len(arguments[0]) != len(arguments[1]):
                raise ValueError("Legacy alphabet/source name count differs")
            return list(zip(*arguments))
        if node.func.id == "dict" and len(arguments) == 1:
            return dict(arguments[0])
    return ast.literal_eval(node)


def legacy_tables(runtime):
    path = Path(runtime) / "experiment_letters.py"
    raw = path.read_bytes()
    assignments = {node.targets[0].id: node.value for node in ast.parse(raw).body
                   if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)}
    base, extras = (_literal_table(assignments[key]) for key in ("NAMES", "EXTRAS"))
    mappings = {}
    for code, values in base.items():
        words = values.split()
        if len(words) != 26:
            raise ValueError("Legacy native alphabet must have 26 base names")
        mappings[code] = dict(zip(ascii_lowercase, (word.replace("-", " ") for word in words))) | extras[code]
    return mappings, {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest(),
                      "semantics": "Existing project ordinary spelling names, not NVDA phonetic examples; independent native/source validation not established by this audit"}


def baseline_bank_coverage(folder, mappings, runtime):
    """Check allowed profiles' exact legacy-name hash keys and PCM byte ranges."""
    policy_path = Path(runtime) / "voice_policy.py"
    spec = importlib.util.spec_from_file_location("_character_audit_voice_policy", policy_path)
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    result = {code: {"allowed_profiles_with_any_name": 0, "allowed_profiles_with_all_names": 0,
                     "valid_name_key_ranges": 0, "scope": "Legacy name keys + bounded nonempty PCM byte ranges; not listening/quality or all voices validated"}
              for code in mappings}
    for index_path in Path(folder).glob("*.json"):
        if not policy.is_voice_allowed(index_path.stem):
            continue
        audio = index_path.with_suffix(".pcm")
        if not audio.is_file():
            continue
        index = json.loads(index_path.read_text(encoding="utf-8"))
        length = audio.stat().st_size
        for code, table in mappings.items():
            found = 0
            for name in table.values():
                key = hashlib.sha256((code + "\0" + normalize("NFC", name).strip().casefold()).encode("utf-8")).hexdigest()[:24]
                pair = index.get(key)
                if (isinstance(pair, list) and len(pair) == 2 and all(type(value) is int for value in pair)
                        and pair[0] >= 0 and pair[0] % 2 == 0 and 2 <= pair[1] <= 48000 * 8
                        and pair[1] % 2 == 0 and pair[0] + pair[1] <= length):
                    found += 1
            row = result[code]
            row["allowed_profiles_with_any_name"] += found > 0
            row["allowed_profiles_with_all_names"] += found == len(table)
            row["valid_name_key_ranges"] += found
    return result


def audit(inventory, resources, runtime=None, legacy_banks=None):
    inventory, resources = Path(inventory), Path(resources)
    raw = inventory.read_bytes()
    document = json.loads(raw)
    rows = document.get("languages")
    if not isinstance(rows, list):
        raise ValueError("Expected selected-language resource inventory")
    legacy, legacy_source = legacy_tables(runtime) if runtime is not None else ({}, {})
    banks = baseline_bank_coverage(legacy_banks, legacy, runtime) if legacy_banks is not None and runtime is not None else {}
    registry, spelling_source = {}, {}
    engine_spelling_call = False
    if runtime is not None:
        registry = json.loads((Path(runtime) / "wide_voice_index.json").read_text(encoding="utf-8"))
        carrier_path = Path(runtime) / "wide_carrier.py"
        carrier_raw = carrier_path.read_bytes()
        engine_spelling_call = any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                                   and node.func.attr == "espeak_Char" for node in ast.walk(ast.parse(carrier_raw)))
        spelling_source = {"path": str(carrier_path), "sha256": hashlib.sha256(carrier_raw).hexdigest(),
                           "mechanism": "lib.espeak_Char", "call_present": engine_spelling_call,
                           "conditions": "character=True, one BMP code point, available registered eSpeak voice, and no prior special-language rewriting; not arbitrary grapheme clusters/non-BMP characters",
                           "semantics": "An engine-native spelling route candidate is not a transcribed ordinary-name table or proof of correct native pronunciation"}
    result = {"format": "dordiai-ordinary-alphabet-coverage", "format_version": 3,
              "inventory_source": str(inventory), "inventory_sha256": hashlib.sha256(raw).hexdigest(),
              "scope": "Identified explicit name-mapping tables, engine-native spelling route candidates and acoustic acceptance are separate. Absence of an explicit table does NOT mean runtime spelling unsupported. Resource presence is inherited from the named inventory; an API call never proves name semantics or correct native audio.",
              "legacy_project_source": legacy_source,
              "engine_spelling_source": spelling_source,
              "languages": [], "regions": {}, "summary": {}}
    selected_ids = set()
    for item in rows:
        code = item.get("runtime_code") or item["id"]
        if not isinstance(code, str) or not re.fullmatch(r"[a-z][a-z0-9]{1,11}", code):
            raise ValueError("Invalid exact language code in inventory")
        if item["id"] in selected_ids:
            raise ValueError("Duplicate selected language in inventory")
        selected_ids.add(item["id"])
        path = resources / (code + ".json")
        names = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
        if names and (names.get("language") != code or names.get("format") != "dordiai-character-name-sources"):
            raise ValueError("Character-name language mismatch: " + code)
        ordinary = names.get("letter_names", {})
        repertoire = names.get("ordinary_alphabet_source_repertoire", [])
        existing_core = names.get("semantics", {}).get("ordinary_letter_names_status") == "existing-core-alphabet"
        count = len(repertoire) if repertoire else len({glyph.lower() for glyph in ordinary})
        complete = names.get("ordinary_alphabet_source_complete") is True or existing_core
        project_names = legacy.get(code, {})
        known_glyphs = {glyph.lower() for glyph in ordinary} | set(project_names)
        info = registry.get(code)
        # The shared acoustic model is used for continuous text only; explicit
        # character requests still take the eSpeak branch when no dedicated
        # pronunciation backend overrides it. This is a static candidate check.
        spelling_candidate = bool(engine_spelling_call and item.get("resources_present") is True
                                  and isinstance(info, dict) and info.get("backend") is None
                                  and isinstance(info.get("voice"), str)
                                  and item.get("backend") in {"espeak+voice-conversion", "shared-neural+voice-conversion"})
        row = {"id": item["id"], "runtime_code": code, "name_uk": item["name_uk"],
               "regions": item.get("regions", []),
               "resources_present_in_inventory": item.get("resources_present") is True,
               "ordinary_names": count, "ordinary_alphabet_source_complete": complete,
               "legacy_project_ordinary_names": len(project_names),
               "known_ordinary_name_mapping_present": bool(known_glyphs),
               "known_ordinary_mapped_graphemes": len(known_glyphs),
               "engine_native_spelling_candidate": spelling_candidate,
               "engine_native_spelling_mechanism": "espeak_Char" if spelling_candidate else None,
               "engine_native_name_semantics_verified_by_this_audit": False,
               "legacy_project_samples": {glyph: project_names[glyph] for glyph in ("b", "j", "w") if glyph in project_names},
               "legacy_prepared_bank_presence": banks.get(code),
               "ordinary_name_scope": "existing-project-core-table" if existing_core else "primary-source-table" if ordinary else "no-curated-explicit-table",
               "ordinary_name_sources": [value for key, value in names.get("sources", {}).items()
                                         if key in {"project_core_alphabet", "curated_primary_alphabet_names"}],
               "phonetic_description_count": len(names.get("phonetic_descriptions", {})),
               "symbol_name_count": len(names.get("symbol_names", {})),
               "full_native_pronunciation_accepted": False, "nvda_typing_accepted_by_this_audit": False,
               "metadata_sha256": hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None,
               "open_source_rows": names.get("curation_exclusions", {})}
        result["languages"].append(row)
        for region in row["regions"]:
            summary = result["regions"].setdefault(region, {"selected": 0, "source_complete": 0, "source_partial": 0, "missing_curated_ordinary_source_tables": 0, "identified_explicit_mapping_tables": 0, "no_identified_explicit_mapping_table": 0, "engine_spelling_candidates_with_resources": 0})
            summary["selected"] += 1
            summary["source_complete" if complete else "source_partial" if ordinary else "missing_curated_ordinary_source_tables"] += 1
            summary["identified_explicit_mapping_tables" if known_glyphs else "no_identified_explicit_mapping_table"] += 1
            summary["engine_spelling_candidates_with_resources"] += spelling_candidate
    result["summary"] = {"selected": len(result["languages"]),
                         "resources_present_in_inventory": sum(row["resources_present_in_inventory"] for row in result["languages"]),
                         "source_complete": sum(row["ordinary_alphabet_source_complete"] for row in result["languages"]),
                         "source_partial": sum(bool(row["ordinary_names"]) and not row["ordinary_alphabet_source_complete"] for row in result["languages"]),
                         "missing_curated_ordinary_source_tables": sum(not row["ordinary_names"] for row in result["languages"]),
                         "legacy_project_mapping_languages": sum(bool(row["legacy_project_ordinary_names"]) for row in result["languages"]),
                         "identified_explicit_mapping_tables": sum(row["known_ordinary_name_mapping_present"] for row in result["languages"]),
                         "no_identified_explicit_mapping_table": sum(not row["known_ordinary_name_mapping_present"] for row in result["languages"]),
                         "engine_spelling_candidates_with_resources": sum(row["engine_native_spelling_candidate"] for row in result["languages"]),
                         "no_explicit_table_but_engine_spelling_candidate": sum(not row["known_ordinary_name_mapping_present"] and row["engine_native_spelling_candidate"] for row in result["languages"])}
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, default=ROOT / "evidence/language_coverage_dev2.json")
    parser.add_argument("--resources", type=Path, default=ROOT / "source/0.12.2/kx47Runtime/models/CharacterNames")
    parser.add_argument("--output", type=Path, default=ROOT / "evidence/ordinary_alphabet_coverage.json")
    parser.add_argument("--runtime", type=Path, default=ROOT / "source/0.12.2/kx47Runtime")
    parser.add_argument("--legacy-banks", type=Path, default=ROOT / "packages/0.12.2/kx47Runtime/models/voices/native_letters")
    args = parser.parse_args(argv)
    result = audit(args.inventory, args.resources, args.runtime, args.legacy_banks)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result["summary"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
