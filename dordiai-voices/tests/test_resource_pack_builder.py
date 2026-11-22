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
        (addon / "manifest.ini").write_text('version = "0.13.0-dev.1"\n')
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


if __name__ == "__main__":
    unittest.main()
