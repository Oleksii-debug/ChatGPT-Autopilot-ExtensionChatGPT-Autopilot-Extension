"""Pinned resolver compatibility: real files on Windows, portable syntax guards."""
import ast
import importlib.util
import logging
import ntpath
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest

ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location("vendor_builder_test",ROOT/"tools/build_release.py")
builder=importlib.util.module_from_spec(SPEC)
import sys
sys.modules[SPEC.name]=builder
SPEC.loader.exec_module(builder)

class OfflineModelError(RuntimeError):
    def __init__(self,model,path,cause,**kwargs):
        super().__init__(model,path,type(cause).__name__)

def resolver(data,paths=os.path):
    tree=ast.parse(data.decode("utf-8"))
    function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=="_download_files")
    namespace={"os":SimpleNamespace(path=paths),"time":time,"LOG":logging.getLogger("resolver-test"),
               "ModelDownloadError":OfflineModelError,"HF_REPO_ID":"fixed","HF_REPO_REVISION":"fixed-revision"}
    exec(compile(ast.Module(body=[function],type_ignores=[]),"pinned-offline-resolver","exec"),namespace)
    return namespace["_download_files"]

class VendorCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.original=builder.STRESS_VENDOR_REFERENCE.read_bytes()
        self.patched=builder.patch_stress_cache(self.original)

    def test_complete_reference_pin_is_idempotent_and_rejects_unknown_source(self):
        self.assertNotEqual(self.original,self.patched)
        self.assertEqual(builder.patch_stress_cache(self.patched),self.patched)
        self.assertEqual(builder.patch_stress_cache(self.original.replace(b"\n",b"\r\n")),self.patched)
        with self.assertRaisesRegex(ValueError,"Unknown stressonnx"):
            builder.patch_stress_cache(self.original+b"# unknown change\n")

    def test_extended_drive_and_unc_keep_original_keys_and_native_values(self):
        for root in ("C:\\cache", "\\\\?\\C:\\cache", "\\\\?\\UNC\\server\\share\\cache"):
            seen=[]
            expected=ntpath.normpath(ntpath.join(root,"ru_ruaccent","nn_omograph/model.onnx"))
            paths=SimpleNamespace(join=ntpath.join,normpath=ntpath.normpath,
                exists=lambda path: seen.append(path) is None and path==expected,
                getsize=lambda path: 12)
            result=resolver(self.patched,paths)("ru_ruaccent",["nn_omograph/model.onnx"],root)
            self.assertEqual(result,{"nn_omograph/model.onnx":expected})
            self.assertEqual(seen,[expected])
            self.assertNotIn("/",result["nn_omograph/model.onnx"])

    def test_real_missing_and_zero_files_still_fail_offline(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            (root/"ru_ruaccent/nn_omograph").mkdir(parents=True)
            fn=resolver(self.patched)
            for name in ("missing.onnx","zero.onnx"):
                if name=="zero.onnx":(root/"ru_ruaccent/nn_omograph"/name).touch()
                with self.assertRaises(OfflineModelError):
                    fn("ru_ruaccent",["nn_omograph/"+name],str(root))

    @unittest.skipUnless(os.name=="nt","Extended namespace requires real Windows")
    def test_real_windows_existing_file_normal_and_extended_cache_roots(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            target=root/"ru_ruaccent/nn_omograph/model.onnx"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"actual existing test bytes")
            fn=resolver(self.patched)
            for cache in (str(root),"\\\\?\\"+str(root)):
                result=fn("ru_ruaccent",["nn_omograph/model.onnx"],cache)
                value=result["nn_omograph/model.onnx"]
                self.assertEqual(Path(value).read_bytes(),target.read_bytes())
                if cache.startswith("\\\\?\\"):
                    self.assertTrue(value.startswith("\\\\?\\"))
                    with self.assertRaises(OfflineModelError):
                        resolver(self.original)("ru_ruaccent",["nn_omograph/model.onnx"],cache)

if __name__=="__main__":
    unittest.main()
