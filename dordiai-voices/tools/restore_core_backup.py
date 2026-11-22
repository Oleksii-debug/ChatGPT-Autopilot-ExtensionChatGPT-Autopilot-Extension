"""Restore a core addon from four data-only backup ZIPs; no third-party modules.

These ZIPs are backup parts, not NVDA installers. Run --verify-only to check
all ZIP/chunk hashes and reconstruct the original SHA256 without a duplicate
full-size output. Restoration publishes the verified file atomically and will
never overwrite an existing file with different contents.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import zipfile

FORMAT = "dordiai-core-backup"
BLOCK_BYTES = 4 * 1024 * 1024
MAX_CHUNK_BYTES = 450_000_000
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_SAFE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")


def _basename(value):
    if (not isinstance(value, str) or not _SAFE.fullmatch(value) or value.endswith((".", " "))
            or value.split(".", 1)[0].upper() in {"CON", "PRN", "AUX", "NUL", *('COM'+str(i) for i in range(1, 10)), *('LPT'+str(i) for i in range(1, 10))}):
        raise ValueError("Unsafe backup filename")
    return value


def _sha(value):
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        raise ValueError("Invalid SHA256 in backup manifest")
    return value


def _size(value, maximum=None):
    if type(value) is not int or value <= 0 or maximum is not None and value > maximum:
        raise ValueError("Invalid size in backup manifest")
    return value


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for data in iter(lambda: stream.read(BLOCK_BYTES), b""):
            digest.update(data)
    return digest.hexdigest()


def load_manifest(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ValueError("Manifest must be a regular file no larger than 1MB")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("format") != FORMAT or type(manifest.get("format_version")) is not int or manifest["format_version"] != 1:
        raise ValueError("Unsupported backup manifest")
    _basename(manifest["source_filename"])
    _size(manifest["source_size_bytes"])
    _sha(manifest["source_sha256"])
    chunks = manifest.get("chunks")
    if not isinstance(chunks, list) or len(chunks) != 4:
        raise ValueError("Exactly four ordered backup chunks are required")
    offset, seen = 0, set()
    for index, chunk in enumerate(chunks, 1):
        if (type(chunk.get("index")) is not int or chunk["index"] != index
                or type(chunk.get("offset_bytes")) is not int or chunk["offset_bytes"] != offset):
            raise ValueError("Backup chunk order or offsets are invalid")
        for field in ("zip_filename", "member_name"):
            value = _basename(chunk[field])
            if value.casefold() in seen:
                raise ValueError("Duplicate backup filenames")
            seen.add(value.casefold())
        if not chunk["zip_filename"].endswith(".zip") or not chunk["member_name"].endswith(".bin"):
            raise ValueError("Unexpected backup ZIP/member extension")
        _sha(chunk["zip_sha256"])
        _sha(chunk["raw_sha256"])
        _size(chunk["zip_size_bytes"], MAX_CHUNK_BYTES)
        offset += _size(chunk["raw_size_bytes"], MAX_CHUNK_BYTES)
    if offset != manifest["source_size_bytes"]:
        raise ValueError("Backup chunks do not match the original size")
    return manifest


def _existing_output(output, manifest):
    if output.is_symlink():
        raise FileExistsError("Restore destination is a symbolic link")
    if not output.exists():
        return False
    if not output.is_file() or output.stat().st_size != manifest["source_size_bytes"] or file_sha256(output) != manifest["source_sha256"]:
        raise FileExistsError("Restore destination already exists with different contents")
    return True


def restore(manifest_path, output=None, verify_only=False):
    manifest_path = Path(manifest_path)
    manifest = load_manifest(manifest_path)
    folder = manifest_path.parent
    output = Path(output) if output is not None else folder / manifest["source_filename"]
    if not verify_only and _existing_output(output, manifest):
        return {"status": "already_verified", "output": str(output), "sha256": manifest["source_sha256"]}
    temporary, destination = None, None
    if not verify_only:
        output.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=".dordiai-core-restore-", dir=output.parent)
        temporary, destination = Path(name), os.fdopen(fd, "wb")
    digest, total = hashlib.sha256(), 0
    try:
        for chunk in manifest["chunks"]:
            archive_path = folder / chunk["zip_filename"]
            if (archive_path.is_symlink() or not archive_path.is_file()
                    or archive_path.stat().st_size != chunk["zip_size_bytes"]
                    or file_sha256(archive_path) != chunk["zip_sha256"]):
                raise ValueError("Missing, changed or corrupt backup ZIP: " + chunk["zip_filename"])
            with zipfile.ZipFile(archive_path) as archive:
                members = archive.infolist()
                if len(members) != 1:
                    raise ValueError("Each backup ZIP must contain exactly one member")
                member = members[0]
                if (member.orig_filename != chunk["member_name"] or member.filename != chunk["member_name"]
                        or member.is_dir() or member.compress_type != zipfile.ZIP_STORED
                        or member.flag_bits & 1 or member.file_size != chunk["raw_size_bytes"]
                        or stat.S_IFMT(member.external_attr >> 16) not in (0, stat.S_IFREG)):
                    raise ValueError("Unsafe or unexpected backup ZIP member")
                raw_digest, size = hashlib.sha256(), 0
                with archive.open(member) as stream:
                    for data in iter(lambda: stream.read(BLOCK_BYTES), b""):
                        size += len(data)
                        if size > chunk["raw_size_bytes"]:
                            raise ValueError("Backup chunk exceeds its expected size")
                        raw_digest.update(data)
                        digest.update(data)
                        if destination is not None:
                            destination.write(data)
                if size != chunk["raw_size_bytes"] or raw_digest.hexdigest() != chunk["raw_sha256"]:
                    raise ValueError("Backup raw chunk checksum differs")
                total += size
        if total != manifest["source_size_bytes"] or digest.hexdigest() != manifest["source_sha256"]:
            raise ValueError("Reconstructed addon checksum differs from the original")
        if destination is not None:
            destination.flush()
            os.fsync(destination.fileno())
            destination.close()
            destination = None
            try:
                # Windows rename refuses existing targets; on POSIX a hard
                # link provides atomic publication without clobbering a race.
                if os.name == "nt":
                    os.rename(temporary, output)
                    temporary = None
                else:
                    os.link(temporary, output)
            except FileExistsError:
                if not _existing_output(output, manifest):
                    raise
            if temporary is not None:
                temporary.unlink()
                temporary = None
        return {"status": "verified" if verify_only else "restored", "output": None if verify_only else str(output),
                "size_bytes": total, "sha256": digest.hexdigest(), "chunks": len(manifest["chunks"])}
    finally:
        if destination is not None:
            destination.close()
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    print(json.dumps(restore(args.manifest, args.output, args.verify_only)))


if __name__ == "__main__":
    main()
