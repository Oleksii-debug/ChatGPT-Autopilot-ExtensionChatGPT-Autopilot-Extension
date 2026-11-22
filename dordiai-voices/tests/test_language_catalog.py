"""Resource inventory regressions; these tests do not synthesize or validate audio."""
import importlib.util
import json
from pathlib import Path
import struct
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

    def npy(self, relative, dtype, shape, raw):
        header = repr({"descr": dtype, "fortran_order": False, "shape": shape}).encode("latin-1")
        header += b" " * ((64 - (10 + len(header) + 1) % 64) % 64) + b"\n"
        self.put(relative, b"\x93NUMPY\x01\x00" + struct.pack("<H", len(header)) + header + raw)

    def identity(self, relative, value=0.25):
        self.npy(relative, "<f4", (1, 256, 1), struct.pack("<256f", *([value] * 256)))

    def mms(self, code="ha", iso="hau"):
        info = {"name": code, "backend": "mms-onnx", "iso_code": iso,
                "source": "MMS/" + code + "/source.npy"}
        self.index({code: info})
        self.satisfy(catalog._wide_requirements(code, info, self.models)[1])
        self.put("MMS/" + code + "/config.json", json.dumps({"format": "dordiai-mms-onnx-v1", "code": code,
            "iso_code": iso, "frontend": "characters", "is_uroman": False}).encode())
        self.identity("MMS/" + code + "/source.npy")

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

    def test_mms_requires_real_conditioning_vector_and_matching_native_frontend(self):
        self.mms()
        self.assertIn("ha", catalog.installed_languages(self.models))
        status = catalog.language_status(self.models, "ha")
        self.assertEqual("mms-neural+voice-conversion", status["backend"])
        self.assertFalse(status["capabilities"]["character_names"])
        self.identity("MMS/ha/source.npy", float("nan"))
        self.assertNotIn("ha", catalog.installed_languages(self.models))
        self.identity("MMS/ha/source.npy")
        config = self.models / "MMS/ha/config.json"
        data = json.loads(config.read_text())
        data["iso_code"] = "yor"
        config.write_text(json.dumps(data))
        self.assertNotIn("ha", catalog.installed_languages(self.models))

    def test_mms_rejects_uroman_adapter_and_missing_notice(self):
        self.mms()
        config = self.models / "MMS/ha/config.json"
        data = json.loads(config.read_text())
        data["is_uroman"] = True
        config.write_text(json.dumps(data))
        self.assertNotIn("ha", catalog.installed_languages(self.models))
        data["is_uroman"] = False
        config.write_text(json.dumps(data))
        (self.models / "MMS/ha/NOTICE.txt").unlink()
        self.assertNotIn("ha", catalog.installed_languages(self.models))

    def test_santali_requires_its_phoneme_map_and_actual_source_identity(self):
        info = {"backend": "extra-onnx", "source": "ExtraLanguages/sat/source.npy"}
        self.index({"sat": info})
        self.satisfy(catalog._wide_requirements("sat", info, self.models)[1])
        self.identity("ExtraLanguages/sat/source.npy")
        self.put("ExtraLanguages/sat/config.json", b'{"phoneme_id_map": {"^": [1], "_": [0], "$": [2]}}')
        self.assertIn("sat", catalog.installed_languages(self.models))
        self.put("ExtraLanguages/sat/source.npy", b"not-a-reference-vector")
        self.assertNotIn("sat", catalog.installed_languages(self.models))

    def test_kabyle_is_explicit_partial_group_variant_not_moroccan_standard(self):
        self.mms("kab", "kab")
        languages = catalog.installed_languages(self.models)
        self.assertTrue(languages["kab"].startswith("Кабільська (берберська; Алжир)"))
        self.assertIn("лише текст", languages["kab"])
        self.assertNotIn("tamazight", languages)
        self.assertNotIn("zgh", languages)
        status = catalog.language_status(self.models, "tamazight")
        self.assertEqual("kab", status["runtime_code"])
        self.assertTrue(status["partial_variant"])
        self.assertEqual("partial-variant-resources-present-unverified", status["status"])
        self.assertEqual("tamazight", catalog.canonical_code("tamazight"))

    def test_omni_requires_valid_codes_and_transcript_without_reference_encoder(self):
        info = {"backend": "omni-onnx", "source": "SharedOmniONNX/references/rm/source.npy"}
        self.index({"rm": info})
        self.satisfy(catalog._wide_requirements("rm", info, self.models)[1])
        self.identity("SharedOmniONNX/references/rm/source.npy")
        relative = "SharedOmniONNX/references/rm/codes.npy"
        self.npy(relative, "<i8", (8, 2), struct.pack("<16q", *range(16)))
        self.put("SharedOmniONNX/references/rm/text.txt", b"Bun di.")
        self.assertIn("rm", catalog.installed_languages(self.models))
        self.assertIn("повільне читання", catalog.installed_languages(self.models)["rm"])
        self.assertFalse(catalog.language_status(self.models, "rm")["character_names_ready"])
        self.assertFalse(catalog.language_status(self.models, "rm")["capabilities"]["interactive_nvda_latency_verified"])
        self.npy(relative, "<i8", (8, 2), struct.pack("<16q", *([1024] * 16)))
        self.assertNotIn("rm", catalog.installed_languages(self.models))
        self.npy(relative, "<i8", (8, 2), struct.pack("<16q", *range(16)))
        self.put("SharedOmniONNX/references/rm/text.txt", b"<|reserved|>")
        self.assertNotIn("rm", catalog.installed_languages(self.models))

    def test_unknown_omni_language_cannot_be_enabled_by_generic_graphs(self):
        self.index({"ito": {"backend": "omni-onnx", "source": "SharedOmniONNX/references/ito/source.npy"}})
        self.assertNotIn("ito", catalog.installed_languages(self.models))

    def test_simba_config_cannot_mislabel_another_language_as_sesotho(self):
        info = {"backend": "extra-onnx", "source": "ExtraLanguages/st/source.npy"}
        self.index({"st": info})
        self.satisfy(catalog._wide_requirements("st", info, self.models)[1])
        self.identity("ExtraLanguages/st/source.npy")
        self.put("ExtraLanguages/st/upstream-vocab.json", b'{"h": 0}')
        self.put("ExtraLanguages/st/upstream-tokenizer_config.json", b'{"pad_token": "h", "add_blank": true, "phonemize": false, "is_uroman": false}')
        runtime = {"format": "dordiai-simba-onnx-v1", "code": "xh", "iso_code": "xho", "sample_rate": 16000, "frontend": "transformers-vits-graphemes"}
        self.put("ExtraLanguages/st/runtime_config.json", json.dumps(runtime).encode())
        self.assertNotIn("st", catalog.installed_languages(self.models))
        runtime.update(code="st", iso_code="sot")
        self.put("ExtraLanguages/st/runtime_config.json", json.dumps(runtime).encode())
        self.assertIn("st", catalog.installed_languages(self.models))

    def test_coqui_requires_native_config_language_and_real_blank_token(self):
        info = {"backend": "extra-onnx", "source": "ExtraLanguages/ig/source.npy"}
        self.index({"ig": info})
        self.satisfy(catalog._wide_requirements("ig", info, self.models)[1])
        self.identity("ExtraLanguages/ig/source.npy")
        self.put("ExtraLanguages/ig/runtime_config.json", b'{"format": "dordiai-coqui-onnx-v1", "code": "ig", "iso_code": "ibo", "sample_rate": 22050}')
        config = {"engine": "coqui", "lang_code": "ln", "audio": {"sample_rate": 22050}, "blank": "<BLNK>", "phoneme_id_map": {"<BLNK>": 3}}
        self.put("ExtraLanguages/ig/config.json", json.dumps(config).encode())
        self.assertNotIn("ig", catalog.installed_languages(self.models))
        config["lang_code"] = "ig"
        self.put("ExtraLanguages/ig/config.json", json.dumps(config).encode())
        self.assertIn("ig", catalog.installed_languages(self.models))


if __name__ == "__main__":
    unittest.main()
