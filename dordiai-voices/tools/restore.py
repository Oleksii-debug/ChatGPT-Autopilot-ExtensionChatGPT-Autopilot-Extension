"""Restore the two exact baseline NVDA packages from the shared Drive archive."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ID = "19Hd9DMyloGz1Jpf8Ig2TKX4JrQvsgEwG"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def safe_members(archive, target):
    target = target.resolve()
    names = set()
    for member in archive.infolist():
        name = member.orig_filename
        relative = PurePosixPath(name)
        if (name != member.filename or "\\" in name or ":" in name
                or any(ord(char) < 32 for char in name) or relative.is_absolute()
                or ".." in relative.parts):
            raise ValueError(f"Unsafe raw archive member: {name}")
        destination = (target / name).resolve()
        if ("\\" in name or not destination.is_relative_to(target)
                or stat.S_ISLNK(member.external_attr >> 16)):
            raise ValueError(f"Unsafe archive member: {name}")
        if destination in names:
            raise ValueError(f"Duplicate archive destination: {name}")
        names.add(destination)
    return archive.infolist()


def download(target, expected):
    if target.is_file() and digest(target) == expected["sha256"]:
        return
    url = "https://drive.google.com/uc?" + urllib.parse.urlencode(
        {"export": "download", "id": SOURCE_ID})
    response = urllib.request.urlopen(url, timeout=120)
    if "text/html" in response.headers.get("Content-Type", ""):
        page = response.read(128 * 1024).decode("utf-8")
        fields = dict(re.findall(r'name="([^"]+)" value="([^"]*)"', page))
        if fields.get("id") != SOURCE_ID or fields.get("confirm") != "t":
            raise RuntimeError("The shared archive cannot currently be downloaded.")
        response.close()
        # Fixed Google destination; never follow an arbitrary HTML form action.
        url = "https://drive.usercontent.google.com/download?" + urllib.parse.urlencode(fields)
        response = urllib.request.urlopen(url, timeout=120)
    if "html" in response.headers.get("Content-Type", ""):
        response.close()
        raise RuntimeError("Google returned a page instead of the archive.")
    temporary = target.with_suffix(".part")
    transferred = 0
    with response, temporary.open("wb") as output:
        while chunk := response.read(8 * 1024 * 1024):
            output.write(chunk)
            transferred += len(chunk)
            if transferred > expected["size_bytes"]:
                raise ValueError("Downloaded data exceeds the recorded archive size.")
    if transferred != expected["size_bytes"] or digest(temporary) != expected["sha256"]:
        raise ValueError("Shared archive checksum or size differs from the audited baseline.")
    temporary.replace(target)


def main():
    import gzip
    with gzip.open(ROOT / "evidence/archive_inventory.json.gz", "rt", encoding="utf-8") as stream:
        inventory = json.load(stream)
    downloads = ROOT / "downloads"
    downloads.mkdir(exist_ok=True)
    archive = downloads / "source.zip"
    print("Checking/downloading the original archive (7,778,217,998 bytes).", flush=True)
    download(archive, inventory["source"])
    with zipfile.ZipFile(archive) as outer:
        for filename, metadata in inventory["packages"].items():
            candidates = [m for m in outer.infolist() if m.filename.rsplit("/", 1)[-1] == filename]
            if len(candidates) != 1:
                raise ValueError(f"Expected one direct copy of {filename}")
            package = downloads / filename
            if not package.is_file() or digest(package) != metadata["sha256"]:
                temporary = package.with_suffix(".part")
                with outer.open(candidates[0]) as source, temporary.open("wb") as output:
                    shutil.copyfileobj(source, output, length=8 * 1024 * 1024)
                if digest(temporary) != metadata["sha256"]:
                    raise ValueError(f"Package checksum differs: {filename}")
                temporary.replace(package)
            label = "unified-0.3.10" if "unified" in filename else "0.12.2"
            target = ROOT / "packages" / label
            if target.exists() and any(target.iterdir()):
                print(f"Keeping existing working package: {target}", flush=True)
                continue
            target.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(package) as baseline:
                members = safe_members(baseline, target)
                baseline.extractall(target, members)
            print(f"Restored {label}: {target}", flush=True)


if __name__ == "__main__":
    main()
