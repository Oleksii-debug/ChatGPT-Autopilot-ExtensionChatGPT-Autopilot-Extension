"""Source11 assembly keeps exact old bank data and rejects unsafe inventories."""
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import zipfile

PATH = Path(__file__).resolve().parents[1]/"tools/research/source11_afri_integration.py"
spec = importlib.util.spec_from_file_location("source11_afri_assembly_test",PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def archive(path, *, unsafe=False, duplicate=False, corrupt=False):
    bank = b"unchanged real-resource stand-in\x00\xff"
    name = "../outside" if unsafe else "kx47Runtime/models/voices/native_letters/synthetic.pcm"
    manifest = {"format":"dordiai-core-release","version":"0.13.1-dev.10",
                "files":{name:{"size_bytes":len(bank),"sha256":sha256(bank).hexdigest()}}}
    with zipfile.ZipFile(path,"w") as output:
        output.writestr(name,b"corrupt" if corrupt else bank)
        if duplicate: output.writestr(name,bank)
        output.writestr("dordiai-release.json",json.dumps(manifest))
    return bank,name


class CoreResourceAssemblyTests(unittest.TestCase):
    def test_generated_old_inventory_is_omitted_but_exact_prepared_resource_survives(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bank,name = archive(root/"old.zip")
            manifest = m.extract_release(root/"old.zip",root/"new",omit_generated_manifest=True)
            self.assertEqual((root/"new"/name).read_bytes(),bank)
            self.assertFalse((root/"new/dordiai-release.json").exists())
            self.assertEqual(manifest["version"],"0.13.1-dev.10")

    def test_traversal_duplicate_or_changed_payload_cannot_become_baseline(self):
        for options in ({"unsafe":True},{"duplicate":True},{"corrupt":True}):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                archive(root/"bad.zip",**options)
                with self.assertRaises(ValueError):
                    m.extract_release(root/"bad.zip",root/"owned")
                self.assertFalse((root/"outside").exists())

    def test_model_pack_pin_rejects_substitution_even_when_filename_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/"same-name.zip"
            path.write_bytes(b"replacement")
            with self.assertRaises(ValueError):
                m.pinned(path,len(b"replacement"),sha256(b"original").hexdigest())


    def test_before_install_allows_only_valid_declared_same_language_omni_fallbacks(self):
        selection = {code:{"backend":"afri-six-onnx","_backend_selection":"preferred-unavailable",
                          "_preferred_missing_resources":["native source absent"]} for code in m.WORDS}
        labels = {code:code for code in ("zu","wo","nso")}
        for code in labels:
            selection[code] = {"backend":"omni-onnx","language":code,
                              "_backend_selection":"explicit-same-language-fallback"}
        catalog = SimpleNamespace(installed_languages=lambda models:labels,
            resolve_backend_info=lambda models,code,info:selection[code])
        actual,inventory = m.native_backend_inventory(catalog,Path("synthetic"),{},native_expected=False)
        self.assertEqual(set(actual),{"zu","wo","nso"})
        self.assertFalse(any(row["native_preferred_installed"] for row in inventory.values()))
        labels["ss"] = "must not exist before native installation"
        with self.assertRaises(ValueError):
            m.native_backend_inventory(catalog,Path("synthetic"),{},native_expected=False)
        labels.pop("ss")
        selection["zu"]["language"] = "xh"
        with self.assertRaises(ValueError):
            m.native_backend_inventory(catalog,Path("synthetic"),{},native_expected=False)

    def test_post_install_language_labels_are_insufficient_if_backend_still_falls_back(self):
        labels = {code:code for code in m.WORDS}
        selection = {code:{"backend":"afri-six-onnx","_backend_selection":"preferred"}
                     for code in m.WORDS}
        catalog = SimpleNamespace(installed_languages=lambda models:labels,
            resolve_backend_info=lambda models,code,info:selection[code])
        unused,inventory = m.native_backend_inventory(catalog,Path("synthetic"),{},native_expected=True)
        self.assertTrue(all(row["native_preferred_installed"] for row in inventory.values()))
        with self.assertRaises(ValueError):
            m.native_backend_inventory(catalog,Path("synthetic"),{},native_expected=False)
        selection["zu"] = {"backend":"omni-onnx","language":"zu",
                           "_backend_selection":"explicit-same-language-fallback"}
        with self.assertRaises(ValueError):
            m.native_backend_inventory(catalog,Path("synthetic"),{},native_expected=True)


if __name__ == "__main__":
    unittest.main()
