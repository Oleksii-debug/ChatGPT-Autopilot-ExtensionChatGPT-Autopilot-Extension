"""Build separate offline model packs from pinned, actually prepared resources."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

from build_release import ROOT
from build_resource_pack import create_resource_pack
import package_manager

MINIMUM_CORE_VERSION = "0.13.1-dev.1"
PACK_VERSION = "1.0.0"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


@contextmanager
def selected_files(source, names):
    """Whitelist runtime assets without moving/deleting preparation originals."""
    source = Path(source)
    with tempfile.TemporaryDirectory(prefix="dordiai-model-pack-") as temporary:
        temporary = Path(temporary)
        for name in names:
            original = source / name
            if original.is_symlink() or not original.is_file():
                raise ValueError("Missing/unsafe required runtime resource: " + str(original))
            target = temporary / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if original.stat().st_size <= 1024 * 1024:
                # Freeze small metadata even if a preparation job appends a
                # later test result. Large prepared weights remain immutable.
                shutil.copyfile(original, target)
                continue
            try:
                os.link(original, target)
            except OSError:
                shutil.copyfile(original, target)
        yield temporary


def save_group(root, group, packages, merge_packages=False, **details):
    path = Path(root) / "evidence/new_resource_pack_summary.json"
    result = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {
        "format": "dordiai-prepared-resource-packs", "format_version": 1, "groups": {},
        "default_installation": False, "complete_product": False,
    }
    if merge_packages:
        merged = {row["id"]: row for row in result["groups"].get(group, {}).get("packages", [])}
        merged.update({row["id"]: row for row in packages})
        packages = list(merged.values())
    result["groups"][group] = dict(details, minimum_core_version=MINIMUM_CORE_VERSION, packages=packages,
                                  package_count=len(packages), download_bytes=sum(x["size_bytes"] for x in packages),
                                  installed_payload_bytes=sum(x["installed_bytes"] for x in packages))
    temporary = path.with_suffix(".json.part")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)
    return result["groups"][group]


def build_mms_packs(root=ROOT, output=None, workers=2):
    root = Path(root)
    output = Path(output or root / "dist/language-packs")
    evidence = json.loads((root / "evidence/mms_preparation.json").read_text(encoding="utf-8"))
    selected = json.loads((root / "selected_languages.json").read_text(encoding="utf-8"))["languages"]
    order = {row["id"]: i for i, row in enumerate(selected)}
    labels = {row["id"]: row["name_uk"] for row in selected}
    source = root / "model-packs/mms/kx47Runtime/models/MMS"
    codes = sorted((p.name for p in source.iterdir() if p.is_dir()),
                   key=lambda code: order.get(code, order.get("tamazight", 10000) if code == "kab" else 10000))

    def build_one(code):
        directory = source / code
        prepared = evidence["models"][code]
        if prepared.get("status") != "prepared-real-onnx-carrier":
            raise ValueError("MMS resource was not actually prepared: " + code)
        expected = {"model.onnx": prepared["model_sha256"], "tokens.txt": prepared["tokens_sha256"],
                    "source.npy": prepared["source_identity"]["source_sha256"]}
        for name, checksum in expected.items():
            if digest(directory / name) != checksum:
                raise ValueError("Prepared MMS resource changed: " + code + "/" + name)
        identity = "mms-" + code
        name = "MMS — " + labels.get(code, "Кабільська (частина групи Тамазигхт)" if code == "kab" else code)
        provenance = {"repo_id": evidence["repo_id"], "revision": evidence["revision"],
                      "standard": prepared["standard"], "model_sha256": expected["model.onnx"],
                      "source_sha256": expected["source.npy"], "tokens_sha256": expected["tokens.txt"],
                      "preparation_evidence": "evidence/mms_preparation.json"}
        quality = {"actual_carrier_cpu_onnx_verified": True, "native_pronunciation_verified": False,
                   "navigation_verified": False, "windows_nvda_verified": False}
        extra = {"license": evidence["license"], "experimental": True, "provenance": provenance,
                 "quality_validation": quality}
        if code == "kab":
            extra.update(catalogue_group="tamazight", coverage_scope="Kabyle only; not Standard Moroccan Tamazight")
        with selected_files(directory, ["NOTICE.txt", "config.json", "model.onnx", "tokens.txt", "source.npy"]) as stage:
            record = create_resource_pack(stage, output / f"dordiai-{identity}-{PACK_VERSION}.zip",
                                          prefix="kx47Runtime/models/MMS/" + code, identity=identity, name=name,
                                          version=PACK_VERSION, minimum_core_version=MINIMUM_CORE_VERSION,
                                          languages=[code], engine_ids=["mms-onnx"], metadata_extra=extra)
        record.update(id=identity, code=code, backend="mms-onnx", license=evidence["license"],
                      model_sha256=expected["model.onnx"], source_sha256=expected["source.npy"],
                      experimental=True, native_pronunciation_verified=False, windows_nvda_verified=False)
        print(f"Built {identity}: {record['size_bytes']:,} bytes", flush=True)
        return record

    with ThreadPoolExecutor(max_workers=workers) as pool:
        packages = list(pool.map(build_one, codes))
    return save_group(root, "mms", packages, selected_languages=28, additional_partial_variants=["kab"],
                      upstream_revision=evidence["revision"], backend="mms-onnx")


def build_extra_packs(root=ROOT, output=None, workers=2, codes=("sat", "st", "xh", "ig", "ln", "nd")):
    root, output = Path(root), Path(output or Path(root) / "dist/language-packs")
    labels = {row["id"]: row["name_uk"] for row in json.loads((root / "selected_languages.json").read_text(encoding="utf-8"))["languages"]}

    def build_one(code):
        candidates = [stage / "kx47Runtime/models/ExtraLanguages" / code
                      for stage in sorted((root / "model-packs").iterdir()) if stage.is_dir()]
        if sum(p.is_dir() for p in candidates) > 1:
            raise ValueError("Ambiguous prepared model directories: " + code)
        directory = next((p for p in candidates if p.is_dir()), None)
        if directory is None:
            raise ValueError("No prepared extra model: " + code)
        runtime = json.loads((directory / "runtime_config.json").read_text(encoding="utf-8"))
        model_hash, source_hash = digest(directory / "model.onnx"), digest(directory / "source.npy")
        if runtime.get("format") == "dordiai-simba-onnx-v1":
            proof = runtime["source_identity"]
            if proof["graph_sha256"] != model_hash or proof["source_identity_sha256"] != source_hash:
                raise ValueError("Simba model changed after native preparation: " + code)
            license_name, provenance = "CC-BY-NC-4.0 MMS-derived; preserve included upstream notices", runtime["provenance"]
        elif runtime.get("format") == "dordiai-coqui-onnx-v1":
            if runtime["model_sha256"] != model_hash or runtime["source_identity"]["source_sha256"] != source_hash:
                raise ValueError("Coqui model changed after native preparation: " + code)
            license_name = runtime["license"]
            provenance = {key: runtime[key] for key in ("repo_id", "revision", "iso_code")}
        elif code == "sat":
            license_name = "Apache-2.0"
            provenance = json.loads((directory / "source.json").read_text(encoding="utf-8"))
        else:
            raise ValueError("Unrecognized prepared native model format: " + code)
        names = [p.name for p in directory.iterdir() if p.is_file() and p.suffix != ".wav"
                 and p.name not in {"native-probe.json", "runtime-probe.json"}]
        if not {"model.onnx", "config.json", "source.npy", "NOTICE.txt"} <= set(names):
            raise ValueError("Missing native extra runtime resource: " + code)
        identity = "extra-" + code
        extra = {"license": license_name, "experimental": True,
                 "provenance": provenance, "model_sha256": model_hash, "source_sha256": source_hash,
                 "quality_validation": {"actual_native_cpu_onnx_verified": True,
                     "native_pronunciation_verified": False, "navigation_verified": False, "windows_nvda_verified": False}}
        with selected_files(directory, names) as stage:
            record = create_resource_pack(stage, output / f"dordiai-{identity}-{PACK_VERSION}.zip",
                                          prefix="kx47Runtime/models/ExtraLanguages/" + code, identity=identity,
                                          name="Нейронний мовний пакет — " + labels.get(code, code),
                                          version=PACK_VERSION, minimum_core_version=MINIMUM_CORE_VERSION,
                                          languages=[code], engine_ids=["extra-onnx"], metadata_extra=extra)
        record.update(id=identity, code=code, backend="extra-onnx", license=license_name,
                      model_sha256=model_hash, source_sha256=source_hash, experimental=True,
                      native_pronunciation_verified=False, windows_nvda_verified=False)
        print(f"Built {identity}: {record['size_bytes']:,} bytes", flush=True)
        return record

    with ThreadPoolExecutor(max_workers=workers) as pool:
        packages = list(pool.map(build_one, codes))
    return save_group(root, "extra", packages, merge_packages=True, backend="extra-onnx")


def build_omni_packs(root=ROOT, output=None, references_only=False):
    root, output = Path(root), Path(output or Path(root) / "dist/language-packs")
    directory = root / "model-packs/extra-onnx/kx47Runtime/models/SharedOmniONNX"
    upstream = json.loads((directory / "source.json").read_text(encoding="utf-8"))
    names = ["backbone.int8.onnx", "vocoder.fp32.onnx", "vocoder.fp32.onnx.data", "tokenizer.json",
             "config.json", "tokenizer_config.json", "preprocessor_config.json", "chat_template.jinja",
             "README.md", "LICENSE-HIGGS-AUDIO-2.txt", "LICENSE-LLAMA3.txt", "UPSTREAM-LICENSE-NOTICE.txt", "source.json"]
    upstream_hashes = {row["file"]: row["sha256"] for row in upstream["files"]}
    for name in names:
        if name in upstream_hashes and digest(directory / name) != upstream_hashes[name]:
            raise ValueError("Shared Omni graph/resource changed: " + name)
    extra = {"experimental": True, "license": upstream["license"],
             "provenance": {"repository": upstream["repository"], "revision": upstream["revision"]},
             "preparation_only_encoder_excluded": True,
             "quality_validation": {"interactive_nvda_latency_verified": False,
                 "native_pronunciation_verified": False, "windows_nvda_verified": False},
             "user_notice": "Експериментальний повільний рушій; не встановлюється за замовчуванням."}
    common_archive = output / f"dordiai-shared-omni-onnx-{PACK_VERSION}.zip"
    if references_only:
        prior = package_manager.inspect_pack(common_archive)
        if prior.get("id") != "shared-omni-onnx" or prior.get("version") != PACK_VERSION or prior.get("minimum_core_version") != MINIMUM_CORE_VERSION:
            raise ValueError("Existing common Omni pack is not the expected model/core version")
        common = {"filename": common_archive.name, "size_bytes": common_archive.stat().st_size,
                  "sha256": digest(common_archive), "payload_files": len(prior["files"]),
                  "installed_bytes": sum(row["size_bytes"] for row in prior["files"].values())}
    else:
        with selected_files(directory, names) as stage:
            common = create_resource_pack(stage, common_archive,
                                      prefix="kx47Runtime/models/SharedOmniONNX", identity="shared-omni-onnx",
                                      name="Omni ONNX — спільна експериментальна модель (повільна)",
                                      version=PACK_VERSION, minimum_core_version=MINIMUM_CORE_VERSION,
                                      engine_ids=["omni-onnx"], metadata_extra=extra)
    common.update(id="shared-omni-onnx", backend="omni-onnx", experimental=True, preparation_encoder_excluded_bytes=(directory / "encoder.fp32.onnx").stat().st_size)
    packages = [common]
    inactive_alternatives = {"ig", "ln", "xh"}
    for reference in sorted((directory / "references").iterdir()):
        if not reference.is_dir():
            continue
        code = reference.name
        names = ["codes.npy", "text.txt", "source.npy"]
        identity = "omni-" + code
        metadata = dict(extra, reference_code=code, reference_source_sha256=digest(reference / "source.npy"),
                        reference_codes_sha256=digest(reference / "codes.npy"),
                        reference_text_sha256=digest(reference / "text.txt"),
                        default_catalogue_active=code not in inactive_alternatives)
        if code in inactive_alternatives:
            metadata["activation_status"] = "inactive-research-alternative; primary catalogue uses dedicated Extra model"
        label = ("Omni — неактивний дослідницький профіль " if code in inactive_alternatives
                 else "Omni — експериментальний мовний профіль ") + code
        with selected_files(reference, names) as stage:
            record = create_resource_pack(stage, output / f"dordiai-{identity}-{PACK_VERSION}.zip",
                                          prefix="kx47Runtime/models/SharedOmniONNX/references/" + code,
                                          identity=identity, name=label,
                                          version=PACK_VERSION, minimum_core_version=MINIMUM_CORE_VERSION,
                                          languages=[code], engine_ids=["omni-onnx"], dependencies=["shared-omni-onnx"],
                                          dependency_versions={"shared-omni-onnx": PACK_VERSION},
                                          metadata_extra=metadata)
        record.update(id=identity, code=code, backend="omni-onnx", experimental=True,
                      dependencies=["shared-omni-onnx"], source_sha256=metadata["reference_source_sha256"])
        record.update(default_catalogue_active=code not in inactive_alternatives,
                      distributable_catalogue_entry=code not in inactive_alternatives,
                      dependency_versions={"shared-omni-onnx": PACK_VERSION})
        packages.append(record)
    return save_group(root, "omni", packages, backend="omni-onnx", runtime_reference_languages=len(packages) - 1,
                      active_reference_languages=7, inactive_research_reference_codes=sorted(inactive_alternatives),
                      experimental=True, interactive_nvda_latency_verified=False,
                      preparation_encoder_excluded_bytes=(directory / "encoder.fp32.onnx").stat().st_size)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--group", action="append", choices=["mms", "extra", "omni"])
    parser.add_argument("--extra-code", action="append")
    parser.add_argument("--references-only", action="store_true", help="Reuse the existing shared Omni model ZIP")
    args = parser.parse_args()
    if not 1 <= args.workers <= 8:
        parser.error("workers must be between 1 and 8")
    for name in args.group or ["mms"]:
        if name == "mms":
            group = build_mms_packs(args.root, args.output, args.workers)
        elif name == "extra":
            group = build_extra_packs(args.root, args.output, args.workers,
                                      args.extra_code or ("sat", "st", "xh", "ig", "ln", "nd"))
        else:
            group = build_omni_packs(args.root, args.output, args.references_only)
        print(json.dumps({key: value for key, value in group.items() if key != "packages"}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
