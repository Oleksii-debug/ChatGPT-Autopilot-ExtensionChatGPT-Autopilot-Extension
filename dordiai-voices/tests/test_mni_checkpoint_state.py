"""Synthetic fixtures prove safety, not native model quality."""
from pathlib import Path
import importlib.util
import pickle
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

TOOL = Path(__file__).resolve().parents[1]/"tools"/"research"/"inspect_mni_checkpoint_state.py"
spec = importlib.util.spec_from_file_location("mni_safe_state_test_tool", TOOL)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class UnsafeFixture:
    pass

class SyntheticStateTests(unittest.TestCase):
    def test_exact_audited_archive_pin(self):
        self.assertEqual(m.ARCHIVE_SIZE,1518195233)
        self.assertEqual(m.ARCHIVE_SHA256,"f689abf7d7398b99b40e589350beae6ceee62bdde880eb8c217b2d076e6683e5")
        self.assertEqual(len(m.FILES),5)
        self.assertEqual(sum(row[0] for row in m.FILES.values()),1653913872)

    def test_native_architecture_pinned(self):
        self.assertEqual(m.COQUI_REVISION,"42155940b5d0c4c78a554af04472925ddd326887")
        self.assertIn("TTS/tts/models/forward_tts.py",m.COQUI_FILES)

    def test_audited_helper_snapshot(self):
        self.assertEqual(m.helper().SOURCE_REVISION,"ad2461c22c373f89a140c5d9fb617b101219bdad")

    def test_safe_mmap_load(self):
        fake=Mock()
        with patch.object(m.zipfile,"is_zipfile",return_value=True):
            m.safe_load(fake,Path("opaque.pth"))
        fake.load.assert_called_once_with(Path("opaque.pth"),weights_only=True,map_location="cpu",mmap=True)

    def test_legacy_still_weights_only(self):
        fake=Mock()
        with patch.object(m.zipfile,"is_zipfile",return_value=False):
            m.safe_load(fake,Path("legacy.pth"))
        fake.load.assert_called_once_with(Path("legacy.pth"),weights_only=True,map_location="cpu",mmap=False)

    def test_no_unsafe_retry(self):
        fake=Mock()
        fake.load.side_effect=pickle.UnpicklingError("fixture refusal")
        with patch.object(m.zipfile,"is_zipfile",return_value=False):
            result=m.inspect_checkpoint(fake,Path("legacy.pth"))
        self.assertEqual(result["status"],"blocked-not-inferred")
        self.assertEqual(result["error_type"],"UnpicklingError")
        self.assertEqual(fake.load.call_count,1)
        self.assertTrue(fake.load.call_args.kwargs["weights_only"])

    def test_cpu_version_gate(self):
        fake=Mock()
        fake.version.cuda=None
        for version in ("2.5.1+cpu","2.6.0","2.6.0+cu124","invalid"):
            fake.__version__=version
            with self.assertRaises(ValueError):
                m.torch_version(fake)
        fake.__version__="2.6.0+cpu"
        self.assertEqual(m.torch_version(fake),"2.6.0+cpu")
        fake.version.cuda="12.4"
        with self.assertRaises(ValueError):
            m.torch_version(fake)

    def test_no_clobber(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/"report.json"
            m.publish(target,b"synthetic")
            with self.assertRaises(FileExistsError):
                m.publish(target,b"replaced")
            self.assertEqual(target.read_bytes(),b"synthetic")

    def test_output_link_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            source=root/"source"
            source.write_bytes(b"kept")
            try:
                (root/"link").symlink_to(source)
            except OSError as error:
                if getattr(error, "winerror", None) == 1314:
                    self.skipTest("This Windows account cannot create filesystem symlinks")
                raise
            with self.assertRaises(ValueError):
                m.publish(root/"link",b"bad")
            self.assertEqual(source.read_bytes(),b"kept")

    def test_cache_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"mni.zip"
            path.write_bytes(b"synthetic")
            with self.assertRaises(ValueError):
                m.check_hash(path,m.ARCHIVE_SIZE,m.ARCHIVE_SHA256)

    def test_zip_traversal_never_extracts(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            zipped=root/"fixture.zip"
            with zipfile.ZipFile(zipped,"w") as archive:
                archive.writestr("../escape.pth",b"opaque")
            with patch.object(m,"check_hash",return_value={}):
                with self.assertRaises(ValueError):
                    m.extract(zipped,root/"owned")
            self.assertFalse((root/"escape.pth").exists())

    def test_json_speakers_not_torch_pickle(self):
        fake=Mock()
        fake.is_tensor.return_value=False
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"speakers.pth"
            path.write_text('{"synthetic-female":0,"synthetic-male":1}',encoding="utf-8")
            result=m.inspect_checkpoint(fake,path)
        self.assertEqual(result["status"],"safe-state-inspected-not-inferred")
        self.assertEqual(result["serialization"],"strict-json")
        self.assertEqual(result["primitive_metadata"]["/synthetic-female"],0)
        fake.load.assert_not_called()

    @unittest.skipUnless(sys.platform=="linux","Linux-only kernel proof")
    def test_kernel_network_guard(self):
        program=("import importlib.util,socket\n"
            "s=importlib.util.spec_from_file_location('guard',%r)\n"
            "m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n"
            "print(m.deny_network()['kind'])\n"
            "try: socket.socket(socket.AF_INET,socket.SOCK_STREAM)\n"
            "except PermissionError: print('kernel-denied')\n"
            "else: raise RuntimeError('guard failed')\n")%str(TOOL)
        done=subprocess.run([sys.executable,"-c",program],capture_output=True,text=True,timeout=30)
        self.assertEqual(done.returncode,0,done.stderr)
        self.assertIn("kernel-denied",done.stdout)

try:
    import torch
except ImportError:
    torch=None

@unittest.skipIf(torch is None,"Actual tiny safe load needs isolated Torch")
class TinyTorchSafetyTests(unittest.TestCase):
    def test_tensor_shape_dtype_storage_groups(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"fixture.pth"
            tensor=torch.arange(6,dtype=torch.float32).reshape(2,3)
            torch.save({"model":{"model_g.weight":tensor,"model_g.alias":tensor,
                                  "model_d.weight":torch.ones(2)},
                        "optimizer":{"step":torch.tensor(3)}},path)
            result=m.inspect_checkpoint(torch,path)
        self.assertEqual(result["status"],"safe-state-inspected-not-inferred")
        self.assertEqual(result["tensor_count"],4)
        self.assertEqual(result["group_logical_bytes"]["model/model_g"],48)
        self.assertLess(result["unique_storage_bytes"],result["logical_tensor_bytes"])
        self.assertEqual(result["tensors"][0]["shape"],[2,3])
        self.assertFalse(result["tensor_values_evaluated"])

    def test_custom_class_blocked(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"blocked.pth"
            torch.save({"object":UnsafeFixture()},path)
            result=m.inspect_checkpoint(torch,path)
        self.assertEqual(result["status"],"blocked-not-inferred")
        self.assertEqual(result["error_type"],"UnpicklingError")
        self.assertTrue(any("UnsafeFixture" in name for name in result["static_unsafe_globals"]))

    def test_actual_legacy_safe_load(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"legacy.pth"
            torch.save({"model":{"weight":torch.ones(3)}},path,_use_new_zipfile_serialization=False)
            result=m.inspect_checkpoint(torch,path)
        self.assertFalse(result["mmap"])
        self.assertEqual(result["status"],"safe-state-inspected-not-inferred")
        self.assertTrue(result["safe_load_kwargs"]["weights_only"])

if __name__=="__main__":
    unittest.main()
