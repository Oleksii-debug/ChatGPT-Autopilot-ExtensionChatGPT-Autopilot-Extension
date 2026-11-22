"""Select explicit historical copies, never original inputs or unified assets."""
import json
from pathlib import Path
from datetime import datetime, timezone

folder=Path(__file__).resolve().parents[1]/'windows-evidence/storage-cleanup-20261122'
data=json.loads((folder/'inventory-summary.json').read_text(encoding='utf8'))
root=Path(data['root'])
targets=[]
for row in data['level2']:
    name=row['path']
    if not name.startswith('Перевірка/'): continue
    short=name.split('/')[1]
    if not ('NVDA' in short or short.startswith(('dordiai-', 'dordiaivoices ', 'Дьордяй'))): continue
    if any(word in short for word in ('Єдиний','Другий','П’ять','Англійська','Початковий','Прискорення')): continue
    if short in ('dordiai-voices 0.10.12 перевірка','dordiai-voices 0.10.11 перевірка','Швидке читання NVDA'): continue
    targets.append(dict(path=name, bytes=row['bytes'], files=row['files'], reason='Obsolete portable NVDA / historical installed development copy'))
for row in data['archive_files']:
    name=row['path']
    if not name.startswith(('Перевірка/','Основний синтезатор/Перевірка/')): continue
    if 'unified' in name.lower() or '0.12.2' in name: continue
    if any(name.startswith(item['path']+'/') for item in targets): continue
    targets.append(dict(**row, files=1, reason='Superseded development installer; current releases and unique original archives preserved'))
for row in data['level2']:
    if row['path']=='Інструменти/uv-cache':
        targets.append(dict(**row, reason='Recreatable package download/build cache; installed hardlinks remain'))
protected=['Другий синтезатор','Розробка 0.13','голоси','Готовий додаток','архів для драйв','Моделі','Багатомовне ядро','Особисті мовні моделі','Перенесення голосу','Експеримент']
for row in targets:
    path=root/row['path']
    if not path.is_relative_to(root) or path==root: raise ValueError(path)
    if any(row['path']==item or row['path'].startswith(item+'/') for item in protected): raise ValueError(path)
    if 'unified' in row['path'].lower(): raise ValueError(path)
plan=dict(format='dordiai-authorized-old-copy-cleanup-v1', created_utc=datetime.now(timezone.utc).isoformat(),root=str(root), authorization='User explicitly requested permanent removal of unneeded old copies, preserving single-voice synthesizer',protected=protected,extra_protection='All unified candidates including 0.3.10 and primary 0.12.2 kept; only listed targets removed; no running process stopped', targets=targets, logical_bytes=sum(x['bytes'] for x in targets),target_count=len(targets),note='Logical sizes are not actual reclaimed volume space; measure volume before/after. Reparse points must be unlinked without traversing their targets.')
(folder/'deletion-plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({k:plan[k] for k in ('logical_bytes','target_count')},ensure_ascii=False))
for item in targets: print(item['path'],item['bytes'])
