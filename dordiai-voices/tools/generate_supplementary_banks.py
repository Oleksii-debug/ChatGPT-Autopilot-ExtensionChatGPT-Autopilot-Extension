"""Prepare same-voice supplementary bank overlay from an immutable core ZIP.

The source archive is never edited. Normal packaged worker requests retain
their native EN/RU semantics. Existing UK/EN space clips are copied only from
their verified same-profile WAV; genuine misses use the actual private worker.
Completed clip records can resume in a new CI job. No voice package is activated.
"""
from __future__ import annotations
import argparse
from array import array
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import time
import uuid
import wave
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BANK_ROOT = "kx47Runtime/models/voices/"
RELEASE = "dordiai-release.json"
MAX_PCM = 24000 * 2 * 8


class PreparationPaused(RuntimeError):
    pass


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


def tools():
    folder = Path(__file__).parent
    return (load("_supplementary_overlay", folder / "prepared_bank_overlay.py"),
            load("_supplementary_audit", folder / "inspect_character_banks.py"),
            load("_supplementary_prepare", folder / "prepare_voice_banks.py"),
            load("_supplementary_probe", folder / "windows_engine_probe.py"),
            load("_supplementary_policy", ROOT / "source/0.12.2/kx47Runtime/voice_policy.py"))


def digest(path):
    value = sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def atomic_json(path, value):
    path = Path(path)
    if path.is_symlink():
        raise ValueError("Linked state destination")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(json_bytes(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def safe_name(info):
    name = info.filename
    if getattr(info, "orig_filename", name) != name or "\\" in name or ":" in name or "\0" in name:
        raise ValueError("Ambiguous archive member")
    path = PurePosixPath(name)
    mode = info.external_attr >> 16
    if (path.is_absolute() or not path.parts or any(p in {"", ".", ".."} for p in path.parts)
            or stat.S_IFMT(mode) not in {0, stat.S_IFREG}):
        raise ValueError("Unsafe/nonregular source member")
    return name


def source_manifest(core, expected):
    if not re.fullmatch("[0-9a-f]{64}", expected) or digest(core) != expected:
        raise ValueError("Immutable core SHA-256 differs from the required source")
    with zipfile.ZipFile(core) as archive:
        names = {}
        for info in archive.infolist():
            name = safe_name(info)
            if name.casefold() in names:
                raise ValueError("Duplicate source archive member")
            names[name.casefold()] = info
        raw = archive.read(RELEASE)
        if len(raw) > 32 * 1024 * 1024:
            raise ValueError("Oversized core manifest")
        manifest = json.loads(raw)
        if (manifest.get("format") != "dordiai-core-release" or manifest.get("format_version") != 1
                or not isinstance(manifest.get("files"), dict)):
            raise ValueError("Unsupported immutable core")
        if set(names) != {name.casefold() for name in manifest["files"]} | {RELEASE.casefold()}:
            raise ValueError("Source archive inventory differs")
        catalogue = archive.read(BANK_ROOT + "catalog.json")
        ids = sorted(json.loads(catalogue))
    return manifest, catalogue, ids


def make_plan(core, expected, audit, policy, probe_source, expected_voice_count=45):
    release, catalogue, ids = source_manifest(core, expected)
    if len(ids) != expected_voice_count or set(ids) != set(release.get("voice_ids", [])):
        raise ValueError("Source voice catalogue count/identity differs")
    for profile in ids:
        policy.require_voice_allowed(profile)
        if not re.fullmatch("[a-z][a-z0-9_-]{0,63}", profile):
            raise ValueError("Unsafe source profile identifier")
    if set(release.get("excluded_voice_ids", [])) != set(policy.EXCLUDED_VOICE_IDS):
        raise ValueError("Source exclusion policy differs")
    worker_source_sha = release["files"].get("kx47Runtime/nvda_worker.py", {}).get("sha256")
    if not isinstance(worker_source_sha, str) or not re.fullmatch("[0-9a-f]{64}", worker_source_sha):
        raise ValueError("Immutable source lacks the actual worker script hash")
    report = audit.inspect(core, ["all"], probe_source=probe_source)
    jobs = {}
    for row in report["profiles"]:
        profile = row["profile"]
        if any(item["no_default_prepared_candidate"] for item in row["summary"].values()):
            raise ValueError("An original alphabet is missing; this plan must not replace it")
        selected = {}
        for item in row["probe_rows"]:
            if item["category"] == "letter" or item["prepared_candidate"] and item["category"] != "space":
                continue
            language, text, key = item["language"], item["text"], item["bank_key"]
            if language not in {"uk", "ru", "en-us"} or not text.strip() or len(text) > 160:
                raise ValueError("Unexpected supplemental utterance")
            if key in selected:
                if selected[key]["language"] != language or selected[key]["text"] != text:
                    raise ValueError("Conflicting same-key spoken labels")
                selected[key]["glyphs"].append(item["glyph"])
                continue
            reuse = None
            if item["prepared_candidate"]:
                if item["category"] != "space" or item["metadata_candidate"] != "navigation":
                    raise ValueError("Only confirmed original space clips may be retained")
                reuse = BANK_ROOT + "navigation/" + profile + "/" + item["navigation_key"] + ".wav"
                if reuse not in release["files"]:
                    raise ValueError("Retained clip is absent from the immutable release manifest")
            selected[key] = {"key": key, "language": language, "text": text,
                "glyphs": [item["glyph"]], "runtime_kinds": [item["kind"]],
                "mapping_origin": item["mapping_origin"], "worker_source_sha256": worker_source_sha, "reuse_wav": reuse,
                "reuse_wav_sha256": release["files"][reuse]["sha256"] if reuse is not None else None}
        jobs[profile] = sorted(selected.values(), key=lambda j: ({"uk": 0, "ru": 1, "en-us": 2}[j["language"]], j["key"]))
    if sorted(jobs) != ids:
        raise ValueError("Plan lost a source profile")
    return {"format": "dordiai-supplementary-bank-plan", "format_version": 1,
            "core_sha256": expected, "core_size_bytes": Path(core).stat().st_size,
            "catalogue_sha256": sha256(catalogue).hexdigest(), "voice_ids": ids, "jobs": jobs,
            "source": {"driver_sha256": report["driver_sha256"],
                       "character_name_sources": report["character_name_sources"],
                       "semantic_anchors_sha256": report["semantic_anchors_sha256"],
                       "probe_definition": report["probe_definition"]}}


def prepare_work(work, plan, version, resume):
    work = Path(work).absolute()
    if work.is_symlink() or getattr(work, "is_junction", lambda: False)():
        raise ValueError("Linked work root")
    if os.name == "nt" and len(str(work / "core8/kx47Runtime/python/python.exe")) > 180:
        raise ValueError("Choose a fixed short owned Windows work root")
    work.mkdir(parents=True, exist_ok=True)
    state = work / "state"
    marker = state / "owner.json"
    recipe_identity = {key: plan[key] for key in ("core_sha256", "catalogue_sha256", "voice_ids", "jobs")}
    expected = {"format": "dordiai-bank-generation-state", "format_version": 1,
                "core_sha256": plan["core_sha256"], "overlay_version": version,
                "plan_sha256": sha256(json_bytes(recipe_identity)).hexdigest()}
    if state.is_symlink() or getattr(state, "is_junction", lambda: False)():
        raise ValueError("Linked resume state")
    if not marker.exists() and any(work.iterdir()):
        raise ValueError("Unowned nonempty work root")
    if marker.exists():
        if marker.stat().st_size > 65536 or not resume or json.loads(marker.read_text(encoding="utf-8")) != expected:
            raise ValueError("Existing state belongs to another source/version/plan; refusing reuse")
    else:
        if state.exists() and any(state.iterdir()):
            raise ValueError("Unowned nonempty resume state")
        state.mkdir(parents=True, exist_ok=True)
        atomic_json(marker, expected)
    atomic_json(state / "plan.json", plan)
    return work, state


@contextmanager
def owned_lock(work):
    path = work / "generation.lock"
    with path.open("a+b") as stream:
        stream.seek(0)
        if not stream.read(1):
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                yield
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def extract_core(core, directory, release):
    directory.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(core) as archive:
        for name, record in release["files"].items():
            info = archive.getinfo(name)
            safe_name(info)
            if info.file_size != record["size_bytes"]:
                raise ValueError("Source member size differs")
            path = directory.joinpath(*PurePosixPath(name).parts)
            if path.is_symlink():
                raise ValueError("Linked extracted source")
            if path.exists():
                if digest(path) != record["sha256"]:
                    raise ValueError("Previously extracted immutable source was modified")
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            value = sha256()
            with archive.open(info) as source, path.open("xb") as destination:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    value.update(block)
                    destination.write(block)
            if value.hexdigest() != record["sha256"]:
                raise ValueError("Extracted immutable source digest differs")
    expected_names = set(release["files"])
    for path in directory.rglob("*"):
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise ValueError("Linked immutable runtime entry")
        if path.is_file() and path.relative_to(directory).as_posix() not in expected_names:
            raise ValueError("Unexpected executable/data file in immutable runtime")
    return directory / "kx47Runtime"


def file_signature(path):
    value = Path(path).stat()
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def runtime_source_paths(runtime, profile, release):
    selected = []
    for name in release["files"]:
        relative = PurePosixPath(name)
        if not name.startswith("kx47Runtime/"):
            continue
        suffix = relative.suffix.lower()
        is_weight = name.startswith("kx47Runtime/models/") and suffix in {".onnx", ".safetensors", ".bin", ".exe"}
        is_profile = name.startswith(BANK_ROOT) and (profile in relative.parts or relative.stem == profile) and "/navigation" not in name and "/native_letters/" not in name and "/native_commands/" not in name
        is_code = len(relative.parts) == 2 and suffix == ".py"
        if is_weight or is_profile or is_code:
            selected.append(runtime.parent.joinpath(*relative.parts))
    return selected


def assert_snapshot(snapshot):
    if any(file_signature(path) != saved for path, saved in snapshot):
        raise ValueError("Immutable engine/profile source changed during preparation")


def verify_renderer(result, profile):
    rows = result.get("renderers")
    if not isinstance(rows, list) or not rows:
        raise ValueError("Actual worker did not attest a renderer")
    if any(not isinstance(row, dict) or row.get("profile") != profile
           or row.get("speaker", profile) != profile or not isinstance(row.get("engine"), str) for row in rows):
        raise ValueError("Worker changed the selected voice identity")
    return rows


def expected_request(profile, job):
    return {"mode": "reference", "profile": profile, "language": job["language"], "text": job["text"],
            "speed": 1.0, "controls": {"pitch": 50, "timbre": 50, "volume": 100},
            "numberLanguage": "auto", "character": False, "nativeEnglish": False,
            "nativeProfile": job["language"] in {"en-us", "ru"}}


class CheckedWorker:
    def __init__(self, worker, profile, snapshot, job):
        self.worker, self.profile, self.snapshot, self.job = worker, profile, snapshot, job
    def render(self, request, timeout):
        expected = expected_request(self.profile, self.job)
        if (any(request.get(key) != value for key, value in expected.items())
                or any(request.get(key) for key in ("segments", "nextNative", "nativeLocale", "wideLocale"))):
            raise ValueError("Unexpected generation semantics")
        assert_snapshot(self.snapshot)
        pcm, report = self.worker.render(request, timeout)
        assert_snapshot(self.snapshot)
        verify_renderer(report, self.profile)
        return pcm, report


def pcm_valid(pcm, probe):
    if not isinstance(pcm, bytes) or not 2 <= len(pcm) <= MAX_PCM or len(pcm) % 2:
        raise ValueError("Invalid prepared mono16 PCM size")
    statistics = probe.audio_statistics(pcm)
    if not statistics["nonzero_samples"]:
        raise ValueError("Prepared speech is digital silence")
    return statistics


def cached_clip(directory, job, profile, core_sha, probe):
    record_path = directory / "clip.json"
    if not record_path.exists():
        return None
    if directory.is_symlink() or getattr(directory, "is_junction", lambda: False)():
        raise ValueError("Linked clip state")
    if record_path.is_symlink() or record_path.stat().st_size > 512 * 1024:
        raise ValueError("Linked/oversized clip metadata")
    record = json.loads(record_path.read_text(encoding="utf-8"))
    expected = {"status": "complete", "profile": profile, "language": job["language"],
                "text": job["text"], "key": job["key"], "source_core_sha256": core_sha}
    if any(record.get(key) != value for key, value in expected.items()):
        raise ValueError("Completed clip belongs to another recipe/voice/source")
    origin = record.get("origin", {})
    if job["reuse_wav"]:
        if (origin.get("kind") != "retained-core8-prepared-navigation" or origin.get("path") != job["reuse_wav"]
                or origin.get("sha256") != job["reuse_wav_sha256"]):
            raise ValueError("Retained clip provenance differs")
    elif (origin.get("kind") != "actual-private-worker" or origin.get("request") != expected_request(profile, job)
            or origin.get("path") != "kx47Runtime/nvda_worker.py"
            or origin.get("sha256") != job.get("worker_source_sha256")):
        raise ValueError("Cached neural request semantics differ")
    verify_renderer(record.get("worker", {}), profile)
    pcm_path = directory / "clip.pcm"
    if pcm_path.is_symlink() or not stat.S_ISREG(pcm_path.stat().st_mode) or pcm_path.stat().st_size > MAX_PCM:
        raise ValueError("Linked/oversized/nonregular PCM cache")
    pcm = pcm_path.read_bytes()
    pcm_valid(pcm, probe)
    if len(pcm) != record.get("size_bytes") or sha256(pcm).hexdigest() != record.get("pcm_sha256"):
        raise ValueError("Completed clip cache checksum differs; refusing silent regeneration")
    record["pcm_path"] = str(pcm_path)
    return record


def prepare_clip(directory, core, release, runtime, job, profile, core_sha, worker, probe, preparation,
                 timeout, snapshot):
    directory.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=directory.name + ".preparing-", dir=directory.parent))
    try:
        if job["reuse_wav"]:
            member = job["reuse_wav"]
            expected_member = BANK_ROOT + "navigation/" + profile + "/" + job["key"] + ".wav"
            if member != expected_member:
                raise ValueError("Retained WAV is not this profile's exact prepared space key")
            with zipfile.ZipFile(core) as archive:
                if archive.getinfo(member).file_size > MAX_PCM + 65536:
                    raise ValueError("Oversized retained space WAV")
                raw = archive.read(member)
            if sha256(raw).hexdigest() != release["files"][member]["sha256"]:
                raise ValueError("Retained same-profile clip digest differs")
            import io
            with wave.open(io.BytesIO(raw), "rb") as stream:
                if (stream.getframerate(), stream.getnchannels(), stream.getsampwidth()) != (24000, 1, 2):
                    raise ValueError("Retained space clip has wrong audio format")
                frames = stream.getnframes()
                if not 0 < frames <= MAX_PCM // 2:
                    raise ValueError("Retained space duration exceeds bank bounds")
                pcm = stream.readframes(frames)
                if len(pcm) != frames * 2:
                    raise ValueError("Truncated retained space WAV")
            result = {"renderers": [{"engine": "retained-core8-navigation", "profile": profile, "speaker": profile}]}
            origin = {"kind": "retained-core8-prepared-navigation", "path": member,
                      "sha256": release["files"][member]["sha256"]}
        else:
            row = {"kind": "command", "language": job["language"], "lookup_text": job["text"],
                   "text": job["text"], "semantic_kind": "literal_text",
                   "source_kind": job["mapping_origin"], "source_id": "immutable-core8-runtime-plan",
                   "acoustic_validation": "pending"}
            worker_sha = release["files"].get("kx47Runtime/nvda_worker.py", {}).get("sha256")
            if worker_sha != job.get("worker_source_sha256"):
                raise ValueError("Neural worker source differs from the plan")
            preparation.generate_banks(CheckedWorker(worker, profile, snapshot, job), probe, profile, [row],
                                       temporary / "generated", timeout=timeout)
            pcm = (temporary / "generated/commands.pcm").read_bytes()
            completed = json.loads((temporary / "generated/generation-progress.json").read_text(encoding="utf-8"))
            if completed.get("complete") is not True or len(completed.get("runs", [])) != 1:
                raise ValueError("Generator did not complete exactly one utterance")
            result = completed["runs"][0]["worker"]
            verify_renderer(result, profile)
            origin = {"kind": "actual-private-worker", "path": "kx47Runtime/nvda_worker.py",
                      "sha256": worker_sha, "request": expected_request(profile, job)}
        statistics = pcm_valid(pcm, probe)
        (temporary / "clip.pcm").write_bytes(pcm)
        report = {"status": "complete", "profile": profile, "language": job["language"],
                  "text": job["text"], "key": job["key"], "source_core_sha256": core_sha,
                  "pcm_sha256": sha256(pcm).hexdigest(), "size_bytes": len(pcm), "audio": statistics,
                  "origin": origin, "worker": {key: result[key] for key in ("renderers", "first_pcm_ms", "completed_ms") if key in result},
                  "pronunciation_verified": False, "nvda_verified": False, "physical_audio_verified": False}
        atomic_json(temporary / "clip.json", report)
        # Only compact resumable clip data is retained; generated scratch banks
        # are not part of the standalone overlay or the resume state.
        shutil.rmtree(temporary / "generated", ignore_errors=True)
        temporary.rename(directory)
        report["pcm_path"] = str(directory / "clip.pcm")
        return report
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


@contextmanager
def worker_lifetime(holder, report):
    try:
        yield
    finally:
        worker = holder.get("worker")
        if worker is not None:
            try:
                worker.send({"mode": "cancel"})
                worker.send({"mode": "drop"})
            except Exception:
                pass
            result = worker.close()
            holder["worker"] = None
            report["worker_shutdown"] = result
            if not isinstance(result, dict) or result.get("exit_code") is None:
                raise RuntimeError("Owned worker termination was not proven")



def run(args):
    if os.name != "nt":
        raise ValueError("Actual packaged Windows worker required")
    if not args.user_provided_provenance:
        raise ValueError("Explicit UserProvidedProvenance marker is required; no licence is fabricated")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", args.version):
        raise ValueError("Invalid immutable overlay version")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1")
    overlay, audit, preparation, probe, policy = tools()
    core, output = args.core.resolve(strict=True), args.output.absolute()
    if output.exists() or output.is_symlink():
        raise FileExistsError("Overlay output is immutable; choose a new destination")
    plan = make_plan(core, args.expected_core_sha256, audit, policy, args.probe_source, args.expected_voice_count)
    release, _, _ = source_manifest(core, args.expected_core_sha256)
    if output.resolve().is_relative_to(args.work_root.absolute().resolve()):
        raise ValueError("Standalone overlay must be outside its owned source/resume root")
    work, state = prepare_work(args.work_root, plan, args.version, args.resume)
    report = {"format": "dordiai-supplementary-bank-generation", "format_version": 1,
              "status": "preparing", "source_core_sha256": plan["core_sha256"], "overlay_version": args.version,
              "planned_clips": sum(map(len, plan["jobs"].values())), "new_worker_clips": 0,
              "retained_space_clips": 0, "resumed_clips": 0, "completed_clips": 0,
              "pronunciation_verified": False, "nvda_verified": False, "physical_audio_verified": False}
    holder = {"worker": None}
    deadline = time.monotonic() + args.max_seconds
    try:
        with owned_lock(work), worker_lifetime(holder, report):
            runtime = extract_core(core, work / "core8", release)
            source_records = overlay.identity_inputs(release)
            def verify_source():
                for name, record in source_records.items():
                    path = runtime.parent.joinpath(*PurePosixPath(name).parts)
                    if path.stat().st_size != record["size_bytes"] or digest(path) != record["sha256"]:
                        raise ValueError("Immutable renderer/source asset changed: " + name)
            verify_source()
            initial_signatures = {runtime.parent.joinpath(*PurePosixPath(name).parts):
                                  file_signature(runtime.parent.joinpath(*PurePosixPath(name).parts))
                                  for name in release["files"]}
            records = {}
            for profile in plan["voice_ids"]:
                records[profile] = {}
                snapshot = [(path, initial_signatures[path]) for path in runtime_source_paths(runtime, profile, release)]
                assert_snapshot(snapshot)
                for job in plan["jobs"][profile]:
                    cache = state / "clips" / profile / job["key"]
                    clip = cached_clip(cache, job, profile, plan["core_sha256"], probe)
                    if clip is None:
                        if time.monotonic() >= deadline - 15 or args.max_new_clips and report["new_worker_clips"] + report["retained_space_clips"] >= args.max_new_clips:
                            raise PreparationPaused("Finite generation budget exhausted; completed clips retained")
                        if not job["reuse_wav"] and holder["worker"] is None:
                            logs = state / "logs"
                            logs.mkdir(exist_ok=True)
                            holder["worker"] = probe.PipeWorker(runtime, logs / ("worker-" + uuid.uuid4().hex + ".stderr.log"))
                        clip = prepare_clip(cache, core, release, runtime, job, profile, plan["core_sha256"],
                            holder["worker"], probe, preparation, min(args.timeout, max(1., deadline-time.monotonic())), snapshot)
                        report["retained_space_clips" if job["reuse_wav"] else "new_worker_clips"] += 1
                    else:
                        report["resumed_clips"] += 1
                    records[profile][job["key"]] = clip
                    report["completed_clips"] += 1
                    atomic_json(state / "generation-report.json", report)
                    print(json.dumps({"profile": profile, "language": job["language"],
                        "completed": report["completed_clips"], "total": report["planned_clips"],
                        "origin": clip["origin"]["kind"]}, ensure_ascii=True), flush=True)
            if holder["worker"] is not None:
                report["worker_shutdown"] = holder["worker"].close()
                holder["worker"] = None
                if report["worker_shutdown"].get("exit_code") is None:
                    raise RuntimeError("Owned worker termination was not proven")
            verify_source()
            provenance = {"kind": "UserProvidedProvenance",
                "statement": "Retained project voice profiles supplied by the project owner; supplementary preparation authorized by the owner. Original source/model terms remain unchanged.",
                "independent_speaker_consent_or_licence_verification": False,
                "new_licence_asserted": False,
                "generator_sha256": digest(__file__),
                "preparation_helper_sha256": digest(Path(preparation.__file__)),
                "probe_helper_sha256": digest(Path(probe.__file__))}
            built = overlay.build_overlay(core, output, args.version, plan, records, provenance)
            report["overlay"] = {"archive": built["archive"], "version": args.version,
                                 "source_core_sha256": plan["core_sha256"]}
            report["status"] = "complete"
            atomic_json(state / "generation-report.json", report)
            print(json.dumps({"status": "complete", "overlay": report["overlay"]}, ensure_ascii=True), flush=True)
            return 0
    except PreparationPaused as error:
        report.update(status="paused-not-published", error=str(error))
        return 2
    except BaseException as error:
        report.update(status="failed-not-published", error_type=type(error).__name__, error=str(error))
        raise
    finally:
        atomic_json(state / "generation-report.json", report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", required=True, type=Path)
    parser.add_argument("--expected-core-sha256", required=True)
    parser.add_argument("--work-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--probe-source", type=Path, default=ROOT / "tools/windows_nvda_probe.py")
    parser.add_argument("--expected-voice-count", type=int, default=45)
    parser.add_argument("--user-provided-provenance", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--timeout", type=float, default=90.)
    parser.add_argument("--max-seconds", type=float, default=2400.)
    parser.add_argument("--max-new-clips", type=int, default=0, help="Supervised trial budget; incomplete jobs never publish an overlay")
    args = parser.parse_args()
    if args.timeout <= 0 or args.max_seconds <= 0 or args.max_new_clips < 0:
        parser.error("Positive finite budgets are required")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
