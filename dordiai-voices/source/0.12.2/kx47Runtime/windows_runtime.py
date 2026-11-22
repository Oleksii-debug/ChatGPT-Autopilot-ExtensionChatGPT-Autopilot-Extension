"""Restore the private worker's DLL search independently of its NVDA parent."""
import os
import ntpath
import sys


def extended_windows_path(value):
    """Make a Windows filesystem path explicit for native Unicode APIs.

    Resolve relative paths before adding the namespace: Windows does not
    interpret forward slashes or dot components inside extended-length paths.
    This changes spelling only; no files, aliases or binary copies are made.
    """
    value = os.fspath(value)
    if not isinstance(value, str):
        raise TypeError("Private runtime paths must be Unicode strings")
    if value.startswith(("\\\\?\\", "\\\\.\\")):
        return value
    if not value:
        value = "."
    if not ntpath.isabs(value) or not ntpath.splitdrive(value)[0]:
        value = ntpath.abspath(value)
    value = ntpath.normpath(value)
    if not ntpath.isabs(value) or not ntpath.splitdrive(value)[0]:
        raise ValueError("Private runtime path could not be made absolute")
    if value.startswith("\\\\"):
        return "\\\\?\\UNC\\" + value[2:]
    return "\\\\?\\" + value


def private_runtime_path(value):
    """Keep non-Windows path behavior unchanged."""
    return extended_windows_path(value) if os.name == "nt" else os.fspath(value)


def configure_worker_import_paths():
    """Apply native-loader-safe spelling only inside the private interpreter."""
    if os.name != "nt":
        return {"status": "not-windows", "extended_import_paths": False}
    previous = list(sys.path)
    sys.path[:] = [extended_windows_path(value) if isinstance(value, str) else value
                   for value in previous]
    if sys.executable:
        sys.executable = extended_windows_path(sys.executable)
    return {"status": "extended-paths", "extended_import_paths": True,
            "sys_path_entries": len(sys.path),
            "long_sys_path_entries": sum(isinstance(value, str) and len(value) >= 260 for value in previous)}


def reset_inherited_dll_directory():
    """Reset only this child; never alter the host's process-global DLL state.

    Windows propagates SetDllDirectory state to child processes. A frozen
    NVDA parent can therefore redirect a native extension dependency away
    from the private interpreter even with Python isolated mode enabled.
    Restore the documented default search before importing model extensions.
    No PATH edits, additional search directories or global host changes occur.
    """
    if os.name != "nt":
        return {"status": "not-windows", "reset_to_default": False}
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    get_directory = kernel.GetDllDirectoryW
    get_directory.argtypes = [wintypes.DWORD, wintypes.LPWSTR]
    get_directory.restype = wintypes.DWORD
    set_directory = kernel.SetDllDirectoryW
    set_directory.argtypes = [wintypes.LPCWSTR]
    set_directory.restype = wintypes.BOOL
    def directory_present():
        # Size queries may return 1 for an empty string, including its NUL.
        # Read the actual string; a nonzero capacity is not a directory.
        required = get_directory(0, None)
        if required > 32768:
            raise OSError("Private worker DLL directory exceeds the Windows path limit")
        buffer = ctypes.create_unicode_buffer(max(1, required))
        ctypes.set_last_error(0)
        written = get_directory(len(buffer), buffer)
        if not written and ctypes.get_last_error():
            raise ctypes.WinError(ctypes.get_last_error())
        if written >= len(buffer):
            raise OSError("Private worker DLL directory changed during verification")
        return bool(buffer.value)

    before = directory_present()
    if not set_directory(None):
        raise ctypes.WinError(ctypes.get_last_error())
    after = directory_present()
    if after:
        raise OSError("Private worker DLL directory was not reset")
    return {"status": "reset", "reset_to_default": True,
            "inherited_directory_present": bool(before), "directory_present_after_reset": False}
