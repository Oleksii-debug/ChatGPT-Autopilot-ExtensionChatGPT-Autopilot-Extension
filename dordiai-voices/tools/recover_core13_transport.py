"""Split the pinned development installer into transport parts without changing bytes."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path

EXPECTED_BYTES = 1_992_990_314
EXPECTED_SHA256 = "4aed1ba48e8600dcd5f80bac9b85e5a3d7ce09b209c76a4a2873fe7b9960876d"
CHUNK_BYTES = 450_000_000

def restore_parts(archive, output):
    archive = Path(archive)
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size != EXPECTED_BYTES:
        raise ValueError("The exact immutable source13 installer is required")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    whole = hashlib.sha256()
    parts = []
    total = 0
    with archive.open("rb") as source:
        for number in range(1, 6):
            name = f"dordiai-core13-{number:03d}.bin"
            temporary = output / (name + ".partial")
            digest = hashlib.sha256()
            size = 0
            limit = min(CHUNK_BYTES, EXPECTED_BYTES - total)
            with temporary.open("xb") as target:
                while size < limit:
                    block = source.read(min(2**20, limit-size))
                    if not block:
                        raise EOFError("The backup ended before its pinned length")
                    target.write(block)
                    digest.update(block)
                    whole.update(block)
                    size += len(block)
            total += size
            parts.append({"file": name, "bytes": size, "sha256": digest.hexdigest()})
        if source.read(1):
            raise ValueError("Backup exceeds its pinned length")
    if total != EXPECTED_BYTES or whole.hexdigest() != EXPECTED_SHA256:
        raise ValueError("Full development backup failed its pinned SHA256")
    receipt = {
        "format": "dordiai-source13-transport-parts", "version": 1,
        "original_name": "dordiai-voices-0.13.1-dev.13.nvda-addon",
        "original_bytes": total, "original_sha256": whole.hexdigest(), "parts": parts,
        "source_artifact_id": 14765535864,
        "source_commit": "2d70515a4c49413efcb23198491bbc675a55db0a",
        "product_ready": False,
    }
    for part in parts:
        (output / (part["file"] + ".partial")).replace(output / part["file"])
    (output / "parts.json").write_text(json.dumps(receipt, indent=2)+"\n", encoding="utf8")
    print(json.dumps(receipt), flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--addon", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    restore_parts(args.addon, args.output)
