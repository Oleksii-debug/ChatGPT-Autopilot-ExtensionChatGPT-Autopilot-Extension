"""Selected-language inventory without importing acoustic libraries or starting models.

``resources_present`` is a file-presence/registration check, never a claim of
correct pronunciation or a successful Windows/NVDA audio test.  This distinction
also prevents missing optional packs from appearing as usable settings choices.
"""
from collections import OrderedDict
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
CORE = frozenset(("uk", "ru", "en", "sk", "pl", "de", "fr", "da", "it", "es"))
ALIASES = {"no": "nb", "iw": "he", "in": "id", "zh": "cmn", "zh-cmn": "cmn",
           "zh-yue": "yue", "hy-arevmda": "hyw", "mo": "ro", "gom": "kok"}
try:
    from voice_policy import is_voice_allowed
except ImportError:
    # NVDA may import this module by path rather than adding runtime to sys.path.
    _policy_spec = importlib.util.spec_from_file_location("_dordiai_catalog_voice_policy", HERE / "voice_policy.py")
    _policy = importlib.util.module_from_spec(_policy_spec)
    _policy_spec.loader.exec_module(_policy)
    is_voice_allowed = _policy.is_voice_allowed
PIPER = {"pl": "pl_PL-gosia-medium.onnx", "de": "de_DE-thorsten-medium.onnx",
         "fr": "fr_FR-siwis-medium.onnx", "da": "da_DK-talesyntese-medium.onnx",
         "it": "it_IT-paola-medium.onnx", "es": "es_ES-davefx-medium.onnx"}


def canonical_code(value):
    """Normalize language tags while leaving selection groups unexpanded.

    An alias does not invent a model: e.g. ``fil`` is not silently substituted
    with another language, and Montenegrin is not mapped to Serbian.
    """
    code = str(value or "").strip().lower().replace("_", "-")
    if code in ALIASES:
        return ALIASES[code]
    return ALIASES.get(code.partition("-")[0], code.partition("-")[0])


def _read(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return {}


def _models(models):
    return Path(models) if models is not None else HERE / "models"


def _path(models, relative):
    root = models.resolve()
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root):
        raise ValueError("Language resource escapes models directory")
    return candidate


def _present(models, relative):
    try:
        file = _path(models, relative)
        return file.is_file() and file.stat().st_size > 0
    except (OSError, ValueError):
        return False


def _check(models, required):
    # A tuple is a set of accepted equivalent graph encodings (ONNX or ORT).
    missing = []
    for requirement in required:
        choices = requirement if isinstance(requirement, tuple) else (requirement,)
        if not any(_present(models, name) for name in choices):
            missing.append(" | ".join(choices))
    return missing


def _graph(path):
    return (path.removesuffix(".onnx") + ".ort", path)


CONVERSION = ("OpenVoiceV2/encoder-flow.onnx", "OpenVoiceV2/decoder.onnx")
HOLOS = ("Holos/holos_onnx.json", "Holos/encoder.onnx", "Holos/prosody.onnx",
         "Holos/source.onnx", "Holos/decoder_window.onnx", "Holos/voices.npz")
ESPEAK = ("WideLanguages/espeak.dll", "WideLanguages/espeak-ng-data/phondata",
          "WideLanguages/espeak-ng-data/phontab", "WideLanguages/espeak-ng-data/phonindex")


def _shared_requirements():
    prefix = "WideLanguages/SharedAcoustic/"
    return (prefix + "capabilities.json", prefix + "source.npy", prefix + "onnx/tts.json",
            prefix + "onnx/unicode_indexer.json", prefix + "voice_styles/F1.json",
            _graph(prefix + "onnx/duration_predictor.onnx"),
            _graph(prefix + "onnx/text_encoder.onnx"),
            _graph(prefix + "onnx/vector_estimator.static-q8.onnx"),
            _graph(prefix + "onnx/vocoder.onnx")) + CONVERSION


def _core_requirements(code, models):
    if code == "uk":
        return "holos-neural", HOLOS
    if code == "en":
        prefix = "PocketTTS/en/"
        return "pocket-neural", (prefix + "tokenizer.model",
            _graph(prefix + "text_conditioner.onnx"), _graph(prefix + "flow_lm_flow.onnx"),
            _graph(prefix + "flow_lm_main_int8.onnx"), _graph(prefix + "mimi_decoder.onnx"),
            "voices/native_profiles/delivery.json")
    if code == "ru":
        return "pocket-neural", ("PocketTTS/ru/model_fast.safetensors", "PocketTTS/ru/config.yaml",
            "PocketTTS/ru/tokenizer.model", "PocketTTS/ru/pocket-ru.exe",
            "voices/native_profiles/delivery.json")
    registry = _read(models / "voices/classmate_locales/languages.json")
    info = registry.get(code, {}) if isinstance(registry, dict) else {}
    if not info:
        return "unregistered", ("voices/classmate_locales/languages.json:" + code,)
    source = info.get("source", "")
    if not isinstance(source, str) or not source:
        return "unregistered", ("voices/classmate_locales/languages.json:" + code + ":source",)
    source = "voices/classmate_locales/" + source
    if code == "sk" and info.get("backend") == "rhvoice":
        return "rhvoice-statistical+voice-conversion", CONVERSION + (source,
            "Slovak/lib/RHVoice.dll", "Slovak/data/voice.info", "Slovak/data/24000/voice.data",
            "Slovak/langdata/language.info", "Slovak/langdata/g2p.fst")
    filename = info.get("model")
    if not isinstance(filename, str) or not filename:
        return "unregistered", ("voices/classmate_locales/languages.json:" + code + ":model",)
    return "piper-neural+voice-conversion", CONVERSION + (source,
        "Piper/" + filename, "Piper/" + filename + ".json")


def _wide_requirements(code, info, models):
    source = info.get("source", "")
    if not isinstance(source, str) or not source:
        return "unregistered", ("wide_voice_index.json:" + code + ":source",)
    required = CONVERSION + ("WideLanguages/" + source,)
    if info.get("natural") == "shared":
        required += _shared_requirements()
        if code == "ja":
            required += ("WideLanguages/Japanese/index.json", "WideLanguages/Japanese/readings.bin")
        return "shared-neural+voice-conversion", required
    backend = info.get("backend")
    if backend == "renikud-noa":
        return "hebrew-neural+voice-conversion", required + (
            "WideLanguages/Hebrew/noa.onnx", "WideLanguages/Hebrew/noa.onnx.json",
            "WideLanguages/Hebrew/g2p.onnx", "WideLanguages/Hebrew/renikud.py")
    if backend == "breton-vits":
        return "breton-neural+voice-conversion", required + (
            "WideLanguages/Breton/model.onnx", "WideLanguages/Breton/tokens.txt")
    if backend == "nos-vits":
        return "vits-neural+voice-conversion", required + (
            "WideLanguages/wide_extra/" + code + "/model-q8.onnx",
            "WideLanguages/wide_extra/" + code + "/config.json")
    if backend:
        # Unknown adapters may need more than just a source vector.
        return "unsupported-adapter", ("adapter:" + str(backend),)
    voice = info.get("voice", "")
    if not isinstance(voice, str) or not voice:
        return "unregistered", ("wide_voice_index.json:" + code + ":voice",)
    if voice.startswith("upstream:"):
        voice = voice.partition(":")[2]
        prefix = "WideLanguages/EuropeanVoices/"
        return "espeak+voice-conversion", required + (prefix + "libespeak-ng.dll",
            prefix + "espeak-ng-data/phondata", prefix + "espeak-ng-data/phontab",
            prefix + "espeak-ng-data/phonindex", prefix + "espeak-ng-data/lang/" + voice)
    if voice.startswith("rules:"):
        return "pronunciation-rules+espeak+voice-conversion", required + ESPEAK + (
            "WideLanguages/PronunciationRules/" + code + ".json",
            "WideLanguages/PronunciationRules/" + code + "-phones.json")
    return "espeak+voice-conversion", required + ESPEAK + ("WideLanguages/espeak-ng-data/lang/" + voice,)


def _selected():
    data = _read(HERE / "language_catalog.json")
    entries = data.get("entries", []) if isinstance(data, dict) else []
    return [entry for entry in entries if isinstance(entry, dict) and isinstance(entry.get("id"), str)]


def _registry(models):
    registry_file = models.parent / "wide_voice_index.json"
    registry = _read(registry_file if registry_file.is_file() else HERE / "wide_voice_index.json")
    return registry if isinstance(registry, dict) else {}


def _availability(entry, models, registry):
    requested = entry["id"]
    code = canonical_code(requested)
    info = registry.get(code)
    if code in CORE:
        backend, required = _core_requirements(code, models)
        registered = True
    elif isinstance(info, dict):
        backend, required = _wide_requirements(code, info, models)
        registered = True
    else:
        backend, required, registered = "not-registered", (), False
    missing = _check(models, required)
    if registered and isinstance(info, dict) and info.get("natural") == "shared":
        capabilities = _read(models / "WideLanguages/SharedAcoustic/capabilities.json")
        supported = capabilities.get("languages", []) if isinstance(capabilities, dict) else []
        if code not in supported:
            missing.append("SharedAcoustic/capabilities.json:language=" + code)
    present = registered and not missing
    return {**entry, "runtime_code": code, "registered": registered,
            "backend": backend, "resources_present": present,
            "status": "resources-present-unverified" if present else "missing-resources" if registered else "not-registered",
            "missing_resources": missing,
            "windows_audio_verified": False}


def coverage(models=None, selected_only=True):
    """Return ordered selected entries with conservative resource availability.

    The original requested ID is retained for catalog groups; ``runtime_code``
    contains the real routing alias. ``windows_audio_verified`` deliberately
    remains false: inventory cannot establish acoustic quality.
    """
    models = _models(models)
    registry = _registry(models)
    entries = _selected()
    if not selected_only:
        selected = {canonical_code(row["id"]) for row in entries}
        entries += [{"id": code, "name_uk": info.get("name", code), "regions": [], "first_priority_region": None}
                    for code, info in registry.items() if code not in selected]
    return [_availability(entry, models, registry) for entry in entries]


def language_status(models, language):
    """Check one selected language; useful when preparing a compatibility map."""
    models = _models(models)
    code = canonical_code(language)
    entry = next((row for row in _selected() if canonical_code(row["id"]) == code), None)
    return _availability(entry, models, _registry(models)) if entry is not None else None


def installed_languages(models=None, selected_only=True):
    """Labels for settings: installed selected resources, not promised catalog items."""
    return OrderedDict((row["runtime_code"], row["name_uk"]) for row in coverage(models, selected_only)
                       if row["resources_present"])


def available_languages(runtime_root=None, selected_only=True):
    """Convenience wrapper for callers holding a runtime directory."""
    return installed_languages(Path(runtime_root) / "models" if runtime_root is not None else None,
                               selected_only=selected_only)


def compatible_voice_ids(models, language, allowed_voice_ids):
    """Return only installed, allowed identity resources for an available language.

    This is structural compatibility. Acoustic validation remains a separate
    acceptance check. No synthetic per-language promise is inferred from names.
    """
    models = _models(models)
    code = canonical_code(language)
    status = language_status(models, code)
    if status is None or not status["resources_present"]:
        return ()
    if code == "uk":
        def profile_present(voice):
            return _present(models, "voices/holos/" + voice + ".npy")
    elif code in {"en", "ru"}:
        delivery = _read(models / "voices/native_profiles/delivery.json")
        def profile_present(voice):
            suffix = ".npz" if code == "en" else ".safetensors"
            return isinstance(delivery, dict) and voice in delivery and _present(
                models, "voices/native_profiles/" + voice + suffix)
    else:
        def profile_present(voice):
            return _present(models, "voices/classmate_locales/" + voice + ".npy")
    return tuple(voice for voice in allowed_voice_ids
                 if isinstance(voice, str) and is_voice_allowed(voice)
                 and voice and all(char.isalnum() or char in "_-" for char in voice)
                 and profile_present(voice))
