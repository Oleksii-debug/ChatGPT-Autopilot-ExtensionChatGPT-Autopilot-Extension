"""Legacy data-path identity/selection tests; no model or audio claim."""
import ctypes
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
import sys
if str(RUNTIME) not in sys.path:
    sys.path.insert(0, str(RUNTIME))
import legacy_data_path as legacy


class LegacyPathSelectionTests(unittest.TestCase):
    def test_short_ascii_data_argument_drops_namespace_only_at_boundary(self):
        with patch.object(legacy, "_short_windows_path") as short:
            value, used_short = legacy._select_windows_spelling(r"\\?\C:\voices\data", tail_bytes=32)
        self.assertEqual(value, r"C:\voices\data")
        self.assertFalse(used_short)
        short.assert_not_called()
        self.assertEqual(legacy.extended_windows_path(value), r"\\?\C:\voices\data")

    def test_unc_namespace_has_correct_ordinary_spelling(self):
        value, used_short = legacy._select_windows_spelling(r"\\?\UNC\server\share\data", tail_bytes=32)
        self.assertEqual(value, r"\\server\share\data")
        self.assertFalse(used_short)

    def test_tail_bound_forces_alias_even_if_directory_itself_fits(self):
        value = "\\\\?\\C:\\" + "a" * 190
        with patch.object(legacy, "_short_windows_path", return_value=r"\\?\C:\SHORT~1\DATA") as short:
            selected, used_short = legacy._select_windows_spelling(value, tail_bytes=96)
        short.assert_called_once_with(value)
        self.assertEqual(selected, r"C:\SHORT~1\DATA")
        self.assertTrue(used_short)

    def test_unicode_requires_verified_ascii_alias(self):
        with patch.object(legacy, "_short_windows_path", return_value=r"\\?\C:\VOICES~1\DATA"):
            value, used_short = legacy._select_windows_spelling("\\\\?\\C:\\голоси\\дані", tail_bytes=32)
        self.assertEqual(value, r"C:\VOICES~1\DATA")
        self.assertTrue(used_short)

    def test_missing_unicode_or_long_alias_is_explicitly_unsupported(self):
        cases = ["\\\\?\\C:\\голоси\\дані", "\\\\?\\C:\\" + "a" * 270]
        for value in cases:
            with self.subTest(value=value), patch.object(legacy, "_short_windows_path", return_value=value):
                with self.assertRaises(legacy.LegacyDataPathUnsupported):
                    legacy._select_windows_spelling(value, tail_bytes=32)

    def test_native_short_path_api_uses_capacity_and_actual_buffer(self):
        def get_short(source, output, capacity):
            text = r"\\?\C:\SHORT~1\DATA"
            if output is None:
                return len(text) + 1
            output.value = text
            return len(text)
        kernel = SimpleNamespace(GetShortPathNameW=Mock(side_effect=get_short))
        with patch.object(ctypes, "WinDLL", return_value=kernel, create=True):
            self.assertEqual(legacy._short_windows_path(r"\\?\C:\long directory\data"), r"\\?\C:\SHORT~1\DATA")
        self.assertEqual(kernel.GetShortPathNameW.call_count, 2)

    def test_native_short_path_api_failure_never_returns_unverified_path(self):
        kernel = SimpleNamespace(GetShortPathNameW=Mock(return_value=0))
        with patch.object(ctypes, "WinDLL", return_value=kernel, create=True):
            with self.assertRaises(legacy.LegacyDataPathUnsupported):
                legacy._short_windows_path(r"\\?\C:\long directory\data")


    def test_ordinary_216_character_parent_uses_measured_tail_without_alias(self):
        entries = ((Path("."), True), (Path("espeak-ng-data"), True),
                   (Path("espeak-ng-data/voices/!v/Alice"), False))
        tail = legacy._measured_tail(entries)
        parent = "\\\\?\\C:\\" + "a" * 213
        with patch.object(legacy, "_short_windows_path") as short:
            selected, used_short = legacy._select_windows_spelling(parent, tail)
        self.assertEqual(len(selected), 216)
        self.assertFalse(used_short)
        short.assert_not_called()

    def test_measured_tail_includes_nested_empty_directory_wildcard(self):
        entries = ((Path("."), True), (Path("espeak-ng-data"), True),
                   (Path("espeak-ng-data/lang/long-empty"), True),
                   (Path("espeak-ng-data/phontab"), False))
        self.assertEqual(legacy._measured_tail(entries), 1 + len("espeak-ng-data/lang/long-empty") + 2)

    def test_unicode_data_children_are_explicitly_unsupported_by_narrow_abi(self):
        with self.assertRaises(legacy.LegacyDataPathUnsupported):
            legacy._measured_tail(((Path("espeak-ng-data/lang/мова"), False),))

    def test_path_signature_preserves_ctime(self):
        info = SimpleNamespace(st_dev=1, st_ino=2, st_mode=0o100644, st_size=30,
                               st_mtime_ns=40, st_ctime_ns=50)
        path = SimpleNamespace(stat=lambda: info)
        first = legacy._signature(path)
        info.st_ctime_ns = 51
        self.assertNotEqual(legacy._signature(path), first)


class LegacyPathIdentityTests(unittest.TestCase):
    def fixture(self, folder, nested=True):
        folder.mkdir()
        data = folder / "espeak-ng-data" if nested else folder
        if nested:
            data.mkdir()
        for name in legacy._REQUIRED:
            (data / name).write_bytes(b"data identity fixture")
        return folder

    def test_same_directory_and_files_keep_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = self.fixture(Path(temporary) / "data")
            location = legacy.LegacyDataLocation(folder, folder)
            location.verify()
            self.assertEqual(location.original, folder)
            self.assertEqual(location.alias, folder)

    def test_different_directory_with_identical_contents_is_not_same_object(self):
        with tempfile.TemporaryDirectory() as temporary:
            first = self.fixture(Path(temporary) / "first")
            second = self.fixture(Path(temporary) / "second")
            with self.assertRaises(RuntimeError):
                legacy.LegacyDataLocation(first, second)

    def test_core_data_change_after_initialization_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = self.fixture(Path(temporary) / "data")
            location = legacy.LegacyDataLocation(folder, folder)
            (folder / "espeak-ng-data" / "phontab").write_bytes(b"replacement with different size")
            with self.assertRaises(RuntimeError):
                location.verify()

    def test_missing_core_file_is_not_treated_as_alias_support(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = self.fixture(Path(temporary) / "data")
            (folder / "espeak-ng-data" / "phonindex").unlink()
            with self.assertRaises(FileNotFoundError):
                legacy.LegacyDataLocation(folder, folder)


    def test_nested_layout_keeps_parent_argument_and_excludes_unrelated_models(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = self.fixture(Path(temporary) / "data")
            unrelated = folder / "neural-models"
            unrelated.mkdir()
            (unrelated / ("x" * 120 + ".onnx")).write_bytes(b"unrelated")
            location = legacy.LegacyDataLocation(folder, folder)
            self.assertEqual(location.data_relative, Path("espeak-ng-data"))
            self.assertEqual(location.alias, folder)
            self.assertTrue(all(relative == Path(".") or relative.parts[0] == "espeak-ng-data"
                                for relative, _ in location._entries))

    def test_multiple_data_layouts_are_explicitly_ambiguous(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = self.fixture(Path(temporary) / "data")
            for name in legacy._REQUIRED:
                (folder / name).write_bytes(b"second direct layout")
            with self.assertRaises(legacy.LegacyDataPathUnsupported):
                legacy.prepare_legacy_data_path(folder)

    def test_direct_legacy_layout_remains_supported(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = self.fixture(Path(temporary) / "data", nested=False)
            location = legacy.LegacyDataLocation(folder, folder)
            self.assertEqual(location.data_relative, Path("."))
            location.verify()

    def test_addition_after_snapshot_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = self.fixture(Path(temporary) / "data")
            location = legacy.LegacyDataLocation(folder, folder)
            (folder / "espeak-ng-data" / "new-data-file").write_bytes(b"new")
            with self.assertRaises(RuntimeError):
                location.verify()

    @unittest.skipUnless(os.name == "nt", "Actual Windows extended-path identity requires Windows")
    def test_actual_windows_prefixed_and_plain_ascii_directory_are_same_data(self):
        with tempfile.TemporaryDirectory(prefix="dordiai-legacy-") as temporary:
            folder = self.fixture(Path(temporary) / "data")
            # If the runner's user profile itself is Unicode/too long and has
            # no usable alias, the explicit unsupported error must not pass.
            location = legacy.prepare_legacy_data_path(legacy.extended_windows_path(folder))
            location.verify()
            self.assertTrue(os.path.samefile(location.original, location.alias))
            self.assertTrue(all(byte < 128 for byte in location.encoded))
            self.assertNotIn(b"\\\\?\\", location.encoded)
            self.assertLessEqual(len(location.encoded) + location.tail_bytes + 1, 260)


if __name__ == "__main__":
    unittest.main()
