"""Separate Windows pathname and descriptor clocks without weakening reload guards."""
from hashlib import sha256
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1] / "source/0.12.2/kx47Runtime"
sys.path.insert(0, str(RUNTIME))
import mms_family_sessions as family


class ResourceClockTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "model.onnx"
        self.data = b"pinned exact model bytes"
        self.path.write_bytes(self.data)

    def snapshot(self):
        path_key = family.signature(self.path)
        with self.path.open("rb") as stream:
            opened = os.fstat(stream.fileno())
        return family._FileIdentity(path_key, opened)

    def test_pinned_read_accepts_stable_path_and_fd_with_distinct_ctime(self):
        real_signature = family.signature
        def windows_path_clock(path):
            key = real_signature(path)
            return key[:-1] + (key[-1] - 1000000,) if key is not None else None
        with patch.object(family, "signature", side_effect=windows_path_clock):
            self.assertEqual(family._read_pinned(self.path, len(self.data), sha256(self.data).hexdigest()), self.data)
            identity = self.snapshot()
            self.assertNotEqual(identity.path_key[-1], identity.opened_stat.st_ctime_ns)
            family._assert_current(self.path, identity, ())

    def test_existing_actual_file_identity_round_trips_with_both_clocks(self):
        identity = self.snapshot()
        family._assert_current(self.path, identity, ())
        self.assertEqual(identity.path_key, family.signature(self.path))
        with self.path.open("rb") as stream:
            current = os.fstat(stream.fileno())
        self.assertTrue(os.path.samestat(identity.opened_stat, current))
        self.assertEqual(family._stat_key(identity.opened_stat), family._stat_key(current))

    def test_restored_mtime_does_not_hide_fd_change_time(self):
        identity = self.snapshot()
        changed = SimpleNamespace(**{name: getattr(identity.opened_stat, name) for name in
                                    ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")})
        changed.st_ctime_ns += 1
        with patch.object(family, "signature", return_value=identity.path_key), \
             patch.object(family.os, "fstat", return_value=changed):
            with self.assertRaises(family.MMSResourceChanged):
                family._assert_current(self.path, identity, ())

    def test_same_bytes_replacement_cannot_reuse_opened_identity(self):
        identity = self.snapshot()
        replacement = self.path.with_name("replacement.onnx")
        replacement.write_bytes(self.data)
        os.utime(replacement, ns=(identity.opened_stat.st_atime_ns, identity.opened_stat.st_mtime_ns))
        replacement.replace(self.path)
        # Even if the pathname clock is indistinguishable, the descriptor must
        # still refer to the original file rather than a same-content inode.
        with patch.object(family, "signature", return_value=identity.path_key):
            with self.assertRaises(family.MMSResourceChanged):
                family._assert_current(self.path, identity, ())

    def test_path_changed_while_reopening_is_rejected(self):
        identity = self.snapshot()
        changed_path_key = identity.path_key[:-1] + (identity.path_key[-1] + 1,)
        with patch.object(family, "signature", side_effect=(identity.path_key, changed_path_key)):
            with self.assertRaises(family.MMSResourceChanged):
                family._assert_current(self.path, identity, ())

    def test_same_fd_change_during_pinned_read_is_rejected(self):
        identity = self.snapshot()
        changed = SimpleNamespace(**{name: getattr(identity.opened_stat, name) for name in
                                    ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_mode")})
        changed.st_ctime_ns += 1
        with patch.object(family.os, "fstat", side_effect=(identity.opened_stat, changed)):
            with self.assertRaises(family.MMSResourceChanged):
                family._read_pinned(self.path, len(self.data), sha256(self.data).hexdigest())

    def test_path_disappearing_between_stat_and_reopen_is_stale_not_fallback(self):
        identity = self.snapshot()
        for error in (FileNotFoundError("removed"), NotADirectoryError("replaced parent")):
            with self.subTest(error=type(error).__name__), \
                 patch.object(Path, "open", side_effect=error):
                with self.assertRaises(family.MMSResourceChanged) as caught:
                    family._assert_current(self.path, identity, ())
                self.assertFalse(family._fallback_error(caught.exception))

    def test_managed_epoch_change_still_rejects_unchanged_model(self):
        identity = self.snapshot()
        manifest = self.path.with_name("manifest.ini")
        manifest.write_text("version = old", encoding="utf-8")
        epoch = ((str(manifest), family.signature(manifest)),)
        manifest.write_text("version = newer", encoding="utf-8")
        with self.assertRaises(family.MMSResourceChanged):
            family._assert_current(self.path, identity, epoch)

    def test_wrong_digest_still_rejects_stable_asset(self):
        with self.assertRaises(family.InvalidSharedMMS):
            family._read_pinned(self.path, len(self.data), "0" * 64)


if __name__ == "__main__":
    unittest.main()
