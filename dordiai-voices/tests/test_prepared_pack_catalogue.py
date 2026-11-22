import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import build_prepared_model_packs as prepared
from build_resource_pack import create_resource_pack


class PreparedCatalogueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "evidence").mkdir()
        self.output = self.root / "dist/language-packs"
        source = self.root / "source"
        source.mkdir()
        (source / "model.onnx").write_bytes(b"actual prepared fixture")
        self.records = []
        for identity, minimum in [("primary", "0.13.1-dev.2"), ("alternate", "0.13.1-dev.1")]:
            record = create_resource_pack(source, self.output / (identity + ".zip"),
                prefix="kx47Runtime/models/" + identity, identity=identity, name=identity,
                minimum_core_version=minimum, languages=["ks"], engine_ids=["test"],
                metadata_extra={"experimental": True})
            record.update(id=identity)
            self.records.append(record)
        self.records[1]["distributable_catalogue_entry"] = False
        self.save()

    def save(self):
        (self.root / "evidence/new_resource_pack_summary.json").write_text(
            json.dumps({"groups": {"native": {"packages": self.records}}}), encoding="utf-8")

    def test_actual_manifest_version_and_inactive_alternate(self):
        catalogue = prepared.write_catalogue(self.root)
        self.assertEqual(catalogue["entry_count"], 1)
        self.assertEqual(catalogue["entries"][0]["minimum_core_version"], "0.13.1-dev.2")
        self.assertEqual(catalogue["inactive_research_archives"], ["alternate.zip"])
        self.assertFalse(catalogue["published"])

    def test_stale_checksum_rejected(self):
        self.records[0]["sha256"] = "0" * 64
        self.save()
        with self.assertRaisesRegex(ValueError, "checksum"):
            prepared.write_catalogue(self.root)

    def test_duplicate_package_identity_rejected(self):
        self.records.append(dict(self.records[0]))
        self.save()
        with self.assertRaisesRegex(ValueError, "duplicated"):
            prepared.write_catalogue(self.root)


if __name__ == "__main__":
    unittest.main()
