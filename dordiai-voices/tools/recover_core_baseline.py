"""Recover a minimal build baseline from a verified generated core addon.

No original Drive archive is required. Only core payloads are recovered; old
optional Piper/Wide/Slovak packages cannot be recreated from absent resources.
All archive hashes and metadata are verified before extraction. Archived Python,
DLLs and executables are copied as data and are never imported or executed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import zipfile

RELEASE_MANIFEST = "dordiai-release.json"
PACK_MANIFEST = "dordiai-resource-pack.json"
MAX_ARCHIVE_BYTES = 3_000_000_000
MAX_PAYLOAD_BYTES = 5 * 1024**3
MAX_FILES = 20000
BLOCK_BYTES = 4 * 1024 * 1024
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_DEVICES = {"CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"} | {
    prefix + suffix for prefix in ("COM", "LPT") for suffix in "123456789¹²³"}


def _safe_name(name):
    if not isinstance(name, str) or not name or any(ord(c) < 32 or c in '\\:<>"|?*' for c in name):
        raise ValueError("Unsafe core archive path")
    relative = PurePosixPath(name)
    if relative.is_absolute() or str(relative) != name or any(
            part in ("", ".", "..") or part.endswith((".", " "))
            or part.split(".", 1)[0].rstrip(" .").upper() in _DEVICES for part in name.split("/")):
        raise ValueError("Unsafe core archive path: " + name)
    return name


def _fingerprint(stream):
    record = os.fstat(stream.fileno())
    return record.st_size, record.st_mtime_ns, record.st_ctime_ns


def _stream_hash(stream):
    result = hashlib.sha256()
    for data in iter(lambda: stream.read(BLOCK_BYTES), b""):
        result.update(data)
    return result.hexdigest()


def _verify_core(archive):
    members = archive.infolist()
    if not 1 < len(members) <= MAX_FILES + 1 or sum(m.file_size for m in members) > MAX_PAYLOAD_BYTES:
        raise ValueError("Core archive exceeds recovery limits")
    names, lookup = set(), {}
    for member in members:
        name = _safe_name(member.orig_filename)
        if (name != member.filename or name.casefold() in names or member.is_dir()
                or member.flag_bits & 1 or member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                or stat.S_IFMT(member.external_attr >> 16) not in (0, stat.S_IFREG)):
            raise ValueError("Unsafe, duplicate or nonregular core archive member: " + name)
        names.add(name.casefold())
        lookup[name] = member
    for name in lookup:
        for parent in PurePosixPath(name).parents:
            if parent != PurePosixPath(".") and parent.as_posix().casefold() in names:
                raise ValueError("Archive file also used as a directory")
    if RELEASE_MANIFEST not in lookup or lookup[RELEASE_MANIFEST].file_size > 8 * 1024 * 1024:
        raise ValueError("Missing or oversized generated core manifest")
    metadata = json.loads(archive.read(RELEASE_MANIFEST))
    if (metadata.get("format") != "dordiai-core-release" or type(metadata.get("format_version")) is not int
            or metadata["format_version"] != 1 or not isinstance(metadata.get("version"), str)
            or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", metadata["version"])):
        raise ValueError("Unsupported generated core manifest")
    files = metadata.get("files")
    if not isinstance(files, dict) or not files or set(files) | {RELEASE_MANIFEST} != set(lookup):
        raise ValueError("Core payload inventory differs from manifest")
    if RELEASE_MANIFEST in files or PACK_MANIFEST in files:
        raise ValueError("Generated release/package manifests cannot be baseline payloads")
    for name, record in files.items():
        if (not isinstance(record, dict) or type(record.get("size_bytes")) is not int or record["size_bytes"] < 0
                or not isinstance(record.get("sha256"), str) or not _SHA.fullmatch(record["sha256"])
                or lookup[name].file_size != record["size_bytes"]):
            raise ValueError("Invalid core payload metadata: " + name)
        with archive.open(lookup[name]) as stream:
            if _stream_hash(stream) != record["sha256"]:
                raise ValueError("Core payload checksum differs: " + name)
    # No fixed original voice count: a legitimate later core can contain a
    # different number of profiles. Its two actual catalogues must agree.
    catalogue_path = "kx47Runtime/models/voices/catalog.json"
    if "manifest.ini" not in files or catalogue_path not in files or lookup[catalogue_path].file_size > 1024 * 1024:
        raise ValueError("Required addon manifest or voice catalogue is missing")
    catalogue = json.loads(archive.read(catalogue_path))
    voices = metadata.get("voice_ids")
    if (not isinstance(voices, list) or not voices or any(not isinstance(v, str) or not v for v in voices)
            or len(voices) != len(set(voices)) or not isinstance(catalogue, dict) or set(catalogue) != set(voices)
            or any(not isinstance(v, str) for v in catalogue.values())):
        raise ValueError("Core voice catalogues differ")
    excluded = metadata.get("excluded_voice_ids", [])
    if not isinstance(excluded, list) or any(not isinstance(v, str) for v in excluded) or set(voices) & set(excluded):
        raise ValueError("Excluded voices occur in core catalogue")
    if lookup["manifest.ini"].file_size > 1024 * 1024:
        raise ValueError("Addon manifest exceeds recovery limit")
    version = re.search(r'^version\s*=\s*"([^"\r\n]+)"\s*$', archive.read("manifest.ini").decode("utf-8-sig"), re.MULTILINE)
    if not version or version.group(1) != metadata["version"]:
        raise ValueError("Addon version differs from generated release metadata")
    return metadata, lookup


def recover(archive_path, output, *, expected_sha256):
    archive_path, output = Path(archive_path), Path(output)
    if not isinstance(expected_sha256, str) or not _SHA.fullmatch(expected_sha256):
        raise ValueError("Provide the trusted SHA256 from the saved release/backup manifest")
    if archive_path.is_symlink() or not archive_path.is_file() or archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Core source must be a regular archive within the size limit")
    if output.exists() or output.is_symlink():
        raise FileExistsError("Recovery output already exists; choose a new directory")
    stage, published = None, False
    try:
        with archive_path.open("rb") as original:
            before = _fingerprint(original)
            if _stream_hash(original) != expected_sha256:
                raise ValueError("Core archive differs from the trusted SHA256")
            with zipfile.ZipFile(original) as archive:
                metadata, members = _verify_core(archive)
                # Extraction starts only after every metadata/hash check passed.
                output.parent.mkdir(parents=True, exist_ok=True)
                required = sum(record["size_bytes"] for record in metadata["files"].values())
                if shutil.disk_usage(output.parent).free < required:
                    raise OSError("Not enough free space for the recovered core baseline")
                stage = Path(tempfile.mkdtemp(prefix=".dordiai-core-baseline-", dir=output.parent))
                for name, record in metadata["files"].items():
                    destination = stage / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    digest, size = hashlib.sha256(), 0
                    with archive.open(members[name]) as source, destination.open("xb") as target:
                        for data in iter(lambda: source.read(BLOCK_BYTES), b""):
                            target.write(data)
                            digest.update(data)
                            size += len(data)
                    if size != record["size_bytes"] or digest.hexdigest() != record["sha256"]:
                        raise ValueError("Core changed during recovery: " + name)
                if _fingerprint(original) != before:
                    raise ValueError("Core archive changed during recovery")
        if output.exists() or output.is_symlink():
            raise FileExistsError("Recovery output appeared during verification")
        os.rename(stage, output)
        published = True
        return {"format": "dordiai-recovered-core-baseline", "format_version": 1,
            "baseline": str(output), "core_version": metadata["version"], "source_archive_sha256": expected_sha256,
            "payload_files": len(metadata["files"]), "payload_bytes": sum(r["size_bytes"] for r in metadata["files"].values()),
            "voice_count": len(metadata["voice_ids"]), "generated_release_manifest_excluded": True,
            "all_payload_hashes_verified_before_extraction": True, "archived_code_executed": False,
            "scope": "Core resources only; omitted optional Piper/Wide/Slovak bundles require their own saved ZIPs."}
    finally:
        if not published and stage is not None:
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    result = recover(args.archive, args.output, expected_sha256=args.expected_sha256)
    if args.evidence:
        args.evidence.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
