"""Preserve verified optional packages when NVDA replaces the add-on folder.

Only registered resource files and validated immutable voice-package versions
are copied. The old installation is never removed or rewritten. An incompatible
collision aborts installation, allowing NVDA to keep the old add-on active.
"""
from contextlib import ExitStack
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile


def _component(name):
    key = "_dordiai_upgrade_" + name
    module = sys.modules.get(key)
    if module is None:
        spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name + ".py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[key] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(key, None)
            raise
    return module


class UpgradeError(ValueError):
    pass


def _metadata(root, path, maximum=8 * 1024 * 1024):
    manager = _component("package_manager")
    target = root / path
    if target.is_symlink() or not target.resolve().is_relative_to(root) or target.stat().st_size > maximum:
        raise UpgradeError("Небезпечний або завеликий опис установлених пакетів: " + path)
    return json.loads(target.read_text(encoding="utf-8"))


def _record(manager, name, value):
    manager._resource_path(name)
    if (not isinstance(value, dict) or type(value.get("size_bytes")) is not int
            or value["size_bytes"] < 0 or not re.fullmatch(r"[0-9a-f]{64}", str(value.get("sha256", "")))):
        raise UpgradeError("Некоректний опис установленого ресурсу: " + name)
    return {"size_bytes": value["size_bytes"], "sha256": value["sha256"]}


def migrate_installed_packages(old_root, new_root):
    """Migrate into NVDA's pendingInstall tree; hash every copied asset.

    Returns counts, not a claim that an acoustic engine has run. All validation
    and staging precede changes to the destination registry. A caught failure
    restores its prior metadata and removes only files created by this attempt.
    """
    old_root, new_root = Path(old_root).resolve(), Path(new_root).resolve()
    if old_root == new_root or not old_root.is_dir():
        return {"resource_packs": 0, "voice_versions": 0, "copied_files": 0}
    manager, packages, assets = (_component(name) for name in ("package_manager", "voice_packages", "voice_assets"))
    old_registry = manager._state_path(old_root)
    old_voices = old_root / "kx47Runtime/models/voices/packages"
    if not old_registry.exists() and not (old_voices / packages.INDEX_NAME).exists():
        return {"resource_packs": 0, "voice_versions": 0, "copied_files": 0}
    if manager._journal_path(old_root).exists():
        raise UpgradeError("Перед оновленням завершіть відновлення перерваного встановлення пакетів.")
    if old_registry.exists():
        _metadata(old_root, "kx47Runtime/installed_resource_packs.json")
    if (old_voices / packages.INDEX_NAME).exists():
        manager._destination(old_root, "kx47Runtime/models/voices/packages/" + packages.INDEX_NAME)
    if (new_root / "kx47Runtime").is_symlink():
        raise UpgradeError("Посилання замість папки нового рушія.")
    new_root.mkdir(parents=True, exist_ok=True)
    with ExitStack() as locks:
        locks.enter_context(manager._locked(old_root))
        locks.enter_context(manager._locked(new_root))
        if (old_voices / packages.INDEX_NAME).exists():
            locks.enter_context(packages._installation_lock(old_voices))
        state, destination_state = manager._state(old_root), manager._state(new_root)
        core_version = manager._core_version(new_root)
        core_manifest = new_root / "dordiai-release.json"
        core_files = None
        if core_manifest.exists():
            core_document = _metadata(new_root, "dordiai-release.json")
            if core_document.get("format") != "dordiai-core-release" or not isinstance(core_document.get("files"), dict):
                raise UpgradeError("Некоректний опис нового ядра.")
            core_files = {name.casefold() for name in core_document["files"]}
        pending, owners, planned = dict(destination_state["packs"]), {}, {}
        for identity, pack in pending.items():
            for name in pack.get("files", {}):
                if name.casefold() in owners:
                    raise UpgradeError("Дубльоване володіння ресурсом у новому встановленні.")
                owners[name.casefold()] = identity

        def plan(name, source, record):
            manager._resource_path(name)
            if name in planned:
                previous = planned[name]
                if previous[1] != record:
                    raise UpgradeError("Несумісні записи одного ресурсу: " + name)
                return
            if source.is_symlink() or not source.is_file() or source.stat().st_size != record["size_bytes"] or manager._hash(source) != record["sha256"]:
                raise UpgradeError("Установлений ресурс пошкоджено або змінено: " + name)
            destination = manager._destination(new_root, name)
            if destination.exists():
                if not destination.is_file() or destination.stat().st_size != record["size_bytes"] or manager._hash(destination) != record["sha256"]:
                    raise UpgradeError("Ресурс конфліктує з новим ядром або пакетом: " + name)
            else:
                planned[name] = (source, record)

        for identity, original in state["packs"].items():
            if (not manager._ID.fullmatch(str(identity)) or not isinstance(original, dict)
                    or original.get("id") != identity or original.get("format") != manager.FORMAT
                    or type(original.get("format_version")) is not int or original["format_version"] != 1):
                raise UpgradeError("Некоректний реєстр пакетів попередньої версії.")
            if core_version < manager._version(original.get("minimum_core_version", "")):
                raise UpgradeError("Мовний пакет потребує новішого ядра: " + identity)
            manager._version(original.get("version", ""))
            dependencies = original.get("dependencies", [])
            if not isinstance(dependencies, list) or any(not isinstance(x, str) or x not in state["packs"] for x in dependencies):
                raise UpgradeError("Відсутня залежність установленого мовного пакета: " + identity)
            if identity in pending and pending[identity].get("version") != original["version"]:
                raise UpgradeError("Різні версії мовного пакета в новому встановленні: " + identity)
            declared, folded = {}, set()
            for field in ("files", "provided_by_core"):
                records = original.get(field, {})
                if not isinstance(records, dict):
                    raise UpgradeError("Некоректний перелік установлених файлів.")
                for name, value in records.items():
                    if name.casefold() in folded:
                        raise UpgradeError("Дубльований установлений ресурс: " + name)
                    folded.add(name.casefold())
                    declared[name] = _record(manager, name, value)
            owned, provided = {}, {}
            for name, value in declared.items():
                owner = owners.get(name.casefold())
                if owner is not None and owner != identity:
                    raise UpgradeError("Ресурс належить іншому пакету: " + name)
                plan(name, manager._destination(old_root, name), value)
                target = manager._destination(new_root, name)
                is_core = target.exists() and (name.casefold() in core_files if core_files is not None else owner is None)
                (provided if is_core else owned)[name] = value
                if not is_core:
                    owners[name.casefold()] = identity
            allowed_fields = ("format", "format_version", "id", "name", "version", "minimum_core_version", "dependencies", "languages", "engine_ids")
            migrated = {key: original[key] for key in allowed_fields if key in original}
            migrated.update(files=owned, provided_by_core=provided)
            pending[identity] = migrated

        resources = {identity: value["version"] for identity, value in pending.items()}
        manifest_text = (new_root / "manifest.ini").read_text(encoding="utf-8-sig")
        match = re.search(r'^version\s*=\s*[\"\']?([^\"\'\s]+)', manifest_text, re.MULTILINE)
        resources["core"] = match.group(1)
        new_voices = new_root / "kx47Runtime/models/voices/packages"
        old_index = packages._load_index(old_voices)
        destination_index = packages._load_index(new_voices)
        active = dict(destination_index["active"])
        versions = 0
        found = set()
        if old_voices.exists():
            for voice_dir in sorted(old_voices.iterdir()):
                if not voice_dir.is_dir() or not packages.IDENTIFIER.fullmatch(voice_dir.name):
                    continue
                packages.require_voice_allowed(voice_dir.name)
                if voice_dir.is_symlink():
                    raise UpgradeError("Посилання замість каталогу голосу.")
                for version_dir in sorted(voice_dir.iterdir()):
                    if not version_dir.is_dir() or not packages.VERSION.fullmatch(version_dir.name):
                        continue
                    if version_dir.is_symlink():
                        raise UpgradeError("Посилання замість версії голосу.")
                    document = packages.load_manifest(version_dir / packages.MANIFEST_NAME)
                    assets.validate_adapter(document)
                    if document["id"] != voice_dir.name or document["version"] != version_dir.name:
                        raise UpgradeError("Ідентифікатор голосового пакета не відповідає його папці.")
                    packages._compatible(document, assets.ENGINE_ADAPTERS, resources)
                    packages.verify_assets(version_dir, document)
                    relative_dir = "kx47Runtime/models/voices/packages/" + voice_dir.name + "/" + version_dir.name
                    existing_manifest = new_root / relative_dir / packages.MANIFEST_NAME
                    if existing_manifest.exists() and packages.load_manifest(existing_manifest) != document:
                        raise UpgradeError("Версія голосу в новому встановленні має інший опис.")
                    for name, record in document["files"].items():
                        plan(relative_dir + "/" + name, manager._destination(old_root, relative_dir + "/" + name), _record(manager, relative_dir + "/" + name, record))
                    manifest_record = {"size_bytes": (version_dir / packages.MANIFEST_NAME).stat().st_size,
                                       "sha256": manager._hash(version_dir / packages.MANIFEST_NAME)}
                    plan(relative_dir + "/" + packages.MANIFEST_NAME, version_dir / packages.MANIFEST_NAME, manifest_record)
                    found.add((voice_dir.name, version_dir.name))
                    versions += 1
        for voice, version in old_index["active"].items():
            if (voice, version) not in found:
                raise UpgradeError("Не знайдено активної версії голосу: " + voice)
            if voice in active and active[voice] != version:
                raise UpgradeError("Конфлікт активної версії голосу: " + voice)
            active[voice] = version

        metadata = {manager._state_path(new_root): {"format_version": 1, "packs": pending}}
        if old_index["active"] or versions:
            metadata[new_voices / packages.INDEX_NAME] = {"format_version": 1, "active": active}
        originals = {path: path.read_bytes() if path.exists() else None for path in metadata}
        needed = sum(record["size_bytes"] for _, record in planned.values())
        if shutil.disk_usage(new_root).free < needed + 32 * 1024 * 1024:
            raise UpgradeError("Недостатньо місця для збереження додаткових пакетів під час оновлення.")
        with tempfile.TemporaryDirectory(prefix=".dordiai-upgrade-", dir=new_root) as temporary:
            temporary = Path(temporary)
            for name, (source, record) in planned.items():
                destination = temporary / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
                if destination.stat().st_size != record["size_bytes"] or manager._hash(destination) != record["sha256"]:
                    raise UpgradeError("Ресурс змінився під час перенесення: " + name)
            created = []
            try:
                for name in sorted(planned):
                    destination = manager._destination(new_root, name)
                    if destination.exists():
                        raise UpgradeError("Місце перенесення зайнято іншим процесом: " + name)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    manager.os.replace(temporary / name, destination)
                    created.append(destination)
                for path, value in metadata.items():
                    manager._atomic_json(path, value)
            except BaseException:
                for path, original in originals.items():
                    if original is None:
                        path.unlink(missing_ok=True)
                    else:
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(original)
                for path in reversed(created):
                    path.unlink(missing_ok=True)
                raise
        return {"resource_packs": len(state["packs"]), "voice_versions": versions, "copied_files": len(planned)}
