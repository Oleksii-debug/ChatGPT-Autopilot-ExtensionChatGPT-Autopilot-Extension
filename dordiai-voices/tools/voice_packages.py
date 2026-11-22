"""Local CLI for preparing, inspecting, installing and rolling back voices.

The manifest describes already prepared assets and a compatible engine adapter.
This tool does not pretend to train an arbitrary recording into an acoustic
model. Shared models are declared once in ``requires`` and are not duplicated
inside every voice package.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import sys

RUNTIME = Path(__file__).resolve().parents[1] / "source" / "0.12.2" / "kx47Runtime"
sys.path.insert(0, str(RUNTIME))
from voice_packages import (  # noqa: E402
    FORMAT, FORMAT_VERSION, MAX_PACKAGE_BYTES, MANIFEST_NAME, PackageError,
    activate_version, create_package, discover_packages, inspect_package,
    install_package, load_manifest, validate_manifest, validate_member_path,
)
from voice_policy import require_voice_allowed  # noqa: E402


def prepare_manifest(source, *, voice_id, name, version, engine, languages,
                     provenance, roles, styles=None, requires=None):
    """One preparation recipe applies to any new voice of a known adapter.

    ``roles`` maps relative data paths to adapter-defined asset roles, such as
    target_embedding, acoustic_profile, letter_bank or delivery_settings. Voice
    identity does not occur in the preparation code itself.
    """
    require_voice_allowed(voice_id)
    source = Path(source).resolve()
    files = {}
    for filename, role in roles.items():
        validate_member_path(filename)
        path = source.joinpath(*filename.split("/"))
        if path.is_symlink() or not path.resolve().is_relative_to(source) or not path.is_file():
            raise PackageError("Missing or unsafe prepared asset: " + filename)
        digest = sha256()
        with path.open("rb") as stream:
            while block := stream.read(1024 * 1024):
                digest.update(block)
        files[filename] = {"role": role, "sha256": digest.hexdigest(), "size_bytes": path.stat().st_size}
    return validate_manifest({
        "format": FORMAT, "format_version": FORMAT_VERSION,
        "id": voice_id, "name": name, "version": version,
        "engine": engine, "languages": languages, "styles": styles or ["neutral"],
        "provenance": provenance, "requires": requires or [], "files": files,
    })


def _inventory(path):
    return json.loads(Path(path).read_text(encoding="utf-8")) if path else None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare", help="Hash prepared data using an engine-specific recipe JSON")
    prepare.add_argument("--source", required=True, type=Path)
    prepare.add_argument("--recipe", required=True, type=Path)
    prepare.add_argument("--manifest", required=True, type=Path)
    create = commands.add_parser("create", help="Create a reproducible .dordiai-voice ZIP")
    create.add_argument("--source", required=True, type=Path)
    create.add_argument("--manifest", required=True, type=Path)
    create.add_argument("--output", required=True, type=Path)
    inspect = commands.add_parser("inspect", help="Check all package paths, sizes and SHA-256 hashes")
    inspect.add_argument("package", type=Path)
    install = commands.add_parser("install", help="Verify and install an immutable voice version")
    install.add_argument("package", type=Path)
    install.add_argument("--root", required=True, type=Path)
    install.add_argument("--engines", type=Path, help="JSON of installed engine ID -> compatibility version")
    install.add_argument("--resources", type=Path, help="JSON of installed shared resource ID -> version")
    install.add_argument("--max-bytes", type=int, default=MAX_PACKAGE_BYTES)
    rollback = commands.add_parser("activate", help="Activate/rollback a verified installed version")
    rollback.add_argument("voice")
    rollback.add_argument("version")
    rollback.add_argument("--root", required=True, type=Path)
    rollback.add_argument("--engines", type=Path)
    rollback.add_argument("--resources", type=Path)
    listing = commands.add_parser("list", help="List valid active package metadata")
    listing.add_argument("--root", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "prepare":
            recipe = json.loads(args.recipe.read_text(encoding="utf-8"))
            result = prepare_manifest(args.source, **recipe)
            args.manifest.parent.mkdir(parents=True, exist_ok=True)
            args.manifest.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(args.manifest)
        elif args.command == "create":
            print(create_package(args.source, load_manifest(args.manifest), args.output))
        elif args.command == "inspect":
            print(json.dumps(inspect_package(args.package), ensure_ascii=False, indent=2))
        elif args.command == "install":
            print(install_package(args.package, args.root, engines=_inventory(args.engines),
                                  resources=_inventory(args.resources), max_bytes=args.max_bytes))
        elif args.command == "activate":
            print(activate_version(args.root, args.voice, args.version,
                                   engines=_inventory(args.engines), resources=_inventory(args.resources)))
        elif args.command == "list":
            print(json.dumps(discover_packages(args.root), ensure_ascii=False, indent=2))
    except (OSError, ValueError, TypeError) as error:
        parser.exit(2, "Voice package error: " + str(error) + "\n")


if __name__ == "__main__":
    main()
