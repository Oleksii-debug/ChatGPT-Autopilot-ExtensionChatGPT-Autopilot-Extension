#!/usr/bin/env python3
"""Fetch pinned optional ONNX resources without touching the audited input package."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import shutil
import urllib.request
import uuid

DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "model-packs" / "extra-onnx"
DESTINATIONS = {"sat": "kx47Runtime/models/ExtraLanguages/sat", "omni": "kx47Runtime/models/SharedOmniONNX"}
SAT_NAMES = {"model/santali_piper_vits.onnx": "model.onnx",
             "model/santali_piper_vits.onnx.json": "config.json",
             "santali_phonemizer.py": "upstream_phonemizer.py.txt"}


def digests(path):
    path = Path(path)
    h = hashlib.sha256()
    git = hashlib.sha1(("blob " + str(path.stat().st_size) + "\0").encode())
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
            git.update(chunk)
    return h.hexdigest(), git.hexdigest()


def verified(path, record):
    path = Path(path)
    if not path.is_file() or path.stat().st_size != record["size_bytes"]:
        return False
    sha256, git = digests(path)
    return sha256 == record["sha256"] if record.get("sha256") else git == record["git_blob"]


def fetch_one(repository, revision, remote_path, record, destination, verify_only=False):
    destination = Path(destination)
    if verified(destination, record):
        return {"file": remote_path, "status": "verified-existing", "sha256": digests(destination)[0]}
    if verify_only:
        raise ValueError("Missing or invalid pinned resource: " + str(destination))
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".part-" + uuid.uuid4().hex)
    url = "https://huggingface.co/" + repository + "/resolve/" + revision + "/" + remote_path
    try:
        last = None
        for attempt in range(3):
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "dordiai-voices-model-preparation/1"})
                with urllib.request.urlopen(request, timeout=60) as source, temporary.open("wb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                if not verified(temporary, record):
                    raise ValueError("Pinned size or digest mismatch for " + remote_path)
                os.replace(temporary, destination)
                return {"file": remote_path, "status": "downloaded-verified", "sha256": digests(destination)[0]}
            except Exception as error:
                last = error
                temporary.unlink(missing_ok=True)
        raise last
    finally:
        temporary.unlink(missing_ok=True)


def prepare(output, families=("sat", "omni"), with_encoder=False, verify_only=False):
    sources = json.loads(Path(__file__).with_name("extra_model_sources.json").read_text(encoding="utf-8"))
    result = {"format_version": 1, "families": {}, "verified_audio": False}
    for family in families:
        specification = sources[family]
        folder = Path(output) / DESTINATIONS[family]
        jobs = []
        with ThreadPoolExecutor(max_workers=4) as pool:
            for name, record in specification["files"].items():
                if name == "encoder.fp32.onnx" and not with_encoder:
                    continue
                local = SAT_NAMES.get(name, name) if family == "sat" else name
                jobs.append(pool.submit(fetch_one, specification["repository"], specification["revision"], name,
                                        record, folder / local, verify_only))
            verified_files = []
            for future in as_completed(jobs):
                item = future.result()
                verified_files.append(item)
                print(family, item["status"], item["file"], flush=True)
        provenance = dict(repository=specification["repository"], revision=specification["revision"],
                          license=specification["license"], files=verified_files,
                          audio_verified=False, windows_verified=False)
        folder.joinpath("source.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if family == "omni":
            folder.joinpath("UPSTREAM-LICENSE-NOTICE.txt").write_text(
                "These ONNX graphs derive from k2-fsa/OmniVoice, whose pre-trained weights are CC-BY-NC "
                "according to its official model card. Converter repository metadata does not remove that condition.\n"
                "Upstream model: https://huggingface.co/k2-fsa/OmniVoice/tree/3fc979d1cd72492cd679c5ac2611e0d7ac047ba1\n"
                "The Higgs Audio tokenizer also carries the included upstream license conditions.\n", encoding="utf-8")
        result["families"][family] = {"folder": str(folder), "files": len(verified_files),
                                      "bytes": sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())}
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--only", choices=["sat", "omni", "all"], default="all")
    parser.add_argument("--with-encoder", action="store_true", help="Fetch optional reference-code encoder for preparation")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args(argv)
    result = prepare(args.output, ("sat", "omni") if args.only == "all" else (args.only,), args.with_encoder, args.verify_only)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
