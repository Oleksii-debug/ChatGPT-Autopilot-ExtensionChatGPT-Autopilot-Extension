"""Data-only prepared bank overlay, bound to one immutable source core.

No speech is generated here. A validator proves declared source identity and
append-only bank integrity; it cannot certify pronunciation, human identity,
NVDA playback or physical audio. Tests use explicitly synthetic fixtures.
"""
from __future__ import annotations
from contextlib import contextmanager
from hashlib import sha256
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import unicodedata
import wave
import zipfile
import os

MANIFEST = "dordiai-prepared-bank-overlay.json"
FORMAT = "dordiai-prepared-bank-overlay"
PLAN_FORMAT = "dordiai-supplementary-bank-plan"
CATALOGUE = "kx47Runtime/models/voices/catalog.json"
BANK_ROOT = "kx47Runtime/models/voices/"
ROLES = ("native_letters", "native_commands")
MAX_RAW = 1024**3
MAX_INDEX = 2 * 1024**2
MAX_MANIFEST = 32 * 1024**2
MAX_CLIP = 384000
PENDING_QUALITY = {"pronunciation": "pending", "nvda": "pending", "physical_audio": "pending"}
EXCLUDED = frozenset({"kostia", "inna", "dina", "vira", "innesa", "veronika_classmate", "anatolii", "veronika"})
ACOUSTIC = frozenset("nvda_worker ukrainian_voices native_multilingual converted_voices voice_delivery voice_controls speech_tempo speech_text spelling_audio english_phonetics session_control streaming_resample voice_assets voice_policy".split())
HEX64 = re.compile(r"[a-f0-9]{64}\Z")
HEX24 = re.compile(r"[a-f0-9]{24}\Z")
PROFILE = re.compile(r"[a-z][a-z0-9_-]{0,63}\Z")
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?\Z")


class OverlayError(ValueError):
    pass


def _bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode("utf-8")


def _record(raw):
    return {"sha256": sha256(raw).hexdigest(), "size_bytes": len(raw)}


def _path(name):
    if (not isinstance(name, str) or not name or "\\" in name or ":" in name
            or "\x00" in name or any(ord(c) < 32 for c in name)
            or PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts
            or PurePosixPath(name).as_posix() != name):
        raise OverlayError("Unsafe archive path")
    return name


def _valid_record(value):
    return (isinstance(value, dict) and set(value) == {"sha256", "size_bytes"}
            and isinstance(value["sha256"], str) and HEX64.fullmatch(value["sha256"])
            and type(value["size_bytes"]) is int and 0 <= value["size_bytes"] <= MAX_RAW)


def _duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise OverlayError("Duplicate JSON property")
        result[key] = value
    return result


def _json(raw):
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_duplicates)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise OverlayError("Invalid UTF-8 JSON") from error


def _bank_path(role, profile, extension):
    return BANK_ROOT + role + "/" + profile + "." + extension


def _bank_paths(profiles):
    return {_bank_path(role, profile, ext) for role in ROLES for profile in profiles for ext in ("json", "pcm")}


def _is_bank(name):
    return any(name.startswith(BANK_ROOT + role + "/") for role in ROLES)


def _is_identity(name):
    return ((name.startswith("kx47Runtime/models/") and not _is_bank(name))
            or name.startswith("kx47Runtime/python/")
            or name in {"kx47Runtime/" + stem + ".py" for stem in ACOUSTIC})


def identity_inputs(release_manifest):
    """All renderer/model/private-Python bytes needed to bind generated audio."""
    files = release_manifest.get("files") if isinstance(release_manifest, dict) else None
    if not isinstance(files, dict):
        raise OverlayError("Release manifest has no file inventory")
    result = {}
    for name, record in files.items():
        _path(name)
        if _is_identity(name):
            if not _valid_record(record):
                raise OverlayError("Invalid release identity input")
            result[name] = dict(record)
    if CATALOGUE not in result:
        raise OverlayError("Release identity lacks the voice catalogue")
    return result


def bank_language(language):
    if not isinstance(language, str):
        raise OverlayError("Invalid bank language")
    value = language.lower().replace("_", "-")
    return "en-us" if value == "en" else value


def bank_key(language, text):
    if not isinstance(text, str):
        raise OverlayError("Invalid bank text")
    value = bank_language(language) + "\0" + unicodedata.normalize("NFC", text).strip().casefold()
    return sha256(value.encode("utf-8")).hexdigest()[:24]


def _profiles(value):
    if (not isinstance(value, list) or len(value) != 45 or value != sorted(set(value))
            or any(not isinstance(item, str) or not PROFILE.fullmatch(item) or item in EXCLUDED for item in value)):
        raise OverlayError("Overlay must bind the exact45 allowed source profile IDs")
    return value


def _plan(plan):
    if (not isinstance(plan, dict) or plan.get("format") != PLAN_FORMAT or plan.get("format_version") != 1
            or not isinstance(plan.get("core_sha256"), str) or not HEX64.fullmatch(plan["core_sha256"])
            or type(plan.get("core_size_bytes")) is not int or plan["core_size_bytes"] <= 0
            or not isinstance(plan.get("catalogue_sha256"), str) or not HEX64.fullmatch(plan["catalogue_sha256"])):
        raise OverlayError("Invalid source core plan pins")
    profiles = _profiles(plan.get("voice_ids"))
    jobs = plan.get("jobs")
    if not isinstance(jobs, dict) or not set(jobs) <= set(profiles):
        raise OverlayError("Plan jobs do not belong to the source profiles")
    for profile, values in jobs.items():
        if not isinstance(values, list):
            raise OverlayError("Invalid profile job list")
        seen = set()
        for job in values:
            if (not isinstance(job, dict) or not isinstance(job.get("key"), str)
                    or not HEX24.fullmatch(job["key"]) or job["key"] in seen
                    or job.get("language") not in {"uk", "ru", "en-us"}
                    or not isinstance(job.get("text"), str) or not job["text"].strip()
                    or len(job["text"]) > 1024 or any(ord(c) < 32 for c in job["text"])
                    or job["key"] != bank_key(job["language"], job["text"])):
                raise OverlayError("Invalid, duplicate or inconsistent bank job")
            for name in ("glyphs", "runtime_kinds"):
                if not isinstance(job.get(name), list) or any(not isinstance(value, str) for value in job[name]):
                    raise OverlayError("Missing job descriptors")
            if "mapping_origin" not in job:
                raise OverlayError("Missing job mapping provenance")
            seen.add(job["key"])
    if not isinstance(plan.get("source"), dict):
        raise OverlayError("Plan lacks mapping-source provenance")
    return profiles


def _index(raw, pcm):
    if len(raw) > MAX_INDEX:
        raise OverlayError("Prepared index is too large")
    data = _json(raw)
    if not isinstance(data, dict):
        raise OverlayError("Builtin indices must remain raw dictionaries")
    for key, value in data.items():
        if (not isinstance(key, str) or not HEX24.fullmatch(key)
                or not isinstance(value, list) or len(value) != 2
                or any(type(number) is not int for number in value)):
            raise OverlayError("Invalid old/new raw index entry")
        offset, size = value
        if offset < 0 or offset % 2 or not 2 <= size <= MAX_CLIP or size % 2 or offset + size > len(pcm):
            raise OverlayError("Bank index has an invalid/out-of-bounds PCM interval")
    if len(pcm) > MAX_RAW or len(pcm) % 2:
        raise OverlayError("Invalid PCM bank length")
    return data


def _zip_files(archive):
    result = {}
    for info in archive.infolist():
        _path(info.filename)
        mode = stat.S_IFMT(info.external_attr >> 16)
        if (info.is_dir() or mode not in (0, stat.S_IFREG) or info.flag_bits & 1
                or info.orig_filename != info.filename or info.file_size > MAX_RAW):
            raise OverlayError("Unsafe archive member")
        folded = info.filename.casefold()
        if folded in result:
            raise OverlayError("Duplicate Windows archive name")
        result[folded] = info
    return {value.filename: value for value in result.values()}


def _read(archive, infos, name, limit):
    if name not in infos or infos[name].file_size > limit:
        raise OverlayError("Missing or oversized archive member: " + name)
    return archive.read(infos[name])


def _pair(getter, role, profile):
    names = [_bank_path(role, profile, ext) for ext in ("json", "pcm")]
    raw, pcm = [getter(name) for name in names]
    if (raw is None) != (pcm is None):
        raise OverlayError("Bank index and PCM must either both exist or both be absent")
    return (None, b"", {}) if raw is None else (raw, pcm, _index(raw, pcm))


def _clip_metadata(record, profile, job, core_sha, identities):
    if (not isinstance(record, dict) or record.get("status") != "complete"
            or record.get("profile") != profile or record.get("language") != job["language"]
            or record.get("text") != job["text"] or record.get("source_core_sha256") != core_sha
            or record.get("key", job["key"]) != job["key"]
            or type(record.get("size_bytes")) is not int or not 2 <= record["size_bytes"] <= MAX_CLIP
            or record["size_bytes"] % 2 or not isinstance(record.get("pcm_sha256"), str)
            or not HEX64.fullmatch(record["pcm_sha256"])):
        raise OverlayError("Incomplete or wrong-profile/language clip declaration")
    origin = record.get("origin")
    if (not isinstance(origin, dict) or origin.get("kind") not in {
            "actual-private-worker", "retained-core8-prepared-navigation"}
            or not isinstance(origin.get("path"), str) or not origin["path"]
            or not isinstance(origin.get("sha256"), str) or not HEX64.fullmatch(origin["sha256"])):
        raise OverlayError("Clip lacks declared rendering/retained-source origin")
    name = _path(origin["path"])
    expected_origin = identities.get(name)
    if not isinstance(expected_origin, dict) or expected_origin.get("sha256") != origin["sha256"]:
        raise OverlayError("Clip origin is not bound to the source core identity")
    if origin["kind"] == "actual-private-worker":
        if name != "kx47Runtime/nvda_worker.py":
            raise OverlayError("Rendered clip must bind the pinned private worker source")
        if job.get("worker_source_sha256", origin["sha256"]) != origin["sha256"]:
            raise OverlayError("Job worker source pin differs from its clip origin")
    elif not name.startswith(BANK_ROOT + "navigation/" + profile + "/"):
        raise OverlayError("Retained navigation source belongs to another profile")
    if not isinstance(record.get("audio"), dict) or not record["audio"]:
        raise OverlayError("Clip lacks audio measurement metadata")
    if origin["kind"] == "actual-private-worker" and (not isinstance(record.get("worker"), dict) or not record["worker"]):
        raise OverlayError("Rendered clip lacks worker provenance")
    return {key: value for key, value in record.items() if key != "pcm_path"}


def _merge(old_index, old_pcm, jobs, clips):
    result, pcm = dict(old_index), bytearray(old_pcm)
    added = []
    for job in jobs:
        key = job["key"]
        if key in result:
            continue
        raw = clips[key]
        result[key] = [len(pcm), len(raw)]
        pcm.extend(raw)
        added.append(key)
    raw_index, full_pcm = _bytes(result), bytes(pcm)
    _index(raw_index, full_pcm)
    return raw_index, full_pcm, added


def _verify_merge(old_index, old_pcm, new_index_raw, new_pcm, jobs, clips):
    new_index = _index(new_index_raw, new_pcm)
    if not new_pcm.startswith(old_pcm):
        raise OverlayError("Old PCM prefix was changed")
    expected = dict(old_index)
    cursor = len(old_pcm)
    for job in jobs:
        key = job["key"]
        if key in old_index:
            continue
        metadata = clips[key]
        size = metadata["size_bytes"]
        if new_index.get(key) != [cursor, size]:
            raise OverlayError("Appended clip interval/order differs from the plan")
        if sha256(new_pcm[cursor:cursor + size]).hexdigest() != metadata["pcm_sha256"]:
            raise OverlayError("Appended clip bytes differ from declared provenance")
        expected[key] = [cursor, size]
        cursor += size
    if new_index != expected or cursor != len(new_pcm):
        raise OverlayError("Old index values changed or unplanned bank data was added")


def _archive_record(path):
    value = sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return {"filename": Path(path).name, "sha256": value.hexdigest(), "size_bytes": Path(path).stat().st_size}



def _stat_key(value):
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


@contextmanager
def _zip_snapshot(path):
    """Hash/read the same descriptor; fstat-to-fstat avoids Windows clock aliases."""
    path = Path(path)
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise OverlayError("Archive is not a regular file")
        value = sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
        record = {"filename": path.name, "sha256": value.hexdigest(), "size_bytes": before.st_size}
        def check():
            if _stat_key(os.fstat(stream.fileno())) != _stat_key(before):
                raise OverlayError("Archive changed while being validated")
            with path.open("rb") as current:
                reopened = os.fstat(current.fileno())
            if not os.path.samestat(before, reopened) or _stat_key(reopened) != _stat_key(before):
                raise OverlayError("Archive pathname was replaced during validation")
        check()
        stream.seek(0)
        with zipfile.ZipFile(stream) as archive:
            yield archive, record, check
            check()


def build_overlay(core_zip, output_zip, version, plan, clip_records, provenance):
    """Create one immutable standalone ZIP with full180 updated bank files."""
    profiles = _plan(plan)
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise OverlayError("Overlay version must be immutable semantic version text")
    output_zip, core_zip = Path(output_zip), Path(core_zip)
    if output_zip.exists() or output_zip.is_symlink():
        raise FileExistsError("Overlay output already exists")
    core_record = {"filename": core_zip.name, "sha256": plan["core_sha256"], "size_bytes": plan["core_size_bytes"]}
    if not isinstance(provenance, dict) or provenance.get("kind") != "UserProvidedProvenance":
        raise OverlayError("Generation provenance must declare UserProvidedProvenance")
    if not isinstance(clip_records, dict) or not set(clip_records) <= set(profiles):
        raise OverlayError("Clip records contain another profile")
    output_zip.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix="prepared-bank-overlay-", suffix=".zip", dir=output_zip.parent)
    os.close(descriptor)
    manifest = {"format": FORMAT, "format_version": 1, "version": version,
                "source_core": core_record, "catalogue_sha256": plan["catalogue_sha256"],
                "voice_ids": profiles, "excluded_voice_ids": sorted(EXCLUDED), "plan": plan,
                "provenance": provenance, "clips": {}, "files": {},
                "quality_validation": dict(PENDING_QUALITY),
                "validation_scope": "Data/source binding only; not independent proof of acoustic generation or speaker identity."}
    total = 0
    try:
        with _zip_snapshot(core_zip) as (source, actual_core, source_check):
            if actual_core != core_record:
                raise OverlayError("Source core archive differs from the plan pin")
            infos = _zip_files(source)
            if sum(info.file_size for name, info in infos.items() if _is_bank(name)) > MAX_RAW:
                raise OverlayError("Source raw bank files exceed1GiB")
            release = _json(_read(source, infos, "dordiai-release.json", 8 * 1024**2))
            if release.get("format") != "dordiai-core-release" or release.get("format_version") != 1:
                raise OverlayError("Invalid source core release inventory")
            catalogue = _read(source, infos, CATALOGUE, MAX_INDEX)
            if _record(catalogue) != release["files"].get(CATALOGUE) or sha256(catalogue).hexdigest() != plan["catalogue_sha256"]:
                raise OverlayError("Source catalogue pin differs")
            if sorted(_json(catalogue)) != profiles or sorted(release.get("voice_ids", [])) != profiles:
                raise OverlayError("Source core catalogue is not this exact45-profile plan")
            manifest["identity_inputs"] = identity_inputs(release)
            def get_old(name):
                expected = release["files"].get(name)
                if expected is None:
                    if name in infos:
                        raise OverlayError("Uninventoried old bank file")
                    return None
                raw = _read(source, infos, name, MAX_INDEX if name.endswith(".json") else MAX_RAW)
                if _record(raw) != expected:
                    raise OverlayError("Old bank differs from source release inventory")
                return raw
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as target:
                for profile in profiles:
                    profile_index_bytes = 0
                    jobs = plan["jobs"].get(profile, [])
                    supplied = clip_records.get(profile, {})
                    if not isinstance(supplied, dict) or set(supplied) != {job["key"] for job in jobs}:
                        raise OverlayError("Plan and clip record keys differ")
                    raw_clips, clean = {}, {}
                    for job in jobs:
                        record = supplied[job["key"]]
                        clean[job["key"]] = _clip_metadata(record, profile, job, plan["core_sha256"], manifest["identity_inputs"])
                        path = Path(record["pcm_path"])
                        if path.is_symlink() or path.stat().st_size != record["size_bytes"]:
                            raise OverlayError("Missing/unsafe/wrong-size generated clip")
                        raw = path.read_bytes()
                        if sha256(raw).hexdigest() != record["pcm_sha256"] or not any(raw):
                            raise OverlayError("Generated clip checksum differs or is silent")
                        origin = record["origin"]
                        if origin["kind"] == "retained-core8-prepared-navigation":
                            name = _path(origin["path"])
                            if not name.startswith(BANK_ROOT + "navigation/" + profile + "/"):
                                raise OverlayError("Retained navigation source belongs to another profile")
                            original = _read(source, infos, name, MAX_CLIP + 65536)
                            if _record(original) != release["files"].get(name) or sha256(original).hexdigest() != origin["sha256"]:
                                raise OverlayError("Retained navigation source pin differs")
                            with wave.open(io.BytesIO(original), "rb") as wav:
                                if wav.getparams()[:3] != (1, 2, 24000) or wav.getcomptype() != "NONE":
                                    raise OverlayError("Retained navigation must be mono24000Hz16bitPCM")
                                retained = wav.readframes(wav.getnframes())
                            if retained != raw:
                                raise OverlayError("Retained clip is not the unchanged source WAV PCM")
                        raw_clips[job["key"]] = raw
                    manifest["clips"][profile] = clean
                    for role in ROLES:
                        old_raw, old_pcm, old_index = _pair(get_old, role, profile)
                        new_raw, new_pcm, added = _merge(old_index, old_pcm, jobs, raw_clips)
                        _verify_merge(old_index, old_pcm, new_raw, new_pcm, jobs, clean)
                        profile_index_bytes += len(new_raw)
                        if profile_index_bytes > MAX_INDEX:
                            raise OverlayError("Combined per-profile bank indices exceed2MiB")
                        for ext, previous, new in (("json", old_raw, new_raw), ("pcm", None if old_raw is None else old_pcm, new_pcm)):
                            name = _bank_path(role, profile, ext)
                            manifest["files"][name] = {"old": None if previous is None else _record(previous),
                                                       "new": _record(new), "added_keys": added}
                            total += len(new)
                            if total > MAX_RAW:
                                raise OverlayError("Overlay reconstructed raw banks exceed1GiB")
                            target.writestr(name, new)
                payload = _bytes(manifest)
                if len(payload) > MAX_MANIFEST:
                    raise OverlayError("Overlay manifest is too large")
                target.writestr(MANIFEST, payload)
            source_check()
        os.link(temporary, output_zip)
        return {"manifest": manifest, "archive": _archive_record(output_zip)}
    finally:
        Path(temporary).unlink(missing_ok=True)


def _input_bytes(item):
    return item.transformed if item.transformed is not None else Path(item.source).read_bytes()


def _input_record(item):
    if item.transformed is not None:
        return _record(item.transformed)
    value, size = sha256(), 0
    with Path(item.source).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
            size += len(block)
    return {"sha256": value.hexdigest(), "size_bytes": size}


@contextmanager
def apply_to_inputs(files, overlay_zip, input_file_type):
    """Validate target identity then stage complete bank replacements acrossyield."""
    original = list(files)
    by_name, folded = {}, set()
    for item in original:
        name = _path(item.path)
        if name.casefold() in folded:
            raise OverlayError("Duplicate target release paths")
        folded.add(name.casefold())
        by_name[name] = item
    with _zip_snapshot(overlay_zip) as (archive, archive_record, archive_check):
        infos = _zip_files(archive)
        manifest = _json(_read(archive, infos, MANIFEST, MAX_MANIFEST))
        if manifest.get("format") != FORMAT or manifest.get("format_version") != 1 or not VERSION.fullmatch(str(manifest.get("version", ""))):
            raise OverlayError("Invalid overlay format/version")
        profiles = _profiles(manifest.get("voice_ids"))
        if (manifest.get("excluded_voice_ids") != sorted(EXCLUDED)
                or manifest.get("quality_validation") != PENDING_QUALITY
                or not isinstance(manifest.get("provenance"), dict)
                or manifest["provenance"].get("kind") != "UserProvidedProvenance"):
            raise OverlayError("Overlay policy/provenance or pending quality flags differ")
        plan = manifest.get("plan")
        if (_plan(plan) != profiles or plan["core_sha256"] != manifest.get("source_core", {}).get("sha256")
                or plan["core_size_bytes"] != manifest.get("source_core", {}).get("size_bytes")
                or plan["catalogue_sha256"] != manifest.get("catalogue_sha256")):
            raise OverlayError("Overlay source plan differs")
        names = _bank_paths(profiles)
        if set(infos) != names | {MANIFEST} or set(manifest.get("files", {})) != names:
            raise OverlayError("Overlay must contain exactly180 raw bank files plus one manifest")
        if (sum(infos[name].file_size for name in names) > MAX_RAW
                or any(infos[name].file_size > MAX_INDEX for name in names if name.endswith(".json"))):
            raise OverlayError("Overlay declared bank payload exceeds size limits")
        current_identity = {name: _input_record(item) for name, item in by_name.items()
                            if item.group == "core" and _is_identity(name)}
        if current_identity != manifest.get("identity_inputs"):
            raise OverlayError("Target model, voice, private Python or acoustic renderer identity changed")
        if CATALOGUE not in by_name:
            raise OverlayError("Target catalogue missing")
        catalogue = _input_bytes(by_name[CATALOGUE])
        if (sha256(catalogue).hexdigest() != manifest.get("catalogue_sha256")
                or sorted(_json(catalogue)) != profiles):
            raise OverlayError("Target catalogue differs from overlay")
        old = {}
        def get_old(name):
            if name not in old:
                item = by_name.get(name)
                old[name] = None if item is None else _input_bytes(item)
            return old[name]
        total = 0
        with tempfile.TemporaryDirectory(prefix="prepared-bank-overlay-") as temporary:
            stage = Path(temporary)
            replacements = {}
            for profile in profiles:
                profile_index_bytes = 0
                jobs = plan["jobs"].get(profile, [])
                clips = manifest.get("clips", {}).get(profile, {})
                if not isinstance(clips, dict) or set(clips) != {job["key"] for job in jobs}:
                    raise OverlayError("Overlay clip metadata differs from plan")
                for job in jobs:
                    _clip_metadata(clips[job["key"]], profile, job, plan["core_sha256"], current_identity)
                    metadata = clips[job["key"]]
                    if metadata["origin"]["kind"] == "retained-core8-prepared-navigation":
                        source_item = by_name.get(metadata["origin"]["path"])
                        if source_item is None:
                            raise OverlayError("Retained navigation source missing from target")
                        with wave.open(io.BytesIO(_input_bytes(source_item)), "rb") as wav:
                            if wav.getparams()[:3] != (1, 2, 24000) or wav.getcomptype() != "NONE":
                                raise OverlayError("Retained navigation must be mono24000Hz16bitPCM")
                            retained_pcm = wav.readframes(wav.getnframes())
                        if (len(retained_pcm) != metadata["size_bytes"]
                                or sha256(retained_pcm).hexdigest() != metadata["pcm_sha256"]):
                            raise OverlayError("Retained navigation PCM differs from its clip declaration")
                for role in ROLES:
                    old_raw, old_pcm, old_index = _pair(get_old, role, profile)
                    raws = {}
                    for ext, previous in (("json", old_raw), ("pcm", None if old_raw is None else old_pcm)):
                        name = _bank_path(role, profile, ext)
                        record = manifest["files"][name]
                        if record.get("old") != (None if previous is None else _record(previous)):
                            raise OverlayError("Target old bank bytes differ from overlay source")
                        raw = _read(archive, infos, name, MAX_INDEX if ext == "json" else MAX_RAW)
                        if _record(raw) != record.get("new"):
                            raise OverlayError("Overlay full bank checksum/size differs")
                        total += len(raw)
                        if total > MAX_RAW:
                            raise OverlayError("Overlay banks exceed1GiB")
                        raws[ext] = raw
                    profile_index_bytes += len(raws["json"])
                    if profile_index_bytes > MAX_INDEX:
                        raise OverlayError("Combined per-profile bank indices exceed2MiB")
                    expected_added = [job["key"] for job in jobs if job["key"] not in old_index]
                    if any(manifest["files"][_bank_path(role, profile, ext)].get("added_keys") != expected_added
                           for ext in ("json", "pcm")):
                        raise OverlayError("Declared appended keys differ from the actual merge")
                    _verify_merge(old_index, old_pcm, raws["json"], raws["pcm"], jobs, clips)
                    for ext, raw in raws.items():
                        name = _bank_path(role, profile, ext)
                        target = stage / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(raw)
                        group = by_name[name].group if name in by_name else "core"
                        replacements[name] = input_file_type(name, target, group)
            updated = [replacements.pop(item.path, item) for item in original]
            updated.extend(replacements[name] for name in sorted(replacements))
            summary = {"format": FORMAT, "version": manifest["version"], "source_core": manifest["source_core"],
                       "archive": archive_record, "voice_count": len(profiles), "bank_file_count": 180,
                       "raw_bank_bytes": total, "append_only_verified": True, "identity_inputs_verified": len(current_identity),
                       "quality_validation": manifest.get("quality_validation"),
                       "scope": "Source-bound bank data overlay; no baseline/model mutation or independent acoustic acceptance"}
            archive_check()
            yield updated, summary
            archive_check()
            after_identity = {name: _input_record(item) for name, item in by_name.items()
                              if item.group == "core" and _is_identity(name)}
            if after_identity != current_identity:
                raise OverlayError("Target model/renderer inputs changed during the build")
