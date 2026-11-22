"""Read-only storage inventory; never follows Windows reparse points."""
from __future__ import annotations
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat
import time


def scan(root, output):
    root=Path(root).absolute()
    if not root.is_dir() or root.is_symlink() or root.stat().st_file_attributes & 0x400:
        raise ValueError('One real project root required')
    files=[];links=[];errors=[];directories=[];stack=[root];start=time.monotonic()
    while stack:
        parent=stack.pop();relative=parent.relative_to(root).as_posix()
        directories.append(relative)
        try:
            with os.scandir(parent) as entries:
                for item in entries:
                    try:
                        info=item.stat(follow_symlinks=False);path=Path(item.path)
                        name=path.relative_to(root).as_posix()
                        if info.st_file_attributes & 0x400 or stat.S_ISLNK(info.st_mode):
                            links.append({'path':name,'attributes':info.st_file_attributes});continue
                        if stat.S_ISDIR(info.st_mode):stack.append(path)
                        elif stat.S_ISREG(info.st_mode):
                            files.append({'path':name,'bytes':info.st_size,'mtime_ns':info.st_mtime_ns,
                                          'dev':info.st_dev,'ino':info.st_ino,'nlink':info.st_nlink,
                                          'attributes':info.st_file_attributes})
                    except OSError as error:errors.append({'path':item.path,'error':str(error)})
        except OSError as error:errors.append({'path':str(parent),'error':str(error)})
    by_top=defaultdict(lambda:{'bytes':0,'files':0,'large_files':0})
    by_level2=defaultdict(lambda:{'bytes':0,'files':0})
    unique={};hardlinks=defaultdict(list)
    for row in files:
        parts=Path(row['path']).parts;top=parts[0];second='/'.join(parts[:2])
        by_top[top]['bytes']+=row['bytes'];by_top[top]['files']+=1
        by_top[top]['large_files']+=row['bytes']>=100_000_000
        by_level2[second]['bytes']+=row['bytes'];by_level2[second]['files']+=1
        if row['ino']:
            key=(row['dev'],row['ino']);unique[key]=row['bytes']
            if row['nlink']>1:hardlinks[str(key)].append(row['path'])
    result={'format':'dordiai-project-storage-inventory','created_utc':datetime.now(timezone.utc).isoformat(),
            'root':str(root),'elapsed_seconds':time.monotonic()-start,'logical_bytes':sum(x['bytes'] for x in files),
            'unique_file_id_logical_bytes':sum(unique.values()) if all(x['ino'] for x in files) else None,
            'file_ids_available_for_all_files':all(x['ino'] for x in files),
            'unique_metric_scope':'Counts each NTFS file ID once; not allocated/compressed clusters. Actual reclaimed space must be read from the volume.',
            'files_count':len(files),'directories_count':len(directories),'reparse_points_skipped':links,'errors':errors,
            'top':[dict(path=k,**v) for k,v in sorted(by_top.items(),key=lambda p:p[1]['bytes'],reverse=True)],
            'level2':[dict(path=k,**v) for k,v in sorted(by_level2.items(),key=lambda p:p[1]['bytes'],reverse=True)],
            'largest_files':sorted(files,key=lambda r:r['bytes'],reverse=True)[:150],
            'hardlinked_paths':dict(hardlinks),'files':files,'directories':directories,'mutations_performed':False}
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf8')
    print(json.dumps({k:result[k] for k in ('logical_bytes','unique_file_id_logical_bytes','files_count','directories_count','elapsed_seconds','top')},ensure_ascii=False))
    return result


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',required=True,type=Path);p.add_argument('--output',required=True,type=Path)
    args=p.parse_args();scan(args.root,args.output)
