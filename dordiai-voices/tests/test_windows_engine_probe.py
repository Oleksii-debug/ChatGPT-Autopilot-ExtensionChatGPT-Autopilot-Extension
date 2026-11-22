"""Probe-harness tests only; these do not execute or certify Windows models."""
import argparse
from array import array
import base64
from contextlib import redirect_stderr
import importlib.util
import io
import json
from pathlib import Path
from queue import Queue
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("windows_engine_probe_under_test", ROOT / "tools/windows_engine_probe.py")
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class ProbeHelpersTests(unittest.TestCase):
    def test_dictionary_regression_word_cannot_use_override_shortcuts(self):
        runtime = ROOT / "source/0.12.2/kx47Runtime"
        spec = importlib.util.spec_from_file_location("stress_fixture_under_test", runtime / "ukrainian_stress.py")
        stress = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stress)
        word = probe.DICTIONARY_REGRESSION_WORD
        self.assertIn(word, probe.DICTIONARY_REGRESSION_TEXT.lower())
        self.assertNotIn(word, stress.OVERRIDES)
        self.assertNotIn(word, stress.HOMOGRAPHS)
        self.assertNotIn(word, stress.rhvoice_dictionary())
        self.assertGreaterEqual(sum(char in stress.VOWELS for char in word), 2)

    def test_preflight_runs_bundled_python_in_both_loader_modes(self):
        result = types.SimpleNamespace(stdout=b'{"status":"passed","dictionary_constructed":true}', stderr=b"", returncode=0)
        with tempfile.TemporaryDirectory() as temporary, patch.object(probe.subprocess, "run", return_value=result) as run:
            folder = Path(temporary)
            reports = probe.native_extension_preflight(folder, folder, 10)
        self.assertEqual([test["bootstrap_mode"] for test in reports], ["inherited", "reset"])
        self.assertEqual(run.call_count, 2)
        for call in run.call_args_list:
            self.assertEqual(call.args[0][0], str(folder / "python/python.exe"))
            self.assertEqual(call.kwargs["cwd"], folder)
        self.assertIn("from marisa_trie import RecordTrie", probe.NATIVE_EXTENSION_PREFLIGHT)
        self.assertIn("dictionary()", probe.NATIVE_EXTENSION_PREFLIGHT)

    def test_preflight_invalid_json_or_native_process_failure_never_passes(self):
        for result in (types.SimpleNamespace(stdout=b"", stderr=b"DLL load failure", returncode=1),
                       types.SimpleNamespace(stdout=b'{"status":"passed"}', stderr=b"", returncode=3)):
            with self.subTest(code=result.returncode), tempfile.TemporaryDirectory() as temporary, \
                    patch.object(probe.subprocess, "run", return_value=result):
                reports = probe.native_extension_preflight(Path(temporary), Path(temporary), 1)
            self.assertTrue(all(test["status"] == "failed" for test in reports))

    def test_short_timing_run_does_not_claim_tail_guarantees(self):
        summary = probe.timing_summary([2, 4, 3])
        self.assertEqual(summary["median_ms"], 3)
        self.assertNotIn("observed_p95_ms", summary)
        self.assertNotIn("observed_p99_ms", summary)
        self.assertEqual(probe.timing_summary([]), {"count": 0})

    def test_empirical_percentiles_require_enough_observations(self):
        summary = probe.timing_summary(range(1, 101))
        self.assertEqual(summary["observed_p95_ms"], 95)
        self.assertEqual(summary["observed_p99_ms"], 99)

    def test_pcm_parser_rejects_malformed_and_odd_samples(self):
        for encoded in (None, "!bad!", "", base64.b64encode(b"x").decode("ascii")):
            with self.assertRaises(probe.ProbeError):
                probe.decode_pcm(encoded)
        self.assertEqual(probe.decode_pcm("AQACAA=="), b"\x01\x00\x02\x00")

    def test_audio_statistics_and_wave_keep_exact_frames(self):
        pcm = array("h", [-32768, 0, 16384]).tobytes()
        stats = probe.audio_statistics(pcm)
        self.assertEqual(stats["frames"], 3)
        self.assertEqual(stats["nonzero_samples"], 2)
        self.assertEqual(stats["peak"], 1)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "evidence.wav"
            probe.save_wave(path, pcm)
            with probe.wave.open(str(path)) as wav:
                self.assertEqual(wav.getframerate(), 24000)
                self.assertEqual(wav.getnchannels(), 1)
                self.assertEqual(wav.readframes(3), pcm)

    def test_request_flags_select_actual_expected_backends(self):
        self.assertTrue(probe.make_request("en", "sara", "text")["nativeProfile"])
        self.assertTrue(probe.make_request("ru", "sara", "текст")["nativeProfile"])
        self.assertFalse(probe.make_request("uk", "sara", "текст")["nativeProfile"])
        self.assertTrue(probe.make_request("fr", "sara", "texte")["nativeLocale"])
        self.assertTrue(probe.make_request("ja", "sara", "日本語")["wideLocale"])

    def test_non_windows_writes_blocked_report_without_launching_worker(self):
        with tempfile.TemporaryDirectory() as folder:
            args = argparse.Namespace(package_root=Path(folder) / "addon", output=Path(folder) / "output")
            fake_os = types.SimpleNamespace(name="posix", cpu_count=lambda: 2)
            with patch.object(probe, "os", fake_os), patch.object(probe, "PipeWorker", side_effect=AssertionError("must not run")):
                self.assertEqual(probe.run_probe(args), 2)
            report = json.loads((args.output / "report.json").read_text())
            self.assertEqual(report["status"], "blocked")
            self.assertFalse(report["nvda_verified"])
            self.assertFalse(report["pronunciation_verified"])
            self.assertEqual(report["tests"], [])

    def test_invalid_cli_values_are_rejected(self):
        with redirect_stderr(io.StringIO()):
            for option, value in (("--timeout", "0"), ("--repetitions", "0"), ("--cancel-delay-ms", "-1")):
                with self.assertRaises(SystemExit) as raised:
                    probe.main(["--package-root", ".", "--output", ".", option, value])
                self.assertEqual(raised.exception.code, 2)


class PipeProtocolHarnessTests(unittest.TestCase):
    def worker(self, replies=()):
        worker = object.__new__(probe.PipeWorker)
        worker.responses = Queue()
        for reply in replies:
            worker.responses.put(reply)
        worker.sent = []
        worker.send = worker.sent.append
        return worker

    def test_receive_has_finite_deadline(self):
        worker = self.worker()
        with self.assertRaises(probe.ProbeTimeout):
            worker.receive(.001)
        with self.assertRaises(probe.ProbeTimeout):
            worker.receive(0)

    def test_eof_and_invalid_reader_data_are_errors(self):
        for reply in (None, probe.ProbeError("bad JSON")):
            worker = self.worker([reply])
            worker.process = types.SimpleNamespace(poll=lambda: 7)
            with self.assertRaises(probe.ProbeError):
                worker.receive(1)
        worker = self.worker()
        worker.process = types.SimpleNamespace(stdout=io.BytesIO(b'[]\n'))
        worker._read()
        self.assertIsInstance(worker.responses.get_nowait(), probe.ProbeError)

    def test_render_preserves_stream_audio_and_metadata(self):
        first, second = array("h", [100, -100]).tobytes(), array("h", [200, -200]).tobytes()
        worker = self.worker([
            {"loadingStage": "language-source"},
            {"chunk": base64.b64encode(first).decode(), "engine": "profile", "profile": "sara"},
            {"chunk": base64.b64encode(second).decode(), "engine": "profile", "profile": "sara"},
            {"finished": True},
        ])
        pcm, result = worker.render({"mode": "reference"}, 1)
        self.assertEqual(pcm, first + second)
        self.assertEqual(result["audio"]["frames"], 4)
        self.assertEqual(len(result["chunks"]), 2)
        self.assertEqual(len(result["renderers"]), 1)
        self.assertEqual(worker.sent, [{"mode": "reference"}, {"mode": "next"}, {"mode": "next"}])

    def test_silent_audio_does_not_pass(self):
        worker = self.worker([
            {"chunk": base64.b64encode(bytes(4)).decode()}, {"finished": True}])
        with self.assertRaisesRegex(probe.ProbeError, "silence"):
            worker.render({"mode": "reference"}, 1)

    def test_engine_failure_is_not_a_successful_sample(self):
        with self.assertRaisesRegex(probe.ProbeError, "RuntimeError"):
            self.worker([{"error": "RuntimeError"}]).render({"mode": "reference"}, 1)

    def test_excluded_voice_must_fail_before_audio(self):
        worker = self.worker([{"error": "ValueError"}])
        self.assertEqual(worker.check_excluded_voice("veronika", 1)["status"], "passed")
        worker = self.worker([{"chunk": "AQACAA=="}])
        with self.assertRaisesRegex(probe.ProbeError, "not rejected"):
            worker.check_excluded_voice("veronika", 1)

    def test_excluded_voice_allows_safe_diagnostics_but_never_pcm(self):
        worker = self.worker([{"error": "ValueError", "diagnostics": {"type": "ValueError", "frames": []}}])
        self.assertEqual(worker.check_excluded_voice("veronika", 1)["status"], "passed")
        for reply in ({"error": "ValueError", "chunk": "AQACAA=="},
                      {"error": "ValueError", "pcm": "AQACAA=="},
                      {"error": "ImportError", "diagnostics": {}},
                      {"error": "ValueError", "unexpected": True}):
            with self.subTest(reply=reply), self.assertRaises(probe.ProbeError):
                self.worker([reply]).check_excluded_voice("veronika", 1)

    def test_cancel_drop_does_not_mislabel_buffered_chunk_as_audible_stop(self):
        worker = self.worker([{"chunk": "AQACAA=="}, {"finished": True}])
        result = worker.cancel_request({"mode": "reference"}, 1, 0)
        self.assertEqual(worker.sent, [{"mode": "reference"}, {"mode": "cancel"}, {"mode": "drop"}])
        self.assertTrue(result["first_reply_was_already_buffered_audio"])
        self.assertIn("not NVDA", result["scope"])


if __name__ == "__main__":
    unittest.main()
