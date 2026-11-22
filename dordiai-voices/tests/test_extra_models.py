"""Optional model preparation and Santali frontend contracts, without network calls."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


sys.path.insert(0, str(RUNTIME))
extra = module("extra_under_test", RUNTIME / "wide_extra_models.py")
prepare = module("extra_prepare_under_test", ROOT / "tools/prepare_extra_models.py")
CONFIG = {"audio": {"sample_rate": 22050}, "phoneme_id_map": {"^": [1], "$": [2], "_": [0], "k": [10], "a": [11], " ": [3]},
          "inference": {"noise_scale": 0.0, "length_scale": 1.0, "noise_w": 0.0}}


class Session:
    def __init__(self):
        self.feed = None

    def run(self, outputs, feed):
        self.feed = feed
        return [np.asarray([[[.1, -.2, .0, .3]]], np.float32)]


class ExtraModelTests(unittest.TestCase):
    def test_native_lru_releases_evicted_graph_and_reuses_recent_language(self):
        created = []
        class Carrier:
            def __init__(self, code):
                self.code, self.closed = code, False
            def close(self):
                self.closed = True
        def factory(code, models, owner):
            value = Carrier(code)
            created.append(value)
            return value
        extra.clear_engines()
        self.addCleanup(extra.clear_engines)
        with patch.object(extra, "_make_engine", side_effect=factory):
            first = extra._engine("sat", "models")
            recent = extra._engine("st", "models")
            self.assertIs(recent, extra._engine("st", "models"))
            extra._engine("xh", "models")
        self.assertTrue(first.closed)
        self.assertFalse(recent.closed)
        self.assertEqual(3, len(created))
        self.assertEqual(2, len(extra._ENGINES))

    def test_worker_close_releases_only_its_own_optional_models(self):
        from types import SimpleNamespace
        owners = object(), object()
        def factory(code, models, owner):
            result = SimpleNamespace(closed=False)
            result.close = lambda: setattr(result, "closed", True)
            return result
        extra.clear_engines()
        self.addCleanup(extra.clear_engines)
        with patch.object(extra, "_make_engine", side_effect=factory):
            first = extra._engine("sat", "models", owners[0])
            second = extra._engine("st", "models", owners[1])
        extra.clear_engines(owner=owners[0])
        self.assertTrue(first.closed)
        self.assertFalse(second.closed)
        self.assertEqual(1, len(extra._ENGINES))

    def test_custom_santali_phonemizer_and_piper_blanks(self):
        self.assertEqual(extra.phoneme_ids("ᱠᱟ", CONFIG), [1, 10, 0, 11, 0, 2])

    def test_unmapped_input_is_an_error_instead_of_silently_dropped_word(self):
        with self.assertRaisesRegex(ValueError, "Unsupported Santali"):
            extra.phoneme_ids("Ж", CONFIG)

    def test_empty_text_has_no_generated_audio_ids(self):
        self.assertEqual(extra.phoneme_ids("  ", CONFIG), [])

    def test_pinned_single_speaker_export_has_no_sid_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            root.joinpath("config.json").write_text(json.dumps(CONFIG))
            session = Session()
            engine = extra.NativeSantali(root, session_factory=lambda path: session)
            waveform = engine.audio("ᱠᱟ", rate=2.0)
            self.assertEqual(set(session.feed), {"input", "input_lengths", "scales"})
            self.assertAlmostEqual(float(session.feed["scales"][1]), .5)
            self.assertEqual(waveform.dtype, np.float32)
            with self.assertRaisesRegex(ValueError, "symbol names"):
                engine.audio("ᱠ", character=True)

    def test_language_not_advertised_without_real_source_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            models = Path(temporary)
            folder = models / "ExtraLanguages/sat"
            folder.mkdir(parents=True)
            folder.joinpath("config.json").write_text(json.dumps(CONFIG))
            folder.joinpath("model.onnx").write_bytes(b"test only")
            self.assertEqual(extra.available(models), set())
            self.assertEqual(extra.available(models, require_source=False), {"sat"})

    def test_downloader_verifies_git_blob_for_small_files(self):
        import hashlib
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "data.json"
            data = b'{"pinned": true}'
            path.write_bytes(data)
            git = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            record = {"size_bytes": len(data), "git_blob": git, "sha256": None}
            self.assertTrue(prepare.verified(path, record))
            path.write_bytes(b"x" * len(data))
            self.assertFalse(prepare.verified(path, record))

    def test_downloader_verify_only_never_fetches_missing_weights(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "Missing or invalid"):
                prepare.fetch_one("owner/repo", "a" * 40, "model.onnx", {"size_bytes": 1}, Path(temporary) / "model.onnx", verify_only=True)


if __name__ == "__main__":
    unittest.main()
