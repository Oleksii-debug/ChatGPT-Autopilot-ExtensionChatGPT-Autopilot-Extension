"""Collect bounded diagnostic evidence without packaging models or portable NVDA.

Only JSON reports, log tails and short WAV evidence are retained. This collector
never changes test outcomes; a missing/failed probe remains visibly missing or
failed in its source report and in the Actions console summary.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil


ALLOWED_SUFFIXES = frozenset((".json", ".log", ".wav"))
EXCLUDED_DIRECTORIES = frozenset(("config", "addons", "models", "portable", "python", "__pycache__"))
MAX_TOTAL_BYTES = 50 * 1024 * 1024
MAX_FILE_BYTES = 4 * 1024 * 1024
LOG_TAIL_BYTES = 2 * 1024 * 1024
CONSOLE_LOG_TAIL_BYTES = 64 * 1024


def candidate_files(source):
    for current, directories, files in os.walk(source, followlinks=False):
        directory = Path(current)
        directories[:] = sorted(name for name in directories
                                if name.casefold() not in EXCLUDED_DIRECTORIES
                                and not (directory / name).is_symlink())
        for name in sorted(files):
            path = directory / name
            if path.suffix.casefold() in ALLOWED_SUFFIXES and not path.is_symlink():
                yield path


def _tail(path, maximum):
    with path.open("rb") as source:
        source.seek(max(0, path.stat().st_size - maximum))
        return source.read(maximum)


def _summary(document):
    result = {key: document[key] for key in ("status", "scope", "error", "reason", "traceback")
              if key in document}
    for field in ("checks", "tests", "cases"):
        entries = document.get(field)
        if isinstance(entries, list):
            result[field + "_count"] = len(entries)
            result[field + "_nonpassing"] = [
                {key: value for key, value in entry.items()
                 if key in {"name", "kind", "language", "voice", "status", "error", "reason", "traceback", "driver_error"}}
                for entry in entries if isinstance(entry, dict) and entry.get("status") not in {"passed", "success", "passed-structure-only"}
            ]
    if isinstance(document.get("probe"), dict):
        result["probe"] = _summary(document["probe"])
    return result


def print_diagnostics(source):
    if not source.is_dir():
        print("Windows diagnostics: no probe result directory was produced.", flush=True)
        return
    files = list(candidate_files(source))
    for path in sorted(files):
        if path.name not in {"report.json", "windows-nvda-probe.json", "nvda-probe.json"}:
            continue
        if path.stat().st_size > MAX_FILE_BYTES:
            print("Oversized diagnostic report omitted from console: " + str(path), flush=True)
            continue
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
            print("DIAGNOSTIC " + str(path.relative_to(source)) + " "
                  + json.dumps(_summary(document), ensure_ascii=True), flush=True)
        except (OSError, ValueError, TypeError) as error:
            print("Unreadable diagnostic report " + str(path) + ": " + repr(error), flush=True)
    for path in sorted(files):
        if path.name not in {"nvda.log", "nvda-console.log",
                             "portable-creation.log", "portable-creation-console.log"}:
            continue
        text = _tail(path, CONSOLE_LOG_TAIL_BYTES).decode("utf-8", errors="replace")
        # Keep traceback continuation lines, not just lines with ERROR tokens.
        lines = text.splitlines()[-100:]
        print("NVDA LOG TAIL " + str(path.relative_to(source)), flush=True)
        for line in lines:
            # Escapes preserve diagnostics even when a Windows console uses a
            # legacy code page. The original UTF-8 log remains in the artifact.
            print(line.encode("ascii", errors="backslashreplace").decode("ascii"), flush=True)


def collect(source, destination, maximum=MAX_TOTAL_BYTES):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if destination == source or destination.is_relative_to(source):
        raise ValueError("Evidence destination must be outside the source tree")
    if maximum < 4096:
        raise ValueError("Evidence byte budget must leave at least 4096 bytes for its inventory")
    if destination.is_symlink():
        raise ValueError("Evidence destination cannot be a symbolic link")
    destination.mkdir(parents=True, exist_ok=True)
    # A stale file from another attempt must not enter the new artifact.
    for child in destination.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    manifest = {"format": "dordiai-bounded-windows-evidence", "format_version": 1,
                "created_utc": datetime.now(timezone.utc).isoformat(),
                "source": str(source), "maximum_bytes": maximum,
                "scope": "diagnostic collection only; source probe results determine success",
                "excluded_directories": sorted(EXCLUDED_DIRECTORIES),
                "allowed_suffixes": sorted(ALLOWED_SUFFIXES), "files": [], "omitted": []}
    total = 0
    priority = {".json": 0, ".log": 1, ".wav": 2}
    files = sorted(candidate_files(source), key=lambda path: (priority[path.suffix.casefold()], path.as_posix()))
    for path in files:
        relative = path.relative_to(source)
        size = path.stat().st_size
        truncated = path.suffix.casefold() == ".log" and size > LOG_TAIL_BYTES
        retained_size = min(size, LOG_TAIL_BYTES) if truncated else size
        if retained_size > MAX_FILE_BYTES or total + retained_size > maximum:
            manifest["omitted"].append({"path": relative.as_posix(), "original_bytes": size,
                                        "reason": "per-file or total evidence byte budget"})
            continue
        data = _tail(path, LOG_TAIL_BYTES) if truncated else path.read_bytes()
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        total += len(data)
        manifest["files"].append({"path": relative.as_posix(), "original_bytes": size,
                                  "retained_bytes": len(data), "log_tail_only": truncated,
                                  "sha256": hashlib.sha256(data).hexdigest()})
    manifest.update(retained_bytes=total, status="collected" if files else "no-probe-results")
    def encoded_inventory():
        return (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    encoded = encoded_inventory()
    # The manifest counts toward the advertised artifact limit too. Remove
    # lowest-priority retained evidence first if its inventory needs space.
    while total + len(encoded) > maximum and manifest["files"]:
        removed = manifest["files"].pop()
        (destination / removed["path"]).unlink()
        total -= removed["retained_bytes"]
        manifest["omitted"].append({"path": removed["path"], "original_bytes": removed["original_bytes"],
                                    "reason": "total evidence budget including inventory"})
        manifest["retained_bytes"] = total
        encoded = encoded_inventory()
    if len(encoded) > maximum:
        raise ValueError("Evidence inventory alone exceeds its byte budget")
    (destination / "collection.json").write_bytes(encoded)
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    print_diagnostics(args.source.resolve())
    manifest = collect(args.source, args.output)
    print(json.dumps({"evidence_collection": manifest["status"],
                      "files": len(manifest["files"]), "retained_bytes": manifest["retained_bytes"],
                      "omitted_files": len(manifest["omitted"]), "output": str(args.output.resolve())}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
