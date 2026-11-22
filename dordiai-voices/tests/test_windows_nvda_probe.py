"""Probe scaffolding tests; these explicitly do not run or simulate NVDA."""
import ast
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import zipfile

TOOLS = Path(__file__).resolve().parents[1] / "tools"
spec = importlib.util.spec_from_file_location("windows_probe_under_test", TOOLS / "windows_nvda_probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class WindowsProbeScaffoldingTests(unittest.TestCase):
    def test_embedded_plugin_is_valid_python_without_executing_nvda(self):
        code = probe.PROBE_PLUGIN.replace("__PROBE_SETTINGS__", repr({"output": "C:/isolated/test", "run_id": "abc"}))
        compile(code, "dordiaiProbe.py", "exec")
        self.assertIn("synthDriverHandler.setSynth", code)
        self.assertIn("wx.UIActionSimulator", code)

    def test_percentile_math_is_checked_without_running_nvda_plugin(self):
        tree = ast.parse(probe.PROBE_PLUGIN.replace("__PROBE_SETTINGS__", "{}"))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "percentiles")
        namespace = {}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "pure-percentiles", "exec"), namespace)
        result = namespace["percentiles"](list(range(1, 101)))
        self.assertEqual((result["p50_ms"], result["p95_ms"], result["p99_ms"]), (50, 95, 99))
        self.assertEqual(namespace["percentiles"]([])["count"], 0)

    def test_unverified_installer_cache_is_rejected_without_execution(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / "nvda.exe"
            cache.write_bytes(b"not the signed pinned installer")
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                probe.verified_installer(cache)

    def test_valid_cached_bytes_are_checked_and_reused(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / "nvda.exe"
            cache.write_bytes(b"test cache bytes")
            digest = probe.sha256_file(cache)
            with patch.object(probe, "NVDA_SHA256", digest):
                self.assertEqual(probe.verified_installer(cache), cache)

    def test_addon_extracted_only_under_isolated_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "test.nvda-addon"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("manifest.ini", 'name = "kx47Voices"')
                output.writestr("kx47Runtime/file.txt", "data")
            self.assertEqual(probe.addon_name(archive), "kx47Voices")
            probe.extract_addon(archive, root / "config" / "addons" / "test")
            self.assertEqual((root / "config/addons/test/kx47Runtime/file.txt").read_text(), "data")

    def test_archive_path_escape_rejected(self):
        for name in ("../escape", "C:/escape", "inside\\escape", "/absolute"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = root / "test.nvda-addon"
                with zipfile.ZipFile(archive, "w") as output:
                    output.writestr("manifest.ini", 'name = "probe"')
                    # ZipInfo's constructor rewrites Windows backslashes to
                    # slashes. Set the raw member name afterward so this is
                    # genuinely an unsafe ZIP fixture on every test host.
                    info = zipfile.ZipInfo("placeholder")
                    info.filename = name
                    output.writestr(info, "unsafe")
                with self.assertRaises(ValueError):
                    probe.extract_addon(archive, root / "config")

    def test_duplicate_windows_paths_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "test.nvda-addon"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("manifest.ini", 'name = "probe"')
                output.writestr("A.txt", "one")
                output.writestr("a.txt", "two")
            with self.assertRaises(ValueError):
                probe.extract_addon(archive, root / "config")

    def test_raw_backslash_rejected_even_when_zipinfo_normalized_filename(self):
        # Reproduce the Windows ZipInfo reader on every host. The raw name
        # must be checked before attempting to open or extract any member.
        member = zipfile.ZipInfo("inside/escape")
        member.orig_filename = "inside\\escape"
        archive = SimpleNamespace(namelist=lambda: ["manifest.ini", member.filename],
                                  infolist=lambda: [member])
        context = patch.object(probe.zipfile, "ZipFile")
        with tempfile.TemporaryDirectory() as temporary, context as factory:
            factory.return_value.__enter__.return_value = archive
            with self.assertRaisesRegex(ValueError, "Unsafe add-on archive member"):
                probe.extract_addon("unused-fixture.zip", Path(temporary) / "isolated")

    @unittest.skipIf(probe.os.name == "nt", "Linux guard test only")
    def test_linux_is_reported_blocked_without_download_or_nvda_stubs(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch("sys.stdout", new=io.StringIO()), patch.object(probe, "verified_installer") as downloader:
                code = probe.main(["--addon", "not-required-on-linux", "--output", temporary])
            result = json.loads((Path(temporary) / "windows-nvda-probe.json").read_text())
            self.assertEqual(code, 2)
            self.assertEqual(result["status"], "blocked")
            downloader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
