"""Import only a previously verified own Afri source artifact as unattached Git blobs.

No source from the artifact is executed. There is no commit/tree/ref update API.
"""
from __future__ import annotations
import argparse
import base64
from hashlib import sha1, sha256
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = "Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension"
ARTIFACT = 14755512807
ARTIFACT_BYTES = 141240
ARTIFACT_SHA256 = "f073cbee60fe7eb1ac7984895d343c79dbe7a30f6ab129a3fa2324b0fb24a16d"
SOURCE_RUN = 45024624013
G2P_REVISION = "76b53a8fa2a688812e369837d179d4710c111a7a"
LANGUAGES = {"ss":"ssw","ve":"ven","zu":"zul","wo":"wol","nso":"nso"}
DESTINATION = "dordiai-voices/source/0.12.2/kx47Runtime/"
FILES = {
  "vendor_afri_g2p/DATA_LICENSE.md": {
    "bytes": 1831,
    "git_blob_sha1": "8bb79af373ed6eca88e51d82c5298d42648d3d07"
  },
  "vendor_afri_g2p/UPSTREAM-PYPROJECT.toml": {
    "bytes": 2181,
    "git_blob_sha1": "d42f9cf5e2744c882df7e6c3f540ae96dc47f2f6"
  },
  "vendor_afri_g2p/africa_g2p/__init__.py": {
    "bytes": 1390,
    "git_blob_sha1": "a05b1f717c68e93f3fd526e405740442f49285e9"
  },
  "vendor_afri_g2p/africa_g2p/convert.py": {
    "bytes": 43529,
    "git_blob_sha1": "cf6e3c5c8911c8d5ef88e5c85ca797883fb3e274"
  },
  "vendor_afri_g2p/africa_g2p/data/ipa_universal_graphemes.json": {
    "bytes": 429875,
    "git_blob_sha1": "830093ea3ca53aea7b97dd1ea3fc749e766faf6d"
  },
  "vendor_afri_g2p/africa_g2p/data/plain_latin_languages.json": {
    "bytes": 1074,
    "git_blob_sha1": "b63654c9542dc6bbd5c48b1c7858e83ad2ff5a04"
  },
  "vendor_afri_g2p/africa_g2p/data/proxy_escapes.json": {
    "bytes": 20089,
    "git_blob_sha1": "613e5f19321612c8a20466fde4822267d163773b"
  },
  "vendor_afri_g2p/africa_g2p/data/proxy_fidelity.json": {
    "bytes": 91354,
    "git_blob_sha1": "d5a522351f381cbcfe79ff1e9b200405f17470fd"
  },
  "vendor_afri_g2p/africa_g2p/data/registry.json": {
    "bytes": 143399,
    "git_blob_sha1": "023158a6aa24426f88d7342209f8643546a2d652"
  },
  "vendor_afri_g2p/africa_g2p/data/universal_fallback.json": {
    "bytes": 48144,
    "git_blob_sha1": "c96a53c982675975d110d9768dd95cbe9e096e53"
  },
  "vendor_afri_g2p/africa_g2p/english.py": {
    "bytes": 5174,
    "git_blob_sha1": "ce4ff3dedda61409855527ed9abceb568c97edaa"
  },
  "vendor_afri_g2p/africa_g2p/fallback.py": {
    "bytes": 4279,
    "git_blob_sha1": "a6282d877053f48abc8ae64e59c50607ca83e25d"
  },
  "vendor_afri_g2p/africa_g2p/g2p.py": {
    "bytes": 14511,
    "git_blob_sha1": "19ba1192446eba7b927163c8c2557bc2461771d1"
  },
  "vendor_afri_g2p/africa_g2p/languages/nso.json": {
    "bytes": 2090,
    "git_blob_sha1": "9cd3bbc84d498b642e3f43c32b9e6423cc34546c"
  },
  "vendor_afri_g2p/africa_g2p/languages/ssw.json": {
    "bytes": 2579,
    "git_blob_sha1": "a345d589d643f6c09508f9fa199e6717f46b4b17"
  },
  "vendor_afri_g2p/africa_g2p/languages/ven.json": {
    "bytes": 2625,
    "git_blob_sha1": "c7310a735f700bf80c97e9f5d3a2d5b5e5ba0b5f"
  },
  "vendor_afri_g2p/africa_g2p/languages/wol.json": {
    "bytes": 2877,
    "git_blob_sha1": "6743b3e5c6a57ddbd97001f45299599792c632ba"
  },
  "vendor_afri_g2p/africa_g2p/languages/zul.json": {
    "bytes": 2456,
    "git_blob_sha1": "4bdc6a9a9fae91915f8a1b2dc2eb398c7afe5dff"
  },
  "vendor_afri_g2p/africa_g2p/loader.py": {
    "bytes": 1655,
    "git_blob_sha1": "614bd4ae262d5be5a2e3ba4c9cc622f7d7cbe10e"
  },
  "vendor_afri_g2p/africa_g2p/normalizer.py": {
    "bytes": 6888,
    "git_blob_sha1": "d418da3e414f65c73c8a06c6afd4a05597130411"
  },
  "vendor_afri_g2p/africa_g2p/pipeline.py": {
    "bytes": 2166,
    "git_blob_sha1": "e9824c32dcece2c2e2842c906193d14ff5d6ec43"
  },
  "wide_afri_six.py": {
    "git_blob_sha1": "8b23c8a15fac1cc0f219115f4853907c85db2264",
    "bytes": 20370
  },
  "wide_afri_frontend.py": {
    "git_blob_sha1": "a6a765b5ffc28d6c825340a16df528a75d310120",
    "bytes": 2939
  }
}
MANIFEST = "vendor_afri_g2p/dordiai-vendor.json"
VENDOR = {name.removeprefix("vendor_afri_g2p/"): row for name,row in FILES.items()
          if name.startswith("vendor_afri_g2p/")}


def git_blob(data):
    return sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def unique_pairs(items):
    result = {}
    for key,value in items:
        if key in result:
            raise ValueError("Duplicate metadata key")
        result[key] = value
    return result



def reviewed_bytes(name, data, expected):
    """Only own two Python files may undo Windows CRLF; vendor bytes never change."""
    if name in ("wide_afri_six.py","wide_afri_frontend.py"):
        if b"\r" in data.replace(b"\r\n",b""):
            raise ValueError("Bare CR is not an approved source transformation")
        data = data.replace(b"\r\n",b"\n")
    if len(data) != expected["bytes"] or git_blob(data) != expected["git_blob_sha1"]:
        raise ValueError("Reviewed source Git SHA/size differs: " + name)
    return data

def validated_payload(raw, files=FILES, vendor=VENDOR):
    """Validate the entire archive before publishing ANY Git object."""
    expected = set(files) | {MANIFEST}
    allowed_dirs = {str(parent)+"/" for name in expected for parent in PurePosixPath(name).parents
                    if str(parent) != "."}
    result, seen = {}, set()
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if len(archive.infolist()) > 50:
            raise ValueError("Unexpected artifact entry count")
        for entry in archive.infolist():
            name = entry.filename
            parts = name.rstrip("/").split("/")
            if ("\\" in name or ":" in name or "\0" in name or name.startswith("/")
                    or any(part in ("", ".", "..") for part in parts)):
                raise ValueError("Invalid artifact member path")
            if name.casefold() in seen:
                raise ValueError("Duplicate artifact member")
            seen.add(name.casefold())
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if entry.is_dir():
                if name not in allowed_dirs or kind not in (0, stat.S_IFDIR):
                    raise ValueError("Unexpected artifact directory")
                continue
            if name not in expected or kind not in (0, stat.S_IFREG) or entry.flag_bits & 1:
                raise ValueError("Unexpected or linked artifact member")
            own_python = name in ("wide_afri_six.py","wide_afri_frontend.py")
            limit = files[name]["bytes"] * (2 if own_python else 1) if name in files else 16384
            if entry.file_size > limit or name in files and not own_python and entry.file_size != limit:
                raise ValueError("Artifact member size differs: " + name + " actual=" + str(entry.file_size) + " expected=" + str(limit))
            with archive.open(entry) as source:
                data = source.read(limit + 1)
            if len(data) != entry.file_size:
                raise ValueError("Expanded member size differs")
            data.decode("utf-8")  # Every reviewed core source asset must remain text.
            result[name] = reviewed_bytes(name,data,files[name]) if name in files else data
    if set(result) != expected:
        raise ValueError("Missing reviewed artifact member")
    manifest = json.loads(result[MANIFEST], object_pairs_hook=unique_pairs)
    if (manifest.get("revision") != G2P_REVISION or manifest.get("languages") != LANGUAGES
            or manifest.get("files") != vendor
            or set(manifest) != {"revision","languages","files","scope","code_license"}
            or manifest["scope"] != "Exact primary source subset; only five native charts are shipped"
            or manifest["code_license"] != "Apache-2.0 declared upstream; DATA_LICENSE.md retains separate source notices"):
        raise ValueError("Artifact vendor manifest differs from the reviewed native subset")
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def acquire(token):
    endpoint = "https://api.github.com/repos/" + REPOSITORY + "/actions/artifacts/" + str(ARTIFACT) + "/zip"
    request = urllib.request.Request(endpoint, headers={"Authorization":"Bearer "+token,
        "Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"Dordiai-owned-source-import"})
    try:
        urllib.request.build_opener(NoRedirect()).open(request, timeout=60)
    except urllib.error.HTTPError as response:
        if response.code != 302:
            raise RuntimeError("GitHub artifact acquisition failed with HTTP " + str(response.code)) from None
        target = response.headers["Location"]
    else:
        raise ValueError("Expected artifact storage redirect")
    parsed = urllib.parse.urlsplit(target)
    host = parsed.hostname or ""
    if parsed.scheme != "https" or not (host.endswith(".blob.core.windows.net") or host.endswith(".actions.githubusercontent.com")):
        raise ValueError("Unexpected artifact storage redirect host")
    # A fresh request deliberately omits the GitHub token on the storage host.
    with urllib.request.urlopen(urllib.request.Request(target, headers={"User-Agent":"Dordiai-owned-source-import"}), timeout=90) as response:
        raw = response.read(ARTIFACT_BYTES + 1)
    if len(raw) != ARTIFACT_BYTES or sha256(raw).hexdigest() != ARTIFACT_SHA256:
        raise ValueError("Own immutable artifact ZIP SHA/size differs")
    return raw


def publish_blob(token, data):
    endpoint = "https://api.github.com/repos/" + REPOSITORY + "/git/blobs"
    body = json.dumps({"encoding":"base64","content":base64.b64encode(data).decode("ascii")}).encode("utf-8")
    request = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "Authorization":"Bearer "+token,"Accept":"application/vnd.github+json",
        "Content-Type":"application/json","X-GitHub-Api-Version":"2022-11-28",
        "User-Agent":"Dordiai-owned-source-import"})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=60) as response:
            result = json.loads(response.read(65537))
    except urllib.error.HTTPError as error:
        raise RuntimeError("Git blob publication failed with HTTP " + str(error.code)) from None
    if result.get("sha") != git_blob(data):
        raise ValueError("GitHub blob does not preserve exact reviewed bytes")
    return result["sha"]



def inspect_owned(raw):
    """Metadata only after exact outer ZIP pin; no source execution or Git write."""
    rows, seen = [], set()
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            name = entry.filename
            if name not in set(FILES)|{MANIFEST} or name.casefold() in seen:
                raise ValueError("Unexpected/duplicate source artifact member")
            seen.add(name.casefold())
            if entry.file_size > 1024**2:
                raise ValueError("Oversized reviewed text source")
            data = archive.read(entry)
            row = {"path":name,"raw_bytes":len(data),"raw_git_blob":git_blob(data),
                   "raw_sha256":sha256(data).hexdigest(),"expected":FILES.get(name),
                   "crlf_pairs":data.count(b"\r\n")}
            if name in ("wide_afri_six.py","wide_afri_frontend.py"):
                canonical = data.replace(b"\r\n",b"\n")
                row.update(lf_bytes=len(canonical),lf_git_blob=git_blob(canonical),
                           lf_matches_reviewed_pin=(len(canonical)==FILES[name]["bytes"]
                               and git_blob(canonical)==FILES[name]["git_blob_sha1"]))
            rows.append(row)
            print("AFRI_SOURCE_RAW_MEMBER "+json.dumps(row,sort_keys=True),flush=True)
    if seen != {name.casefold() for name in set(FILES)|{MANIFEST}}:
        raise ValueError("Missing source artifact member")
    return rows

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--archive", type=Path, help="Verify a local exact archive instead of downloading")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--inspect-only", action="store_true", help="Print exact bounded ZIP member pins; never publish")
    args = parser.parse_args()
    if args.report.exists() or args.report.is_symlink():
        parser.error("Report must be a new owned path")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token and (not (args.verify_only or args.inspect_only) or args.archive is None):
        parser.error("GitHub token required for acquisition or unattached blob publication")
    raw = args.archive.read_bytes() if args.archive is not None else acquire(token)
    if len(raw) != ARTIFACT_BYTES or sha256(raw).hexdigest() != ARTIFACT_SHA256:
        raise ValueError("Full immutable artifact pin differs")
    if args.inspect_only:
        report = {"format":"dordiai-exact-owned-source-artifact-inspection","artifact_id":ARTIFACT,
                  "artifact_sha256":ARTIFACT_SHA256,"files":inspect_owned(raw),
                  "source_executed":False,"git_blobs_created":False,"refs_updated":False}
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
        return 0
    raw_members = inspect_owned(raw)
    payload = validated_payload(raw)
    report = {"format":"dordiai-reviewed-afri-source-import-v1",
              "artifact_id":ARTIFACT,"artifact_sha256":ARTIFACT_SHA256,"source_run":SOURCE_RUN,
              "all_files_verified_before_writes":True,"source_executed":False,
              "source_byte_normalisations":[row for row in raw_members
                  if row["path"] in ("wide_afri_six.py","wide_afri_frontend.py")],
              "vendor_source_bytes_transformed":False,
              "refs_updated":False,"trees_or_commits_created":False,
              "mode":"verify-only" if args.verify_only else "unattached-git-blobs-only","files":[]}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    for name,data in sorted(payload.items()):
        expected = git_blob(data)
        blob = expected if args.verify_only else publish_blob(token,data)
        row = {"path":DESTINATION+name,"sha":blob,"bytes":len(data),"sha256":sha256(data).hexdigest()}
        report["files"].append(row)
        args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        print("AFRI_UNATTACHED_SOURCE " + json.dumps(row,sort_keys=True),flush=True)
    report["status"] = "all24-reviewed-source-assets-verified" if args.verify_only else "all24-unattached-blobs-created-no-ref-change"
    args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print("AFRI_SOURCE_IMPORT_SUMMARY " + json.dumps({k:report[k] for k in ("status","artifact_id","refs_updated","source_executed")}),flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
