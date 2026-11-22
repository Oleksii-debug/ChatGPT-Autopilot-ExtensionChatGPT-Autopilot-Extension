"""Versioned data-only voice packages; no model or NVDA imports.

Creating/importing a package is a local maintenance operation. Discovery reads
only small manifests, and does not hash multi-gigabyte models in NVDA's audio
thread. An engine adapter must verify assets before it first uses a package.
"""
from contextlib import contextmanager
from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import zipfile

try:
    from voice_policy import require_voice_allowed
except ImportError:
    # NVDA loads selected helpers by filename without adding this directory to
    # sys.path. Keep the fallback local and use a project-prefixed module name.
    import importlib.util
    import sys
    _policy_name = "_dordiai_package_voice_policy"
    _policy = sys.modules.get(_policy_name)
    if _policy is None:
        _spec = importlib.util.spec_from_file_location(_policy_name, Path(__file__).with_name("voice_policy.py"))
        _policy = importlib.util.module_from_spec(_spec)
        sys.modules[_policy_name] = _policy
        try:
            _spec.loader.exec_module(_policy)
        except Exception:
            sys.modules.pop(_policy_name, None)
            raise
    require_voice_allowed = _policy.require_voice_allowed


MANIFEST_NAME = "voice-package.json"
INDEX_NAME = "voice-packages.json"
FORMAT = "dordiai-voice-package"
FORMAT_VERSION = 1
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_PACKAGE_BYTES = 8 * 1024 * 1024 * 1024
MAX_MEMBERS = 10000
IDENTIFIER = re.compile(r"[a-z][a-z0-9_\-]{0,63}\Z")
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.\-]+)?\Z")
LANGUAGE = re.compile(r"[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*\Z")
DIGEST = re.compile(r"[a-f0-9]{64}\Z")
WINDOWS_RESERVED = {"con", "prn", "aux", "nul", "clock$"} | {
    name + str(n) for name in ("com", "lpt") for n in range(1, 10)
}
CODE_SUFFIXES = frozenset({".py", ".pyc", ".pyo", ".pyd", ".pth", ".exe",
                           ".dll", ".bat", ".cmd", ".ps1", ".vbs", ".js",
                           ".so", ".dylib", ".lnk", ".url", ".pickle", ".pkl"})


class PackageError(ValueError):
    pass


def validate_member_path(name):
    """Reject paths that change meaning on Windows or can escape a package."""
    if not isinstance(name, str) or not name or len(name) > 240:
        raise PackageError("Invalid package path")
    parts = name.split("/")
    if ("\\" in name or any(c in name for c in ':\x00<>|?*"')
            or any(ord(c) < 32 for c in name)
            or any(p in ("", ".", "..") or p.endswith((" ", ".")) for p in parts)
            or any(p.split(".", 1)[0].casefold() in WINDOWS_RESERVED for p in parts)
            or PurePosixPath(name).is_absolute()):
        raise PackageError("Unsafe package path: " + name)
    return name


def _text(value, label, maximum=200):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise PackageError("Invalid " + label)
    return value


def validate_manifest(document, max_bytes=MAX_PACKAGE_BYTES):
    if not isinstance(document, dict) or document.get("format") != FORMAT:
        raise PackageError("Unsupported voice package format")
    if type(document.get("format_version")) is not int or document["format_version"] != FORMAT_VERSION:
        raise PackageError("Unsupported voice package format version")
    voice = _text(document.get("id"), "voice identifier", 64)
    if not IDENTIFIER.fullmatch(voice):
        raise PackageError("Invalid voice identifier")
    require_voice_allowed(voice)
    validate_member_path(voice)
    if not VERSION.fullmatch(_text(document.get("version"), "version", 80)):
        raise PackageError("A voice version must use major.minor.patch")
    validate_member_path(document["version"])
    _text(document.get("name"), "voice name", 100)
    engine = document.get("engine")
    if (not isinstance(engine, dict) or not IDENTIFIER.fullmatch(str(engine.get("id", "")))
            or type(engine.get("compatibility_version")) is not int
            or engine["compatibility_version"] < 1):
        raise PackageError("A voice must declare its engine adapter and compatibility version")
    languages = document.get("languages")
    if (not isinstance(languages, list) or not languages
            or any(not isinstance(x, str) or not LANGUAGE.fullmatch(x) for x in languages)
            or len(set(languages)) != len(languages)):
        raise PackageError("Invalid supported languages")
    styles = document.get("styles", ["neutral"])
    if (not isinstance(styles, list) or not styles or "neutral" not in styles
            or any(not isinstance(x, str) or not IDENTIFIER.fullmatch(x) for x in styles)
            or len(styles) != len(set(styles))):
        raise PackageError("Invalid voice styles; neutral must be available")
    provenance = document.get("provenance")
    if not isinstance(provenance, dict):
        raise PackageError("A voice package must record its source and license")
    _text(provenance.get("source"), "voice source", 4096)
    _text(provenance.get("license"), "voice license", 4096)
    requirements = document.get("requires", [])
    if not isinstance(requirements, list):
        raise PackageError("Invalid shared resource requirements")
    for requirement in requirements:
        if (not isinstance(requirement, dict)
                or not IDENTIFIER.fullmatch(str(requirement.get("id", "")))
                or not VERSION.fullmatch(str(requirement.get("version", "")))):
            raise PackageError("Invalid shared resource requirement")
    files = document.get("files")
    if not isinstance(files, dict) or not files or len(files) > MAX_MEMBERS - 1:
        raise PackageError("Invalid package file inventory")
    seen, total = set(), 0
    for name, entry in files.items():
        validate_member_path(name)
        folded = name.casefold()
        if folded == MANIFEST_NAME or folded in seen:
            raise PackageError("Duplicate or reserved package destination: " + name)
        seen.add(folded)
        if PurePosixPath(name).suffix.casefold() in CODE_SUFFIXES:
            raise PackageError("Voice packages contain data, not executable code: " + name)
        if (not isinstance(entry, dict) or not DIGEST.fullmatch(str(entry.get("sha256", "")))
                or type(entry.get("size_bytes")) is not int or entry["size_bytes"] < 0):
            raise PackageError("Invalid file checksum or size: " + name)
        _text(entry.get("role"), "asset role", 80)
        total += entry["size_bytes"]
        if total > max_bytes:
            raise PackageError("Voice data exceeds the package size limit")
    # A file cannot also be a directory, even on a case-insensitive file system.
    for name in seen:
        if any(parent.as_posix() in seen for parent in PurePosixPath(name).parents
               if parent.as_posix() != "."):
            raise PackageError("A package path is both a file and a directory")
    return document


def _json_bytes(document):
    return (json.dumps(document, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def load_manifest(path):
    path = Path(path)
    if path.is_symlink():
        raise PackageError("Voice manifests cannot be symbolic links")
    if path.stat().st_size > MAX_MANIFEST_BYTES:
        raise PackageError("Voice manifest is too large")
    return validate_manifest(json.loads(path.read_text(encoding="utf-8")))


def _digest(stream):
    digest = sha256()
    while True:
        block = stream.read(1024 * 1024)
        if not block:
            return digest.hexdigest()
        digest.update(block)


def _asset_path(directory, name):
    validate_member_path(name)
    directory = Path(directory).resolve()
    path = directory.joinpath(*name.split("/"))
    for part in (path, *path.parents):
        if part == directory:
            break
        if part.is_symlink():
            raise PackageError("Symbolic links are not permitted in voice assets")
    resolved = path.resolve()
    if not resolved.is_relative_to(directory):
        raise PackageError("Voice asset escapes its package")
    return resolved


def verify_assets(directory, document, *, hashes=True):
    validate_manifest(document)
    for name, entry in document["files"].items():
        path = _asset_path(directory, name)
        if not path.is_file() or path.stat().st_size != entry["size_bytes"]:
            raise PackageError("Missing or wrong-size voice asset: " + name)
        if hashes:
            with path.open("rb") as stream:
                if _digest(stream) != entry["sha256"]:
                    raise PackageError("Voice asset checksum differs: " + name)
    return document


def create_package(source, document, output):
    """Package prepared data reproducibly; acoustic preparation is adapter-owned."""
    document = validate_manifest(document)
    source, output = Path(source).resolve(), Path(output)
    verify_assets(source, document)
    data = _json_bytes(document)
    if len(data) > MAX_MANIFEST_BYTES:
        raise PackageError("Voice manifest is too large")
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".voice-package-", suffix=".zip", dir=output.parent)
    os.close(descriptor)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name in (MANIFEST_NAME, *sorted(document["files"])):
                info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                with archive.open(info, "w", force_zip64=True) as destination:
                    if name == MANIFEST_NAME:
                        destination.write(data)
                    else:
                        with _asset_path(source, name).open("rb") as original:
                            shutil.copyfileobj(original, destination, 1024 * 1024)
        # Check the bytes actually written as well as the original source.
        inspect_package(temporary)
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return output


def inspect_zip_members(archive, max_bytes=MAX_PACKAGE_BYTES):
    seen, members, total = set(), {}, 0
    if len(archive.infolist()) > MAX_MEMBERS:
        raise PackageError("Too many package members")
    for info in archive.infolist():
        # On Windows ZipInfo rewrites raw backslashes while reading. Validate
        # the original archive identity as well as the normalized destination.
        validate_member_path(info.orig_filename)
        validate_member_path(info.filename)
        if info.orig_filename != info.filename:
            raise PackageError("Noncanonical package member: " + info.orig_filename)
        mode = info.external_attr >> 16
        kind = stat.S_IFMT(mode)
        if info.is_dir() or kind not in (0, stat.S_IFREG) or info.flag_bits & 1:
            raise PackageError("A voice package must contain unencrypted regular files")
        folded = info.filename.casefold()
        if folded in seen:
            raise PackageError("Duplicate package destination: " + info.filename)
        seen.add(folded)
        members[info.filename] = info
        total += info.file_size
        if total > max_bytes + MAX_MANIFEST_BYTES:
            raise PackageError("Package exceeds the expanded size limit")
    return members


def _read_package(archive, max_bytes=MAX_PACKAGE_BYTES):
    members = inspect_zip_members(archive, max_bytes)
    manifest = members.get(MANIFEST_NAME)
    if manifest is None or manifest.file_size > MAX_MANIFEST_BYTES:
        raise PackageError("Missing or oversized voice manifest")
    document = validate_manifest(json.loads(archive.read(manifest).decode("utf-8")), max_bytes)
    if set(members) != {MANIFEST_NAME, *document["files"]}:
        raise PackageError("Archive members differ from the declared inventory")
    for name, entry in document["files"].items():
        if members[name].file_size != entry["size_bytes"]:
            raise PackageError("Archive file size differs from its manifest: " + name)
    return document, members


def inspect_package(package, max_bytes=MAX_PACKAGE_BYTES):
    with zipfile.ZipFile(package) as archive:
        document, members = _read_package(archive, max_bytes)
        for name, entry in document["files"].items():
            with archive.open(members[name]) as stream:
                if _digest(stream) != entry["sha256"]:
                    raise PackageError("Archive checksum differs: " + name)
    return document


@contextmanager
def _installation_lock(root):
    """OS file locks are released automatically if the installer process exits."""
    path = root / ".voice-packages.lock"
    if path.is_symlink():
        raise PackageError("Invalid package lock path")
    with path.open("a+b") as stream:
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            if not path.stat().st_size:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def _load_index(root):
    path = root / INDEX_NAME
    if not path.exists():
        return {"format_version": 1, "active": {}}
    if path.is_symlink() or path.stat().st_size > MAX_MANIFEST_BYTES:
        raise PackageError("Invalid installed voice index")
    result = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(result, dict) or type(result.get("format_version")) is not int
            or result.get("format_version") not in (1, 2)
            or not isinstance(result.get("active"), dict)):
        raise PackageError("Unsupported installed voice index")
    version = result["format_version"]
    if (version == 1 and "inactive" in result) or (version == 2 and "inactive" not in result):
        raise PackageError("Inactive ownership requires index format version 2")
    inactive = result.get("inactive", {})
    if not isinstance(inactive, dict) or set(result["active"]) & set(inactive):
        raise PackageError("Invalid inactive voice ownership")
    for entries in (result["active"], inactive):
        for voice, version in entries.items():
            if (not isinstance(voice, str) or not IDENTIFIER.fullmatch(voice)
                    or not isinstance(version, str) or not VERSION.fullmatch(version)):
                raise PackageError("Invalid installed voice index entry")
            validate_member_path(voice)
            try:
                require_voice_allowed(voice)
            except ValueError as error:
                raise PackageError("Excluded installed voice ownership: " + voice) from error
    return result


def _write_index(root, document):
    document = dict(document)
    if document.get("inactive"):
        document["format_version"] = 2
    else:
        document.pop("inactive", None)
        document["format_version"] = 1
    descriptor, temporary = tempfile.mkstemp(prefix=".voice-index-", dir=root)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(_json_bytes(document))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, root / INDEX_NAME)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _compatible(document, engines=None, resources=None):
    if engines is not None and engines.get(document["engine"]["id"]) != document["engine"]["compatibility_version"]:
        raise PackageError("Required voice engine adapter is unavailable or incompatible")
    if resources is not None:
        for requirement in document.get("requires", []):
            if resources.get(requirement["id"]) != requirement["version"]:
                raise PackageError("Required shared resource is unavailable: " + requirement["id"])


def install_package(package, root, *, engines=None, resources=None, max_bytes=MAX_PACKAGE_BYTES):
    """Verify into staging, commit immutable data, then atomically activate it.

    Passing engine/resource inventories enforces compatibility before activation.
    Omitting them is useful for an offline depot; it does not prove that the
    installed voice can execute in a particular synthesizer.
    """
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with _installation_lock(root), zipfile.ZipFile(package) as archive:
        document, members = _read_package(archive, max_bytes)
        _compatible(document, engines, resources)
        index = _load_index(root)
        relative = document["id"] + "/" + document["version"]
        final = _asset_path(root, relative)
        stage = Path(tempfile.mkdtemp(prefix=".voice-install-", dir=root))
        try:
            for name, entry in document["files"].items():
                path = stage.joinpath(*name.split("/"))
                path.parent.mkdir(parents=True, exist_ok=True)
                digest, count = sha256(), 0
                with archive.open(members[name]) as source, path.open("xb") as destination:
                    while True:
                        block = source.read(min(1024 * 1024, entry["size_bytes"] - count + 1))
                        if not block:
                            break
                        count += len(block)
                        if count > entry["size_bytes"]:
                            raise PackageError("Expanded file exceeds its declared size")
                        digest.update(block)
                        destination.write(block)
                if count != entry["size_bytes"] or digest.hexdigest() != entry["sha256"]:
                    raise PackageError("Voice asset checksum or size differs: " + name)
            (stage / MANIFEST_NAME).write_bytes(_json_bytes(document))
            already_installed = final.exists()
            if already_installed:
                previous = load_manifest(final / MANIFEST_NAME)
                if _json_bytes(previous) != _json_bytes(document):
                    raise PackageError("The installed version has different contents; use a new version")
                verify_assets(final, previous)
            # A new ID must remain administratively owned if promotion or the
            # final activation commit fails. Never retire a working old active
            # version merely to stage an upgrade under its already-owned ID.
            if (document["id"] not in index["active"]
                    and document["id"] not in index.get("inactive", {})):
                index.setdefault("inactive", {})[document["id"]] = document["version"]
                _write_index(root, index)
            if not already_installed:
                final.parent.mkdir(parents=True, exist_ok=True)
                os.replace(stage, final)
            index["active"][document["id"]] = document["version"]
            index.get("inactive", {}).pop(document["id"], None)
            _write_index(root, index)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    return final


def activate_version(root, voice, version, *, engines=None, resources=None):
    """Rollback to a previously installed and fully verified immutable version."""
    if not IDENTIFIER.fullmatch(voice) or not VERSION.fullmatch(version):
        raise PackageError("Invalid voice identity or version")
    require_voice_allowed(voice)
    root = Path(root).resolve()
    with _installation_lock(root):
        directory = _asset_path(root, voice + "/" + version)
        document = load_manifest(directory / MANIFEST_NAME)
        if document["id"] != voice or document["version"] != version:
            raise PackageError("Voice identity differs from the installed directory")
        _compatible(document, engines, resources)
        verify_assets(directory, document)
        index = _load_index(root)
        index["active"][voice] = version
        index.get("inactive", {}).pop(voice, None)
        _write_index(root, index)
    return directory


def installed_versions(root, voice):
    """List valid version metadata without hashing acoustic files in the UI."""
    if not isinstance(voice, str) or not IDENTIFIER.fullmatch(voice):
        raise PackageError("Invalid voice identifier")
    root = Path(root).resolve()
    directory = _asset_path(root, voice)
    if not directory.is_dir():
        return []
    result = []
    for version in sorted(directory.iterdir(), key=lambda path: path.name):
        if not VERSION.fullmatch(version.name):
            continue
        try:
            path = _asset_path(root, voice + "/" + version.name)
            document = load_manifest(path / MANIFEST_NAME)
            if document["id"] == voice and document["version"] == version.name:
                verify_assets(path, document, hashes=False)
                result.append(document)
        except (OSError, ValueError, TypeError):
            continue
    return result


def uninstall_package(root, voice, *, keep_files=False):
    """Deactivate durably, retaining ownership until disk cleanup succeeds.

    An inactive tombstone is administrative only: speech discovery never reads
    it. Failed or interrupted deletion can therefore be retried without making
    a partially deleted voice active or losing its entry from the package UI.
    """
    if not isinstance(voice, str) or not IDENTIFIER.fullmatch(voice):
        raise PackageError("Invalid voice identifier")
    root = Path(root).resolve()
    if not root.exists():
        raise PackageError("The voice package directory does not exist")
    with _installation_lock(root):
        index = _load_index(root)
        directory = _asset_path(root, voice)
        version = index["active"].get(voice, index.get("inactive", {}).get(voice))
        if version is None:
            raise PackageError("The voice package is not registered")
        # Commit ownership before touching data. A failure here leaves the
        # previously active installation completely unchanged.
        index["active"].pop(voice, None)
        index.setdefault("inactive", {})[voice] = version
        _write_index(root, index)
        if not keep_files:
            if directory.exists():
                shutil.rmtree(directory)
            # If this commit fails, the durable inactive record still allows
            # an idempotent retry even when every data file is already gone.
            index["inactive"].pop(voice)
            _write_index(root, index)
    return directory


def discover_packages(root, *, engines=None, resources=None):
    """Read small active manifests; incompatible/damaged entries are not exposed."""
    root = Path(root).resolve()
    try:
        index = _load_index(root)
    except (OSError, ValueError, TypeError):
        return {}
    found = {}
    for voice, version in index["active"].items():
        try:
            directory = _asset_path(root, voice + "/" + version)
            document = load_manifest(directory / MANIFEST_NAME)
            if document["id"] != voice or document["version"] != version:
                continue
            _compatible(document, engines, resources)
            verify_assets(directory, document, hashes=False)
            found[voice] = {**document, "directory": str(directory)}
        except (OSError, ValueError, TypeError):
            continue
    return found


def list_installed_packages(root):
    """Administrative metadata, including damaged entries that can be removed."""
    root = Path(root).resolve()
    index = _load_index(root)
    result = []
    entries = {**index["active"], **index.get("inactive", {})}
    for voice, version in entries.items():
        active = voice in index["active"]
        entry = {"id": voice, "version": version, "name": voice,
                 "status": "unavailable", "active": active}
        try:
            directory = _asset_path(root, voice + "/" + version)
            document = load_manifest(directory / MANIFEST_NAME)
            if document["id"] != voice or document["version"] != version:
                raise PackageError("Installed voice identity differs")
            entry.update({key: value for key, value in document.items() if key != "files"})
            verify_assets(directory, document, hashes=False)
            entry["status"] = "installed" if active else "inactive"
            entry["active"] = active
        except (OSError, ValueError, TypeError):
            pass
        result.append(entry)
    return result
