"""Finite research controls, never native-model or pronunciation proof."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import unicodedata
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("uk_ru_carrier_contract_test", ROOT / "tools/research/uk_ru_shared_contract.py")
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
PROBE_SPEC = importlib.util.spec_from_file_location("uk_ru_carrier_probe_test", ROOT / "tools/research/probe_uk_ru_shared_carrier.py")
probe = importlib.util.module_from_spec(PROBE_SPEC)
PROBE_SPEC.loader.exec_module(probe)
WORDS = ROOT / "tools/research/uk_ru_shared_carrier_words.json"
CAPABILITIES = ROOT / "tools/research/shared_capabilities_original.json"


class Values:
    def __init__(self, values):
        self.values = values
    def reshape(self, *args):
        return self
    def tolist(self):
        return self.values


class LiteralFrontend:
    def _model_character(self, value):
        return value
    def _preprocess_text(self, text, code):
        return "<" + code + ">" + unicodedata.normalize("NFKD", text) + "</" + code + ">"
    def __call__(self, texts, languages):
        text = self._preprocess_text(texts[0], languages[0])
        return Values([ord(c) for c in text]), Values([1] * len(text))


class CarrierInputContracts(unittest.TestCase):
    def test_exact_fixture_has_twenty_unique_alternating_literal_words(self):
        data = m.fixture(WORDS)
        self.assertEqual(len({x["text"] for x in data["cases"]}), 20)
        self.assertEqual([x["language"] for x in data["cases"]], ["uk", "ru"] * 10)
        self.assertEqual(data["profile"], "viktoriia")

    def test_changed_fixture_cannot_reach_model(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.json"
            path.write_bytes(WORDS.read_bytes().replace("їжак".encode(), "ижак".encode()))
            with self.assertRaisesRegex(ValueError, "fixture differs"):
                m.fixture(path)

    def test_exact_packed_capabilities_and_original_ids_support_both_languages(self):
        result = m.support(CAPABILITIES.read_bytes(), list(m.TRAINED_LANGUAGES) + ["na"])
        self.assertEqual(result["packed_language_count"], 31)
        self.assertFalse(result["neutral_na_condition_used"])
        for missing in ("uk", "ru"):
            with self.assertRaises(ValueError):
                m.support(CAPABILITIES.read_bytes(), [x for x in m.TRAINED_LANGUAGES if x != missing])
        with self.assertRaises(ValueError):
            m.support(CAPABILITIES.read_bytes() + b"\n", m.TRAINED_LANGUAGES)

    def test_all_decomposed_letters_and_marks_reach_conditioned_ids_and_mask(self):
        result = m.literal_inputs(LiteralFrontend(), m.fixture(WORDS)["cases"])
        self.assertEqual(len(result), 20)
        row = next(x for x in result if x["source_text"] == "їжак")
        self.assertIn("U+0308", row["nfkd_codepoints"])
        self.assertTrue(row["marked_text"].startswith("<uk>"))
        self.assertEqual(len(row["marked_text"]), len(row["native_input_ids"]))

    def test_dropped_combining_mark_is_fatal_before_inference(self):
        class DropsMark(LiteralFrontend):
            def _model_character(self, value):
                return "" if value == "\u0308" else value
        with self.assertRaisesRegex(ValueError, "drop/change"):
            m.literal_inputs(DropsMark(), [{"id": 1, "language": "uk", "text": "їжак"}])

    def test_inserted_punctuation_or_wrong_language_tag_is_rejected(self):
        class InsertsPeriod(LiteralFrontend):
            def _preprocess_text(self, text, code):
                return super()._preprocess_text(text + ".", code)
        class UsesNeutral(LiteralFrontend):
            def _preprocess_text(self, text, code):
                return super()._preprocess_text(text, "na")
        row = {"id": 1, "language": "uk", "text": "кнопка"}
        for frontend in (InsertsPeriod(), UsesNeutral()):
            with self.assertRaisesRegex(ValueError, "literal word or native condition"):
                m.literal_inputs(frontend, [row])

    def test_locale_alias_or_multitoken_input_is_rejected(self):
        for code, text in (("ru-RU", "окно"), ("na", "окно"), ("uk", "дві назви")):
            with self.assertRaises(ValueError):
                m.literal_inputs(LiteralFrontend(), [{"id": 1, "language": code, "text": text}])

    def test_negative_id_or_masked_text_is_rejected(self):
        class NegativeID(LiteralFrontend):
            def __call__(self, texts, languages):
                ids, mask = super().__call__(texts, languages)
                ids.values[0] = -1
                return ids, mask
        class MissingMask(LiteralFrontend):
            def __call__(self, texts, languages):
                ids, mask = super().__call__(texts, languages)
                mask.values[-1] = 0
                return ids, mask
        row = {"id": 1, "language": "ru", "text": "окно"}
        for frontend in (NegativeID(), MissingMask()):
            with self.assertRaisesRegex(ValueError, "IDs/mask"):
                m.literal_inputs(frontend, [row])

    def test_observed_first_block_and_complete_generation_exclude_saving(self):
        import numpy as np
        closed = []
        def actual_blocks():
            try:
                yield np.asarray([.1, .2], np.float32)
                yield np.asarray([.3], np.float32)
            finally:
                closed.append(True)
        with patch.object(probe.time, "perf_counter", side_effect=[2., 3., 4.]):
            wave, timing = probe.observe_stream(actual_blocks(), 1., np)
        self.assertEqual(len(wave), 3)
        self.assertEqual(timing["first_software_block_seconds"], 1.)
        self.assertEqual(timing["generation_wall_seconds"], 3.)
        self.assertEqual(closed, [True])

    def test_invalid_stream_closes_own_generator_and_never_produces_receipt(self):
        import numpy as np
        closed = []
        def invalid():
            try:
                yield np.asarray([float("nan")], np.float32)
            finally:
                closed.append(True)
        with self.assertRaisesRegex(ValueError, "invalid block"):
            probe.observe_stream(invalid(), 0., np)
        self.assertEqual(closed, [True])

    def test_only_delivery_function_is_extracted_without_running_worker_startup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "nvda_worker.py").write_text("raise RuntimeError('do not start worker')\n"
                "def delivered_audio(source, *args, **kwargs):\n    yield from source\n", encoding="utf-8")
            function, digest = probe.delivery_function(root)
            self.assertEqual(list(function((1, 2))), [1, 2])
            self.assertEqual(len(digest), 64)

    def test_wrong_carrier_recipe_pin_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "probe_ar_ordinary_names.py").write_text("raise RuntimeError('unreviewed source')", encoding="utf-8")
            with patch.object(probe, "__file__", str(root / "probe_uk_ru_shared_carrier.py")):
                with self.assertRaisesRegex(ValueError, "reviewed original carrier"):
                    probe.ar_recipe()

    def test_existing_reviewed_recipe_and_immutable_runtime_pins_match_before_download(self):
        original = probe.ar_recipe()
        self.assertEqual(original.CORE_SHA, probe.CORE_SHA)
        self.assertEqual(original.CORE_BYTES, probe.CORE_BYTES)
        self.assertEqual(original.WIDE_SHA, probe.WIDE_SHA)
        self.assertEqual(original.WIDE_BYTES, probe.WIDE_BYTES)


if __name__ == "__main__":
    unittest.main()
