"""Actionable exception metadata without text, filenames or exception messages."""
import re


def _identifier(value):
    return value[:160] if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.<>-]{1,160}", value) else None


def safe_error(error, _depth=0):
    """Never format the exception or read source lines (both may contain text)."""
    result = {"type": type(error).__name__}
    for attribute in ("errno", "winerror"):
        value = getattr(error, attribute, None)
        if isinstance(value, int) and not isinstance(value, bool):
            result[attribute] = value
    if isinstance(error, ImportError):
        result["import_name"] = _identifier(error.name)
    frames = []
    frame = error.__traceback__
    while frame is not None:
        code = frame.tb_frame.f_code
        # Module and function identifiers locate code without exposing users'
        # filenames, filesystem paths, locals or the requested spoken text.
        frames.append({"module": _identifier(frame.tb_frame.f_globals.get("__name__")),
                       "function": _identifier(code.co_name), "line": frame.tb_lineno})
        frame = frame.tb_next
    result["frames"] = frames[-16:]
    worker = getattr(error, "dordiai_worker_error", None)
    if isinstance(worker, dict):
        result["worker"] = worker
    cause = error.__cause__
    if cause is None and not error.__suppress_context__:
        cause = error.__context__
    if cause is not None and cause is not error and _depth < 2:
        result["cause"] = safe_error(cause, _depth + 1)
    return result
