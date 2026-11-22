"""Injected only into one fresh owned official NVDA config by its controller."""
import copy,ctypes,hashlib,json,os,sys,threading,time
from pathlib import Path
import api,config,controlTypes,core,globalPluginHandler,globalVars,speech,synthDriverHandler,textInfos,versionInfo,wx
SETTINGS=__SETTINGS__
ROOT=Path(SETTINGS['root'])
DRIVER=None
PHASE='starting'
FINISHED=False
DONE=False
CANCEL_SCHEDULED=False
PCM=bytearray()
EVENTS=[]
ROUTES=[]
SEQUENCES=[]
LOCK=threading.Lock()
SAVED={}
ORIGINAL_FEED=None
ORIGINAL_PARTS=None
FRAME=None
CONTROL=None
USER=None
RATE=24000
CLOCK={}
CASE=None
SNAPSHOTS=[]
HIGH_LEVEL=[]
COUNTERS={'feed_entered':0,'feed_returned':0,'planner_requests':0,'public_read_dispatches':0,'public_read_returns':0,'wx_heartbeats':0}
REPORT={'format':'dordiai-owned-nvda-longread','status':'running','probe_id':SETTINGS['probe_id'],
    'pid':os.getpid(),'controller_pid':SETTINGS['controller_pid'],'recording_pcm_sink_test_double':False,
    'physical_audio_verified':False,'acoustic_latency_verified':False,'native_pronunciation_verified':False,
    'product_ready':False,'no_manual_language_commands':True,'driver_speak_not_called_by_probe':True,
    'whole_workload_warmup_performed':False,'configured_rate':80,
    'source_probe_sha256':SETTINGS['source_probe_sha256'],'source_helpers_sha256':SETTINGS['source_helpers_sha256']}

# Exact pure original workload and audit routines, extracted from a pinned
# unchanged plain probe. No input text, membership or expected route is edited.
__SOURCE_HELPERS__


def publish(name,value):
    with (ROOT/name).open('x',encoding='utf-8') as out:json.dump(value,out,sort_keys=True,separators=(',',':'),ensure_ascii=True)


def guarded(function):
    def wrapped():
        try:function()
        except Exception as error:fail(error)
    return wrapped


def state_snapshot(label):
    public_state=speech.getState();mode=public_state.speechMode
    row={'label':label,'when_ns':time.perf_counter_ns(),'phase':PHASE,
        'speech_mode':getattr(mode,'name',str(mode)),'speech_is_speaking':bool(speech.isSpeaking()),
        'speech_been_canceled':bool(public_state.beenCanceled),'speech_is_paused':bool(public_state.isPaused),
        'selected_synth_is_owned_driver':synthDriverHandler.getSynth() is DRIVER,
        'done_notification_seen':DONE,'counters':dict(COUNTERS),'thread':threading.current_thread().name,
        'high_level_inputs':len(HIGH_LEVEL),'driver_sequences':len(SEQUENCES),'planned_routes':len(ROUTES),'feed_events':len(EVENTS),'reference_bytes':len(PCM)}
    if DRIVER is not None:
        row.update(driver_name=DRIVER.name,driver_type=type(DRIVER).__module__+'.'+type(DRIVER).__name__,
            driver_rate=DRIVER.rate,driver_rate_multiplier=DRIVER.rateMultiplier,
            driver_default_tempo=DRIVER._tempo(DRIVER.rate,DRIVER.rateMultiplier),
            driver_generation=getattr(DRIVER,'_generation',None),driver_paused=getattr(DRIVER,'_paused',None),driver_closed=getattr(DRIVER,'_closed',None),
            driver_error=str(getattr(DRIVER,'_dordiai_last_error',None))[:1000])
        queue=getattr(DRIVER,'_jobs',None);thread=getattr(DRIVER,'_thread',None)
        row['driver_jobs_size_approximate']=queue.qsize() if queue is not None else None
        row['driver_thread_alive']=thread.is_alive() if thread is not None else None
    implementation=getattr(speech,'speech',None)
    manager=getattr(implementation,'_manager',None) if implementation is not None else None
    if manager is None:manager=getattr(speech,'_manager',None)
    if manager is not None:
        row['manager_type']=type(manager).__module__+'.'+type(manager).__name__
        indexes=getattr(manager,'_indexesSpeaking',None)
        row['manager_indexes_speaking']={'count':len(indexes),'strict_int_items':[x for x in list(indexes)[:8] if type(x) is int]} if isinstance(indexes,(list,tuple,set,frozenset)) else None
        row['manager_should_push_when_done']=bool(getattr(manager,'_shouldPushWhenDoneSpeaking',False))
        current=getattr(manager,'_curPriQueue',None)
        def queue_state(queue):
            if queue is None:return None
            priority=getattr(queue,'priority',None);pending=getattr(queue,'pendingSequences',None)
            return {'priority':int(priority) if isinstance(priority,int) else None,'pending_sequence_count':len(pending) if pending is not None else None}
        row['manager_current_priority_queue']=queue_state(current)
        queues=getattr(manager,'_priQueues',None)
        if isinstance(queues,dict):queues=list(queues.values())
        if isinstance(queues,(list,tuple)):row['manager_priority_queues']=[queue_state(q) for q in queues[:3]]
    if len(SNAPSHOTS)<128:SNAPSHOTS.append(row)
    return row


def heartbeat():
    if FINISHED:return
    COUNTERS['wx_heartbeats']+=1;state_snapshot('wx-heartbeat')
    core.callLater(1000,guarded(heartbeat))


def on_high_level(speechSequence,originalSpeechSequence=None,**kwargs):
    if PHASE in ('longread','cancelling') and len(HIGH_LEVEL)<128:
        HIGH_LEVEL.append({'when_ns':time.perf_counter_ns(),'speech_sequence':_plain_sequence(speechSequence),
            'original_speech_sequence':_plain_sequence(originalSpeechSequence if originalSpeechSequence is not None else speechSequence)})


def fail(error):
    global FINISHED,PHASE
    if FINISHED:return
    state_snapshot('failure-before-cleanup')
    FINISHED=True
    with LOCK:raw=bytes(PCM);events=list(EVENTS)
    with (ROOT/'partial-reference.pcm').open('xb') as out:out.write(raw)
    REPORT.update(status='failed',error=type(error).__name__+': '+str(error),failure_phase=PHASE,
        diagnostic_snapshots=list(SNAPSHOTS),feed_events=events,planned_routes=list(ROUTES),driver_sequences=list(SEQUENCES),
        high_level_speech_inputs=list(HIGH_LEVEL),partial_reference_scope='Exact feed payloads observed before failure; incomplete workload, never accepted as complete reference',
        partial_reference_pcm={'filename':'partial-reference.pcm','size_bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
    PHASE='failed'
    try:cleanup()
    except Exception as cleanup_error:REPORT['cleanup_error']=type(cleanup_error).__name__+': '+str(cleanup_error)
    # The controller may still be finishing its exact90second capture. Keep
    # focus-destroy/desktop announcements suppressed until it reaps this child.
    speech.setSpeechMode(speech.SpeechMode.off)
    state_snapshot('failure-after-cleanup');REPORT['diagnostic_snapshots']=list(SNAPSHOTS)
    try:publish('plugin-complete.json',REPORT)
    except FileExistsError:pass


def observe_feed(data,*args,**kwargs):
    global CANCEL_SCHEDULED
    before=time.perf_counter_ns();phase=PHASE;raw=None
    COUNTERS['feed_entered']+=1
    if phase in ('longread','cancelling'):
        if not isinstance(data,(bytes,bytearray,memoryview)):raise TypeError('Actual WavePlayer bytes required')
        raw=bytes(data)
        with LOCK:
            cap=RATE*2*(80 if phase=='longread' else 7)
            if len(PCM)+len(raw)>cap or len(EVENTS)>=16384:raise ValueError('Independent PCM/feed quota exceeded')
            if phase=='cancelling' and raw and any(raw) and not CANCEL_SCHEDULED:
                CANCEL_SCHEDULED=True
                wx.CallAfter(core.callLater,300,guarded(cancel_actual_speech))
    result=ORIGINAL_FEED(data,*args,**kwargs)
    after=time.perf_counter_ns();COUNTERS['feed_returned']+=1
    if raw is not None:
        with LOCK:
            offset=len(PCM)//2;PCM.extend(raw)
            EVENTS.append({'before_feed_ns':before,'after_feed_ns':after,'bytes':len(raw),'reference_offset_frames':offset,'phase_at_call':phase})
    return result


def observe_parts(*args,**kwargs):
    source=ORIGINAL_PARTS(*args,**kwargs)
    try:
        for part in source:
            kind,value=part
            if PHASE in ('longread','cancelling') and kind in ('text','character') and isinstance(value,dict):
                if len(ROUTES)>=1024:raise ValueError('Route observation quota exceeded')
                COUNTERS['planner_requests']+=1
                ROUTES.append({key:value.get(key) for key in ('text','language','profile','character','speed')})
            yield part
    finally:
        close=getattr(source,'close',None)
        if close is not None:close()


def on_synth(speechSequence):
    if PHASE in ('longread','cancelling') and synthDriverHandler.getSynth() is DRIVER:
        if len(SEQUENCES)>=1024:raise ValueError('Speech sequence observation quota exceeded')
        SEQUENCES.append(_plain_sequence(speechSequence))


def on_done(synth=None,**kwargs):
    global DONE
    if synth in (None,DRIVER) and PHASE in ('longread','cancelling'):DONE=True


def cleanup():
    global ORIGINAL_FEED,ORIGINAL_PARTS,FRAME
    try:speech.cancelSpeech()
    except Exception:pass
    try:synthDriverHandler.synthDoneSpeaking.unregister(on_done)
    except Exception:pass
    try:synthDriverHandler.pre_synthSpeak.unregister(on_synth)
    except Exception:pass
    try:speech.pre_speech.unregister(on_high_level)
    except Exception:pass
    if DRIVER is not None:
        if ORIGINAL_FEED is not None:DRIVER._player.feed=ORIGINAL_FEED;ORIGINAL_FEED=None
        if ORIGINAL_PARTS is not None:DRIVER._planned_parts=ORIGINAL_PARTS;ORIGINAL_PARTS=None
        if 'voices' in SAVED:
            DRIVER._dordiai_apply(SAVED['voices'],SAVED['languages'],SAVED['default'],SAVED['voice'],{},
                mode=SAVED['mode'],voice_map=SAVED['voice_map'])
            DRIVER.rate=SAVED['rate'];DRIVER.rateMultiplier=SAVED['rateMultiplier']
            config.conf['speech']['autoLanguageSwitching']=SAVED['auto_language']
            config.conf['speech']['reportNotSupportedLanguage']=SAVED['report_language']
            speech.setSpeechMode(SAVED['speech_mode'])
    if FRAME is not None:FRAME.Destroy();FRAME=None


def focus_owned():
    focus=api.getFocusObject();owner=ctypes.c_uint32()
    USER.GetWindowThreadProcessId(CONTROL.GetHandle(),ctypes.byref(owner))
    return owner.value==os.getpid() and USER.GetForegroundWindow()==FRAME.GetHandle() and getattr(focus,'windowHandle',None)==CONTROL.GetHandle() and focus.role==controlTypes.Role.EDITABLETEXT and not api.isTypingProtected()


def poll_ready(deadline):
    global PHASE
    if not focus_owned():
        if time.monotonic()>deadline:raise TimeoutError('Owned genuine Edit focus not acquired')
        core.callLater(100,guarded(lambda:poll_ready(deadline)));return
    info=api.getFocusObject().makeTextInfo(textInfos.POSITION_ALL)
    if info.text.rstrip('\r\n')!=CASE['text']:raise ValueError('Genuine whole TextInfo differs from exact original100 input')
    PHASE='ready'
    publish('plugin-ready.json',{'format':'dordiai-owned-nvda-capture-ready','status':'ready','probe_id':SETTINGS['probe_id'],
        'pid':os.getpid(),'controller_pid':SETTINGS['controller_pid'],'config':str(Path(globalVars.appArgs.configPath).resolve()),
        'synth':DRIVER.name,'image_sha256':hashlib.sha256(Path(sys.executable).resolve().read_bytes()).hexdigest(),
        'sample_rate':RATE,'recording_pcm_sink_test_double':False,'physical_audio_verified':False})
    poll()


def read_actual_file(cancel=False):
    global PHASE,DONE,CANCEL_SCHEDULED
    state_snapshot('read-boundary-before-public-mode-and-cancel')
    speech.setSpeechMode(speech.SpeechMode.talk)
    state_snapshot('read-boundary-talk-before-cancel')
    speech.cancelSpeech()
    state_snapshot('read-boundary-after-public-cancel')
    speech.setSpeechMode(speech.SpeechMode.off)
    if not focus_owned():raise RuntimeError('Owned Edit focus changed before real read')
    text=SETTINGS['cancel_text'] if cancel else CASE['text']
    if cancel:
        CONTROL.SetValue(text);CONTROL.SetInsertionPoint(0)
    info=api.getFocusObject().makeTextInfo(textInfos.POSITION_ALL)
    if info.text.rstrip('\r\n')!=text:raise ValueError('Genuine TextInfo incomplete; no substitute TextInfo accepted')
    fields=[]
    for item in info.getTextWithFields():
        if isinstance(item,textInfos.FieldCommand):
            language=item.field.get('language') if isinstance(item.field,dict) else None
            if language:fields.append(str(language))
    if fields:raise ValueError('Owned plain file unexpectedly has authored language fields')
    with LOCK:PCM.clear();EVENTS.clear()
    ROUTES.clear();SEQUENCES.clear();DONE=False;CANCEL_SCHEDULED=False
    DRIVER._dordiai_last_error=None
    PHASE='cancelling' if cancel else 'longread'
    REPORT['cancel_request_started_ns' if cancel else 'read_started_ns']=time.perf_counter_ns()
    if not cancel:REPORT.update(input_text=text,input_utf8_sha256=hashlib.sha256(text.encode('utf-8')).hexdigest(),source_words=CASE['words'],textinfo_type=type(info).__name__,textinfo_language_fields=fields,complete_range_api='POSITION_ALL',read_api='speech.speakTextInfo')
    speech.setSpeechMode(speech.SpeechMode.talk)
    COUNTERS['public_read_dispatches']+=1;state_snapshot('before-public-speakTextInfo')
    speech.speakTextInfo(info,unit=textInfos.UNIT_PARAGRAPH,reason=controlTypes.OutputReason.CARET)
    COUNTERS['public_read_returns']+=1;state_snapshot('after-public-speakTextInfo')
    if not cancel:core.callLater(50,guarded(lambda:wait_read(time.monotonic()+80)))
    else:core.callLater(6000,guarded(lambda:cancel_watchdog()))


def wait_read(deadline):
    global PHASE
    error=getattr(DRIVER,'_dordiai_last_error',None)
    if error:raise RuntimeError('Real driver error: '+str(error))
    if not (DONE and not speech.isSpeaking() and EVENTS and ROUTES and SEQUENCES):
        if time.monotonic()>deadline:raise TimeoutError('Actual complete longread exceeded80seconds')
        core.callLater(50,guarded(lambda:wait_read(deadline)));return
    PHASE='longread-complete';speech.setSpeechMode(speech.SpeechMode.off)
    with LOCK:raw=bytes(PCM);events=list(EVENTS)
    if not raw or len(raw)%2 or not any(raw):raise ValueError('Actual reference PCM missing')
    with (ROOT/'longread-reference.pcm').open('xb') as out:out.write(raw)
    audit=_plain_route_audit(CASE['words'],ROUTES)
    REPORT.update(status='completed-real-waveplayer-longread',sample_rate=RATE,reference_pcm={'filename':'longread-reference.pcm','size_bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()},
        actual_rate=DRIVER.rate,actual_rate_multiplier=DRIVER.rateMultiplier,effective_default_tempo=DRIVER._tempo(DRIVER.rate,DRIVER.rateMultiplier),
        per_request_speed_is_authoritative=True,planned_routes=list(ROUTES),route_audit=audit,driver_sequences=list(SEQUENCES),feed_events=events,
        real_wave_player_type=type(DRIVER._player).__module__+'.'+type(DRIVER._player).__name__,read_finished_ns=time.perf_counter_ns(),driver_error=error,
        diagnostic_snapshots=list(SNAPSHOTS),high_level_speech_inputs=list(HIGH_LEVEL))
    publish('plugin-longread.json',REPORT)


def cancel_actual_speech():
    global PHASE
    if PHASE!='cancelling':return
    frequency=ctypes.c_longlong();before=ctypes.c_longlong();after=ctypes.c_longlong()
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    for name in ('QueryPerformanceCounter','QueryPerformanceFrequency'):
        getattr(kernel,name).argtypes=[ctypes.POINTER(ctypes.c_longlong)];getattr(kernel,name).restype=ctypes.c_int
    if not kernel.QueryPerformanceFrequency(ctypes.byref(frequency)):raise RuntimeError('Actual QPC frequency unavailable')
    perf_before=time.perf_counter_ns()
    if not kernel.QueryPerformanceCounter(ctypes.byref(before)):raise RuntimeError('QPC before cancel failed')
    speech.cancelSpeech()
    if not kernel.QueryPerformanceCounter(ctypes.byref(after)):raise RuntimeError('QPC after cancel failed')
    perf_after=time.perf_counter_ns()
    CLOCK.update(qpc_frequency=frequency.value,qpc_before_cancel=before.value,qpc_after_cancel=after.value,
        perf_before_cancel_ns=perf_before,perf_after_cancel_ns=perf_after)
    PHASE='cancel-observing'
    speech.setSpeechMode(speech.SpeechMode.off)
    core.callLater(1000,guarded(finish_cancel))


def finish_cancel():
    global PHASE
    if PHASE!='cancel-observing':return
    with LOCK:raw=bytes(PCM);events=list(EVENTS)
    with (ROOT/'cancel-reference.pcm').open('xb') as out:out.write(raw)
    publish('plugin-cancel.json',{'format':'dordiai-owned-real-nvda-cancel','status':'cancel-called-and-observed','pid':os.getpid(),
        'probe_id':SETTINGS['probe_id'],'clock':CLOCK,'sample_rate':RATE,'feed_events':events,'planned_routes':list(ROUTES),
        'cancel_text':SETTINGS['cancel_text'],'actual_cancel_api':'speech.cancelSpeech','queued_reference_not_required_to_finish':True,
        'reference_pcm':{'filename':'cancel-reference.pcm','size_bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()},
        'physical_audio_verified':False,'acoustic_latency_verified':False})
    PHASE='complete'


def cancel_watchdog():
    if PHASE in ('cancelling','cancel-observing'):raise TimeoutError('Actual cancellation did not finish bounded observation')


def poll():
    stop=ROOT/'stop.json'
    if stop.is_file():
        if json.loads(stop.read_text())!={'probe_id':SETTINGS['probe_id']}:raise ValueError('Stop lease differs')
        cleanup();core.callLater(100,core.triggerNVDAExit);return
    for phase,name in (('ready','longread-trigger.json'),('longread-complete','cancel-trigger.json')):
        path=ROOT/name
        if PHASE==phase and path.is_file():
            if json.loads(path.read_text())!={'probe_id':SETTINGS['probe_id']}:raise ValueError('Owned read trigger differs')
            read_actual_file(cancel=phase=='longread-complete')
    core.callLater(50,guarded(poll))


def begin(deadline):
    global DRIVER,ORIGINAL_FEED,ORIGINAL_PARTS,FRAME,CONTROL,USER,RATE,CASE
    if versionInfo.version!='2026.3.1':raise ValueError('Pinned official NVDA version differs')
    if Path(globalVars.appArgs.configPath).resolve()!=Path(SETTINGS['config']):raise ValueError('Owned NVDA config differs')
    lease=ROOT/'owned-launch.json'
    if not lease.is_file():
        if time.monotonic()>deadline:raise TimeoutError('Own controller launch lease missing')
        core.callLater(50,guarded(lambda:begin(deadline)));return
    if json.loads(lease.read_text())!={'pid_expected':os.getpid(),'probe_id':SETTINGS['probe_id']}:raise ValueError('Own process lease differs')
    SAVED['speech_mode']=speech.getState().speechMode;speech.setSpeechMode(speech.SpeechMode.off)
    if not synthDriverHandler.setSynth('kx47Preview'):raise RuntimeError('Actual Dordiai synth selection failed')
    DRIVER=synthDriverHandler.getSynth()
    if DRIVER is None or DRIVER.name!='kx47Preview' or 'Recording' in type(DRIVER._player).__name__:raise RuntimeError('Genuine actual WavePlayer driver required')
    RATE=sys.modules[type(DRIVER).__module__].SAMPLE_RATE
    if RATE not in (22050,24000,48000):raise ValueError('Actual driver rate unsupported')
    if str(config.conf['audio']['outputDevice'])!=SETTINGS['output_device']:raise ValueError('Exact isolated output endpoint differs')
    SAVED.update(voices=[v for v in DRIVER._dordiai_all_voices() if v not in DRIVER._dordiai_selection[0]],
        languages=list(DRIVER._dordiai_enabled_languages),default=DRIVER._dordiai_selection[2],voice=DRIVER.voice,
        mode=DRIVER._dordiai_mode,voice_map=dict(DRIVER._dordiai_voice_map),rate=DRIVER.rate,rateMultiplier=DRIVER.rateMultiplier,
        auto_language=config.conf['speech']['autoLanguageSwitching'],report_language=config.conf['speech']['reportNotSupportedLanguage'])
    CASE=_plain_cases()[0]
    if len(CASE['words'])!=100 or hashlib.sha256(CASE['text'].encode('utf-8')).hexdigest()!=SETTINGS['input_sha256']:raise ValueError('Authenticated original100 input changed')
    DRIVER._dordiai_apply(SAVED['voices'],CASE['enabled'],'uk',SAVED['voice'],{},mode='auto',voice_map={k:v for k,v in SAVED['voice_map'].items() if k in CASE['enabled']})
    DRIVER.rate=80
    from config.configFlags import ReportNotSupportedLanguage
    config.conf['speech']['reportNotSupportedLanguage']=ReportNotSupportedLanguage.OFF.value
    config.conf['speech']['autoLanguageSwitching']=True
    ORIGINAL_FEED=DRIVER._player.feed;ORIGINAL_PARTS=DRIVER._planned_parts
    DRIVER._player.feed=observe_feed;DRIVER._planned_parts=observe_parts
    synthDriverHandler.synthDoneSpeaking.register(on_done);synthDriverHandler.pre_synthSpeak.register(on_synth)
    if getattr(speech,'pre_speech',None) is not None:speech.pre_speech.register(on_high_level)
    USER=ctypes.WinDLL('user32',use_last_error=True)
    USER.GetForegroundWindow.argtypes=[];USER.GetForegroundWindow.restype=ctypes.c_void_p
    USER.GetWindowThreadProcessId.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_uint32)];USER.GetWindowThreadProcessId.restype=ctypes.c_uint32
    FRAME=wx.Frame(None,title='Dordiai owned longread transport experiment')
    CONTROL=wx.TextCtrl(FRAME,style=wx.TE_MULTILINE|wx.TE_DONTWRAP|wx.HSCROLL,size=(1000,240))
    FRAME.SetClientSize((1040,300));path=ROOT/'original100.txt';path.write_text(CASE['text'],encoding='utf-8-sig')
    if not CONTROL.LoadFile(str(path)) or CONTROL.GetValue()!=CASE['text']:raise RuntimeError('Owned UTF8 file not loaded exactly')
    CONTROL.SetInsertionPoint(0);FRAME.Show();FRAME.Raise();CONTROL.SetFocus()
    core.callLater(300,guarded(lambda:poll_ready(time.monotonic()+10)))
    core.callLater(1000,guarded(heartbeat))

class GlobalPlugin(globalPluginHandler.GlobalPlugin):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        core.callLater(1000,guarded(lambda:begin(time.monotonic()+8)))
    def terminate(self):
        cleanup();super().terminate()
