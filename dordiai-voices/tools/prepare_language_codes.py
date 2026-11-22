"""Reproduce exact language identifier equivalents from the pinned LoC table."""
from hashlib import sha256
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://www.loc.gov/standards/iso639-2/ISO-639-2_utf-8.txt"
SOURCE_SHA256 = "42b71885e4dc885559fda5ad059fd81838cf4782cedb5fd08cc3431f7d067371"
SOURCE = ROOT / "tools/data/iso-639-2-20261122.txt"
OUTPUT = ROOT / "source/0.12.2/kx47Runtime/language_iso_aliases.json"


def prepare(source=SOURCE):
    data = Path(source).read_bytes()
    if sha256(data).hexdigest() != SOURCE_SHA256:
        raise ValueError("Language identifier source differs from the reviewed official table")
    result = {}
    for line in data.decode("utf-8-sig").splitlines():
        terms = line.split("|")
        if len(terms) != 5:
            raise ValueError("Invalid ISO language identifier record")
        terminological, bibliographic, primary = terms[:3]
        if not primary:
            continue
        if len(primary) != 2 or not primary.isascii() or not primary.islower():
            raise ValueError("Invalid primary ISO language identifier")
        for alias in (terminological, bibliographic):
            if alias:
                if len(alias) != 3 or not alias.isascii() or not alias.islower():
                    raise ValueError("Invalid three-letter ISO language identifier")
                result[alias] = primary
    return dict(sorted(result.items()))


if __name__ == "__main__":
    OUTPUT.write_text(json.dumps(prepare(), indent=2) + "\n", encoding="utf-8")
    print("Reproduced exact ISO identifier equivalents from pinned official source")
