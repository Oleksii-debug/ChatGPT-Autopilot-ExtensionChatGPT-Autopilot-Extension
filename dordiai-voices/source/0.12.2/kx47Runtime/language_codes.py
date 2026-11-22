"""Known language-tag aliases shared by UI, routing and installed-resource checks.

ISO aliases follow the Library of Congress ISO 639-2/639-1 table (retrieved 2026-11-22):
https://www.loc.gov/standards/iso639-2/php/code_list.php
Only identifiers are normalized; this module never declares a model installed.
The existing project choices no→Bokmål and zh→Mandarin are retained. Explicit
Nynorsk, Cantonese, Western Armenian and North/South Ndebele remain distinct.
"""

import json
from pathlib import Path

ALIASES = {
    "no": "nb", "iw": "he", "in": "id", "zh": "cmn", "zh-cmn": "cmn",
    "zh-yue": "yue", "hy-arevmda": "hyw", "mo": "ro", "gom": "kok",
    "eng": "en", "ukr": "uk", "rus": "ru", "slk": "sk", "slo": "sk",
    "pol": "pl", "deu": "de", "ger": "de", "fra": "fr", "fre": "fr",
    "dan": "da", "ita": "it", "spa": "es", "sqi": "sq", "alb": "sq",
    "ces": "cs", "cze": "cs", "ron": "ro", "rum": "ro", "nld": "nl",
    "dut": "nl", "por": "pt", "ell": "el", "gre": "el", "fin": "fi",
    "nob": "nb", "nno": "nn", "khm": "km", "tgk": "tg", "lao": "lo",
    "div": "dv", "dzo": "dz", "hau": "ha", "yor": "yo", "ful": "ff",
    "mlg": "mg", "som": "so", "sna": "sn", "kin": "rw", "run": "rn",
    "nya": "ny", "aka": "ak", "bam": "bm", "tso": "ts", "sag": "sg",
    "smo": "sm", "fij": "fj", "sot": "st", "xho": "xh", "ibo": "ig",
    "lin": "ln", "nde": "nd", "nbl": "nr", "roh": "rm", "kas": "ks",
    "zul": "zu", "wol": "wo", "ton": "to", "hmo": "ho", "ssw": "ss",
    "ven": "ve", "aar": "aa",
}

# Exact ISO 639-2 (terminological/bibliographic) to 639-1 equivalents.
# Prepared from the official LoC table by tools/prepare_language_codes.py.
# Resolve existing project defaults only after the exact identifier mapping;
# this keeps, for example, explicit Cantonese and Nynorsk distinct.
_ISO_EQUIVALENTS = json.loads(Path(__file__).with_name("language_iso_aliases.json").read_text(encoding="utf-8"))
ALIASES.update({alias: ALIASES.get(primary, primary)
                for alias, primary in _ISO_EQUIVALENTS.items() if alias not in ALIASES})


def canonical_language(value, default=""):
    if not isinstance(value, str) or not value.strip():
        return default
    parts = value.strip().lower().replace("_", "-").split("-")
    # Match the longest known prefix before dropping region/script extensions.
    # zh-yue-Hant-HK must not be truncated to generic zh/Mandarin.
    for length in range(len(parts), 0, -1):
        key = "-".join(parts[:length])
        if key in ALIASES:
            return ALIASES[key]
    return parts[0] or default
