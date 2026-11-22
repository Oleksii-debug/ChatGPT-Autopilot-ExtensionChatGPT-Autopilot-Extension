#!/usr/bin/env python3
"""Preserve six pinned optional native model ZIPs in an owned, unpublished GitHub draft.

No ref updates, release publication, asset replacement, deletion or code execution.
This is an isolated immutable optional native resource backup for dev11.
The dev9/dev10 helpers, drafts and constants remain unchanged. Never a product acceptance certificate.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
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
SOURCE_COMMIT = "46dd8b5a61a348b6354807245559b6dd19070a2f"
STORAGE_ANCHOR = "096a5e8b0a3f97aa3199106ff88c3009e7fc7bc4"
SOURCE_RUN = 45024624013
ARTIFACT_ID = 14754908871
ARTIFACT_NAME = "dordiai-afri-six-optional-packs-45024624013"
ARTIFACT_SIZE = 370709167
ARTIFACT_SHA256 = "917bd7c60bf4cbaefc419b73fdadbf26e3ebabe8c3a332ac7b3ad8a613b2d810"
PACKS = {
  "afri-six-shared-1.0.0.zip": {
    "size_bytes": 369927753,
    "sha256": "647ba0a235404ecca1101795c71d7f7e08d3de3601172f8e0542e1568f27ba1d"
  },
  "afri-six-ss-1.0.0.zip": {
    "size_bytes": 150948,
    "sha256": "efa397443408e86820599606cab4e1ebd582745060b8deb193092141b9d80ce6"
  },
  "afri-six-ve-1.0.0.zip": {
    "size_bytes": 171864,
    "sha256": "af379f952c34b1b1a162920ed65d4ddba83caea2221e906a4be320b92ec8a95c"
  },
  "afri-six-zu-1.0.0.zip": {
    "size_bytes": 192861,
    "sha256": "70225adacc32cd55be92902051d66d6012624961f34873ae18788ab6addcf0a1"
  },
  "afri-six-wo-1.0.0.zip": {
    "size_bytes": 122837,
    "sha256": "651bd8049d9698b3441d3cf54db926801fc0cf190a269da8dca06f8a521370ac"
  },
  "afri-six-nso-1.0.0.zip": {
    "size_bytes": 142068,
    "sha256": "d89dbaae31183979eae68a61a101fae6f44a22a0c2b502e5e04957decbaa9d62"
  }
}
TAG = "dordiai-voices-afri-six-dev11-data-backup"
TITLE = "Dordiai AfriSix dev11 data backup (unpublished; product not ready)"
RECEIPT_NAME = "dordiai-afri-six-dev11-backup-receipt.json"
CHUNK = 4 * 1024 * 1024

INTEGRATION_RUN = 45029834209
INTEGRATION_COMMIT = "84ca83e36e729fece88fc56af078a0de826d9db3"
INTEGRATION_CORE_SHA256 = "223e5ea7b29d0f9d16f3ca653711e8ced281c0fc7d5bd2fb891018a73926eceb"

IDENTITY = {
    "format": "dordiai-afri-six-data-backup", "format_version": 1,
    "repository": REPOSITORY, "tag": TAG,
    "binary_source_commit": SOURCE_COMMIT, "storage_anchor_commit": STORAGE_ANCHOR,
    "source_run_id": SOURCE_RUN, "source_run_conclusion": "success",
    "source_artifact": {"id": ARTIFACT_ID, "name": ARTIFACT_NAME,
        "wrapper_sha256": ARTIFACT_SHA256, "wrapper_size_bytes": ARTIFACT_SIZE},
    "packs": PACKS, "pack_version": "1.0.0", "minimum_core_version": "0.13.1-dev.11",
    "model_repository": "AfriSpeech/africa-tts",
    "model_revision": "d47667a3bb03d0d6db924e789648abd7d55d828b",
    "source_checkpoint_sha256": "b4cdf2cb62674145fe83ba661041d8180faa543ff9ae1906ae3bb59c9a03171c",
    "separate_source11_integration": {"run_id": INTEGRATION_RUN,
        "source_commit": INTEGRATION_COMMIT, "core_sha256": INTEGRATION_CORE_SHA256,
        "actual_selected_profile_worker_cases": 225},
    "native_pronunciation_verified": False, "character_names_verified": False,
    "typing_verified": False, "nvda_verified": False,
    "physical_audio_verified": False, "product_ready": False,
}
BODY = ("Owned data-only engineering backup. Keep this release as a DRAFT. "
        "Do not publish or replace assets. Six exact ZIPs contain one shared six-layer FP32 "
        "native engine and five separately selectable native references, minimum core dev11. "
        "The separate frozen source11 workflow passed 225 real packaged-worker cases after installing these exact packs. "
        "This is not NVDA, native pronunciation, character-name, typing or physical audio acceptance. "
        "Publisher model/voice license notices remain inside the original ZIPs.\n\n"
        "<!-- dordiai-afri-six-data-backup-v1 -->\n"
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
        if name not in set(PACKS) | {RECEIPT_NAME} or type(release_id) is not int:
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
            or run.get("path") != ".github/workflows/dordiai-afri-resources.yml"):
        raise BackupError("Source workflow identity changed")
    artifact = client.request("GET", api_path("/actions/artifacts/" + str(ARTIFACT_ID)))
    if (artifact.get("name") != ARTIFACT_NAME or artifact.get("expired") is not False
            or artifact.get("size_in_bytes") != ARTIFACT_SIZE
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
    if (any(a.get("name") not in set(PACKS) | {RECEIPT_NAME} for a in rows)
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


def verify_integration(client):
    run = client.request("GET", api_path("/actions/runs/" + str(INTEGRATION_RUN)))
    if (run.get("head_sha") != INTEGRATION_COMMIT or run.get("status") != "completed"
            or run.get("conclusion") != "success"
            or run.get("path") != ".github/workflows/dordiai-source11-integration.yml"):
        raise BackupError("Separate actual source11 integration proof does not match its immutable pin")


def run(input_directory, receipt_path, client):
    directory = Path(input_directory)
    if directory.is_symlink() or not directory.is_dir() or {p.name for p in directory.iterdir()} != set(PACKS):
        raise BackupError("Expected exactly six regular pinned optional pack ZIPs")
    # Open and hash ALL SIX before any remote operation. Same descriptors go to upload.
    with ExitStack() as opened:
        streams = {}
        for name,record in sorted(PACKS.items()):
            path = directory / name
            if path.is_symlink() or not path.is_file():
                raise BackupError("Optional pack is not a regular owned file")
            stream = opened.enter_context(path.open("rb"))
            verify_stream(stream,record["size_bytes"],record["sha256"])
            streams[name] = stream
        verify_source(client)
        verify_integration(client)
        release = find_or_create_release(client)
        pack_assets = {}
        for name,record in sorted(PACKS.items()):
            asset = ensure_asset(client,release,name,streams[name],record["size_bytes"],record["sha256"])
            pack_assets[name] = {"asset_id":asset["id"],"size_bytes":record["size_bytes"],
                                 "sha256":record["sha256"],"download_sha256_verified":True}
        receipt = dict(IDENTITY,release_id=release["id"],release_draft=True,
                       release_published_at=None,pack_assets=pack_assets,
                       all6_download_sha256_verified=True,
                       no_core_or_code_assets_in_this_backup=True)
        payload = canonical_json(receipt)
        import io
        ensure_asset(client,release,RECEIPT_NAME,io.BytesIO(payload),
                     len(payload),hashlib.sha256(payload).hexdigest())
        validate_release(client.request("GET",api_path("/releases/"+str(release["id"]))))
        publish_receipt_file(receipt_path,payload)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-directory", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    try:
        receipt = run(args.input_directory, args.receipt, GitHub(os.environ.get("GITHUB_TOKEN", "")))
    except (BackupError, OSError, json.JSONDecodeError) as exc:
        # Never print server bodies, request objects, environment or signed redirect URLs.
        print("Backup failed: " + (str(exc) if isinstance(exc, BackupError) else type(exc).__name__))
        return 1
    print(json.dumps({"draft_release_id": receipt["release_id"],
                      "all6_download_sha256_verified": receipt["all6_download_sha256_verified"], "product_ready": False}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
