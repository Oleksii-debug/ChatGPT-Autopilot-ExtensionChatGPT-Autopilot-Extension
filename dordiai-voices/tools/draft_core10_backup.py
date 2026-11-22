#!/usr/bin/env python3
"""Preserve one pinned development binary in an owned, unpublished GitHub draft.

No ref updates, release publication, asset replacement, deletion or code execution.
This is an isolated immutable dev10 backup with merged native bank data.
The dev9 helper, draft and constants remain unchanged. Never a product acceptance certificate.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import ssl
import tempfile
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = "Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension"
SOURCE_COMMIT = "2bdababb86378f3cc6e58b934265175da589d703"
STORAGE_ANCHOR = "096a5e8b0a3f97aa3199106ff88c3009e7fc7bc4"
SOURCE_RUN = 45021069771
ARTIFACT_ID = 14753953381
ARTIFACT_NAME = "dordiai-voices-banks10-development-core"
ARTIFACT_SHA256 = "8759b0924bc9412332960b06c6e0a1736e7841416c864dbfda98fcd64f34bbe1"
CORE_NAME = "dordiai-voices-0.13.1-dev.10.nvda-addon"
CORE_SIZE = 1974796411
CORE_SHA256 = "437bb9394df5b44cb1a99edee21312f6255b8cc74622c0bcc15b3513e6c328d8"
TAG = "dordiai-voices-dev10-engineering-backup"
TITLE = "Dordiai dev10 engineering backup (unpublished; product not ready)"
RECEIPT_NAME = "dordiai-core-dev10-backup-receipt.json"
CHUNK = 4 * 1024 * 1024

IDENTITY = {
    "format": "dordiai-engineering-backup", "format_version": 1,
    "repository": REPOSITORY, "tag": TAG,
    "binary_source_commit": SOURCE_COMMIT, "storage_anchor_commit": STORAGE_ANCHOR,
    "source_run_id": SOURCE_RUN, "source_run_conclusion": "success",
    "source_artifact": {"id": ARTIFACT_ID, "name": ARTIFACT_NAME,
                        "wrapper_sha256": ARTIFACT_SHA256},
    "core": {"name": CORE_NAME, "size_bytes": CORE_SIZE, "sha256": CORE_SHA256},
    "prepared_bank_overlay": {"version": "0.13.1-banks.1",
        "archive_sha256": "055d57d619ed0925b19199799ff08a24690ff8a34f1a3652674cb8c7b38e6ccb",
        "generation_run_id": 45018169807,
        "generator_commit": "7b08ce448d5b888e6c75a503f72bf1d3dd8e8368",
        "source_core_sha256": "568e49547f386b17fc82d1def13257749774eecaf999f4823d74100e47bf7ac6",
        "bank_file_count": 180, "retained_voice_count": 45},
    "product_ready": False,
}
BODY = ("Owned engineering backup. Keep this release as a DRAFT. "
        "Do not publish or replace assets. The source workflow used recording PCM sink test doubles; "
        "physical audio and pronunciation are not certified for public use.\n\n"
        "<!-- dordiai-engineering-backup-v1 -->\n"
        + json.dumps(IDENTITY, sort_keys=True, separators=(",", ":")) + "\n")


class BackupError(ValueError):
    pass


def canonical_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def stream_fingerprint(stream):
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = stream.read(CHUNK)
        if not chunk:
            break
        size += len(chunk)
        digest.update(chunk)
    return size, digest.hexdigest()


def verify_stream(stream, size, sha256):
    actual = stream_fingerprint(stream)
    if actual != (size, sha256):
        raise BackupError("Binary size/SHA-256 mismatch")
    return actual


def validate_release(release):
    required = {"tag_name": TAG, "target_commitish": STORAGE_ANCHOR, "name": TITLE,
                "body": BODY, "draft": True, "prerelease": True}
    if any(release.get(k) != v for k, v in required.items()):
        raise BackupError("Existing release does not match the exact owned DRAFT identity")
    if release.get("published_at") is not None:
        raise BackupError("Existing release has been published")
    if type(release.get("id")) is not int or release["id"] <= 0:
        raise BackupError("Invalid release ID")
    return release


class _GithubOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        host = (parsed.hostname or "").lower()
        if (parsed.scheme != "https" or parsed.port not in (None, 443)
                or parsed.username or parsed.password
                or not (host == "api.github.com" or host.endswith(".githubusercontent.com"))):
            raise BackupError("Binary redirect left GitHub-owned HTTPS infrastructure")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None:
            # Signed GitHub storage URLs never receive the API credential.
            redirected.remove_header("Authorization")
        return redirected


class GitHub:
    def __init__(self, token):
        if not token:
            raise BackupError("GITHUB_TOKEN is required")
        self.token = token
        self.opener = urllib.request.build_opener(_GithubOnlyRedirect())

    def _headers(self, accept="application/vnd.github+json"):
        return {"Authorization": "Bearer " + self.token, "Accept": accept,
                "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "dordiai-owned-backup"}

    def request(self, method, path, payload=None, missing_ok=False):
        if not path.startswith("/repos/" + REPOSITORY + "/"):
            raise BackupError("API request escaped the owned repository")
        data = None if payload is None else canonical_json(payload)
        headers = self._headers()
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request("https://api.github.com" + path, data=data,
                                     headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=180) as response:
                if response.geturl() != req.full_url:
                    raise BackupError("Unexpected JSON API redirect")
                raw = response.read(8 * 1024 * 1024 + 1)
                if len(raw) > 8 * 1024 * 1024:
                    raise BackupError("Oversized JSON API response")
                return json.loads(raw)
        except urllib.error.HTTPError as exc:
            if missing_ok and exc.code == 404:
                return None
            raise BackupError("GitHub API failed (HTTP %d)" % exc.code) from None
        except urllib.error.URLError:
            raise BackupError("GitHub API transport failed") from None

    def pages(self, path):
        for page in range(1, 101):
            sep = "&" if "?" in path else "?"
            rows = self.request("GET", path + sep + "per_page=100&page=" + str(page))
            if not isinstance(rows, list):
                raise BackupError("Malformed paginated API response")
            yield from rows
            if len(rows) < 100:
                return
        raise BackupError("Pagination limit exceeded")

    def download_fingerprint(self, asset_id):
        if type(asset_id) is not int or asset_id <= 0:
            raise BackupError("Invalid asset ID")
        path = "/repos/" + REPOSITORY + "/releases/assets/" + str(asset_id)
        req = urllib.request.Request("https://api.github.com" + path,
                                     headers=self._headers("application/octet-stream"))
        try:
            with self.opener.open(req, timeout=300) as response:
                return stream_fingerprint(response)
        except (urllib.error.HTTPError, urllib.error.URLError):
            raise BackupError("GitHub asset verification download failed") from None

    def upload(self, release_id, name, stream, size):
        if name not in (CORE_NAME, RECEIPT_NAME) or type(release_id) is not int:
            raise BackupError("Upload escaped the owned backup asset names")
        path = ("/repos/" + REPOSITORY + "/releases/" + str(release_id)
                + "/assets?name=" + urllib.parse.quote(name, safe=""))
        connection = http.client.HTTPSConnection("uploads.github.com", timeout=300,
                                                 context=ssl.create_default_context())
        try:
            connection.putrequest("POST", path)
            for key, value in self._headers().items():
                connection.putheader(key, value)
            connection.putheader("Content-Type", "application/octet-stream")
            connection.putheader("Content-Length", str(size))
            connection.endheaders()
            sent = 0
            while True:
                chunk = stream.read(CHUNK)
                if not chunk:
                    break
                connection.send(chunk)
                sent += len(chunk)
            if sent != size:
                raise BackupError("Local asset changed during upload")
            response = connection.getresponse()
            raw = response.read(1024 * 1024 + 1)
            if response.status != 201:
                raise BackupError("GitHub upload failed (HTTP %d); existing assets untouched"
                                  % response.status)
            if len(raw) > 1024 * 1024:
                raise BackupError("Oversized upload API response")
            return json.loads(raw)
        except (OSError, http.client.HTTPException):
            raise BackupError("GitHub upload transport failed; no asset overwrite attempted") from None
        finally:
            connection.close()


def api_path(suffix):
    return "/repos/" + REPOSITORY + suffix


def verify_source(client):
    run = client.request("GET", api_path("/actions/runs/" + str(SOURCE_RUN)))
    if (run.get("head_sha") != SOURCE_COMMIT or run.get("status") != "completed"
            or run.get("conclusion") != IDENTITY["source_run_conclusion"]
            or run.get("path") != ".github/workflows/dordiai-banks10.yml"):
        raise BackupError("Source workflow identity changed")
    artifact = client.request("GET", api_path("/actions/artifacts/" + str(ARTIFACT_ID)))
    if (artifact.get("name") != ARTIFACT_NAME or artifact.get("expired") is not False
            or artifact.get("digest") != "sha256:" + ARTIFACT_SHA256
            or artifact.get("workflow_run", {}).get("id") != SOURCE_RUN
            or artifact.get("workflow_run", {}).get("head_sha") != SOURCE_COMMIT):
        raise BackupError("Source artifact identity changed or expired")


def verify_tag_if_present(client):
    reference = client.request("GET", api_path("/git/ref/tags/" + TAG), missing_ok=True)
    if reference is None:
        return
    obj = reference.get("object", {})
    for _ in range(6):
        if obj.get("type") == "commit":
            if obj.get("sha") != STORAGE_ANCHOR:
                raise BackupError("Existing isolated backup tag targets a different storage-anchor commit")
            return
        sha = obj.get("sha", "")
        if obj.get("type") != "tag" or not re.fullmatch(r"[0-9a-f]{40}", sha):
            break
        obj = client.request("GET", api_path("/git/tags/" + sha)).get("object", {})
    raise BackupError("Cannot establish isolated backup tag ownership")


def find_or_create_release(client):
    verify_tag_if_present(client)
    matches = [r for r in client.pages(api_path("/releases")) if r.get("tag_name") == TAG]
    if len(matches) > 1:
        raise BackupError("Ambiguous backup draft identity")
    if matches:
        return validate_release(matches[0])
    # GITHUB_TOKEN cannot create tags at commits changing workflow files relative
    # to the default branch. Use an explicitly separate existing-main storage
    # anchor; binary provenance remains SOURCE_COMMIT. Never move main.
    anchor = client.request("GET", api_path("/branches/main"))
    if anchor.get("commit", {}).get("sha") != STORAGE_ANCHOR:
        raise BackupError("Pinned draft storage anchor no longer matches main; no automatic retarget")
    # The only release mutation allowed by this tool. No PATCH, DELETE or refs calls.
    created = client.request("POST", api_path("/releases"), {
        "tag_name": TAG, "target_commitish": STORAGE_ANCHOR, "name": TITLE, "body": BODY,
        "draft": True, "prerelease": True, "make_latest": "false",
        "generate_release_notes": False,
    })
    return validate_release(created)


def assets(client, release):
    # Recheck state immediately before each mutation; never append to a published release.
    validate_release(client.request("GET", api_path("/releases/" + str(release["id"]))))
    rows = list(client.pages(api_path("/releases/" + str(release["id"]) + "/assets")))
    if (any(a.get("name") not in (CORE_NAME, RECEIPT_NAME) for a in rows)
            or len({a["name"] for a in rows}) != len(rows)):
        raise BackupError("Backup draft contains unknown or duplicate assets")
    return {a["name"]: a for a in rows}


def verify_asset(client, asset, size, sha256):
    if (asset.get("size") != size or asset.get("state") != "uploaded"
            or asset.get("digest") not in (None, "sha256:" + sha256)):
        raise BackupError("Existing asset metadata mismatch; no overwrite allowed")
    if client.download_fingerprint(asset.get("id")) != (size, sha256):
        raise BackupError("Existing asset bytes mismatch; no overwrite allowed")


def ensure_asset(client, release, name, stream, size, sha256):
    current = assets(client, release)
    if name not in current:
        stream.seek(0)
        uploaded = client.upload(release["id"], name, stream, size)
        if uploaded.get("name") != name:
            raise BackupError("Uploaded asset identity mismatch")
        current = assets(client, release)
    if name not in current:
        raise BackupError("Uploaded asset did not become visible")
    verify_asset(client, current[name], size, sha256)
    return current[name]


def publish_receipt_file(path, data):
    path = Path(path)
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise BackupError("Unsafe local receipt destination")
    if path.exists():
        if path.read_bytes() != data:
            raise BackupError("Existing local receipt differs")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".backup-receipt-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        # POSIX link publishes without ever overwriting a concurrent destination.
        os.link(temporary, path)
    finally:
        os.unlink(temporary)


def run(core, receipt_path, client):
    core = Path(core)
    if core.is_symlink() or not core.is_file() or core.name != CORE_NAME:
        raise BackupError("Expected one regular pinned core archive")
    # Verification happens BEFORE any remote write. Keep the same descriptor for upload.
    with core.open("rb") as handle:
        verify_stream(handle, CORE_SIZE, CORE_SHA256)
        verify_source(client)
        release = find_or_create_release(client)
        core_asset = ensure_asset(client, release, CORE_NAME, handle, CORE_SIZE, CORE_SHA256)
        receipt = dict(IDENTITY, release_id=release["id"], release_draft=True,
                       release_published_at=None, core_asset_id=core_asset["id"],
                       binary_download_sha256_verified=True,
                       limitations=["Windows/NVDA probes used explicit recording PCM sink test doubles",
                                    "No physical audio acceptance",
                                    "Merged supplemental native bank data included; pronunciation remains pending",
                                    "Core archive does not include optional language packs"])
        receipt_bytes = canonical_json(receipt)
        import io
        ensure_asset(client, release, RECEIPT_NAME, io.BytesIO(receipt_bytes),
                     len(receipt_bytes), hashlib.sha256(receipt_bytes).hexdigest())
        validate_release(client.request("GET", api_path("/releases/" + str(release["id"]))))
        publish_receipt_file(receipt_path, receipt_bytes)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    try:
        receipt = run(args.core, args.receipt, GitHub(os.environ.get("GITHUB_TOKEN", "")))
    except (BackupError, OSError, json.JSONDecodeError) as exc:
        # Never print server bodies, request objects, environment or signed redirect URLs.
        print("Backup failed: " + (str(exc) if isinstance(exc, BackupError) else type(exc).__name__))
        return 1
    print(json.dumps({"draft_release_id": receipt["release_id"],
                      "core_sha256": CORE_SHA256, "product_ready": False}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
