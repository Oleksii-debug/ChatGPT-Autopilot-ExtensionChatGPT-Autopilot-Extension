"""Fetch the pinned public model files once, before offline synthesis."""
import argparse
import hashlib
from pathlib import Path
import shutil
import tarfile
from urllib.request import urlopen


PIPER_ROOT = (
    "https://huggingface.co/rhasspy/piper-voices/resolve/"
    "6b9cfaacb4fb2e02a9621227e3c1a48bec9710c3/uk/uk_UA"
)
RELEASE_ROOT = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models"
UKRAINIAN = {
    "lada/x_low/uk_UA-lada-x_low.onnx": "f8d015d3fc19ea6bd8ac3ca1fd0c0fbac5054c609599ee73799235fd2cf5c786",
    "lada/x_low/uk_UA-lada-x_low.onnx.json": "2df74b622e78930e8a62432d1cc8380f79f34f02c8c58ebd68e6ccbc857d80aa",
    "tetiana/high/uk_UA-tetiana-high.onnx": "1206d8447b99632badeb63d6132241f76cf551874e5254eb8836db36aed7c85c",
    "tetiana/high/uk_UA-tetiana-high.onnx.json": "c96a051028976afc74269f73470651384deb6872431f890cad3b6424d09e812b",
}
ARCHIVES = {
    "kokoro-int8-multi-lang-v1_0.tar.bz2": "72c347230107ef8a31098ec4d468a605244beef5f1ed00db97efa13518800653",
    "sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2": "82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427",
}


def matches(path, expected):
    if not path.is_file():
        return False
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest() == expected


def download(url, target, expected):
    if matches(target, expected):
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + ".part")
    try:
        print(f"Downloading {target.name}", flush=True)
        with urlopen(url, timeout=60) as response, temp.open("wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        if not matches(temp, expected):
            raise ValueError(f"Checksum mismatch for {target.name}")
        temp.replace(target)
    finally:
        temp.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("models", type=Path, nargs="?", default=Path("models"))
    args = parser.parse_args()
    root = args.models
    for relative, digest in UKRAINIAN.items():
        download(f"{PIPER_ROOT}/{relative}", root / "piper" / Path(relative).name, digest)

    for name, digest in ARCHIVES.items():
        marker = root / name.removesuffix(".tar.bz2") / ".ready"
        if marker.is_file() and marker.read_text(encoding="ascii") == digest:
            continue
        archive = root / name
        download(f"{RELEASE_ROOT}/{name}", archive, digest)
        with tarfile.open(archive) as contents:
            contents.extractall(root, filter="data")
        marker.write_text(digest, encoding="ascii")
        archive.unlink()
    print(f"Local models ready in {root.resolve()}")


if __name__ == "__main__":
    main()
