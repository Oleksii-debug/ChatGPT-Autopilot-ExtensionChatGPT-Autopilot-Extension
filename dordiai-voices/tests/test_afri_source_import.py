"""Owned source import refuses altered data before any Git publication."""
from hashlib import sha256
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

TOOL = Path(__file__).resolve().parents[1]/"tools/research/import_afri_reviewed_source.py"
spec = importlib.util.spec_from_file_location("afri_source_import_test",TOOL)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def fixture(extra=None, corrupt=False, manifest_languages=None):
    payload = {"wide_afri_six.py":b"pass\n",
               "vendor_afri_g2p/africa_g2p/__init__.py":b"native = True\n"}
    pins = {name:{"bytes":len(data),"git_blob_sha1":m.git_blob(data)} for name,data in payload.items()}
    vendor = {name.removeprefix("vendor_afri_g2p/"):row for name,row in pins.items()
              if name.startswith("vendor_afri_g2p/")}
    manifest = {"revision":m.G2P_REVISION,"languages":manifest_languages or m.LANGUAGES,
                "files":vendor,"scope":"Exact primary source subset; only five native charts are shipped",
                "code_license":"Apache-2.0 declared upstream; DATA_LICENSE.md retains separate source notices"}
    if corrupt:
        payload["wide_afri_six.py"] = b"evil\n"
    output = io.BytesIO()
    with zipfile.ZipFile(output,"w") as archive:
        for name,data in payload.items():
            archive.writestr(name,data)
        archive.writestr(m.MANIFEST,json.dumps(manifest))
        if extra is not None:
            archive.writestr(*extra)
    return output.getvalue(),pins,vendor


class SourceImportTests(unittest.TestCase):
    def test_exact_text_payload_and_altered_source_or_paths_are_rejected(self):
        raw,pins,vendor = fixture()
        result = m.validated_payload(raw,pins,vendor)
        self.assertEqual(set(result),set(pins)|{m.MANIFEST})
        for raw,pins,vendor in (
                fixture(corrupt=True),
                fixture(extra=("../outside.py",b"pass")),
                fixture(extra=("vendor_afri_g2p/extra-language.json",b"{}")),
                fixture(extra=("wide_afri_six.py",b"pass\n"))):
            with self.subTest(sha256=sha256(raw).hexdigest()):
                with self.assertRaises(ValueError):
                    m.validated_payload(raw,pins,vendor)

    def test_manifest_cannot_silently_add_related_language(self):
        raw,pins,vendor = fixture(manifest_languages={**m.LANGUAGES,"nr":"nde"})
        with self.assertRaises(ValueError):
            m.validated_payload(raw,pins,vendor)

    def test_publication_uses_only_unattached_blob_endpoint_and_preserves_raw_bytes(self):
        captured = []
        data = "мітка\n".encode("utf-8")
        class Response:
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def read(self,limit): return json.dumps({"sha":m.git_blob(data)}).encode()
        class Opener:
            def open(self,request,timeout):
                captured.append(request)
                return Response()
        with patch.object(m.urllib.request,"build_opener",return_value=Opener()):
            actual = m.publish_blob("synthetic-not-a-secret",data)
        self.assertEqual(actual,m.git_blob(data))
        self.assertEqual(len(captured),1)
        request = captured[0]
        self.assertEqual(request.method,"POST")
        self.assertEqual(request.full_url,"https://api.github.com/repos/"+m.REPOSITORY+"/git/blobs")
        self.assertEqual(json.loads(request.data)["encoding"],"base64")
        self.assertNotIn("/refs",request.full_url)


if __name__ == "__main__":
    unittest.main()
