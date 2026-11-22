"""Range recovery tests use in-memory HTTP responses, never credentials or live artifacts."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import re
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("read_action_artifact_test", ROOT / "tools/read_action_artifact.py")
reader_tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reader_tool)
BLOB = "https://productionresultssa1.blob.core.windows.net/actions-results/test.zip?sig=not-a-real-secret"


class Response:
    def __init__(self, status, headers, body=b"", forbid_read=False):
        self.status, self.headers, self.body = status, headers, body
        self.forbid_read = forbid_read
        self.closed = False

    def read(self, amount):
        if self.forbid_read:
            raise AssertionError("Non-206 body must never be read")
        return self.body[:amount]

    def close(self):
        self.closed = True


class InMemoryRanges:
    def __init__(self, blob):
        self.blob = blob
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append(request)
        match = re.fullmatch(r"bytes=(\d+)-(\d+)", request.get_header("Range"))
        start, end = map(int, match.groups())
        return Response(206, {"Content-Range": f"bytes {start}-{end}/{len(self.blob)}"},
                        self.blob[start:end + 1])


class RangeReaderTests(unittest.TestCase):
    def test_seek_read_and_zip_metadata_use_only_explicit_ranges(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("models/large.bin", bytes(1024 * 1024))
            archive.writestr("nvda/windows-nvda-probe.json", '{"status":"failed","error":"real driver failure"}')
            archive.writestr("nvda/run/nvda.log", "ERROR: actual diagnostic\n")
        ranges = InMemoryRanges(data.getvalue())
        with reader_tool.HTTPRangeReader(BLOB, open_url=ranges) as remote, tempfile.TemporaryDirectory() as folder:
            with redirect_stdout(io.StringIO()) as console:
                result = reader_tool.recover(remote, Path(folder))
            self.assertEqual(len(result["files"]), 2)
            self.assertLess(remote.bytes_read, 10000)
            self.assertFalse((Path(folder) / "models").exists())
            self.assertIn("real driver failure", console.getvalue())
        self.assertTrue(all(request.get_header("Authorization") is None for request in ranges.requests))

    def test_http_200_is_rejected_without_reading_body(self):
        def ignored_range(request, timeout):
            return Response(200, {}, forbid_read=True)
        with self.assertRaisesRegex(reader_tool.ArtifactError, "required HTTP 206"):
            reader_tool.HTTPRangeReader(BLOB, open_url=ignored_range)

    def test_whole_artifact_read_is_rejected_before_request(self):
        ranges = InMemoryRanges(bytes(1000))
        remote = reader_tool.HTTPRangeReader(BLOB, maximum=20, open_url=ranges)
        self.assertEqual(len(ranges.requests), 1)
        with self.assertRaisesRegex(reader_tool.ArtifactError, "budget"):
            remote.read()
        self.assertEqual(len(ranges.requests), 1)
        remote.close()

    def test_wrong_content_range_or_changed_size_is_rejected(self):
        ranges = InMemoryRanges(b"0123456789")
        remote = reader_tool.HTTPRangeReader(BLOB, open_url=ranges)
        remote.open_url = lambda request, timeout: Response(206, {"Content-Range": "bytes 0-1/99"}, b"01")
        with self.assertRaisesRegex(reader_tool.ArtifactError, "changed"):
            remote.read(2)
        remote.close()

    def test_truncated_ranges_fail(self):
        def truncated(request, timeout):
            return Response(206, {"Content-Range": "bytes 0-0/10"}, b"")
        with self.assertRaisesRegex(reader_tool.ArtifactError, "byte count"):
            reader_tool.HTTPRangeReader(BLOB, open_url=truncated)

    def test_api_auth_is_not_reused_for_blob_requests(self):
        requests = []
        def api(request, timeout):
            requests.append(request)
            return Response(302, {"Location": BLOB})
        location = reader_tool.artifact_location("owner/repo", 123, "test-job-token", open_url=api)
        self.assertEqual(requests[0].get_header("Authorization"), "Bearer test-job-token")
        ranges = InMemoryRanges(b"data")
        with reader_tool.HTTPRangeReader(location, open_url=ranges) as remote:
            self.assertEqual(remote.read(2), b"da")
        self.assertTrue(all(request.get_header("Authorization") is None for request in ranges.requests))

    def test_redirect_domain_is_strict_and_no_api_redirect_is_followed(self):
        for url in ("http://productionresultssa1.blob.core.windows.net/test", "https://evil.example/a.zip",
                    "https://productionresultssa1.blob.core.windows.net.evil.example/test",
                    "https://user:password@productionresultssa1.blob.core.windows.net/test"):
            with self.subTest(url=url), self.assertRaises(reader_tool.ArtifactError):
                reader_tool.validate_blob_url(url)
        self.assertIsNone(reader_tool.NoRedirect().redirect_request(None, None, 302, "", {}, BLOB))

    def test_raw_zip_path_alias_and_traversal_are_rejected(self):
        for raw, normalized in (("../outside.json", "../outside.json"),
                                ("nvda\\nvda.log", "nvda/nvda.log"),
                                ("nvda/nvda.log\0suffix", "nvda/nvda.log")):
            info = zipfile.ZipInfo(normalized)
            info.orig_filename = raw
            with self.subTest(raw=raw), self.assertRaises(reader_tool.ArtifactError):
                reader_tool.safe_member(info)

    def test_oversized_json_is_not_expanded(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("nvda/windows-nvda-probe.json", bytes(reader_tool.MAX_MEMBER_BYTES + 1))
        ranges = InMemoryRanges(data.getvalue())
        with reader_tool.HTTPRangeReader(BLOB, open_url=ranges) as remote, tempfile.TemporaryDirectory() as folder:
            result = reader_tool.recover(remote, Path(folder))
        self.assertEqual(result["files"], [])
        self.assertEqual(len(result["omitted"]), 1)


    def test_owned_banks_summary_whitelist_is_exact_and_does_not_adopt_pcm(self):
        for name in ("overlay-input.json", "prepared-coverage-summary.json", "input-cleanup.json"):
            self.assertTrue(reader_tool.selected_member(Path("banks") / name))
        for name in ("banks/unknown.json", "banks/nested/prepared-coverage-summary.json",
                     "models/banks/prepared-coverage-summary.json", "banks/payload.pcm",
                     "banks/worker.py", "banks/prepared-coverage-all45.json"):
            with self.subTest(name=name):
                self.assertFalse(reader_tool.selected_member(Path(name)))

    def test_engine_mms_characters_and_bank_original_reports_recover_without_weights(self):
        paths = ["banks/overlay-input.json", "banks/prepared-coverage-summary.json",
                 "engine/report.json", "extra-engines/report.json", "characters/report.json",
                 "mms-ha/report.json", "mms-ha-shared/report.json",
                 "nvda/run/nvda-probe.json", "nt/windows-nvda-probe.json", "nr/windows-nvda-probe.json"]
        data = io.BytesIO()
        raw = b'{"status":"passed","measured_ms":1.234}'
        with zipfile.ZipFile(data, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("models/large.onnx", bytes(1024*1024))
            archive.writestr("banks/payload.pcm", bytes(1024*1024))
            for path in paths:
                archive.writestr(path, raw)
        ranges = InMemoryRanges(data.getvalue())
        with reader_tool.HTTPRangeReader(BLOB, open_url=ranges) as remote, tempfile.TemporaryDirectory() as folder:
            with redirect_stdout(io.StringIO()):
                result = reader_tool.recover(remote, Path(folder))
            self.assertEqual({row["path"] for row in result["files"]}, set(paths))
            self.assertLess(remote.bytes_read, 30000)
            for path in paths:
                self.assertEqual((Path(folder) / path).read_bytes(), raw)
            self.assertFalse((Path(folder) / "models").exists())
            self.assertFalse((Path(folder) / "banks/payload.pcm").exists())


if __name__ == "__main__":
    unittest.main()
