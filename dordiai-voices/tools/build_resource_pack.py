"""Package any prepared model/language resource directory for offline installation."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from build_release import InputFile, PACK_MANIFEST, ROOT, VERSION, build_archive

sys.path.insert(0, str(ROOT / "source/0.12.2/kx47Runtime"))
import package_manager as manager


def create_resource_pack(source, output, *, prefix, identity, name, version="1.0.0",
                         minimum_core_version=VERSION, languages=(), engine_ids=(), dependencies=()):
    """Create a generic pack without adding a per-language branch to the builder.

    The caller supplies the exact destination namespace expected by its adapter.
    Hashes and file inventory are generated from real bytes, never supplied by
    the caller. This operation verifies packaging, not acoustic quality.
    """
    source, output = Path(source), Path(output)
    if source.is_symlink() or not source.is_dir():
        raise ValueError("Resource source must be a regular directory")
    source = source.resolve()
    if output.resolve().is_relative_to(source):
        raise ValueError("Output archive must be outside the resource directory")
    if not manager._ID.fullmatch(identity) or not isinstance(name, str) or not name.strip():
        raise ValueError("Invalid resource pack identity or name")
    manager._version(version)
    manager._version(minimum_core_version)
    manager._resource_path(prefix + "/placeholder.bin")
    if any(not isinstance(value, str) or not manager._ID.fullmatch(value) for value in dependencies):
        raise ValueError("Invalid resource pack dependency")
    if identity in dependencies:
        raise ValueError("A pack cannot depend on itself")
    if any(not isinstance(value, str) or not value for value in [*languages, *engine_ids]):
        raise ValueError("Language and engine identifiers must be nonempty strings")
    payload, folded, total = [], set(), 0
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            raise ValueError("Symlink in resource source: " + str(path))
        if not path.is_file():
            continue
        relative = path.relative_to(source)
        if "__pycache__" in relative.parts:
            continue
        destination = prefix + "/" + relative.as_posix()
        manager._resource_path(destination)
        if destination.casefold() in folded:
            raise ValueError("Windows path collision: " + destination)
        folded.add(destination.casefold())
        total += path.stat().st_size
        if len(payload) >= manager.MAX_FILES or total > manager.MAX_BYTES - 8 * 1024 * 1024:
            raise ValueError("Resource pack exceeds installation limits; split the resources")
        payload.append(InputFile(destination, path, identity))
    if not payload:
        raise ValueError("Resource directory has no files")
    metadata = {"format": manager.FORMAT, "format_version": 1, "id": identity, "name": name,
                "version": version, "minimum_core_version": minimum_core_version,
                "languages": list(dict.fromkeys(languages)), "engine_ids": list(dict.fromkeys(engine_ids)),
                "dependencies": list(dict.fromkeys(dependencies))}
    output.parent.mkdir(parents=True, exist_ok=True)
    record = build_archive(output, payload, metadata, PACK_MANIFEST)
    manager.inspect_pack(output)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prefix", required=True, help="Destination below kx47Runtime/models")
    parser.add_argument("--id", dest="identity", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--version", default="1.0.0")
    parser.add_argument("--minimum-core-version", default=VERSION)
    parser.add_argument("--language", dest="languages", action="append", default=[])
    parser.add_argument("--engine", dest="engine_ids", action="append", default=[])
    parser.add_argument("--dependency", dest="dependencies", action="append", default=[])
    args = parser.parse_args()
    record = create_resource_pack(**vars(args))
    print(json.dumps(record, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
