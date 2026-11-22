"""Synthetic code/receipt/input-buffer fixtures, never actual keyboard proof."""
import ast
import copy
import ctypes
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import textwrap
import sys
import subprocess
from types import SimpleNamespace
from contextlib import contextmanager
import unittest
import zipfile
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
m=load('settings_keyboard_test',ROOT/'tools/windows_nvda_settings_keyboard_probe.py')
base=load('settings_original_base',ROOT/'tools/windows_nvda_probe.py')


def receipt(phase):
    original={'languages':['en','ru','uk'],'default_language':'uk','mode':'auto','voice':'voice0',
              'voice_map':{},'voices':['viktoriia']+['voice'+str(i) for i in range(44)]}
    settings=copy.deepcopy(original)
    if phase=='edit':settings.update(languages=['en'],default_language='en',voice_map={'en':'viktoriia'})
    events=[{'name':x} for x in ['keyboard_ok_applied','keyboard_reopen_verified']]
    if phase=='edit':
        events += [{'name':'actual_hotkey_opened_settings'},{'name':'choice'}]
        for kind,code,before,after in [('language','ru',True,False),('language','uk',True,False),
                                     ('voice','voice1',True,False),('voice','voice1',False,True)]:
            events.append(dict(name='checkbox',kind=kind,code=code,before=before,after=after))
    else:events += [{'name':'actual_process_restart_loaded_settings'},{'name':'NVDA_tools_menu_opened_settings'},
                   {'name':'native_menu_target','menu_item_id':71,'observer':'wx-taskbar-popup-owner'},
                   {'name':'native_menu_highlight','menu_item_id':71},
                   {'name':'native_menu_selection_verified','menu_item_id':71,'observed_menu_item_id':71}]
    for label in ['NVDA+control+shift+f10','NVDA+control+c']+(['NVDA+n','Activate dordiai Tools item'] if phase=='resume' else []):
        events.append(dict(name='send_input',label=label,events_expected=4,events_sent=4))
    row={'phase':phase,'status':'passed-functional-only','events':events,'raw_keys':[{'vk':9}],
         'speech_requests':[{'text':['Synthetic checkbox feedback']}],
         'gesture_scripts':[{'script_name':'script_preferences','script_module':'globalPlugins.dordiaiMainPreferences'},
                            {'script_name':'script_saveConfiguration','script_module':'globalCommands'},
                            {'script_name':'script_showGui','script_module':'globalCommands'}],
         'public_post_configSave_count':1,'configuration_saved_by_real_NVDA_keyboard_command':True,
         'public_TALK_then_cancel_before_keyboard':True,
         'original_settings':original,'saved_settings':settings,
         'cleanup':{'errors':[],'observers_unregistered':True,'normal_user_profile_untouched':True}}
    for key in ('physical_keyboard_verified','full_accessibility_verified','named_profile_switching_verified',
                'file_chooser_keyboard_verified','pronunciation_verified','physical_audio_verified'):row[key]=False
    return {'addon_sha256':'a'*64,'checks':[{'name':'windows_audio_output_enumeration','status':'blocked'}],
            'probe':{'nvda_version_actual':'2026.3.1','product_ready':False,'physical_audio_verified':False,
                     'recording_pcm_sink_test_double':True,
                     'keyboard_startup_synth':{'observed_before_probe_begin':True,'configured_synth':'kx47Preview',
                         'actual_synth':'kx47Preview','saved_synth_automatic_startup_verified':True,
                         'at_begin_synth':'kx47Preview','same_startup_instance_at_begin':True,
                         'at_begin_settings':dict(original,languages=['en'],default_language='en',voice_map={'en':'viktoriia'}),
                         'status':'passed-functional-only','settings':dict(original,languages=['en'],default_language='en',voice_map={'en':'viktoriia'})},
                     'checks':[{'name':'actual_keyboard_settings','status':'passed'}],'keyboard_settings':row}}


class SourceContracts(unittest.TestCase):
    def test_pinned_base_bytes_and_initial_anchor(self):
        self.assertEqual(m._load_pinned(ROOT/'tools/windows_nvda_probe.py',m.BASE_BLOB,'verified_base').NVDA_VERSION,'2026.3.1')
        self.assertEqual(base.PROBE_PLUGIN.count(m.DEFAULT_CHECK),1)

    def test_composition_keeps_original_source_object_and_compiles_both_phases(self):
        before=base.PROBE_PLUGIN
        for phase in ('edit','resume'):
            source=m.compose_plugin(base,phase,receipt('edit')['probe']['keyboard_settings']['original_settings'])
            tree=ast.parse(source.replace('__PROBE_SETTINGS__',repr({})).replace('__NATIVE_IMPORT_DIAGNOSTIC__',repr('')))
            opens=[x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='open_settings']
            self.assertEqual(len(opens),2)
            effective=ast.unparse(opens[-1])
            self.assertNotIn('_dordiai_open_settings(',effective)
            self.assertIn('_ks_hotkey(_ks_edit)',effective)
        self.assertEqual(base.PROBE_PLUGIN,before)

    def test_no_programmatic_control_selection_or_save_calls_in_supplement(self):
        tree=ast.parse(m.PLUGIN_CODE)
        attrs={x.func.attr for x in ast.walk(tree) if isinstance(x,ast.Call) and isinstance(x.func,ast.Attribute)}
        self.assertFalse(attrs&{'SetFocus','SetSelection','Check','SetValue','onOk','onApply','onCancel','_dordiai_apply','_dordiai_open_settings','speak'})
        self.assertIn('SendInput',attrs)
        self.assertIn('SetForegroundWindow',attrs)  # Owned fixture activation only.

    def test_missing_or_duplicate_initial_anchor_rejected(self):
        for source in [base.PROBE_PLUGIN.replace(m.DEFAULT_CHECK,''),base.PROBE_PLUGIN+m.DEFAULT_CHECK]:
            with self.assertRaises(ValueError):m.compose_plugin(SimpleNamespace(PROBE_PLUGIN=source),'edit')

    def test_unknown_phase_rejected(self):
        with self.assertRaises(ValueError):m.compose_plugin(base,'fake')

    def test_public_save_observer_and_real_persistence_keys(self):
        for text in ['config.post_configSave.register','config.post_configSave.unregister','dordiaiEnabledLanguages',
                     'dordiaiDefaultLanguage','dordiaiLanguageVoices','NVDA+control+c']:
            self.assertIn(text,m.PLUGIN_CODE)
        self.assertLess(m.PLUGIN_CODE.index('speech.setSpeechMode(speech.SpeechMode.talk)'),m.PLUGIN_CODE.index('speech.cancelSpeech()'))

    def test_startup_capture_precedes_manual_selection_and_late_headless_factory(self):
        source=m.compose_plugin(base,'resume',receipt('edit')['probe']['keyboard_settings']['original_settings'])
        tree=ast.parse(source.replace('__PROBE_SETTINGS__',repr({})).replace('__NATIVE_IMPORT_DIAGNOSTIC__',repr('')))
        begin=next(x for x in tree.body if isinstance(x,ast.FunctionDef) and x.name=='begin')
        self.assertEqual(ast.unparse(begin.body[0]),'_ks_check_startup()')
        self.assertEqual(ast.unparse(tree.body[-1]),'_ks_capture_startup()')


class ReceiptTests(unittest.TestCase):
    def test_both_metadata_fixtures_pass_without_actual_model_claim(self):
        for phase in ['edit','resume']:
            row=m.validate_phase(receipt(phase),phase,{'archive_sha256':'a'*64})
            self.assertFalse(row['physical_audio_verified']);self.assertFalse(row['full_accessibility_verified'])

    def test_wrong_core_or_nvda_is_rejected(self):
        r=receipt('edit');r['addon_sha256']='b'*64
        with self.assertRaises(ValueError):m.validate_phase(r,'edit',{'archive_sha256':'a'*64})
        r=receipt('edit');r['probe']['nvda_version_actual']='unknown'
        with self.assertRaises(ValueError):m.validate_phase(r,'edit',{'archive_sha256':'a'*64})

    def test_partial_send_or_missing_raw_input_rejected(self):
        r=receipt('edit');row=r['probe']['keyboard_settings'];next(x for x in row['events'] if x['name']=='send_input')['events_sent']=1
        with self.assertRaises(ValueError):m.validate_phase(r,'edit',{'archive_sha256':'a'*64})
        r=receipt('edit');r['probe']['keyboard_settings']['raw_keys']=[]
        with self.assertRaises(ValueError):m.validate_phase(r,'edit',{'archive_sha256':'a'*64})

    def test_both_starting_languages_must_be_disabled_by_keyboard(self):
        r=receipt('edit');row=r['probe']['keyboard_settings'];row['events']=[x for x in row['events'] if x.get('code')!='uk']
        with self.assertRaises(ValueError):m.validate_phase(r,'edit',{'archive_sha256':'a'*64})

    def test_voice_toggle_and_restore_must_match_same_profile(self):
        r=receipt('edit');row=r['probe']['keyboard_settings'];next(x for x in row['events'] if x.get('kind')=='voice' and x.get('after') is True)['code']='voice2'
        with self.assertRaises(ValueError):m.validate_phase(r,'edit',{'archive_sha256':'a'*64})

    def test_cleanup_save_and_speech_feedback_are_required(self):
        for key,value in [('cleanup',{'errors':['bad']}),('speech_requests',[]),('public_post_configSave_count',0)]:
            r=receipt('edit');r['probe']['keyboard_settings'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):m.validate_phase(r,'edit',{'archive_sha256':'a'*64})

    def test_restart_menu_path_and_restored_original_state_required(self):
        r=receipt('resume');row=r['probe']['keyboard_settings'];row['events']=[x for x in row['events'] if x.get('name')!='actual_process_restart_loaded_settings']
        with self.assertRaises(ValueError):m.validate_phase(r,'resume',{'archive_sha256':'a'*64})
        r=receipt('resume');r['probe']['keyboard_settings']['saved_settings']['languages']=['en']
        with self.assertRaises(ValueError):m.validate_phase(r,'resume',{'archive_sha256':'a'*64})

    def test_spoken_menu_label_or_wrong_native_highlight_cannot_prove_selection(self):
        for change in ('no_highlight','wrong_highlight','wrong_selection','late_highlight','wrong_owner'):
            r=receipt('resume');events=r['probe']['keyboard_settings']['events']
            highlight=next(x for x in events if x['name']=='native_menu_highlight')
            if change=='no_highlight':events.remove(highlight)
            elif change=='wrong_highlight':highlight['menu_item_id']=999
            elif change=='wrong_selection':next(x for x in events if x['name']=='native_menu_selection_verified')['observed_menu_item_id']=999
            elif change=='late_highlight':events.remove(highlight);events.append(highlight)
            else:next(x for x in events if x['name']=='native_menu_target')['observer']='unowned-menu'
            with self.subTest(change=change),self.assertRaises(ValueError):
                m.validate_phase(r,'resume',{'archive_sha256':'a'*64})
    def test_unsupported_claims_and_excluded_voices_rejected(self):
        r=receipt('edit');r['probe']['keyboard_settings']['named_profile_switching_verified']=True
        with self.assertRaises(ValueError):m.validate_phase(r,'edit',{'archive_sha256':'a'*64})

    def test_headless_startup_failure_is_explicitly_blocked_never_silently_verified(self):
        r=receipt('resume');startup=r['probe']['keyboard_startup_synth']
        startup.update(actual_synth='espeak',settings=None,saved_synth_automatic_startup_verified=False,
            at_begin_synth='espeak',same_startup_instance_at_begin=False,
            status='blocked-saved-synth-startup-unverified-headless',manual_reselection_after_startup_observation=True,
            startup_failure_cause_not_inferred=True)
        r['probe']['checks'].append({'name':'saved_synth_automatic_startup','status':'blocked'})
        self.assertEqual(m.validate_phase(r,'resume',{'archive_sha256':'a'*64})['phase'],'resume')
        startup['saved_synth_automatic_startup_verified']=True
        with self.assertRaises(ValueError):m.validate_phase(r,'resume',{'archive_sha256':'a'*64})
        startup['saved_synth_automatic_startup_verified']=False
        r['probe']['recording_pcm_sink_test_double']=False
        with self.assertRaises(ValueError):m.validate_phase(r,'resume',{'archive_sha256':'a'*64})

    def test_manual_reselection_cannot_hide_bad_saved_synth_parameters(self):
        r=receipt('resume');r['probe']['keyboard_startup_synth']['settings']['languages']=['uk']
        with self.assertRaises(ValueError):m.validate_phase(r,'resume',{'archive_sha256':'a'*64})

    def test_virtual_mode_requires_original_waveplayer_no_recording_and_saved_exact_id(self):
        r=receipt('resume');p=r['probe'];row=p['keyboard_settings'];startup=p['keyboard_startup_synth']
        row.update(owned_virtual_endpoint_id='owned-id',real_wave_player_initialized=True)
        startup.update(output_device='owned-id',at_begin_output_device='owned-id',real_wave_player=True,at_begin_real_wave_player=True)
        p['recording_pcm_sink_test_double']=False
        m.validate_phase(r,'resume',{'archive_sha256':'a'*64})
        for key,value in [('output_device','other'),('at_begin_output_device','other'),('real_wave_player',False),('at_begin_real_wave_player',False)]:
            other=copy.deepcopy(r);other['probe']['keyboard_startup_synth'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):m.validate_phase(other,'resume',{'archive_sha256':'a'*64})
        p['recording_pcm_sink_test_double']=True
        with self.assertRaises(ValueError):m.validate_phase(r,'resume',{'archive_sha256':'a'*64})
        r=receipt('resume');r['probe']['keyboard_settings']['gesture_scripts']=[]
        with self.assertRaises(ValueError):m.validate_phase(r,'resume',{'archive_sha256':'a'*64})
        r=receipt('edit');r['probe']['keyboard_settings']['saved_settings']['voices'][0]='kostia'
        with self.assertRaises(ValueError):m.validate_phase(r,'edit',{'archive_sha256':'a'*64})


class InputBufferTests(unittest.TestCase):
    def namespace(self):
        ns={'finish':lambda:None};exec(compile(m.PLUGIN_CODE,'fixture-only','exec'),ns)
        return ns

    def test_actual_ctypes_buffer_has_native_pointer_alignment(self):
        ns=self.namespace()
        self.assertEqual(ctypes.sizeof(ns['_KSInput']),40 if ctypes.sizeof(ctypes.c_void_p)==8 else 28)

    def test_menu_uses_actual_preferences_item_when_legacy_label_also_matches(self):
        ns=self.namespace()
        def item(ident,label):return SimpleNamespace(GetId=lambda:ident,GetItemLabelText=lambda:label)
        legacy=item(10,'dordiai-voices: поєднання голосів за мовами…')
        current=item(20,'dordiai-voices — голоси, мови й мовлення…')
        owner=type('GlobalPlugin',(),{'__module__':'globalPlugins.dordiaiMainPreferences'})()
        owner._item=current
        self.assertEqual(ns['_ks_preferences_item_index']([legacy,current],[owner]),1)
        self.assertEqual(ns['_ks_preferences_item_index']([current,legacy],[owner]),0)

    def test_menu_rejects_missing_or_ambiguous_preferences_owner_and_item(self):
        ns=self.namespace()
        item=SimpleNamespace(GetId=lambda:20)
        owner=type('GlobalPlugin',(),{'__module__':'globalPlugins.dordiaiMainPreferences'})()
        owner._item=item
        for items,plugins in (([item],[]),([item],[owner,owner]),([],[owner]),([item,item],[owner])):
            with self.subTest(items=len(items),plugins=len(plugins)),self.assertRaises(ValueError):
                ns['_ks_preferences_item_index'](items,plugins)

    def test_native_menu_mnemonic_preserves_escaped_ampersands_and_rejects_missing(self):
        ns=self.namespace()
        for label in ('&Tools','T&ools','Escaped && &Tools'):
            expected=ord('O') if label=='T&ools' else ord('T')
            self.assertEqual(ns['_ks_menu_access_key'](label),expected)
        for label in ('Tools','Tools && more','Tools&','&Засоби'):
            with self.subTest(label=label),self.assertRaises(ValueError):
                ns['_ks_menu_access_key'](label)

    def test_native_menu_highlight_observer_only_records_and_propagates(self):
        ns=self.namespace();events=[];skipped=[]
        ns.update(_KS={},_ks_record=lambda *a,**kw:events.append((a,kw)))
        # An active probe always has a nonempty ownership/result object.
        ns['_KS']['result']={}
        event=SimpleNamespace(GetId=lambda:-1,GetMenuId=lambda:71,Skip=lambda:skipped.append(True))
        ns['_ks_menu_highlight'](event)
        self.assertEqual(ns['_KS']['menu_last_highlight'],71)
        self.assertEqual(len(events),1);self.assertEqual(skipped,[True])
        ns['_KS']['cleaned']=True
        ns['_ks_menu_highlight'](event)
        self.assertEqual(len(events),1);self.assertEqual(skipped,[True,True])

    def test_menu_highlights_are_bound_to_actual_taskbar_popup_owner(self):
        ns=self.namespace();bindings=[];events=[]
        target=SimpleNamespace(GetId=lambda:71,GetItemLabel=lambda:'dordiai preferences',IsSeparator=lambda:False,IsEnabled=lambda:True)
        tools=SimpleNamespace(GetMenuItems=lambda:[target])
        root_item=SimpleNamespace(GetSubMenu=lambda:tools,GetItemLabel=lambda:'&Tools',IsSeparator=lambda:False,IsEnabled=lambda:True)
        tray=SimpleNamespace(menu=SimpleNamespace(GetMenuItems=lambda:[root_item]),toolsMenu=tools,
                             Bind=lambda kind,fn:bindings.append((kind,fn)))
        owner=type('GlobalPlugin',(),{'__module__':'globalPlugins.dordiaiMainPreferences'})();owner._item=target
        wx=SimpleNamespace(EVT_MENU_HIGHLIGHT_ALL=object())
        ns.update(_KS={'result':{},'nvda_key':(45,True)},wx=wx,
                  _ks_record=lambda name,**kw:events.append(dict(name=name,**kw)),_ks_send=lambda *a:None)
        with patch.dict(sys.modules,{'gui':SimpleNamespace(mainFrame=SimpleNamespace(sysTrayIcon=tray)),
                                    'globalPluginHandler':SimpleNamespace(runningPlugins=[owner])}):
            ns['_ks_menu']()
        self.assertEqual(ns['_KS']['menu_observers'],[tray])
        self.assertEqual(bindings,[(wx.EVT_MENU_HIGHLIGHT_ALL,ns['_ks_menu_highlight'])])
        self.assertEqual(events[0]['menu_item_id'],71)
        self.assertEqual(events[0]['observer'],'wx-taskbar-popup-owner')

    def test_balanced_buffer_and_partial_send_modifier_release(self):
        for partial in [False,True]:
            ns=self.namespace();calls=[];events=[];later=[]
            class Sender:
                def SendInput(self,n,values,size):
                    calls.append([(values[i].ki.wVk,values[i].ki.dwFlags) for i in range(n)])
                    return n-1 if partial and len(calls)==1 else n
            ns.update(_KS={'user':Sender()},_ks_owned=lambda:True,
                      _ks_record=lambda name,**kw:events.append((name,kw)),later=lambda ms,fn:later.append(fn))
            if partial:
                with self.assertRaises(OSError):ns['_ks_send']([[(0x11,False),(0x2d,True)]],'fixture',lambda:None)
                self.assertTrue(all(flags&2 for _,flags in calls[1]))
            else:
                ns['_ks_send']([[(0x11,False),(0x2d,True)]],'fixture',lambda:None)
                self.assertEqual(calls[0],[(0x11,0),(0x2d,1),(0x2d,3),(0x11,2)])


class RuntimeIntegrityTests(unittest.TestCase):
    def fixture(self,root):
        installed=root/'installed';f=installed/'kx47Runtime/models/fixture.bin';f.parent.mkdir(parents=True);f.write_bytes(b'original')
        addon=root/'core.zip'
        manifest={'files':{'kx47Runtime/models/fixture.bin':{'size_bytes':8,'sha256':sha256(b'original').hexdigest()}}}
        with zipfile.ZipFile(addon,'w') as z:z.writestr('dordiai-release.json',json.dumps(manifest))
        return addon,installed,f

    def test_readonly_runtime_verification_and_mutation_rejection(self):
        with tempfile.TemporaryDirectory() as d:
            addon,installed,f=self.fixture(Path(d));before=f.stat().st_mtime_ns
            self.assertTrue(m.verify_installed_runtime(addon,installed)['all_match_immutable_core_manifest'])
            self.assertEqual(f.stat().st_mtime_ns,before)
            f.write_bytes(b'changed!')
            with self.assertRaises(ValueError):m.verify_installed_runtime(addon,installed)

    def test_deleted_installed_runtime_is_not_checkbox_success(self):
        with tempfile.TemporaryDirectory() as d:
            addon,installed,f=self.fixture(Path(d));f.unlink()
            with self.assertRaises(FileNotFoundError):m.verify_installed_runtime(addon,installed)


class OwnedLifecycleTests(unittest.TestCase):
    @staticmethod
    def fake_job():
        job=SimpleNamespace(handle=1,assign_and_resume=lambda p:None)
        def finish(**kwargs):
            job.handle=None
            return {'active_before_cleanup':0,'active_after_cleanup':0,
                    'forced_tree_termination':False,'all_owned_workers_reaped':True}
        job.finish=finish
        return job

    def test_failed_resume_receipt_survives_secondary_fatal_exit(self):
        primary={'name':'keyboard_settings_exception','status':'failed','error':'native menu selection timeout'}
        value={'checks':[primary,{'name':'keyboard_settings_cleanup','status':'passed'}],
               'keyboard_startup_synth':{'saved_synth_automatic_startup_verified':True}}
        for code in (3221226525,-1073740771):
            process=SimpleNamespace(pid=7264,poll=lambda code=code:code)
            report={'phases':{}}
            second=m._record_resume_receipt(report,{'archive_sha256':'a'*64},value,process,1234)
            self.assertIs(report['phases']['resume'],second)
            self.assertIs(second['probe'],value)
            self.assertEqual(report['primary_phase_error']['check'],primary)
            m._record_resume_exit(report,process)
            self.assertEqual(report['resume_process_exit']['returncode'],code)
            self.assertEqual(report['resume_process_exit']['windows_status_hex'],'0xC000041D')
            self.assertFalse(report['resume_process_exit']['normal_shutdown_verified'])
            self.assertEqual(report['actual_second_process_pid'],7264)

    def test_successful_resume_receipt_never_invents_primary_failure(self):
        report={'phases':{}};process=SimpleNamespace(pid=8,poll=lambda:0)
        m._record_resume_receipt(report,{'archive_sha256':'a'*64},{'checks':[{'status':'passed'}]},process,9)
        m._record_resume_exit(report,process)
        self.assertNotIn('primary_phase_error',report)
        self.assertTrue(report['resume_process_exit']['normal_shutdown_verified'])

    def test_only_exact_popen_objects_are_stopped_and_explicitly_waited(self):
        events=[]
        class Child:
            def __init__(self,pid):self.pid=pid;self.code=None
            def poll(self):return self.code
            def wait(self,timeout):events.append(('wait',self.pid,timeout));self.code=0;return 0
        flags=[]
        def popen(command,**kwargs):flags.append(kwargs['creationflags']);return Child(len(flags)+10)
        module=SimpleNamespace(Popen=popen,STDOUT=-2)
        observed=m.OwnedProcesses(module,job_factory=self.fake_job)
        a=observed.Popen(['/own/nvda.exe']);b=observed.Popen(['/own/nvda.exe'])
        report={};stopped=[]
        observed.reap(SimpleNamespace(stop_owned=lambda p:stopped.append(p)),report)
        self.assertEqual(stopped,[]);self.assertEqual(len(events),2)
        self.assertEqual(flags,[4,4])
        self.assertEqual(observed.STDOUT,-2)
        self.assertTrue(report['owned_process_cleanup']['all_reaped_before_device_cleanup'])
        self.assertEqual(report['owned_process_cleanup']['actual_nvda_process_count'],2)
        self.assertTrue(report['owned_process_cleanup']['all_owned_nvda_descendants_reaped'])

    def test_forced_stop_failure_never_claims_success_even_if_process_exits(self):
        process=SimpleNamespace(pid=19,poll=lambda:0,wait=lambda **kw:0)
        observed=m.OwnedProcesses(SimpleNamespace(Popen=lambda command:process));observed.Popen(['installer.exe'])
        def fail(p):raise OSError('synthetic stop failure')
        report={}
        with self.assertRaises(RuntimeError):observed.reap(SimpleNamespace(stop_owned=fail),report)
        self.assertFalse(report['owned_process_cleanup']['all_reaped_before_device_cleanup'])
        self.assertIn('OSError',report['owned_process_cleanup']['errors'][0])

    def test_forced_job_cleanup_remains_failed_even_when_entire_tree_is_reaped(self):
        job=self.fake_job()
        original=job.finish
        def finish(**kwargs):return dict(original(**kwargs),forced_tree_termination=True)
        job.finish=finish
        child=SimpleNamespace(pid=91,poll=lambda:1,wait=lambda **kw:1)
        observed=m.OwnedProcesses(SimpleNamespace(Popen=lambda *a,**kw:child),job_factory=lambda:job)
        observed.Popen(['nvda.exe']);report={}
        with self.assertRaises(RuntimeError):observed.reap(SimpleNamespace(stop_owned=lambda p:None),report)
        self.assertTrue(report['owned_process_cleanup']['all_owned_nvda_descendants_reaped'])
        self.assertFalse(report['owned_process_cleanup']['all_reaped_before_device_cleanup'])
        self.assertTrue(report['owned_process_cleanup']['owned_nvda_jobs'][0]['forced_tree_termination'])

    def test_job_assignment_failure_reaps_suspended_held_child_and_closes_job(self):
        calls=[];job=self.fake_job()
        def reject(process):calls.append('assign');raise OSError('assignment failed')
        job.assign_and_resume=reject;original=job.finish
        def finish(**kw):calls.append('close');return original(**kw)
        job.finish=finish
        child=SimpleNamespace(pid=12,kill=lambda:calls.append('kill'),wait=lambda **kw:calls.append('wait'),poll=lambda:1)
        observed=m.OwnedProcesses(SimpleNamespace(Popen=lambda *a,**kw:child),job_factory=lambda:job)
        with self.assertRaises(OSError):observed.Popen(['nvda.exe'])
        self.assertEqual(calls,['assign','kill','wait','close']);self.assertIsNone(job.handle)

    def test_failed_popen_and_job_query_always_close_owned_job(self):
        job=self.fake_job()
        def fail(*a,**kw):raise OSError('Popen failed')
        observed=m.OwnedProcesses(SimpleNamespace(Popen=fail),job_factory=lambda:job)
        with self.assertRaises(OSError):observed.Popen(['nvda.exe'])
        self.assertIsNone(job.handle)
        for failure in ('query','terminate'):
            job=m.OwnedNvdaJob.__new__(m.OwnedNvdaJob);job.handle=77;closed=[]
            job.kernel=SimpleNamespace(CloseHandle=lambda h:closed.append(h) or True,
                                       TerminateJobObject=lambda *a:False)
            job.ct=SimpleNamespace(WinError=lambda code:OSError('native failure'),get_last_error=lambda:5)
            def query_error():raise OSError('accounting failed')
            job.active=query_error if failure=='query' else lambda:1
            with self.subTest(failure=failure),self.assertRaises(OSError):job.finish(grace_seconds=0)
            self.assertEqual(closed,[77]);self.assertIsNone(job.handle)

    @unittest.skipUnless(os.name=='nt','Actual bounded Windows owned process-family test')
    def test_actual_windows_child_and_grandchild_job_normal_and_forced_cleanup(self):
        for orphan in (False,True):
            job=m.OwnedNvdaJob();process=None
            child_code='import time;time.sleep('+('5' if orphan else '.6')+')'
            code='import subprocess,sys,time;p=subprocess.Popen([sys.executable,"-I","-B","-c",'+repr(child_code)+']);'+('time.sleep(.3)' if orphan else 'p.wait(timeout=4)')
            try:
                process=subprocess.Popen([sys.executable,'-I','-B','-c',code],creationflags=4)
                job.assign_and_resume(process)
                deadline=m.time.monotonic()+4
                while job.active()<2 and process.poll() is None and m.time.monotonic()<deadline:m.time.sleep(.01)
                self.assertEqual(job.active(),2,'Actual own child and grandchild must both be in the job')
                process.wait(timeout=5)
                result=job.finish(grace_seconds=0 if orphan else 2)
                self.assertEqual(result['active_after_cleanup'],0)
                self.assertEqual(result['forced_tree_termination'],orphan)
                if orphan:self.assertGreaterEqual(result['active_before_cleanup'],1)
            finally:
                if job.handle is not None:job.finish(grace_seconds=0)
                if process is not None and process.poll() is None:process.kill();process.wait(timeout=5)

    def description(self):
        return SimpleNamespace(pid=9,returncode=0,stderr='',stdout=json.dumps({
            'target_pid':9,'capture_mode':'process-include-current-pid',
            'selected_endpoint':{'id':'owned-endpoint','name':'CABLE Input (VB-Audio Virtual Cable)'}}))

    def test_describe_only_child_identity_and_bounded_endpoint_are_required(self):
        render={'name':'CABLE Input (VB-Audio Virtual'}
        self.assertEqual(m.validate_described_endpoint(self.description(),render)['target_pid'],9)
        for key,value in [('target_pid',10),('capture_mode','unrelated'),('selected_endpoint',{'id':'bad\n','name':render['name']})]:
            child=self.description();data=json.loads(child.stdout);data[key]=value;child.stdout=json.dumps(data)
            with self.subTest(key=key),self.assertRaises(ValueError):m.validate_described_endpoint(child,render)

    def fixture(self,events,*,cleanup_ok=True):
        child=self.description()
        @contextmanager
        def owned(inf,state):
            events.append('device-enter');state['owned_instance_id']='ROOT\\EXACT'
            try:yield
            finally:
                events.append('device-cleanup')
                state['cleanup']={'attempted':True,'removed':cleanup_ok,'absence_verified':cleanup_ok}
        pnp=SimpleNamespace(owned_device=owned,matching=lambda:['ROOT\\EXACT'],instance_exists=lambda _:True)
        device=SimpleNamespace(guard_environment=lambda *a:events.append('environment'),
            verify_package=lambda *a:{'synthetic':True},endpoints=lambda:{'synthetic':True},WindowsPnP=lambda:pnp,
            select_new_vendor_endpoints=lambda *a:({'name':'CABLE Input (VB-Audio Virtual'},None))
        def own_child(command,timeout):events.append('describe-child-reaped');return child
        guard=SimpleNamespace(verify_build=lambda *a:{'synthetic':True},own_child=own_child)
        args=SimpleNamespace(owned_virtual_render=True,ephemeral_ci=True,headless_ui_probe=False,
            package=Path('/synthetic/package'),output=Path('/synthetic/output'),validation=Path('/synthetic/validation'),
            marker_helper=Path('/synthetic/helper.exe'),marker_build_receipt=Path('/synthetic/build.json'))
        return args,device,guard

    def test_endpoint_lease_spans_both_processes_and_cleanup_is_after_reaping(self):
        events=[];args,device,guard=self.fixture(events);report={}
        with patch.object(m,'_load_pinned',side_effect=[device,guard]),patch.object(m,'_sha_file',return_value=m.MARKER_CPP_SHA256):
            with m.owned_virtual_render(args,report) as lease:
                self.assertEqual(lease.endpoint['id'],'owned-endpoint')
                lease.verify_live();events.extend(['first-nvda-reaped','second-nvda-reaped'])
                report['owned_process_cleanup']={'all_reaped_before_device_cleanup':True}
        self.assertLess(events.index('describe-child-reaped'),events.index('first-nvda-reaped'))
        self.assertLess(events.index('second-nvda-reaped'),events.index('device-cleanup'))
        self.assertFalse(report['owned_virtual_render']['capture_or_microphone_api_requested'])

    def test_missing_process_reap_or_device_absence_fails(self):
        for cleanup_ok in (True,False):
            events=[];args,device,guard=self.fixture(events,cleanup_ok=cleanup_ok);report={}
            with patch.object(m,'_load_pinned',side_effect=[device,guard]),patch.object(m,'_sha_file',return_value=m.MARKER_CPP_SHA256):
                with self.assertRaises(RuntimeError):
                    with m.owned_virtual_render(args,report):
                        report['owned_process_cleanup']={'all_reaped_before_device_cleanup':not cleanup_ok}
            self.assertIn('device-cleanup',events)
            if not cleanup_ok:self.assertTrue(report['owned_virtual_cleanup_failed'])

    def test_virtual_route_never_accepts_headless_or_non_ephemeral_operation(self):
        for key in ('headless_ui_probe','ephemeral_ci'):
            args,_,_=self.fixture([]);setattr(args,key,key=='headless_ui_probe')
            with patch.object(m,'_load_pinned',side_effect=AssertionError('must reject before helper import')):
                with self.assertRaises(ValueError):
                    with m.owned_virtual_render(args,{}):pass
        with m.owned_virtual_render(SimpleNamespace(owned_virtual_render=False),{}) as lease:self.assertIsNone(lease)


class WorkflowContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        name=Path('.github/workflows/dordiai-source13-settings-keyboard.yml')
        path=ROOT.parent/name
        if not path.exists():path=ROOT/name  # Standalone candidate packet fixture.
        cls.source=path.read_text(encoding='utf-8')

    def test_placeholder_rejection_before_core_api_acquisition(self):
        w=self.source
        self.assertLess(w.index('pin=module.read_pin'),w.index('urllib.request.Request'))
        self.assertLess(w.index('pin=module.read_pin'),w.index('actions/download-artifact'))
        for value in ['run.get("conclusion")!="success"','artifact.get("digest")!="sha256:"+pin["artifact_sha256"]',
                      'actual!=os.environ["SOURCE13_SHA"]']:
            self.assertIn(value,w)

    def test_all_six_python_blocks_compile(self):
        count=0
        for step in self.source.split('      - '):
            if '        shell: python\n' not in step or '        run: |\n' not in step:continue
            block=step.split('        run: |\n',1)[1];lines=[]
            for line in block.splitlines(True):
                if line.strip() and not line.startswith('          '):break
                lines.append(line)
            ast.parse(textwrap.dedent(''.join(lines)));count+=1
        self.assertEqual(count,6)

    def test_optional_virtual_route_uses_only_frozen_marker_and_existing_vendor_guards(self):
        w=self.source
        for value in ['options: [owned-virtual, existing-or-headless]','default: owned-virtual',
                      'from windows_virtual_audio_trial import check_audio_service_receipt',
                      'bc44e8974191a5a2427d6c979e2dab08dbb09925f3f435dfa2f0ba3e45b6eb90',
                      'signtool verify /kp /v /c','--owned-virtual-render','--marker-build-receipt',
                      'DORDIAI_SETTINGS_OUTPUT','RUNNER_TEMP']:
            self.assertIn(value,w)
        self.assertNotIn('nvda-longread.exe',w)
        self.assertNotIn('continue-on-error: true',w)
        self.assertNotIn('Start-Process',w)

    def test_only_bounded_receipts_are_uploaded_not_private_sdk_or_model_tree(self):
        self.assertIn('path: dordiai-voices/settings-keyboard-evidence',self.source)
        self.assertNotIn('path: dordiai-voices/windows-settings-results',self.source)
        self.assertIn('if: always()',self.source)
        self.assertIn('gzip.compress(bundle,mtime=0)',self.source)

    def test_all_reviewed_tool_pins_match_actual_candidate_bytes(self):
        import hashlib
        expected=self.source.split('          expected=',1)[1].split('          for name,pin',1)[0]
        for relative,pin in ast.literal_eval(textwrap.dedent(expected)).items():
            path=ROOT/relative
            if not path.exists():
                # The standalone packet has only the new tool and the immutable
                # smoke source; source13 validator is separately supplied by root.
                self.assertEqual(relative,'tools/validate_source13_integration_receipt.py')
                self.assertEqual(pin,m.PIN_VALIDATOR_BLOB)
                continue
            raw=path.read_bytes();self.assertEqual(hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest(),pin)


if __name__=='__main__':unittest.main()
