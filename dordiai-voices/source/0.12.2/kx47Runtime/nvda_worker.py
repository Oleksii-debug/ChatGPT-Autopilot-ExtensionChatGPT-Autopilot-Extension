"""Serve KX-47 requests over private pipes using a persistent local model cache."""

import argparse
import base64
import json
import os
from pathlib import Path
import sys
import traceback
from queue import Queue
from threading import Thread

# The embedded interpreter is launched with -I and a restricted ._pth file;
# sibling modules must be reachable before importing request-control helpers.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from session_control import RequestCancellation, SynthesisCancelled
from voice_policy import require_voice_allowed


OUTPUT_RATE = 24000
CLASSMATE_PROFILE = 'veronika_classmate'
CLASSMATE_LOCALES = frozenset(('sk', 'pl', 'de', 'fr', 'da', 'it', 'es'))


def pcm_response(audio, rate):
    import numpy as np
    if rate <= 0 or not len(audio) or not np.isfinite(audio).all():
        raise ValueError("The model returned invalid audio.")
    if rate != OUTPUT_RATE:
        source = np.arange(len(audio))
        target = np.arange(round(len(audio) * OUTPUT_RATE / rate)) * rate / OUTPUT_RATE
        audio = np.interp(target, source, audio)
    pcm = np.rint(np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    return base64.b64encode(pcm).decode("ascii")


def delivered_audio(source, rate, references, request, controls, *, condition):
    from voice_controls import apply_stream_controls

    try:
        blocks = source
        if condition:
            from voice_delivery import clean_onset, equalize_voice
            blocks = equalize_voice(blocks, references, request["profile"], request["language"])
            blocks = clean_onset(blocks, character=bool(request.get("character")))
        blocks = apply_stream_controls(blocks, rate, **controls)
        if condition and request["profile"] in {"innesa", "vira", "dina", "kostia"}:
            from clean_voice_audio import tame_sibilance_stream
            blocks = tame_sibilance_stream(blocks, ceiling=.020 if request["profile"] == "kostia" else .014)
        yield from blocks
    finally:
        close = getattr(source, "close", None)
        if close is not None:
            close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("models", type=Path)
    parser.add_argument("--reference-model", type=Path)
    parser.add_argument("--references", type=Path)
    parser.add_argument("--reference-engine", choices=("omnivoice", "openvoice", "holos"), default="omnivoice")
    parser.add_argument("--preload-language", choices=("uk", "en", "mixed"), default="mixed")
    args = parser.parse_args()
    if bool(args.reference_model) != bool(args.references):
        parser.error("Supply both the reference model and reference samples.")

    # Libraries can write diagnostics to either standard stream. Keep the pipe for replies only.
    with os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="ascii", newline="\n") as replies:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        engine = None
        reference_voices = None
        if args.references:
            if args.reference_engine == "holos":
                from ukrainian_voices import UkrainianVoices
                reference_voices = UkrainianVoices(args.models, args.references, threads=4)
            elif args.reference_engine == "openvoice":
                from converted_voices import ConvertedVoices
                reference_voices = ConvertedVoices(args.models, args.references)
            else:
                from reference_voices import ReferenceVoices
                reference_voices = ReferenceVoices(args.reference_model, args.references)
        stream = None
        native_profiles = None
        classmate_locales = None
        classmate_forecast = None
        wide_voices = None
        renderer = {}
        native_loader = None
        incoming = Queue()
        cancellations = RequestCancellation()
        stream_cancellation = None

        def close_stream():
            nonlocal stream, stream_cancellation
            previous, stream = stream, None
            try:
                if previous is not None:
                    previous.close()
            finally:
                cancellations.release(stream_cancellation)
                stream_cancellation = None

        def get_classmate_locales():
            nonlocal classmate_locales
            if classmate_locales is None:
                from native_locale import NativeLocaleVoices
                classmate_locales = NativeLocaleVoices(
                    args.models, args.references / "classmate_locales", threads=4, owner=reference_voices,
                )
            return classmate_locales

        def get_native_profiles():
            nonlocal native_profiles
            if native_profiles is None:
                import atexit
                from native_multilingual import NativeMultilingual

                native_profiles = NativeMultilingual(args.models / "PocketTTS", args.references / "native_profiles", threads=3)
                atexit.register(native_profiles.close)
            return native_profiles

        from wide_warmup import WideWarmupGate,memory_headroom,background_setup_thread
        warmup_gate = WideWarmupGate()

        def warm_models(profiles):
            background_setup_thread()
            if not warmup_gate.ready():
                return
            # The worker and the separate Russian process together can occupy
            # over two GiB. Under pressure open only the model actually requested.
            space = memory_headroom()
            if space is not None and space < 3 * 1024**3:
                return

            def prepare(load):
                background_setup_thread()
                try:
                    load()
                except Exception as error:
                    print(f"Speech model warmup failed: {error}", file=sys.stderr)

            # Russian has its own executable. Prepare it alongside the local
            # Ukrainian graph; then load English without contending for all
            # three languages' native CPU thread pools at once.
            russian_loader = Thread(target=prepare, args=(profiles.warm_russian,), daemon=True, name="Russian setup")
            russian_loader.start()
            load_ukrainian()
            prepare(profiles.warm_english)
            russian_loader.join()

        def load_ukrainian():
            try:
                # Load the graph and stress data without running an utterance or
                # changing the request's cancellation event.
                from ukrainian_stress import accent_text

                reference_voices.holos
                accent_text("Готово.")
            except Exception as error:
                print(f"Ukrainian warmup failed: {type(error).__name__}", file=sys.stderr)

        def read_requests():
            current = None
            try:
                for line in sys.stdin.buffer:
                    request = json.loads(line)
                    if request["mode"] == "discardForecast":
                        if classmate_forecast is not None:
                            classmate_forecast.discard(request.get("token"))
                        continue
                    if request["mode"] == "cancel":
                        warmup_gate.finished()
                        if classmate_forecast is not None:
                            classmate_forecast.discard()
                        cancellations.cancel(reference_voices)
                        continue  # Out-of-band signal, no response in the audio pipe.
                    if request["mode"] == "reference":
                        warmup_gate.reference(bool(request.get("wideLocale")))
                        current = cancellations.new()
                    incoming.put((request, current))
            finally:
                cancellations.cancel(reference_voices)
                warmup_gate.close()
                incoming.put(None)

        Thread(target=read_requests, daemon=True, name="Speech cancellation").start()
        while (entry := incoming.get()) is not None:
            try:
                request, cancellation = entry
                if "profile" in request:
                    require_voice_allowed(request["profile"])
                if request["mode"] == "reference":
                    close_stream()
                    if cancellation is not None and cancellation.is_set():
                        warmup_gate.finished()
                        cancellations.release(cancellation)
                        replies.write('{"finished": true}\n')
                        replies.flush()
                        continue
                if request["mode"] == "reference" and reference_voices is not None:
                    reference_voices.cancel_event = cancellation
                if request["mode"] == "preload":
                    if reference_voices is not None and not request.get("runtimeOnly"):
                        if args.reference_engine == "holos":
                            reference_voices.preload(args.preload_language)
                        elif args.reference_engine == "openvoice":
                            reference_voices.preload()
                    if args.reference_engine == "holos" and request.get("runtimeOnly") and native_loader is None:
                        try:
                            profiles = get_native_profiles()
                            native_loader = Thread(target=warm_models, args=(profiles,), daemon=True, name="Speech model setup")
                            native_loader.start()
                        except Exception as error:
                            print(f"Voice profile setup failed: {error}", file=sys.stderr)
                    replies.write('{"ready": true}\n')
                    replies.flush()
                    continue
                controls = request.get("controls") or {}
                if (request.get("stream") and request["mode"] == "reference"
                        and args.reference_engine in {"openvoice", "holos"} and reference_voices is not None):
                    from navigation_cache import load_clip
                    segments = request.get("segments") if args.reference_engine == "holos" else None
                    native = args.reference_engine == "holos" and request.get("nativeEnglish", False)
                    renderer = {"engine": "baseline", "profile": request["profile"]}
                    use_profile = args.reference_engine == "holos" and request.get("nativeProfile", False)
                    locale = (request.get("language") or "").split("-")[0]
                    wide_code = None
                    if request.get("wideLocale"):
                        from wide_languages import registered
                        wide_code = registered(request.get("language") or "")
                        if not wide_code:
                            raise ValueError("Unregistered extended language")
                        use_profile = False
                    hint = request.get("nextNative")
                    if (not isinstance(hint, list) or len(hint) != 3 or hint[1] not in CLASSMATE_LOCALES
                            or request.get("character")):
                        hint = None
                    def start_forecast(forecast=hint, event=cancellation):
                        nonlocal classmate_forecast
                        if not forecast or event.is_set():
                            return
                        if classmate_forecast is None:
                            from native_lookahead import NativeLookahead
                            classmate_forecast = NativeLookahead(get_classmate_locales().forecast_context)
                        classmate_forecast.schedule(forecast, event)
                    is_locale = (locale in CLASSMATE_LOCALES and
                                 request.get("nativeLocale", request["profile"] == CLASSMATE_PROFILE))
                    if not is_locale:
                        if hint:
                            start_forecast()
                        elif classmate_forecast is not None:
                            classmate_forecast.discard()
                    cached = None if segments or native or use_profile or is_locale or wide_code or request.get("character") else load_clip(
                        args.references, request["profile"], request["language"], request["text"], request["speed"])
                    if wide_code:
                        if wide_voices is None:
                            from wide_voice import WideVoices
                            wide_voices = WideVoices(args.models,args.references,owner=reference_voices,threads=3,
                                                   converter=get_classmate_locales())
                        def opening(stage):
                            replies.write(json.dumps({"loadingStage":stage}) + "\n")
                            replies.flush()
                        wide_voices.progress = opening if request.get("reportLoading") else None
                        renderer["engine"] = "wide:" + wide_code
                        renderer["speaker"] = request["profile"]
                        blocks = wide_voices.blocks(request["profile"],wide_code,request["text"],request["speed"],
                                                   character=bool(request.get("character")))
                        if request.get("reportLoading"):
                            from wide_warmup import foreground_blocks
                            blocks = foreground_blocks(blocks)
                    elif args.reference_engine == "holos" and not segments and is_locale:
                        get_classmate_locales()
                        renderer["engine"] = ("classmate-locale:" if request["profile"] == CLASSMATE_PROFILE else "native-locale:") + locale
                        renderer["carrier"] = classmate_locales.languages[locale].get("voice", "Piper")
                        renderer["speaker"] = request["profile"]
                        prepared = (classmate_forecast.take(locale, request["text"], cancellation)
                                    if classmate_forecast is not None and not request.get("character") else None)
                        if prepared is not None:
                            renderer["preparedCarrier"] = True
                        blocks = classmate_locales.blocks(
                            request["profile"], locale, request["text"], request["speed"],
                            character=bool(request.get("character")), prepared=prepared,
                            prepare_next=start_forecast if hint else None,
                        )
                    elif cached is not None:
                        blocks = (cached,)
                    elif native:
                        blocks = reference_voices.native_english_chunks(
                            request["profile"], request["language"], request["text"], request["speed"])
                    else:
                        blocks = reference_voices.chunks(
                            request["profile"], request["language"], request["text"], request["speed"],
                            **({"segments": segments} if segments else {}),
                        )
                    if use_profile:
                        native_profiles = get_native_profiles()
                        parts = native_profiles.plan(
                            request["profile"], request["language"], request["text"], request.get("numberLanguage", "auto"),
                        )
                        if parts:
                            from native_multilingual import preferred_speech

                            blocks = preferred_speech(
                                native_profiles.phrase(
                                    request["profile"], parts, request["speed"], cancellation.is_set,
                                    reference_voices.chunks,
                                ),
                                blocks, renderer,
                            )
                    rate = getattr(reference_voices, "output_rate", reference_voices.sampling_rate)
                    stream = delivered_audio(blocks, rate, args.references, request, controls,
                                             condition=cached is None and args.reference_engine == "holos")
                    stream_cancellation = cancellation
                elif request["mode"] == "drop":
                    warmup_gate.finished()
                    close_stream()
                    replies.write('{"finished": true}\n')
                    replies.flush()
                    continue
                if request["mode"] == "next" or request.get("stream") and stream is not None:
                    try:
                        if stream_cancellation is not None and stream_cancellation.is_set():
                            raise SynthesisCancelled()
                        block = next(stream) if stream is not None else None
                    except StopIteration:
                        close_stream()
                        block = None
                    if stream_cancellation is not None and stream_cancellation.is_set():
                        raise SynthesisCancelled()
                    if block is None:
                        warmup_gate.finished()
                    result = {"finished": True} if block is None else {
                        "chunk": pcm_response(block, getattr(reference_voices, "output_rate", reference_voices.sampling_rate)),
                        **renderer,
                    }
                    replies.write(json.dumps(result) + "\n")
                    replies.flush()
                    continue
                if request["mode"] == "reference":
                    if reference_voices is None:
                        raise ValueError("Reference voices are unavailable.")
                    audio, rate = reference_voices.synthesize(
                        request["profile"], request["language"], request["text"], request["speed"],
                    )
                    if cancellation is not None and cancellation.is_set():
                        raise SynthesisCancelled()
                    cancellations.release(cancellation)
                else:
                    if engine is None:
                        from kx47 import LocalSynthesizer, PROFILES
                        engine = LocalSynthesizer(args.models)
                    audio, rate = engine.synthesize(
                        PROFILES[request["profile"]], request["language"], request["text"],
                        request["mode"], request["speed"],
                    )
                controls = request.get("controls")
                if controls:
                    from voice_controls import apply_voice_controls
                    audio = apply_voice_controls(audio, rate, **controls)
                response = {"pcm": pcm_response(audio, rate)}
            except Exception as error:
                warmup_gate.finished()
                if not isinstance(error, SynthesisCancelled):
                    # Keep diagnostics out of the JSON audio pipe. The engine
                    # probe retains this stream for actionable model failures.
                    traceback.print_exc(file=sys.stderr)
                try:
                    close_stream()
                except Exception as cleanup_error:
                    print(f"Speech stream cleanup failed: {type(cleanup_error).__name__}", file=sys.stderr)
                cancellations.release(cancellation)
                response = {"finished": True} if isinstance(error, SynthesisCancelled) else {"error": type(error).__name__}
            replies.write(json.dumps(response) + "\n")
            replies.flush()
        close_stream()
        if classmate_forecast is not None:
            classmate_forecast.close()
        if classmate_locales is not None:
            classmate_locales.close_locales()
        if wide_voices is not None:
            wide_voices.close()
        if native_loader is not None:
            native_loader.join(timeout=5)


if __name__ == "__main__":
    main()
