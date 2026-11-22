"""Inspect recovered code and resources without NVDA or Windows dependencies."""
from __future__ import annotations

import ast
from collections import Counter
import gzip
import json
import math
from pathlib import Path
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]


def vector(path):
    """Validate the actual NPY float32 speaker data using the standard library."""
    with path.open("rb") as stream:
        if stream.read(6) != b"\x93NUMPY":
            raise ValueError(f"Invalid NPY magic: {path}")
        version = tuple(stream.read(2))
        if version == (1, 0):
            size = struct.unpack("<H", stream.read(2))[0]
        elif version in ((2, 0), (3, 0)):
            size = struct.unpack("<I", stream.read(4))[0]
        else:
            raise ValueError(f"Unsupported NPY version: {version}")
        header = ast.literal_eval(stream.read(size).decode("utf-8"))
        if header["shape"] != (1, 256, 1) or header["descr"] != "<f4":
            raise ValueError(f"Unexpected speaker vector header: {path}: {header}")
        payload = stream.read()
        if len(payload) != 256 * 4 or not all(math.isfinite(v) for v, in struct.iter_unpack("<f", payload)):
            raise ValueError(f"Invalid speaker vector values: {path}")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def check():
    summary = {"platform_scope": "Linux; static code/data checks only; no Windows/NVDA speech execution", "packages": {}}
    for label, runtime in (("0.12.2", "kx47Runtime"), ("unified-0.3.10", "dordiaiUnifiedRuntime")):
        package = ROOT / "packages" / label
        folder = package / runtime
        if not folder.is_dir():
            raise FileNotFoundError(f"Restore the binary baseline first: {package}")
        sources = sorted([*folder.glob("*.py"), *package.glob("*.py"),
                          *(package / "synthDrivers").glob("*.py"),
                          *(package / "globalPlugins").glob("*.py")])
        for path in sources:
            ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
        json_files = [p for p in package.rglob("*.json")
                      if "python" not in p.relative_to(package).parts and "radeon_runtime" not in p.parts]
        for path in json_files:
            read_json(path)
        result = {"own_python_files_syntax_passed": len(sources), "json_files_parsed": len(json_files)}
        if label == "0.12.2":
            registry = read_json(folder / "wide_voice_index.json")
            voices = read_json(folder / "models/voices/catalog.json")
            core = ("uk", "ru", "en", "sk", "pl", "de", "fr", "da", "it", "es")
            for code, row in registry.items():
                vector(folder / "models/WideLanguages" / row["source"])
            for code in voices:
                vector(folder / "models/voices/classmate_locales" / (code + ".npy"))
            routes = Counter("shared_neural" if row.get("natural") == "shared"
                             else row.get("backend", "espeak_with_voice_conversion") for row in registry.values())
            if len(registry) != 111 or len(voices) != 53 or set(registry) & set(core):
                raise ValueError("Main package registry does not match the recovered baseline.")
            expected = ["OpenVoiceV2/encoder-flow.onnx", "OpenVoiceV2/decoder.onnx", "Holos/encoder.onnx",
                        "Holos/decoder_window.onnx", "PocketTTS/ru/model_fast.safetensors",
                        "WideLanguages/espeak.dll", "WideLanguages/wide-lid.dll", "WideLanguages/lid.176.ftz",
                        "WideLanguages/Breton/model.onnx", "WideLanguages/Hebrew/noa.onnx",
                        "WideLanguages/wide_extra/gl/model-q8.onnx", "WideLanguages/SharedAcoustic/onnx/vocoder.onnx"]
            for resource in expected:
                if not (folder / "models" / resource).is_file():
                    raise FileNotFoundError(resource)
            result.update(language_variants=121, core_languages=list(core), additional_languages=111,
                          voice_profiles=53, validated_source_vectors=111, validated_target_vectors=53,
                          additional_language_routes=dict(routes),
                          optional_personal_language_pack_included=False)
        else:
            registry = read_json(folder / "models/voices/catalog.json")
            if len(registry["voices"]) != 3 or len(registry["languages"]) != 10:
                raise ValueError("Unified package registry does not match the recovered baseline.")
            for row in registry["voices"].values():
                vector(folder / "models/voices" / row["target"])
            for row in registry["languages"].values():
                if row["backend"] != "supertonic":
                    raise ValueError("Unexpected unified acoustic route.")
                vector(folder / "models/voices" / row["source"])
                model = folder / "models" / row["model"] / "onnx" / row["vector_model"]
                if not model.is_file() and not model.with_suffix(".ort").is_file():
                    raise FileNotFoundError(model)
            result.update(language_variants=10, languages=list(registry["languages"]), voice_profiles=3,
                          validated_target_vectors=3, acoustic_backend="Supertonic3 + OpenVoice")
        summary["packages"][label] = result
    return summary


if __name__ == "__main__":
    data = check()
    output = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if "--save" in sys.argv:
        evidence = ROOT / "evidence"
        evidence.mkdir(exist_ok=True)
        (evidence / "summary.json").write_text(output, encoding="utf-8")
    print(output, end="")
