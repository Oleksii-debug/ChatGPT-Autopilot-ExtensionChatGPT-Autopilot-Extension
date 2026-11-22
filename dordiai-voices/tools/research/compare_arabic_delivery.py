"""Compare immutable Arabic1305 PCM with source-bound prepare_letter offline.

This is a research measurement tool. It neither installs nor activates a bank.
Activity measurements describe samples, never a proved phonetic silence/onset.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import stat
import wave
from zipfile import ZipFile

import numpy as np

PROJECT = Path(__file__).resolve().parents[2]
RAW_BYTES = 101_748_675
RAW_SHA256 = "14b6838daff3621a67f71d443610787467cc5e9f007930d7aa244f3d9bc6a6f4"
POLICY_SHA256 = "2d5a1877622f6d7e95babc12685f88f69999263fa0a6fd32748f2093cda2ea93"
REPORT_SHA256 = "5a46e99b41c87e7970cd8c000c0ddd3b5668622fffc12e08e957cb0065dac91c"
INDEX_SHA256 = "4f85288544604cd59d6a524b7cf8c8917ea23d19165f29a4e6e847844650a92f"
RATE = 24_000
QUIET_GLYPHS = frozenset(("ح", "ه", "ف"))
EXCLUDED = frozenset(("kostia", "inna", "dina", "vira", "innesa",
                      "veronika_classmate", "anatolii", "veronika"))
GLYPHS = tuple("ابتثجحخدذرزسشصضطظعغفقكلمنهويء")
MAX_MEMBER_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 192 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def pinned_json(path, expected):
    raw = Path(path).read_bytes()
    if digest(raw) != expected:
        raise ValueError("Exact source evidence checksum differs: " + str(path))
    return json.loads(raw)


def load_policy(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or file_digest(path) != POLICY_SHA256:
        raise ValueError("Exact reviewed source13 delivery policy is required")
    spec = importlib.util.spec_from_file_location("_arabic_delivery_review_policy", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if module.SAMPLE_RATE != RATE:
        raise ValueError("Unexpected delivery sample rate")
    return module


def safe_member(info):
    path = PurePosixPath(info.filename)
    mode = info.external_attr >> 16
    if (info.is_dir() or not info.filename or info.orig_filename != info.filename
            or "\\" in info.orig_filename or ":" in path.parts[0]
            or path.is_absolute() or ".." in path.parts
            or any(ord(char) < 32 for char in info.filename)
            or (stat.S_IFMT(mode) and not stat.S_ISREG(mode)) or info.file_size > MAX_MEMBER_BYTES
            or info.flag_bits & 1):
        raise ValueError("Unexpected raw archive member: " + info.filename)


def verify_archive(archive, expected_files):
    """Verify every retained original member, without extracting executable data."""
    infos = archive.infolist()
    if len(infos) != len(expected_files) or len({info.filename for info in infos}) != len(infos):
        raise ValueError("Raw archive member set has changed")
    if sum(info.file_size for info in infos) > MAX_TOTAL_BYTES:
        raise ValueError("Unexpected uncompressed archive size")
    mapping = {item["path"]: item for item in expected_files}
    if len(mapping) != len(expected_files) or set(mapping) != {info.filename for info in infos}:
        raise ValueError("Original byte index differs from archive members")
    for info in infos:
        safe_member(info)
        expected = mapping[info.filename]
        data = archive.read(info)
        if len(data) != expected["size_bytes"] or digest(data) != expected["sha256"]:
            raise ValueError("Original archive member failed checksum: " + info.filename)


def region_statistics(audio):
    values = np.asarray(audio, dtype=np.float32)
    if not len(values):
        return {"frames": 0, "seconds": 0.0, "peak": 0.0, "rms": 0.0,
                "nonzero_samples": 0, "above_one_pcm_tick": 0, "pcm_sha256": digest(b"")}
    return {
        "frames": len(values), "seconds": len(values) / RATE,
        "peak": float(np.max(np.abs(values))),
        "rms": float(np.sqrt(np.mean(values.astype(np.float64) ** 2))),
        "nonzero_samples": int(np.count_nonzero(values)),
        "above_one_pcm_tick": int(np.count_nonzero(np.abs(values) > 1.0 / 32768)),
        "pcm_sha256": digest(pcm16(values)),
    }


def pcm16(audio):
    values = np.asarray(audio, dtype=np.float32)
    return np.asarray(np.rint(np.clip(values, -1.0, 32767 / 32768) * 32768), dtype="<i2").tobytes()


def activity_diagnostics(audio):
    """Whole-clip 10ms RMS observations; no threshold is used for cropping here."""
    values = np.asarray(audio, dtype=np.float32)
    width = RATE // 100
    bins = [float(np.sqrt(np.mean(values[start:start + width].astype(np.float64) ** 2)))
            for start in range(0, len(values), width)]
    maximum = max(bins, default=0.0)
    observations = {}
    for fraction in (.001, .005, .02, .055):
        active = [i for i, energy in enumerate(bins) if maximum and energy >= maximum * fraction]
        observations[str(fraction)] = {
            "first_bin_ms": active[0] * 10 if active else None,
            "last_bin_end_ms": min(len(values) / RATE * 1000, (active[-1] + 1) * 10) if active else None,
        }
    return {"bin_ms": 10, "max_rms": maximum, "relative_activity": observations,
            "interpretation": "Diagnostic activity only. Quiet consonants and noise can both lie below these thresholds."}


def compare_clip(raw_pcm, policy, *, quiet_glyph=False):
    if not isinstance(raw_pcm, bytes) or len(raw_pcm) % 2:
        raise ValueError("A complete little-endian int16 mono clip is required")
    original = np.frombuffer(raw_pcm, dtype="<i2").astype(np.float32) / 32768
    if not np.isfinite(original).all() or not np.count_nonzero(original):
        raise ValueError("Finite audible original PCM is required")
    scratch = original.copy()
    slices = []
    clean_onset = policy.clean_onset

    def observe(chunks, *, character=False):
        # prepare_letter passes its one contiguous selected input view here.
        # Forward the actual samples unchanged to the original cleaner.
        blocks = tuple(chunks)
        if len(blocks) != 1 or not np.shares_memory(blocks[0], scratch):
            raise ValueError("The pinned policy's slice-observation contract changed")
        offset = (blocks[0].ctypes.data - scratch.ctypes.data) // scratch.itemsize
        if offset < 0 or offset + len(blocks[0]) > len(scratch):
            raise ValueError("The observed delivery slice lies outside its original")
        slices.append((offset, offset + len(blocks[0])))
        yield from clean_onset(blocks, character=character)

    policy.clean_onset = observe
    try:
        derived = np.asarray(policy.prepare_letter(scratch), dtype=np.float32)
    finally:
        policy.clean_onset = clean_onset
    if len(slices) != 1 or len(derived) != slices[0][1] - slices[0][0]:
        raise ValueError("Delivery observation failed to preserve exact output boundaries")
    if not np.isfinite(derived).all() or not len(derived):
        raise ValueError("The policy produced invalid candidate samples")
    if pcm16(original) != raw_pcm:
        raise ValueError("Original sample decoding failed its exact byte round trip")
    begin, end = slices[0]
    prefix = region_statistics(original[:begin])
    suffix = region_statistics(original[end:])
    removed_signal = bool(prefix["nonzero_samples"] or suffix["nonzero_samples"])
    record = {
        "raw": {**region_statistics(original), "sha256": digest(raw_pcm)},
        "observed_source_slice": {
            "start_frame": begin, "end_frame_exclusive": end,
            "kept_frames": end - begin,
            "kept_original_pcm_sha256": digest(raw_pcm[2*begin:2*end]),
        },
        "removed_prefix": prefix, "removed_suffix": suffix,
        "raw_activity": activity_diagnostics(original),
        "derived_activity": activity_diagnostics(derived),
        "derived": region_statistics(derived),
        "quiet_fricative_review": quiet_glyph,
        "removed_nonzero_samples": removed_signal,
        "requires_phonetic_boundary_review": quiet_glyph or removed_signal,
        "phonetic_onset_verified": False, "phonetic_tail_verified": False,
        "native_pronunciation_verified": False, "physical_audio_verified": False,
        "activation_allowed": False,
    }
    return derived, record


def read_bank(archive, profile, bank):
    if not re.fullmatch("[a-z0-9_]+", profile) or profile in EXCLUDED:
        raise ValueError("Only allowed immutable profile IDs may be compared")
    if bank["audio"]["name"] != profile+".pcm" or bank["index"]["name"] != profile+".json":
        raise ValueError("Immutable per-profile bank filename differs")
    audio_name = "pcm/banks/ar/" + bank["audio"]["name"]
    index_name = "pcm/banks/ar/" + bank["index"]["name"]
    audio = archive.read(audio_name)
    index_raw = archive.read(index_name)
    if digest(audio) != bank["audio"]["sha256"] or len(audio) != bank["audio"]["size_bytes"]:
        raise ValueError("Original bank PCM differs")
    if digest(index_raw) != bank["index"]["sha256"] or len(index_raw) != bank["index"]["size_bytes"]:
        raise ValueError("Original bank index differs")
    return audio, json.loads(index_raw)


def read_clip(audio, entries, clip):
    offset, size = clip["offset"], clip["size_bytes"]
    if (type(offset) is not int or type(size) is not int or offset < 0 or size <= 0
            or offset % 2 or size % 2 or offset + size > len(audio)
            or entries.get(clip["key"]) != [offset, size]):
        raise ValueError("Original clip range differs")
    pcm = audio[offset:offset + size]
    if digest(pcm) != clip["pcm_sha256"]:
        raise ValueError("Original individual clip failed checksum")
    return pcm


def save_wave(path, samples):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as target:
        target.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        target.writeframes(pcm16(samples))


def compare_archive(raw_archive, output, *, write_candidates=False, project=PROJECT):
    raw_archive = Path(raw_archive)
    project, output = Path(project), Path(output)
    if raw_archive.is_symlink() or not raw_archive.is_file() or raw_archive.stat().st_size != RAW_BYTES:
        raise ValueError("The immutable complete raw1305 archive is required")
    if file_digest(raw_archive) != RAW_SHA256:
        raise ValueError("The complete original archive failed its pinned SHA256")
    proof = pinned_json(project / "evidence/ar_full_banks_windows_45053476903.exact-crlf.json", REPORT_SHA256)
    index = pinned_json(project / "evidence/ar_full_banks_archive_index_45053476903.json", INDEX_SHA256)
    policy = load_policy(project / "source/0.12.2/kx47Runtime/voice_delivery.py")
    profiles = proof["all45_profile_ids"]
    if (len(profiles) != 45 or len(set(profiles)) != 45 or set(profiles) & EXCLUDED
            or set(profiles) != set(proof["banks"]) or tuple(proof["selected_glyphs"]) != GLYPHS
            or proof["actual_clip_count"] != 1305 or proof["sample_rate"] != RATE):
        raise ValueError("Exact45-profile/29-name raw bank contract differs")
    if output.exists():
        raise FileExistsError("Research output must be a fresh directory")
    rows = []
    with ZipFile(raw_archive) as archive:
        verify_archive(archive, index["files"])
        output.mkdir(parents=True, exist_ok=False)
        for profile in profiles:
            bank = proof["banks"][profile]
            clips = bank["clips"]
            if tuple(clip["glyph"] for clip in clips) != GLYPHS or bank["profile"] != profile:
                raise ValueError("Original per-profile name order differs")
            bank_audio, entries = read_bank(archive, profile, bank)
            if set(entries) != {clip["key"] for clip in clips}:
                raise ValueError("Original bank contains unaccounted clip keys")
            position = 0
            for clip in clips:
                if clip["offset"] != position:
                    raise ValueError("Original clip ranges are not complete and contiguous")
                raw_pcm = read_clip(bank_audio, entries, clip)
                position += len(raw_pcm)
                derived, measured = compare_clip(raw_pcm, policy, quiet_glyph=clip["glyph"] in QUIET_GLYPHS)
                record = {"profile": profile, "glyph": clip["glyph"], "ordinary_name": clip["ordinary_name"],
                          "key": clip["key"], "original_bank_path": "pcm/banks/ar/" + profile + ".pcm",
                          "original_offset": clip["offset"], "original_bytes": clip["size_bytes"],
                          **measured}
                if write_candidates:
                    relative = Path("derived") / profile / (f"{ord(clip['glyph']):04x}.wav")
                    save_wave(output / relative, derived)
                    record["derived_wave"] = {"path": relative.as_posix(),
                                              "sha256": file_digest(output / relative)}
                rows.append(record)
            if position != bank["audio"]["size_bytes"]:
                raise ValueError("The original bank has unaccounted trailing PCM")
            print("Compared original Arabic delivery", profile, len(clips), flush=True)
    if file_digest(raw_archive) != RAW_SHA256:
        raise ValueError("The original archive changed during research")
    quiet = [row for row in rows if row["quiet_fricative_review"]]
    report = {
        "format": "dordiai-arabic-delivery-source13-comparison", "format_version": 1,
        "research_only": True, "source_archive": {"bytes": RAW_BYTES, "sha256": RAW_SHA256},
        "policy_sha256": POLICY_SHA256, "original_proof_sha256": REPORT_SHA256,
        "original_archive_member_index_sha256": INDEX_SHA256,
        "profiles": len(profiles), "clips": len(rows), "quiet_fricative_clips": len(quiet),
        "original_archive_unchanged": True, "original_archive_members_verified": len(index["files"]),
        "raw_originals_preserved": True, "existing3330_regenerated": False,
        "production_source_changed": False, "candidate_waves_written": write_candidates,
        "clips_with_nonzero_removed": sum(row["removed_nonzero_samples"] for row in rows),
        "quiet_clips_with_nonzero_removed": sum(row["removed_nonzero_samples"] for row in quiet),
        "total_raw_frames": sum(row["raw"]["frames"] for row in rows),
        "total_derived_frames": sum(row["derived"]["frames"] for row in rows),
        "review_requirements": ["Listen to complete original and derived quiet consonant attacks and natural endings.",
                                "Inspect acoustic alignment independently. Activity is not phonetic silence.",
                                "Measure real NVDA typed-character and audio-device onset before activation."],
        "activation_allowed": False, "native_pronunciation_verified": False,
        "physical_audio_verified": False, "product_ready": False, "results": rows,
    }
    destination = output / "comparison.json"
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n", encoding="utf8")
    print("Arabic delivery comparison saved", len(rows), "activation remains unaccepted", flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-archive", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--write-candidates", action="store_true")
    args = parser.parse_args()
    compare_archive(args.raw_archive, args.output, write_candidates=args.write_candidates)


if __name__ == "__main__":
    main()

