"""Create and stream-verify four data-only ZIP backups of an immutable addon.

Requires the expected full SHA256 from release verification. No second full
addon is created. The source addon is never changed. Existing output folders
are refused, and a complete verified backup directory is published together.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import zipfile

import restore_core_backup as restorer


def _zip_info(name):
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def create_backup(source, output, *, version, expected_sha256):
    source, output = Path(source), Path(output)
    restorer._basename(version)
    restorer._sha(expected_sha256)
    if source.is_symlink() or not source.is_file() or not source.name.endswith(".nvda-addon"):
        raise ValueError("Backup source must be a regular .nvda-addon file")
    restorer._basename(source.name)
    if output.exists() or output.is_symlink():
        raise FileExistsError("Backup output folder already exists; choose a new folder")
    total = restorer._size(source.stat().st_size)
    chunk_bytes = (total + 3) // 4
    if total < 4 or chunk_bytes + 1024 > restorer.MAX_CHUNK_BYTES:
        raise ValueError("Source cannot fit into four ZIP files below the backup limit")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".dordiai-backup-", dir=output.parent))
    published = False
    try:
        records, offset, source_hash = [], 0, hashlib.sha256()
        with source.open("rb") as stream:
            for index in range(1, 5):
                filename = f"dordiai-core-{version}-backup-{index:03d}.zip"
                member = f"dordiai-core-{version}-chunk-{index:03d}.bin"
                path = stage / filename
                count, size, raw_hash = total // 4 + int(index <= total % 4), 0, hashlib.sha256()
                with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
                    with archive.open(_zip_info(member), "w", force_zip64=True) as target:
                        while size < count:
                            data = stream.read(min(restorer.BLOCK_BYTES, count - size))
                            if not data:
                                raise ValueError("Source addon shrank during backup")
                            target.write(data)
                            raw_hash.update(data)
                            source_hash.update(data)
                            size += len(data)
                if path.stat().st_size > restorer.MAX_CHUNK_BYTES:
                    raise ValueError("Backup ZIP exceeds its limit")
                records.append({"index": index, "offset_bytes": offset, "zip_filename": filename,
                    "zip_size_bytes": path.stat().st_size, "zip_sha256": restorer.file_sha256(path),
                    "member_name": member, "raw_size_bytes": size, "raw_sha256": raw_hash.hexdigest()})
                offset += size
                print(f"Created backup {index}/4: {path.stat().st_size:,} bytes", flush=True)
            if stream.read(1) or offset != total or source_hash.hexdigest() != expected_sha256:
                raise ValueError("Source addon differs from the expected release SHA256")
        tool = stage / "restore_core_backup.py"
        shutil.copyfile(Path(restorer.__file__), tool)
        recovery_tool = stage / "recover_core_baseline.py"
        shutil.copyfile(Path(__file__).with_name(recovery_tool.name), recovery_tool)
        manifest_name = f"dordiai-core-{version}-backup-manifest.json"
        manifest_path = stage / manifest_name
        manifest = {"format": restorer.FORMAT, "format_version": 1, "version": version,
            "source_filename": source.name, "source_size_bytes": total, "source_sha256": expected_sha256,
            "chunks": records, "backup_parts_are_not_standalone_installers": True,
            "restore_tool": {"filename": tool.name, "sha256": restorer.file_sha256(tool)},
            "baseline_recovery_tool": {"filename": recovery_tool.name, "sha256": restorer.file_sha256(recovery_tool)},
            "restore_command": f"python restore_core_backup.py --manifest {manifest_name}",
            "verify_without_duplicate_output_command": f"python restore_core_backup.py --manifest {manifest_name} --verify-only"}
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (stage / "README_UK.txt").write_text(
            f"Резервні частини dordiai-voices {version}\n\n"
            "Ці чотири ZIP — резервні частини одного файла, а не окремі інсталятори NVDA. "
            "Збережіть усі чотири ZIP, опис JSON і restore_core_backup.py в одну папку. "
            "Python не потребує додаткових бібліотек.\n\n"
            "Перевірка всіх частин без створення другого великого файла:\n" + manifest["verify_without_duplicate_output_command"] +
            "\n\nВідновлення повного початкового .nvda-addon:\n" + manifest["restore_command"] +
            "\n\nДля іншого шляху додайте --output потрібний_файл.nvda-addon. "
            "Засіб перевіряє порядок, контрольні суми ZIP, внутрішніх блоків та остаточного файла. "
            "Наявний інший файл не перезаписується. Перевірений результат публікується атомарно: "
            "у Windows перейменуванням без перезапису, у Linux/macOS жорстким посиланням "
            "на тій самій файловій системі.\n\nМінімальна база для продовження розробки без початкового Drive:\n"
            f"python recover_core_baseline.py --archive {source.name} --output recovered-core-baseline --expected-sha256 {expected_sha256}\n"
            "Це відновлює лише ресурси ядра; відсутні додаткові мовні пакети потребують власних ZIP.\n\n"
            "Очікувана остаточна SHA-256:\n" + expected_sha256 + "\n",
            encoding="utf-8")
        verification = restorer.restore(manifest_path, verify_only=True)
        helper_name = f"dordiai-core-{version}-backup-tools.zip"
        helper = stage / helper_name
        with zipfile.ZipFile(helper, "w", compression=zipfile.ZIP_STORED) as archive:
            for path in (manifest_path, tool, recovery_tool, stage / "README_UK.txt"):
                archive.writestr(_zip_info(path.name), path.read_bytes())
        evidence = {"format": "dordiai-core-backup-verification", "format_version": 1, "version": version,
            "source_filename": source.name, "source_size_bytes": total, "source_sha256": expected_sha256,
            "parts": records, "maximum_zip_bytes": max(row["zip_size_bytes"] for row in records),
            "real_stream_reconstruction_verified": True, "verification": verification,
            "verification_output_file_created": False, "original_core_modified": False,
            "manifest_filename": manifest_name, "manifest_sha256": restorer.file_sha256(manifest_path),
            "restore_tool_sha256": restorer.file_sha256(tool),
            "baseline_recovery_tool_sha256": restorer.file_sha256(recovery_tool),
            "helper_bundle": {"filename": helper_name, "size_bytes": helper.stat().st_size,
                              "sha256": restorer.file_sha256(helper)},
            "backup_parts_are_not_standalone_installers": True}
        if output.exists() or output.is_symlink():
            raise FileExistsError("Backup output folder appeared during creation")
        os.rename(stage, output)
        published = True
        return evidence
    finally:
        if not published:
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    evidence = create_backup(args.source, args.output, version=args.version, expected_sha256=args.expected_sha256)
    if args.evidence:
        args.evidence.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "source_sha256": evidence["source_sha256"],
                      "maximum_zip_bytes": evidence["maximum_zip_bytes"], "stream_verified": True}))


if __name__ == "__main__":
    main()
