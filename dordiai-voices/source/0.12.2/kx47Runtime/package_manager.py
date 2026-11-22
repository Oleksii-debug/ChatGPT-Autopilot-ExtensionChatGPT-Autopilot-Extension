"""Install locally selected, checksum-verified model resource packs.

Packs are data archives, not NVDA add-ons. Their files have paths relative to
the add-on root and may only live below kx47Runtime/models. Existing core files
and files owned by other packs cannot be replaced. An interrupted Python
operation rolls its file changes back before releasing the installer lock.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import zipfile

try:
    from voice_policy import EXCLUDED_VOICE_IDS
except ImportError:
    # NVDA's dialog loads helpers by filename without changing global sys.path.
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
    EXCLUDED_VOICE_IDS = _policy.EXCLUDED_VOICE_IDS


MANIFEST = "dordiai-resource-pack.json"
FORMAT = "dordiai-resource-pack"
SCHEMA_VERSION = 1
MAX_BYTES = 5 * 1024**3
MAX_FILES = 20000
_ID = re.compile(r"[a-z][a-z0-9-]{0,79}\Z")
_SHA = re.compile(r"[0-9a-f]{64}\Z")


class PackageError(ValueError):
    """A resource pack is invalid or cannot be applied safely."""


def _root(addon_root=None):
    return Path(addon_root).resolve() if addon_root is not None else Path(__file__).resolve().parents[1]


def _state_path(root):
    return root / "kx47Runtime" / "installed_resource_packs.json"


def _journal_path(root):
    return root / "kx47Runtime" / ".resource-transaction.json"


def _state(root):
    path = _state_path(root)
    if not path.exists():
        return {"format_version": 1, "packs": {}}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise PackageError("Не вдалося прочитати реєстр встановлених пакетів.") from exc
    if not isinstance(value, dict) or value.get("format_version") != 1 or not isinstance(value.get("packs"), dict):
        raise PackageError("Непідтримуваний формат реєстру пакетів.")
    return value


def _atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".resource-state-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
            json.dump(value, output, ensure_ascii=False, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _write_state(root, state):
    _atomic_json(_state_path(root), state)


def _begin_transaction(root, directory, state, old_files, new_files):
    _atomic_json(_journal_path(root), {
        "format_version": 1, "directory": Path(directory).name,
        "prior_state": state, "old_files": old_files, "new_files": new_files,
    })


def _recover_transaction(root):
    """Roll an interrupted install/removal back before another operation starts.

    Each renamed resource is already complete. The journal is written before
    the first rename and retained if a Windows file lock prevents recovery.
    Unknown or externally modified files are preserved rather than guessed at.
    """
    journal = _journal_path(root)
    if not journal.exists():
        return
    try:
        transaction = json.loads(journal.read_text(encoding="utf-8"))
        name = transaction["directory"]
        if (transaction.get("format_version") != 1 or not isinstance(name, str)
                or not name.startswith((".dordiai-pack-", ".dordiai-remove-"))
                or Path(name).name != name):
            raise ValueError("Invalid transaction directory")
        directory = root / name
        if directory.is_symlink() or not directory.resolve().is_relative_to(root):
            raise ValueError("Unsafe transaction directory")
        old_files, new_files = transaction["old_files"], transaction["new_files"]
        for resource in set(old_files) | set(new_files):
            destination = _destination(root, resource)
            backup = directory / "backup" / resource
            if backup.is_symlink():
                raise ValueError("Unsafe backup")
            if resource in old_files:
                if backup.exists():
                    if _hash(backup) != old_files[resource]["sha256"]:
                        raise PackageError("Пошкоджено резервну копію: " + resource)
                elif not destination.is_file() or _hash(destination) != old_files[resource]["sha256"]:
                    raise PackageError("Не знайдено незмінений попередній файл: " + resource)
            if destination.exists():
                digest = _hash(destination)
                permitted = {record["sha256"] for record in [old_files.get(resource), new_files.get(resource)] if record}
                if digest not in permitted:
                    raise PackageError("Файл змінено після переривання; його збережено: " + resource)
        for resource in sorted(set(old_files) | set(new_files)):
            destination = _destination(root, resource)
            backup = directory / "backup" / resource
            if backup.exists():
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.replace(backup, destination)
            elif resource not in old_files:
                destination.unlink(missing_ok=True)
        _write_state(root, transaction["prior_state"])
        journal.unlink()
        shutil.rmtree(directory, ignore_errors=True)
    except PackageError:
        raise
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise PackageError("Не завершено відновлення перерваної операції з пакетами. Перезапустіть NVDA перед повтором.") from exc


def _resource_path(name):
    if not isinstance(name, str) or not name or "\\" in name or ":" in name or any(ord(c) < 32 or c in '<>"|?*' for c in name):
        raise PackageError("Небезпечний шлях у пакеті.")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or str(path) != name:
        raise PackageError("Небезпечний шлях у пакеті: " + name)
    if path.parts[:2] != ("kx47Runtime", "models") or len(path.parts) < 3:
        raise PackageError("Пакет ресурсів може містити лише kx47Runtime/models: " + name)
    if path.suffix.lower() in {".py", ".pyc", ".pyo", ".pth", ".bat", ".cmd", ".ps1"}:
        raise PackageError("Пакет ресурсів не може встановлювати сценарії: " + name)
    # Windows trims spaces/dots, supports device paths and alternate streams.
    reserved = {"con", "prn", "aux", "nul", "clock$", *("com" + str(i) for i in range(1, 10)), *("lpt" + str(i) for i in range(1, 10))}
    for part in path.parts:
        if part.endswith((" ", ".")) or part.split(".")[0].casefold() in reserved:
            raise PackageError("Неприпустимий для Windows шлях: " + name)
        if part.casefold() in EXCLUDED_VOICE_IDS or PurePosixPath(part).stem.casefold() in EXCLUDED_VOICE_IDS:
            raise PackageError("Ресурс виключеного голосу не встановлюється: " + name)
    return path


def _destination(root, name):
    parts = _resource_path(name).parts
    result = root.joinpath(*parts)
    current = root
    for part in parts:
        current /= part
        if current.is_symlink():
            raise PackageError("Символьне посилання в місці встановлення: " + name)
    if not result.resolve().is_relative_to(root):
        raise PackageError("Файл виходить за межі додатка: " + name)
    return result


def _hash(path):
    with Path(path).open("rb") as source:
        digest = hashlib.sha256()
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _version(value):
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$", str(value))
    if not match:
        raise PackageError("Некоректна версія пакета або ядра.")
    return tuple(map(int, match.groups()))


def _core_version(root):
    try:
        text = (root / "manifest.ini").read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise PackageError("Не знайдено manifest.ini синтезатора.") from exc
    match = re.search(r'^version\s*=\s*[\"\']?([^\"\'\s]+)', text, re.MULTILINE)
    if not match:
        raise PackageError("Не визначено версію ядра синтезатора.")
    return _version(match.group(1))


def _read_manifest(archive):
    infos = archive.infolist()
    if len(infos) > MAX_FILES + 1:
        raise PackageError("Забагато файлів у пакеті.")
    names = set()
    size = 0
    for info in infos:
        if info.is_dir():
            raise PackageError("Архів повинен містити лише перелічені файли.")
        key = info.filename.casefold()
        mode = stat.S_IFMT(info.external_attr >> 16)
        if key in names or mode not in (0, stat.S_IFREG) or info.flag_bits & 1:
            raise PackageError("Дубльований, зашифрований файл або посилання в пакеті.")
        names.add(key)
        if info.filename != MANIFEST:
            _resource_path(info.filename)
        size += info.file_size
        if size > MAX_BYTES:
            raise PackageError("Пакет перевищує граничний розмір.")
    try:
        meta_info = archive.getinfo(MANIFEST)
        if meta_info.file_size > 8 * 1024 * 1024:
            raise PackageError("Завеликий опис пакета.")
        meta = json.loads(archive.read(meta_info))
    except (KeyError, ValueError, UnicodeError) as exc:
        raise PackageError("Відсутній або пошкоджений опис пакета.") from exc
    if not isinstance(meta, dict) or meta.get("format") != FORMAT or meta.get("format_version") != SCHEMA_VERSION:
        raise PackageError("Непідтримуваний формат пакета ресурсів.")
    if not _ID.fullmatch(str(meta.get("id", ""))) or not isinstance(meta.get("name"), str) or not meta["name"].strip():
        raise PackageError("Некоректний ідентифікатор або назва пакета.")
    _version(meta.get("version", ""))
    _version(meta.get("minimum_core_version", ""))
    files = meta.get("files")
    if not isinstance(files, dict) or not files or len(files) > MAX_FILES:
        raise PackageError("Порожній або некоректний перелік файлів пакета.")
    declared = {MANIFEST.casefold()}
    for name, record in files.items():
        _resource_path(name)
        key = name.casefold()
        if key in declared or not isinstance(record, dict):
            raise PackageError("Дубльований або некоректний запис файла.")
        declared.add(key)
        amount = record.get("size_bytes")
        if type(amount) is not int or amount < 0 or not _SHA.fullmatch(str(record.get("sha256", ""))):
            raise PackageError("Некоректний розмір або контрольна сума файла.")
        try:
            if archive.getinfo(name).file_size != amount:
                raise PackageError("Розмір файла відрізняється від опису: " + name)
        except KeyError as exc:
            raise PackageError("Файл із опису відсутній: " + name) from exc
    if names != declared:
        raise PackageError("Склад архіву відрізняється від опису пакета.")
    dependencies = meta.get("dependencies", [])
    if not isinstance(dependencies, list) or any(not isinstance(x, str) or not _ID.fullmatch(x) for x in dependencies):
        raise PackageError("Некоректні залежності пакета.")
    if meta["id"] in dependencies:
        raise PackageError("Пакет не може залежати від самого себе.")
    return meta


@contextmanager
def _locked(root):
    root.mkdir(parents=True, exist_ok=True)
    lock = root / "kx47Runtime" / ".resource-install.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        try:
            pid = int(lock.read_text(encoding="ascii"))
            if pid <= 0:
                raise ValueError("Invalid lock owner")
            alive = _process_alive(pid)
        except (OSError, ValueError):
            raise PackageError("Інша операція з пакетами не завершена або її стан невідомий.") from exc
        if not alive:
            lock.unlink()
            try:
                fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError as active:
                raise PackageError("Інша операція з пакетами вже виконується.") from active
        else:
            raise PackageError("Інша операція з пакетами ще не завершена.") from exc
    try:
        os.write(fd, str(os.getpid()).encode("ascii"))
        os.close(fd)
        _recover_transaction(root)
        yield
    finally:
        lock.unlink(missing_ok=True)


def _process_alive(pid):
    if os.name == "nt":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if handle:
            kernel.CloseHandle(handle)
            return True
        error = ctypes.get_last_error()
        if error == 87:  # ERROR_INVALID_PARAMETER: PID does not exist.
            return False
        if error == 5:  # ERROR_ACCESS_DENIED: a protected live process.
            return True
        raise OSError(error, "Cannot inspect package lock owner")
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def list_installed_packs(addon_root=None):
    """Return metadata (without large file lists) suitable for an accessible UI."""
    state = _state(_root(addon_root))
    return [{key: value for key, value in pack.items() if key != "files"}
            for _, pack in sorted(state["packs"].items())]


def recover_pending_install(addon_root=None):
    """Recover a crash journal at startup, before model files are opened.

    Normal startup needs no lock or file write. If recovery cannot complete,
    callers should keep optional models disabled and report the precise error.
    """
    root = _root(addon_root)
    if not _journal_path(root).exists():
        return False
    with _locked(root):
        return True


def inspect_pack(archive_path):
    """Validate archive structure; install_pack additionally streams all hashes."""
    try:
        with zipfile.ZipFile(archive_path) as archive:
            return _read_manifest(archive)
    except (zipfile.BadZipFile, OSError) as exc:
        raise PackageError("Не вдалося відкрити пакет ресурсів.") from exc


def install_pack(archive_path, addon_root=None):
    root = _root(addon_root)
    with _locked(root):
        state = _state(root)
        try:
            archive = zipfile.ZipFile(archive_path)
        except (zipfile.BadZipFile, OSError) as exc:
            raise PackageError("Не вдалося відкрити пакет ресурсів.") from exc
        with archive:
            meta = _read_manifest(archive)
            if _core_version(root) < _version(meta["minimum_core_version"]):
                raise PackageError("Потрібне новіше ядро dordiai-voices.")
            for dependency in meta.get("dependencies", []):
                if dependency not in state["packs"]:
                    raise PackageError("Спочатку встановіть залежність: " + dependency)
            previous = state["packs"].get(meta["id"], {})
            old_files = previous.get("files", {})
            owners = {name.casefold(): pack_id for pack_id, pack in state["packs"].items()
                      for name in pack.get("files", {})}
            for name in set(old_files) | set(meta["files"]):
                target = _destination(root, name)
                owner = owners.get(name.casefold())
                if owner is not None and owner != meta["id"]:
                    raise PackageError("Файл належить іншому пакету: " + name)
                if target.exists() and name not in old_files:
                    raise PackageError("Пакет не може замінити наявний файл ядра: " + name)
                if name in old_files and (not target.is_file() or _hash(target) != old_files[name]["sha256"]):
                    raise PackageError("Встановлений файл змінено; автоматична заміна скасована: " + name)
            total = sum(value["size_bytes"] for value in meta["files"].values())
            if shutil.disk_usage(root).free < total + 32 * 1024 * 1024:
                raise PackageError("Недостатньо вільного місця для перевірки та встановлення пакета.")
            # A process crash must leave both the journal and backup directory
            # available for the next invocation's recovery.
            temporary = Path(tempfile.mkdtemp(prefix=".dordiai-pack-", dir=root))
            try:
                staged, backup = temporary / "staged", temporary / "backup"
                for name, record in meta["files"].items():
                    target = staged.joinpath(*PurePosixPath(name).parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    digest = hashlib.sha256()
                    written = 0
                    # Exclusive creation also catches Windows short-name aliases
                    # that collide despite having different Unicode spellings.
                    with archive.open(name) as source, target.open("xb") as output:
                        for block in iter(lambda: source.read(1024 * 1024), b""):
                            written += len(block)
                            if written > record["size_bytes"]:
                                raise PackageError("Файл перевищує заявлений розмір: " + name)
                            digest.update(block)
                            output.write(block)
                        output.flush()
                        os.fsync(output.fileno())
                    if written != record["size_bytes"] or digest.hexdigest() != record["sha256"]:
                        raise PackageError("Контрольна сума файла не збігається: " + name)
                _begin_transaction(root, temporary, state, old_files, meta["files"])
                try:
                    for name in sorted(old_files):
                        target = _destination(root, name)
                        saved_path = backup.joinpath(*PurePosixPath(name).parts)
                        saved_path.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(target, saved_path)
                    for name in sorted(meta["files"]):
                        target = _destination(root, name)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(staged.joinpath(*PurePosixPath(name).parts), target)
                    updated = dict(state, packs=dict(state["packs"], **{meta["id"]: meta}))
                    _write_state(root, updated)
                except BaseException:
                    _recover_transaction(root)
                    raise
                _journal_path(root).unlink()
            finally:
                if not _journal_path(root).exists():
                    shutil.rmtree(temporary, ignore_errors=True)
            return {"id": meta["id"], "version": meta["version"], "restart_required": True,
                    "installed_files": len(meta["files"]), "installed_bytes": total}


def uninstall_pack(pack_id, addon_root=None):
    root = _root(addon_root)
    with _locked(root):
        state = _state(root)
        if pack_id not in state["packs"]:
            raise PackageError("Пакет не встановлено: " + str(pack_id))
        for other_id, other in state["packs"].items():
            if other_id != pack_id and pack_id in other.get("dependencies", []):
                raise PackageError("Від цього пакета залежить: " + other_id)
        meta = state["packs"][pack_id]
        for name, record in meta["files"].items():
            target = _destination(root, name)
            if not target.is_file() or _hash(target) != record["sha256"]:
                raise PackageError("Файл змінено або відсутній; автоматичне видалення скасоване: " + name)
        temporary = Path(tempfile.mkdtemp(prefix=".dordiai-remove-", dir=root))
        try:
            _begin_transaction(root, temporary, state, meta["files"], {})
            saved = []
            try:
                for name in sorted(meta["files"]):
                    backup = temporary / "backup" / name
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(_destination(root, name), backup)
                    saved.append(name)
                packs = {key: value for key, value in state["packs"].items() if key != pack_id}
                _write_state(root, dict(state, packs=packs))
            except BaseException:
                _recover_transaction(root)
                raise
            _journal_path(root).unlink()
        finally:
            if not _journal_path(root).exists():
                shutil.rmtree(temporary, ignore_errors=True)
        return {"id": pack_id, "removed_files": len(saved), "restart_required": True}


remove_pack = uninstall_pack
