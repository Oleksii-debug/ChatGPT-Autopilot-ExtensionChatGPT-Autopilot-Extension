"""Actual Windows worker smoke checks for letter and symbol audio structure.

This does not certify pronunciation or NVDA typing/physical audio acceptance.
Names come from the installed same-language resources/project helper, or an
explicitly labeled pinned CLDR probe annotation. Missing names never borrow
English. Exploratory raw supplementary output stays unverified even if audible.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
CASES = (
    {"id": "uk-cyrillic-letter", "language": "uk", "glyph": "ї", "resolver": "installed-name"},
    {"id": "ru-cyrillic-letter", "language": "ru", "glyph": "ж", "resolver": "installed-name"},
    {"id": "en-latin-letter", "language": "en", "glyph": "b", "resolver": "installed-name"},
    {"id": "fr-accented-letter", "language": "fr", "glyph": "é", "resolver": "project-latin-name"},
    {"id": "de-accented-letter", "language": "de", "glyph": "ä", "resolver": "project-latin-name"},
    {"id": "uk-punctuation", "language": "uk", "glyph": "?", "resolver": "installed-name"},
    {"id": "en-punctuation", "language": "en", "glyph": "!", "resolver": "installed-name"},
    {"id": "uk-supplementary-arrow", "language": "uk", "glyph": "🡺", "resolver": "installed-name"},
    {"id": "en-supplementary-emoji-name", "language": "en", "glyph": "😀", "resolver": "pinned-cldr-probe-name"},
    {"id": "uk-supplementary-emoji-name", "language": "uk", "glyph": "😀", "resolver": "pinned-cldr-probe-name"},
    {"id": "nb-native-bmp-character", "language": "nb", "glyph": "ø", "resolver": "native-raw-bmp"},
    {"id": "nb-raw-supplementary-exploratory", "language": "nb", "glyph": "😀", "resolver": "raw-supplementary", "exploratory": True},
)
CLDR_REVISION = "7d2b9cb11cec08f4d333ad73209deb3df0711c3b"
CLDR_EMOJI = {
    "en": {"😀": "grinning face", "sha256": "6b6b6e0e5f211bc31cf3fa39f385d80dea6cd19ee19bbc6db9071fce3ae5d360"},
    "uk": {"😀": "широко всміхнене обличчя", "sha256": "33a612c15a1a715511817c56d6c1319ebffd60e62d25d4a158eacfb769bbdff6"},
}


def load_file(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def resolve_case(runtime, case):
    language, glyph = case["language"], case["glyph"]
    mode = case["resolver"]
    if mode in {"native-raw-bmp", "raw-supplementary"}:
        if mode == "native-raw-bmp" and (len(glyph) != 1 or ord(glyph) > 0xFFFF):
            raise ValueError("The native BMP character case is not one BMP character")
        return {"text": glyph, "character": True, "name_source": "actual native backend character path",
                "reviewed_spoken_name": False, "raw_glyph_resolution_verified": False}
    if mode == "pinned-cldr-probe-name":
        try:
            installed_case = dict(case, resolver="installed-name")
            installed = resolve_case(runtime, installed_case)
        except (LookupError, FileNotFoundError):
            pass
        else:
            return dict(installed, production_mapping_gap=False)
        data = CLDR_EMOJI.get(language, {})
        if glyph not in data:
            raise LookupError("No same-language pinned CLDR probe annotation")
        return {"text": data[glyph], "character": False,
                "name_source": "pinned CLDR annotation supplied as spoken description, not driver raw-glyph support",
                "source_url": f"https://raw.githubusercontent.com/unicode-org/cldr-json/{CLDR_REVISION}/cldr-json/cldr-annotations-full/annotations/{language}/annotations.json",
                "source_sha256": data["sha256"], "source_license": "Unicode-3.0",
                "reviewed_spoken_name": True, "raw_glyph_resolution_verified": False,
                "production_mapping_gap": "Probe annotation only; installed driver emoji mapping is not demonstrated"}
    if mode == "project-latin-name":
        helper = load_file(runtime / "experiment_letters.py", "_character_probe_latin_names")
        text = helper.letter_name(language, glyph)
        if not text:
            raise LookupError("No project native letter name for this language/glyph")
        return {"text": text, "character": True,
                "name_source": "installed project experiment_letters mapping; native pronunciation remains unreviewed",
                "reviewed_spoken_name": False, "raw_glyph_resolution_verified": False}
    if mode != "installed-name":
        raise ValueError("Unknown character probe resolver")
    helper = load_file(runtime / "character_names.py", "_character_probe_installed_names")
    directory = runtime / "models/CharacterNames"
    text = helper.spoken_name(language, glyph, directory=directory)
    data = helper.data(language, directory)
    return {"text": text, "character": glyph in data.get("letter_names", {}),
            "name_source": "installed same-language explicit character-name resource",
            "sources": data.get("sources", {}), "reviewed_spoken_name": True,
            "raw_glyph_resolution_verified": False}


def expected_renderer(language):
    if language == "uk":
        return "baseline"
    if language in {"en", "ru"}:
        return "profile"
    if language in {"fr", "de"}:
        return "native-locale:" + language
    return "wide:" + language


def renderer_matches(result, language, voice):
    renderers = result.get("renderers", [])
    expected = expected_renderer(language)
    return bool(renderers) and all(row.get("engine") == expected
        and row.get("profile") == voice and row.get("speaker", voice) == voice for row in renderers)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout", type=float, default=90)
    args = parser.parse_args(argv)
    if not 0 < args.timeout <= 300:
        parser.error("--timeout must be positive and at most 300 seconds")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"format": "dordiai-windows-character-probe", "format_version": 1,
              "created_utc": datetime.now(timezone.utc).isoformat(), "status": "running",
              "scope": "actual worker PCM/renderer structure, not pronunciation, raw-glyph resolution or NVDA typing acceptance",
              "pronunciation_verified": False, "nvda_typing_verified": False, "wave_player_verified": False,
              "physical_audio_verified": False, "product_ready": False, "cases": []}
    worker = None
    failures, unsupported = 0, 0
    try:
        if os.name != "nt":
            report.update(status="blocked", reason="Actual Windows packaged worker required; no engine requests were made")
            return 2
        runtime = args.package_root.resolve() / "kx47Runtime"
        if args.package_root.name == "kx47Runtime":
            runtime = args.package_root.resolve()
        engine = load_file(HERE / "windows_engine_probe.py", "_character_engine_probe")
        catalog = engine.load_catalog(runtime)
        installed = catalog.installed_languages(runtime / "models")
        voices = json.loads((runtime / "models/voices/catalog.json").read_text(encoding="utf-8"))
        worker = engine.PipeWorker(runtime, output / "worker-stderr.log")
        for case in CASES:
            row = dict(case)
            report["cases"].append(row)
            language = case["language"]
            if language not in installed:
                row.update(status="unsupported", reason="Actual same-language resources are not installed")
                unsupported += not case.get("exploratory", False)
                continue
            compatible = catalog.compatible_voice_ids(runtime / "models", language, tuple(voices))
            if not compatible:
                row.update(status="unsupported", reason="No allowed compatible voice assets")
                unsupported += not case.get("exploratory", False)
                continue
            voice = "sara" if "sara" in compatible else compatible[0]
            row["voice"] = voice
            try:
                resolved = resolve_case(runtime, case)
                row.update(resolved)
                request = engine.make_request(language, voice, resolved["text"])
                request["character"] = resolved["character"]
                pcm, result = worker.render(request, args.timeout)
                filename = case["id"] + ".wav"
                engine.save_wave(output / filename, pcm)
                row.update(result, wave_file=filename, wave_sha256=sha256((output / filename).read_bytes()).hexdigest())
                if not renderer_matches(result, language, voice):
                    raise ValueError("Character request changed renderer, language route or selected voice")
                if case.get("exploratory"):
                    row.update(status="unverified", reason="Raw supplementary PCM does not prove a reviewed same-language symbol name; no semantic or typing pass claimed")
                else:
                    row["status"] = "passed-structure-only"
            except LookupError as error:
                row.update(status="unsupported", reason=str(error), english_fallback_used=False)
                unsupported += not case.get("exploratory", False)
            except Exception as error:
                known_unsupported = (isinstance(error, engine.ProbeError)
                    and (str(error).startswith("Speech engine error: ValueError")
                         or str(error) == "No audio samples returned"
                         or "only digital silence" in str(error)))
                if case.get("exploratory") and known_unsupported:
                    row.update(status="unsupported", reason=str(error), english_fallback_used=False)
                else:
                    row.update(status="failed", error=type(error).__name__ + ": " + str(error))
                    failures += 1
                if isinstance(error, engine.ProbeTimeout):
                    raise
        report.update(status="failed" if failures else "partial" if unsupported else "passed-structural-smoke",
                      failed_cases=failures, unsupported_required_cases=unsupported)
    except Exception as error:
        report.update(status="failed", error=type(error).__name__ + ": " + str(error))
    finally:
        if worker is not None:
            report["worker_shutdown"] = worker.close()
            if report["worker_shutdown"]["forced_termination"] or report["worker_shutdown"]["exit_code"] != 0:
                report.update(status="failed", error="Worker did not shut down cleanly")
        report["completed_utc"] = datetime.now(timezone.utc).isoformat()
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"windows_character_probe": report["status"], "failed_cases": report.get("failed_cases"),
                          "unsupported_required_cases": report.get("unsupported_required_cases"), "error": report.get("error")}), flush=True)
    return 0 if report["status"] == "passed-structural-smoke" else 2 if report["status"] in {"partial", "blocked"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
