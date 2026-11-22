"""Resource inventory regressions; these tests do not synthesize or validate audio."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
spec = importlib.util.spec_from_file_location("test_catalog_module", RUNTIME / "language_catalog.py")
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.runtime = Path(self.temporary.name)
        self.models = self.runtime / "models"
        self.models.mkdir()

    def put(self, name, data=b"resource"):
        file = self.models / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)

    def satisfy(self, requirements):
        for name in requirements:
            self.put(name[0] if isinstance(name, tuple) else name)

    def index(self, entries):
        (self.runtime / "wide_voice_index.json").write_text(json.dumps(entries))

    def test_selected_scope_matches_authoritative_file(self):
        selected = json.loads((ROOT / "selected_languages.json").read_text(encoding="utf-8"))["languages"]
        self.assertEqual(135, len(selected))
        self.assertEqual([row["id"] for row in selected], [row["id"] for row in catalog._selected()])

    def test_aliases_do_not_merge_separate_languages(self):
        for source, expected in (("no-NO", "nb"), ("zh_CN", "cmn"), ("iw-IL", "he"),
                                 ("EN_gb", "en"), ("fil", "fil"), ("cnr", "cnr"),
                                 ("zh-yue", "yue"), ("hy-arevmda", "hyw")):
            self.assertEqual(expected, catalog.canonical_code(source))

    def test_empty_models_never_enable_promised_catalog(self):
        self.assertEqual({}, catalog.installed_languages(self.models))
        rows = catalog.coverage(self.models)
        self.assertEqual(135, len(rows))
        self.assertFalse(any(row["windows_audio_verified"] for row in rows))
        self.assertFalse(any(row["resources_present"] for row in rows))

    def test_shared_model_requires_declared_language_and_all_graphs(self):
        self.index({"ar": {"name": "Арабська", "voice": "sem/ar", "source": "wide-sources/ar.npy", "natural": "shared"}})
        _, required = catalog._wide_requirements("ar", {"source": "wide-sources/ar.npy", "natural": "shared"}, self.models)
        self.satisfy(required)
        self.put("WideLanguages/SharedAcoustic/capabilities.json", b'{"languages": ["ko"]}')
        self.assertNotIn("ar", catalog.installed_languages(self.models))
        self.put("WideLanguages/SharedAcoustic/capabilities.json", b'{"languages": ["ar"]}')
        self.assertIn("ar", catalog.installed_languages(self.models))
        (self.models / "OpenVoiceV2/decoder.onnx").unlink()
        self.assertNotIn("ar", catalog.installed_languages(self.models))

    def test_onnx_and_ort_encodings_are_alternatives(self):
        _, required = catalog._core_requirements("en", self.models)
        self.satisfy(required)
        self.assertIn("en", catalog.installed_languages(self.models))
        ort = self.models / "PocketTTS/en/mimi_decoder.ort"
        ort.rename(ort.with_suffix(".onnx"))
        self.assertIn("en", catalog.installed_languages(self.models))

    def test_source_vector_alone_is_not_a_language_engine(self):
        self.index({"nb": {"name": "Норвезька", "voice": "gmq/nb", "source": "wide-sources/nb.npy"}})
        self.put("WideLanguages/wide-sources/nb.npy")
        self.assertNotIn("nb", catalog.installed_languages(self.models))
        _, required = catalog._wide_requirements("nb", {"voice": "gmq/nb", "source": "wide-sources/nb.npy"}, self.models)
        self.satisfy(required)
        languages = catalog.installed_languages(self.models)
        self.assertIn("nb", languages)
        self.assertNotIn("no", languages)
        (self.models / "WideLanguages/espeak-ng-data/lang/gmq/nb").unlink()
        self.assertNotIn("nb", catalog.installed_languages(self.models))

    def test_unselected_language_is_opt_in_inventory_only(self):
        self.index({"eo": {"name": "Есперанто", "voice": "art/eo", "source": "wide-sources/eo.npy"}})
        _, required = catalog._wide_requirements("eo", {"voice": "art/eo", "source": "wide-sources/eo.npy"}, self.models)
        self.satisfy(required)
        self.assertNotIn("eo", catalog.installed_languages(self.models))
        self.assertIn("eo", catalog.installed_languages(self.models, selected_only=False))

    def test_resource_paths_cannot_escape_models(self):
        outside = self.runtime / "outside.npy"
        outside.write_bytes(b"outside")
        self.index({"nb": {"voice": "gmq/nb", "source": "../../outside.npy"}})
        self.satisfy(catalog.CONVERSION + catalog.ESPEAK + ("WideLanguages/espeak-ng-data/lang/gmq/nb",))
        self.assertFalse(catalog.language_status(self.models, "nb")["resources_present"])
        self.assertFalse(catalog._present(self.models, "../outside.npy"))

    def test_compatibility_rejects_removed_voice_and_absent_profiles(self):
        self.satisfy(catalog.HOLOS)
        self.put("voices/holos/sara_archive.npy")
        self.put("voices/holos/kostia.npy")
        self.assertEqual(("sara_archive",), catalog.compatible_voice_ids(
            self.models, "uk-UA", ("kostia", "sara_archive", "missing", "../outside")))
        self.assertEqual((), catalog.compatible_voice_ids(self.models, "ito", ("sara_archive",)))

    def test_pocket_voice_needs_delivery_entry_and_correct_profile_type(self):
        self.satisfy(catalog._core_requirements("en", self.models)[1])
        self.put("voices/native_profiles/delivery.json", b'{"sara_archive": {}}')
        self.put("voices/native_profiles/sara_archive.safetensors")
        self.assertEqual((), catalog.compatible_voice_ids(self.models, "en", ("sara_archive",)))
        self.put("voices/native_profiles/sara_archive.npz")
        self.assertEqual(("sara_archive",), catalog.compatible_voice_ids(self.models, "en", ("sara_archive",)))


if __name__ == "__main__":
    unittest.main()
