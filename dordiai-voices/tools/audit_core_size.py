"""Read an existing core manifest/ZIP directory to measure disk costs without loading models."""
import argparse
from collections import defaultdict
import json
from pathlib import Path, PurePosixPath
import zipfile


def audit_core(path):
    path = Path(path)
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("dordiai-release.json"))
        files = manifest["files"]
        members = {row.filename: row for row in archive.infolist()}
        voices = set(manifest["voice_ids"])
        duplicates = defaultdict(list)
        categories = defaultdict(lambda: {"installed_payload_bytes": 0, "compressed_member_bytes": 0, "files": 0})
        per_voice = {voice: {"installed_payload_bytes": 0, "compressed_member_bytes": 0, "files": 0} for voice in sorted(voices)}
        branches = defaultdict(lambda: {"installed_payload_bytes": 0, "compressed_member_bytes": 0, "files": 0})
        for name, record in files.items():
            parts = PurePosixPath(name).parts
            size, zipped = record["size_bytes"], members[name].compress_size
            duplicates[(record["sha256"], size)].append(name)
            if name.startswith("kx47Runtime/models/voices/"):
                category = "voice_profiles_and_prepared_audio"
                branch = "/".join(parts[:4])
            elif name.startswith("kx47Runtime/models/"):
                category = "shared_models_and_language_data"
                branch = "/".join(parts[:4])
            elif name.startswith("kx47Runtime/python/"):
                category = "embedded_python_and_native_libraries"
                branch = "kx47Runtime/python"
            else:
                category = "code_dictionaries_documents_other"
                branch = "/".join(parts[:2])
            for target in (categories[category], branches[branch]):
                target["installed_payload_bytes"] += size
                target["compressed_member_bytes"] += zipped
                target["files"] += 1
            matched = voices.intersection(parts) | ({PurePosixPath(name).stem} & voices)
            if len(matched) > 1:
                raise ValueError("Ambiguous voice ownership: " + name)
            if matched:
                target = per_voice[matched.pop()]
                target["installed_payload_bytes"] += size
                target["compressed_member_bytes"] += zipped
                target["files"] += 1
        duplicate_groups = []
        for (sha, size), names in duplicates.items():
            if len(names) > 1 and size:
                duplicate_groups.append({"sha256": sha, "size_bytes": size, "copies": len(names),
                    "redundant_payload_bytes": size * (len(names) - 1),
                    "redundant_compressed_member_bytes": sum(members[n].compress_size for n in names) - min(members[n].compress_size for n in names),
                    "paths": names})
        duplicate_groups.sort(key=lambda item: item["redundant_payload_bytes"], reverse=True)
        installed = sum(row["size_bytes"] for row in files.values())
        duplicate_bytes = sum(row["redundant_payload_bytes"] for row in duplicate_groups)
        graph_alternatives = []
        for name in files:
            if name.endswith(".onnx") and name[:-5] + ".ort" in files:
                graph_alternatives.append({"onnx": name, "ort": name[:-5] + ".ort",
                    "onnx_payload_bytes": files[name]["size_bytes"], "onnx_compressed_member_bytes": members[name].compress_size,
                    "exact_byte_duplicates": files[name]["sha256"] == files[name[:-5] + ".ort"]["sha256"]})
        return {"format": "dordiai-core-size-audit", "format_version": 1, "archive": path.name,
            "download_bytes": path.stat().st_size, "installed_payload_bytes": installed,
            "installed_payload_excludes_release_manifest_and_filesystem_allocation": True,
            "voice_profile_count": len(voices), "ram_bytes": None, "ram_not_inferred_from_disk_size": True,
            "method": "Existing verified per-file SHA256 and ZIP compressed-size metadata; no acoustic weights loaded or modified.",
            "categories": dict(categories), "branches": dict(sorted(branches.items(), key=lambda item: item[1]["installed_payload_bytes"], reverse=True)),
            "per_voice_owned_paths": per_voice,
            "shared_voice_data_bytes": categories["voice_profiles_and_prepared_audio"]["installed_payload_bytes"] - sum(row["installed_payload_bytes"] for row in per_voice.values()),
            "exact_duplicate_groups": len(duplicate_groups), "redundant_payload_bytes": duplicate_bytes,
            "redundant_payload_fraction": duplicate_bytes / installed,
            "redundant_compressed_member_bytes": sum(row["redundant_compressed_member_bytes"] for row in duplicate_groups),
            "largest_duplicate_groups": duplicate_groups[:20], "duplicate_detail_limit": 20, "graph_format_alternatives": graph_alternatives,
            "decisions": ["No core or runtime file changed by audit.",
                "Exact duplicates require preserving every referenced path or adding a tested content-addressed resolver; direct deletion is unsafe.",
                "ONNX/ORT alternatives are not identical weights; current English loader tries ORT and falls back to ONNX, so dropping a format needs actual Windows compatibility proof.",
                "Prepared voice banks trade disk space for fast keyboard/navigation playback; do not remove them to claim an unmeasured latency improvement.",
                "Measure process working set and peak separately on Windows; ZIP or installed bytes do not establish RAM usage."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = audit_core(args.archive)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in ("download_bytes", "installed_payload_bytes", "voice_profile_count", "redundant_payload_bytes", "redundant_compressed_member_bytes")}))


if __name__ == "__main__":
    main()
