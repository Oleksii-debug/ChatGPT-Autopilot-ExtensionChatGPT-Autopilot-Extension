#!/usr/bin/env python3
"""Reproducible High hotfix: keep the exact previous product file set + new local dependencies."""
import argparse
import hashlib
import json
import pathlib
import posixpath
import re
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--base', type=pathlib.Path, default=ROOT / 'releases/11.0.1/ChatGPT-Autopilot-11.0.1-HIGH-2026-09-30.zip')
parser.add_argument('--out-dir', type=pathlib.Path, default=ROOT / 'releases/11.0.2')
args = parser.parse_args()
version = json.loads((ROOT / 'package.json').read_text())['version']
manifest = json.loads((ROOT / 'manifest.json').read_text())
assert manifest['version'] == version
assert "forceHighEffort: true" in (ROOT / 'src/config/execution-policy.js').read_text()
with zipfile.ZipFile(args.base) as old:
    assert old.testzip() is None
    files = {name.split('/', 1)[1] for name in old.namelist() if not name.endswith('/')}
files.update({f'CHANGES-{version}.txt', f'QA-{version}.txt'})
# Discover newly introduced local dependencies from the product entry points.
imports = re.compile(r'''(?:from\s*|import\s*\()(['"])([^'"]+)\1''')
queue = list(files)
while queue:
    name = queue.pop()
    assert not name.startswith('/') and '..' not in pathlib.PurePosixPath(name).parts
    if not name.endswith(('.js', '.mjs')):
        continue
    for _, relative in imports.findall((ROOT / name).read_text()):
        if not relative.startswith('.'):
            continue
        dependency = posixpath.normpath(posixpath.join(posixpath.dirname(name), relative))
        assert (ROOT / dependency).is_file(), (name, dependency)
        if dependency not in files:
            assert dependency.startswith(('src/', 'companion/')), dependency
            files.add(dependency)
            queue.append(dependency)
args.out_dir.mkdir(parents=True, exist_ok=True)
name = f'ChatGPT-Autopilot-{version}-HIGH-2026-09-30.zip'
output = args.out_dir / name
prefix = f'ChatGPT-Autopilot-{version}-HIGH'
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for relative in sorted(files):
        data = (ROOT / relative).read_bytes()
        if pathlib.Path(relative).suffix in {'.js', '.mjs', '.json', '.html', '.css', '.md', '.txt', '.cmd', '.ps1', '.cs'}:
            assert b'\0' not in data
            text = data.decode()
            assert not re.search(r'\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{20,}', text), relative
        info = zipfile.ZipInfo(f'{prefix}/{relative}', (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert json.loads(archive.read(f'{prefix}/manifest.json'))['version'] == version
    for relative in files:
        assert archive.read(f'{prefix}/{relative}') == (ROOT / relative).read_bytes()
sha256 = hashlib.sha256(output.read_bytes()).hexdigest()
(args.out_dir / 'SHA256SUMS.txt').write_text(f'{sha256}  {name}\n')
print(json.dumps({'zip': str(output.resolve()), 'files': len(files), 'bytes': output.stat().st_size, 'sha256': sha256}))
