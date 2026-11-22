"""Restore the private worker's DLL search independently of its NVDA parent."""
import os


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
    before = get_directory(0, None)
    if not set_directory(None):
        raise ctypes.WinError(ctypes.get_last_error())
    after = get_directory(0, None)
    if after:
        raise OSError("Private worker DLL directory was not reset")
    return {"status": "reset", "reset_to_default": True,
            "inherited_directory_present": bool(before), "directory_present_after_reset": False}
