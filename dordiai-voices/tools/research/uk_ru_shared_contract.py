"""Finite existing-carrier research input checks; no synthesis or registration."""
from hashlib import sha256
import json
from pathlib import Path
import unicodedata

FIXTURE_SHA256 = "f974e1062293b6f6ab4e873803a6deb722fc32d3bdb256f66096d474f8959f52"
CAPABILITIES_SHA256 = "159a7f418ae089a2a47bd32017f5465a5ec31235d479731121f85dc5a97bcbe1"
TRAINED_LANGUAGES = ("en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "hi", "hr", "hu", "id", "it", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi")


def fixture(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("Ordinary immutable fixture required")
    raw = path.read_bytes()
    if len(raw) != 2151 or sha256(raw).hexdigest() != FIXTURE_SHA256:
        raise ValueError("Exact reviewed20word fixture differs")
    data = json.loads(raw)
    rows = data["cases"]
    if len(rows) != 20 or len({row["text"] for row in rows}) != 20:
        raise ValueError("Exactly20 unique unprepared words required")
    if [row["id"] for row in rows] != list(range(1, 21)):
        raise ValueError("Word IDs must retain original alternating order")
    if [row["language"] for row in rows] != ["uk", "ru"] * 10:
        raise ValueError("Only actual trainedUK/RU conditions in alternating order")
    if data["profile"] != "viktoriia" or data["requested_speed"] != 2 ** ((80 - 50) / 50) or data["shared_steps"] != 8:
        raise ValueError("Existing profile/rate/steps contract differs")
    return data


def support(capabilities_raw, available_languages):
    if len(capabilities_raw) != 367 or sha256(capabilities_raw).hexdigest() != CAPABILITIES_SHA256:
        raise ValueError("Exact original packed capabilities required")
    languages = json.loads(capabilities_raw).get("languages")
    if languages != list(TRAINED_LANGUAGES) or not {"uk", "ru"} <= set(available_languages):
        raise ValueError("Both original trainedUK/RU conditions must be supported")
    # The implementation's legacy na sentinel is never treated as a trained ID.
    return {"packed_language_count": len(languages), "requested_conditions": ["uk", "ru"],
        "unsupported_language_aliases_used": False, "neutral_na_condition_used": False}


def literal_inputs(processor, rows):
    processor.append_terminal_period = False
    prepared = []
    for row in rows:
        code, text = row["language"], row["text"]
        if code not in ("uk", "ru") or not isinstance(text, str) or not text or text.strip() != text or any(c.isspace() for c in text):
            raise ValueError("A literal single word and exact trained condition required")
        decomposed = unicodedata.normalize("NFKD", text)
        changed = [c for c in decomposed if processor._model_character(c) != c]
        if changed:
            raise ValueError("Existing frontend would drop/change an input codepoint: " + repr(changed))
        expected = "<" + code + ">" + decomposed + "</" + code + ">"
        marked = processor._preprocess_text(text, code)
        if marked != expected:
            raise ValueError("Existing frontend changed literal word or native condition")
        ids, mask = processor([text], [code])
        ids, mask = ids.reshape(-1).tolist(), mask.reshape(-1).tolist()
        if len(ids) != len(expected) or len(mask) != len(ids) or any(type(v) is not int or v < 0 for v in ids) or any(v != 1 for v in mask):
            raise ValueError("Native IDs/mask do not preserve the complete conditioned text")
        prepared.append({"id": row["id"], "language": code, "source_text": text,
            "source_utf8_sha256": sha256(text.encode()).hexdigest(), "nfkd_text": decomposed,
            "nfkd_codepoints": ["U+%04X" % ord(c) for c in decomposed],
            "marked_text": marked, "native_input_ids": ids, "native_input_mask": mask})
    return prepared
