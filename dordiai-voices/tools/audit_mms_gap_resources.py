"""Read-only HTTP/metadata audit of exact MMS native IDs for open language gaps.

No model weights are fetched, no neighbouring-language alias is tried, and no
HTTP failure or metadata entry is interpreted as an acoustically accepted model.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path, PurePosixPath
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HOST = "https://huggingface.co"
MAX_BODY = 4 * 1024 * 1024
ROWS = (("aa", "aar"), ("to", "ton"), ("ho", "hmo"), ("tet", "tet"),
        ("nr", "nbl"), ("ss", "ssw"), ("ve", "ven"), ("cnr", "cnr"),
        ("ito", "ito"), ("comorian", "zdj"), ("comorian", "wni"),
        ("comorian", "wlc"), ("comorian", "swb"))


def metadata(url, *, opener=urlopen):
    if not url.startswith(HOST + "/") or "/resolve/" in url:
        raise ValueError("Only primary Hugging Face metadata endpoints are allowed")
    request = Request(url, headers={"User-Agent": "Dordiai-metadata-audit/1",
                                   "Accept": "application/json"})
    try:
        with opener(request, timeout=20) as response:
            raw = response.read(MAX_BODY + 1)
            if len(raw) > MAX_BODY:
                raise ValueError("Metadata response exceeds bounded quota")
            code = response.status
            final = response.geturl()
            if not final.startswith(HOST + "/"):
                raise ValueError("Metadata redirect left the primary host")
    except HTTPError as error:
        raw = error.read(65537)
        if len(raw) > 65536:
            raw = raw[:65536]
        return {"url": url, "http_status": error.code,
                "classification": "actual-http-error", "body_sha256": sha256(raw).hexdigest(),
                "error_excerpt": raw.decode("utf-8", "replace")[:240]}
    except (URLError, TimeoutError, OSError) as error:
        return {"url": url, "http_status": None, "classification": "transport-error",
                "error_type": type(error).__name__, "error": str(error)[:240]}
    result = {"url": url, "http_status": code, "classification": "actual-http-response",
              "final_url": final, "body_sha256": sha256(raw).hexdigest(),
              "body_size_bytes": len(raw)}
    try:
        result["json"] = json.loads(raw)
    except (UnicodeError, ValueError):
        result["classification"] = "invalid-json-response"
    return result


def repo_summary(response, expected_id):
    body = response.get("json")
    if response.get("http_status") != 200 or not isinstance(body, dict):
        return None
    if body.get("id") != expected_id or not re.fullmatch("[0-9a-f]{40}", body.get("sha", "")):
        raise ValueError("Primary repository metadata identity differs")
    files = sorted(row["rfilename"] for row in body.get("siblings", [])
                   if isinstance(row, dict) and isinstance(row.get("rfilename"), str))
    return {"id": body["id"], "revision": body["sha"],
            "pipeline_tag": body.get("pipeline_tag"), "gated": body.get("gated"),
            "private": body.get("private"), "card_language": (body.get("cardData") or {}).get("language"),
            "file_names": files}


def matching_paths(files, code):
    """Exact component/stem only: never nbl->nde, ton->tn, hmo->meu."""
    if not re.fullmatch("[a-z]{3}", code):
        raise ValueError("An exact ISO639-3 code is required")
    output = []
    for name in files:
        parts = PurePosixPath(name).parts
        if code in parts or any(part in {code + suffix for suffix in
                                         (".pt", ".pth", ".bin", ".safetensors", ".tar.gz", ".zip")}
                                for part in parts):
            output.append(name)
    return sorted(output)


def concise(response):
    return {key: value for key, value in response.items() if key != "json"}


def audit(fetch=metadata):
    consolidated = fetch(HOST + "/api/models/facebook/mms-tts")
    catalogue = repo_summary(consolidated, "facebook/mms-tts")
    control_response = fetch(HOST + "/api/models/facebook/mms-tts-hau")
    control = repo_summary(control_response, "facebook/mms-tts-hau")
    if catalogue is None or control is None or not (
            {"model.safetensors", "pytorch_model.bin"} & set(control["file_names"])):
        raise ValueError("Primary consolidated and real Hausa model controls did not verify")
    tree_base = HOST + "/api/models/facebook/mms-tts/tree/" + catalogue["revision"] + "/models/"
    control_tree = fetch(tree_base + "hau")
    directory_pattern_verified = (control_tree.get("http_status") == 200
                                  and isinstance(control_tree.get("json"), list)
                                  and any(row.get("type") == "file"
                                          for row in control_tree["json"] if isinstance(row, dict)))
    def one(row):
        selected, code = row
        expected = "facebook/mms-tts-" + code
        reply = fetch(HOST + "/api/models/" + expected)
        summary = repo_summary(reply, expected)
        tree = fetch(tree_base + code)
        native = {"selected_code": selected, "native_iso639_3": code,
                  "individual_repository": concise(reply), "repository_metadata": summary,
                  "consolidated_exact_paths": matching_paths(catalogue["file_names"], code),
                  "consolidated_directory": concise(tree),
                  "directory_pattern_verified_by_actual_hau": directory_pattern_verified,
                  "model_ready": False, "native_listener_verified": False}
        if reply.get("http_status") == 404:
            native["individual_lookup_result"] = "actual-primary-HTTP404"
        elif reply.get("http_status") in (401, 403):
            native["individual_lookup_result"] = "public-access-denied-or-hidden-not-proof-of-nonexistence"
        elif summary is not None:
            native["individual_lookup_result"] = "actual-primary-model-metadata-further-native-provenance-and-runtime-validation-required"
        else:
            native["individual_lookup_result"] = "inconclusive-transport-or-response"
        return native
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(one, ROWS))
    return {"format": "dordiai-mms-gap-http-audit", "format_version": 1,
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "scope": "Exact official model endpoints and consolidated metadata only; no acoustic assets downloaded",
            "consolidated": {**concise(consolidated), "id": catalogue["id"],
                             "revision": catalogue["revision"], "file_count": len(catalogue["file_names"])},
            "positive_control": {**concise(control_response), "metadata": control,
                                 "consolidated_directory": concise(control_tree)},
            "checks": rows,
            "cautions": ["HTTP401/403 and transport errors are never reported as HTTP404.",
                         "An actual directory404 is relevant only when the positive directory pattern succeeds.",
                         "No neighbouring language, IPA prototype, metadata entry, or PCM output establishes accepted native pronunciation.",
                         "Comorian varieties are kept separate; none establishes all varieties."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = audit()
    raw = (json.dumps(result, ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode()
    if len(raw) > 128 * 1024:
        raise ValueError("Bounded audit report exceeded128KiB")
    if args.output:
        if args.output.exists():
            raise FileExistsError("Audit output already exists")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("xb") as stream:
            stream.write(raw)
    print(raw.decode(), end="")


if __name__ == "__main__":
    main()
