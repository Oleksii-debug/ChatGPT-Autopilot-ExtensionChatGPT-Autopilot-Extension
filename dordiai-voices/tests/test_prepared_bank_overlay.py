"""Synthetic metadata/data-integrity fixtures only: no model or listening proof."""
from __future__ import annotations
from copy import deepcopy
from dataclasses import dataclass
from hashlib import sha256
import importlib.util
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
import wave
import zipfile

SPEC = importlib.util.spec_from_file_location(
    "prepared_bank_overlay", Path(__file__).resolve().parents[1] / "tools/prepared_bank_overlay.py")
overlay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(overlay)


@dataclass(frozen=True)
class InputFile:
    path: str
    source: Path
    group: str = "core"
    transformed: bytes | None = None


def raw_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def record(raw):
    return {"sha256": sha256(raw).hexdigest(), "size_bytes": len(raw)}


class OverlayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.profiles = [f"voice{number:02d}" for number in range(45)]
        self.profile = self.profiles[0]
        self.old_key = overlay.bank_key("uk", "раніше")
        self.old_pcm = struct.pack("<hhh", 123, -456, 789)
        self.clip = struct.pack("<hhhh", 111, -222, 333, -444)
        self.payload = {
            overlay.CATALOGUE: raw_json({profile: {"name": profile} for profile in self.profiles}),
            "kx47Runtime/models/test/model.bin": b"synthetic-acoustic-model-not-real",
            "kx47Runtime/python/Lib/test.py": b"# synthetic private runtime\n",
            "kx47Runtime/nvda_worker.py": b"# synthetic worker\n",
            "kx47Runtime/speech_text.py": b"# synthetic renderer\n",
            "manifest.ini": b'version = "synthetic"\n',
        }
        for profile in self.profiles:
            for role in overlay.ROLES:
                self.payload[overlay._bank_path(role, profile, "json")] = raw_json({self.old_key: [0, len(self.old_pcm)]})
                self.payload[overlay._bank_path(role, profile, "pcm")] = self.old_pcm
        self.release = {
            "format": "dordiai-core-release", "format_version": 1,
            "voice_ids": self.profiles,
            "files": {name: record(raw) for name, raw in self.payload.items()},
        }
        self.core = self.root / "synthetic-core.zip"
        self._write_core()
        job = {"language": "uk", "text": "додано", "glyphs": ["д"],
               "runtime_kinds": ["character"], "mapping_origin": {"synthetic_fixture": True}}
        job["key"] = overlay.bank_key(job["language"], job["text"])
        self.job = job
        self.plan = {
            "format": overlay.PLAN_FORMAT, "format_version": 1,
            "core_sha256": record(self.core.read_bytes())["sha256"],
            "core_size_bytes": self.core.stat().st_size,
            "catalogue_sha256": record(self.payload[overlay.CATALOGUE])["sha256"],
            "voice_ids": self.profiles,
            "jobs": {self.profile: [job]},
            "source": {"synthetic_metadata_only": True},
        }
        self.clip_path = self.root / "synthetic-clip.pcm"
        self.clip_path.write_bytes(self.clip)
        self.records = {self.profile: {job["key"]: {
            "pcm_path": str(self.clip_path), "pcm_sha256": record(self.clip)["sha256"],
            "size_bytes": len(self.clip), "profile": self.profile, "key": job["key"],
            "language": job["language"], "text": job["text"],
            "source_core_sha256": self.plan["core_sha256"], "status": "complete",
            "audio": {"synthetic_fixture": True}, "worker": {"synthetic_fixture": True},
            "origin": {"kind": "actual-private-worker", "path": "kx47Runtime/nvda_worker.py",
                       "sha256": record(self.payload["kx47Runtime/nvda_worker.py"])["sha256"]},
        }}}
        self.inputs = []
        for number, (name, raw) in enumerate(self.payload.items()):
            source = self.root / "inputs" / str(number)
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(raw)
            self.inputs.append(InputFile(name, source))
        self.output = self.root / "supplementary.zip"
        self.provenance = {"kind": "UserProvidedProvenance", "synthetic_metadata_only": True, "actual_model_proof": False}

    def _write_core(self):
        with zipfile.ZipFile(self.core, "w") as archive:
            for name, raw in self.payload.items():
                archive.writestr(name, raw)
            archive.writestr("dordiai-release.json", raw_json(self.release))

    def _repin_core(self):
        self.release["files"] = {name: record(raw) for name, raw in self.payload.items()}
        self._write_core()
        self.plan["core_sha256"] = record(self.core.read_bytes())["sha256"]
        self.plan["core_size_bytes"] = self.core.stat().st_size
        for clips in self.records.values():
            for metadata in clips.values():
                metadata["source_core_sha256"] = self.plan["core_sha256"]

    def build(self):
        return overlay.build_overlay(self.core, self.output, "1.0.0-test.1",
                                     self.plan, self.records, self.provenance)

    def rewrite(self, mutate):
        with zipfile.ZipFile(self.output) as archive:
            data = {name: archive.read(name) for name in archive.namelist()}
        manifest = json.loads(data[overlay.MANIFEST])
        mutate(data, manifest)
        data[overlay.MANIFEST] = raw_json(manifest)
        self.output.unlink()
        with zipfile.ZipFile(self.output, "w") as archive:
            for name, raw in data.items():
                archive.writestr(name, raw)

    def test_full180_append_only_raw_indices_and_context_lifetime(self):
        result = self.build()
        self.assertEqual(result["manifest"]["provenance"], self.provenance)
        self.assertEqual(len(result["manifest"]["files"]), 180)
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(len(archive.namelist()), 181)
            for role in overlay.ROLES:
                name = overlay._bank_path(role, self.profile, "json")
                index = json.loads(archive.read(name))
                pcm = archive.read(overlay._bank_path(role, self.profile, "pcm"))
                self.assertEqual(index[self.old_key], [0, len(self.old_pcm)])
                self.assertEqual(index[self.job["key"]], [len(self.old_pcm), len(self.clip)])
                self.assertEqual(pcm, self.old_pcm + self.clip)
                self.assertNotIn("entries", index)
        with overlay.apply_to_inputs(self.inputs, self.output, InputFile) as (updated, summary):
            staged = [item for item in updated if "/native_letters/" in item.path]
            self.assertTrue(all(item.source.exists() for item in staged))
            self.assertEqual(summary["bank_file_count"], 180)
            self.assertTrue(summary["append_only_verified"])
            one = staged[0].source
        self.assertFalse(one.exists())
        self.assertEqual(self.inputs[0].source.read_bytes(), self.payload[self.inputs[0].path])

    def test_transformed_bytes_bind_target_not_baseline_json(self):
        self.build()
        item = next(item for item in self.inputs if item.path == overlay.CATALOGUE)
        item.source.write_bytes(b"wrong-untransformed-baseline")
        transformed = [InputFile(x.path, x.source, x.group,
                                 self.payload[x.path] if x.path == overlay.CATALOGUE else None)
                       for x in self.inputs]
        with overlay.apply_to_inputs(transformed, self.output, InputFile) as (updated, _):
            self.assertEqual(len(updated), len(transformed))

    def test_optional_model_group_does_not_expand_core_identity(self):
        self.build()
        optional = self.root / "optional.onnx"
        optional.write_bytes(b"synthetic optional pack")
        inputs = self.inputs + [InputFile("kx47Runtime/models/WideLanguages/optional.onnx", optional, "wide-languages")]
        with overlay.apply_to_inputs(inputs, self.output, InputFile) as (updated, _):
            self.assertIn(inputs[-1], updated)

    def test_identity_scope_includes_all_models_private_python_and_acoustic_whitelist(self):
        identities = overlay.identity_inputs(self.release)
        self.assertIn("kx47Runtime/python/Lib/test.py", identities)
        self.assertIn("kx47Runtime/speech_text.py", identities)
        self.assertIn("kx47Runtime/models/test/model.bin", identities)
        self.assertNotIn("manifest.ini", identities)
        self.assertFalse(any("/native_commands/" in name for name in identities))

    def test_changed_core_renderer_is_rejected(self):
        self.build()
        item = next(x for x in self.inputs if x.path == "kx47Runtime/speech_text.py")
        item.source.write_bytes(b"changed renderer")
        with self.assertRaisesRegex(overlay.OverlayError, "identity changed"):
            with overlay.apply_to_inputs(self.inputs, self.output, InputFile):
                self.fail("Changed renderer accepted")

    def test_changed_identity_during_build_is_rejected_on_context_exit(self):
        self.build()
        item = next(x for x in self.inputs if x.path == "kx47Runtime/speech_text.py")
        with self.assertRaisesRegex(overlay.OverlayError, "during the build"):
            with overlay.apply_to_inputs(self.inputs, self.output, InputFile):
                item.source.write_bytes(b"modified while packaging")

    def test_immutable_output_not_overwritten(self):
        self.build()
        before = self.output.read_bytes()
        with self.assertRaises(FileExistsError):
            self.build()
        self.assertEqual(before, self.output.read_bytes())

    def test_wrong_core_pin_rejected_and_no_archive_published(self):
        self.plan["core_sha256"] = "0" * 64
        with self.assertRaisesRegex(overlay.OverlayError, "archive differs"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_excluded_profile_and_wrong_profile_clip_are_rejected(self):
        bad = deepcopy(self.plan)
        bad["voice_ids"][0] = "veronika"
        bad["voice_ids"].sort()
        with self.assertRaises(overlay.OverlayError):
            overlay.build_overlay(self.core, self.output, "1.0.0", bad, self.records, self.provenance)
        self.records[self.profile][self.job["key"]]["profile"] = self.profiles[1]
        with self.assertRaisesRegex(overlay.OverlayError, "wrong-profile"):
            self.build()

    def test_existing_key_keeps_exact_old_entry_and_pcm_without_duplicate(self):
        original_key = self.job["key"]
        self.plan["jobs"][self.profile][0]["key"] = self.old_key
        self.plan["jobs"][self.profile][0]["text"] = "раніше"
        metadata = self.records[self.profile].pop(original_key)
        metadata.update(key=self.old_key, text="раніше")
        self.records[self.profile][self.old_key] = metadata
        self.build()
        with zipfile.ZipFile(self.output) as archive:
            for role in overlay.ROLES:
                self.assertEqual(archive.read(overlay._bank_path(role, self.profile, "pcm")), self.old_pcm)
        with overlay.apply_to_inputs(self.inputs, self.output, InputFile):
            pass

    def test_invalid_old_index_interval_is_rejected(self):
        name = overlay._bank_path("native_letters", self.profile, "json")
        self.payload[name] = raw_json({self.old_key: [1, 4]})
        self._repin_core()
        with self.assertRaisesRegex(overlay.OverlayError, "invalid/out-of-bounds"):
            self.build()

    def test_one_missing_bank_pair_member_is_rejected(self):
        del self.payload[overlay._bank_path("native_letters", self.profile, "pcm")]
        self._repin_core()
        with self.assertRaisesRegex(overlay.OverlayError, "both exist"):
            self.build()

    def test_absent_complete_pair_is_supported_and_declared_none(self):
        for ext in ("json", "pcm"):
            name = overlay._bank_path("native_letters", self.profile, ext)
            del self.payload[name]
            self.inputs = [item for item in self.inputs if item.path != name]
        self._repin_core()
        result = self.build()
        for ext in ("json", "pcm"):
            self.assertIsNone(result["manifest"]["files"][overlay._bank_path("native_letters", self.profile, ext)]["old"])
        with overlay.apply_to_inputs(self.inputs, self.output, InputFile) as (updated, _):
            self.assertEqual(len(updated), len(self.inputs) + 2)

    def test_retained_navigation_validates_raw_wav_and_unchanged_pcm(self):
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
            wav.writeframes(self.clip)
        name = overlay.BANK_ROOT + "navigation/" + self.profile + "/synthetic.wav"
        self.payload[name] = buffer.getvalue()
        self._repin_core()
        self.records[self.profile][self.job["key"]]["origin"] = {
            "kind": "retained-core8-prepared-navigation", "path": name,
            "sha256": record(self.payload[name])["sha256"]}
        self.build()

    def test_retained_navigation_wrong_profile_is_rejected(self):
        self.records[self.profile][self.job["key"]]["origin"] = {
            "kind": "retained-core8-prepared-navigation",
            "path": overlay.BANK_ROOT + "navigation/" + self.profiles[1] + "/synthetic.wav",
            "sha256": "1" * 64}
        with self.assertRaises(overlay.OverlayError):
            self.build()

    def test_altered_old_pcm_prefix_rejected_even_with_new_hash(self):
        self.build()
        def mutate(data, manifest):
            name = overlay._bank_path("native_letters", self.profile, "pcm")
            data[name] = b"\x01\x02" + data[name][2:]
            manifest["files"][name]["new"] = record(data[name])
        self.rewrite(mutate)
        with self.assertRaisesRegex(overlay.OverlayError, "Old PCM prefix"):
            with overlay.apply_to_inputs(self.inputs, self.output, InputFile):
                self.fail("Changed prefix accepted")

    def test_altered_old_index_values_rejected_even_with_new_hash(self):
        self.build()
        def mutate(data, manifest):
            name = overlay._bank_path("native_letters", self.profile, "json")
            index = json.loads(data[name])
            index[self.old_key] = [2, 2]
            data[name] = raw_json(index)
            manifest["files"][name]["new"] = record(data[name])
        self.rewrite(mutate)
        with self.assertRaisesRegex(overlay.OverlayError, "Old index values"):
            with overlay.apply_to_inputs(self.inputs, self.output, InputFile):
                self.fail("Changed old index accepted")

    def test_extra_model_file_or_path_escape_rejected(self):
        self.build()
        self.rewrite(lambda data, _: data.update({"../bad.py": b"not allowed"}))
        with self.assertRaisesRegex(overlay.OverlayError, "Unsafe archive path"):
            with overlay.apply_to_inputs(self.inputs, self.output, InputFile):
                self.fail("Escape accepted")

    def test_declared_added_keys_cannot_hide_unplanned_append(self):
        self.build()
        def mutate(_, manifest):
            name = overlay._bank_path("native_letters", self.profile, "pcm")
            manifest["files"][name]["added_keys"] = []
        self.rewrite(mutate)
        with self.assertRaisesRegex(overlay.OverlayError, "Declared appended keys"):
            with overlay.apply_to_inputs(self.inputs, self.output, InputFile):
                self.fail("Wrong append declaration accepted")

    def test_tampered_quality_or_exclusion_policy_rejected(self):
        self.build()
        self.rewrite(lambda _, manifest: manifest["quality_validation"].update(pronunciation="verified"))
        with self.assertRaisesRegex(overlay.OverlayError, "pending quality"):
            with overlay.apply_to_inputs(self.inputs, self.output, InputFile):
                self.fail("Unverified quality flag accepted")

    def test_provenance_marker_required(self):
        self.provenance.pop("kind")
        with self.assertRaisesRegex(overlay.OverlayError, "UserProvidedProvenance"):
            self.build()

    def test_worker_origin_must_bind_exact_renderer_source(self):
        metadata = self.records[self.profile][self.job["key"]]
        metadata["origin"]["sha256"] = "a" * 64
        with self.assertRaisesRegex(overlay.OverlayError, "source core identity"):
            self.build()
        metadata["origin"] = {"kind": "actual-private-worker",
                              "path": "kx47Runtime/speech_text.py",
                              "sha256": record(self.payload["kx47Runtime/speech_text.py"])["sha256"]}
        with self.assertRaisesRegex(overlay.OverlayError, "pinned private worker"):
            self.build()

    def test_changed_clip_checksum_silence_and_ambiguous_jobs_rejected(self):
        self.clip_path.write_bytes(b"\0" * len(self.clip))
        with self.assertRaisesRegex(overlay.OverlayError, "checksum differs or is silent"):
            self.build()
        self.clip_path.write_bytes(self.clip)
        self.plan["jobs"][self.profile].append(deepcopy(self.job))
        with self.assertRaisesRegex(overlay.OverlayError, "duplicate"):
            self.build()


if __name__ == "__main__":
    unittest.main()
