"""Recover small diagnostic members from a large GitHub artifact using HTTP ranges.

The GitHub token is sent only to api.github.com. A redirect is inspected without
following it; signed Azure range requests carry no Authorization header. Every
blob response must be 206, and the complete operation has a 32 MiB read budget.
No model, executable or full artifact is downloaded or executed.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile


MAX_RANGE_BYTES = 32 * 1024 * 1024
MAX_MEMBER_BYTES = 4 * 1024 * 1024
MAX_SELECTED_BYTES = 16 * 1024 * 1024
MAX_SELECTED_FILES = 32
REPO_PATTERN = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
BLOB_HOST = re.compile(r"productionresultssa[0-9]+\.blob\.(?:core\.windows\.net|storage\.azure\.net)\Z")
REPORT_NAMES = frozenset(("windows-nvda-probe.json", "nvda-probe.json"))
LOG_NAMES = frozenset(("nvda.log", "nvda-console.log", "portable-creation.log", "portable-creation-console.log"))
EXCLUDED_COMPONENTS = frozenset(("config", "addons", "models", "portable", "python", "__pycache__"))


class ArtifactError(ValueError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        return None


def validate_blob_url(url):
    if not isinstance(url, str) or any(ord(char) < 33 for char in url):
        raise ArtifactError("Malformed artifact redirect URL")
    parsed = urllib.parse.urlsplit(url)
    try:
        port = parsed.port
    except ValueError as error:
        raise ArtifactError("Malformed artifact redirect port") from error
    if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.fragment
            or port not in (None, 443) or not BLOB_HOST.fullmatch(parsed.hostname or "")):
        raise ArtifactError("Artifact redirect is not a recognized HTTPS GitHub Actions Azure blob")
    return url


def artifact_location(repo, artifact_id, token, open_url=None):
    if not REPO_PATTERN.fullmatch(repo) or artifact_id <= 0:
        raise ArtifactError("Invalid GitHub repository or artifact ID")
    if not token or any(char in token for char in "\r\n"):
        raise ArtifactError("GITHUB_TOKEN must be supplied through the job environment")
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/actions/artifacts/{artifact_id}/zip",
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "dordiai-diagnostic-range-reader"})
    open_url = open_url or urllib.request.build_opener(NoRedirect()).open
    try:
        response = open_url(request, timeout=30)
    except urllib.error.HTTPError as error:
        try:
            if error.code not in {301, 302, 303, 307, 308}:
                raise ArtifactError("GitHub artifact API returned HTTP " + str(error.code)) from None
            location = error.headers.get("Location")
        finally:
            error.close()
    else:
        try:
            if response.status not in {301, 302, 303, 307, 308}:
                raise ArtifactError("GitHub artifact API did not return an inspected redirect")
            location = response.headers.get("Location")
        finally:
            response.close()
    if not location:
        raise ArtifactError("GitHub artifact redirect has no Location header")
    return validate_blob_url(location)


class HTTPRangeReader(io.RawIOBase):
    """Seekable ZIP input with strict partial-response and transfer budgets."""
    def __init__(self, url, maximum=MAX_RANGE_BYTES, open_url=None):
        super().__init__()
        self.url = validate_blob_url(url)
        self.maximum = maximum
        self.open_url = open_url or urllib.request.build_opener(NoRedirect()).open
        self.position = 0
        self.bytes_read = 0
        self.size = None
        if maximum <= 0:
            raise ArtifactError("Range read budget must be positive")
        _, self.size = self._range(0, 0)

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=io.SEEK_SET):
        if self.closed:
            raise ValueError("I/O operation on closed artifact")
        if whence == io.SEEK_SET:
            position = offset
        elif whence == io.SEEK_CUR:
            position = self.position + offset
        elif whence == io.SEEK_END:
            position = self.size + offset
        else:
            raise ValueError("Invalid seek origin")
        if position < 0:
            raise ValueError("Negative artifact seek")
        self.position = position
        return position

    def _range(self, start, end):
        amount = end - start + 1
        if amount <= 0 or self.bytes_read + amount > self.maximum:
            raise ArtifactError("Artifact range read would exceed the 32 MiB transfer budget")
        request = urllib.request.Request(self.url, headers={
            "Range": f"bytes={start}-{end}", "Accept-Encoding": "identity",
            "User-Agent": "dordiai-diagnostic-range-reader"})
        # This independently created Request has no API token or cookies.
        try:
            response = self.open_url(request, timeout=30)
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            raise ArtifactError("Artifact range endpoint returned HTTP " + str(code)) from None
        try:
            if response.status != 206:
                # Never read even one byte of a 200 response: it could be the
                # complete multi-gigabyte artifact the server ignored Range for.
                raise ArtifactError("Artifact server ignored Range; required HTTP 206")
            content_range = response.headers.get("Content-Range", "")
            match = re.fullmatch(r"bytes ([0-9]+)-([0-9]+)/([0-9]+)", content_range)
            if not match:
                raise ArtifactError("Artifact response has no valid Content-Range")
            first, last, total = map(int, match.groups())
            if (first != start or last != end or total <= last
                    or self.size is not None and total != self.size):
                raise ArtifactError("Artifact response range or archive size changed")
            if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                raise ArtifactError("Artifact range response changed its content encoding")
            declared = response.headers.get("Content-Length")
            if declared is not None and declared != str(amount):
                raise ArtifactError("Artifact range has an inconsistent Content-Length")
            data = response.read(amount)
            self.bytes_read += len(data)
            if len(data) != amount or self.bytes_read > self.maximum:
                raise ArtifactError("Artifact range returned an unexpected byte count")
            return data, total
        finally:
            response.close()

    def read(self, size=-1):
        if self.closed:
            raise ValueError("I/O operation on closed artifact")
        remaining = max(0, self.size - self.position)
        amount = remaining if size is None or size < 0 else min(size, remaining)
        if not amount:
            return b""
        data, _ = self._range(self.position, self.position + amount - 1)
        self.position += len(data)
        return data


def safe_member(info):
    raw, name = info.orig_filename, info.filename
    path = PurePosixPath(raw)
    if (raw != name or not raw or path.is_absolute() or ".." in path.parts or "\\" in raw
            or ":" in raw or any(ord(char) < 32 for char in raw)):
        raise ArtifactError("Unsafe diagnostic ZIP member")
    return path


def selected_member(path):
    if any(part.casefold() in EXCLUDED_COMPONENTS for part in path.parts):
        return False
    if path.name in REPORT_NAMES or path.name in LOG_NAMES:
        return True
    return path.name in {"report.json", "worker-stderr.log"} and path.parts[0] in {"engine", "extra-engines"}


def brief_report(document):
    result = {key: document[key] for key in ("status", "scope", "error", "reason", "traceback", "audio_environment")
              if key in document}
    for field in ("checks", "tests"):
        if isinstance(document.get(field), list):
            result[field + "_nonpassing"] = [
                {key: entry[key] for key in ("name", "kind", "language", "voice", "status", "error", "reason", "traceback", "driver_error") if key in entry}
                for entry in document[field] if isinstance(entry, dict) and entry.get("status") != "passed"]
    if isinstance(document.get("probe"), dict):
        result["probe"] = brief_report(document["probe"])
    return result


def recover(reader, output):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"format": "dordiai-range-artifact-diagnostics", "format_version": 1,
              "archive_size_bytes": reader.size, "maximum_range_bytes": reader.maximum,
              "scope": "read-only diagnostic recovery; not a new Windows/NVDA test",
              "files": [], "omitted": []}
    total = 0
    with zipfile.ZipFile(reader) as archive:
        selected = []
        seen = set()
        for info in archive.infolist():
            path = safe_member(info)
            if not selected_member(path) or info.is_dir():
                continue
            if path.as_posix().casefold() in seen:
                raise ArtifactError("Duplicate Windows diagnostic destination")
            seen.add(path.as_posix().casefold())
            if (info.file_size > MAX_MEMBER_BYTES or total + info.file_size > MAX_SELECTED_BYTES
                    or len(selected) >= MAX_SELECTED_FILES):
                report["omitted"].append({"path": path.as_posix(), "reason": "diagnostic extraction budget"})
                continue
            total += info.file_size
            selected.append((info, path))
        for info, path in selected:
            target = output.joinpath(*path.parts)
            if not target.resolve().is_relative_to(output) or target.is_symlink():
                raise ArtifactError("Diagnostic member escapes output directory")
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as stream:
                data = stream.read(MAX_MEMBER_BYTES + 1)
            if len(data) != info.file_size or len(data) > MAX_MEMBER_BYTES:
                raise ArtifactError("Diagnostic ZIP member has an inconsistent expanded size")
            target.write_bytes(data)
            report["files"].append({"path": path.as_posix(), "bytes": len(data),
                                     "sha256": hashlib.sha256(data).hexdigest()})
            if target.suffix == ".json":
                document = json.loads(data)
                print("RECOVERED " + path.as_posix() + " " + json.dumps(brief_report(document), ensure_ascii=True), flush=True)
            elif target.name == "nvda.log":
                print("RECOVERED NVDA LOG TAIL " + path.as_posix(), flush=True)
                for line in data.decode("utf-8", errors="replace").splitlines()[-100:]:
                    print(line.encode("ascii", errors="backslashreplace").decode("ascii"), flush=True)
    report["range_bytes_read"] = reader.bytes_read
    report["status"] = "diagnostics-recovered" if report["files"] else "no-matching-diagnostics"
    (output / "recovery.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--artifact-id", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        location = artifact_location(args.repo, args.artifact_id, os.environ.get("GITHUB_TOKEN"))
        with HTTPRangeReader(location) as reader:
            report = recover(reader, args.output)
        print(json.dumps({"status": report["status"], "range_bytes_read": report["range_bytes_read"],
                          "archive_size_bytes": report["archive_size_bytes"], "files": len(report["files"])}), flush=True)
        return 0 if report["files"] else 1
    except (ArtifactError, OSError, ValueError, zipfile.BadZipFile) as error:
        # Do not log exception request objects or signed URLs/API credentials.
        print("Artifact diagnostic recovery failed: " + str(error), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
