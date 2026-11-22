"""Controller hook routing/rate/source invalidation without speech models."""
import importlib.util
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "source/0.12.2/kx47Runtime"
CANDIDATE = ROOT / "candidates/afri-six/wide_voice.py"
sys.path.insert(0, str(SOURCE))


class AfriControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        shutil.copyfile(CANDIDATE, self.folder / "wide_voice.py")
        (self.folder / "wide_voice_index.json").write_text('{"ss":{"backend":"afri-six-onnx","source":"SharedAfriSixONNX/references/ss/source.npy"}}')
        spec = importlib.util.spec_from_file_location("afri_controller_hook_test", self.folder / "wide_voice.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.owner = SimpleNamespace(check_cancelled=lambda: None, flow=object(), decoder=object(),
                                     target_profile=lambda profile: np.ones((1, 256, 1), np.float32),
                                     levelled=lambda blocks: blocks, _session=lambda path: None)
        self.controller = self.module.WideVoices(self.folder / "models", self.folder / "references",
                                                 converter=self.owner,mms_cache_budget_bytes=0)
        self.controller._backend_info = lambda code, text=None, character=False: self.controller.registry[code]
        self.controller._ensure_headroom = lambda amount: None
        self.source_value = np.ones((1, 256, 1), np.float32)
        self.sources, self.calls, self.tempos, self.cleared = [], [], [], []
        def source(code, *, models):
            self.sources.append(code)
            return self.source_value
        def audio(code, text, character=False, **kwargs):
            self.calls.append((code, kwargs))
            return np.full(1024, .1, np.float32), 24000
        self.backend = SimpleNamespace(source=source, available=lambda models: {"ss"}, audio=audio,
                                       clear_engines=lambda **kwargs: self.cleared.append(kwargs))
        self.context = patch.dict(sys.modules, {"wide_afri_six": self.backend})
        self.context.start()
        self.module.resample = lambda audio, before, after: audio.copy()
        self.module.stream_resample = lambda blocks, before, after: blocks
        self.module.compact_padding = lambda blocks, text: blocks
        def tempo(blocks, rate, factor):
            self.tempos.append(factor)
            return blocks
        self.module.stream_tempo = tempo
        self.projected_sources = []
        def converted(audio, source, target, tempo=1., character=False):
            self.projected_sources.append(source.copy())
            yield audio
        self.controller.converted = converted
    def tearDown(self):
        self.controller.close()
        self.context.stop()
        self.temp.cleanup()

    def test_native_rate_is_not_applied_twice_and_owned_backend_is_closed(self):
        result = list(self.controller.blocks("viktoriia", "ss", "native text", speed=2.))
        self.assertTrue(result)
        self.assertEqual(self.calls[0][1]["rate"], 1.)
        self.assertIs(self.calls[0][1]["owner"], self.owner)
        self.assertIs(self.calls[0][1]["session_factory"], self.owner._session)
        self.assertEqual(self.tempos[-1], 2.)  # complete user rate, not speed/1.85
        self.controller.close()
        self.assertEqual(len(self.cleared), 1)
        self.assertIs(self.cleared[0]["owner"], self.owner)

    def test_source_replacement_is_not_hidden_by_language_only_source_cache(self):
        list(self.controller.blocks("viktoriia", "ss", "first"))
        self.source_value = np.full((1, 256, 1), 2, np.float32)
        list(self.controller.blocks("viktoriia", "ss", "second"))
        self.assertEqual(self.sources, ["ss", "ss"])
        self.assertTrue(np.all(self.projected_sources[0] == 1))
        self.assertTrue(np.all(self.projected_sources[1] == 2))

    def test_missing_native_pack_never_falls_through_to_another_language(self):
        self.backend.available = lambda models: set()
        with self.assertRaisesRegex(ValueError, "Required native language resources"):
            list(self.controller.blocks("viktoriia", "ss", "native text"))
        self.assertFalse(self.calls)
        self.assertFalse(self.projected_sources)


if __name__ == "__main__":
    unittest.main()
