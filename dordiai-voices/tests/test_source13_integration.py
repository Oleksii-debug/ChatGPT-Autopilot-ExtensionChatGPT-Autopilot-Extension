"""Core13 must retain the exact immutable12 resource and identity inventory."""
import copy
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("source13_builder_test", ROOT / "tools/research/source13_integration.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def inventories():
    profiles = ["profile" + str(index) for index in range(45)]
    files = {}
    for index in range(180):
        files[builder.BANK_PREFIXES[index % 2] + str(index)] = {"sha256": "a" * 64, "size_bytes": index + 1}
    for index in range(1596):
        files[builder.PRIVATE_PREFIX + str(index)] = {"sha256": "b" * 64, "size_bytes": index + 1}
    files.update({
        "kx47Runtime/models/WordLanguage/native-word-membership.bin":
            {"sha256": builder.BINARY_SHA256, "size_bytes": builder.BINARY_SIZE},
        "kx47Runtime/models/WordLanguage/native-word-membership.json":
            {"sha256": builder.DESCRIPTOR_SHA256, "size_bytes": builder.DESCRIPTOR_SIZE},
        "kx47Runtime/models/WordLanguage/native-word-membership.NOTICE.json":
            {"sha256": "c" * 64, "size_bytes": 100},
        "kx47Runtime/models/voices/allowed.npy": {"sha256": "d" * 64, "size_bytes": 1152},
        "kx47Runtime/models/OpenVoiceV2/decoder.onnx": {"sha256": "e" * 64, "size_bytes": 1000},
    })
    for code in ("ay", "fil", "ar"):
        files["kx47Runtime/models/CharacterNames/" + code + ".json"] = {"sha256": "f" * 64, "size_bytes": 512}
    missing = 8510 - sum(name.startswith(builder.IMMUTABLE_MODELS) for name in files)
    for index in range(missing):
        files[builder.IMMUTABLE_MODELS + "fixture/" + str(index)] = {"sha256": "9" * 64, "size_bytes": index + 1}
    old = {"version": "0.13.1-dev.12", "voice_ids": profiles, "files": files}
    new = copy.deepcopy(old)
    new["version"] = "0.13.1-dev.13"
    return old, new


class PreservationTests(unittest.TestCase):
    def setUp(self):
        self.old, self.new = inventories()

    def test_exact_resources_and_all45_identities_pass_with_explicit_counts(self):
        proof = builder.verify_preservation(self.old, self.new)
        self.assertEqual(proof["existing_prepared_bank_files_byte_identical"], 180)
        self.assertEqual(proof["existing_private_files_byte_identical"], 1596)
        self.assertEqual(proof["existing_model_identity_files_byte_identical"], 8510)
        self.assertTrue(proof["character_name_payloads_byte_identical"])
        self.assertTrue(proof["native_membership_data_descriptor_notice_byte_identical"])

    def test_new_driver_code_can_change_without_altering_resources(self):
        self.new["files"]["synthDrivers/kx47Preview.py"] = {"sha256": "1" * 64, "size_bytes": 1500}
        self.new["files"]["kx47Runtime/language_origin.py"] = {"sha256": "2" * 64, "size_bytes": 500}
        self.assertTrue(builder.verify_preservation(self.old, self.new)["allowed_voice_identity_set_unchanged"])

    def test_mutated_or_missing_prepared_audio_is_rejected(self):
        for remove in (False, True):
            old, new = inventories()
            key = next(name for name in old["files"] if name.startswith(builder.BANK_PREFIXES))
            if remove:
                del new["files"][key]
            else:
                new["files"][key]["sha256"] = "0" * 64
            with self.subTest(remove=remove), self.assertRaisesRegex(ValueError, "prepared bank"):
                builder.verify_preservation(old, new)

    def test_mutated_private_runtime_package_or_dll_is_rejected(self):
        key = next(name for name in self.old["files"] if name.startswith(builder.PRIVATE_PREFIX))
        self.new["files"][key]["size_bytes"] += 1
        with self.assertRaisesRegex(ValueError, "private runtime"):
            builder.verify_preservation(self.old, self.new)

    def test_mutated_acoustic_graph_or_voice_identity_is_rejected(self):
        for key in ("kx47Runtime/models/OpenVoiceV2/decoder.onnx", "kx47Runtime/models/voices/allowed.npy"):
            old, new = inventories()
            new["files"][key]["sha256"] = "0" * 64
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "model/identity"):
                builder.verify_preservation(old, new)

    def test_unreviewed_new_model_payload_is_not_an_implicit_exception(self):
        self.new["files"]["kx47Runtime/models/new-model.onnx"] = {"sha256": "1" * 64, "size_bytes": 100}
        with self.assertRaisesRegex(ValueError, "Unreviewed new model"):
            builder.verify_preservation(self.old, self.new)

    def test_new_private_package_cannot_be_silently_added(self):
        self.new["files"]["kx47Runtime/python/Lib/site-packages/new-package.py"] = {"sha256": "1" * 64, "size_bytes": 100}
        with self.assertRaisesRegex(ValueError, "New private runtime"):
            builder.verify_preservation(self.old, self.new)

    def test_dataset_descriptor_and_source_notice_cannot_be_replaced(self):
        for suffix in ("bin", "json", "NOTICE.json"):
            old, new = inventories()
            key = "kx47Runtime/models/WordLanguage/native-word-membership." + suffix
            new["files"][key]["sha256"] = "0" * 64
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                builder.verify_preservation(old, new)

    def test_wrong_trusted_dictionary_in_both_manifests_still_fails(self):
        key = "kx47Runtime/models/WordLanguage/native-word-membership.bin"
        self.old["files"][key]["sha256"] = "0" * 64
        self.new["files"][key]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "dictionary/descriptor"):
            builder.verify_preservation(self.old, self.new)

    def test_identity_set_and_duplicate_profile_changes_fail(self):
        for replacement in ("new-profile", self.old["voice_ids"][0]):
            old, new = inventories()
            new["voice_ids"][-1] = replacement
            with self.subTest(replacement=replacement), self.assertRaisesRegex(ValueError, "identity set"):
                builder.verify_preservation(old, new)

    def test_wrong_baseline_or_output_version_is_rejected(self):
        for target, version in (("old", "0.13.1-dev.10"), ("new", "0.13.1-dev.12")):
            old, new = inventories()
            (old if target == "old" else new)["version"] = version
            with self.subTest(target=target), self.assertRaises(ValueError):
                builder.verify_preservation(old, new)

    def test_incomplete_original_bank_or_private_inventory_is_rejected(self):
        for prefix in (builder.BANK_PREFIXES, builder.PRIVATE_PREFIX):
            old, new = inventories()
            key = next(name for name in old["files"] if name.startswith(prefix))
            del old["files"][key]
            del new["files"][key]
            with self.subTest(prefix=prefix), self.assertRaisesRegex(ValueError, "bank/private"):
                builder.verify_preservation(old, new)


class Exact13BaselineTests(unittest.TestCase):
    def test_old_or_duplicate_source_manifest_cannot_be_dispatched_as13(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = root / "manifest.ini"
            for text in ('version = "0.13.1-dev.12"\n', 'version = "0.13.1-dev.13"\nversion = "0.13.1-dev.13"\n'):
                manifest.write_text(text, encoding="utf-8")
                with self.subTest(text=text), self.assertRaisesRegex(ValueError, "reviewed13"):
                    builder.check_source_version(root)
            manifest.write_text('name = "kx47Voices"\nversion = "0.13.1-dev.13"\n', encoding="utf-8")
            self.assertEqual(builder.check_source_version(root), builder.VERSION)

    def test_source12_archive_and_run_pins_are_not_historical11(self):
        self.assertEqual(builder.CORE12_SIZE, 1992944744)
        self.assertEqual(builder.CORE12_SHA256, "908a9825a8f3e1574d9d0a370ac0e35e1e1683eb04b998a937c312f0ce3ec573")
        self.assertEqual(builder.CORE12_RUN, 45040668513)
        self.assertEqual(builder.VERSION, "0.13.1-dev.13")

    def test_all_character_name_payloads_stay_immutable_without_a_reviewed_exception(self):
        for code in ("ay", "fil", "ar"):
            old, new = inventories()
            new["files"]["kx47Runtime/models/CharacterNames/" + code + ".json"]["sha256"] = "0" * 64
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, "model/identity"):
                builder.verify_preservation(old, new)

    def test_missing_original_model_inventory_is_not_hidden_by_matching_output(self):
        old, new = inventories()
        key = builder.IMMUTABLE_MODELS + "fixture/0"
        del old["files"][key]
        del new["files"][key]
        with self.assertRaisesRegex(ValueError, "complete immutable source12"):
            builder.verify_preservation(old, new)

    def test_same_worker225_recipe_preserves_all_five_native_languages_and_exact_six_packs(self):
        self.assertEqual(set(builder.WORDS), {"ss", "ve", "zu", "wo", "nso"})
        self.assertEqual(len(builder.PACKS), 6)
        self.assertEqual(len(builder.WORDS) * 45, 225)

if __name__ == "__main__":
    unittest.main()
