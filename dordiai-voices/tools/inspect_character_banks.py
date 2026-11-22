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


def digest(language, text, *, canonical=True, nfc=True):
    language = language.lower().replace("_", "-")
    language = "en-us" if canonical and language == "en" else language
    value = (unicodedata.normalize("NFC", text) if nfc else text).strip().casefold()
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


def inspect_letters(core, profiles):
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
            # Immutable core is builtin: NativeLetterBank managed=False leaves wrapper dictionaries unexpanded.
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



# Exact AST anchors: reject a different driver rather than guessing its policy.
SEMANTIC_REFERENCE = {"core_character_units":"def core_character_units(text, language):\n    \"\"\"Keep reviewed symbol/emoji sequences intact and use native names.\"\"\"\n    text = normalize(\"NFC\", text)\n    symbols = None\n    position = 0\n    while position < len(text):\n        char = text[position]\n        keycap = char.isdecimal() and position + 1 < len(text) and text[position + 1] in \"\\ufe0f\\u20e3\"\n        if char.isalpha() or char.isspace() or char.isdecimal() and not keycap:\n            yield char, None\n            position += 1\n            continue\n        if symbols is None:\n            try:\n                symbols = _runtime_module(\"character_names\").data(language).get(\"symbol_names\", {})\n            except LookupError:\n                symbols = {}\n        for end in range(min(position + 32, len(text)), position, -1):\n            glyph = text[position:end]\n            name = symbols.get(glyph)\n            if isinstance(name, str) and name.strip() and name != glyph:\n                yield glyph, name\n                position = end\n                break\n        else:\n            yield char, None\n            position += 1\n","core_character_parts":"def core_character_parts(text, language, english, spelling_language=\"auto\"):\n    for char, symbol_name in core_character_units(text, language):\n        if symbol_name is not None:\n            yield \"character\", (language, symbol_name)\n            continue\n        lower = char.lower()\n        cyrillic = language if spelling_language == \"auto\" else spelling_language\n        if lower in RU_LETTERS and (lower not in UK_LETTERS or cyrillic == \"ru\"):\n            yield \"character\", (\"ru\", RU_LETTERS[lower])\n        elif lower in UK_LETTERS:\n            yield \"character\", (\"uk\", UK_LETTERS[lower])\n        elif (foreign := latin_letter_language(lower, language)) is not None:\n            yield \"character\", (foreign, lower if lower == \"ß\" else char.upper())\n        elif lower in EN_LETTERS:\n            name = \"zed\" if lower == \"z\" and language.lower() == \"en-gb\" else EN_LETTERS[lower]\n            yield \"character\", (language if language.startswith(\"en\") else english, name)\n        elif char.isspace():\n            yield \"character\", (language, {\"ru\": \"пробел\", \"uk\": \"пробіл\"}.get(language, \"space\"))\n        else:\n            yield \"text\", (language, char)\n","fast_clip":"def fast_clip(self, request):\n    \"\"\"Read prepared speech without waiting for any neural model or worker.\"\"\"\n    _voice_policy.require_voice_allowed(request[\"profile\"])\n    self._assert_resource_epoch()\n    managed=(self._references is not None and\n             _runtime_module(\"voice_assets\")._profile(self._references,request[\"profile\"]) is not None)\n    if self._references is not None and not request.get(\"segments\"):\n        language = (request.get(\"language\") or \"uk\").lower().replace(\"_\", \"-\")\n        if request.get(\"character\"):\n            # Managed banks and the existing core-language banks use the\n            # same selected identity. Check them before legacy WAV caches\n            # or worker startup, including keyboard echo in core languages.\n            names = dict.fromkeys((request.get(\"preparedLetterName\"), request[\"text\"],\n                                   request.get(\"letterCacheText\")))\n            for name in names:\n                if name is None:\n                    continue\n                pcm = self._letterBank.read(request[\"profile\"], language, name)\n                if pcm is None and language == \"en-gb\" and name != \"zed\":\n                    pcm = self._letterBank.read(request[\"profile\"], \"en-us\", name)\n                if pcm is not None:\n                    return self._checked_prepared_clip(request,pcm,native=True)\n        elif len(request[\"text\"]) <= 160:\n            pcm = self._commandBank.read(request[\"profile\"], language, request[\"text\"])\n            if pcm is not None:\n                return self._checked_prepared_clip(request,pcm,native=True)\n    if managed:\n        # Only verified package banks and this exact resource epoch's live\n        # synthesis cache belong to the replacement identity. Every legacy\n        # navigation/command/WAV cache below belongs to the older speaker.\n        return self._cached_clip(request)\n    if request.get(\"danishCommands\") and not request.get(\"character\") and not request.get(\"segments\"):\n        pcm = self._commandBank.read(request[\"profile\"], \"da\", request[\"text\"])\n        if pcm is not None:\n            return self._checked_prepared_clip(request,pcm,native=True)\n    if request.get(\"wideLocale\") and not request.get(\"segments\") and len(request[\"text\"])<=160:\n        code = _wide.registered(request[\"language\"])\n        if code and self._references is not None:\n            if code not in self._wideNavigation:\n                from synthDrivers._dordiai_letter_bank import NativeLetterBank\n                folder = self._references.parent / \"WideLanguages\" / \"navigation\"\n                self._wideNavigation[code] = NativeLetterBank(folder, code) if (folder / code).is_dir() else None\n            bank = self._wideNavigation[code]\n            if bank is not None:\n                kind = \"-char\" if request.get(\"character\") else \"-text\"\n                pcm = bank.read(request[\"profile\"], code + kind, normalize(\"NFC\",request[\"text\"]))\n                if pcm is not None:\n                    return self._checked_prepared_clip(request,pcm,native=True)\n    cached=self._cached_clip(request)\n    if cached is not None:return cached\n    if request.get(\"wideLocale\"):\n        return None\n    if request.get(\"nativeLocale\") and request[\"profile\"] != CLASSMATE_PROFILE and not request.get(\"character\"):\n        # Older immutable clips of these phrases use Ukrainian acoustic approximations.\n        return None\n    if self._references is None or request.get(\"segments\"):\n        return None\n    language = (request.get(\"language\") or (\"en-us\" if re.search(r\"[A-Za-z]\", request[\"text\"]) else \"uk\")).lower().replace(\"_\", \"-\")\n    language = \"en-us\" if language == \"en\" else language\n    spelling = request.get(\"character\") and language in {\"uk\", \"en-us\", \"en-gb\", \"ru\"}\n    if spelling and language == \"en-gb\" and request[\"text\"] != \"zed\":\n        language = \"en-us\"\n    native = request.get(\"nativeEnglish\", False) and not request[\"text\"].isdecimal()\n    if any(char.isdecimal() for char in request[\"text\"]) and (\n            language != \"uk\" or request.get(\"numberLanguage\", \"auto\") != \"auto\"):\n        return None\n    if spelling:\n        cache = \"navigation\"\n    elif request.get(\"nativeProfile\") and not request[\"text\"].isdecimal():\n        cache = \"navigation_profile\"\n        if language == \"en-gb\":\n            language = \"en-us\"\n    else:\n        cache = \"navigation_native\" if native else \"navigation\"\n    clip_text = request.get(\"letterCacheText\", request[\"text\"])\n    core_at_cap = False\n    if (spelling and language == \"uk\" and request[\"speed\"] == 2.0 and clip_text in {\"є\", \"ес\", \"ї\"}):\n        digest = sha256((\"uk\\0\" + clip_text.strip().casefold()).encode(\"utf8\")).hexdigest()[:24] + \".wav\"\n        if (self._references / \"core_spelling_2x\" / request[\"profile\"] / digest).is_file():\n            cache = \"core_spelling_2x\"\n            core_at_cap = True\n    native_letter = bool(request.get(\"character\") and (request.get(\"nativeLocale\") or request.get(\"preparedLetterName\"))\n                         and language in CLASSMATE_LOCALES)\n    key = (cache, request[\"profile\"], language, clip_text, native_letter)\n    if key not in self._navigation:\n        name = sha256((language + \"\\0\" + clip_text.strip().casefold()).encode(\"utf-8\")).hexdigest()[:24] + \".wav\"\n        path = self._references / cache / request[\"profile\"] / name\n        if path.is_file():\n            with wave.open(str(path), \"rb\") as source:\n                if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, SAMPLE_RATE):\n                    raise ValueError(\"Invalid prepared speech format\")\n                pcm = source.readframes(source.getnframes())\n        elif native_letter:\n            pcm = self._letterBank.read(request[\"profile\"], language, request.get(\"preparedLetterName\", request[\"text\"]))\n            if pcm is None:\n                return None\n        else:\n            return None\n        self._navigation[key] = pcm\n        if len(self._navigation) > 256:\n            self._navigation.popitem(last=False)\n    pcm = self._navigation[key]\n    self._navigation.move_to_end(key)\n    if core_at_cap:\n        request = dict(request, speed=1.0)\n    return self._checked_prepared_clip(request,pcm,native_letter or core_at_cap)\n"}
PROBE_EXTRA = "0123456789 .,;:!?+-=()[]{}@#"


def semantics(source):
    tree = ast.parse(source)
    anchors = {}
    space_names = None
    for name, reference in SEMANTIC_REFERENCE.items():
        nodes = tree.body
        if name == "fast_clip":
            owner = next((n for n in nodes if isinstance(n, ast.ClassDef) and n.name == "SpeechWorker"), None)
            nodes = owner.body if owner is not None else []
        actual = next((n for n in nodes if isinstance(n, ast.FunctionDef) and n.name == name), None)
        if actual is None or ast.dump(actual, include_attributes=False) != ast.dump(ast.parse(reference).body[0], include_attributes=False):
            raise ValueError("Unsupported driver semantic anchor: " + name)
        anchors[name] = sha256(ast.dump(actual, include_attributes=False).encode()).hexdigest()
        if name == "core_character_parts":
            for call in ast.walk(actual):
                if (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                        and call.func.attr == "get" and isinstance(call.func.value, ast.Dict) and len(call.args) == 2):
                    mapping = ast.literal_eval(call.func.value)
                    if set(mapping) == {"uk", "ru"}:
                        space_names = mapping, ast.literal_eval(call.args[1])
    if space_names is None:
        raise ValueError("Actual whitespace-name map not found")
    return anchors, space_names


def actual_probe_extra(path, alphabet):
    if path is None:
        return PROBE_EXTRA, {"verified": False, "kind": "fixed-existing-176-probe"}
    raw = Path(path).read_bytes()
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError("Oversized probe source")
    tree = ast.parse(raw.decode("utf-8"))
    trees = [tree] + [ast.parse(n.value) for n in ast.walk(tree)
                     if isinstance(n, ast.Constant) and isinstance(n.value, str) and "def latency_worker(" in n.value]
    found = []
    for candidate in trees:
        for worker in ast.walk(candidate):
            if not isinstance(worker, ast.FunctionDef) or worker.name != "latency_worker":
                continue
            mappings, extras = [], []
            for node in ast.walk(worker):
                if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "alphabets" for t in node.targets):
                    mappings.append(ast.literal_eval(node.value))
                if (isinstance(node, ast.For) and isinstance(node.iter, ast.BinOp) and isinstance(node.iter.op, ast.Add)
                        and isinstance(node.iter.left, ast.Subscript) and isinstance(node.iter.left.value, ast.Name)
                        and node.iter.left.value.id == "alphabets" and isinstance(node.iter.right, ast.Constant)
                        and isinstance(node.iter.right.value, str)):
                    extras.append(node.iter.right.value)
            if len(mappings) == len(extras) == 1:
                found.append((mappings[0], extras[0]))
    expected = {"en" if code == "en-us" else code: "".join(mapping) for code, mapping in alphabet.items()}
    if len(found) != 1 or found[0][0] != expected:
        raise ValueError("Actual probe alphabets do not uniquely match actual driver")
    return found[0][1], {"verified": True, "kind": "actual-probe-AST", "sha256": sha256(raw).hexdigest()}


def bank_index(archive, names, profile, kind):
    base = PREFIX + "native_" + kind + "/" + profile
    raw = read_small(archive, names, base + ".json", INDEX_LIMIT)
    index = json.loads(raw) if raw is not None else {}
    if not isinstance(index, dict):
        raise ValueError("Invalid bank index")
    # Immutable core is builtin: NativeLetterBank managed=False leaves wrapper dictionaries unexpanded.
    if not isinstance(index, dict):
        raise ValueError("Invalid bank entries")
    return index, names[base + ".pcm"].file_size if base + ".pcm" in names else 0


def mapped_probe_unit(glyph, language, alphabet, symbols, spaces):
    category = "letter" if glyph.isalpha() else "digit" if glyph.isdecimal() else "space" if glyph.isspace() else "symbol"
    if category == "symbol":
        value = symbols.get(glyph)
        if isinstance(value, str) and value.strip() and value != glyph:
            return "character", value, category, "actual-CharacterNames-symbol-label"
    lower = glyph.lower()
    if lower in alphabet["ru"] and (lower not in alphabet["uk"] or language == "ru"):
        return "character", alphabet["ru"][lower], category, "actual-RU_LETTERS"
    if lower in alphabet["uk"]:
        return "character", alphabet["uk"][lower], category, "actual-UK_LETTERS"
    if lower in alphabet["en-us"]:
        return "character", alphabet["en-us"][lower], category, "actual-EN_LETTERS"
    if glyph.isspace():
        return "character", spaces[0].get(language, spaces[1]), category, "actual-whitespace-map"
    return "text", glyph, category, "actual-literal-text-fallback"


def probe_coverage(profile, language, glyph, kind, text, category, origin, banks, names,
                   *, native_profiles=True, native_english=True, speed=1.0):
    letter_index, letter_size = banks["letters"]
    command_index, command_size = banks["commands"]
    key, nav_key = digest(language, text), digest(language, text, nfc=False)
    letter = valid_entry(letter_index, key, letter_size)
    command = valid_entry(command_index, key, command_size)
    character = kind == "character"
    effective_speed = min(speed, 2.0 if language in {"uk", "ru"} else 2.5) if character else speed
    english = bool(native_english and not native_profiles and not character and language.startswith("en-"))
    native_profile = bool(native_profiles and language in {"en-us", "ru"})
    presence = {folder: PREFIX + folder + "/" + profile + "/" + nav_key + ".wav" in names
                for folder in ("navigation", "navigation_profile", "navigation_native", "core_spelling_2x")}
    folder, bypass = None, None
    if character and letter:
        selected = "native_letters"
    elif not character and command:
        selected = "native_commands"
    else:
        if any(c.isdecimal() for c in text) and language != "uk":
            bypass = "legacy-number-language-rule"
        elif character:
            folder = "navigation"
            if language == "uk" and effective_speed == 2.0 and text in {"є", "ес", "ї"} and presence["core_spelling_2x"]:
                folder = "core_spelling_2x"
        elif native_profile and not text.isdecimal():
            folder = "navigation_profile"
        else:
            folder = "navigation_native" if english and not text.isdecimal() else "navigation"
        selected = folder if folder is not None and presence[folder] else "live-worker"
    return {"language": language, "glyph": glyph, "kind": kind, "category": category,
            "text": text, "mapping_origin": origin, "character": character,
            "bank_key": key, "navigation_key": nav_key,
            "native_letters_valid_bounds": letter, "native_commands_valid_bounds": command,
            "navigation_presence": presence, "effective_speed": effective_speed,
            "nativeProfile": native_profile, "nativeEnglish": english,
            "metadata_candidate": selected, "prepared_candidate": selected != "live-worker",
            "legacy_cache_bypass": bypass,
            "diagnostic_raw_glyph_navigation_present": PREFIX + "navigation/" + profile + "/" + digest(language, glyph, nfc=False) + ".wav" in names}


def inspect(core, profiles, *, probe_source=None, native_profiles=True, native_english=True, speed=1.0):
    if not 0 < speed <= 10:
        raise ValueError("Invalid probe speed")
    result = inspect_letters(core, profiles)
    with zipfile.ZipFile(core) as archive:
        names = {entry.filename: entry for entry in archive.infolist()}
        source = read_small(archive, names, DRIVER, 1024 * 1024).decode("utf-8-sig")
        anchors, spaces = semantics(source)
        alphabet = {code: letters(source, variable) for code, variable in (
            ("uk", "UK_LETTERS"), ("ru", "RU_LETTERS"), ("en-us", "EN_LETTERS"))}
        extra, definition = actual_probe_extra(probe_source, alphabet)
        symbols, documents = {}, {}
        for language in alphabet:
            code = language.split("-")[0]
            name = "kx47Runtime/models/CharacterNames/" + code + ".json"
            raw = read_small(archive, names, name, 4 * 1024 * 1024)
            document = json.loads(raw) if raw is not None else None
            if document is not None and (not isinstance(document, dict)
                    or document.get("format") != "dordiai-character-name-sources" or document.get("format_version") != 1
                    or document.get("language") != code or any(not isinstance(document.get(field, {}), dict)
                        for field in ("letter_names", "symbol_names", "phonetic_descriptions"))):
                raise ValueError("Invalid actual character-name document: " + name)
            symbols[language] = document.get("symbol_names", {}) if document is not None else {}
            documents[language] = {"path": name, "present": raw is not None,
                                   "sha256": sha256(raw).hexdigest() if raw is not None else None}
        aggregate = {"requests": 0, "prepared_candidates": 0, "live_worker_candidates": 0,
                     "letter": 0, "digit": 0, "space": 0, "symbol": 0, "number_policy_bypasses": 0}
        for report in result["profiles"]:
            profile = report["profile"]
            banks = {kind: bank_index(archive, names, profile, kind) for kind in ("letters", "commands")}
            rows, summary = [], {}
            for language, mapping in alphabet.items():
                counts = {key: 0 for key in aggregate}
                counts["known_unprepared"] = []
                for glyph in "".join(mapping) + extra:
                    kind, text, category, origin = mapped_probe_unit(glyph, language, alphabet, symbols[language], spaces)
                    row = probe_coverage(profile, language, glyph, kind, text, category, origin, banks, names,
                        native_profiles=native_profiles, native_english=native_english, speed=speed)
                    rows.append(row)
                    counts["requests"] += 1
                    counts[category] += 1
                    counts["prepared_candidates" if row["prepared_candidate"] else "live_worker_candidates"] += 1
                    counts["number_policy_bypasses"] += row["legacy_cache_bypass"] == "legacy-number-language-rule"
                    if not row["prepared_candidate"]:
                        counts["known_unprepared"].append({"glyph": glyph, "text": text, "kind": kind,
                            "reason": row["legacy_cache_bypass"] or "exact-current-label-not-prepared"})
                for key in aggregate:
                    aggregate[key] += counts[key]
                summary[language] = counts
            report.update(probe_rows=rows, probe_summary=summary)
        result.update(format_version=2, aggregate=aggregate, semantic_anchors_sha256=anchors,
                      character_name_sources=documents, probe_definition=dict(definition, extra_glyphs=extra),
                      probe_request_assumptions={"mode": "reference", "numberLanguage": "auto", "spellingLanguage": "auto",
                          "nativeProfiles": native_profiles, "nativeEnglishSetting": native_english, "sameVoiceForMixed": False,
                          "speed": speed, "live_preferences_or_voice_overrides_measured": False})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", required=True, type=Path)
    parser.add_argument("--profiles", default="sara,sara_archive", help="Comma separated allowed IDs or all")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--probe-source", type=Path, help="Parse actual windows_nvda_probe.py embedded plugin AST")
    parser.add_argument("--native-profiles", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--native-english", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()
    result = inspect(args.core, args.profiles.split(","), probe_source=args.probe_source,
                     native_profiles=args.native_profiles, native_english=args.native_english, speed=args.speed)
    if args.output.exists():
        raise ValueError("Refusing to overwrite audit output")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"format": result["format"], "profiles": [
        {"profile": row["profile"], "summary": row["summary"], "probe_summary": {
            code: {key: value for key, value in counts.items() if key != "known_unprepared"}
            for code, counts in row["probe_summary"].items()}} for row in result["profiles"]],
        "aggregate": result["aggregate"], "representative_unprepared": {
            code: counts["known_unprepared"] for code, counts in result["profiles"][0]["probe_summary"].items()}
            if result["profiles"] else {}}, ensure_ascii=True))


if __name__ == "__main__":
    main()
