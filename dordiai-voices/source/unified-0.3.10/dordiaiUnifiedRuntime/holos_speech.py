"""Stream multilingual acoustics with a shared target identity per person."""
from concurrent.futures import ThreadPoolExecutor
from queue import Queue,Full,Empty
from threading import Thread,Event,get_ident,RLock,Lock,local
from collections import OrderedDict
import json
from time import perf_counter
from functools import cached_property

import numpy as np

from native_multilingual import NativeMultilingual
from ipa_uk import ipa
from reading_style import DELIVERY, PROFILES, locale, prepare_runs, punctuation_pause, style_for
from russian_phonetics import russian_phones
from speech_tempo import stream_tempo
from spelling_audio import SPECIAL_NAMES, render_letter
from ukrainian_stress import accent_text
from ukrainian_voices import UkrainianVoices
from voice_controls import apply_stream_controls
from voice_delivery import clean_onset, compact_padding, condition_shared, prepare_letter,match_level,match_stream_level,trim_source_padding
from shared_identity import SharedIdentity
from session_control import SynthesisCancelled,cancel_running
from data_registry import Registry

RATE = 24000
LAUGH = {"uk": "ха-ха", "en": "ha-ha", "ru": "ха-ха", "sk":"ha-ha", "de":"ha-ha", "pl":"ha-ha"}


def initial_buffer(chunks,minimum=7200):
    """A tiny first remnant after silence trimming must not start playback."""
    pending=[]
    size=0
    ready=False
    try:
        for block in chunks:
            if ready:
                yield block
                continue
            pending.append(block);size+=len(block)
            if size>=minimum:
                ready=True
                yield np.concatenate(pending)
                pending=[]
        if pending:yield np.concatenate(pending)
    finally:
        close=getattr(chunks,'close',None)
        if close is not None:close()


class ConversionOwner:
    """Conversion cancellation belongs to its playback, not a future source job."""
    def __init__(self,reader):self.reader=reader;self.context=local()
    @property
    def cancel_event(self):return getattr(self.context,'event',self.reader.cancel_event)
    def check_cancelled(self):
        if hasattr(self.context,'event'):
            event=self.context.event
            if event is not None and event.is_set():raise SynthesisCancelled()
        else:self.reader.check_cancelled()
    def __getattr__(self,name):return getattr(self.reader,name)


class FastSpeech:
    def __init__(self, models, references,registry=None):
        # Both stages need enough parallelism. Two source threads could not
        # prepare short sentences as quickly as accelerated audio consumed
        # them, even when every upcoming request was correctly announced.
        self.reader = UkrainianVoices(models, references, threads=min(4,__import__('os').cpu_count() or 4))
        self.english = NativeMultilingual(models / "PocketTTS", references / "native_profiles", threads=3)
        self._conversion_owner=ConversionOwner(self.reader)
        self.identity = SharedIdentity(models, references, self._conversion_owner)
        from buffered_converter import BufferedConverter
        self.identity.tone=BufferedConverter(models,references,threads=min(4,__import__('os').cpu_count() or 4))
        self.registry=self.identity.registry
        if registry is not None:self.registry=self.identity.registry=registry
        self._acoustic_cache=OrderedDict()
        self._acoustic_lock=RLock()
        self._source_lock=RLock()
        self._ahead_source_slot=Lock()
        self._ahead_ready=Event()
        self._anticipated=Queue(maxsize=8)
        self._anticipated_keys=set()
        self._source_trace=[] if __import__('os').environ.get('DORDIAI_TRACE_SOURCES')=='1' else None
        self._trace_origin=perf_counter()

    @property
    def common_enabled(self):
        return bool(self.registry.languages) and all(row['backend']=='supertonic' for row in self.registry.languages.values())

    @cached_property
    def common(self):
        from common_carrier import CommonCarrier
        settings=next(row for row in self.registry.languages.values() if row['backend']=='supertonic')
        return CommonCarrier(self.identity.models,settings,self.reader)

    def preload(self):
        backends={row['backend'] for row in self.registry.languages.values()}
        if not backends&{'holos','pocket'}:
            if 'supertonic' in backends:self.common.preload()
            self.identity.preload()
            from latin_languages import detector
            detector()
            return
        if any(row['backend']=='supertonic' for row in self.registry.languages.values()):self.common.preload()
        # Load the acoustic session and initialize the pronunciation dictionary
        # concurrently. Russian and English use the same phonemizer and model.
        def dictionaries():
            self.english.warm_english()
            origins={self.registry.source_voice(profile,'pocket') for profile in self.registry.voices}
            for origin in origins:
                if (self.english.profiles/(origin+'.npz')).is_file():self.english.english_state(origin)
            russian_phones("Откройте меню.")
            self.identity.preload()
            from latin_languages import detector
            detector()

        with ThreadPoolExecutor(max_workers=1) as helper:
            ready = helper.submit(dictionaries)
            self.reader.preload("uk")
            ready.result()

    def plan(self, request):
        spelling = request["character"]
        chosen = request.get("readingStyle", "plain")
        style, text = style_for(request["text"], chosen, spelling)
        hints = request.get("segments")
        if hints:
            hints = [[lang, style_for(span, chosen)[1]] for lang, span in hints]
        else:
            hints = [[request.get("language"), text]]
        original = self.registry.locale(request.get("language"))
        hints = [[lang, span.replace("[laughter]", LAUGH.get(self.registry.locale(lang or original),'ha-ha'))]
                 for lang, span in hints]
        runs = prepare_runs(hints, "uk", request.get("numberLanguage", "auto"),
                            request.get("detectRussian", True), spelling,self.registry)
        disabled=set(request.get("disabledLanguages", ()))
        if disabled:
            fallback=request["defaultLanguage"]
            runs=[(fallback if self.registry.locale(lang) in disabled else lang,span) for lang,span in runs]
        return style, text, [(lang, span) for lang, span in runs if span.strip()]

    def blocks(self, request, plan=None, cancellation=None):
        self._conversion_owner.context.event=cancellation if cancellation is not None else self.reader.cancel_event
        yield from self.prepared_blocks(request,self.prepare_source(request,cancellation))

    def metadata(self, request, plan):
        style, _, runs = plan
        labels = {self.registry.locale(language) for language, _ in runs}
        language = labels.pop() if len(labels) == 1 else "mixed"
        engine = 'Shared speaker: '+', '.join(sorted(labels or {self.registry.locale(lang) for lang,_ in runs}))
        return {"profile": request["profile"], "language": language, "readingStyle": style, "engine":engine,
                "decoder":type(self.identity.tone).__name__,
                "radeon_blocks":getattr(getattr(self.identity.tone,"graphics",None),"used_blocks",0),
                **({'source_recent':self._source_trace[-8:]} if self._source_trace is not None else {})}

    def prepare_source(self,request,cancellation=None,*,anticipation=False):
        if request.get('speed',1.)>=3. and not request.get('character'):
            self.identity.tone.warm_graphics()
        if cancellation is not None and cancellation.is_set():raise SynthesisCancelled()
        key=self._acoustic_key(request)
        with self._acoustic_lock:
            cached=self._acoustic_cache.get(key)
            if cached is not None:
                self._acoustic_cache.move_to_end(key)
                return cached
        # One acoustic owner survives batch boundaries. A cached next line
        # can be converted while an earlier batch prepares a later source.
        with self._source_lock:
            with self._acoustic_lock:
                cached=self._acoustic_cache.get(key)
                if cached is not None:return cached
            self.reader.cancel_thread=get_ident()
            if cancellation is not None:self.reader.cancel_event=cancellation
            started=perf_counter()
            prepared=self._prepare_source(request)
            if self._source_trace is not None:
                self._source_trace.append(dict(text=request.get('text','')[:80],anticipation=anticipation,
                    started_ms=round((started-self._trace_origin)*1000),duration_ms=round((perf_counter()-started)*1000),
                    queued=self._anticipated.qsize(),cached=len(self._acoustic_cache)))
                self._source_trace[:]=self._source_trace[-32:]
            self.reader.check_cancelled()
            if key is not None:
                with self._acoustic_lock:
                    self._acoustic_cache[key]=prepared
                    # Several future lines can each contain two packets.
                    # Eight entries could evict the current prepared prefix
                    # before SpeechManager actually requested that prefix.
                    while len(self._acoustic_cache)>32:self._acoustic_cache.popitem(last=False)
            return prepared

    def _acoustic_key(self,request):
        if len(request.get('text',''))>240:return None
        if self.common_enabled:
            # Source acoustics are identical for every target person. Reuse
            # them across voices and changes of volume/pitch; identity and
            # user controls are applied later and retain separate PCM keys.
            request=dict(request,profile='*',controls={},speed=self._source_tempo(request))
            # Transport and bookmark position do not change source acoustics.
            request.pop('mode',None);request.pop('continuation',None)
        return json.dumps(request,ensure_ascii=True,sort_keys=True)

    @staticmethod
    def _source_tempo(request):
        # Keep the model's phonetic durations for phrases too. Source speed
        # 1.35 erased "documents" in "Three documents are selected" and
        # joined Ukrainian word boundaries. User tempo is applied afterwards
        # by the pitch-preserving audio stage, identically for every voice.
        return 1.

    def anticipate(self,requests):
        for request in requests[:8]:
            key=self._acoustic_key(request)
            if key is None:continue
            with self._acoustic_lock:
                if key in self._acoustic_cache or key in self._anticipated_keys:continue
                try:self._anticipated.put_nowait(request)
                except Full:break
                self._anticipated_keys.add(key)

    def clear_ahead(self):
        while True:
            try:request=self._anticipated.get_nowait()
            except Empty:return
            with self._acoustic_lock:self._anticipated_keys.discard(self._acoustic_key(request))

    def _prepare_source(self,request):
        """Acoustic stage only; one dedicated producer owns these sessions."""
        plan=self.plan(request)
        style,text,runs=plan
        profile=request['profile']
        parts=[]
        if self.common_enabled and not request.get('disabledLanguages'):
            original=request.get('segments') or [[request.get('language'),text]]
            hints={self.registry.locale(language) for language,span in original if language and span.strip()}
            language=next(iter(hints)) if len(hints)==1 and all(hint for hint,span in original if span.strip()) else 'na'
            automatic_runs=None
            if not request['character']:
                from speech_text import script_mismatch
                incompatible_tag = script_mismatch(text, language)
                from latin_languages import confidently_mixed,primary_language,mixed_scripts
                automatic=(not hints or hints=={'uk'} and request.get('detectRussian',True)
                           or incompatible_tag)
                if automatic:
                    # plan() already analysed genuinely untagged text. Clear
                    # language tags must not trigger another word-by-word
                    # search through all 31 language dictionaries.
                    automatic_runs=(runs if incompatible_tag or all(not hint for hint,span in original if span.strip()) else
                        prepare_runs([[None,text]],'uk','auto',request.get('detectRussian',True),False,self.registry))
                    language=primary_language(text) or 'na'
                if mixed_scripts(text) or automatic and confidently_mixed(text):language='na'
                if language=='na' and any(c.isdecimal() for c in text) and automatic_runs is None and len(original)==1:
                    automatic_runs=prepare_runs([[None,text]],'uk','auto',request.get('detectRussian',True),False,self.registry)
            if any(c.isdecimal() for c in text) and not request['character']:
                from reading_style import english_numeric_text
                from speech_text import speak_numbers
                normalized=[]
                number_runs=automatic_runs or runs
                for code,span in number_runs:
                    if language!='na':code=language
                    target=code if request.get('numberLanguage','auto')=='auto' else request['numberLanguage']
                    if target=='en':span=english_numeric_text(span)
                    if code in self.registry.languages and target in self.registry.languages:span=speak_numbers(span,target,code)
                    normalized.append(span)
                text=' '.join(normalized)
                if any('а'<=c.lower()<='я' or c.lower() in 'іїєґ' for c in text) and any('a'<=c.lower()<='z' for c in text):language='na'
            # A single inference covers arbitrary word-level code switching;
            # the speaker and source model remain the same throughout.
            # Generate full phonetic durations, then apply the requested
            # pitch-safe tempo without dropping words in the acoustic model.
            # This also reuses source acoustics across ordinary rate changes.
            source_tempo=self._source_tempo(request)
            from grouped_words import word_batch, synthesize as synthesize_words
            batch=word_batch(automatic_runs or runs) if language=='na' and not request['character'] else None
            audio=synthesize_words(self.common,batch,source_tempo) if batch else ()
            if not audio:
                audio=tuple(self.common.synthesize(text,language,source_tempo,append_terminal=request['character']))
            if audio:
                spoken=np.concatenate(audio)
                if not request['character'] and any(c.isalpha() for c in text) and np.max(np.abs(spoken),initial=0)<.001:
                    source_tempo=1.
                    audio=tuple(self.common.synthesize(text,language,source_tempo,
                                                       append_terminal=len(request.get('text','').split())<=1))
                    spoken=np.concatenate(audio) if audio else np.empty(0,np.float32)
                    if np.max(np.abs(spoken),initial=0)<.001:
                        raise RuntimeError('The acoustic model produced no audible speech')
                if not request['character']:spoken=trim_source_padding(spoken)
                parts.append((self.identity.carrier_key(next(iter(self.registry.languages))),spoken))
            return plan,parts,source_tempo,language
        if request['character'] and runs and runs[0][0]=='uk' and text.casefold() in SPECIAL_NAMES:
            origin=self.registry.source_voice(profile,'holos')
            carrier='holos' if self.registry.voice(profile).get('holos') else origin+'-holos'
            parts.append((carrier,render_letter(self.reader,origin,text.casefold())))
        else:
            acoustic=[]
            def flush():
                if not acoustic:return
                model=self.reader.holos
                tokens=''.join(c for c in ' '.join(acoustic) if c in model.tokenizer._token_to_id)
                acoustic.clear()
                if any(c.isalpha() for c in tokens):
                    origin=self.registry.source_voice(profile,'holos')
                    audio=tuple(model.stream(tokens,voice=self.reader._holos_style(origin),speed=1.,chunk_frames=40))
                    carrier='holos' if self.registry.voice(profile).get('holos') else origin+'-holos'
                    if audio:parts.append((carrier,np.concatenate(audio)))
            for language,span in runs:
                self.reader.check_cancelled()
                backend=self.registry.language(language)['backend']
                if backend=='pocket':
                    flush()
                    event=self.reader.cancel_event
                    origin=self.registry.source_voice(profile,'pocket')
                    blocks=tuple(self.english.stream(origin,language,span,1.,event.is_set if event is not None else lambda:False))
                    if blocks:parts.append((origin+'-pocket',np.concatenate(blocks)))
                elif backend in ('piper','rhvoice'):
                    flush()
                    blocks=tuple(self.identity.native(language,span))
                    if blocks:parts.append((self.identity.carrier_key(language),np.concatenate(blocks)))
                elif backend=='supertonic':
                    flush()
                    blocks=tuple(self.common.synthesize(span,self.registry.locale(language),1.))
                    if blocks:parts.append((self.identity.carrier_key(language),np.concatenate(blocks)))
                else:
                    acoustic.append(russian_phones(span) if language=='ru' else ipa(accent_text(span)))
            flush()
        return plan,parts

    def prepared_blocks(self,request,prepared):
        plan,parts=prepared[:2]
        source_tempo=prepared[2] if len(prepared)>2 else 1.
        style,text,runs=plan
        pace,pitch,gain=DELIVERY[style]
        speed=min(10.,pace*request['speed'])/source_tempo
        spelling=request['character']
        conversion_tempo=min(2.,max(1.,speed)) if not spelling and any(c!='holos' for c,_ in parts) else 1.
        def render():
            for carrier,audio in parts:
                if carrier=='holos':
                    yield from stream_tempo((audio,),RATE,conversion_tempo)
                else:
                    blocks=self.identity.convert(request['profile'],carrier,(audio,),conversion_tempo,stream=not spelling,
                        fast_reading=self.common_enabled and not spelling and speed>=3.)
                    if self.common_enabled:
                        blocks=map(match_level,blocks) if spelling else match_stream_level(blocks)
                    yield from blocks
        raw=render()
        if spelling:
            pieces=tuple(raw)
            if not pieces:return
            vocals=(prepare_letter(np.concatenate(pieces)),)
        else:
            vocals=compact_padding(clean_onset(raw),text)
            delivery={} if self.common_enabled else self.reader.delivery_profiles.get(request['profile'],{})
            vocals=condition_shared(vocals,delivery.get('gain',1.),delivery.get('quiet',0.))
        for block in apply_stream_controls(stream_tempo(vocals,RATE,speed/conversion_tempo),RATE,
                        pitch_scale=2**(pitch/12),**request.get('controls',{})):
            if block.size:yield np.clip(block*gain,-1.,1.)
        pause=punctuation_pause(text,style,RATE)
        if pause:yield np.zeros(round(pause/speed),dtype=np.float32)

    def batch_blocks(self,items,cancel):
        """Pipeline source generation against conversion, with bounded lookahead."""
        queue=Queue(maxsize=2)
        stopped=Event()
        ahead_ready=self._ahead_ready
        def put(value):
            while not stopped.is_set() and not cancel.is_set():
                try:queue.put(value,timeout=.02);return
                except Full:pass
            raise SynthesisCancelled()
        def prepare():
            ahead_lease=False
            try:
                prepared_source=0
                for number,item in enumerate(items):
                    if stopped.is_set() or cancel.is_set():break
                    if item['kind']=='source':
                        # Keep enough actual audio ahead of playback before
                        # the next acoustic job competes with the vocoder.
                        # The source and converter can overlap their first
                        # jobs. Waiting for first PCM here
                        # left a long second packet completely unprepared.
                        while prepared_source>=2 and not ahead_ready.wait(.01):
                            if stopped.is_set() or cancel.is_set():raise SynthesisCancelled()
                        started=perf_counter()
                        prepared=self.prepare_source(item['request'],cancel)
                        put(('source',number,dict(item,source_ms=round((perf_counter()-started)*1000)),prepared))
                        prepared_source+=1
                    else:put((item['kind'],number,item,None))
                put(None)
                # Only one retained speculative producer may wait for model
                # work. Old batches must not accumulate a backlog of threads.
                ahead_lease=self._ahead_source_slot.acquire(blocking=False)
                if not ahead_lease:return
                # The converter can still be decoding the current final
                # block. Spend this otherwise idle acoustic time on the next
                # announced line's first packet, without emitting any audio.
                # The audio batch may end while its speculative source is
                # running. Continue the same bounded source owner across
                # batches; later audio replenishes the shared ready budget.
                started_ahead=False
                while not cancel.is_set():
                    if self._anticipated.empty():break
                    if started_ahead and not ahead_ready.wait(.01):continue
                    try:request=self._anticipated.get_nowait()
                    except Empty:break
                    key=self._acoustic_key(request)
                    try:
                        with self._acoustic_lock:cached=key in self._acoustic_cache
                        if cached:continue
                        ahead_ready.clear()
                        self.prepare_source(request,cancel,anticipation=True)
                        started_ahead=True
                    finally:
                        with self._acoustic_lock:self._anticipated_keys.discard(key)
            except BaseException as error:
                if not stopped.is_set() and not cancel.is_set():
                    try:put(('error',error))
                    except SynthesisCancelled:pass
            finally:
                if ahead_lease:self._ahead_source_slot.release()
        worker=Thread(target=prepare,name='dordiai acoustic lookahead',daemon=True)
        worker.start()
        complete=False
        try:
            while True:
                if cancel.is_set():raise SynthesisCancelled()
                try:entry=queue.get(timeout=.02)
                except Empty:continue
                if entry is None:
                    complete=True
                    return
                if entry[0]=='error':raise entry[1]
                kind,number,item,prepared=entry
                if kind=='index':yield {'index':item['value']};continue
                if kind=='break':
                    yield {'silence':min(item['value'],10000)}
                    continue
                request=item['request']
                if kind=='cached':
                    import base64
                    audio=np.frombuffer(base64.b64decode(item['pcm']),'<i2').astype('float32')/32767
                    blocks=(audio,)
                    metadata={'profile':request['profile'],'language':self.registry.locale(request.get('language')),'engine':'Shared speaker: '+self.registry.locale(request.get('language'))}
                else:
                    metadata=self.metadata(request,prepared[0])
                    metadata['source_ms']=item.get('source_ms')
                    self._conversion_owner.context.event=cancel
                    blocks=self.prepared_blocks(request,prepared)
                    if not request.get('character'):
                        from phrase_pauses import phrase_audio
                        blocks=initial_buffer(phrase_audio(blocks,request['text'],request['speed'],request.get('controls')))
                started=perf_counter()
                first=True
                generated=0.
                first_output=None
                for block in blocks:
                    if cancel.is_set():raise SynthesisCancelled()
                    if first:
                        metadata['first_convert_ms']=round((perf_counter()-started)*1000)
                        first=False
                    now=perf_counter()
                    if first_output is None:first_output=now
                    generated+=len(block)/RATE
                    # Full phonetic durations need longer source inference;
                    # announce it while the first half-second is ready.
                    if generated-(now-first_output)>=.5:ahead_ready.set()
                    yield block,dict(metadata,part=number)
                # Make a completed packet reusable immediately. Waiting for
                # the whole speculative utterance held its ready prefix
                # behind the final packet's neural conversion.
                ahead_ready.set()
                yield {'part_finished':number}
        finally:
            stopped.set()
            # Completed audio must not hold the response pipe until a later
            # speculative source finishes. Its source lock protects the model.
            retain=complete and not cancel.is_set() and self.common_enabled
            if not retain:
                if worker.is_alive():
                    cancel.set();cancel_running(self.reader,cancel)
                    source_event=getattr(self.reader,'cancel_event',None)
                    if source_event is not None:source_event.set()
                    active=getattr(self.reader,'active_run',None)
                    if active is not None:active[0].terminate=True
                worker.join(3)
                if worker.is_alive():raise RuntimeError('Acoustic producer did not stop')
