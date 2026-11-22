"""Resolve installed voice data for the existing engine adapters.

Data is immutable per version. Small index signatures invalidate discovery;
SHA-256 is checked only on first asset use, and again if its file signature
changes. A package never supplies Python code or an arbitrary model loader.
"""
from functools import lru_cache
from hashlib import sha256
import json
from pathlib import Path

try:
    import voice_packages as _packages
except ImportError:
    import importlib.util
    import sys
    _package_name = "_dordiai_local_voice_packages"
    _packages = sys.modules.get(_package_name)
    if _packages is None:
        _spec = importlib.util.spec_from_file_location(_package_name, Path(__file__).with_name("voice_packages.py"))
        _packages = importlib.util.module_from_spec(_spec)
        sys.modules[_package_name] = _packages
        try:
            _spec.loader.exec_module(_packages)
        except Exception:
            sys.modules.pop(_package_name, None)
            raise
INDEX_NAME = _packages.INDEX_NAME
PackageError = _packages.PackageError
_asset_path = _packages._asset_path
discover_packages = _packages.discover_packages
validate_manifest = _packages.validate_manifest
inspect_package = _packages.inspect_package
install_package = _packages.install_package
require_voice_allowed = _packages.require_voice_allowed


ENGINE_ADAPTERS = {"holos": 1, "openvoice": 1, "omnivoice": 1}
REQUIRED_ROLES = {
    "holos": frozenset({"holos_profile"}),
    "openvoice": frozenset({"target_embedding"}),
    "omnivoice": frozenset({"reference_audio", "reference_text"}),
}
SUPPORTED_STYLES = {engine: frozenset({"neutral"}) for engine in ENGINE_ADAPTERS}


def package_root(references):
    return Path(references).resolve() / "packages"


def _signature(path):
    try:
        info = Path(path).stat()
        return info.st_mtime_ns, info.st_size, info.st_ctime_ns, info.st_ino
    except OSError:
        return None


@lru_cache(maxsize=4)
def _shared_resources(index_path, index_signature, manifest_path, manifest_signature):
    resources = {}
    if manifest_signature is not None and manifest_signature[1] < 1024 * 1024:
        for line in Path(manifest_path).read_text(encoding="utf-8-sig").splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip() == "version":
                resources["core"] = value.strip().strip('"')
                break
    if index_signature is not None and index_signature[1] <= 2 * 1024 * 1024:
        try:
            document = json.loads(Path(index_path).read_text(encoding="utf-8"))
            packs = document.get("packs", {}) if isinstance(document, dict) else {}
            if isinstance(packs, dict):
                for package_id, entry in packs.items():
                    if isinstance(package_id, str) and isinstance(entry, dict) and isinstance(entry.get("version"), str):
                        resources[package_id] = entry["version"]
        except (OSError, ValueError, TypeError):
            pass
    return resources


def shared_resource_versions():
    index = Path(__file__).with_name("installed_resource_packs.json")
    manifest = Path(__file__).resolve().parents[1] / "manifest.ini"
    return dict(_shared_resources(str(index), _signature(index), str(manifest), _signature(manifest)))


def validate_adapter(document):
    """Do not expose prepared assets through an adapter that cannot use them."""
    validate_manifest(document)
    engine = document["engine"]["id"]
    if ENGINE_ADAPTERS.get(engine) != document["engine"]["compatibility_version"]:
        raise PackageError("The voice requires an unsupported engine adapter")
    roles = [value["role"] for value in document["files"].values()]
    if len(roles) != len(set(roles)):
        raise PackageError("An adapter asset role must identify exactly one file")
    if not REQUIRED_ROLES[engine] <= set(roles):
        raise PackageError("The voice is missing required engine profile data")
    for prefix in ("native_letters", "native_commands"):
        pair = {prefix + "_index", prefix + "_audio"}
        if pair.intersection(roles) and not pair <= set(roles):
            raise PackageError("The prepared voice bank must include both index and audio")
    if not set(document.get("styles", ["neutral"])) <= SUPPORTED_STYLES[engine]:
        raise PackageError("This adapter currently supports neutral speech only")
    for name, value in document["files"].items():
        if value["role"] == "pocket_russian_prompt" and Path(name).name != document["id"] + ".safetensors":
            raise PackageError("The native Russian profile filename must match the voice identity")
    return document


@lru_cache(maxsize=8)
def _discovered(root, signature, engine_id, resource_versions):
    result = {}
    for voice, document in discover_packages(root, engines=ENGINE_ADAPTERS, resources=dict(resource_versions)).items():
        try:
            validate_adapter(document)
        except (ValueError, TypeError):
            continue
        if engine_id is None or document["engine"]["id"] == engine_id:
            result[voice] = document
    return result


def discover_voices(references, engine_id=None):
    root = package_root(references)
    # Installing, rollback and removal all atomically replace the active index.
    resources = tuple(sorted(shared_resource_versions().items()))
    return dict(_discovered(str(root), _signature(root / INDEX_NAME), engine_id, resources))


def clear_cache():
    _discovered.cache_clear()
    _verified.cache_clear()
    _native_settings.cache_clear()
    _shared_resources.cache_clear()
    _active_ids.cache_clear()


def install_voice_package(package, references, *, engine_id="holos", resources=None):
    """UI entry point: accept only data usable by the active adapter."""
    document = validate_adapter(inspect_package(package))
    if document["engine"]["id"] != engine_id:
        raise PackageError("The voice is incompatible with the active synthesizer engine")
    resources = shared_resource_versions() if resources is None else resources
    directory = install_package(package, package_root(references),
                                engines={engine_id: ENGINE_ADAPTERS[engine_id]}, resources=resources)
    clear_cache()
    return directory


def uninstall_voice_package(references, voice):
    try:
        return _packages.uninstall_package(package_root(references), voice)
    finally:
        clear_cache()


def activate_voice_version(references, voice, version, *, engine_id="holos", resources=None):
    directory = _packages._asset_path(package_root(references), voice + "/" + version)
    document = validate_adapter(_packages.load_manifest(directory / _packages.MANIFEST_NAME))
    if document["engine"]["id"] != engine_id:
        raise PackageError("The voice version is incompatible with the active engine")
    resources = shared_resource_versions() if resources is None else resources
    result = _packages.activate_version(package_root(references), voice, version,
                                        engines={engine_id: ENGINE_ADAPTERS[engine_id]}, resources=resources)
    clear_cache()
    return result


def voice_versions(references, voice):
    return _packages.installed_versions(package_root(references), voice)


@lru_cache(maxsize=8)
def _active_ids(root, signature):
    try:
        return frozenset(_packages._load_index(Path(root))["active"])
    except (OSError, ValueError, TypeError):
        return frozenset()


def _profile(references, profile):
    require_voice_allowed(profile)
    document = discover_voices(references).get(profile)
    if document is None:
        root = package_root(references)
        if profile in _active_ids(str(root), _signature(root / INDEX_NAME)):
            raise PackageError("The installed voice package is unavailable or incompatible: " + profile)
    return document


@lru_cache(maxsize=256)
def _verified(path, signature, expected, size):
    if signature is None or signature[1] != size:
        raise PackageError("Missing or wrong-size installed voice asset")
    digest = sha256()
    with Path(path).open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    if digest.hexdigest() != expected:
        raise PackageError("Installed voice asset checksum differs")
    return Path(path)


def asset_path(references, profile, role, *, required=False):
    """Return verified package data, or None for a built-in legacy profile.

    A managed voice missing a required role is an error, so it cannot silently
    borrow the acoustic identity of another speaker.
    """
    document = _profile(references, profile)
    if document is None:
        return None
    for name, value in document["files"].items():
        if value["role"] == role:
            path = _asset_path(document["directory"], name)
            return _verified(str(path), _signature(path), value["sha256"], value["size_bytes"])
    if required:
        raise PackageError("Installed voice is missing the required asset: " + role)
    return None


@lru_cache(maxsize=64)
def _native_settings(path, signature):
    if signature is None or signature[1] > 1024 * 1024:
        raise PackageError("Invalid native voice settings")
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(document, dict) or not set(document) <= {"en", "ru"}:
        raise PackageError("Invalid native voice language settings")
    for settings in document.values():
        if not isinstance(settings, dict) or not set(settings) <= {"gain", "tempo", "seed", "temperature"}:
            raise PackageError("Invalid native voice controls")
        for key, value in settings.items():
            if type(value) not in (int, float):
                raise PackageError("Native voice controls must be numeric")
            if key == "seed" and (type(value) is not int or not 0 <= value <= 0xFFFFFFFF):
                raise PackageError("Invalid native voice seed")
            if key == "gain" and not 0 < value <= 10:
                raise PackageError("Invalid native voice gain")
            if key == "tempo" and not .1 <= value <= 10:
                raise PackageError("Invalid native voice tempo")
            if key == "temperature" and not 0 <= value <= 5:
                raise PackageError("Invalid native voice temperature")
    return document


def native_settings(references, profile):
    path = asset_path(references, profile, "native_delivery")
    return dict(_native_settings(str(path), _signature(path))) if path is not None else {}


def supports_language(references, profile, language):
    document = _profile(references, profile)
    if document is None:
        return None  # Legacy capability is checked by the main catalog.
    code = language.lower().replace("_", "-")
    return any(code == available.lower() or code.split("-")[0] == available.lower()
               or ("-" not in code and available.lower().split("-")[0] == code)
               for available in document["languages"])
