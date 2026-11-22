"""Stream the verified development backup into bounded transport parts in owned CI."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request

REPOSITORY = "Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension"
ASSET_ID = 779924768
EXPECTED_BYTES = 1_992_990_314
EXPECTED_SHA256 = "4aed1ba48e8600dcd5f80bac9b85e5a3d7ce09b209c76a4a2873fe7b9960876d"
CHUNK_BYTES = 450_000_000

class AssetRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        parsed = urllib.parse.urlsplit(new_url)
        if parsed.scheme != "https" or not parsed.hostname or not (
            parsed.hostname == "github.com" or parsed.hostname == "api.github.com"
            or parsed.hostname.endswith(".githubusercontent.com")
            or parsed.hostname.endswith(".github.com")
            or parsed.hostname.endswith(".blob.core.windows.net")
        ):
            raise ValueError("Unexpected release-asset redirect host")
        redirected = super().redirect_request(request, fp, code, message, headers, new_url)
        if parsed.hostname != urllib.parse.urlsplit(request.full_url).hostname:
            redirected.remove_header("Authorization")
        return redirected

def restore_parts(output):
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise RuntimeError("This authenticated backup transport runs only in the owned GitHub CI")
    token = os.environ.get("GH_TOKEN")
    if not token:
        raise RuntimeError("Repository-scoped CI credential is unavailable")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    request = urllib.request.Request(
        f"https://api.github.com/repos/{REPOSITORY}/releases/assets/{ASSET_ID}",
        headers={"Authorization": "Bearer " + token, "Accept": "application/octet-stream",
                 "User-Agent": "dordiai-owned-core13-backup-recovery"},
    )
    opener = urllib.request.build_opener(AssetRedirect())
    whole = hashlib.sha256()
    parts = []
    total = 0
    with opener.open(request, timeout=90) as response:
        if response.headers.get_content_type() == "application/json":
            raise ValueError("GitHub returned asset metadata instead of backup bytes")
        for number in range(1, 6):
            name = f"dordiai-core13-{number:03d}.bin"
            temporary = output / (name + ".partial")
            digest = hashlib.sha256()
            size = 0
            with temporary.open("xb") as target:
                while size < min(CHUNK_BYTES, EXPECTED_BYTES - total):
                    block = response.read(min(2**20, CHUNK_BYTES-size, EXPECTED_BYTES-total-size))
                    if not block:
                        raise EOFError("The backup stream ended before its pinned length")
                    target.write(block)
                    digest.update(block)
                    whole.update(block)
                    size += len(block)
            total += size
            parts.append({"file": name, "bytes": size, "sha256": digest.hexdigest()})
        if response.read(1):
            raise ValueError("Backup stream exceeds pinned length")
    if total != EXPECTED_BYTES or whole.hexdigest() != EXPECTED_SHA256:
        raise ValueError("Full immutable development backup failed its pinned SHA256")
    receipt = {
        "format": "dordiai-source13-transport-parts", "version": 1,
        "original_name": "dordiai-voices-0.13.1-dev.13.nvda-addon",
        "original_bytes": total, "original_sha256": whole.hexdigest(), "parts": parts,
        "source_asset_id": ASSET_ID, "source_commit": "2d70515a4c49413efcb23198491bbc675a55db0a",
        "product_ready": False,
    }
    for part in parts:
        (output / (part["file"] + ".partial")).replace(output / part["file"])
    (output / "parts.json").write_text(json.dumps(receipt, indent=2)+"\n", encoding="utf8")
    print(json.dumps(receipt), flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    restore_parts(parser.parse_args().output)
