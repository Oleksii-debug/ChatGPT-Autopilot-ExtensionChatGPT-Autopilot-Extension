"""Restore only the audited main baseline; keep peak CI disk use bounded.

Original archives outside this tool's explicit cache directory are untouched.
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("_dordiai_restore", Path(__file__).with_name("restore.py"))
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


def restore_main(cache, target, discard_downloads=False):
    cache, target = Path(cache).resolve(), Path(target).resolve()
    if cache == target or cache in target.parents or target in cache.parents:
        raise ValueError("Download cache and package destination must be separate directories")
    with gzip.open(ROOT / "evidence/archive_inventory.json.gz", "rt", encoding="utf-8") as stream:
        inventory = json.load(stream)
    package_name = "dordiai-voices-0.12.2.nvda-addon"
    metadata = inventory["packages"][package_name]
    if target.exists() and any(target.iterdir()):
        raise ValueError("Restore destination must be empty; existing packages are never overwritten")
    cache.mkdir(parents=True, exist_ok=True)
    addon = cache / package_name
    if not addon.is_file() or restore.digest(addon) != metadata["sha256"]:
        archive = cache / "source.zip"
        if shutil.disk_usage(cache).free < inventory["source"]["size_bytes"] + metadata["size_bytes"]:
            raise OSError("Not enough free space to download and extract the audited source archive")
        restore.download(archive, inventory["source"])
        with zipfile.ZipFile(archive) as outer:
            members = [m for m in outer.infolist() if m.filename.rsplit("/", 1)[-1] == package_name]
            if len(members) != 1:
                raise ValueError("Expected one direct main add-on in the source archive")
            temporary = addon.with_suffix(".part")
            with outer.open(members[0]) as stream, temporary.open("wb") as output:
                shutil.copyfileobj(stream, output, length=8 * 1024 * 1024)
        if temporary.stat().st_size != metadata["size_bytes"] or restore.digest(temporary) != metadata["sha256"]:
            raise ValueError("Main add-on differs from the audited baseline")
        temporary.replace(addon)
        if discard_downloads:
            archive.unlink()
    if shutil.disk_usage(cache).free < metadata["uncompressed_bytes"]:
        raise OSError("Not enough free space for the main add-on")
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(addon) as baseline:
        members = restore.safe_members(baseline, target)
        baseline.extractall(target, members)
    if discard_downloads:
        addon.unlink()
    return {"baseline": str(target), "sha256": metadata["sha256"],
            "uncompressed_bytes": metadata["uncompressed_bytes"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("--target", type=Path, default=ROOT / "packages/0.12.2")
    parser.add_argument("--discard-downloads", action="store_true")
    args = parser.parse_args()
    print(json.dumps(restore_main(args.cache, args.target, args.discard_downloads)), flush=True)


if __name__ == "__main__":
    main()
