"""Owned config-length construction, independent of actual NVDA acceptance."""
from contextlib import redirect_stdout
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location("long_owned_nvda_probe",ROOT/"tools/windows_nvda_probe.py")
TOOL=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)
RUN_ID="a"*32


class LongInstalledConfigTests(unittest.TestCase):
    def test_only_fixed_config_child_is_lengthened_by28(self):
        run=Path("owned-nvda-run")
        normal=TOOL.owned_config_directory(run)
        long=TOOL.owned_config_directory(run,long_installed=True)
        self.assertEqual(normal,run/"config")
        self.assertEqual(long.parent,run)
        self.assertEqual(long.name,"config-native-membership-long-path")
        self.assertEqual(len(str(long))-len(str(normal)),28)
        self.assertNotEqual(long,run/"portable")

    def test_cli_exposes_explicit_optin(self):
        stream=io.StringIO()
        with redirect_stdout(stream),self.assertRaises(SystemExit) as error:
            TOOL.main(["--help"])
        self.assertEqual(error.exception.code,0)
        self.assertIn("--long-installed-config",stream.getvalue())

    def test_genuine_owned_required_resource_quarantine_and_restore_both_names(self):
        for long in (False,True):
            with self.subTest(long=long),tempfile.TemporaryDirectory() as name:
                run=Path(name).resolve()
                addon=TOOL.owned_config_directory(run,long_installed=long)/"addons/kx47Voices"
                target=addon/"kx47Runtime"/TOOL.REQUIRED_RESOURCE_RELATIVE
                target.parent.mkdir(parents=True)
                target.write_bytes(b"owned unit resource; not a model")
                record=TOOL.quarantine_required_resource(addon,run,RUN_ID)
                self.assertFalse(target.exists())
                result=TOOL.restore_required_resource(record)
                self.assertTrue(result["restored"])
                self.assertTrue(result["sha256_identical"])
                self.assertEqual(target.read_bytes(),b"owned unit resource; not a model")

    def test_arbitrary_config_child_is_never_authorized(self):
        with tempfile.TemporaryDirectory() as name:
            run=Path(name).resolve()
            addon=run/"untrusted-config/addons/kx47Voices"
            (addon/"kx47Runtime").mkdir(parents=True)
            with self.assertRaises(ValueError):
                TOOL.required_resource_probe_paths(addon,run,RUN_ID)

    def test_host_ownership_guard_uses_same_two_fixed_config_names(self):
        self.assertIn('owned / "config" / "addons"',TOOL.PROBE_PLUGIN)
        self.assertIn('owned / "config-native-membership-long-path" / "addons"',TOOL.PROBE_PLUGIN)
        self.assertNotIn("config_directory_name",TOOL.PROBE_PLUGIN)


if __name__=="__main__":
    unittest.main()
