"""Owned shared native lexical resource; exact evidence only, no language choice."""
from functools import lru_cache
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import stat
from threading import RLock

DESCRIPTOR_NAME = "native-word-membership.json"
DATASET_NAME = "native-word-membership.bin"
DESCRIPTOR_SHA256 = "2de5611c384e933e19d1cdf5fda37f17bd5c4b7602d09964f53fdb7280877459"
DATASET_SHA256 = "21208748a50ebf3f5dd3e2feb94f0f3caf3490c2be784aaca2209462380e6689"
DATASET_BYTES = 18661227
DATASET_WORDS = 6642550
CODES = ("uk", "ru")
NORMALIZATION = "nfc-casefold-cyrillic-acute-apostrophes-v1"
MAX_DESCRIPTOR = 65536
MAX_RELEASE_MANIFEST = 16 * 1024 * 1024


class NativeMembershipResourceError(RuntimeError):
    """Permanent configured-resource failure, distinct from ordinary unknown words."""


def is_resource_failure(error):
    return isinstance(error, NativeMembershipResourceError)


@lru_cache(maxsize=1)
def _host_paths():
    spec = importlib.util.spec_from_file_location(
        "_dordiai_membership_host_paths", Path(__file__).with_name("host_paths.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _filesystem_path(value):
    return _host_paths().filesystem_path(Path(value).absolute())


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise NativeMembershipResourceError("Повторений ключ опису словника.")
        result[key] = value
    return result


def _signature(path):
    for parent in (path, *path.parents):
        if parent.is_symlink() or getattr(parent, "is_junction", lambda: False)():
            raise NativeMembershipResourceError("Посилання замість файлу словника не дозволене.")
    try:
        info = path.stat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        raise NativeMembershipResourceError("Словник має бути звичайним файлом.")
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _read_json(path, limit):
    with path.open("rb") as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise NativeMembershipResourceError("Опис словника перевищує допустимий розмір.")
    return raw, json.loads(raw.decode("utf-8"), object_pairs_hook=_unique)


@lru_cache(maxsize=1)
def reader_module():
    spec = importlib.util.spec_from_file_location(
        "_dordiai_owned_membership_leaf", Path(__file__).with_name("native_word_membership.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Resource:
    """Hash-trusted descriptor, read-only reader and change checks, all owned."""
    def __init__(self, models, addon_root=None, *, reader_factory=None,
                 descriptor_sha256=DESCRIPTOR_SHA256, dataset_sha256=DATASET_SHA256,
                 dataset_bytes=DATASET_BYTES, dataset_words=DATASET_WORDS):
        self.models = _filesystem_path(models)
        self.addon_root = _filesystem_path(addon_root) if addon_root is not None else self.models.parent.parent
        folder = self.models / "WordLanguage"
        self.descriptor = folder / DESCRIPTOR_NAME
        self.dataset = folder / DATASET_NAME
        self.release = self.addon_root / "dordiai-release.json"
        self.paths = (self.descriptor, self.dataset, self.release)
        self.reader = None
        self.closed = False
        self.enabled = False
        self._lock = RLock()
        try:
            before = tuple(_signature(path) for path in self.paths)
            records = {}
            if before[2] is not None:
                _, release = _read_json(self.release, MAX_RELEASE_MANIFEST)
                if (not isinstance(release, dict) or release.get("format") != "dordiai-core-release"
                        or release.get("format_version") != 1 or not isinstance(release.get("files"), dict)):
                    raise NativeMembershipResourceError("Пошкоджений опис установленого синтезатора.")
                files = release["files"]
                records = {name: files.get("kx47Runtime/models/WordLanguage/" + name)
                           for name in (DESCRIPTOR_NAME, DATASET_NAME)}
            expected = any(value is not None for value in records.values())
            self.enabled = expected or before[0] is not None or before[1] is not None
            self.snapshot = before
            if not self.enabled:
                return  # An old core/source checkout genuinely has no native dictionary.
            if before[0] is None or before[1] is None:
                raise NativeMembershipResourceError("Файл установленого мовного словника відсутній.")
            raw, descriptor = _read_json(self.descriptor, MAX_DESCRIPTOR)
            if sha256(raw).hexdigest() != descriptor_sha256:
                raise NativeMembershipResourceError("Контрольна сума опису мовного словника не збігається.")
            if (not isinstance(descriptor, dict)
                    or descriptor.get("format") != "dordiai-native-word-membership-resource"
                    or descriptor.get("format_version") != 1 or descriptor.get("filename") != DATASET_NAME
                    or descriptor.get("sha256") != dataset_sha256 or descriptor.get("bytes") != dataset_bytes
                    or descriptor.get("codes") != list(CODES) or descriptor.get("word_count") != dataset_words
                    or descriptor.get("normalization") != NORMALIZATION
                    or descriptor.get("binary_format") != "DMLX0001"):
                raise NativeMembershipResourceError("Непідтримуваний або змінений опис мовного словника.")
            if expected:
                for name, size, digest in ((DESCRIPTOR_NAME, len(raw), descriptor_sha256),
                                          (DATASET_NAME, dataset_bytes, dataset_sha256)):
                    record = records.get(name)
                    if (not isinstance(record, dict) or record.get("size_bytes") != size
                            or record.get("sha256") != digest):
                        raise NativeMembershipResourceError("Опис випуску не відповідає мовному словнику.")
            if before[1][2] != dataset_bytes:
                raise NativeMembershipResourceError("Розмір мовного словника не збігається.")
            factory = reader_factory or reader_module().MembershipLexicon
            self.reader = factory(self.dataset, dataset_sha256)
            if tuple(self.reader.codes) != CODES or self.reader.word_count != dataset_words:
                raise NativeMembershipResourceError("Таблиця мов або кількість слів словника не збігається.")
            self._verify()
        except InterruptedError:
            self.close()
            raise
        except Exception as error:
            self.close()
            if isinstance(error, NativeMembershipResourceError):
                raise
            raise NativeMembershipResourceError("Не вдалося перевірити мовний словник.") from error

    def _verify(self):
        if self.closed:
            if self.enabled:
                raise NativeMembershipResourceError("Мовний словник закрито. Повторно виберіть синтезатор.")
            return
        if tuple(_signature(path) for path in self.paths) != self.snapshot:
            raise NativeMembershipResourceError("Мовний словник змінився. Повторно виберіть синтезатор.")
        if self.reader is not None:
            self.reader.verify_current()

    def candidates(self, word):
        if not isinstance(word, str):
            raise TypeError("Native lexical membership requires a word string")
        with self._lock:
            try:
                self._verify()
                if not self.enabled:
                    return frozenset()
                result = frozenset(self.reader.candidates(word))
                if not result <= frozenset(CODES):
                    raise NativeMembershipResourceError("Мовний словник повернув невідому мову.")
                return result
            except InterruptedError:
                raise
            except Exception as error:
                if isinstance(error, NativeMembershipResourceError):
                    raise
                raise NativeMembershipResourceError("Помилка читання мовного словника.") from error

    def close(self):
        with self._lock:
            if self.reader is not None:
                self.reader.close()
                self.reader = None
            self.closed = True


_lock = RLock()
_resource = None
_leases = set()
_maintenance = None


def acquire(models, addon_root=None):
    """Each driver owns one lease; a newer driver's reader is never closed by an old lease."""
    global _resource
    key = (_filesystem_path(models), _filesystem_path(addon_root) if addon_root is not None else None)
    with _lock:
        if _maintenance is not None:
            raise RuntimeError("Триває оновлення пакетів dordiai-voices.")
        if _resource is not None and _leases:
            if (_resource.models, _resource.addon_root) != (
                    key[0], key[1] if key[1] is not None else key[0].parent.parent):
                raise RuntimeError("Інший екземпляр ще використовує мовний словник.")
            _resource._verify()
        else:
            candidate = Resource(models, addon_root)
            try:
                if _resource is not None:
                    _resource.close()
            except BaseException:
                candidate.close()
                raise
            _resource = candidate
        token = object()
        _leases.add(token)
        return token


def release(token):
    with _lock:
        if token not in _leases:
            return False
        _leases.remove(token)
        if not _leases and _resource is not None:
            _resource.close()
        return True


def candidates(word):
    # Every speech_text instance consults this ONE registered manager; no primary
    # evidence ever enters the legacy frequency or wide decision LRU.
    with _lock:
        if _resource is None:
            return frozenset()
        return _resource.candidates(word)


def begin_maintenance(token, owner_tokens):
    global _maintenance
    with _lock:
        if _maintenance is not None:
            raise RuntimeError("Оновлення мовного словника вже триває.")
        if _leases - set(owner_tokens):
            raise RuntimeError("Мовний словник зайнятий іншим екземпляром.")
        _maintenance = (token, frozenset(owner_tokens))


def quiesce(token):
    with _lock:
        if _maintenance is None or _maintenance[0] is not token:
            raise RuntimeError("Втрачено право завершення мовного словника.")
        if _leases - _maintenance[1]:
            raise RuntimeError("Новий екземпляр використовує мовний словник.")
        # Caller has joined all captured producers before reaching this method.
        _leases.difference_update(_maintenance[1])
        if _resource is not None:
            _resource.close()


def end_maintenance(token):
    global _maintenance
    with _lock:
        if _maintenance is not None and _maintenance[0] is token:
            _maintenance = None
            return True
        return False
