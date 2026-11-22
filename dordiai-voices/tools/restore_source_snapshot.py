"""Restore the exact small source tree recorded for a qualified development build."""
import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile


def restore(snapshot, output):
    snapshot, output = Path(snapshot), Path(output)
    if snapshot.stat().st_size > 100 * 1024 * 1024:
        raise ValueError("Source snapshot exceeds size limit")
    if snapshot.suffix == ".gz":
        with gzip.open(snapshot, "rb") as stream:
            contents = stream.read(100 * 1024 * 1024 + 1)
        if len(contents) > 100 * 1024 * 1024:
            raise ValueError("Expanded source snapshot exceeds size limit")
        document = json.loads(contents)
    else:
        document = json.loads(snapshot.read_text(encoding="utf-8"))
    if document.get("format") != "dordiai-source-snapshot" or document.get("format_version") != 1:
        raise ValueError("Unsupported source snapshot")
    files = document.get("files")
    if not isinstance(files, dict) or not files or len(files) > 10000:
        raise ValueError("Invalid source snapshot inventory")
    if output.exists():
        raise ValueError("Restore destination already exists; choose an unused directory")
    decoded, folded, rows, total = {}, set(), [], 0
    for name in sorted(files, key=lambda value: PurePosixPath(value).parts):
        relative = PurePosixPath(name)
        if (relative.is_absolute() or ".." in relative.parts or str(relative) != name
                or "\\" in name or ":" in name or any(ord(c) < 32 for c in name)
                or name.casefold() in folded):
            raise ValueError("Unsafe source snapshot path")
        folded.add(name.casefold())
        record = files[name]
        if not isinstance(record, dict) or not re.fullmatch(r"[0-9a-f]{64}", str(record.get("sha256", ""))):
            raise ValueError("Invalid source snapshot checksum")
        data = base64.b64decode(record["base64"], validate=True)
        total += len(data)
        if total > 100 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != record["sha256"]:
            raise ValueError("Source snapshot checksum or size differs")
        decoded[name] = data
        rows.append(name + "\0" + record["sha256"] + "\n")
    digest = hashlib.sha256("".join(rows).encode()).hexdigest()
    if digest != document.get("source_sha256"):
        raise ValueError("Source tree checksum differs")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".dordiai-source-", dir=output.parent))
    try:
        for name, data in decoded.items():
            path = temporary / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        temporary.replace(output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return {"files": len(decoded), "source_sha256": digest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(restore(args.snapshot, args.output)))


if __name__ == "__main__":
    main()
