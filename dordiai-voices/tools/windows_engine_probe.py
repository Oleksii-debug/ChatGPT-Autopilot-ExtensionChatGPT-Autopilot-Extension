"""Exercise actual packaged speech workers on Windows and retain PCM evidence.

This stdlib host-Python harness launches the add-on's embedded Python with -I.
It does not substitute model stubs. Successful engine smoke checks establish
neither NVDA integration nor native-speaker pronunciation quality or latency.
"""
from __future__ import annotations

import argparse
from array import array
import base64
from datetime import datetime, timezone
import importlib.util
import hashlib
import json
import math
import os
import platform
from pathlib import Path
from queue import Empty, Queue
import re
import statistics
import subprocess
import sys
from threading import Thread
import time
import wave


OUTPUT_RATE = 24000
MAX_REPLY_BYTES = 16 * 1024 * 1024
MAX_AUDIO_BYTES = OUTPUT_RATE * 2 * 180
EXCLUDED = ("kostia", "inna", "dina", "vira", "innesa", "veronika_classmate", "anatolii", "veronika")
CORE = ("uk", "en", "ru")
NATIVE_LOCALES = frozenset(("sk", "pl", "de", "fr", "da", "it", "es"))
# Engineering smoke text, not a pronunciation evaluation corpus.
SAMPLES = {
    "uk": "Перевірка синтезатора. Кнопка перемикач натиснуто. Голос читає український текст.",
    "en": "Speech engine check. The selected voice is reading an English sentence.",
    "ru": "Проверка синтезатора. Выбранный голос читает русский текст.",
    "sk": "Toto je skúška syntézy reči.",
    "pl": "To jest próba syntezatora mowy.",
    "de": "Dies ist ein Test der Sprachausgabe.",
    "fr": "Ceci est un test de synthèse vocale.",
    "da": "Dette er en test af talesyntese.",
    "it": "Questa è una prova di sintesi vocale.",
    "es": "Esta es una prueba de síntesis de voz.",
    "pt": "Este é um teste de síntese de voz.",
    "nl": "Dit is een test van spraaksynthese.",
    "sv": "Detta är ett test av talsyntes.",
    "cs": "Toto je zkouška syntézy řeči.",
    "fi": "Tämä on puhesynteesin testi.",
    "nb": "Dette er en test av talesyntese.",
    "ro": "Acesta este un test de sinteză vocală.",
    "bg": "Това е тест на синтеза на реч.",
    "ja": "これは音声合成のテストです。",
    "cmn": "这是语音合成测试。",
    "ko": "이것은 음성 합성 테스트입니다.",
}


class ProbeError(RuntimeError):
    pass


class ProbeTimeout(ProbeError):
    pass


def timing_summary(values):
    """Small sample runs report observations, not unsupported tail guarantees."""
    values = [float(value) for value in values]
    if not values:
        return {"count": 0}
    result = {"count": len(values), "minimum_ms": min(values),
              "median_ms": statistics.median(values), "maximum_ms": max(values)}
    if len(values) >= 20:
        result["observed_p95_ms"] = sorted(values)[math.ceil(len(values) * .95) - 1]
    if len(values) >= 100:
        result["observed_p99_ms"] = sorted(values)[math.ceil(len(values) * .99) - 1]
    return result


def decode_pcm(value):
    if not isinstance(value, str):
        raise ProbeError("Worker PCM is not a base64 string")
    try:
        pcm = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as error:
        raise ProbeError("Worker returned invalid base64 PCM") from error
    if not pcm or len(pcm) % 2:
        raise ProbeError("Worker PCM is empty or not aligned to 16-bit samples")
    if len(pcm) > MAX_AUDIO_BYTES:
        raise ProbeError("Worker PCM exceeds the probe's audio budget")
    return pcm


def audio_statistics(pcm):
    samples = array("h", pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        raise ProbeError("No audio samples returned")
    rms = math.sqrt(sum(value * value for value in samples) / len(samples)) / 32768
    return {"frames": len(samples), "duration_seconds": len(samples) / OUTPUT_RATE,
            "peak": max(abs(value) for value in samples) / 32768, "rms": rms,
            "nonzero_samples": sum(value != 0 for value in samples)}


def save_wave(path, pcm):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(OUTPUT_RATE)
        output.writeframes(pcm)


def save_report(path, report):
    temporary = path.with_suffix(".json.part")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def load_catalog(runtime):
    """Inventory uses stdlib runtime helpers; model execution stays embedded."""
    module_path = runtime / "language_catalog.py"
    if not module_path.is_file():
        raise ProbeError("Packaged language_catalog.py is missing")
    spec = importlib.util.spec_from_file_location("_dordiai_probe_language_catalog", module_path)
    module = importlib.util.module_from_spec(spec)
    old_path = list(sys.path)
    try:
        sys.path.insert(0, str(runtime))
        spec.loader.exec_module(module)
    finally:
        sys.path[:] = old_path
    return module


def make_request(language, profile, text):
    request = {"mode": "reference", "profile": profile, "language": language,
               "text": text, "speed": 1., "stream": True,
               "controls": {"pitch": 50, "timbre": 50, "volume": 100},
               "numberLanguage": "auto", "character": False,
               "nativeProfile": language in {"en", "ru"}, "nativeEnglish": False}
    if language in NATIVE_LOCALES:
        request["nativeLocale"] = True
    elif language not in CORE:
        request["wideLocale"] = True
        request["reportLoading"] = True
    return request


class PipeWorker:
    """One persistent packaged process, with finite reply and shutdown waits."""

    def __init__(self, runtime, stderr_path):
        self.runtime = Path(runtime)
        self.command = [str(self.runtime / "python/python.exe"), "-I", "-B", "-u",
                        str(self.runtime / "nvda_worker.py"), str(self.runtime / "models"),
                        "--reference-model", str(self.runtime / "models/Holos"),
                        "--references", str(self.runtime / "models/voices"),
                        "--reference-engine", "holos", "--preload-language", "mixed"]
        self.responses = Queue()
        self.stderr = Path(stderr_path).open("wb")
        try:
            self.process = subprocess.Popen(
                self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=self.stderr, cwd=self.runtime,
                creationflags=(getattr(subprocess, "CREATE_NO_WINDOW", 0)
                               | getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)))
        except BaseException:
            self.stderr.close()
            raise
        self.reader = Thread(target=self._read, daemon=True, name="engine probe replies")
        self.reader.start()

    def _read(self):
        try:
            while True:
                line = self.process.stdout.readline(MAX_REPLY_BYTES + 1)
                if not line:
                    self.responses.put(None)
                    return
                if len(line) > MAX_REPLY_BYTES:
                    self.responses.put(ProbeError("Worker reply exceeds the probe's size limit"))
                    return
                try:
                    value = json.loads(line)
                    if not isinstance(value, dict):
                        raise ValueError("Worker response is not an object")
                except (ValueError, UnicodeError) as error:
                    self.responses.put(ProbeError("Invalid worker JSON: " + str(error)))
                    return
                self.responses.put(value)
        except OSError as error:
            self.responses.put(ProbeError("Worker response pipe failed: " + str(error)))

    def send(self, request):
        if self.process.poll() is not None:
            raise ProbeError("Worker exited with code " + str(self.process.returncode))
        try:
            self.process.stdin.write((json.dumps(request, ensure_ascii=True) + "\n").encode("ascii"))
            self.process.stdin.flush()
        except OSError as error:
            raise ProbeError("Could not send worker request: " + str(error)) from error

    def receive(self, timeout):
        if timeout <= 0:
            raise ProbeTimeout("Worker reply deadline expired")
        try:
            value = self.responses.get(timeout=timeout)
        except Empty as error:
            raise ProbeTimeout("Worker did not reply within " + str(round(timeout, 3)) + " seconds") from error
        if value is None:
            raise ProbeError("Worker closed its reply pipe; exit code " + str(self.process.poll()))
        if isinstance(value, Exception):
            raise value
        return value

    def render(self, request, timeout):
        started = time.perf_counter()
        deadline = time.monotonic() + timeout
        self.send(request)
        pieces, chunks, stages, first_ms, total_bytes = [], [], [], None, 0
        renderers = []
        while True:
            result = self.receive(deadline - time.monotonic())
            now_ms = (time.perf_counter() - started) * 1000
            if "loadingStage" in result:
                stages.append({"stage": result["loadingStage"], "time_ms": now_ms})
                continue
            if "error" in result:
                raise ProbeError("Speech engine error: " + str(result["error"]))
            if result.get("finished"):
                break
            encoded = result.get("chunk", result.get("pcm"))
            if encoded is None:
                raise ProbeError("Unexpected worker reply fields: " + ", ".join(result))
            data = decode_pcm(encoded)
            total_bytes += len(data)
            if total_bytes > MAX_AUDIO_BYTES:
                raise ProbeError("Utterance exceeds the probe's audio budget")
            if first_ms is None:
                first_ms = now_ms
            chunks.append({"time_ms": now_ms, "bytes": len(data)})
            pieces.append(data)
            details = {key: value for key, value in result.items() if key not in {"chunk", "pcm"}}
            if details not in renderers:
                renderers.append(details)
            if "pcm" in result:
                break
            self.send({"mode": "next"})
        pcm = b"".join(pieces)
        statistics_result = audio_statistics(pcm)
        if not statistics_result["nonzero_samples"]:
            raise ProbeError("Engine returned only digital silence")
        elapsed_ms = (time.perf_counter() - started) * 1000
        return pcm, {"first_pcm_ms": first_ms, "completed_ms": elapsed_ms,
                     "real_time_factor": elapsed_ms / 1000 / statistics_result["duration_seconds"],
                     "audio": statistics_result, "chunks": chunks,
                     "loading_stages": stages, "renderers": renderers}

    def check_excluded_voice(self, voice, timeout):
        self.send(make_request("uk", voice, "Перевірка."))
        result = self.receive(timeout)
        if result != {"error": "ValueError"}:
            raise ProbeError("Excluded voice was not rejected before audio: " + str(result.keys()))
        return {"voice": voice, "status": "passed", "reply": result}

    def cancel_request(self, request, timeout, delay_ms):
        """Cancel a real long request; distinguish pipe ACK from audible stop."""
        self.send(request)
        time.sleep(delay_ms / 1000)
        started = time.perf_counter()
        self.send({"mode": "cancel"})
        deadline = time.monotonic() + timeout
        first = self.receive(deadline - time.monotonic())
        while "loadingStage" in first:
            first = self.receive(deadline - time.monotonic())
        if "error" in first:
            raise ProbeError("Cancelled request returned an engine error: " + str(first["error"]))
        if not (first.get("finished") or "chunk" in first or "pcm" in first):
            raise ProbeError("Unexpected cancellation response")
        # A chunk can have reached the pipe before cancellation was received.
        # drop closes any remaining generator and establishes synchronization.
        self.send({"mode": "drop"})
        ack = self.receive(deadline - time.monotonic())
        if ack != {"finished": True}:
            raise ProbeError("Worker did not acknowledge dropping the cancelled stream")
        return {"status": "passed", "cancel_delay_after_request_ms": delay_ms,
                "cancel_and_drop_ack_ms": (time.perf_counter() - started) * 1000,
                "first_reply_was_already_buffered_audio": "chunk" in first or "pcm" in first,
                "scope": "worker protocol only; not NVDA audible stop latency"}

    def close(self):
        forced = False
        try:
            if self.process.poll() is None:
                try:
                    self.process.stdin.close()
                    self.process.wait(timeout=3)
                except (OSError, subprocess.TimeoutExpired):
                    forced = True
                    # A Russian native process may be a child of the worker.
                    # Kill this probe-owned process tree rather than leave it
                    # occupying RAM after a timed-out model request.
                    if os.name == "nt":
                        taskkill = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/taskkill.exe"
                        try:
                            subprocess.run([str(taskkill), "/PID", str(self.process.pid), "/T", "/F"],
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
                        except (OSError, subprocess.TimeoutExpired):
                            pass
                    if self.process.poll() is None:
                        self.process.kill()
                    try:
                        self.process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        pass
            return {"exit_code": self.process.poll(), "forced_termination": forced}
        finally:
            self.reader.join(timeout=.1)
            if not self.reader.is_alive():
                self.process.stdout.close()
            self.stderr.close()


def safe_name(value):
    return re.sub(r"[^a-zA-Z0-9_-]", "_", value)


def file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run_probe(args):
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    report_path = output / "report.json"
    package = Path(args.package_root).resolve()
    report = {"format": "dordiai-windows-engine-probe", "format_version": 1,
              "created_utc": datetime.now(timezone.utc).isoformat(),
              "platform": sys.platform, "host_python": sys.version,
              "system": platform.platform(), "machine": platform.machine(),
              "processor": platform.processor(), "logical_cpu_count": os.cpu_count(),
              "package_root": str(package), "status": "running", "tests": [],
              "scope": "actual packaged worker/model smoke; no NVDA audio device",
              "nvda_verified": False, "pronunciation_verified": False,
              "all_selected_languages_verified": False,
              "prepared_letter_latency_verified": False,
              "warnings": ["First-PCM time is a pipe measurement, not audible onset.",
                           "Generated WAV files require pronunciation and listening review."]}
    save_report(report_path, report)
    if os.name != "nt":
        report.update(status="blocked", reason="This probe requires real Windows and the packaged Windows runtime. No model or NVDA test was run.")
        report["completed_utc"] = datetime.now(timezone.utc).isoformat()
        save_report(report_path, report)
        return 2
    runtime = package if package.name == "kx47Runtime" else package / "kx47Runtime"
    worker = None
    try:
        for required in (runtime / "python/python.exe", runtime / "nvda_worker.py",
                         runtime / "models/voices/catalog.json"):
            if not required.is_file():
                raise ProbeError("Required packaged file missing: " + str(required))
        catalogue = load_catalog(runtime)
        names = json.loads((runtime / "models/voices/catalog.json").read_text(encoding="utf-8"))
        if not isinstance(names, dict):
            raise ProbeError("Packaged voice catalogue is not an object")
        allowed = tuple(voice for voice in names if isinstance(voice, str) and voice not in EXCLUDED)
        if not allowed:
            raise ProbeError("No allowed packaged voice is present")
        if args.voice is not None and args.voice not in allowed:
            raise ProbeError("Requested voice is absent or excluded: " + args.voice)
        models = runtime / "models"
        installed = catalogue.installed_languages(models)
        languages = list(installed) if args.all_installed else (
            [catalogue.canonical_code(code) for code in args.languages.split(",") if code.strip()]
            if args.languages else list(CORE))
        languages = list(dict.fromkeys(languages))
        samples = dict(SAMPLES)
        if args.samples_json:
            extra = json.loads(Path(args.samples_json).read_text(encoding="utf-8"))
            if not isinstance(extra, dict) or not all(isinstance(k, str) and isinstance(v, str)
                    and 0 < len(v.strip()) <= 2000 for k, v in extra.items()):
                raise ProbeError("Sample JSON must map language codes to nonempty texts of at most 2000 characters")
            samples.update((catalogue.canonical_code(code), text) for code, text in extra.items())
        report.update(runtime_root=str(runtime), requested_languages=languages,
                      installed_language_count=len(installed), voice_count=len(allowed),
                      worker_script_sha256=file_digest(runtime / "nvda_worker.py"),
                      embedded_python_sha256=file_digest(runtime / "python/python.exe"))
        release_manifest = package / "dordiai-release.json"
        if release_manifest.is_file():
            release = json.loads(release_manifest.read_text(encoding="utf-8"))
            report["package_version"] = release.get("version")
        worker = PipeWorker(runtime, output / "worker-stderr.log")
        report["worker_command"] = worker.command
        failures = 0
        for language in languages:
            test = {"kind": "language-engine", "language": language, "runs": []}
            report["tests"].append(test)
            if language not in installed:
                test.update(status="blocked", reason="Required language resources are not installed")
                failures += 1
                save_report(report_path, report)
                continue
            if language not in samples:
                test.update(status="skipped", reason="No engineering sample provided; supply --samples-json")
                save_report(report_path, report)
                continue
            compatible = catalogue.compatible_voice_ids(models, language, allowed)
            if args.voice:
                compatible = tuple(voice for voice in compatible if voice == args.voice)
            if not compatible:
                test.update(status="blocked", reason="No compatible allowed voice assets are present")
                failures += 1
                save_report(report_path, report)
                continue
            voice = "sara" if "sara" in compatible else compatible[0]
            test.update(voice=voice, text=samples[language])
            for repetition in range(args.repetitions):
                try:
                    pcm, result = worker.render(make_request(language, voice, samples[language]), args.timeout)
                    filename = f"{safe_name(language)}-{safe_name(voice)}-{repetition + 1}.wav"
                    save_wave(output / filename, pcm)
                    test["runs"].append(dict(result, wave_file=filename,
                                             repeat_index=repetition,
                                             warm_repeat=repetition > 0))
                    if language in {"en", "ru"} and any(
                            renderer.get("engine") != "profile" for renderer in result["renderers"]):
                        raise ProbeError("Native profile synthesis fell back to the baseline renderer")
                except (ProbeError, OSError, ValueError) as error:
                    test.update(status="failed", error=str(error))
                    failures += 1
                    # A timeout loses pipe synchronization. Stop rather than
                    # assign an old response to the next language request.
                    if isinstance(error, ProbeTimeout):
                        raise
                    break
            if test.get("status") != "failed":
                test.update(status="passed", first_pcm=timing_summary(
                    run["first_pcm_ms"] for run in test["runs"]))
            save_report(report_path, report)
        for voice in EXCLUDED:
            try:
                report["tests"].append(dict(worker.check_excluded_voice(voice, min(args.timeout, 10)),
                                            kind="excluded-voice"))
            except ProbeError as error:
                report["tests"].append({"kind": "excluded-voice", "voice": voice,
                                        "status": "failed", "error": str(error)})
                failures += 1
                if isinstance(error, ProbeTimeout):
                    raise
            save_report(report_path, report)
        cancel_voice = catalogue.compatible_voice_ids(models, "uk", allowed)
        if cancel_voice:
            voice = "sara" if "sara" in cancel_voice else cancel_voice[0]
            cancel = {"kind": "cancel-and-recover", "language": "uk", "voice": voice}
            report["tests"].append(cancel)
            try:
                cancel.update(worker.cancel_request(make_request("uk", voice, SAMPLES["uk"] * 8),
                                                    min(args.timeout, 15), args.cancel_delay_ms))
                pcm, result = worker.render(make_request("uk", voice,
                    "Перевірка після скасування. Мовлення знову працює."), args.timeout)
                save_wave(output / "cancel-recovery.wav", pcm)
                cancel["recovery"] = dict(result, wave_file="cancel-recovery.wav")
            except ProbeError as error:
                cancel.update(status="failed", error=str(error))
                failures += 1
                if isinstance(error, ProbeTimeout):
                    raise
        else:
            report["tests"].append({"kind": "cancel-and-recover", "status": "blocked",
                                    "reason": "No compatible Ukrainian voice resources"})
            failures += 1
        report["status"] = "failed" if failures else "passed"
        report["failed_or_blocked_checks"] = failures
    except (ProbeError, OSError, ValueError, ImportError) as error:
        report.update(status="blocked" if worker is None else "failed", error=str(error))
    finally:
        if worker is not None:
            report["worker_shutdown"] = worker.close()
            if (report["worker_shutdown"]["forced_termination"]
                    or report["worker_shutdown"]["exit_code"] != 0):
                report["status"] = "failed"
                report["warnings"].append("Packaged worker did not shut down cleanly")
        report["completed_utc"] = datetime.now(timezone.utc).isoformat()
        save_report(report_path, report)
    return 0 if report["status"] == "passed" else 2 if report["status"] == "blocked" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", required=True, type=Path,
                        help="Unpacked NVDA add-on root, or its kx47Runtime directory")
    parser.add_argument("--output", required=True, type=Path, help="Report, WAV and worker-log directory")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--all-installed", action="store_true")
    group.add_argument("--languages", help="Comma-separated explicit language codes; default is the three core languages")
    parser.add_argument("--voice", help="Require this allowed voice instead of choosing a compatible installed one")
    parser.add_argument("--samples-json", type=Path, help="Additional engineering text samples by language code")
    parser.add_argument("--timeout", type=float, default=90, help="Maximum seconds per complete utterance")
    parser.add_argument("--repetitions", type=int, default=2)
    parser.add_argument("--cancel-delay-ms", type=float, default=20)
    args = parser.parse_args(argv)
    if not 0 < args.timeout <= 600 or not 1 <= args.repetitions <= 20 or not 0 <= args.cancel_delay_ms <= 1000:
        parser.error("timeout must be 0..600 seconds, repetitions 1..20, cancel delay 0..1000 ms")
    code = run_probe(args)
    report_path = args.output.resolve() / "report.json"
    result = json.loads(report_path.read_text(encoding="utf-8"))
    print("Windows engine probe: " + result["status"] + "; report: " + str(report_path), flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
