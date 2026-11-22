"""Build deterministic NVDA core and optional resource archives from baseline + source.

The original packages/0.12.2 tree is read only. Updated text/code in source/
overlays the baseline. Core and optional payloads are disjoint, so installing a
resource pack never needs to replace core files. This does not certify speech.
"""
from __future__ import annotations

import argparse
from contextlib import nullcontext
from dataclasses import dataclass
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.13.1-dev.13"
RELEASE_MANIFEST = "dordiai-release.json"
PACK_MANIFEST = "dordiai-resource-pack.json"
EXCLUDED = frozenset({"kostia", "inna", "dina", "vira", "innesa", "veronika_classmate", "anatolii", "veronika"})
PACKS = {
    "european-piper": {"name": "Європейські моделі Piper", "engine_ids": ["piper"],
                       "languages": ["pl", "de", "fr", "da", "it", "es"], "dependencies": []},
    "slovak-rhvoice": {"name": "Словацький рушій RHVoice", "engine_ids": ["rhvoice"],
                       "languages": ["sk"], "dependencies": []},
    "wide-languages": {"name": "Додаткові мовні ресурси", "engine_ids": ["espeak", "shared-acoustic", "hebrew-vits"],
                       "languages": [], "dependencies": []},
}


@dataclass(frozen=True)
class InputFile:
    path: str
    source: Path
    group: str
    transformed: bytes | None = None


def excluded_path(name):
    """Match exact voice directory/file identifiers, not human-name substrings."""
    return any(part.casefold() in EXCLUDED or PurePosixPath(part).stem.casefold() in EXCLUDED
               for part in PurePosixPath(name).parts)


def _excluded_reference(value):
    return isinstance(value, str) and (value.casefold() in EXCLUDED or excluded_path(value.replace("\\", "/")))


def remove_excluded_metadata(value):
    if isinstance(value, dict):
        return {key: remove_excluded_metadata(item) for key, item in value.items()
                if not _excluded_reference(key) and not _excluded_reference(item)}
    if isinstance(value, list):
        return [remove_excluded_metadata(item) for item in value if not _excluded_reference(item)]
    return value


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def group_for_path(name):
    path = PurePosixPath(name)
    parts = path.parts
    # The Hebrew niqqud adapter is Python code stored alongside baseline models.
    # Ship reviewed adapter code in the core; data packs cannot introduce code.
    if path.suffix.lower() in {".py", ".pth", ".bat", ".cmd", ".ps1"}:
        return "core"
    if parts[:3] == ("kx47Runtime", "models", "WideLanguages"):
        return "wide-languages"
    if parts[:3] == ("kx47Runtime", "models", "Slovak"):
        return "slovak-rhvoice"
    if parts[:3] == ("kx47Runtime", "models", "Piper"):
        if path.name.startswith("en_") or path.name == "MODEL_CARD":
            return "core"
        return "european-piper"
    return "core"


def _source_files(directory):
    if not directory.is_dir():
        raise ValueError("Input directory missing: " + str(directory))
    result = {}
    for source in sorted(directory.rglob("*")):
        if source.is_symlink():
            raise ValueError("Symlink in release input: " + str(source))
        if not source.is_file():
            continue
        relative = source.relative_to(directory)
        if "__pycache__" in relative.parts or source.suffix in {".pyc", ".pyo"}:
            continue
        name = relative.as_posix()
        if "\\" in name or ":" in name:
            raise ValueError("Invalid release input path: " + name)
        result[name] = source
    return result


STRESS_VENDOR_PATH = "kx47Runtime/python/Lib/site-packages/stressonnx/download.py"
STRESS_VENDOR_REFERENCE = Path(__file__).resolve().parent / "vendor/stressonnx-download-original.txt"


def patch_stress_cache(data):
    """Normalize only the audited offline vendor resolver, never unknown code.

    The full reference pins source text (BOM/CRLF normalization is explicit).
    The original archive and all model weights remain read only.
    """
    original = STRESS_VENDOR_REFERENCE.read_text(encoding="utf-8").replace("\r\n", "\n")
    before = "local = os.path.join(cache_dir, hf_subdir, fname)"
    after = "local = os.path.normpath(os.path.join(cache_dir, hf_subdir, fname))"
    if original.count(before) != 1:
        raise ValueError("Invalid pinned stressonnx compatibility reference")
    patched = original.replace(before, after)
    actual = data.decode("utf-8-sig").replace("\r\n", "\n")
    if actual not in (original, patched):
        raise ValueError("Unknown stressonnx source; compatibility patch aborted")
    return patched.encode("utf-8")


def collect_inputs(baseline, source, version=VERSION):
    files = _source_files(Path(baseline))
    files.update(_source_files(Path(source)))
    # Adapter code moved to core must retain its supplied attribution/license,
    # even if the optional model archive is never installed.
    for filename in ("renikud-code-license.txt", "NOTICE.txt"):
        original = files.get("kx47Runtime/models/WideLanguages/Hebrew/" + filename)
        if original is not None:
            files.setdefault("doc/third-party/Hebrew/" + filename, original)
    if STRESS_VENDOR_PATH in files:
        files.setdefault("doc/third-party/stressonnx/dordiai-compatibility.txt",
                         Path(__file__).resolve().parent / "vendor/NOTICE-stressonnx.txt")
    voice_catalogue = files.get("kx47Runtime/models/voices/catalog.json")
    voice_count = len(remove_excluded_metadata(json.loads(voice_catalogue.read_bytes()))) if voice_catalogue else 0
    result, excluded = [], []
    casefold = set()
    for name, path in sorted(files.items()):
        if name.casefold() in casefold:
            raise ValueError("Windows path collision: " + name)
        casefold.add(name.casefold())
        if excluded_path(name):
            excluded.append(name)
            continue
        content = patch_stress_cache(path.read_bytes()) if name == STRESS_VENDOR_PATH else None
        if path.suffix == ".json" and (name.startswith("kx47Runtime/models/voices/")
                                      or name == "kx47Runtime/models/english_voice_profiles.json"
                                      or name.startswith("kx47Runtime/models/WideLanguages/navigation/")):
            content = json_bytes(remove_excluded_metadata(json.loads(path.read_bytes())))
        if name == "manifest.ini":
            text = path.read_text(encoding="utf-8-sig")
            text, count = re.subn(r'^version\s*=.*$', 'version = "' + version + '"', text, count=1, flags=re.MULTILINE)
            if count != 1:
                raise ValueError("No addon version in manifest.ini")
            text = re.sub(r'^description\s*=.*$',
                          f'description = "Модульний локальний синтезатор NVDA. {voice_count} дозволених голосових профілів. Додаткові мовні пакети встановлюються окремо."',
                          text, count=1, flags=re.MULTILINE)
            content = text.replace("\r\n", "\n").encode("utf-8")
        result.append(InputFile(name, path, group_for_path(name), content))
    return result, excluded


def _info(name, compression=zipfile.ZIP_DEFLATED):
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = compression
    info._compresslevel = 3
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def write_payload(archive, item):
    digest = hashlib.sha256()
    amount = 0
    with archive.open(_info(item.path), "w", force_zip64=True) as output:
        if item.transformed is not None:
            chunks = (item.transformed,)
            source = None
        else:
            source = item.source.open("rb")
            chunks = iter(lambda: source.read(1024 * 1024), b"")
        try:
            for chunk in chunks:
                digest.update(chunk)
                amount += len(chunk)
                output.write(chunk)
        finally:
            if source is not None:
                source.close()
    return {"size_bytes": amount, "sha256": digest.hexdigest()}


def build_archive(path, files, metadata, manifest_name):
    path = Path(path)
    temporary = path.with_name(path.name + ".part")
    records = {}
    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as archive:
            for i, item in enumerate(files, 1):
                records[item.path] = write_payload(archive, item)
                if i % 1000 == 0:
                    print(f"{path.name}: {i}/{len(files)} files", flush=True)
            manifest = dict(metadata, files=records)
            archive.writestr(_info(manifest_name), json_bytes(manifest))
        temporary.replace(path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return {"filename": path.name, "size_bytes": path.stat().st_size, "sha256": digest.hexdigest(),
            "payload_files": len(records), "installed_bytes": sum(x["size_bytes"] for x in records.values())}


def build_release(baseline, source, output, version=VERSION, only=None, max_core_bytes=3_000_000_000,
                  prepared_bank_overlay=None):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    files, excluded = collect_inputs(baseline, source, version)
    if prepared_bank_overlay is None:
        overlay_context = nullcontext((files, None))
    else:
        from prepared_bank_overlay import apply_to_inputs
        overlay_context = apply_to_inputs(files, Path(prepared_bank_overlay), InputFile)
    with overlay_context as (files, overlay_summary):
        groups = {name: [item for item in files if item.group == name] for name in ["core", *PACKS]}
        catalogue_path = "kx47Runtime/models/voices/catalog.json"
        catalogue = next((item for item in files if item.path == catalogue_path), None)
        voice_ids = []
        if catalogue is not None:
            voice_ids = sorted(json.loads(catalogue.transformed or catalogue.source.read_bytes()))
            if set(voice_ids) & EXCLUDED:
                raise ValueError("Excluded voice in release catalogue")
        vendor_patches = [{"path": item.path,
                           "input_sha256": hashlib.sha256(item.source.read_bytes()).hexdigest(),
                           "output_sha256": hashlib.sha256(item.transformed).hexdigest(),
                           "reason": "Normalize Windows extended-path separators; retain offline model lookup"}
                          for item in files if item.path == STRESS_VENDOR_PATH and item.transformed is not None]
        report = {"format": "dordiai-release-build", "format_version": 1, "version": version,
                  "baseline": "0.12.2", "voice_ids": voice_ids, "voice_count": len(voice_ids),
                  "excluded_voice_ids": sorted(EXCLUDED), "excluded_input_files": excluded,
                  "windows_nvda_validation": "not_performed_by_builder", "compatibility_patches": vendor_patches, "artifacts": []}
        if overlay_summary is not None:
            report["prepared_bank_overlay"] = overlay_summary
        for group, payload in groups.items():
            if only and group not in only:
                continue
            if not payload:
                continue
            if group == "core":
                filename = f"dordiai-voices-{version}.nvda-addon"
                metadata = {"format": "dordiai-core-release", "format_version": 1, "version": version,
                            "voice_ids": voice_ids, "excluded_voice_ids": sorted(EXCLUDED),
                            "initial_languages": ["uk", "en", "ru"], "compatibility_patches": vendor_patches,
                            "windows_nvda_validation": "not_performed_by_builder"}
                if overlay_summary is not None:
                    metadata["prepared_bank_overlay"] = overlay_summary
                manifest = RELEASE_MANIFEST
            else:
                filename = f"dordiai-{group}-{version}.zip"
                metadata = dict(PACKS[group], format="dordiai-resource-pack", format_version=1,
                                id=group, version=version, minimum_core_version=version)
                manifest = PACK_MANIFEST
            print(f"Building {group}: {len(payload)} files, {sum(len(x.transformed) if x.transformed is not None else x.source.stat().st_size for x in payload):,} bytes", flush=True)
            record = build_archive(output / filename, payload, metadata, manifest)
            record["group"] = group
            report["artifacts"].append(record)
            if group == "core" and record["size_bytes"] > max_core_bytes:
                raise ValueError(f"Core archive exceeds {max_core_bytes:,} bytes; do not claim ready")
            print(f"Built {filename}: {record['size_bytes']:,} bytes", flush=True)
        (output / "release-build.json").write_bytes(json_bytes(report))
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=ROOT / "packages/0.12.2")
    parser.add_argument("--source", type=Path, default=ROOT / "source/0.12.2")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    parser.add_argument("--version", default=VERSION)
    parser.add_argument("--only", choices=["core", *PACKS], action="append")
    parser.add_argument("--prepared-bank-overlay", type=Path,
                        help="Optional validated append-only prepared letter/command bank ZIP")
    args = parser.parse_args()
    build_release(args.baseline, args.source, args.output, args.version, args.only,
                  prepared_bank_overlay=args.prepared_bank_overlay)


if __name__ == "__main__":
    main()
