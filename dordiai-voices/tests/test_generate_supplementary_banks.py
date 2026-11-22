"""Synthetic orchestration/data tests, never model or pronunciation evidence."""
from array import array
from copy import deepcopy
from hashlib import sha256
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import wave
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("supplementary_generator_test", ROOT / "tools/generate_supplementary_banks.py")
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)
prep = gen.load("_supplementary_test_preparation", ROOT / "tools/prepare_voice_banks.py")
probe = gen.load("_supplementary_test_probe", ROOT / "tools/windows_engine_probe.py")
policy = gen.load("_supplementary_test_policy", ROOT / "source/0.12.2/kx47Runtime/voice_policy.py")
PCM = struct.pack("<hhhh", 100, -200, 300, 0) * 100
WORKER_FIXTURE = b"# synthetic source worker fixture; never executed"


class FakeWorker:
    """Explicit generated PCM fixture; no real synthesis is claimed."""
    def __init__(self, action=None):
        self.requests = []
        self.action = action
    def render(self, request, timeout):
        self.requests.append(deepcopy(request))
        if self.action is not None:
            self.action()
        return PCM, {"renderers": [{"engine": "synthetic-unit-fixture",
                                   "profile": request["profile"], "speaker": request["profile"]}],
                     "first_pcm_ms": 1.0, "completed_ms": 2.0}


def job(language="en-us", text="period", reuse=None):
    return {"key": prep.entry_key(language, text), "language": language, "text": text,
            "reuse_wav": reuse, "reuse_wav_sha256": None, "mapping_origin": "explicit-unit-fixture",
            "glyphs": ["."], "runtime_kinds": ["character"],
            "worker_source_sha256": sha256(WORKER_FIXTURE).hexdigest()}


class SupplementaryGenerationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.core = self.root / "fixture.zip"
        self.sha = "0" * 64

    def prepare(self, selected=None, worker=None, snapshot=None):
        selected = selected or job()
        worker = worker or FakeWorker()
        cache = self.root / selected["key"]
        record = gen.prepare_clip(cache, self.core, {"files": {"kx47Runtime/nvda_worker.py": {"sha256": selected["worker_source_sha256"]}}}, self.root, selected, "sara", self.sha,
                                  worker, probe, prep, 10, snapshot or [])
        return cache, record, worker

    def test_normal_literal_requests_preserve_native_english_russian_and_no_segments(self):
        for language in ("uk", "ru", "en-us"):
            selected = job(language, "name")
            _, record, worker = self.prepare(selected)
            request = worker.requests[0]
            self.assertFalse(request["character"])
            self.assertFalse(request["nativeEnglish"])
            self.assertNotIn("segments", request)
            self.assertEqual(request["nativeProfile"], language in {"ru", "en-us"})
            self.assertEqual(request["speed"], 1.0)
            self.assertEqual(request["profile"], "sara")
            self.assertEqual(record["origin"]["kind"], "actual-private-worker")
            self.assertFalse(record["pronunciation_verified"])

    def test_changed_native_route_or_controls_are_rejected_before_render(self):
        selected = job("ru", "0")
        for field, changed in (("nativeProfile", False), ("character", True),
                               ("speed", 2.), ("controls", {"volume": 0})):
            worker = FakeWorker()
            guarded = gen.CheckedWorker(worker, "sara", [], selected)
            request = dict(gen.expected_request("sara", selected))
            request[field] = changed
            with self.subTest(field=field), self.assertRaises(ValueError):
                guarded.render(request, 10)
            self.assertFalse(worker.requests)
        worker = FakeWorker()
        request = dict(gen.expected_request("sara", selected), segments=[["ru", "0"]])
        with self.assertRaises(ValueError):
            gen.CheckedWorker(worker, "sara", [], selected).render(request, 10)

    def test_completed_clip_resumes_without_render_and_tamper_does_not_regenerate(self):
        selected = job()
        cache, first, worker = self.prepare(selected)
        second = gen.cached_clip(cache, selected, "sara", self.sha, probe)
        self.assertEqual(second["pcm_sha256"], first["pcm_sha256"])
        self.assertEqual(len(worker.requests), 1)
        (cache / "clip.pcm").write_bytes(PCM + b"xx")
        with self.assertRaises(ValueError):
            gen.cached_clip(cache, selected, "sara", self.sha, probe)
        self.assertEqual(len(worker.requests), 1)

    def test_cache_voice_source_and_native_request_semantics_are_bound(self):
        selected = job()
        cache, _, _ = self.prepare(selected)
        path = cache / "clip.json"
        original = json.loads(path.read_text(encoding="utf-8"))
        for field, changed in (("profile", "another"), ("source_core_sha256", "f" * 64), ("text", "another")):
            record = deepcopy(original)
            record[field] = changed
            path.write_text(json.dumps(record), encoding="utf-8")
            with self.subTest(field=field), self.assertRaises(ValueError):
                gen.cached_clip(cache, selected, "sara", self.sha, probe)
        record = deepcopy(original)
        record["origin"]["request"]["nativeProfile"] = False
        path.write_text(json.dumps(record), encoding="utf-8")
        with self.assertRaises(ValueError):
            gen.cached_clip(cache, selected, "sara", self.sha, probe)

    def test_wrong_renderer_or_midrender_profile_change_never_finalizes_clip(self):
        with self.assertRaises(ValueError):
            gen.verify_renderer({"renderers": [{"engine": "fixture", "profile": "another", "speaker": "another"}]}, "sara")
        with self.assertRaises(ValueError):
            gen.verify_renderer({"renderers": []}, "sara")
        source = self.root / "synthetic-profile.npy"
        source.write_bytes(b"old synthetic profile")
        snapshot = [(source, gen.file_signature(source))]
        selected = job("uk", "крапка")
        worker = FakeWorker(lambda: source.write_bytes(b"changed synthetic profile identity"))
        with self.assertRaises(ValueError):
            self.prepare(selected, worker, snapshot)
        self.assertFalse((self.root / selected["key"]).exists())

    def test_retained_space_copies_same_profile_wav_without_worker(self):
        selected = job("uk", "пробіл")
        selected["reuse_wav"] = "kx47Runtime/models/voices/navigation/sara/" + selected["key"] + ".wav"
        data = io.BytesIO()
        with wave.open(data, "wb") as stream:
            stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(24000); stream.writeframes(PCM)
        raw = data.getvalue()
        selected["reuse_wav_sha256"] = sha256(raw).hexdigest()
        with zipfile.ZipFile(self.core, "w") as archive:
            archive.writestr(selected["reuse_wav"], raw)
        release = {"files": {selected["reuse_wav"]: {"sha256": selected["reuse_wav_sha256"]}}}
        worker = Mock()
        cache = self.root / "retained"
        record = gen.prepare_clip(cache, self.core, release, self.root, selected, "sara", self.sha,
                                  worker, probe, prep, 10, [])
        worker.render.assert_not_called()
        self.assertEqual((cache / "clip.pcm").read_bytes(), PCM)
        self.assertEqual(record["origin"]["kind"], "retained-core8-prepared-navigation")
        self.assertEqual(gen.cached_clip(cache, selected, "sara", self.sha, probe)["pcm_sha256"], sha256(PCM).hexdigest())

    def test_owner_marker_reuses_identical_recipe_not_changed_jobs_or_unowned_root(self):
        selected = job()
        plan = {"core_sha256": self.sha, "catalogue_sha256": "1" * 64,
                "voice_ids": ["sara"], "jobs": {"sara": [selected]}, "source": {"probe": "old"}}
        work = self.root / "work"
        gen.prepare_work(work, plan, "1.0.0", False)
        with self.assertRaises(ValueError):
            gen.prepare_work(work, plan, "1.0.0", False)
        changed_tools_only = deepcopy(plan)
        changed_tools_only["source"]["probe"] = "new nonsemantic probe source"
        gen.prepare_work(work, changed_tools_only, "1.0.0", True)
        changed = deepcopy(plan)
        changed["jobs"]["sara"][0]["text"] = "another actual utterance"
        with self.assertRaises(ValueError):
            gen.prepare_work(work, changed, "1.0.0", True)
        foreign = self.root / "foreign"
        foreign.mkdir()
        (foreign / "canary.txt").write_bytes(b"leave untouched")
        with self.assertRaises(ValueError):
            gen.prepare_work(foreign, plan, "1.0.0", True)
        self.assertEqual((foreign / "canary.txt").read_bytes(), b"leave untouched")

    def test_owned_worker_is_stopped_even_when_preparation_pauses(self):
        worker = Mock()
        worker.close.return_value = {"exit_code": 0, "forced_termination": False}
        holder, report = {"worker": worker}, {}
        with self.assertRaises(gen.PreparationPaused):
            with gen.worker_lifetime(holder, report):
                raise gen.PreparationPaused("finite budget")
        worker.close.assert_called_once_with()
        self.assertIsNone(holder["worker"])
        self.assertEqual(report["worker_shutdown"]["exit_code"], 0)
        worker.close.return_value = {"exit_code": None}
        with self.assertRaises(RuntimeError):
            with gen.worker_lifetime({"worker": worker}, {}):
                pass

    def test_real_generation_entrypoint_cannot_run_models_on_nonwindows(self):
        if sys.platform == "win32":
            self.skipTest("Non-Windows refusal applies to Linux controller")
        with self.assertRaises(ValueError):
            gen.run(SimpleNamespace())


class SourceArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def source(self):
        data = {"kx47Runtime/example.py": b"# synthetic source fixture, not executed",
                "kx47Runtime/nvda_worker.py": WORKER_FIXTURE,
                "kx47Runtime/models/voices/catalog.json": b'{"sara":"Synthetic fixture"}'}
        files = {name: {"sha256": sha256(raw).hexdigest(), "size_bytes": len(raw)} for name, raw in data.items()}
        release = {"format": "dordiai-core-release", "format_version": 1, "files": files,
                   "voice_ids": ["sara"], "excluded_voice_ids": sorted(policy.EXCLUDED_VOICE_IDS)}
        core = self.root / "synthetic-source.zip"
        with zipfile.ZipFile(core, "w") as archive:
            for name, raw in data.items(): archive.writestr(name, raw)
            archive.writestr(gen.RELEASE, json.dumps(release))
        return core, release

    def test_source_sha_inventory_and_modified_extraction_are_enforced(self):
        core, release = self.source()
        actual, _, ids = gen.source_manifest(core, gen.digest(core))
        self.assertEqual(ids, ["sara"])
        with self.assertRaises(ValueError):
            gen.source_manifest(core, "0" * 64)
        root = self.root / "owned-copy"
        runtime = gen.extract_core(core, root, release)
        source = runtime / "example.py"
        source.write_bytes(b"changed")
        with self.assertRaises(ValueError):
            gen.extract_core(core, root, release)
        self.assertEqual(source.read_bytes(), b"changed")

    def test_extra_pyd_in_extracted_source_is_not_executed_or_accepted(self):
        core, release = self.source()
        root = self.root / "owned-copy"
        runtime = gen.extract_core(core, root, release)
        (runtime / "untrusted.pyd").write_bytes(b"not actual code; refuse extra fixture")
        with self.assertRaises(ValueError):
            gen.extract_core(core, root, release)

    def test_plan_includes_only_actual_misses_and_all_explicit_spaces(self):
        core, release = self.source()
        def row(language, glyph, text, prepared, category):
            key = prep.entry_key(language, text)
            return {"language": language, "glyph": glyph, "text": text, "bank_key": key, "navigation_key": key,
                    "prepared_candidate": prepared, "metadata_candidate": "navigation" if prepared else "live-worker",
                    "category": category, "kind": "character" if category != "digit" else "text",
                    "mapping_origin": "synthetic-unit-mapping"}
        rows = [row("uk", ".", "крапка", False, "symbol"), row("ru", "0", "0", False, "digit"),
                row("uk", " ", "пробіл", True, "space"), row("en-us", " ", "space", True, "space"),
                row("uk", "а", "а", True, "letter")]
        for item in rows:
            if item["category"] == "space":
                release["files"][gen.BANK_ROOT + "navigation/sara/" + item["navigation_key"] + ".wav"] = {"sha256": "a" * 64}
        report = {"profiles": [{"profile": "sara", "summary": {"uk": {"no_default_prepared_candidate": 0}}, "probe_rows": rows}],
                  "driver_sha256": "b" * 64, "character_name_sources": {}, "semantic_anchors_sha256": {}, "probe_definition": {}}
        audit = SimpleNamespace(inspect=lambda *a, **kw: report)
        with patch.object(gen, "source_manifest", return_value=(release, b'{"sara":"fixture"}', ["sara"])):
            plan = gen.make_plan(core, gen.digest(core), audit, policy, None, expected_voice_count=1)
        self.assertEqual(len(plan["jobs"]["sara"]), 4)
        self.assertEqual(sum(item["reuse_wav"] is not None for item in plan["jobs"]["sara"]), 2)


if __name__ == "__main__":
    unittest.main()
