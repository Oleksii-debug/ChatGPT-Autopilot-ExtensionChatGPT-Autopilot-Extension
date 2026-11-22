import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import build_resource_pack as builder


class GenericResourcePackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "model.onnx").write_bytes(b"prepared model")
        (self.source / "lexicon.json").write_text('{"inna":"a language word"}')
        self.options = dict(prefix="kx47Runtime/models/Optional/demo", identity="language-demo", name="Demo",
                            languages=["uk"], engine_ids=["prepared-test-adapter"])

    def test_generic_pack_roundtrip_without_per_language_code(self):
        archive = self.root / "language.zip"
        result = builder.create_resource_pack(self.source, archive, **self.options)
        second = self.root / "language-again.zip"
        self.assertEqual(result["sha256"], builder.create_resource_pack(self.source, second, **self.options)["sha256"])
        addon = self.root / "addon"
        addon.mkdir()
        (addon / "manifest.ini").write_text('version = "' + builder.VERSION + '"\n')
        builder.manager.install_pack(archive, addon)
        self.assertEqual((addon / self.options["prefix"] / "lexicon.json").read_text(), '{"inna":"a language word"}')
        builder.manager.uninstall_pack("language-demo", addon)

    def test_bad_destination_and_executable_script_rejected(self):
        for prefix in ["../outside", "kx47Runtime/models/../outside", "kx47Runtime/models/voices/inna"]:
            with self.subTest(prefix=prefix), self.assertRaises(ValueError):
                builder.create_resource_pack(self.source, self.root / "bad.zip", **dict(self.options, prefix=prefix))
        (self.source / "adapter.py").write_text("code must ship with the core")
        with self.assertRaises(ValueError):
            builder.create_resource_pack(self.source, self.root / "bad.zip", **self.options)

    def test_output_cannot_be_included_in_its_own_payload(self):
        with self.assertRaises(ValueError):
            builder.create_resource_pack(self.source, self.source / "archive.zip", **self.options)

    def test_provenance_metadata_preserved_but_cannot_override_files(self):
        archive = self.root / "language.zip"
        builder.create_resource_pack(self.source, archive, **self.options,
                                     metadata_extra={"experimental": True, "license": "CC0-1.0"})
        metadata = builder.manager.inspect_pack(archive)
        self.assertTrue(metadata["experimental"])
        self.assertEqual(metadata["license"], "CC0-1.0")
        with self.assertRaises(ValueError):
            builder.create_resource_pack(self.source, self.root / "bad.zip", **self.options, metadata_extra={"files": {}})

    def test_exact_dependency_metadata_is_preserved_and_validated(self):
        archive = self.root / "reference.zip"
        builder.create_resource_pack(self.source, archive, **self.options,
                                     dependencies=["shared"], dependency_versions={"shared": "1.0.0"})
        metadata = builder.manager.inspect_pack(archive)
        self.assertEqual(metadata["dependency_versions"], {"shared": "1.0.0"})
        with self.assertRaises(ValueError):
            builder.create_resource_pack(self.source, self.root / "bad.zip", **self.options,
                                         dependency_versions={"not-declared": "1.0.0"})


if __name__ == "__main__":
    unittest.main()
