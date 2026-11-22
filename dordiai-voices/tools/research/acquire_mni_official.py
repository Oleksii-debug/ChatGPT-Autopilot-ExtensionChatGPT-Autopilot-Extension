#!/usr/bin/env python3
"""Hash and inspect the official Manipuri release WITHOUT loading any checkpoint.

Source code MIT is not automatically a weights licence. No torch, pickle,
inference, export, model registration, network frontend or voice projection.
"""
from __future__ import annotations
import argparse
import base64
from datetime import datetime, timezone
import gzip
from hashlib import sha1, sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = "AI4Bharat/Indic-TTS"
SOURCE_REVISION = "ad2461c22c373f89a140c5d9fb617b101219bdad"
ASSET_ID = 92143512
ASSET_BYTES = 1518195233
ASSET_CREATED = "2023-01-18T12:45:25Z"
ASSET_UPDATED = "2023-01-18T12:47:20Z"
DOWNLOAD_URL = "https://github.com/AI4Bharat/Indic-TTS/releases/download/v1-checkpoints-release/mni.zip"
SOURCE_FILES = {
    "LICENSE.txt": "3200d2d480d31d2d24429aa16511ae478d89f643",
    "inference/README.md": "de668b32ceb5a7aeedc6ffa37e652da1c938d63c",
    "inference/src/inference.py": "a57192b67a33358f88685fab8175a38e98744172",
}
MAX_RAW = 6 * 1024**3
MAX_FILES = 2000
MAX_METADATA = 1024**2
MAX_REPORT = 2 * 1024**2
CHUNK = 1024**2
EXPECTED = {"mni/fastpitch/best_model.pth", "mni/fastpitch/config.json",
            "mni/hifigan/best_model.pth", "mni/hifigan/config.json"}


def fingerprint(path):
    state, amount = sha256(), 0
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(CHUNK), b""):
            state.update(block)
            amount += len(block)
    return {"size_bytes": amount, "sha256": state.hexdigest()}


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, indent=2) + "\n").encode("utf-8")


def unique_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate source JSON property")
        value[key] = item
    return value


def request(url):
    response = urlopen(Request(url, headers={"User-Agent": "Dordiai-isolated-MNI-acquisition/2"}), timeout=120)
    parsed = urlsplit(response.geturl())
    host = (parsed.hostname or "").lower()
    if (parsed.scheme != "https" or parsed.port not in (None, 443)
            or parsed.username or parsed.password
            or not (host in {"github.com", "api.github.com", "raw.githubusercontent.com"}
                    or host.endswith(".githubusercontent.com"))):
        response.close()
        raise ValueError("Primary source left GitHub-owned HTTPS storage")
    # Public endpoints only; no credential is read, sent or logged.
    return response


def bounded(url, limit):
    with request(url) as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Primary response exceeds bounded metadata size")
    return data


def asset_identity(body):
    expected = {"id": ASSET_ID, "name": "mni.zip", "size": ASSET_BYTES,
                "created_at": ASSET_CREATED, "updated_at": ASSET_UPDATED,
                "browser_download_url": DOWNLOAD_URL, "state": "uploaded"}
    if not isinstance(body, dict) or any(body.get(key) != value for key, value in expected.items()):
        raise ValueError("Exact official release asset identity changed")
    digest = body.get("digest")
    if digest is not None and re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is None:
        raise ValueError("Unrecognized publisher checkpoint digest")
    return dict(expected, published_digest=digest, published_digest_available=digest is not None)


def member_name(info):
    name = info.filename
    if (getattr(info, "orig_filename", name) != name or "\\" in name or "\0" in name
            or ":" in name or any(ord(char) < 32 for char in name)):
        raise ValueError("Ambiguous archive member")
    normalized = name[:-1] if info.is_dir() else name
    path = PurePosixPath(normalized)
    if (not normalized or path.is_absolute() or any(part in (".", "..") for part in path.parts)
            or path.as_posix() != normalized):
        raise ValueError("Unsafe archive member")
    mode = stat.S_IFMT(info.external_attr >> 16)
    if mode not in (0, stat.S_IFREG, stat.S_IFDIR) or info.flag_bits & 1:
        raise ValueError("Linked, encrypted or nonregular archive member")
    if mode == stat.S_IFDIR and not info.is_dir() or mode == stat.S_IFREG and info.is_dir():
        raise ValueError("Archive member type/name disagreement")
    return name


def inspect_archive(path):
    """Read untrusted .pth files ONLY as opaque byte streams for hashing."""
    result = {"files": {}, "configs": {}, "licence_documents": {},
              "weights_deserialized": False, "archive_code_executed": False,
              "native_inference_verified": False}
    total, seen = 0, set()
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_FILES:
            raise ValueError("Archive entry quota exceeded")
        for info in entries:
            name = member_name(info)
            if name.casefold() in seen:
                raise ValueError("Duplicate archive member")
            seen.add(name.casefold())
            if info.is_dir():
                continue
            total += info.file_size
            if info.file_size < 0 or total > MAX_RAW:
                raise ValueError("Expanded checkpoint quota exceeded")
            filename = PurePosixPath(name).name.casefold()
            metadata = name.casefold().endswith(".json") or any(word in filename for word in ("license", "licence", "readme"))
            if metadata and info.file_size > MAX_METADATA:
                raise ValueError("Oversized checkpoint metadata")
            state, count, small = sha256(), 0, bytearray()
            with archive.open(info) as stream:
                for block in iter(lambda: stream.read(CHUNK), b""):
                    count += len(block)
                    if count > info.file_size:
                        raise ValueError("Archive expanded beyond declared size")
                    state.update(block)
                    if metadata:
                        small.extend(block)
            if count != info.file_size:
                raise ValueError("Truncated archive member")
            result["files"][name] = {"size_bytes": count, "sha256": state.hexdigest()}
            if metadata:
                text = bytes(small).decode("utf-8-sig")
                if name.casefold().endswith("config.json"):
                    document = json.loads(text, object_pairs_hook=unique_pairs)
                    if not isinstance(document, dict):
                        raise ValueError("Native config must be a JSON object")
                    result["configs"][name] = {key: document[key] for key in (
                        "model", "run_name", "audio", "characters", "use_phonemes",
                        "phoneme_language", "text_cleaner", "speakers_file", "speaker_ids",
                        "model_args", "num_speakers", "speaker_embedding_channels")
                        if key in document}
                elif "license" in filename or "licence" in filename:
                    result["licence_documents"][name] = text
    result["expanded_bytes"] = total
    result["checkpoint_licence_document_present"] = bool(result["licence_documents"])
    result["checkpoint_licence_scope_requires_review"] = True
    result["missing_expected_files"] = sorted(EXPECTED - set(result["files"]))
    result["expected_native_pairs_present"] = not result["missing_expected_files"]
    result["both_native_configs_parsed"] = all(name in result["configs"]
        for name in ("mni/fastpitch/config.json", "mni/hifigan/config.json"))
    result["layout_verified"] = result["expected_native_pairs_present"] and result["both_native_configs_parsed"]
    return result


def inside(path, directory):
    return path == directory or directory in path.parents


def safe_outputs(archive, report):
    archive, report = Path(archive).absolute(), Path(report).absolute()
    for path in (archive, report):
        if path.exists() or path.is_symlink():
            raise FileExistsError("Acquisition output is immutable; use fresh owned paths")
        for parent in path.parents:
            if parent.is_symlink() or getattr(parent, "is_junction", lambda: False)():
                raise ValueError("Linked acquisition output parent")
    a, b = archive.resolve(), report.resolve()
    if inside(a, b) or inside(b, a):
        raise ValueError("Archive and report paths overlap")
    protected = [ROOT / name for name in ("source", "tools", "tests", "training-data", "evidence", "packages")]
    protected.append(ROOT.parent / ".github")
    if any(inside(path, target.resolve()) or inside(target.resolve(), path)
           for path in (a, b) for target in protected):
        raise ValueError("Acquisition output overlaps protected project inputs")
    return archive, report


class OwnedReport:
    """Initial no-clobber publication; later updates require our prior bytes."""
    def __init__(self, path):
        self.path, self.record = Path(path), None
    def write(self, document):
        raw = json_bytes(document)
        if len(raw) > MAX_REPORT:
            raise ValueError("Checkpoint metadata report quota exceeded")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.is_symlink() or self.path.exists() and not self.path.is_file():
            raise ValueError("Unsafe report destination")
        if self.record is None:
            if self.path.exists():
                raise FileExistsError("Another writer owns the report")
        elif not self.path.exists() or fingerprint(self.path) != self.record:
            raise ValueError("Owned report changed outside this acquisition")
        descriptor, temporary = tempfile.mkstemp(prefix="mni-report-", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            if self.record is None:
                os.link(temporary, self.path)
            else:
                if self.path.is_symlink() or fingerprint(self.path) != self.record:
                    raise ValueError("Owned report changed before update")
                os.replace(temporary, self.path)
            self.record = {"sha256": sha256(raw).hexdigest(), "size_bytes": len(raw)}
        finally:
            Path(temporary).unlink(missing_ok=True)


def print_receipt(report):
    encoded = base64.b64encode(gzip.compress(json_bytes(report), mtime=0)).decode("ascii")
    parts = [encoded[offset:offset + 4096] for offset in range(0, len(encoded), 4096)]
    for index, part in enumerate(parts, 1):
        print("MNI_AUDIT_REPORT_GZIP_B64_PART %d/%d %s" % (index, len(parts), part), flush=True)
    print("MNI_AUDIT_SUMMARY " + json.dumps({
        "status": report["status"], "archive": report.get("archive"),
        "files": len(report.get("inspection", {}).get("files", {})),
        "layout_verified": report.get("inspection", {}).get("layout_verified"),
        "checkpoint_licence_document_present": report.get("inspection", {}).get("checkpoint_licence_document_present"),
        "model_weights_loaded": False, "native_inference_verified": False}, sort_keys=True), flush=True)


def acquire(args):
    archive, report_path = safe_outputs(args.archive, args.report)
    writer = OwnedReport(report_path)
    report = {"format": "dordiai-native-manipuri-official-acquisition", "format_version": 1,
              "status": "acquiring", "checked_at": datetime.now(timezone.utc).isoformat(),
              "source_repository": REPOSITORY, "source_revision": SOURCE_REVISION,
              "source_files": {}, "model_weights_loaded": False, "model_pickle_executed": False,
              "archive_code_executed": False, "product_integrated": False,
              "native_pronunciation_verified": False, "cpu_inference_speed_measured": False,
              "selected_voice_projection_verified": False,
              "native_script_note": "Official source says training uses Bengali/Eastern-Nagari; MeeteiMayek transliterates to Bengali before the SAME Manipuri model.",
              "licence_note": "Pinned SOURCE CODE is MIT; checkpoint-specific licence text recorded if present, no new weights licence asserted."}
    temporary = None
    writer.write(report)
    try:
        asset_url = "https://api.github.com/repos/" + REPOSITORY + "/releases/assets/" + str(ASSET_ID)
        before = asset_identity(json.loads(bounded(asset_url, 262144)))
        report["asset"] = before
        for name, blob in SOURCE_FILES.items():
            raw = bounded("https://raw.githubusercontent.com/" + REPOSITORY + "/" + SOURCE_REVISION + "/" + name, 262144)
            if sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest() != blob:
                raise ValueError("Pinned primary source bytes differ")
            report["source_files"][name] = dict(fingerprint_bytes(raw), git_blob=blob)
            if name == "LICENSE.txt":
                report["source_code_licence_text"] = raw.decode("utf-8")
            elif name == "inference/src/inference.py":
                text = raw.decode("utf-8")
                marker = 'aksharamukha_xlit("MeeteiMayek", "Bengali", input_text)'
                report["official_meetei_to_bengali_source_marker_present"] = marker in text
                if marker not in text:
                    raise ValueError("Pinned official frontend declaration differs")
        writer.write(report)
        archive.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix="mni-official-", suffix=".zip", dir=archive.parent)
        # Open the owned descriptor FIRST: failed network open cannot leak it.
        state, count = sha256(), 0
        with os.fdopen(descriptor, "wb") as destination:
            with request(DOWNLOAD_URL) as source:
                for block in iter(lambda: source.read(CHUNK), b""):
                    count += len(block)
                    if count > ASSET_BYTES:
                        raise ValueError("Official download exceeds pinned size")
                    state.update(block)
                    destination.write(block)
        if count != ASSET_BYTES:
            raise ValueError("Official checkpoint archive byte count differs")
        after = asset_identity(json.loads(bounded(asset_url, 262144)))
        if before != after:
            raise ValueError("Release asset changed while reading")
        if before["published_digest"] and before["published_digest"] != "sha256:" + state.hexdigest():
            raise ValueError("Archive differs from actual published digest")
        report["archive"] = {"filename": archive.name, "size_bytes": count, "sha256": state.hexdigest(),
                             "first_raw_hash_acquisition": True,
                             "prior_raw_hash_was_available": bool(before["published_digest"])}
        writer.write(report)
        report["inspection"] = inspect_archive(temporary)
        os.link(temporary, archive)
        report["status"] = ("actual-official-manipuri-checkpoints-hashed-not-inferred"
            if report["inspection"]["layout_verified"] else "hashed-native-layout-needs-review")
        writer.write(report)
        print_receipt(report)
        return report
    except Exception as error:
        report.update(status="failed-not-inferred", error_type=type(error).__name__)
        writer.write(report)
        print_receipt(report)
        raise
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)


def fingerprint_bytes(raw):
    return {"sha256": sha256(raw).hexdigest(), "size_bytes": len(raw)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        report = acquire(args)
    except Exception as error:
        print("MNI_AUDIT_FAILED " + type(error).__name__, flush=True)
        return 1
    return 0 if report["status"] == "actual-official-manipuri-checkpoints-hashed-not-inferred" else 2


if __name__ == "__main__":
    raise SystemExit(main())
