"""Consume the independent exact-copy/derived-cache leaf audit."""
import hashlib,json,shutil
from pathlib import Path
folder=Path(__file__).resolve().parents[1]/'windows-evidence/storage-cleanup-20261122'
root=Path(r'D:\Синтезатор мовлення KX-47')
reviewpath=folder/'old-test-safe-leaves-review.json'
assert hashlib.sha256(reviewpath.read_bytes()).hexdigest()=='1c5921a4f788d82d3c28cf3422a0d4a574dd713c09554732969653a2be512e45'
review=json.loads(reviewpath.read_text(encoding='utf8'))
planpath=folder/'deletion-plan.json';plan=json.loads(planpath.read_text(encoding='utf8'))
shutil.copyfile(planpath,folder/'deletion-plan-build-caches.json')
shutil.copyfile(folder/'deletion-receipt.json',folder/'deletion-receipt-build-caches.json')
cache={}
def digest(path):
    if path not in cache:
        result=hashlib.sha256()
        with Path(path).open('rb') as stream:
            while block:=stream.read(4*1024*1024):result.update(block)
        cache[path]=result.hexdigest()
    return cache[path]
for proof in review['exact_file_copy_proofs']:
    assert digest(proof['candidate'])==proof['sha256']
    assert digest(proof['retained_witness'])==proof['sha256']
rows=[]
for item in review['confirmed_safe_leaf_candidates']:
    names=item['file_paths'] if item['kind']=='specific_files_only' else [item['path']]
    for name in names:
        path=Path(name)
        assert path.is_relative_to(root) and path!=root
        size=path.stat().st_size if item['kind']=='specific_files_only' else item['logical_bytes']
        rows.append(dict(path=path.relative_to(root).as_posix(),bytes=size,files=1 if item['kind']=='specific_files_only' else item['files'],reason=item['category']+': '+item['reason']))
assert sum(x['bytes'] for x in rows)==review['candidate_logical_bytes']
for proof in review['exact_file_copy_proofs']:
    witness=Path(proof['retained_witness'])
    assert not any(witness==root/item['path'] or witness.is_relative_to(root/item['path']) for item in rows)
plan.update(targets=rows,target_count=len(rows),logical_bytes=review['candidate_logical_bytes'],independent_review_sha256=hashlib.sha256(reviewpath.read_bytes()).hexdigest(),all_retained_witnesses_sha256_reverified=True)
planpath.write_text(json.dumps(plan,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(dict(target_count=len(rows),logical_bytes=plan['logical_bytes'],reverified_copy_proofs=len(review['exact_file_copy_proofs']))))
