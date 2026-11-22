"""Offline, isolated Tongan phonemic-carrier experiment; never installs a voice.

Requires a locally extracted Linux eSpeak NG library/data and the existing
FP32 OpenVoice reference encoder + flow/decoder. eSpeak receives ONLY explicit
native-rule phonemes, not text pronounced as Spanish. Its Spanish acoustic
table is a five-vowel universal carrier, not a Tongan trained model.
"""
import argparse
import ctypes as ct
import hashlib
import json
from pathlib import Path
import sys
import time

from tongan_frontend import encoded, text_words, Word


class PhonemicCarrier:
    CALLBACK = ct.CFUNCTYPE(ct.c_int, ct.POINTER(ct.c_int16), ct.c_int, ct.c_void_p)

    def __init__(self, library_directory):
        folder = Path(library_directory).resolve()
        self.dependencies = [ct.CDLL(str(folder / name), mode=ct.RTLD_GLOBAL)
                             for name in ("libsonic.so.0", "libpcaudio.so.0")]
        self.lib = ct.CDLL(str(folder / "libespeak-ng.so.1"))
        signatures = {
            "espeak_Initialize": ([ct.c_int, ct.c_int, ct.c_char_p, ct.c_int], ct.c_int),
            "espeak_SetSynthCallback": ([self.CALLBACK], None),
            "espeak_SetVoiceByName": ([ct.c_char_p], ct.c_int),
            "espeak_SetParameter": ([ct.c_int, ct.c_int, ct.c_int], ct.c_int),
            "espeak_Synth": ([ct.c_char_p, ct.c_size_t, ct.c_uint, ct.c_int,
                              ct.c_uint, ct.c_uint, ct.c_void_p, ct.c_void_p], ct.c_int),
            "espeak_Terminate": ([], ct.c_int),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.lib, name)
            function.argtypes, function.restype = arguments, result
        self.rate = self.lib.espeak_Initialize(2, 35, str(folder).encode(), 0x8000)
        if self.rate <= 0:
            raise RuntimeError("Local eSpeak NG data could not initialize")
        self.packets = []
        self.callback = self.CALLBACK(self.capture)
        self.lib.espeak_SetSynthCallback(self.callback)
        if self.lib.espeak_SetVoiceByName(b"es"):
            raise RuntimeError("Requested five-vowel acoustic table is unavailable")
        self.lib.espeak_SetParameter(1, 182, 0)

    def capture(self, pointer, length, _events):
        if pointer and length > 0:
            self.packets.append(ct.string_at(pointer, 2 * length))
        return 0

    def audio(self, text):
        import numpy as np
        phonemes = encoded(text)
        raw = phonemes.encode("ascii")
        self.packets.clear()
        status = self.lib.espeak_Synth(raw, len(raw) + 1, 0, 1, 0, 1 | 0x100, None, None)
        if status:
            raise RuntimeError("Explicit phonemic input was rejected")
        result = np.frombuffer(b"".join(self.packets), dtype="<i2").astype(np.float32) / 32768.
        self.packets.clear()
        if result.size < 512 or not np.isfinite(result).all() or not np.any(result):
            raise ValueError("Phonemic carrier produced no valid PCM")
        return result

    def close(self):
        self.lib.espeak_Terminate()


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--espeak-libraries", required=True, type=Path)
    parser.add_argument("--models", required=True, type=Path)
    parser.add_argument("--encoder", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    sys.path[:0] = [str(root / "source/0.12.2/kx47Runtime"), str(root / "tools")]
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
    import soundfile as sf
    from converted_voices import spectrogram, resample
    from prepare_reference_encoder import extract_embedding, load_encoder
    from voice_delivery import speech_level, peak_limit
    if ort.__version__ != "1.27.0":
        raise RuntimeError("This pinned experiment requires verified ORT 1.27.0")
    args.output.mkdir(parents=True, exist_ok=True)
    carrier = PhonemicCarrier(args.espeak_libraries)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    def session(name):
        return ort.InferenceSession(str(args.models / "OpenVoiceV2" / name),
                                   sess_options=options, providers=["CPUExecutionProvider"])
    reference = load_encoder(args.encoder, threads=2)
    calibration = "Mālō e lelei. ʻOku ou sai pē. Mālō e lelei."
    calibration_wave = carrier.audio(calibration)
    sf.write(args.output / "calibration.wav", calibration_wave, carrier.rate, subtype="PCM_16")
    # Establish identity from the exact written calibration WAV, not a copied
    # neighbouring-language source vector or a unit-normalized approximation.
    calibration_wave, recorded_rate = sf.read(args.output / "calibration.wav", dtype="float32")
    source = extract_embedding(calibration_wave, recorded_rate, reference)
    np.save(args.output / "source.npy", source, allow_pickle=False)
    target_file = args.models / "voices/classmate_locales/viktoriia.npy"
    target = np.load(target_file, allow_pickle=False)
    if target.shape != (1, 256, 1) or not np.isfinite(target).all():
        raise ValueError("Target identity contract differs from baseline")
    flow, decoder = session("encoder-flow.onnx"), session("decoder.onnx")
    cases = [("ordinary-text", None, text) for text in
             ["uma", "ʻuma", "kaka", "kakā", "kākā", "tangata", "tangatá", "koté",
              "Mālō e lelei.", "Kuo´ u fiu, mālō."]]
    names_file = Path(__file__).with_name("tongan_letter_names.json")
    names = json.loads(names_file.read_text())["letter_names"]
    cases.extend(("ordinary-letter-name", glyph, text) for glyph, text in names.items())
    records = []
    try:
        for index, (kind, lookup, text) in enumerate(cases):
            started = time.perf_counter(); wave = carrier.audio(text)
            carrier_ms = 1000 * (time.perf_counter() - started)
            native = args.output / (str(index).zfill(2) + "-phonemic.wav")
            sf.write(native, wave, carrier.rate, subtype="PCM_16")
            spectrum = spectrogram(resample(wave, carrier.rate, 22050)).T[None]
            started = time.perf_counter()
            latent = flow.run(None, {"spec": spectrum, "spec_lengths": np.array([spectrum.shape[-1]], np.int64),
                                     "src_g": source, "tgt_g": target})[0]
            projected = decoder.run(None, {"/Mul_output_0": latent,
                                           "/ConstantOfShape_1_output_0": np.zeros_like(target)})[0].reshape(-1)
            level = speech_level(projected)
            gain = float(np.clip(.112 / level, .32, 4.)) if level > 1e-5 else 1.
            projected = peak_limit(projected * gain)
            projection_ms = 1000 * (time.perf_counter() - started)
            if not np.isfinite(projected).all() or not np.any(projected):
                raise ValueError("Projection produced no finite audible signal")
            projected_file = args.output / (str(index).zfill(2) + "-viktoriia.wav")
            sf.write(projected_file, projected, 24000, subtype="PCM_16")
            records.append({"semantic_kind": kind, "lookup_text": lookup,
                            "text": text, "frontend": [p.describe() for p in text_words(text) if isinstance(p, Word)],
                            "encoded": encoded(text), "carrier_ms": carrier_ms,
                            "carrier_samples": len(wave), "carrier_seconds": len(wave) / carrier.rate,
                            "carrier_pcm_sha256": sha256(native), "projection_ms": projection_ms,
                            "projected_samples": len(projected), "projected_pcm_sha256": sha256(projected_file),
                            "projected_peak": float(np.max(np.abs(projected))), "finite_nonzero": True})
    finally:
        carrier.close()
    report = {
        "status": "isolated-native-rule-phonemic-experiment-not-registered", "language": "to",
        "model_is_native_tongan": False, "carrier": "espeak-ng explicit phonemes, Spanish five-vowel acoustic table",
        "source_identity_is_actual_same_carrier": True, "source_sha256": sha256(args.output / "source.npy"),
        "source_norm": float(np.linalg.norm(source)), "source_shape": list(source.shape),
        "calibration_text": calibration, "calibration_wav_sha256": sha256(args.output / "calibration.wav"),
        "calibration_seconds": len(calibration_wave) / recorded_rate,
        "encoder_sha256": sha256(args.encoder), "target_identity_file": str(target_file),
        "flow_sha256": sha256(args.models / "OpenVoiceV2/encoder-flow.onnx"),
        "decoder_sha256": sha256(args.models / "OpenVoiceV2/decoder.onnx"),
        "frontend_sha256": sha256(Path(__file__).with_name("tongan_frontend.py")),
        "ordinary_letter_names_metadata_sha256": sha256(names_file),
        "target_identity_sha256": sha256(target_file), "onnxruntime": ort.__version__,
        "registered": False, "native_listener_verified": False, "native_phonetic_fidelity_verified": False,
        "ordinary_character_names_verified": False, "windows_nvda_verified": False,
        "sources": [
            {"title": "Faufaua! An Introduction to Tongan", "publisher": "NZ Ministry of Education",
             "year": 2010, "pages": [13, 14, 15, 20, 21],
             "pdf_sha256": "f26b5eb0fb7109d1518441b770683952b801dc5ba7873db76188b4f49de82e61",
             "url": "https://mapaoch00pr.blob.core.windows.net/mapaoch00pr/artefacts/pdf/5a7c980b-4849-4690-ad8d-4a9cda5201d9/Faufaua%21-an-introduction-to-Tongan.pdf"},
            {"title": "Phonetics of Tongan stress", "authors": "Marc Garellek and James White",
             "year": 2015, "doi": "10.1017/S0025100314000206",
             "url": "https://www.homepages.ucl.ac.uk/~ucjtcwh/index_files/GarellekWhite2015.pdf",
             "sections": ["1.1 phoneme inventory and penultimate-mora stress"]},
            {"title": "Tongan", "authors": "Marc Garellek and Marija Tabain", "year": 2019,
             "doi": "10.1017/S0025100318000397",
             "url": "https://www.cambridge.org/core/journals/journal-of-the-international-phonetic-association/article/tongan/FEE50E3523F8844E0617DB290EA0516A",
             "sections": ["Stress: definitive vowel copying", "Vowel sequences", "Consonants"]},
            {"title": "Tongan Language Week Education Resource 2016", "publisher": "Te Papa",
             "pdf_page": 6, "section": "Explicit ordinary Letter name fields",
             "url": "https://www.tepapa.govt.nz/assets/76067/1692747224-final_final_version-tongan_resource_2016.pdf"},
            {"title": "eSpeak NG dictionary documentation", "section": "Phoneme names: | separator",
             "url": "https://github.com/espeak-ng/espeak-ng/blob/master/docs/dictionary.md"}
        ],
        "remaining_limits": ["unwritten definitive accents", "unmarked clitic stress domains", "optional vowel fusion",
                             "secondary and loanword stress", "native phrasal intonation",
                             "phonemic carrier timing/quality and target voice projection need native review"],
        "cases": records,
    }
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"cases": len(records), "source_norm": report["source_norm"], "registered": False,
                      "evidence": str(args.evidence)}))


if __name__ == "__main__": main()
