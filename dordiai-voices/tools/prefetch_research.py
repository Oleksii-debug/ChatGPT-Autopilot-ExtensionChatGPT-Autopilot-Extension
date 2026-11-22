"""Research-only outer prefetch overlays and deterministic spike timeline.

No synthesis, audio-device API, archive modification or production source edit.
Only a fresh controller-owned extracted NVDA copy may receive the overlay.
"""
from __future__ import annotations
import argparse,ast,collections,hashlib,json,os,re,stat
from pathlib import Path

COUNTS=(12,24,32)
DEFAULT_EXPERIMENT='baseline-12-24-32'
EXTENDED_EXPERIMENT='extended-32-64-128'
EXPERIMENT_COUNTS={DEFAULT_EXPERIMENT:COUNTS,EXTENDED_EXPERIMENT:(32,64,128)}
CHUNK_MS=10
SAMPLE_RATE=24000
PCM_BYTES_PER_CHUNK=480


def _contract(tree):
    classes=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='SynthDriver']
    if len(classes)!=1:raise ValueError('One exact SynthDriver class required')
    runs=[n for n in classes[0].body if isinstance(n,ast.FunctionDef) and n.name=='_run']
    if len(runs)!=1:raise ValueError('One exact outer speech loop required')
    calls=[n for n in ast.walk(runs[0]) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='buffered_items']
    if len(calls)!=1:raise ValueError('Exactly one outer buffered_items call required')
    call=calls[0]
    if len(call.args)!=2 or not isinstance(call.args[0],ast.Name) or call.args[0].id!='produce' or not isinstance(call.args[1],ast.Lambda):
        raise ValueError('Original producer and cancellation lambda required')
    wanted=ast.parse('lambda: generation != self._generation',mode='eval').body
    if ast.dump(call.args[1],include_attributes=False)!=ast.dump(wanted,include_attributes=False):
        raise ValueError('Original generation cancellation contract differs')
    helpers=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='buffered_items']
    if len(helpers)!=1:raise ValueError('One original buffering helper required')
    helper=helpers[0];defaults=dict(zip((n.arg for n in helper.args.kwonlyargs),helper.args.kw_defaults))
    if not isinstance(defaults.get('pending_count'),ast.Constant) or defaults['pending_count'].value!=12:
        raise ValueError('Unmodified original default12 buffering helper required')
    return call


def declared_counts(experiment):
    if experiment not in EXPERIMENT_COUNTS:raise ValueError('Explicit declared prefetch experiment required')
    return EXPERIMENT_COUNTS[experiment]


def overlay(source_raw,*,source_sha256,pending_count,experiment=DEFAULT_EXPERIMENT):
    """Insert only an explicit outer count; whole remaining AST must match."""
    if type(pending_count) is not int or pending_count not in declared_counts(experiment):raise ValueError('Only counts declared by this explicit experiment accepted')
    if not isinstance(source_raw,bytes) or not 0<len(source_raw)<=512*1024 or not isinstance(source_sha256,str) or not re.fullmatch('[0-9a-f]{64}',source_sha256):
        raise ValueError('Bounded exact caller-pinned source bytes required')
    actual=hashlib.sha256(source_raw).hexdigest()
    if actual!=source_sha256:raise ValueError('Exact original source SHA differs')
    text=source_raw.decode('utf-8');tree=ast.parse(text);call=_contract(tree)
    if [k.arg for k in call.keywords]!=['short_reserve','cancelling_threads']:
        raise ValueError('Original outer keyword shape differs or overlay already present')
    keyword=call.keywords[0]
    # AST columns are UTF8 byte offsets. Operate on ORIGINAL bytes, preserving
    # every non-overlay byte, including Unicode and line ending conventions.
    lines=source_raw.splitlines(keepends=True);position=sum(map(len,lines[:keyword.lineno-1]))+keyword.col_offset
    insertion=f'pending_count={pending_count}, '.encode('ascii')
    candidate=source_raw[:position]+insertion+source_raw[position:]
    after=ast.parse(candidate.decode('utf-8'));after_call=_contract(after)
    if [k.arg for k in after_call.keywords]!=['pending_count','short_reserve','cancelling_threads']:
        raise ValueError('Candidate does not bind exactly one explicit outer count')
    added=after_call.keywords.pop(0)
    if not isinstance(added.value,ast.Constant) or type(added.value.value) is not int or added.value.value!=pending_count:
        raise ValueError('Candidate literal count differs')
    if ast.dump(tree,include_attributes=False)!=ast.dump(after,include_attributes=False):
        raise ValueError('Candidate changes behavior outside the one outer count')
    compile(candidate,'<research-only-prefetch-overlay>','exec')
    inner=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='buffered_items' and n is not call]
    inner_counts=[k.value.value for n in inner for k in n.keywords if k.arg=='pending_count' and isinstance(k.value,ast.Constant)]
    if inner_counts!=[2]:raise ValueError('Exactly the original inner explicit2 buffering call required')
    receipt={'format':'dordiai-research-only-outer-prefetch-overlay','format_version':1,'pending_count':pending_count,
        'experiment':experiment,'declared_comparison_counts':list(declared_counts(experiment)),
        'original_source_sha256':actual,'candidate_source_sha256':hashlib.sha256(candidate).hexdigest(),
        'original_source_bytes':len(source_raw),'candidate_source_bytes':len(candidate),'added_source_bytes':len(insertion),
        'only_outer_keyword_ast_difference_verified':True,'original_default_count_unchanged':12,
        'explicit_inner_counts_unchanged':inner_counts,'first_ready_reserve_or_start_delay_added':False,
        'word_warmup_added':False,'generation_and_cancel_ast_unchanged':True,'sample_rate_for_queue_budget':SAMPLE_RATE,
        'pcm_chunk_ms':CHUNK_MS,'maximum_outer_queued_pcm_bytes':pending_count*PCM_BYTES_PER_CHUNK,
        'extra_outer_queued_pcm_bytes_over12':(pending_count-12)*PCM_BYTES_PER_CHUNK,
        'queue_budget_scope':'Outer queued PCM payload only; excludes Python objects, worker memory, caches and sink buffers',
        'original_archive_modified':False,'product_ready':False,'physical_audio_verified':False}
    return candidate,receipt


def _regular_no_links(path):
    path=Path(path)
    for part in (path,*path.parents):
        info=part.lstat()
        if part.is_symlink() or getattr(info,'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0x400):
            raise ValueError('Owned source path must not contain symlinks/junctions/reparse points')
    if not stat.S_ISREG(path.stat().st_mode):raise ValueError('Exact owned regular source required')


def install_owned_overlay(owned_run_root,*,source_sha256,pending_count,experiment=DEFAULT_EXPERIMENT):
    root=Path(owned_run_root).absolute()
    if not re.fullmatch('nvda-[0-9a-f]{32}',root.name):raise ValueError('Fresh nonce-bound owned run root required')
    source=root/'config/addons/kx47Voices/synthDrivers/kx47Preview.py'
    _regular_no_links(source)
    for cache in (source.with_suffix('.pyc'),source.parent/'__pycache__'):
        if cache.exists() or cache.is_symlink():raise ValueError('Fresh extracted source without preexisting bytecode cache required')
    receipt_path=root/'prefetch-overlay.json';temporary=source.with_name(source.name+'.prefetch-candidate')
    if receipt_path.exists() or receipt_path.is_symlink() or temporary.exists() or temporary.is_symlink():
        raise ValueError('Fresh one-time research overlay only')
    raw=source.read_bytes();candidate,receipt=overlay(raw,source_sha256=source_sha256,pending_count=pending_count,experiment=experiment)
    receipt.update(owned_run_root=str(root),owned_source=str(source))
    with temporary.open('xb') as output:
        output.write(candidate);output.flush();os.fsync(output.fileno())
    os.replace(temporary,source)
    with receipt_path.open('x',encoding='utf-8') as output:json.dump(receipt,output,sort_keys=True,indent=2)
    return receipt


def simulate_spikes(chunks_per_word,render_costs_ms,*,pending_count,cancel_at_ms=None,experiment=DEFAULT_EXPERIMENT):
    """Virtual bounded producer and a ten-ms consumer, with NO sink reserve.

    Render costs are synthetic WHOLE-word readiness costs, not fitted feed-gap
    measurements. An actual WavePlayer has additional buffering and scheduling;
    this simulation establishes mechanics, never predicts a device latency.
    """
    if type(pending_count) is not int or pending_count not in declared_counts(experiment):raise ValueError('Declared count required')
    if not 1<=len(chunks_per_word)<=100 or len(chunks_per_word)!=len(render_costs_ms):raise ValueError('Bounded matching word/cost lists required')
    if any(type(x) is not int or not 1<=x<=1000 for x in chunks_per_word):raise ValueError('Bounded positive chunk counts required')
    if sum(chunks_per_word)>20000:raise ValueError('Synthetic trace exceeds declared20000chunk quota')
    if any(type(x) is not int or not 0<=x<=10000 for x in render_costs_ms):raise ValueError('Bounded nonnegative synthetic costs required')
    if cancel_at_ms is not None and (type(cancel_at_ms) is not int or cancel_at_ms<0):raise ValueError('Nonnegative virtual cancellation time required')
    queue=collections.deque();word=0;chunk=0;ready=render_costs_ms[0];now=0;consumer_ready=0
    first=None;last_end=None;maximum=0;started=[];gaps=[];cancelled=False;discarded=0;generation=1
    while True:
        if cancel_at_ms is not None and now>=cancel_at_ms:
            generation+=1;cancelled=True;discarded=len(queue);queue.clear()
            if last_end is not None:last_end=min(last_end,cancel_at_ms)
            break
        while ready is not None and now>=ready and len(queue)<pending_count:
            queue.append((word,chunk));chunk+=1;maximum=max(maximum,len(queue))
            if chunk==chunks_per_word[word]:
                word+=1;chunk=0
                ready=None if word==len(chunks_per_word) else now+render_costs_ms[word]
        if queue and now>=consumer_ready:
            item=queue.popleft();started.append({'word':item[0],'chunk':item[1],'start_ms':now,'generation':generation})
            if first is None:first=now
            if last_end is not None and now>last_end:gaps.append({'first_ms':last_end,'last_ms':now,'duration_ms':now-last_end})
            last_end=now+CHUNK_MS;consumer_ready=last_end
            # Producer can occupy the newly freed slot immediately, even while
            # the current chunk plays. Never wait to fill before first playback.
            continue
        if ready is None and not queue:
            end=last_end if last_end is not None else now
            if cancel_at_ms is not None and cancel_at_ms<end:now=cancel_at_ms;continue
            now=end;break
        future=[t for t in (ready,consumer_ready if queue else None,cancel_at_ms) if t is not None and t>now]
        if not future:raise RuntimeError('Synthetic timeline made no progress')
        now=min(future)
    expected=[(w,c) for w,amount in enumerate(chunks_per_word) for c in range(amount)]
    observed=[(r['word'],r['chunk']) for r in started]
    return {'format':'dordiai-synthetic-prefetch-spike-timeline','format_version':1,'simulation_only':True,
        'not_actual_nvda_or_acoustic_measurement':True,'pending_count':pending_count,'experiment':experiment,'synthetic_render_costs_ms':list(render_costs_ms),
        'chunks_per_word':list(chunks_per_word),'first_chunk_ready_ms':render_costs_ms[0],'first_play_ms':first,
        'startup_reserve_ms':0,'modeled_sink_reserve_ms':0,'maximum_pending_items':maximum,
        'maximum_queued_pcm_bytes':maximum*PCM_BYTES_PER_CHUNK,'gaps':gaps,'extra_gap_ms':sum(g['duration_ms'] for g in gaps),
        'all_chunks_preserved_in_order':observed==expected and not cancelled,'started_chunks':started,'cancelled':cancelled,
        'cancel_at_ms':cancel_at_ms,'last_audio_end_ms':last_end,'queued_items_discarded_on_cancel':discarded,
        'final_generation':generation,'old_generation_started_after_cancel':any(cancel_at_ms is not None and r['start_ms']>=cancel_at_ms for r in started),
        'product_ready':False,'physical_audio_verified':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owned-run-root',type=Path,required=True);parser.add_argument('--source-sha256',required=True)
    parser.add_argument('--pending-count',type=int,required=True)
    parser.add_argument('--experiment',choices=tuple(EXPERIMENT_COUNTS),default=DEFAULT_EXPERIMENT);args=parser.parse_args()
    print(json.dumps(install_owned_overlay(args.owned_run_root,source_sha256=args.source_sha256,pending_count=args.pending_count,experiment=args.experiment),sort_keys=True))

if __name__=='__main__':main()
