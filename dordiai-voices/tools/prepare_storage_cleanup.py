"""Prepare a bounded cleanup manifest from the read-only local inventory."""
import collections
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import sys

folder = Path(__file__).resolve().parents[1] / 'windows-evidence/storage-cleanup-20261122'
inventory = folder / (sys.argv[1] if len(sys.argv)>1 else 'inventory.json')
stem=inventory.stem
data = json.loads(inventory.read_text(encoding='utf8'))
data['unique_file_id_logical_bytes'] = None
data['file_ids_available_for_all_files'] = False
summary = {key: value for key, value in data.items() if key not in ('files', 'directories', 'hardlinked_paths')}
summary['archive_files'] = [dict(path=row['path'], bytes=row['bytes']) for row in data['files'] if row['path'].endswith('.nvda-addon')]
summary['level3'] = []
groups = collections.defaultdict(lambda: [0, 0])
for row in data['files']:
    parts = row['path'].split('/')
    if parts[0] in ('Основний синтезатор', 'Другий синтезатор', 'Перевірка'):
        key = '/'.join(parts[:3])
        groups[key][0] += row['bytes']
        groups[key][1] += 1
summary['level3'] = [dict(path=key, bytes=value[0], files=value[1]) for key, value in sorted(groups.items(), key=lambda item: -item[1][0])]
(folder / (stem+'-summary.json')).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf8')
del data
packed = inventory.with_suffix('.json.gz')
with inventory.open('rb') as source, gzip.open(packed, 'wb', compresslevel=6) as dest:
    shutil.copyfileobj(source, dest, 1024*1024)
def digest(stream):
    result = hashlib.sha256()
    while block := stream.read(1024*1024): result.update(block)
    return result.hexdigest()
with inventory.open('rb') as stream: original = digest(stream)
with gzip.open(packed, 'rb') as stream: restored = digest(stream)
if original != restored: raise RuntimeError('Inventory roundtrip mismatch')
receipt = dict(raw_bytes=inventory.stat().st_size, gzip_bytes=packed.stat().st_size, raw_sha256=original, roundtrip_verified=True, file_id_metric_unavailable=True)
(folder/(stem+'-compression.json')).write_text(json.dumps(receipt, indent=2),encoding='utf8')
inventory.unlink()
print(json.dumps(receipt))
