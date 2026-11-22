"""Character probe names and renderer checks; no acoustic/Windows acceptance."""
import copy
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
SPEC = importlib.util.spec_from_file_location("windows_character_probe_test", ROOT / "tools/windows_character_probe.py")
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class CharacterProbeTests(unittest.TestCase):
    def runtime(self, folder, code, symbols):
        runtime = Path(folder)
        shutil.copyfile(RUNTIME / "character_names.py", runtime / "character_names.py")
        directory = runtime / "models/CharacterNames"
        directory.mkdir(parents=True)
        (directory / (code + ".json")).write_text(json.dumps({
            "format": "dordiai-character-name-sources", "format_version": 1, "language": code,
            "symbol_names": symbols, "letter_names": {}, "sources": {},
        }, ensure_ascii=False), encoding="utf-8")
        return runtime

    def test_installed_same_language_name_is_used_before_probe_annotation(self):
        with tempfile.TemporaryDirectory() as folder:
            runtime = self.runtime(folder, "uk", {"😀": "українська назва"})
            result = probe.resolve_case(runtime, {"language": "uk", "glyph": "😀", "resolver": "pinned-cldr-probe-name"})
        self.assertEqual(result["text"], "українська назва")
        self.assertFalse(result["production_mapping_gap"])
        self.assertFalse(result["raw_glyph_resolution_verified"])

    def test_missing_production_emoji_mapping_is_explicit_probe_only_gap(self):
        with tempfile.TemporaryDirectory() as folder:
            runtime = self.runtime(folder, "uk", {})
            result = probe.resolve_case(runtime, {"language": "uk", "glyph": "😀", "resolver": "pinned-cldr-probe-name"})
        self.assertEqual(result["text"], "широко всміхнене обличчя")
        self.assertIn("Probe annotation only", result["production_mapping_gap"])
        self.assertNotEqual(result["text"], "grinning face")
        self.assertFalse(result["raw_glyph_resolution_verified"])

    def test_missing_locale_name_never_borrows_english(self):
        with tempfile.TemporaryDirectory() as folder:
            runtime = self.runtime(folder, "en", {"😀": "grinning face"})
            with self.assertRaises(LookupError):
                probe.resolve_case(runtime, {"language": "fr", "glyph": "😀", "resolver": "pinned-cldr-probe-name"})

    def test_accented_letter_uses_the_installed_project_mapping(self):
        resolved = probe.resolve_case(RUNTIME, {"language": "de", "glyph": "ä", "resolver": "project-latin-name"})
        self.assertEqual(resolved["text"], "a Umlaut")
        self.assertTrue(resolved["character"])

    def test_native_bmp_path_does_not_accept_supplementary_glyph(self):
        with self.assertRaises(ValueError):
            probe.resolve_case(RUNTIME, {"language": "nb", "glyph": "😀", "resolver": "native-raw-bmp"})

    def test_renderer_and_selected_voice_must_both_match(self):
        correct = {"renderers": [{"engine": "native-locale:fr", "profile": "sara", "speaker": "sara"}]}
        self.assertTrue(probe.renderer_matches(correct, "fr", "sara"))
        for key, value in (("engine", "baseline"), ("speaker", "other"), ("profile", "other")):
            wrong = copy.deepcopy(correct)
            wrong["renderers"][0][key] = value
            self.assertFalse(probe.renderer_matches(wrong, "fr", "sara"))

    @unittest.skipIf(probe.os.name == "nt", "Non-Windows guard only")
    def test_non_windows_cannot_claim_typing_or_acoustic_acceptance(self):
        with tempfile.TemporaryDirectory() as folder, redirect_stdout(io.StringIO()), patch.object(probe, "load_file") as load:
            code = probe.main(["--package-root", "absent", "--output", folder])
            result = json.loads((Path(folder) / "report.json").read_text(encoding="utf-8"))
            load.assert_not_called()
        self.assertEqual(code, 2)
        self.assertEqual(result["status"], "blocked")
        self.assertFalse(result["nvda_typing_verified"])
        self.assertFalse(result["physical_audio_verified"])
        self.assertFalse(result["product_ready"])


if __name__ == "__main__":
    unittest.main()
