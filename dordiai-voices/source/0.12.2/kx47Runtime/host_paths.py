"""Host filesystem roots using the worker's pure path spelling function.

No DLL search, import-path, environment, cwd or interpreter mutation is allowed
here. Only the spelling passed to filesystem APIs changes.
"""
from functools import lru_cache
import importlib.util
import os
from pathlib import Path
import sys

_WINDOWS = os.name == "nt"


@lru_cache(maxsize=1)
def _windows_paths():
    name = "_dordiai_host_windows_paths"
    module = sys.modules.get(name)
    if module is None:
        location = Path(__file__).absolute().with_name("windows_runtime.py")
        # Bootstrap only this known absolute source filename; the shared helper
        # performs all consumer-path normalization, including UNC/dot handling.
        spelling = str(location)
        if os.name == "nt":
            import ntpath
            spelling = ntpath.normpath(spelling)
        if os.name == "nt" and not spelling.startswith(("\\\\?\\", "\\\\.\\")):
            spelling = "\\\\?\\UNC\\" + spelling[2:] if spelling.startswith("\\\\") else "\\\\?\\" + spelling
        spec = importlib.util.spec_from_file_location(name, spelling)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(name, None)
            raise
    return module


def filesystem_path(value):
    """Return a namespace-safe Path without changing its filesystem object."""
    raw = os.fspath(value)
    if not isinstance(raw, str):
        raise TypeError("Host filesystem paths must be Unicode strings")
    if _WINDOWS:
        raw = _windows_paths().extended_windows_path(raw)
    return Path(raw)
