import ast,hashlib,sys,tempfile,threading,unittest
from queue import Queue,Empty,Full
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import prefetch_research as p

SOURCE='''# Приватна дослідна копія; no real model is loaded by these fixtures.
def buffered_items(produce, cancelled, *, pending_count=12, short_reserve=False, cancelling_threads=None):
    if pending_count < 1:
        raise ValueError("positive bound")
    return produce(cancelled)
class Worker:
    def stream(self, produce, cancelled):
        return buffered_items(produce, cancelled, pending_count=2)
class SynthDriver:
    def _run(self):
        flow = buffered_items(produce, lambda: generation != self._generation,
                              short_reserve=short_reserve, cancelling_threads=cancelling_threads)
        return flow
'''

def patch(raw=None,count=24):
    raw=SOURCE.encode() if raw is None else raw
    return p.overlay(raw,source_sha256=hashlib.sha256(raw).hexdigest(),pending_count=count)

def frozen13_driver(raw):
    """Recover historical bytes only from either of the two exact known files.

    The buffering helper is still tested from live production below. Historical
    overlay tests need the immutable13 call rather than applying an overlay
    twice to the new14 explicit64 call.
    """
    original='17eeda6106858c4eb14ede91dd2a698cae0abaa9894d3df3e3d445d374a042ee'
    candidate='72d4526804111d66e5786da60542e9effbb91a84a7c00a2d785e6e30bbf0acf7'
    actual=hashlib.sha256(raw).hexdigest()
    if actual==candidate:
        raw=raw.replace(b'pending_count=64, short_reserve=',b'short_reserve=',1)
    elif actual!=original:
        raise ValueError('Unknown driver cannot stand in for immutable source13')
    if len(raw)!=93785 or hashlib.sha256(raw).hexdigest()!=original:
        raise ValueError('Historical source13 fixture identity differs')
    return raw

class Overlay(unittest.TestCase):
    def test_exact_one_outer_keyword_and_unchanged_inner2_for_all_variants(self):
        raw=SOURCE.encode()
        for count in p.COUNTS:
            candidate,receipt=patch(count=count)
            insertion=f'pending_count={count}, '.encode();position=candidate.index(insertion,candidate.index(b'flow = buffered_items'))
            self.assertEqual(candidate[:position]+candidate[position+len(insertion):],raw)
            self.assertTrue(receipt['only_outer_keyword_ast_difference_verified']);self.assertEqual(receipt['explicit_inner_counts_unchanged'],[2])
            self.assertTrue(receipt['generation_and_cancel_ast_unchanged']);self.assertFalse(receipt['first_ready_reserve_or_start_delay_added'])
    def test_unicode_and_crlf_preserved_exactly(self):
        raw=SOURCE.replace('\n','\r\n').encode();candidate,_=patch(raw)
        self.assertEqual(candidate.replace(b'pending_count=24, ',b'',1),raw)
    def test_wrong_source_pin_rejected(self):
        with self.assertRaises(ValueError):p.overlay(SOURCE.encode(),source_sha256='0'*64,pending_count=24)
    def test_unsupported_or_bool_counts_rejected(self):
        for count in (0,1,13,128,True):
            with self.assertRaises(ValueError):patch(count=count)
    def test_extended_counts_require_explicit_experiment_and_preserve_all_other_bytes(self):
        raw=SOURCE.encode();pin=hashlib.sha256(raw).hexdigest()
        self.assertEqual(p.COUNTS,(12,24,32))
        for count in (32,64,128):
            candidate,r=p.overlay(raw,source_sha256=pin,pending_count=count,experiment=p.EXTENDED_EXPERIMENT)
            self.assertEqual(candidate.replace(f'pending_count={count}, '.encode(),b'',1),raw)
            self.assertEqual(r['experiment'],p.EXTENDED_EXPERIMENT)
            self.assertEqual(r['maximum_outer_queued_pcm_bytes'],count*480)
            self.assertFalse(r['first_ready_reserve_or_start_delay_added'])
            self.assertEqual(r['original_default_count_unchanged'],12)
        with self.assertRaises(ValueError):p.overlay(raw,source_sha256=pin,pending_count=12,experiment=p.EXTENDED_EXPERIMENT)
        with self.assertRaises(ValueError):p.overlay(raw,source_sha256=pin,pending_count=32,experiment='unknown')
    def test_changed_generation_cancellation_contract_rejected(self):
        with self.assertRaises(ValueError):patch(SOURCE.replace('generation != self._generation','self._closed').encode())
    def test_modified_helper_default_rejected(self):
        with self.assertRaises(ValueError):patch(SOURCE.replace('pending_count=12','pending_count=24').encode())
    def test_unreviewed_inner_buffer_count_rejected(self):
        with self.assertRaises(ValueError):patch(SOURCE.replace('pending_count=2)','pending_count=4)').encode())
    def test_reapplying_overlay_rejected(self):
        candidate,_=patch()
        with self.assertRaises(ValueError):patch(candidate)
    def test_multiple_outer_calls_rejected(self):
        raw=SOURCE.replace('        return flow','        another = buffered_items(produce, lambda: generation != self._generation)\n        return flow').encode()
        with self.assertRaises(ValueError):patch(raw)
    def test_memory_receipt_is_total_and_increment_not_entire_process(self):
        for count,total,extra in [(12,5760,0),(24,11520,5760),(32,15360,9600)]:
            _,r=patch(count=count);self.assertEqual(r['maximum_outer_queued_pcm_bytes'],total);self.assertEqual(r['extra_outer_queued_pcm_bytes_over12'],extra)
    def create_owned(self,parent):
        root=Path(parent)/('nvda-'+'a'*32);source=root/'config/addons/kx47Voices/synthDrivers/kx47Preview.py';source.parent.mkdir(parents=True);source.write_bytes(SOURCE.encode());return root,source
    def test_overlay_mutates_only_owned_copy_and_records_exact_pins(self):
        with tempfile.TemporaryDirectory() as d:
            root,source=self.create_owned(d);pin=hashlib.sha256(source.read_bytes()).hexdigest()
            r=p.install_owned_overlay(root,source_sha256=pin,pending_count=24)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),r['candidate_source_sha256']);self.assertTrue((root/'prefetch-overlay.json').is_file())
            self.assertFalse(r['original_archive_modified']);self.assertFalse(source.with_name(source.name+'.prefetch-candidate').exists())
    def test_non_nonce_root_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):p.install_owned_overlay(Path(d),source_sha256='0'*64,pending_count=24)
    def test_preexisting_bytecode_cache_rejected_before_write(self):
        with tempfile.TemporaryDirectory() as d:
            root,source=self.create_owned(d);(source.parent/'__pycache__').mkdir();before=source.read_bytes()
            with self.assertRaises(ValueError):p.install_owned_overlay(root,source_sha256=hashlib.sha256(before).hexdigest(),pending_count=24)
            self.assertEqual(source.read_bytes(),before)
    def test_preexisting_receipt_rejected_before_source_write(self):
        with tempfile.TemporaryDirectory() as d:
            root,source=self.create_owned(d);(root/'prefetch-overlay.json').write_text('{}');before=source.read_bytes()
            with self.assertRaises(ValueError):p.install_owned_overlay(root,source_sha256=hashlib.sha256(before).hexdigest(),pending_count=24)
            self.assertEqual(source.read_bytes(),before)
    def test_symlink_source_rejected_before_write(self):
        with tempfile.TemporaryDirectory() as d:
            root,source=self.create_owned(d);real=source.with_name('other.py');source.rename(real)
            try:source.symlink_to(real)
            except OSError:self.skipTest('Host does not permit symlinks')
            with self.assertRaises(ValueError):p.install_owned_overlay(root,source_sha256=hashlib.sha256(real.read_bytes()).hexdigest(),pending_count=24)

class Spikes(unittest.TestCase):
    def test_extended_simulation_keeps_zero_startup_reserve_and_generation_cancel(self):
        for n in (32,64,128):
            r=p.simulate_spikes([50]*4,[50,300,300,300],pending_count=n,experiment=p.EXTENDED_EXPERIMENT)
            self.assertEqual(r['first_play_ms'],50);self.assertEqual(r['startup_reserve_ms'],0)
            self.assertTrue(r['all_chunks_preserved_in_order']);self.assertLessEqual(r['maximum_queued_pcm_bytes'],61440)
            r=p.simulate_spikes([50]*4,[0,300,300,300],pending_count=n,cancel_at_ms=405,experiment=p.EXTENDED_EXPERIMENT)
            self.assertTrue(r['cancelled']);self.assertFalse(r['old_generation_started_after_cancel'])
            self.assertEqual(r['last_audio_end_ms'],405)
    def test_first_ready_start_unchanged_no_prefill_barrier(self):
        for n in p.COUNTS:
            r=p.simulate_spikes([50]*4,[50,300,300,300],pending_count=n)
            self.assertEqual(r['first_play_ms'],50);self.assertEqual(r['startup_reserve_ms'],0)
            self.assertTrue(r['all_chunks_preserved_in_order']);self.assertLessEqual(r['maximum_pending_items'],n)
    def test_synthetic_spikes_exercise_three_distinct_headroom_results(self):
        values=[p.simulate_spikes([50]*4,[50,300,300,300],pending_count=n)['extra_gap_ms'] for n in p.COUNTS]
        self.assertEqual(values,[510,150,0])
    def test_no_spikes_no_new_gaps_for_any_count(self):
        for n in p.COUNTS:self.assertEqual(p.simulate_spikes([50]*4,[0,20,20,20],pending_count=n)['gaps'],[])
    def test_cancellation_discards_pending_old_generation_without_delay(self):
        for n in p.COUNTS:
            r=p.simulate_spikes([50]*4,[0,300,300,300],pending_count=n,cancel_at_ms=405)
            self.assertTrue(r['cancelled']);self.assertEqual(r['final_generation'],2);self.assertFalse(r['old_generation_started_after_cancel'])
            self.assertEqual(r['last_audio_end_ms'],405);self.assertFalse(r['all_chunks_preserved_in_order'])
    def test_cancel_before_first_pcm_does_not_start_old_audio(self):
        r=p.simulate_spikes([50],[300],pending_count=32,cancel_at_ms=100)
        self.assertTrue(r['cancelled']);self.assertIsNone(r['first_play_ms']);self.assertEqual(r['started_chunks'],[])
    def test_cancel_after_complete_is_not_claimed_as_active_stop(self):
        r=p.simulate_spikes([1],[0],pending_count=12,cancel_at_ms=100)
        self.assertFalse(r['cancelled']);self.assertTrue(r['all_chunks_preserved_in_order'])
    def test_invalid_simulation_inputs_rejected(self):
        for words,costs in [([],[]),([1],[0,1]),([True],[0]),([0],[0]),([1],[-1])]:
            with self.assertRaises(ValueError):p.simulate_spikes(words,costs,pending_count=12)

class ActualBufferingHelper(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source=Path(__file__).resolve().parents[1]/'source/0.12.2/synthDrivers/kx47Preview.py'
        raw=source.read_bytes();tree=ast.parse(raw.decode('utf-8'))
        node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='buffered_items')
        namespace={'Queue':Queue,'Empty':Empty,'Full':Full,'Thread':threading.Thread}
        exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),'exec'),namespace)
        cls.buffer=staticmethod(namespace['buffered_items']);cls.source_raw=frozen13_driver(raw)
    def test_historical_overlay_fixture_rejects_any_unreviewed_driver_edit(self):
        self.assertEqual(frozen13_driver(self.source_raw),self.source_raw)
        with self.assertRaises(ValueError):frozen13_driver(self.source_raw+b'\n')
    def test_actual_source_overlay_changes_only_outer_count(self):
        for count in (12,24,32,64,128):
            _,r=p.overlay(self.source_raw,source_sha256=hashlib.sha256(self.source_raw).hexdigest(),pending_count=count,
                          experiment=p.EXTENDED_EXPERIMENT if count>32 else p.DEFAULT_EXPERIMENT)
            self.assertTrue(r['generation_and_cancel_ast_unchanged']);self.assertEqual(r['explicit_inner_counts_unchanged'],[2])
    def test_actual_first_ready_item_does_not_wait_to_fill_any_variant(self):
        for count in (12,24,32,64,128):
            release=threading.Event();delivered=threading.Event();result=[]
            first=('pcm',b'first')
            def produce(stop):
                yield first
                release.wait(2)
            flow=self.buffer(produce,lambda:False,pending_count=count,cancelling_threads=[])
            def consume():
                result.append(next(flow));delivered.set()
            consumer=threading.Thread(target=consume,daemon=True);consumer.start()
            try:
                self.assertTrue(delivered.wait(1),'First ready item waited for an unready future item')
                self.assertIs(result[0],first)
            finally:
                release.set();consumer.join(2);flow.close()
    def test_actual_generation_cancel_never_yields_prefetched_old_items(self):
        for count in (12,24,32,64,128):
            generation=[1];retiring=[]
            def produce(stop):
                for index in range(200):
                    if stop():return
                    yield ('pcm',index)
            flow=self.buffer(produce,lambda:generation[0]!=1,pending_count=count,cancelling_threads=retiring)
            self.assertEqual(next(flow),('pcm',0));generation[0]=2
            self.assertEqual(list(flow),[])
            for thread in retiring:thread.join(1)
            self.assertTrue(all(not thread.is_alive() for thread in retiring))
    def test_actual_pcm_and_index_order_retained_for_every_count(self):
        expected=[('pcm',i) if i%5 else ('index',i) for i in range(200)]
        for count in (12,24,32,64,128):
            self.assertEqual(list(self.buffer(lambda stop:iter(expected),lambda:False,pending_count=count)),expected)

if __name__=='__main__':unittest.main()
