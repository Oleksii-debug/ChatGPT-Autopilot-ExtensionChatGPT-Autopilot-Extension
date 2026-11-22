"""Core12 must retain the exact immutable11 resource and identity inventory."""
import copy
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("source12_builder_test", ROOT / "tools/research/source12_integration.py")
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
    old = {"version": "0.13.1-dev.11", "voice_ids": profiles, "files": files}
    new = copy.deepcopy(old)
    new["version"] = "0.13.1-dev.12"
    return old, new


class PreservationTests(unittest.TestCase):
    def setUp(self):
        self.old, self.new = inventories()

    def test_exact_resources_and_all45_identities_pass_with_explicit_counts(self):
        proof = builder.verify_preservation(self.old, self.new)
        self.assertEqual(proof["existing_prepared_bank_files_byte_identical"], 180)
        self.assertEqual(proof["existing_private_files_byte_identical"], 1596)
        self.assertEqual(proof["existing_model_identity_files_byte_identical"], 185)
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

    def test_only_two_exact_pinned_character_payloads_may_differ_or_be_added(self):
        approved = {name: {"sha256": "1" * 64, "size_bytes": 100} for name in builder.CHARACTER_NAME_PATHS}
        self.new["files"].update(copy.deepcopy(approved))
        self.assertEqual(builder.verify_preservation(self.old, self.new, approved)["reviewed_character_name_payloads"], approved)
        key = next(iter(approved))
        self.new["files"][key]["size_bytes"] += 1
        with self.assertRaisesRegex(ValueError, "reviewed character-name"):
            builder.verify_preservation(self.old, self.new, approved)

    def test_broad_or_single_character_exception_cannot_bypass_model_preservation(self):
        for names in (list(builder.CHARACTER_NAME_PATHS)[:1], list(builder.CHARACTER_NAME_PATHS) + ["kx47Runtime/models/voices/allowed.npy"]):
            approved = {name: {"sha256": "1" * 64, "size_bytes": 100} for name in names}
            with self.subTest(names=names), self.assertRaisesRegex(ValueError, "No model exception"):
                builder.verify_preservation(self.old, self.new, approved)

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
        for target, version in (("old", "0.13.1-dev.10"), ("new", "0.13.1-dev.11")):
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


class CharacterReviewTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.pin = self.root / "review.json"
        self.records = {}
        self.docs = {}
        for code, (count, primary_sha) in builder.CHARACTER_NAME_SOURCES.items():
            repertoire = ["glyph" + str(index) for index in range(count)]
            primary = {"sha256": primary_sha} if code == "fil" else {
                "sha256": "a" * 64, "primary_corroboration": {"sha256": primary_sha}}
            self.docs[code] = {"format": "dordiai-character-name-sources", "format_version": 1,
                "language": code, "ordinary_alphabet_source_complete": True,
                "ordinary_alphabet_source_repertoire": repertoire,
                "letter_names": {glyph: "native-name" for glyph in repertoire},
                "sources": {"curated_primary_alphabet_names": primary},
                "letter_names_ready": False, "semantics": {"native_pronunciation_verified": False}}
        self.write()

    def write(self):
        for code, value in self.docs.items():
            name = "kx47Runtime/models/CharacterNames/" + code + ".json"
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            raw = (json.dumps(value) + "\n").encode()
            target.write_bytes(raw)
            count, source_sha = builder.CHARACTER_NAME_SOURCES[code]
            self.records[name] = {"sha256": sha256(raw).hexdigest(), "size_bytes": len(raw),
                "source_repertoire_count": count, "primary_source_sha256": source_sha}
        self.pin.write_text(json.dumps({"format": "dordiai-source12-character-name-review", "format_version": 1,
            "files": self.records}))

    def test_actual_file_sha_counts_and_distinct_primary_source_locations_are_checked(self):
        approved = builder.character_name_review(self.root, self.pin)
        self.assertEqual(set(approved), builder.CHARACTER_NAME_PATHS)
        self.assertEqual(approved[next(iter(approved))].keys(), {"sha256", "size_bytes"})

    def test_after_review_file_change_is_rejected_before_build(self):
        target = self.root / next(iter(self.records))
        target.write_bytes(target.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "size/SHA"):
            builder.character_name_review(self.root, self.pin)

    def test_wrong_repertoire_or_primary_source_fails_even_with_refreshed_payload_hash(self):
        for defect in ("repertoire", "source"):
            code = "ay"
            original = copy.deepcopy(self.docs[code])
            if defect == "repertoire":
                self.docs[code]["ordinary_alphabet_source_repertoire"].pop()
            else:
                self.docs[code]["sources"]["curated_primary_alphabet_names"]["primary_corroboration"]["sha256"] = "0" * 64
            self.write()
            with self.subTest(defect=defect), self.assertRaisesRegex(ValueError, "facts/counts/source"):
                builder.character_name_review(self.root, self.pin)
            self.docs[code] = original

    def test_false_quality_promotion_is_rejected_even_when_byte_pin_matches(self):
        self.docs["fil"]["semantics"]["native_pronunciation_verified"] = True
        self.write()
        with self.assertRaisesRegex(ValueError, "acceptance flags"):
            builder.character_name_review(self.root, self.pin)


if __name__ == "__main__":
    unittest.main()
