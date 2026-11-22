import ast,hashlib,json,sys,tempfile,threading,types,unittest
from pathlib import Path
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import windows_nvda_longread_probe as probe
ROOT=Path(__file__).resolve().parents[1]
PLUGIN=ROOT/'tools/windows_nvda_longread_plugin.py'


def functions(*names):
    tree=ast.parse(PLUGIN.read_text());nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
    return compile(ast.Module(body=nodes,type_ignores=[]),'<pure-passive-observer>','exec')

class Probe(unittest.TestCase):
    def test_exact_original100_workload_and_routes(self):
        helpers=probe.source_helpers(ROOT/'tools/windows_nvda_plain_text_probe.py');ns={};exec(helpers,ns)
        case=ns['_plain_cases']()[0];self.assertEqual(len(case['words']),100)
        self.assertEqual(hashlib.sha256(case['text'].encode()).hexdigest(),probe.INPUT_SHA)
        routes=[{'text':w['word']+' ','language':w['expected_language']} for w in case['words']]
        audit=ns['_plain_route_audit'](case['words'],routes);self.assertTrue(audit['routing_passed']);self.assertEqual(audit['input_lexical_piece_count'],102)
    def test_changed_plain_helper_source_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'source.py';p.write_text('x=1')
            with self.assertRaises(ValueError):probe.source_helpers(p)
    def test_injected_plugin_compiles_without_placeholder(self):
        s=PLUGIN.read_text().replace('SETTINGS=__SETTINGS__','SETTINGS={}').replace('__SOURCE_HELPERS__',probe.source_helpers(ROOT/'tools/windows_nvda_plain_text_probe.py'))
        self.assertNotIn('__SOURCE_HELPERS__',s);compile(s,'<plugin>','exec')
    def test_feed_identity_args_result_and_reference(self):
        sentinel=object();data=bytearray(b'\x01\x00\x02\x00');arg=object();kw=object();calls=[]
        def original(*args,**kwargs):calls.append((args,kwargs));return sentinel
        ns={'time':types.SimpleNamespace(perf_counter_ns=iter([10,20]).__next__),'PHASE':'longread','RATE':24000,
            'LOCK':threading.Lock(),'PCM':bytearray(),'EVENTS':[],'ORIGINAL_FEED':original,'CANCEL_SCHEDULED':False}
        exec(functions('observe_feed'),ns);result=ns['observe_feed'](data,arg,done=kw)
        self.assertIs(result,sentinel);self.assertEqual(len(calls),1);self.assertIs(calls[0][0][0],data);self.assertIs(calls[0][0][1],arg);self.assertIs(calls[0][1]['done'],kw)
        self.assertEqual(bytes(ns['PCM']),bytes(data));self.assertEqual(ns['EVENTS'][0]['reference_offset_frames'],0)
    def test_feed_exception_preserved_without_fake_pcm(self):
        def original(*args,**kwargs):raise RuntimeError('original failure')
        ns={'time':types.SimpleNamespace(perf_counter_ns=lambda:1),'PHASE':'longread','RATE':24000,
            'LOCK':threading.Lock(),'PCM':bytearray(),'EVENTS':[],'ORIGINAL_FEED':original,'CANCEL_SCHEDULED':False}
        exec(functions('observe_feed'),ns)
        with self.assertRaisesRegex(RuntimeError,'original failure'):ns['observe_feed'](b'\x01\x00')
        self.assertEqual(ns['PCM'],bytearray());self.assertEqual(ns['EVENTS'],[])
    def test_no_reference_capture_outside_explicit_phase(self):
        original=Mock(return_value=123);ns={'time':types.SimpleNamespace(perf_counter_ns=lambda:1),'PHASE':'ready','ORIGINAL_FEED':original}
        exec(functions('observe_feed'),ns);self.assertEqual(ns['observe_feed'](b'a'),123);original.assert_called_once_with(b'a')
    def test_planner_returns_exact_original_part_and_closes(self):
        first=('text',{'text':'тест','language':'uk','speed':2.2});second=('other',object());closed=[];arg=object();kw=object();calls=[]
        def original(*args,**kwargs):
            calls.append((args,kwargs))
            try:yield first;yield second
            finally:closed.append(True)
        ns={'ORIGINAL_PARTS':original,'PHASE':'longread','ROUTES':[]};exec(functions('observe_parts'),ns)
        g=ns['observe_parts'](arg,option=kw);self.assertIs(next(g),first);g.close();self.assertEqual(closed,[True]);self.assertIs(calls[0][0][0],arg);self.assertIs(calls[0][1]['option'],kw);self.assertEqual(ns['ROUTES'][0]['speed'],2.2)
    def test_planner_second_nontext_part_identity(self):
        p=('other',object());ns={'ORIGINAL_PARTS':lambda:iter([p]),'PHASE':'longread','ROUTES':[]};exec(functions('observe_parts'),ns)
        self.assertIs(next(ns['observe_parts']()),p);self.assertEqual(ns['ROUTES'],[])
    def test_only_one_cancel_scheduled_after_first_active_feed(self):
        callbacks=[];ns={'time':types.SimpleNamespace(perf_counter_ns=lambda:1),'PHASE':'cancelling','RATE':24000,
            'LOCK':threading.Lock(),'PCM':bytearray(),'EVENTS':[],'ORIGINAL_FEED':lambda *a,**k:None,'CANCEL_SCHEDULED':False,
            'core':types.SimpleNamespace(callLater=lambda *args:callbacks.append(args)),
            'wx':types.SimpleNamespace(CallAfter=lambda function,*args:function(*args)),
            'guarded':lambda x:x,'cancel_actual_speech':lambda:None}
        exec(functions('observe_feed'),ns);ns['observe_feed'](b'\x00\x00');self.assertFalse(callbacks)
        ns['observe_feed'](b'\x01\x00');ns['observe_feed'](b'\x02\x00');self.assertEqual(len(callbacks),1);self.assertEqual(callbacks[0][0],300)
    def test_exact_pcm_receipt(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'x.pcm';p.write_bytes(b'\x01\x00');receipt={'filename':p.name,'size_bytes':2,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
            self.assertEqual(probe.read_pcm(p,receipt,8),b'\x01\x00');receipt['size_bytes']=4
            with self.assertRaises(ValueError):probe.read_pcm(p,receipt,8)
    def test_pcm_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'source';p.write_bytes(b'\x01\x00');link=Path(d)/'x.pcm'
            try:link.symlink_to(p)
            except OSError:self.skipTest('Host cannot create symlinks')
            with self.assertRaises(ValueError):probe.read_pcm(link,{},8)
    def test_old_short_capture_quotas_remain_frozen(self):
        s=(ROOT/'tools/windows_nvda_process_capture.cpp').read_text()
        self.assertIn('seconds=integer(args.at(L"--seconds"),10)',s);self.assertIn('proof.packets.size()>=4096',s)
    def test_new_native_only_accepts_case_specific_bounded_scopes(self):
        s=(ROOT/'tools/windows_nvda_longread_capture.cpp').read_text()
        self.assertIn('seconds=integer(args.at(L"--seconds"),90)',s);self.assertIn('seconds==90',s);self.assertIn('seconds==8',s);self.assertIn('proof.packets.size()>=32768',s)
        self.assertIn('HeldProcess target(target_pid),controller(controller_pid)',s)
        self.assertIn('Only controller-owned sibling NVDA process may be captured',s)
        self.assertNotIn('PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE',s)
    def test_no_manual_language_injected_or_recording_sink(self):
        s=PLUGIN.read_text();self.assertNotIn('LangChangeCommand(',s);self.assertNotIn('DRIVER.speak(',s);self.assertNotIn('RecordingSink(',s)
        self.assertIn('speech.speakTextInfo(info',s);self.assertIn('textInfos.POSITION_ALL',s)
    def test_cancel_helper_reaped_on_ready_failure(self):
        child=Mock();child.pid=88;child.poll.side_effect=[None,0];child.communicate.return_value=('','')
        child.stdout=Mock();child.stderr=Mock();report={};args=types.SimpleNamespace(helper=Path('/owned/helper'))
        from unittest.mock import patch
        with patch.object(probe.subprocess,'Popen',return_value=child),patch.object(probe.short,'wait_file',side_effect=RuntimeError('no ready')):
            with self.assertRaisesRegex(RuntimeError,'no ready'):probe.capture_phase(args,Path('/owned/nvda-'+('a'*32)),types.SimpleNamespace(pid=77),24000,'a'*64,'b'*64,'owned','cancel-capture',8,'cancel-trigger.json',report)
        child.kill.assert_called_once();child.communicate.assert_called_once();self.assertTrue(report['owned_capture_helper_cleanup'][0]['reaped'])
    def test_native_ninety_second_metadata_limit_coherent(self):
        import nvda_longread_analysis as a
        self.assertGreaterEqual(a.MAX_PACKETS,90*100);self.assertEqual(a.MAX_PCM_BYTES,48000*2*90)

if __name__=='__main__':unittest.main()
