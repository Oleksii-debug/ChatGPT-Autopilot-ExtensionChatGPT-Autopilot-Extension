"""Selected-language inventory without importing acoustic libraries or starting models.

``resources_present`` is a file-presence/registration check, never a claim of
correct pronunciation or a successful Windows/NVDA audio test.  This distinction
also prevents missing optional packs from appearing as usable settings choices.
"""
from collections import OrderedDict
from functools import lru_cache
import ast
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import struct

HERE = Path(__file__).resolve().parent
CORE = frozenset(("uk", "ru", "en", "sk", "pl", "de", "fr", "da", "it", "es"))
try:
    from language_codes import ALIASES, canonical_language
except ImportError:
    _codes_spec = importlib.util.spec_from_file_location("_dordiai_catalog_language_codes", HERE / "language_codes.py")
    _codes = importlib.util.module_from_spec(_codes_spec)
    _codes_spec.loader.exec_module(_codes)
    ALIASES, canonical_language = _codes.ALIASES, _codes.canonical_language
GROUP_STANDARDS = {
    "tamazight": {"runtime_code": "kab", "display_name_uk": "Кабільська (берберська; Алжир)",
                   "partial_variant": True,
                   "standard_note": "Only an explicit Kabyle variant of the broad selected Berber group; not Standard Moroccan Tamazight (zgh/tzm)."},
}
OMNI_LANGUAGES = frozenset(("rm", "ks", "mni", "brx", "ig", "ln", "zu", "xh", "wo", "nso"))
_PURE_HELPERS = {}


def _pure_helper(name):
    if name not in _PURE_HELPERS:
        spec = importlib.util.spec_from_file_location("_dordiai_catalog_" + name, HERE / (name + ".py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _PURE_HELPERS[name] = module
    return _PURE_HELPERS[name]
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
    return canonical_language(value)


def _file_signature(path):
    path = Path(path).resolve()
    state = path.stat()
    return str(path), state.st_size, state.st_mtime_ns, getattr(state, "st_ctime_ns", 0), getattr(state, "st_ino", 0)


@lru_cache(maxsize=64)
def _read_json_cached(path, size, modified, changed, inode):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _read(path):
    try:
        signature = _file_signature(path)
        if signature[1] > 4 * 1024**2:
            return {}
        return _read_json_cached(*signature)
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


def _read_npy(models, relative, max_bytes):
    """Read a bounded numeric NPY resource without NumPy or pickle in NVDA."""
    try:
        path = _path(models, relative)
        if not 32 <= path.stat().st_size <= max_bytes:
            return None
        with path.open("rb") as source:
            if source.read(6) != b"\x93NUMPY":
                return None
            version = source.read(2)
            if version[0] == 1:
                length = struct.unpack("<H", source.read(2))[0]
            elif version[0] in (2, 3):
                length = struct.unpack("<I", source.read(4))[0]
            else:
                return None
            if length > 4096:
                return None
            header = ast.literal_eval(source.read(length).decode("utf-8" if version[0] == 3 else "latin-1"))
            if not isinstance(header, dict) or header.get("fortran_order") is not False:
                return None
            return header, source.read(max_bytes + 1)
    except (OSError, ValueError, TypeError, SyntaxError, IndexError, struct.error):
        return None


def _source_identity_valid(models, relative):
    """Validate the small conditioning vector without importing NumPy in NVDA."""
    data = _read_npy(models, relative, 8192)
    if data is None:
        return False
    header, raw = data
    if header.get("shape") != (1, 256, 1) or header.get("descr") not in ("<f4", "=f4") or len(raw) != 1024:
        return False
    values = struct.unpack("<256f", raw)
    return all(math.isfinite(value) for value in values) and any(abs(value) > 1e-8 for value in values)


def _codec_reference_valid(models, relative):
    data = _read_npy(models, relative, 40000)
    if data is None:
        return False
    header, raw = data
    shape = header.get("shape")
    if (not isinstance(shape, tuple) or len(shape) != 2 or shape[0] != 8
            or not isinstance(shape[1], int) or not 1 <= shape[1] <= 500
            or header.get("descr") not in ("<i8", "=i8") or len(raw) != 8 * shape[0] * shape[1]):
        return False
    return all(0 <= value < 1024 for value in struct.unpack("<" + str(shape[0] * shape[1]) + "q", raw))


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
    if info.get("backend") == "afri-six-onnx":
        if code not in {"ss", "ve", "zu", "wo", "nso"}:
            return "unsupported-adapter", ("afri-six-onnx-adapter:" + code,)
        prefix = "SharedAfriSixONNX/"
        return "native-shared-six-layer-fp32+voice-conversion", CONVERSION + tuple(prefix + name for name in (
            "lm_main.onnx", "lm_flow.onnx", "encoder.onnx", "decoder.onnx", "text_conditioner.onnx",
            "tokenizer.json", "config.json", "NOTICE.txt", "references/" + code + "/config.json",
            "references/" + code + "/reference.wav", "references/" + code + "/source.npy",
            "references/" + code + "/NOTICE.txt"))
    if info.get("backend") == "rasa-onnx":
        if code != "brx":
            return "unsupported-adapter", ("rasa-onnx-adapter:" + code,)
        return "rasa-native-neural+voice-conversion", CONVERSION + tuple("SharedRasaONNX/" + name for name in (
            "model.onnx", "tokens.txt", "config.json", "NOTICE.txt", "references/brx/source.npy"))
    if info.get("backend") == "omni-onnx":
        if code not in OMNI_LANGUAGES:
            return "unsupported-adapter", ("omni-onnx-adapter:" + code,)
        prefix = "SharedOmniONNX/"
        return "shared-diffusion-neural+voice-conversion", CONVERSION + tuple(prefix + name for name in (
            "backbone.int8.onnx", "vocoder.fp32.onnx", "vocoder.fp32.onnx.data", "tokenizer.json",
            "UPSTREAM-LICENSE-NOTICE.txt", "references/" + code + "/codes.npy",
            "references/" + code + "/text.txt", "references/" + code + "/source.npy"))
    if info.get("backend") in {"mms-onnx", "mms-vits"}:
        return "mms-neural+voice-conversion", CONVERSION + tuple(
            "MMS/" + code + "/" + name for name in ("model.onnx", "tokens.txt", "config.json", "source.npy", "NOTICE.txt"))
    if info.get("backend") == "extra-onnx":
        if code not in {"sat", "st", "xh", "ig", "ln", "nd", "ks"}:
            return "unsupported-adapter", ("extra-onnx-adapter:" + code,)
        required = ("model.onnx", "config.json", "source.npy", "NOTICE.txt")
        if code in {"st", "xh"}:
            required += ("runtime_config.json", "upstream-vocab.json", "upstream-tokenizer_config.json")
        if code in {"ig", "ln", "nd"}:
            required += ("runtime_config.json",)
        if code == "ks":
            required += ("runtime_config.json", "export_provenance.json")
        return "dedicated-neural+voice-conversion", CONVERSION + tuple("ExtraLanguages/" + code + "/" + name for name in required)
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
    return [{**entry, **GROUP_STANDARDS.get(entry["id"], {})} for entry in entries
            if isinstance(entry, dict) and isinstance(entry.get("id"), str)]


def _entry_code(entry):
    return canonical_code(entry.get("runtime_code", entry["id"]))


def _registry(models):
    registry_file = models.parent / "wide_voice_index.json"
    registry = _read(registry_file if registry_file.is_file() else HERE / "wide_voice_index.json")
    return registry if isinstance(registry, dict) else {}


@lru_cache(maxsize=128)
def _small_hash_cached(path, size, modified, changed, inode):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _small_hash(models, relative):
    try:
        path = _path(models, relative)
        signature = _file_signature(path)
        if signature[1] > 50000:
            return None
        return _small_hash_cached(*signature)
    except (OSError, ValueError):
        return None


def _rasa_missing(models, code, info):
    missing = _check(models, _wide_requirements(code, info, models)[1])
    configuration = _read(models / "SharedRasaONNX/config.json")
    expected = {"brx": {"speaker_id": 4, "speaker_name": "BRX_F", "style_id": 0, "style_name": "ALEXA", "script": "Deva"}}
    if (code != "brx" or not isinstance(configuration, dict) or configuration.get("format") != "dordiai-rasa-onnx-v1"
            or configuration.get("sample_rate") != 24000 or configuration.get("frontend") != "native-characters"
            or configuration.get("languages") != expected):
        missing.append("SharedRasaONNX/config.json:documented-native-BRX-speaker-and-style")
    relative = "SharedRasaONNX/references/brx/source.npy"
    if not _source_identity_valid(models, relative):
        missing.append(relative + ":valid-finite-float32-conditioning-vector")
    identities = configuration.get("source_identity", {}) if isinstance(configuration, dict) else {}
    proof = identities.get("brx", {}) if isinstance(identities, dict) else {}
    provenance = configuration.get("provenance", {}) if isinstance(configuration, dict) else {}
    files = provenance.get("files", {}) if isinstance(provenance, dict) else {}
    graph = files.get("model.onnx", {}) if isinstance(files, dict) else {}
    if (not isinstance(proof, dict) or proof.get("language") != "brx" or proof.get("speaker_id") != 4
            or proof.get("style_id") != 0 or proof.get("sample_rate") != 24000
            or not isinstance(graph, dict) or not graph.get("sha256") or proof.get("model_sha256") != graph.get("sha256")
            or proof.get("tokens_sha256") != _small_hash(models, "SharedRasaONNX/tokens.txt")
            or proof.get("source_sha256") != _small_hash(models, relative)):
        missing.append(relative + ":actual-matching-BRX_F4-ALEXA0-calibration")
    return missing


def _matcha_missing(models, code, info):
    missing = _check(models, _wide_requirements(code, info, models)[1])
    configuration = _read(models / "ExtraLanguages/ks/runtime_config.json")
    if not isinstance(configuration, dict):
        configuration = {}
    if (code != "ks" or not isinstance(configuration, dict) or configuration.get("format") != "dordiai-matcha-onnx-v1"
            or configuration.get("code") != "ks" or configuration.get("iso_code") != "kas"
            or configuration.get("sample_rate") != 22050 or configuration.get("speaker") != 422
            or configuration.get("steps") != 10):
        missing.append("ExtraLanguages/ks/runtime_config.json:exact-native-Matcha-standard")
    if not _source_identity_valid(models, "ExtraLanguages/ks/source.npy"):
        missing.append("ExtraLanguages/ks/source.npy:valid-finite-float32-conditioning-vector")
    proof = configuration.get("source_identity", {}) if isinstance(configuration, dict) else {}
    if (not isinstance(proof, dict) or proof.get("source_sha256") != _small_hash(models, "ExtraLanguages/ks/source.npy")
            or configuration.get("config_sha256") != _small_hash(models, "ExtraLanguages/ks/config.json")):
        missing.append("ExtraLanguages/ks/source.npy:matching-native-Matcha-calibration")
    try:
        _matcha_frontend(models)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        missing.append("ExtraLanguages/ks/config.json:valid-trained-native-frontend")
    return missing


@lru_cache(maxsize=4)
def _matcha_frontend_cached(path, size, modified, changed, inode):
    return _pure_helper("wide_matcha_frontend").MatchaFrontend(_read_json_cached(path, size, modified, changed, inode))


def _matcha_frontend(models):
    return _matcha_frontend_cached(*_file_signature(models / "ExtraLanguages/ks/config.json"))


def _matcha_input_problem(models, text, character):
    helper = _pure_helper("wide_matcha_frontend")
    if character and not (len(text) == 1 and text.isdecimal()):
        try:
            text = _pure_helper("character_names").spoken_name("ks", text, directory=models / "CharacterNames")
        except LookupError:
            # The same ordinary-name resource is needed by either engine; a
            # missing name must remain an explicit error, not an invented sound.
            return None
    try:
        _matcha_frontend(models).ids(text)
    except helper.UnsupportedMatchaInput as error:
        return str(error)
    return None



def _afri_missing(models, code, info):
    expected = {"ss": "ssw", "ve": "ven", "zu": "zul", "wo": "wol", "nso": "nso"}
    if (code not in expected or info.get("language") != code or info.get("iso_code") != expected[code]
            or info.get("source") != "SharedAfriSixONNX/references/" + code + "/source.npy"):
        return ["afri-six-onnx:explicit-same-native-language-required"]
    missing = _check(models, _wide_requirements(code, info, models)[1])
    try:
        if code not in _pure_helper("wide_afri_six").available(models):
            missing.append("SharedAfriSixONNX/references/" + code + ":matching-native-resource-and-source-calibration")
    except (OSError, ValueError, TypeError, KeyError, ImportError):
        missing.append("afri-six-onnx:reviewed-runtime-adapter-required")
    return list(dict.fromkeys(missing))


def _omni_fallback_missing(models, code, info):
    if (code not in {"brx", "ks", "zu", "wo", "nso"} or info.get("backend") != "omni-onnx" or info.get("language") != code
            or info.get("source") != "SharedOmniONNX/references/" + code + "/source.npy"):
        return ["fallback:explicit-same-language-Omni-reference-required"]
    missing = _check(models, _wide_requirements(code, info, models)[1])
    source = _read(models / "SharedOmniONNX/source.json")
    if (not isinstance(source, dict) or not info.get("model_repository") or not info.get("model_revision")
            or source.get("repository") != info.get("model_repository") or source.get("revision") != info.get("model_revision")):
        missing.append("SharedOmniONNX/source.json:matching-prepared-model-revision")
    prefix = "SharedOmniONNX/references/" + code + "/"
    if not _codec_reference_valid(models, prefix + "codes.npy") or not _source_identity_valid(models, prefix + "source.npy"):
        missing.append(prefix + ":valid-codec-and-conditioning-vectors")
    expected = info.get("reference_hashes", {})
    if not isinstance(expected, dict) or set(expected) != {"codes.npy", "text.txt", "source.npy"}:
        missing.append(prefix + ":pinned-reference-calibration-required")
    else:
        for name, digest in expected.items():
            if not isinstance(digest, str) or len(digest) != 64 or _small_hash(models, prefix + name) != digest:
                missing.append(prefix + name + ":matching-pinned-reference")
    return missing


def resolve_backend_info(models, code, info, text=None, character=False):
    """One conservative backend choice for inventory and actual source/rendering.

    A fallback is explicitly declared, same-language, and calibrated. No nearby
    language, another speaker, or generic eSpeak engine is ever substituted.
    Text-specific Matcha rejection does not hide missing unsupported characters.
    """
    if not isinstance(info, dict):
        return info
    preferred = info.get("backend")
    is_matcha = preferred == "extra-onnx" and info.get("family") == "matcha"
    is_afri = preferred == "afri-six-onnx"
    if preferred != "rasa-onnx" and not is_matcha and not is_afri:
        return info
    models, code = _models(models), canonical_code(code)
    missing = (_afri_missing(models, code, info) if is_afri else
               _matcha_missing(models, code, info) if is_matcha else _rasa_missing(models, code, info))
    unsupported = _matcha_input_problem(models, text, character) if is_matcha and text is not None and not missing else None
    if not missing and not unsupported:
        return {**info, "_backend_selection": "preferred", "_preferred_backend": preferred}
    reason = "unsupported-native-input" if unsupported else "preferred-resources-missing"
    failures = []
    for fallback in info.get("fallbacks", []):
        if not isinstance(fallback, dict):
            continue
        rejected = _omni_fallback_missing(models, code, fallback)
        if not rejected:
            return {**fallback, "_backend_selection": "explicit-same-language-fallback", "_preferred_backend": preferred,
                    "_selection_reason": reason, "_unsupported_input_detail": unsupported, "_preferred_missing_resources": missing}
        failures.extend(rejected)
    return {**info, "_backend_selection": "preferred-unavailable" if missing else "preferred",
            "_preferred_backend": preferred, "_selection_reason": reason,
            "_preferred_missing_resources": missing, "_fallback_missing_resources": failures}


def _availability(entry, models, registry):
    requested = entry["id"]
    code = _entry_code(entry)
    info = resolve_backend_info(models, code, registry.get(code))
    if code in CORE:
        backend, required = _core_requirements(code, models)
        registered = True
    elif isinstance(info, dict):
        backend, required = _wide_requirements(code, info, models)
        registered = True
    else:
        backend, required, registered = "not-registered", (), False
    missing = _check(models, required)
    capabilities = None
    if isinstance(info, dict) and info.get("backend") == "afri-six-onnx":
        missing = _afri_missing(models, code, info)
        capabilities = {"character_names": False, "number_normalization": False,
                        "keyboard_echo_verified": False, "interactive_nvda_latency_verified": False,
                        "native_pronunciation_verified": False}
    if isinstance(info, dict) and info.get("backend") == "rasa-onnx":
        missing = _rasa_missing(models, code, info)
        capabilities = {"character_names": False, "number_normalization": False,
                        "source_speaker": "BRX_F", "source_speaker_id": 4, "source_style": "ALEXA", "source_style_id": 0}
    if isinstance(info, dict) and info.get("backend") in {"mms-onnx", "mms-vits", "extra-onnx"}:
        prefix = ("MMS/" + code) if info["backend"] in {"mms-onnx", "mms-vits"} else "ExtraLanguages/" + code
        config = _read(models / prefix / "config.json")
        if info["backend"] in {"mms-onnx", "mms-vits"}:
            if (not isinstance(config, dict) or config.get("format") != "dordiai-mms-onnx-v1"
                    or config.get("code") != code or config.get("frontend") != "characters"
                    or config.get("is_uroman") or config.get("iso_code") != info.get("iso_code")):
                missing.append(prefix + "/config.json:valid-native-language-adapter")
            navigation = config.get("navigation", {}) if isinstance(config, dict) else {}
            capabilities = {"character_names": bool(config.get("navigation_verified")) and bool(navigation.get("letters")) if isinstance(navigation, dict) else False,
                            "number_normalization": False}
        elif code == "sat":
            mapping = config.get("phoneme_id_map", {}) if isinstance(config, dict) else {}
            if not isinstance(mapping, dict) or not {"^", "_", "$"} <= mapping.keys():
                missing.append(prefix + "/config.json:phoneme-map")
            capabilities = {"character_names": False, "number_normalization": False}
        elif code in {"ig", "ln", "nd"}:
            runtime = _read(models / prefix / "runtime_config.json")
            mapping = config.get("phoneme_id_map", {}) if isinstance(config, dict) else {}
            audio = config.get("audio", {}) if isinstance(config, dict) else {}
            if (not isinstance(runtime, dict) or runtime.get("format") != "dordiai-coqui-onnx-v1"
                    or runtime.get("code") != code or runtime.get("iso_code") != {"ig": "ibo", "ln": "lin", "nd": "nde"}[code]
                    or runtime.get("sample_rate") != 22050 or not isinstance(config, dict)
                    or config.get("engine") != "coqui" or config.get("lang_code") != code or not isinstance(mapping, dict)
                    or not isinstance(audio, dict) or audio.get("sample_rate") != 22050
                    or not mapping or config.get("blank") not in mapping):
                missing.append(prefix + "/runtime_config.json:valid-native-coqui-adapter")
            capabilities = {"character_names": False, "number_normalization": False}
        elif code == "ks":
            missing = _matcha_missing(models, code, info)
            capabilities = {"character_names": False, "number_normalization": False, "unsupported_native_characters": ["U+0672"]}
        else:
            runtime = _read(models / prefix / "runtime_config.json")
            vocabulary = _read(models / prefix / "upstream-vocab.json")
            tokenizer = _read(models / prefix / "upstream-tokenizer_config.json")
            if (not isinstance(runtime, dict) or runtime.get("format") != "dordiai-simba-onnx-v1"
                    or runtime.get("code") != code or runtime.get("iso_code") != {"st": "sot", "xh": "xho"}.get(code)
                    or runtime.get("sample_rate") != 16000
                    or runtime.get("frontend") != "transformers-vits-graphemes"
                    or not isinstance(vocabulary, dict) or vocabulary.get("h") != 0
                    or not isinstance(tokenizer, dict) or tokenizer.get("pad_token") != "h"
                    or tokenizer.get("is_uroman") or tokenizer.get("phonemize") or not tokenizer.get("add_blank")):
                missing.append(prefix + "/runtime_config.json:valid-native-simba-adapter")
            capabilities = {"character_names": False, "number_normalization": False}
        if not _source_identity_valid(models, prefix + "/source.npy"):
            missing.append(prefix + "/source.npy:valid-finite-float32-conditioning-vector")
    if isinstance(info, dict) and info.get("backend") == "omni-onnx":
        prefix = "SharedOmniONNX/references/" + code
        if not _codec_reference_valid(models, prefix + "/codes.npy"):
            missing.append(prefix + "/codes.npy:valid-native-codec-reference")
        if not _source_identity_valid(models, prefix + "/source.npy"):
            missing.append(prefix + "/source.npy:valid-finite-float32-conditioning-vector")
        try:
            text = _path(models, prefix + "/text.txt").read_text(encoding="utf-8").strip()
            if not text or len(text) > 10000 or "<|" in text or "|>" in text:
                missing.append(prefix + "/text.txt:valid-literal-transcript")
        except (OSError, UnicodeError, ValueError):
            missing.append(prefix + "/text.txt:valid-literal-transcript")
        capabilities = {"character_names": False, "number_normalization": False,
                        "interactive_nvda_latency_verified": False}
    if registered and isinstance(info, dict) and info.get("natural") == "shared":
        capabilities = _read(models / "WideLanguages/SharedAcoustic/capabilities.json")
        supported = capabilities.get("languages", []) if isinstance(capabilities, dict) else []
        if code not in supported:
            missing.append("SharedAcoustic/capabilities.json:language=" + code)
    present = registered and not missing
    settings_label = entry.get("display_name_uk", entry["name_uk"])
    readiness = {}
    if isinstance(info, dict) and info.get("backend") in {"mms-onnx", "mms-vits", "extra-onnx", "omni-onnx", "rasa-onnx", "afri-six-onnx"}:
        names_ready = bool(capabilities and capabilities.get("character_names"))
        readiness = {"character_names_ready": names_ready, "number_normalization_ready": bool(capabilities and capabilities.get("number_normalization"))}
        if info["backend"] == "omni-onnx":
            settings_label += " (експериментально, повільне читання; лише текст)"
            if info.get("_backend_selection") == "explicit-same-language-fallback":
                settings_label += " (резервний рушій цієї мови)"
            readiness["interactive_reading_ready"] = False
        elif info["backend"] == "afri-six-onnx":
            settings_label += " (експериментально; назви символів і введення не перевірені)"
            readiness.update(keyboard_echo_verified=False, interactive_reading_ready=False)
        elif info.get("family") == "matcha":
            settings_label += " (експериментально; для окремих літер потрібен резервний пакет)"
            readiness.update(native_orthography_partial=True, keyboard_echo_verified=False)
        elif info["backend"] == "rasa-onnx":
            settings_label += " (експериментально; назви літер не перевірені)"
            readiness["keyboard_echo_verified"] = False
        elif not names_ready:
            settings_label += " (лише текст; назви символів не перевірені)"
    return {**entry, "runtime_code": code, "registered": registered,
            "backend": backend, "resources_present": present,
            "status": ("partial-variant-resources-present-unverified" if entry.get("partial_variant") else "resources-present-unverified")
                      if present else "missing-resources" if registered else "not-registered",
            "missing_resources": missing,
            "settings_label_uk": settings_label, **readiness,
            **({"backend_selection": info.get("_backend_selection"), "selected_backend": info.get("backend"),
                "preferred_backend": info.get("_preferred_backend"), "selection_reason": info.get("_selection_reason"),
                "preferred_missing_resources": info.get("_preferred_missing_resources", []),
                "fallback_missing_resources": info.get("_fallback_missing_resources", [])}
               if isinstance(info, dict) and info.get("_backend_selection") else {}),
            **({"capabilities": capabilities} if capabilities is not None else {}),
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
        selected = {_entry_code(row) for row in entries}
        entries += [{"id": code, "name_uk": info.get("name", code), "regions": [], "first_priority_region": None}
                    for code, info in registry.items() if code not in selected]
    return [_availability(entry, models, registry) for entry in entries]


def language_status(models, language):
    """Check one selected language; useful when preparing a compatibility map."""
    models = _models(models)
    code = canonical_code(language)
    entry = next((row for row in _selected() if _entry_code(row) == code or canonical_code(row["id"]) == code), None)
    return _availability(entry, models, _registry(models)) if entry is not None else None


def installed_languages(models=None, selected_only=True):
    """Labels for settings: installed selected resources, not promised catalog items."""
    return OrderedDict((row["runtime_code"], row["settings_label_uk"]) for row in coverage(models, selected_only)
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
