"""Runtime regression tests; no NVDA/Windows/model-quality claims are made here."""
import ast
from array import array
from collections import OrderedDict
from contextlib import closing
import importlib.util
import json
from pathlib import Path
from queue import Empty, Full, Queue
import sys
import subprocess
import tempfile
from threading import Condition, Event, RLock, Thread
from time import monotonic
import types
import unittest
from unittest.mock import patch
import wave

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
DRIVERS = ROOT / "source/0.12.2/synthDrivers"
if str(RUNTIME) not in sys.path:
    sys.path.insert(0, str(RUNTIME))

from session_control import GuardedSession, RequestCancellation, SynthesisCancelled, cancel_running
from native_lookahead import NativeLookahead, CarrierContext
import navigation_cache


def standalone_driver_parts():
    """Load actual pure streaming functions without importing NVDA bindings."""
    tree = ast.parse((DRIVERS / "kx47Preview.py").read_text(encoding="utf-8"))
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                 and node.name in {"initial_audio", "buffered_items"}]
    driver = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "SynthDriver")
    methods = [node for node in driver.body if isinstance(node, ast.FunctionDef)
               and node.name in {"_play", "_render_parts", "cancel", "terminate", "_run"}]
    stub = ast.ClassDef(name="Playback", bases=[], keywords=[], body=methods, decorator_list=[])
    module = ast.fix_missing_locations(ast.Module(body=functions + [stub], type_ignores=[]))
    namespace = dict(Queue=Queue, Empty=Empty, Full=Full, Thread=Thread, closing=closing,
                     monotonic=monotonic, SAMPLE_RATE=24000,
                     release_shared_worker=lambda token: None,
                     log=types.SimpleNamespace(error=lambda *a: None))
    exec(compile(module, str(DRIVERS / "kx47Preview.py"), "exec"), namespace)
    return namespace


class CancellationTests(unittest.TestCase):
    def test_worker_starts_with_isolated_python(self):
        result = subprocess.run([sys.executable, "-I", str(RUNTIME / "nvda_worker.py"), "--help"],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--reference-engine", result.stdout)

    def test_cancel_covers_active_and_all_queued_requests(self):
        tracker = RequestCancellation()
        active, second, latest = [tracker.new() for _ in range(3)]
        options = types.SimpleNamespace(terminate=False)
        owner = types.SimpleNamespace(active_run=(options, active))
        tracker.cancel(owner)
        self.assertTrue(all(event.is_set() for event in (active, second, latest)))
        self.assertTrue(options.terminate)
        self.assertFalse(tracker.new().is_set())

    def test_completed_requests_are_released(self):
        tracker = RequestCancellation()
        complete, waiting = tracker.new(), tracker.new()
        tracker.release(complete)
        tracker.cancel()
        self.assertFalse(complete.is_set())
        self.assertTrue(waiting.is_set())
        tracker.release(waiting)
        tracker.release(None)
        self.assertEqual(tracker._requests, set())

    def test_only_matching_native_run_is_interrupted(self):
        options = types.SimpleNamespace(terminate=False)
        owner = types.SimpleNamespace(active_run=(options, Event()))
        cancel_running(owner, Event())
        self.assertFalse(options.terminate)

    def test_guard_stops_before_native_call(self):
        event = Event()
        event.set()
        owner = types.SimpleNamespace(cancel_event=event, active_run=None)
        def check():
            if event.is_set():
                raise SynthesisCancelled()
        owner.check_cancelled = check
        called = []
        session = GuardedSession(types.SimpleNamespace(run=lambda *a: called.append(a)), owner)
        with patch.dict(sys.modules, {"onnxruntime": types.SimpleNamespace(RunOptions=lambda: object())}):
            with self.assertRaises(SynthesisCancelled):
                session.run(None, {})
        self.assertEqual(called, [])

    def test_guard_converts_cancelled_native_error_and_clears_active(self):
        event = Event()
        owner = types.SimpleNamespace(cancel_event=event, active_run=None)
        def check():
            if event.is_set():
                raise SynthesisCancelled()
        owner.check_cancelled = check
        def run(*args):
            event.set()
            cancel_running(owner, event)
            self.assertTrue(args[2].terminate)
            raise RuntimeError("native termination")
        session = GuardedSession(types.SimpleNamespace(run=run), owner)
        with patch.dict(sys.modules, {"onnxruntime": types.SimpleNamespace(
                RunOptions=lambda: types.SimpleNamespace(terminate=False))}):
            with self.assertRaises(SynthesisCancelled):
                session.run(None, {})
        self.assertIsNone(owner.active_run)

    def test_guard_preserves_actual_model_error(self):
        owner = types.SimpleNamespace(cancel_event=Event(), active_run=None, check_cancelled=lambda: None)
        def run(*a):
            raise ValueError("invalid model input")
        with patch.dict(sys.modules, {"onnxruntime": types.SimpleNamespace(RunOptions=lambda: object())}):
            with self.assertRaisesRegex(ValueError, "invalid model input"):
                GuardedSession(types.SimpleNamespace(run=run), owner).run(None, {})
        self.assertIsNone(owner.active_run)


class ForecastTests(unittest.TestCase):
    def test_unfinished_forecast_never_blocks_current_word(self):
        entered, release = Event(), Event()
        def carrier(language, text):
            entered.set()
            release.wait(1)
            yield b"prepared"
        provider = CarrierContext(carrier)
        forecast = NativeLookahead(provider)
        try:
            forecast.schedule(("token", "de", "Wort"), Event())
            self.assertTrue(entered.wait(1))
            started = monotonic()
            self.assertIsNone(forecast.take("de", "Wort", Event()))
            self.assertLess(monotonic() - started, .1)
            self.assertTrue(provider.cancel_event.is_set())
        finally:
            release.set()
            forecast.close()

    def test_finished_forecast_is_reused_once(self):
        provider = CarrierContext(lambda language, text: iter((b"ready",)))
        forecast = NativeLookahead(provider)
        try:
            forecast.schedule(("token", "de", "Wort"), Event())
            job = forecast.selected
            self.assertEqual(job.result.result(timeout=1), b"ready")
            self.assertEqual(forecast.take("de", "Wort", Event()), b"ready")
            self.assertIsNone(forecast.take("de", "Wort", Event()))
        finally:
            forecast.close()

    def test_cancelled_foreground_does_not_take_forecast(self):
        forecast = NativeLookahead(CarrierContext(lambda *a: iter((b"ready",))))
        try:
            forecast.schedule(("token", "de", "Wort"), Event())
            forecast.selected.result.result(timeout=1)
            cancelled = Event()
            cancelled.set()
            with self.assertRaises(SynthesisCancelled):
                forecast.take("de", "Wort", cancelled)
        finally:
            forecast.close()


class WorkerProtocolTests(unittest.TestCase):
    """Exercise the real pipe dispatcher with deterministic stub synthesis."""

    def setUp(self):
        bootstrap = r'''
import runpy, sys, types, time, numpy as np
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
from session_control import SynthesisCancelled
class Voice:
    sampling_rate = output_rate = 24000
    active_run = None
    cancel_event = None
    def __init__(self, *a, **kw): pass
    def chunks(self, profile, language, text, speed, **kw):
        if text == "WAIT":
            print("ENTERED", file=sys.stderr, flush=True)
            deadline = time.monotonic() + 3
            while not self.cancel_event.is_set() and time.monotonic() < deadline:
                time.sleep(.001)
            if not self.cancel_event.is_set():
                raise RuntimeError("Cancellation missed the active request")
            raise SynthesisCancelled()
        yield np.array([.1, -.1, .2, -.2], dtype=np.float32)
class Gate:
    def ready(self): return False
    def reference(self, *a): pass
    def finished(self): pass
    def close(self): pass
sys.modules["ukrainian_voices"] = types.SimpleNamespace(UkrainianVoices=Voice)
sys.modules["wide_warmup"] = types.SimpleNamespace(
    WideWarmupGate=Gate, memory_headroom=lambda: None, background_setup_thread=lambda: None)
sys.modules["voice_delivery"] = types.SimpleNamespace(
    clean_onset=lambda source, **kw: source,
    equalize_voice=lambda source, *a: source)
sys.modules["voice_controls"] = types.SimpleNamespace(
    apply_stream_controls=lambda source, *a, **kw: source)
worker = sys.argv[1]
sys.argv = [worker, ".", "--reference-model", ".", "--references", ".", "--reference-engine", "holos"]
runpy.run_path(worker, run_name="__main__")
'''
        self.process = subprocess.Popen(
            [sys.executable, "-I", "-u", "-c", bootstrap, str(RUNTIME / "nvda_worker.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1)
        self.responses, self.diagnostics = Queue(), Queue()
        def read(pipe, queue):
            for line in pipe:
                queue.put(line)
            queue.put(None)
        self.readers = [Thread(target=read, args=(pipe, queue), daemon=True)
                        for pipe, queue in ((self.process.stdout, self.responses),
                                            (self.process.stderr, self.diagnostics))]
        for thread in self.readers:
            thread.start()

    def tearDown(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)
        for thread in self.readers:
            thread.join(1)
        self.process.stdout.close()
        self.process.stderr.close()

    def send(self, request):
        self.process.stdin.write(json.dumps(request) + "\n")
        self.process.stdin.flush()

    def reference(self, text="word", profile="sara"):
        return dict(mode="reference", profile=profile, language="uk", text=text,
                    speed=1., stream=True, segments=[["uk", text]])

    def reply(self):
        line = self.responses.get(timeout=5)
        self.assertIsNotNone(line, "Worker exited before replying")
        return json.loads(line)

    def test_stream_drop_and_excluded_voice_protocol(self):
        self.send(self.reference())
        self.assertIn("chunk", self.reply())
        self.send({"mode": "next"})
        self.assertEqual(self.reply(), {"finished": True})
        self.send(self.reference(profile="veronika"))
        self.assertEqual(self.reply(), {"error": "ValueError"})
        self.send(self.reference("new"))
        self.assertIn("chunk", self.reply())
        self.send({"mode": "drop"})
        self.assertEqual(self.reply(), {"finished": True})

    def test_cancel_catches_active_and_queued_request_and_worker_recovers(self):
        self.send(self.reference("WAIT"))
        self.assertEqual(self.diagnostics.get(timeout=5).strip(), "ENTERED")
        self.send(self.reference("queued"))
        self.send({"mode": "cancel"})
        self.send({"mode": "next"})
        for _ in range(3):
            self.assertEqual(self.reply(), {"finished": True})
        self.send(self.reference("fresh"))
        self.assertIn("chunk", self.reply())
        self.send({"mode": "next"})
        self.assertEqual(self.reply(), {"finished": True})


class NavigationCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        navigation_cache.clear_cache()

    def tearDown(self):
        navigation_cache.clear_cache()
        self.temp.cleanup()

    def clip(self, path, samples, rate=24000):
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            wav.writeframes(array("h", samples).tobytes())
        return path

    def test_cached_audio_is_immutable_and_exact(self):
        path = self.clip(self.root / "clip.wav", [-32768, 0, 16384])
        data = navigation_cache.read_clip(path)
        self.assertEqual(data.tolist(), [-1, 0, .5])
        self.assertFalse(data.flags.writeable)
        self.assertIs(data, navigation_cache.read_clip(path))

    def test_updated_package_does_not_return_old_clip(self):
        path = self.clip(self.root / "clip.wav", [100])
        old = navigation_cache.read_clip(path)
        self.clip(path, [200, 300])
        new = navigation_cache.read_clip(path)
        self.assertIsNot(new, old)
        self.assertEqual(len(new), 2)

    def test_cache_has_byte_budget_not_only_entry_limit(self):
        with patch.object(navigation_cache, "CACHE_BYTES", 40):
            for number in range(5):
                path = self.clip(self.root / (str(number) + ".wav"), [number] * 4)
                navigation_cache.read_clip(path)
            self.assertLessEqual(navigation_cache._cache_size, 40)
            self.assertLessEqual(len(navigation_cache._clips), 2)

    def test_missing_or_corrupt_navigation_uses_normal_synthesis(self):
        self.assertIsNone(navigation_cache.load_clip(self.root, "sara", "uk", "слово", 1))
        name = navigation_cache.cache_name("uk", "слово")
        path = self.root / "navigation/sara" / name
        path.parent.mkdir(parents=True)
        path.write_bytes(b"invalid wave")
        self.assertIsNone(navigation_cache.load_clip(self.root, "sara", "uk", "слово", 1))

    def test_unsupported_audio_format_rejected(self):
        with self.assertRaises(ValueError):
            navigation_cache.read_clip(self.clip(self.root / "bad.wav", [1], rate=22050))

    def test_path_escape_rejected(self):
        with self.assertRaises(ValueError):
            navigation_cache.load_clip(self.root, "../../elsewhere", "uk", "слово", 1)


class PlaybackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = standalone_driver_parts()

    def test_initial_audio_releases_first_word_without_reading_second(self):
        consumed = []
        def source():
            consumed.append(1)
            yield "pcm", b"12"
            consumed.append(2)
            yield "pcm", b"34"
        flow = self.api["initial_audio"](source())
        self.assertEqual(next(flow), ("pcm", b"12"))
        self.assertEqual(consumed, [1])
        flow.close()

    def test_short_reserve_does_not_wait_for_next_synthesis(self):
        release = Event()
        def produce(stop):
            yield "pcm", b"12"
            release.wait(1)
            yield "pcm", b"34"
        cancelled = Event()
        waiting = []
        flow = self.api["buffered_items"](produce, cancelled.is_set, short_reserve=True,
                                           cancelling_threads=waiting)
        try:
            start = monotonic()
            self.assertEqual(next(flow), ("pcm", b"12"))
            self.assertLess(monotonic() - start, .1)
            cancelled.set()
            start = monotonic()
            flow.close()
            self.assertLess(monotonic() - start, .1)
            self.assertLessEqual(len(waiting), 1)
        finally:
            release.set()
            for thread in waiting:
                thread.join(1)

    def test_queue_preserves_pcm_and_index_order(self):
        expected = [("pcm", b"a"), ("index", 7), ("pcm", b"b")]
        result = list(self.api["buffered_items"](lambda stop: iter(expected), lambda: False, pending_count=1))
        self.assertEqual(result, expected)

    def test_synthesis_failure_propagates_instead_of_skipping_word(self):
        def produce(stop):
            yield "pcm", b"first"
            raise ValueError("failed second word")
        flow = self.api["buffered_items"](produce, lambda: False)
        self.assertEqual(next(flow), ("pcm", b"first"))
        with self.assertRaisesRegex(ValueError, "second word"):
            next(flow)

    def test_stuck_producer_limit_rejects_without_hanging(self):
        release = Event()
        threads = [Thread(target=release.wait, daemon=True) for _ in range(2)]
        for thread in threads:
            thread.start()
        try:
            flow = self.api["buffered_items"](lambda stop: iter(()), lambda: False,
                                               cancelling_threads=threads)
            with self.assertRaisesRegex(RuntimeError, "cancellation"):
                next(flow)
        finally:
            release.set()
            for thread in threads:
                thread.join(1)

    def test_playback_uses_ten_ms_chunks_and_checks_cancellation(self):
        playback = self.api["Playback"]()
        playback._state = Condition()
        playback._generation = 1
        playback._paused = False
        fed, stopped = [], []
        def feed(pcm):
            fed.append(pcm)
            playback._generation = 2
        playback._player = types.SimpleNamespace(feed=feed, stop=lambda: stopped.append(True))
        playback._play(bytes(4800), 1)
        self.assertEqual([len(data) for data in fed], [480])
        self.assertEqual(stopped, [True])

    def test_render_parts_does_not_swallow_voice_error(self):
        playback = self.api["Playback"]()
        def bad_clip(request):
            raise ValueError("voice failed")
        playback._english_engine = None
        playback._engine = types.SimpleNamespace(fast_clip=bad_clip)
        with self.assertRaisesRegex(ValueError, "voice failed"):
            list(playback._render_parts([("text", {"language": "uk"})], {}, lambda: False))

    def test_terminate_keeps_shared_lease_until_output_loop_finishes(self):
        playback = self.api["Playback"]()
        playback._state = Condition()
        playback._closed = False
        playback._generation = 1
        playback._paused = False
        playback._jobs = Queue()
        playback._jobs.put("old queued speech")
        playback._worker_lease = object()
        playback._warm = False
        playback._english_engine = None
        stopped, closed, released = [], [], []
        playback._engine = types.SimpleNamespace(close=lambda: self.fail("idle shared worker must stay warm"))
        playback._player = types.SimpleNamespace(stop=lambda: stopped.append(True), close=lambda: closed.append(True))
        with patch.dict(self.api, release_shared_worker=lambda token: released.append(token)):
            playback.terminate()
            self.assertEqual(released, [])
            self.assertEqual(stopped, [True])
            self.assertEqual(playback._jobs.qsize(), 1)
            playback.terminate()
            self.assertEqual(playback._jobs.qsize(), 1)
            playback._run()
        self.assertEqual(released, [playback._worker_lease])
        self.assertEqual(closed, [True])


class PreparedPCMTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("dordiai_audio_test", DRIVERS / "_dordiai_audio.py")
        cls.audio = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.audio)

    def test_neutral_volume_does_not_load_pitch_dll(self):
        pcm = array("h", [-32768, 0, 32767]).tobytes()
        with patch.object(self.audio, "library", side_effect=AssertionError("unnecessary DLL")):
            self.assertEqual(self.audio.control_pcm(pcm, "absent.dll", 24000, 50, 50, 100), pcm)
            scaled = self.audio.control_pcm(pcm, "absent.dll", 24000, 50, 50, 50)
            self.assertEqual(list(array("h", scaled)), [-16384, 0, 16384])
            self.assertEqual(self.audio.control_pcm(pcm, "absent.dll", 24000, 20, 20, 0), bytes(len(pcm)))

    def test_invalid_controls_rejected(self):
        for params in [(24000, float("nan"), 50, 100), (0, 50, 50, 100),
                       (24000, 50, 50, 101)]:
            with self.assertRaises(ValueError):
                self.audio.control_pcm(b"12", "absent.dll", *params)

    def test_invalid_dll_block_cannot_loop_forever_and_frees_state(self):
        deleted = []
        lib = types.SimpleNamespace(
            rubberband_live_new=lambda *a: 1,
            rubberband_live_set_pitch_scale=lambda *a: None,
            rubberband_live_set_formant_scale=lambda *a: None,
            rubberband_live_get_block_size=lambda *a: 0,
            rubberband_live_get_start_delay=lambda *a: 0,
            rubberband_live_delete=lambda state: deleted.append(state),
        )
        with patch.object(self.audio, "library", return_value=lib):
            with self.assertRaises(ValueError):
                self.audio.control_pcm(b"12", "fake.dll", 24000, 60, 50, 100)
        self.assertEqual(deleted, [1])


if __name__ == "__main__":
    unittest.main()
