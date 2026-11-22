"""Verify release hashes, exact archive inventory, voice exclusion and size limits.

This verifies packaging, not Windows DLL loading, pronunciation or NVDA behavior.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import zipfile

from build_release import EXCLUDED, PACK_MANIFEST, RELEASE_MANIFEST, excluded_path


def verify_archive(path, max_core_bytes=3_000_000_000):
    path = Path(path)
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(infos) > 20001 or sum(info.file_size for info in infos) > 5 * 1024**3:
            raise ValueError("Archive exceeds verification limits")
        for info in infos:
            name = info.filename
            if info.orig_filename != name or "\\" in info.orig_filename or "\x00" in info.orig_filename:
                raise ValueError("Noncanonical raw archive member: " + info.orig_filename)
            relative = PurePosixPath(name)
            if (relative.is_absolute() or ".." in relative.parts or str(relative) != name
                    or "\\" in name or ":" in name or any(ord(c) < 32 for c in name)
                    or info.is_dir() or stat.S_IFMT(info.external_attr >> 16) not in (0, stat.S_IFREG)
                    or info.flag_bits & 1):
                raise ValueError("Unsafe archive member: " + name)
        folded = [x.casefold() for x in names]
        if len(folded) != len(set(folded)):
            raise ValueError("Duplicate Windows archive paths")
        manifest_name = RELEASE_MANIFEST if RELEASE_MANIFEST in names else PACK_MANIFEST
        if archive.getinfo(manifest_name).file_size > 8 * 1024 * 1024:
            raise ValueError("Manifest exceeds verification limits")
        metadata = json.loads(archive.read(manifest_name))
        expected_format = "dordiai-core-release" if manifest_name == RELEASE_MANIFEST else "dordiai-resource-pack"
        if metadata.get("format") != expected_format or type(metadata.get("format_version")) is not int or metadata["format_version"] != 1:
            raise ValueError("Unsupported release format")
        files = metadata["files"]
        if set(files) | {manifest_name} != set(names):
            raise ValueError("Archive inventory differs from its manifest")
        for name, record in files.items():
            if excluded_path(name):
                raise ValueError("Excluded voice resource: " + name)
            info = archive.getinfo(name)
            if (not isinstance(record, dict) or type(record.get("size_bytes")) is not int
                    or not re.fullmatch(r"[0-9a-f]{64}", str(record.get("sha256", "")))):
                raise ValueError("Invalid member metadata: " + name)
            if info.file_size != record["size_bytes"]:
                raise ValueError("Unexpected member size: " + name)
            digest = hashlib.sha256()
            with archive.open(info) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != record["sha256"]:
                raise ValueError("Unexpected member checksum: " + name)
        voice_count = None
        if manifest_name == RELEASE_MANIFEST:
            if path.stat().st_size > max_core_bytes:
                raise ValueError("Core download exceeds maximum size")
            catalogue = json.loads(archive.read("kx47Runtime/models/voices/catalog.json"))
            if set(catalogue) & EXCLUDED or set(catalogue) != set(metadata["voice_ids"]):
                raise ValueError("Core voice catalogue differs from manifest")
            voice_count = len(catalogue)
        return {"filename": path.name, "verified_files": len(files),
                "installed_bytes": sum(record["size_bytes"] for record in files.values()),
                "download_bytes": path.stat().st_size, "voice_count": voice_count,
                "windows_nvda_validation": "not_performed_by_packaging_verifier"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archives", type=Path, nargs="+")
    args = parser.parse_args()
    for path in args.archives:
        print(json.dumps(verify_archive(path), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
