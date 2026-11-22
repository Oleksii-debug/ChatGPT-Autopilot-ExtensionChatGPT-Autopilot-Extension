"""Verified directory spellings for eSpeak's legacy narrow data-path ABI.

Modern Python/ONNX paths retain their extended namespace. Only the directory
argument consumed by this C API uses a verified ordinary ASCII spelling.
"""
import ctypes
import ntpath
import os
from pathlib import Path
import stat

from windows_runtime import extended_windows_path

_WINDOWS = os.name == "nt"
_REQUIRED = ("phontab", "phonindex", "phondata")
_MAX_PATH_BYTES = 260


class LegacyDataPathUnsupported(OSError):
    """No verified spelling supported by the legacy narrow path ABI."""


def _ordinary_windows_path(value):
    if value.upper().startswith("\\\\?\\UNC\\"):
        return "\\\\" + value[8:]
    if value.startswith("\\\\?\\"):
        return value[4:]
    if value.startswith("\\\\.\\"):
        raise LegacyDataPathUnsupported("Device paths are not legacy speech data directories")
    return value


def _fits_legacy_abi(value, tail_bytes):
    try:
        encoded = value.encode("ascii")
    except UnicodeEncodeError:
        return False
    return (ntpath.isabs(value) and bool(ntpath.splitdrive(value)[0]) and
            "/" not in value and "\0" not in value and
            len(encoded) + tail_bytes + 1 <= _MAX_PATH_BYTES)


def _short_windows_path(value):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    function = kernel.GetShortPathNameW
    function.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
    function.restype = ctypes.c_uint
    required = function(value, None, 0)
    if not 0 < required <= 32768:
        raise LegacyDataPathUnsupported("A short filesystem alias is unavailable for legacy speech data")
    output = ctypes.create_unicode_buffer(required)
    written = function(value, output, len(output))
    if not 0 < written < len(output):
        raise LegacyDataPathUnsupported("A short filesystem alias could not be verified for legacy speech data")
    return output.value


def _select_windows_spelling(value, tail_bytes):
    if type(tail_bytes) is not int or tail_bytes < 0:
        raise ValueError("Invalid measured legacy data-path tail")
    if tail_bytes + 1 >= _MAX_PATH_BYTES:
        raise LegacyDataPathUnsupported("Native data suffixes exceed the legacy path ABI")
    ordinary = _ordinary_windows_path(value)
    if _fits_legacy_abi(ordinary, tail_bytes):
        return ordinary, False
    alias = _ordinary_windows_path(_short_windows_path(value))
    if not _fits_legacy_abi(alias, tail_bytes):
        # Filesystems without 8.3 aliases may return the unchanged long name.
        raise LegacyDataPathUnsupported("Legacy speech data requires an unavailable short ASCII filesystem alias")
    return alias, True


def _data_relative(parent):
    # espeak_Initialize receives the parent containing espeak-ng-data, not
    # that data directory itself. Older/direct layouts are also recognized.
    candidates = []
    for name in ("espeak-ng-data", "espeak-data", ""):
        directory = parent / name if name else parent
        if directory.is_dir() and all((directory / leaf).is_file() for leaf in _REQUIRED):
            candidates.append(Path(name))
    if len(candidates) == 1:
        return candidates[0]
    if candidates:
        raise LegacyDataPathUnsupported("Multiple legacy speech data layouts are ambiguous")
    raise FileNotFoundError("Required legacy speech data files are missing")


def _inventory(parent, relative):
    directory = parent / relative
    entries = {Path("."): True, relative: True}
    for path in directory.rglob("*"):
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise LegacyDataPathUnsupported("Linked entries in legacy speech data are unsupported")
        if path.is_dir():
            entries[path.relative_to(parent)] = True
        elif path.is_file():
            entries[path.relative_to(parent)] = False
        else:
            raise LegacyDataPathUnsupported("The legacy speech data has an unsupported filesystem entry")
    return tuple(sorted(entries.items(), key=lambda entry: entry[0].as_posix()))


def _measured_tail(entries, require_ascii=True):
    maximum = 0
    for relative, directory in entries:
        name = "" if relative == Path(".") else relative.as_posix()
        try:
            size = len(name.encode("ascii" if require_ascii else "utf-8"))
        except UnicodeEncodeError as error:
            raise LegacyDataPathUnsupported("Non-ASCII names inside legacy speech data are unsupported") from error
        # C can append a separator and filename, or enumerate an empty
        # directory using separator + '*'. The final NUL is counted by
        # _fits_legacy_abi. Include the nested espeak-ng-data prefix.
        maximum = max(maximum, 1 + size + (2 if directory else 0))
    return maximum


def _signature(path, directory=False):
    info = path.stat()
    if not info.st_ino:
        raise LegacyDataPathUnsupported("The filesystem cannot verify legacy speech data identity")
    expected = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not expected:
        raise LegacyDataPathUnsupported("The legacy speech data has an unexpected filesystem type")
    # Both sides use the same path-based stat accessor, including ctime.
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def _signatures(folder, entries):
    return tuple(_signature(folder / relative, directory=directory) for relative, directory in entries)


class LegacyDataLocation:
    def __init__(self, original, alias, uses_short_alias=False, *,
                 relative=None, entries=None, snapshot=None):
        self.original = Path(original)
        self.alias = Path(alias)
        self.uses_short_alias = uses_short_alias
        self.data_relative = _data_relative(self.original) if relative is None else relative
        self._entries = _inventory(self.original, self.data_relative) if entries is None else entries
        self._snapshot = _signatures(self.original, self._entries) if snapshot is None else snapshot
        self.tail_bytes = _measured_tail(self._entries, require_ascii=_WINDOWS)
        self.verify()
        self.encoded = str(self.alias).encode("ascii" if _WINDOWS else "utf-8")

    def verify(self):
        for folder in (self.original, self.alias):
            if (_inventory(folder, self.data_relative) != self._entries or
                    _signatures(folder, self._entries) != self._snapshot):
                raise RuntimeError("Legacy speech data changed during initialization")
        for relative, _ in self._entries:
            if not os.path.samefile(self.original / relative, self.alias / relative):
                raise RuntimeError("The legacy speech data alias refers to a different filesystem object")


def prepare_legacy_data_path(folder):
    original = Path(folder).resolve(strict=True)
    relative = _data_relative(original)
    entries = _inventory(original, relative)
    snapshot = _signatures(original, entries)
    if not _WINDOWS:
        return LegacyDataLocation(original, original, relative=relative, entries=entries, snapshot=snapshot)
    canonical = extended_windows_path(original)
    tail_bytes = _measured_tail(entries)
    alias, short = _select_windows_spelling(canonical, tail_bytes)
    return LegacyDataLocation(canonical, alias, short, relative=relative, entries=entries, snapshot=snapshot)
