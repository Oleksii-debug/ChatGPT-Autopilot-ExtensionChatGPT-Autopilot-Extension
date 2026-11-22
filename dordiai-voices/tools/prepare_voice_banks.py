"""Prepare a NEW voice-package source with same-voice letters/commands.

Run on Windows against an installed Holos-family voice and the packaged worker.
The installed immutable voice version is never changed. A new preparation recipe
is written alongside verified profile copies and generated PCM banks. Generation
does not prove pronunciation quality; review the resulting audio before release.
"""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from unicodedata import normalize


MAX_CLIP_BYTES = 24000 * 2 * 8
MAX_ENTRIES = 10000
BANK_ROLES = frozenset({"native_letters_index", "native_letters_audio",
                        "native_commands_index", "native_commands_audio"})
CORE = ("uk", "en", "ru")


def load_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module


def language_key(language):
    value = language.strip().lower().replace("_", "-")
    return "en-us" if value == "en" else value


def entry_key(language, name):
    return sha256((language_key(language) + "\0" + normalize("NFC", name).strip().casefold()).encode("utf-8")).hexdigest()[:24]


def validate_entries(entries):
    if not isinstance(entries, list) or not entries or len(entries) > MAX_ENTRIES:
        raise ValueError("Provide 1..10000 letter/command entries")
    output, seen = [], {}
    for item in entries:
        if not isinstance(item, dict) or item.get("kind", "letter") not in {"letter", "command"}:
            raise ValueError("An entry must have kind letter or command")
        language, text = item.get("language"), item.get("text")
        name = item.get("name", text)
        if (not isinstance(language, str) or not 2 <= len(language) <= 35
                or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in language)
                or not isinstance(text, str) or not text.strip() or len(text) > 160
                or not isinstance(name, str) or not name.strip() or len(name) > 160):
            raise ValueError("Invalid entry language, lookup name or spoken text")
        kind = item.get("kind", "letter")
        row = {"kind": kind, "language": language_key(language), "name": name, "text": text}
        identity = kind, entry_key(language, name)
        if identity in seen:
            if seen[identity] != row:
                raise ValueError("Two entries use the same lookup key with different speech")
            continue
        seen[identity] = row
        output.append(row)
    return output


def _core_letter_maps(driver_path):
    """Read the driver's literal alphabets without importing NVDA or executing it."""
    result = {}
    wanted = {"UK_LETTERS": "uk", "EN_LETTERS": "en", "RU_LETTERS": "ru"}
    for node in ast.parse(Path(driver_path).read_text(encoding="utf-8")).body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            continue
        name = node.targets[0].id
        if name not in wanted:
            continue
        value = node.value
        if (not isinstance(value, ast.Call) or not isinstance(value.func, ast.Name) or value.func.id != "dict"
                or len(value.args) != 1 or not isinstance(value.args[0], ast.Call)
                or not isinstance(value.args[0].func, ast.Name) or value.args[0].func.id != "zip"):
            raise ValueError("Unsupported core letter map layout")
        characters, names = map(ast.literal_eval, value.args[0].args)
        if len(characters) != len(names):
            raise ValueError("Core alphabet and letter names differ")
        result[wanted[name]] = dict(zip(characters, names))
    if set(result) != set(CORE):
        raise ValueError("The driver's core letter maps are missing")
    return result


def default_letter_entries(runtime, languages):
    maps = _core_letter_maps(Path(runtime).parent / "synthDrivers/kx47Preview.py")
    extras = load_file("_dordiai_bank_letter_names", Path(runtime) / "experiment_letters.py")
    output = []
    for language in languages:
        locale = language_key(language)
        base = locale.split("-")[0]
        if base in maps:
            names = list(maps[base].values())
            if locale == "en-gb":
                names = ["zed" if name == "zee" else name for name in names]
            names.append({"uk": "пробіл", "ru": "пробел", "en": "space"}[base])
        elif base in extras.LETTERS:
            names = list(extras.LETTERS[base].values())
        else:
            raise ValueError("Provide --entries-json with reviewed names for language " + locale)
        output.extend({"language": locale, "kind": "letter", "name": name, "text": name} for name in names)
    return validate_entries(output)


def _atomic_json(path, document):
    temporary = path.with_suffix(path.suffix + ".part")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def generate_banks(worker, probe, voice_id, entries, directory, *, timeout=90, progress=None):
    """Pure orchestration, injectable for tests; production uses real PipeWorker."""
    entries = validate_entries(entries)
    for kind in ("letter", "command"):
        selected = [row for row in entries if row["kind"] == kind]
        preview = {"entries": {entry_key(row["language"], row["name"]): [10**12, MAX_CLIP_BYTES] for row in selected},
                   "entry_texts": {entry_key(row["language"], row["name"]): row for row in selected}}
        if len(json.dumps(preview, ensure_ascii=False, indent=2).encode("utf-8")) > 2 * 1024 * 1024 - 1024:
            raise ValueError("The prepared bank index would be too large; prepare fewer languages per voice package")
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    banks, roles, runs = {}, {}, []
    for row in entries:
        kind = row["kind"]
        if kind not in banks:
            plural = "letters" if kind == "letter" else "commands"
            index = directory / (plural + ".json")
            audio = directory / (plural + ".pcm")
            if index.exists() or audio.exists():
                raise ValueError("Prepared bank files already exist; choose a new output source")
            audio.touch(exist_ok=False)
            banks[kind] = {"index_path": index, "audio_path": audio,
                           "document": {"format": "dordiai-voice-bank", "format_version": 1,
                                        "voice_id": voice_id, "kind": plural,
                                        "sample_rate": 24000, "sample_width": 2, "channels": 1,
                                        "complete": False, "entries": {}, "entry_texts": {}}}
            roles[index.name] = "native_" + plural + "_index"
            roles[audio.name] = "native_" + plural + "_audio"
        bank = banks[kind]
        language = row["language"]
        base = language.split("-")[0]
        request = probe.make_request(base if base in CORE else language, voice_id, row["text"])
        request.update(language=language, character=kind == "letter", speed=1.0)
        pcm, result = worker.render(request, timeout)
        if not isinstance(pcm, bytes) or not 2 <= len(pcm) <= MAX_CLIP_BYTES or len(pcm) % 2:
            raise ValueError("Prepared utterance must contain aligned 16-bit PCM of at most eight seconds")
        statistics = probe.audio_statistics(pcm)
        if not statistics["nonzero_samples"]:
            raise ValueError("Prepared utterance contains only digital silence")
        for renderer in result.get("renderers", []):
            if any(renderer.get(key, voice_id) != voice_id for key in ("profile", "speaker")):
                raise ValueError("The worker returned another voice identity")
        offset = bank["audio_path"].stat().st_size
        with bank["audio_path"].open("ab") as audio:
            audio.write(pcm)
        key = entry_key(language, row["name"])
        bank["document"]["entries"][key] = [offset, len(pcm)]
        bank["document"]["entry_texts"][key] = row
        _atomic_json(bank["index_path"], bank["document"])
        runs.append({**row, "audio": statistics, "worker": result})
        _atomic_json(directory / "generation-progress.json", {"voice_id": voice_id, "complete": False, "runs": runs})
        if progress is not None:
            progress(len(runs), len(entries), row)
    for bank in banks.values():
        bank["document"]["complete"] = True
        _atomic_json(bank["index_path"], bank["document"])
    _atomic_json(directory / "generation-progress.json", {"voice_id": voice_id, "complete": True, "runs": runs})
    return roles, runs


def copy_profile_source(runtime, assets, profile, destination, *, version, license_text=None):
    """Export data only into a new source; never modify installed profile files."""
    references = Path(runtime) / "models/voices"
    managed = assets._profile(references, profile)
    roles = {}
    if managed is not None:
        if managed["engine"]["id"] != "holos":
            raise ValueError("This worker preparation currently supports the Holos-family adapter")
        assets._packages.verify_assets(managed["directory"], managed)
        for relative, value in managed["files"].items():
            if value["role"] not in BANK_ROLES:
                target = destination / "assets" / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(Path(managed["directory"]) / relative, target)
                roles[target.relative_to(destination).as_posix()] = value["role"]
        recipe = {key: managed[key] for key in ("name", "engine", "languages", "provenance")}
        recipe.update(styles=managed.get("styles", ["neutral"]), requires=managed.get("requires", []))
    else:
        names = json.loads((references / "catalog.json").read_text(encoding="utf-8"))
        if profile not in names:
            raise ValueError("The requested voice is not installed")
        if not license_text:
            raise ValueError("Provide --license with the actual provenance terms for an exported built-in voice")
        candidates = {
            "holos/" + profile + ".npy": "holos_profile",
            profile + ".npy": "target_embedding",
            "english/" + profile + ".npy": "english_embedding",
            "native_profiles/" + profile + ".npz": "pocket_english_state",
            "native_profiles/" + profile + ".safetensors": "pocket_russian_prompt",
        }
        for relative, role in candidates.items():
            source = references / relative
            if source.is_file():
                target = destination / "assets" / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
                roles[target.relative_to(destination).as_posix()] = role
        if "holos_profile" not in roles.values():
            raise ValueError("The installed Holos voice profile is missing")
        native = references / "native_profiles/delivery.json"
        if native.is_file():
            settings = json.loads(native.read_text(encoding="utf-8")).get(profile)
            if isinstance(settings, dict):
                target = destination / "assets/native-delivery.json"
                _atomic_json(target, settings)
                roles[target.relative_to(destination).as_posix()] = "native_delivery"
        recipe = {"name": names[profile], "engine": {"id": "holos", "compatibility_version": 1},
                  "languages": [code for code, role in (("uk", "holos_profile"), ("en", "pocket_english_state"),
                                                        ("ru", "pocket_russian_prompt")) if role in roles.values()],
                  "styles": ["neutral"], "requires": [],
                  "provenance": {"source": "Prepared profile exported from " + str(references), "license": license_text}}
        catalogue_file = Path(runtime) / "language_catalog.py"
        if catalogue_file.is_file():
            catalogue = load_file("_dordiai_bank_language_catalog", catalogue_file)
            recipe["languages"] = [code for code in catalogue.installed_languages(Path(runtime) / "models")
                                   if catalogue.compatible_voice_ids(Path(runtime) / "models", code, (profile,))]
    recipe.update(voice_id=profile, version=version, roles=roles)
    return recipe


def run(args):
    output = Path(args.output).resolve()
    if output.exists():
        raise ValueError("Choose a NEW output directory; existing/installed sources are never overwritten")
    root = Path(args.package_root).resolve()
    runtime = root if root.name == "kx47Runtime" else root / "kx47Runtime"
    if output.is_relative_to(runtime.parent):
        raise ValueError("Prepared output must be outside the installed add-on")
    if os.name != "nt":
        raise ValueError("Real Windows and the packaged Windows worker are required; no audio was generated")
    assets = load_file("_dordiai_bank_voice_assets", runtime / "voice_assets.py")
    assets.require_voice_allowed(args.voice)
    if not assets._packages.VERSION.fullmatch(args.version):
        raise ValueError("Provide a new major.minor.patch voice version")
    if (assets.package_root(runtime / "models/voices") / args.voice / args.version).exists():
        raise ValueError("This installed voice version already exists; choose a NEW version before generation")
    probe = load_file("_dordiai_bank_worker_probe", Path(__file__).with_name("windows_engine_probe.py"))
    if not (runtime / "python/python.exe").is_file():
        raise ValueError("The packaged Windows Python is missing")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=output.name + ".preparing-", dir=output.parent))
    worker = None
    report = {"format": "dordiai-voice-bank-preparation", "format_version": 1,
              "voice_id": args.voice, "version": args.version, "status": "running",
              "pronunciation_verified": False, "nvda_verified": False,
              "created_utc": datetime.now(timezone.utc).isoformat()}
    try:
        recipe = copy_profile_source(runtime, assets, args.voice, stage, version=args.version, license_text=args.license)
        if args.entries_json:
            entries = validate_entries(json.loads(Path(args.entries_json).read_text(encoding="utf-8")))
        else:
            languages = (args.languages.split(",") if args.languages else
                         [code for code in recipe["languages"] if code.split("-")[0] in CORE])
            entries = default_letter_entries(runtime, languages)
        allowed = {code.lower().split("-")[0] for code in recipe["languages"]}
        if any(row["language"].split("-")[0] not in allowed for row in entries):
            raise ValueError("The requested bank includes a language not declared by the installed voice")
        worker = probe.PipeWorker(runtime, stage / "worker-stderr.log")
        roles, runs = generate_banks(worker, probe, args.voice, entries, stage / "banks", timeout=args.timeout,
            progress=lambda done, total, row: print(f"{done}/{total}: {row['language']} {row['name']}", flush=True))
        recipe["roles"].update({"banks/" + name: role for name, role in roles.items()})
        _atomic_json(stage / "recipe.json", recipe)
        report.update(status="prepared", entry_count=len(runs), generation_report="banks/generation-progress.json",
                      note="Generated data requires listening and pronunciation review before release")
        report["worker_shutdown"] = worker.close()
        worker = None
        if report["worker_shutdown"]["forced_termination"] or report["worker_shutdown"]["exit_code"] != 0:
            raise ValueError("The worker did not shut down cleanly")
        _atomic_json(stage / "preparation-report.json", report)
        os.replace(stage, output)
        print("Prepared source and reusable recipe: " + str(output), flush=True)
    except Exception as error:
        report.update(status="failed", error=str(error), retained_partial_source=str(stage))
        _atomic_json(stage / "preparation-report.json", report)
        raise
    finally:
        if worker is not None:
            worker.close()
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", required=True, type=Path)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--version", required=True, help="New immutable voice-package version")
    parser.add_argument("--output", required=True, type=Path, help="NEW prepared-source directory outside the add-on")
    parser.add_argument("--languages", help="Optional comma-separated bank languages; defaults to the voice's core languages")
    parser.add_argument("--entries-json", type=Path, help="Explicit reviewed letter/command entries instead of default alphabets")
    parser.add_argument("--license", help="Required actual provenance terms when exporting a built-in voice")
    parser.add_argument("--timeout", type=float, default=90)
    args = parser.parse_args(argv)
    if not 0 < args.timeout <= 600:
        parser.error("timeout must be greater than zero and no more than 600 seconds")
    try:
        run(args)
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(2, "Voice bank preparation error: " + str(error) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
