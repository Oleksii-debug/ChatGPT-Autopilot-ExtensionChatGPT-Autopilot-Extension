"""Independent90second real original100 read plus8second software-cancel capture.

Never modifies the frozen short-capture tools or the caller-pinned core12.
Only the controller's own fresh official NVDA sibling tree may be captured.
"""
from __future__ import annotations
import argparse,ast,hashlib,json,os,stat,subprocess,time,uuid
from pathlib import Path
import windows_nvda_process_capture_probe as short
from nvda_process_capture_support import read_json,validate_ready,validate_capture
from nvda_longread_analysis import analyze_longread,cancellation_tail,MAX_PCM_BYTES

INPUT_SHA='c7cfa1ba024ee6f59bfa0152a4016318c9f8542fbec79f6b7accb07645acbe16'
PLAIN_PROBE_SHA='7364484b5083d5abb66e3ee86d9a272de593d87357768378d3055457d618334f'
CORE12_SHA='908a9825a8f3e1574d9d0a370ac0e35e1e1683eb04b998a937c312f0ce3ec573'
CORE12_BYTES=1992944744
CANCEL_TEXT=('Перевірка негайної зупинки українського мовлення. '*12).strip()


def source_helpers(path):
    raw=Path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest()!=PLAIN_PROBE_SHA:raise ValueError('Exact reviewed plain probe source differs')
    tree=ast.parse(raw.decode('utf-8'));plugin=None
    for node in tree.body:
        if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='PLUGIN_CODE' for t in node.targets):plugin=ast.literal_eval(node.value)
    if not isinstance(plugin,str):raise ValueError('Reviewed plain plugin not found')
    wanted={'_plain_normalize','_plain_tokens','_plain_source_groups','_plain_cases','_plain_route_audit','_plain_sequence'}
    pieces=['import unicodedata as _plain_unicode','import re as _plain_re'];found=set()
    for node in ast.parse(plugin).body:
        if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='PLAIN_SOURCE_CASES' for t in node.targets):
            ast.literal_eval(node.value);pieces.append(ast.get_source_segment(plugin,node));found.add('PLAIN_SOURCE_CASES')
        elif isinstance(node,ast.FunctionDef) and node.name in wanted:
            pieces.append(ast.get_source_segment(plugin,node));found.add(node.name)
    if found!=wanted|{'PLAIN_SOURCE_CASES'}:raise ValueError('Original source fixture/audit helper selection incomplete')
    helpers='\n\n'.join(pieces)
    namespace={};exec(compile(helpers,'<exact-reviewed-pure-workload>','exec'),namespace)
    case=namespace['_plain_cases']()[0]
    if len(case['words'])!=100 or hashlib.sha256(case['text'].encode('utf-8')).hexdigest()!=INPUT_SHA:
        raise ValueError('Original100 case input changed')
    return helpers


def read_pcm(path,receipt,seconds):
    path=Path(path)
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode) or not 0<path.stat().st_size<=min(MAX_PCM_BYTES,48000*2*seconds):
        raise ValueError('Only bounded own regular PCM accepted')
    raw=path.read_bytes()
    if len(raw)%2 or receipt.get('filename')!=path.name or receipt.get('size_bytes')!=len(raw) or receipt.get('sha256')!=hashlib.sha256(raw).hexdigest():
        raise ValueError('Exact own PCM receipt differs')
    return raw


def capture_phase(args,run,nvda,rate,image_sha,ready_sha,owned_instance,name,seconds,trigger,report):
    capture=run/name;helper=None
    try:
        command=[str(args.helper),'--owned-nvda-pid',str(nvda.pid),'--controller-pid',str(os.getpid()),
            '--owned-run-root',str(run),'--probe-id',run.name.removeprefix('nvda-'),'--nvda-image-sha256',image_sha,
            '--plugin-ready-sha256',ready_sha,'--sample-rate',str(rate),'--seconds',str(seconds),
            '--output',str(capture),'--owned-instance-id',owned_instance]
        helper=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        ready=short.wait_file(capture/'ready.json',[nvda,helper],7)
        if ready.get('status')!='capture-started' or ready.get('target_pid')!=nvda.pid or ready.get('helper_pid')!=helper.pid or ready.get('controller_pid')!=os.getpid():
            raise ValueError('Capture start receipt differs from exact owned siblings')
        short.publish(run/trigger,{'probe_id':run.name.removeprefix('nvda-')})
        try:stdout,stderr=helper.communicate(timeout=seconds+3)
        except subprocess.TimeoutExpired:
            helper.kill();helper.communicate();raise RuntimeError('Exact bounded helper killed and reaped after watchdog')
        if max(len(stdout),len(stderr))>65536:raise ValueError('Helper console quota exceeded')
        report.setdefault('capture_helpers',[]).append({'phase':name,'pid':helper.pid,'returncode':helper.returncode,'stdout':stdout,'stderr':stderr})
        native=read_json(capture/'capture.json',limit=8*1024*1024)
        if helper.returncode:raise RuntimeError('Native bounded capture failed: '+str(native.get('reason')))
        validate_capture(native,nvda_pid=nvda.pid,controller_pid=os.getpid(),helper_pid=helper.pid,image_sha=image_sha,ready_sha=ready_sha,sample_rate=rate)
        if native.get('capture_seconds_limit')!=seconds or native.get('packet_quota')!=32768 or native.get('byte_quota')!=rate*seconds*2:
            raise ValueError('Independent native capture quotas differ')
        return native,read_pcm(capture/'captured.pcm',native['captured_pcm'],seconds)
    finally:
        if helper is not None:
            if helper.poll() is None:helper.kill()
            stdout,stderr=helper.communicate()
            if helper.stdout:helper.stdout.close()
            if helper.stderr:helper.stderr.close()
            report.setdefault('owned_capture_helper_cleanup',[]).append({'phase':name,'pid':helper.pid,'reaped':helper.poll() is not None,'final_stdout':stdout[-8192:],'final_stderr':stderr[-8192:]})


def run_nvda(args,output_device,owned_instance,report):
    import process_loopback_guard as guard
    base=short.module('_owned_nvda_longread_base',Path(__file__).with_name('windows_nvda_probe.py'))
    report['helper_build']=guard.verify_build(args.helper,args.helper_build_receipt,Path(__file__).with_name('windows_nvda_longread_capture.cpp'))
    build=read_json(args.helper_build_receipt)
    if build.get('purpose')!='owned-nvda-longread-capture' or build.get('included_marker_source_sha256')!=short.FROZEN_MARKER_CPP_SHA or short.digest(Path(__file__).with_name('windows_process_loopback.cpp'))!=short.FROZEN_MARKER_CPP_SHA:
        raise ValueError('Longread capture does not bind reviewed frozen marker primitives')
    helpers=source_helpers(Path(__file__).with_name('windows_nvda_plain_text_probe.py'))
    nonce=uuid.uuid4().hex;run=args.output/('nvda-'+nonce);run.mkdir()
    image,config=short.create_portable(base,run,args.addon,output_device);image_sha=short.digest(image)
    probe=config/'addons/dordiaiCaptureProbe';plugins=probe/'globalPlugins';plugins.mkdir(parents=True)
    (probe/'manifest.ini').write_text('name="dordiaiCaptureProbe"\nsummary="Owned bounded longread capture"\nversion="1.0.0"\nauthor="dordiai-voices"\nminimumNVDAVersion="2026.1"\nlastTestedNVDAVersion="2026.3.1"\n',encoding='utf-8')
    settings={'root':str(run),'config':str(config.resolve()),'probe_id':nonce,'controller_pid':os.getpid(),
        'output_device':output_device,'input_sha256':INPUT_SHA,'cancel_text':CANCEL_TEXT,
        'source_probe_sha256':PLAIN_PROBE_SHA,'source_helpers_sha256':hashlib.sha256(helpers.encode('utf-8')).hexdigest()}
    template=Path(__file__).with_name('windows_nvda_longread_plugin.py').read_text(encoding='utf-8')
    code=template.replace('SETTINGS=__SETTINGS__','SETTINGS='+repr(settings)).replace('__SOURCE_HELPERS__',helpers)
    compile(code,'<owned-exact-longread-plugin>','exec')
    (plugins/'dordiaiCaptureProbe.py').write_text(code,encoding='utf-8')
    nvda=None
    try:
        with (run/'nvda-console.log').open('wb') as console:
            nvda=subprocess.Popen([str(image),'--config-path='+str(config),'--log-file='+str(run/'nvda.log'),
                '--debug-logging','--no-sr-flag','--minimal','--lang=en'],cwd=image.parent,stdout=console,stderr=subprocess.STDOUT)
            short.publish(run/'owned-launch.json',{'pid_expected':nvda.pid,'probe_id':nonce})
            ready=short.wait_file(run/'plugin-ready.json',[nvda],180,failed_file=run/'plugin-complete.json')
            rate=validate_ready(ready,nvda_pid=nvda.pid,controller_pid=os.getpid(),nonce=nonce,config=config.resolve(),image_sha=image_sha)
            ready_sha=short.digest(run/'plugin-ready.json')
            native,captured=capture_phase(args,run,nvda,rate,image_sha,ready_sha,owned_instance,'longread-capture',90,'longread-trigger.json',report)
            result=short.wait_file(run/'plugin-longread.json',[nvda],2,failed_file=run/'plugin-complete.json')
            if result.get('status')!='completed-real-waveplayer-longread' or result.get('pid')!=nvda.pid or result.get('probe_id')!=nonce or result.get('input_utf8_sha256')!=INPUT_SHA or result.get('actual_rate')!=80 or result.get('sample_rate')!=rate or result.get('driver_error') is not None or result.get('recording_pcm_sink_test_double') is not False:
                raise ValueError('Genuine exact100 case did not complete with expected immutable input/rate/driver')
            reference=read_pcm(run/'longread-reference.pcm',result['reference_pcm'],80)
            correlation=analyze_longread(reference,captured,rate,native['packets'])
            audit=result.get('route_audit',{})
            structural=audit.get('input_word_count')==100 and audit.get('input_lexical_piece_count')==102 and audit.get('lexical_content_preserved_in_order') is True and audit.get('routing_passed') is True
            correlation['structural_all100_input_words_preserved_and_routed']=structural
            correlation['semantic_pronunciation_not_proven_by_waveform_match']=True
            short.publish(run/'longread-analysis.json',correlation)
            cancel_native,cancel_pcm=capture_phase(args,run,nvda,rate,image_sha,ready_sha,owned_instance,'cancel-capture',8,'cancel-trigger.json',report)
            cancel=short.wait_file(run/'plugin-cancel.json',[nvda],2,failed_file=run/'plugin-complete.json')
            if cancel.get('pid')!=nvda.pid or cancel.get('probe_id')!=nonce or cancel.get('actual_cancel_api')!='speech.cancelSpeech' or cancel.get('cancel_text')!=CANCEL_TEXT:
                raise ValueError('Independent actual public cancellation receipt differs')
            if cancel.get('clock',{}).get('qpc_frequency')!=cancel_native.get('qpc_frequency'):raise ValueError('Cancellation/native QPC frequencies differ')
            tail=cancellation_tail(cancel_pcm,rate,cancel_native['packets'],cancel['clock'])
            short.publish(run/'cancel-analysis.json',tail)
            passed=structural and correlation['full_reference_transport_verified'] and correlation['no_new_transport_gap_verified'] and tail['gate_status']=='measured-software-only'
            report.update(status='longread-and-software-cancel-verified' if passed else 'longread-independent-gates-open',experiment='original100-plus-independent-cancel',
                official_installer_sha256=base.NVDA_SHA256,official_nvda_image_sha256=image_sha,run_directory=str(run),
                actual_nvda_pid=nvda.pid,controller_pid=os.getpid(),input_utf8_sha256=INPUT_SHA,
                actual_rate=result['actual_rate'],actual_rate_multiplier=result['actual_rate_multiplier'],
                effective_default_tempo=result['effective_default_tempo'],wave_player_verified=True,
                full_reference_transport_verified=correlation['full_reference_transport_verified'],no_new_transport_gap_verified=correlation['no_new_transport_gap_verified'],
                virtual_audio_verified=correlation['full_reference_transport_verified'],correlation=correlation,cancellation=tail)
            short.publish(run/'stop.json',{'probe_id':nonce})
            try:nvda.wait(timeout=20)
            except subprocess.TimeoutExpired:base.stop_owned(nvda)
    finally:
        base.stop_owned(nvda);report['owned_nvda_reaped']=nvda is None or nvda.poll() is not None
        report['owned_helper_reaped']=all(r['reaped'] for r in report.get('owned_capture_helper_cleanup',[]))


def run(args):
    import windows_virtual_audio_trial as device
    import process_loopback_guard as guard
    report={"format":"dordiai-owned-real-nvda-longread-capture","format_version":1,"status":"failed",
        "recording_pcm_sink_test_double":False,"physical_audio_verified":False,"acoustic_latency_verified":False,
        "virtual_audio_verified":False,"requested_phrase_waveform_match_verified":False,"wave_player_verified":False,
        "native_pronunciation_verified":False,"product_ready":False,"microphone_capture_used":False,
        "privacy_settings_changed":False,"default_device_changed":False,"security_settings_changed":False,"reboot_performed":False}
    created=False
    try:
        if not args.ephemeral_ci:raise device.TrialBlocked("Explicit owned CI scope required")
        device.guard_environment(os.environ,args.package,args.output)
        if args.output.exists():raise ValueError("Fresh owned evidence output required")
        args.output.mkdir();created=True
        short.verify_addon_input(args.addon,args.addon_bytes,args.addon_sha256,report)
        report["verification"]=device.verify_package(args.package,args.validation)
        report["endpoints_before"]=device.endpoints()
        pnp=device.WindowsPnP()
        with pnp.owned_device(args.package/"vbMmeCable64_win10.inf",report):
            deadline=time.monotonic()+20
            while True:
                during=device.endpoints();render,_=device.select_new_vendor_endpoints(report["endpoints_before"],during)
                if render:break
                if time.monotonic()>deadline:raise RuntimeError("No unique new owned render endpoint")
                time.sleep(.25)
            # Resolve exact CoreAudio endpoint identity using the independently
            # accepted frozen marker helper, without starting any capture.
            guard.verify_build(args.marker_helper,args.marker_build_receipt,Path(__file__).with_name("windows_process_loopback.cpp"))
            described=guard.own_child([str(args.marker_helper),"--describe-native-format","--render-name",render["name"],
                "--owned-instance-id",report["owned_instance_id"]],8)
            if described.returncode:raise RuntimeError("Exact native endpoint identity resolution failed")
            endpoint=json.loads(described.stdout)["selected_endpoint"];report["selected_endpoint"]=endpoint
            run_nvda(args,endpoint["id"],report["owned_instance_id"],report)
    except Exception as error:
        report.update(status="failed",error=type(error).__name__+": "+str(error))
    finally:
        if report.get("cleanup",{}).get("attempted") and report["cleanup"].get("removed") is not True:
            report.update(status="failed",error="Exact owned PnP device absence was not verified")
        if created:short.publish(args.output/"nvda-longread-capture.json",report)
        print("OWNED_NVDA_LONGREAD_CAPTURE "+json.dumps(report),flush=True)
    return 0 if report["status"]=="longread-and-software-cancel-verified" else 1

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('package','validation','output','addon','helper','helper-build-receipt','marker-helper','marker-build-receipt'):
        parser.add_argument('--'+name,required=True,type=Path)
    parser.add_argument('--addon-sha256',default=CORE12_SHA);parser.add_argument('--addon-bytes',type=int,default=CORE12_BYTES)
    parser.add_argument('--ephemeral-ci',action='store_true');args=parser.parse_args()
    if args.addon_sha256!=CORE12_SHA or args.addon_bytes!=CORE12_BYTES:parser.error('Only exact frozen core12 accepted')
    return run(args)


if __name__=='__main__':raise SystemExit(main())
