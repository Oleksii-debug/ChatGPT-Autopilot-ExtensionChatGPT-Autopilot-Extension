"""Exact additional recreatable build caches; preserves executables and archives."""
import json,os,stat,shutil
from pathlib import Path
from datetime import datetime,timezone
folder=Path(__file__).resolve().parents[1]/'windows-evidence/storage-cleanup-20261122'
planpath=folder/'deletion-plan.json'
plan=json.loads(planpath.read_text(encoding='utf8'))
shutil.copyfile(planpath,folder/'deletion-plan-old-copies.json')
shutil.copyfile(folder/'deletion-receipt.json',folder/'deletion-receipt-old-copies.json')
root=Path(plan['root'])
targets=['r102/release/build','r102/release/incremental','Інструменти/Rust/toolchains','Інструменти/Rust/cargo','Інструменти/Rust/tmp','Інструменти/Compiler/llvm-mingw-20261104-ucrt-x86_64','Інструменти/Compiler/tmp','кеш/pip']
rows=[]
for relative in targets:
    pending=[root/relative];size=0;files=0
    while pending:
        current=pending.pop()
        if not current.exists():continue
        if current.stat().st_file_attributes&0x400:raise ValueError('Top link')
        with os.scandir(current) as entries:
            for entry in entries:
                info=entry.stat(follow_symlinks=False)
                if info.st_file_attributes&0x400:continue
                if stat.S_ISDIR(info.st_mode):pending.append(Path(entry.path))
                elif stat.S_ISREG(info.st_mode):size+=info.st_size;files+=1
    rows.append(dict(path=relative,bytes=size,files=files,reason='Recreatable historic build/download cache; source/lockfiles, pocket-tts.exe, rustup installer and compiler ZIP retained'))
plan['targets']=rows;plan['target_count']=len(rows);plan['logical_bytes']=sum(x['bytes'] for x in rows)
plan['created_utc']=datetime.now(timezone.utc).isoformat()
planpath.write_text(json.dumps(plan,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(dict(target_count=len(rows),logical_bytes=plan['logical_bytes'],targets=rows),ensure_ascii=False))
