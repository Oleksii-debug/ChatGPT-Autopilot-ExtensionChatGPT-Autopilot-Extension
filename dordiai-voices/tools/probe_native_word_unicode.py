"""Reuse the exact matched runner with frozen1738 as the Unicode control.

Only this owned measurement module's expected baseline and child entry point
are configured. Reader code, validation, timing loop, fresh-process isolation,
source/data pins and report bytes remain the reviewed common runner's logic.
"""
from hashlib import sha1
import importlib.util
from pathlib import Path

RUNNER_BLOB = "6f4fbd99c1f19ea18807d99d3418a59d3af5fcfa"
BASELINE_BLOB = "1738de70c9a81fab54eddde9f1e3442b9d962813"


def runner():
    path = Path(__file__).with_name("probe_native_word_cache.py")
    if path.is_symlink() or not path.is_file():
        raise ValueError("Reviewed common measurement runner required")
    raw = path.read_bytes()
    if sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest() != RUNNER_BLOB:
        raise ValueError("Common measurement runner differs from reviewed source")
    spec = importlib.util.spec_from_file_location("_owned_unicode_matched_runner", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.BASELINE_GIT_BLOB = BASELINE_BLOB
    # Every fresh child invokes this same pinned-baseline configuration.
    module.__file__ = str(Path(__file__).resolve())
    return module


if __name__ == "__main__":
    raise SystemExit(runner().main())
