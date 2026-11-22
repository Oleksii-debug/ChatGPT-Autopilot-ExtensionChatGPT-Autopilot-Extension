"""Inspect immutable character bank coverage in an actual core ZIP without models.

This audits names and byte bounds only. It neither synthesizes audio nor proves
a real NVDA request/identity or audible latency. Runtime managed replacements
are intentionally outside this immutable-core report.
"""
import argparse
import ast
from hashlib import sha256
import json
from pathlib import Path
import re
import unicodedata
import zipfile

PREFIX = "kx47Runtime/models/voices/"
DRIVER = "synthDrivers/kx47Preview.py"
EXCLUDED = frozenset({"kostia", "inna", "dina", "vira", "innesa",
                      "veronika_classmate", "anatolii", "veronika"})
INDEX_LIMIT = 2 * 1024 * 1024
MAX_CLIP_BYTES = 24000 * 2 * 8


def digest(language, text, *, canonical=True):
    language = language.lower().replace("_", "-")
    language = "en-us" if canonical and language == "en" else language
    value = unicodedata.normalize("NFC", text).strip().casefold()
    return sha256((language + "\0" + value).encode("utf-8")).hexdigest()[:24]


def read_small(archive, names, name, maximum):
    entry = names.get(name)
    if entry is None:
        return None
    if entry.file_size > maximum:
        raise ValueError("Oversized audit metadata: " + name)
    return archive.read(entry)


def letters(source, variable):
    for statement in ast.parse(source).body:
        if not isinstance(statement, ast.Assign) or not any(
                isinstance(target, ast.Name) and target.id == variable for target in statement.targets):
            continue
        outer = statement.value
        if (not isinstance(outer, ast.Call) or not isinstance(outer.func, ast.Name)
                or outer.func.id != "dict" or len(outer.args) != 1 or outer.keywords):
            break
        inner = outer.args[0]
        if (not isinstance(inner, ast.Call) or not isinstance(inner.func, ast.Name)
                or inner.func.id != "zip" or len(inner.args) != 2 or inner.keywords):
            break
        glyphs, spoken = map(ast.literal_eval, inner.args)
        if (not isinstance(glyphs, str) or not isinstance(spoken, (list, tuple))
                or len(glyphs) != len(spoken) or len(set(glyphs)) != len(glyphs)
                or any(not isinstance(name, str) or not name.strip() for name in spoken)):
            break
        return dict(zip(glyphs, spoken))
    raise ValueError("Unsupported actual driver alphabet declaration: " + variable)


def valid_entry(index, key, audio_size):
    entry = index.get(key)
    return (isinstance(entry, list) and len(entry) == 2
            and type(entry[0]) is int and type(entry[1]) is int
            and entry[0] >= 0 and entry[0] % 2 == 0
            and 2 <= entry[1] <= MAX_CLIP_BYTES and entry[1] % 2 == 0
            and entry[0] + entry[1] <= audio_size)


def inspect(core, profiles):
    with zipfile.ZipFile(core) as archive:
        names = {}
        for entry in archive.infolist():
            if entry.filename in names:
                raise ValueError("Duplicate ZIP member: " + entry.filename)
            names[entry.filename] = entry
        source = read_small(archive, names, DRIVER, 1024 * 1024)
        if source is None:
            raise ValueError("Actual core driver is absent")
        source = source.decode("utf-8-sig")
        alphabet = {code: letters(source, variable) for code, variable in (
            ("uk", "UK_LETTERS"), ("ru", "RU_LETTERS"), ("en-us", "EN_LETTERS"))}
        catalogue = json.loads(read_small(archive, names, PREFIX + "catalog.json", INDEX_LIMIT))
        if not isinstance(catalogue, dict):
            raise ValueError("Invalid actual core voice catalogue")
        selected = list(catalogue) if profiles == ["all"] else profiles
        reports = []
        for profile in selected:
            if (not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", profile)
                    or profile in EXCLUDED or profile not in catalogue):
                raise ValueError("Unavailable/excluded core profile: " + profile)
            index_name = PREFIX + "native_letters/" + profile + ".json"
            pcm_name = PREFIX + "native_letters/" + profile + ".pcm"
            raw = read_small(archive, names, index_name, INDEX_LIMIT)
            index = json.loads(raw) if raw is not None else {}
            if not isinstance(index, dict):
                raise ValueError("Invalid bank index for " + profile)
            if "entries" in index:
                if (index.get("format") != "dordiai-voice-bank" or index.get("format_version") != 1
                        or index.get("voice_id") != profile or index.get("kind") != "letters"
                        or index.get("sample_rate") != 24000 or index.get("channels") != 1
                        or index.get("sample_width") != 2 or index.get("complete") is not True):
                    raise ValueError("Bank identity/format differs: " + profile)
                index = index["entries"]
            if not isinstance(index, dict):
                raise ValueError("Invalid entries for " + profile)
            audio_size = names[pcm_name].file_size if pcm_name in names else 0
            rows = []
            language_summary = {}
            for language, mapping in alphabet.items():
                counts = {"letters": 0, "native_spoken_name": 0, "native_glyph_only": 0,
                          "navigation_spoken_name": 0, "no_default_prepared_candidate": 0}
                for glyph, spoken in mapping.items():
                    named = digest(language, spoken)
                    raw_glyph = digest(language, glyph)
                    native = valid_entry(index, named, audio_size)
                    glyph_hit = valid_entry(index, raw_glyph, audio_size)
                    nav_path = PREFIX + "navigation/" + profile + "/" + named + ".wav"
                    nav = nav_path in names
                    special = PREFIX + "core_spelling_2x/" + profile + "/" + named + ".wav"
                    counts["letters"] += 1
                    counts["native_spoken_name"] += native
                    counts["native_glyph_only"] += glyph_hit and not native
                    counts["navigation_spoken_name"] += nav
                    counts["no_default_prepared_candidate"] += not native and not nav
                    aliases = {code: valid_entry(index, digest(code, spoken, canonical=False), audio_size)
                               for code in (("en", "en-us", "en-gb") if language == "en-us" else
                                            ("uk", "uk-ua") if language == "uk" else ("ru", "ru-ru"))}
                    rows.append({"language": language, "glyph": glyph, "spoken_name": spoken,
                                 "spoken_key": named, "glyph_key": raw_glyph,
                                 "native_spoken_name_valid_bounds": native,
                                 "native_glyph_valid_bounds": glyph_hit,
                                 "native_language_alias_hits": aliases,
                                 "navigation_named_wav_present": nav,
                                 "special_2x_named_wav_present": special in names,
                                 "metadata_candidate": "native-bank" if native else "navigation-wav" if nav else "live-worker"})
                language_summary[language] = counts
            reports.append({"profile": profile, "label": catalogue[profile],
                            "native_index_present": raw is not None,
                            "native_index_sha256": sha256(raw).hexdigest() if raw is not None else None,
                            "native_index_entries": len(index), "native_audio_bytes": audio_size,
                            "summary": language_summary, "letters": rows})
        return {"format": "dordiai-character-bank-coverage-audit", "format_version": 1,
                "scope": "Immutable core ZIP metadata only; no models/NVDA/audio executed",
                "driver_sha256": sha256(source.encode("utf-8")).hexdigest(),
                "request_assumption": "Default core character mapping, actual ZIP driver AST; live per-language voice/rate/preferences not measured",
                "managed_voice_versions_verified": False, "wav_headers_or_pcm_quality_verified": False,
                "physical_or_nvda_latency_verified": False, "profiles": reports}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", required=True, type=Path)
    parser.add_argument("--profiles", default="sara,sara_archive", help="Comma separated allowed IDs or all")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = inspect(args.core, args.profiles.split(","))
    if args.output.exists():
        raise ValueError("Refusing to overwrite audit output")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"format": result["format"], "profiles": [
        {"profile": row["profile"], "summary": row["summary"]} for row in result["profiles"]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
