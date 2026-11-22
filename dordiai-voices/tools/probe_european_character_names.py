#!/usr/bin/env python3
"""Probe literal primary-source names with original Piper weights on Linux.

These finite PCM and vocabulary checks are not human pronunciation validation,
Windows driver tests or a statement of real typing latency.
"""
from pathlib import Path
import argparse
import gc
import hashlib
import json
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--onnxruntime-root', type=Path, required=True)
    parser.add_argument('--piper-root', type=Path, required=True)
    parser.add_argument('--models', type=Path, default=ROOT / 'packages/0.12.2/kx47Runtime/models/Piper')
    args = parser.parse_args(argv)
    safe = args.onnxruntime_root.resolve()
    for binary in (p for p in safe.rglob('*') if p.is_file() and (p.suffix.lower() in {'.so', '.dll', '.pyd'} or '.so.' in p.name)):
        data = binary.read_bytes()
        if b'mobile.events.data.microsoft.com' in data or b'OneCollector' in data:
            raise RuntimeError('Refusing previously rejected telemetry-capable preparation runtime')
    sys.path.insert(0, str(safe))
    import onnxruntime as ort
    assert ort.__version__ == '1.27.0' and Path(ort.__file__).resolve().is_relative_to(safe)
    ort.disable_telemetry_events()
    sys.path.insert(0, str(args.piper_root.resolve()))
    from piper import PiperVoice, PiperConfig, SynthesisConfig
    from piper.phonemize_espeak import EspeakPhonemizer
    import piper
    assert Path(piper.__file__).resolve().is_relative_to(args.piper_root.resolve())
    import numpy as np
    import soundfile as sf
    runtime = ROOT / 'source/0.12.2/kx47Runtime'
    sys.path.insert(0, str(runtime))
    from character_names import spoken_name
    names = runtime / 'models/CharacterNames'
    phonemizer = EspeakPhonemizer()
    output = ROOT / 'evidence/european_character_probes'
    output.mkdir(parents=True, exist_ok=True)
    report = {'scope': 'Linux original-weight Piper vocabulary/PCM checks only; no human pronunciation, selected-target identity or Windows/NVDA acceptance',
              'onnxruntime': ort.__version__, 'piper_version': '1.8.0', 'languages': {}}
    for code, filename, probes in [('es', 'es_ES-davefx-medium.onnx', ['b', 'ñ', 'w']),
                                    ('it', 'it_IT-paola-medium.onnx', ['c', 'h', 'w']),
                                    ('pl', 'pl_PL-gosia-medium.onnx', ['b', 'ł', 'ź'])]:
        model = args.models / filename
        config = PiperConfig.from_dict(json.loads(model.with_suffix('.onnx.json').read_text(encoding='utf-8')))
        doc = json.loads((names / (code + '.json')).read_text(encoding='utf-8'))
        missing, prepared = {}, {}
        for glyph in doc['ordinary_alphabet_source_repertoire']:
            text = spoken_name(code, glyph, directory=names)
            clauses = phonemizer.phonemize(config.espeak_voice, text, vowel_clusters=config.vowel_clusters)
            prepared[glyph] = clauses
            unknown = sorted({phone for clause in clauses for phone in clause if phone not in config.phoneme_id_map})
            if unknown:
                missing[glyph] = unknown
        entry = {'model': filename, 'all_source_names_frontend_missing_phones': missing, 'clips': [],
                 'native_pronunciation_accepted': False}
        report['languages'][code] = entry
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
        voice = PiperVoice(session=session, config=config)
        for glyph in probes:
            if glyph in missing:
                raise ValueError('Untrained phones for native name: ' + code + '/' + glyph)
            text = spoken_name(code, glyph, directory=names)
            start = time.perf_counter()
            chunks = [voice.phoneme_ids_to_audio(voice.phonemes_to_ids(clause), SynthesisConfig()) for clause in prepared[glyph] if clause]
            wave = np.concatenate(chunks).astype(np.float32)
            elapsed = time.perf_counter() - start
            assert wave.size and np.isfinite(wave).all() and np.max(np.abs(wave)) > 1e-7
            clip = output / (code + '-' + str(len(entry['clips'])) + '.wav')
            sf.write(clip, wave, config.sample_rate, subtype='PCM_16')
            row = {'glyph': glyph, 'name': text, 'samples': wave.size, 'sample_rate': config.sample_rate,
                   'render_seconds': elapsed, 'peak': float(np.max(np.abs(wave))),
                   'sha256': hashlib.sha256(clip.read_bytes()).hexdigest(), 'path': str(clip.relative_to(ROOT))}
            entry['clips'].append(row)
            print(code, text, elapsed, flush=True)
            (ROOT / 'evidence/european_character_probes.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        del voice, session
        gc.collect()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
