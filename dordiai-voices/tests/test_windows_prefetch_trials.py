"""Research runner contracts without audio devices or a running NVDA."""
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"tools"))
import windows_prefetch_trials as trial
import prefetch_research

class PrefetchTrialTests(unittest.TestCase):
    def test_frozen_order(self):
        self.assertEqual(trial.ORDER,(12,24,32,32,24,12))

    def test_source13_pin_matches_durable_receipt(self):
        pin=json.loads((ROOT/"tools/data/source13_build_pin.json").read_bytes())
        self.assertEqual(pin["archive_sha256"],trial.ARCHIVE_SHA)
        self.assertEqual(pin["archive_bytes"],trial.ARCHIVE_BYTES)
        self.assertEqual(pin["source_commit"],trial.SOURCE_COMMIT)

    def test_original_complete_workload(self):
        case=trial.original_source100()
        self.assertEqual(len(case["words"]),100)
        self.assertEqual(hashlib.sha256(case["text"].encode()).hexdigest(),trial.ORIGINAL_INPUT_UTF8_SHA256)
        routes=[dict(text=w["word"],language=w["expected_language"]) for w in case["words"]]
        audit=trial.audit_original100(routes)
        self.assertEqual(audit["input_lexical_piece_count"],102)
        self.assertTrue(audit["routing_passed"])

    def generated(self):
        return trial.plugin_source({})

    def function(self,name,namespace):
        source=self.generated()
        node=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name==name)
        exec(compile(ast.Module(body=[node],type_ignores=[]),"<owned-trial-fixture>","exec"),namespace)
        return namespace[name]

    def test_generated_plugin_compiles_and_never_warms_words(self):
        source=self.generated()
        compile(source,"<compiled-generated-diagnostic>","exec")
        for forbidden in ("__SETTINGS__","__SOURCE_HELPERS__","DRIVER.speak(","RecordingSink(","pauseSpeech(",".preload("):
            self.assertNotIn(forbidden,source)
        self.assertIn("speech.speakTextInfo(info",source)
        self.assertIn("DRIVER.rate=80;DRIVER.rateMultiplier=1",source)
        self.assertIn("CASE['enabled'],'uk','adam',{}",source)
        self.assertIn("time.monotonic()+80",source)

    def test_quiet_boundary_precedes_ready_publication(self):
        source=self.generated()
        tree=ast.parse(source)
        poll=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=="poll_ready")
        self.assertIn("begin_quiet_boundary()",ast.get_source_segment(source,poll))
        self.assertNotIn("plugin-ready.json",ast.get_source_segment(source,poll))
        ready=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=="publish_capture_ready")
        self.assertIn("plugin-ready.json",ast.get_source_segment(source,ready))

    def test_boundary_needs_two_spaced_samples(self):
        import threading
        state=dict(serial=1,planners=0,last_ns=0,stable=0,last_cancel=-1,
                   samples=[],cancel_calls=0,published_serial=None,deadline=30.)
        trace=[];scheduled=[]
        ns=dict(BOUNDARY=state,BOUNDARY_LOCK=threading.Lock(),DRIVER=types.SimpleNamespace(_jobs=types.SimpleNamespace(qsize=lambda:0),_generation=1),
            focus_owned=lambda:True,synthDriverHandler=types.SimpleNamespace(getSynth=lambda:ns["DRIVER"]),
            speech=types.SimpleNamespace(setSpeechMode=lambda value:trace.append(value),SpeechMode=types.SimpleNamespace(talk="talk",off="off"),
                                         cancelSpeech=lambda:trace.append("cancel"),isSpeaking=lambda:False),
            time=types.SimpleNamespace(perf_counter_ns=lambda:300_000_000,monotonic=lambda:1),
            REPORT={},publish_capture_ready=lambda:trace.append("ready"),
            core=types.SimpleNamespace(callLater=lambda ms,f:scheduled.append((ms,f))),guarded=lambda f:f)
        fn=self.function("wait_quiet_boundary",ns)
        fn()
        self.assertEqual(trace,["talk","cancel","off"])
        self.assertEqual(scheduled[0][0],100)
        fn()
        self.assertEqual(trace[-1],"ready")
        self.assertTrue(ns["REPORT"]["pre_read_quiescence"]["passed"])
        self.assertEqual(state["published_serial"],1)

    def test_busy_or_new_planner_cannot_publish_ready(self):
        import threading
        for planners,jobs,speaking,quiet_ns in ((1,0,False,300000000),(0,1,False,300000000),(0,0,True,300000000),(0,0,False,200000000)):
            state=dict(serial=1,planners=planners,last_ns=0,stable=1,last_cancel=1,samples=[],cancel_calls=0,published_serial=None,deadline=30.)
            published=[]
            ns=dict(BOUNDARY=state,BOUNDARY_LOCK=threading.Lock(),DRIVER=types.SimpleNamespace(_jobs=types.SimpleNamespace(qsize=lambda:jobs),_generation=1),
                focus_owned=lambda:True,synthDriverHandler=types.SimpleNamespace(getSynth=lambda:ns["DRIVER"]),
                speech=types.SimpleNamespace(isSpeaking=lambda:speaking),
                time=types.SimpleNamespace(perf_counter_ns=lambda:quiet_ns,monotonic=lambda:1),
                REPORT={},publish_capture_ready=lambda:published.append(True),
                core=types.SimpleNamespace(callLater=lambda *a:None),guarded=lambda f:f)
            self.function("wait_quiet_boundary",ns)()
            self.assertFalse(published)
            self.assertEqual(state["stable"],0)

    def test_cancelled_planner_closes_and_decrements(self):
        import threading
        closed=[];part=("text",dict(text="test",language="en"))
        def original():
            try:yield part
            finally:closed.append(True)
        ns=dict(BOUNDARY_LOCK=threading.Lock(),BOUNDARY=dict(planners=0),boundary_activity=lambda:None,
            ORIGINAL_PARTS=original,PHASE="pre-read-quiescence",ROUTES=[],COUNTERS={})
        stream=self.function("observe_parts",ns)()
        self.assertIs(next(stream),part)
        self.assertEqual(ns["BOUNDARY"]["planners"],1)
        stream.close()
        self.assertEqual(ns["BOUNDARY"]["planners"],0)
        self.assertEqual(closed,[True])
        self.assertEqual(ns["ROUTES"],[])

    def passing(self):
        overlay=dict(candidate_source_sha256="a"*64,pending_count=12)
        result=dict(status="completed-real-waveplayer-longread",input_utf8_sha256=trial.ORIGINAL_INPUT_UTF8_SHA256,
            actual_rate=80,actual_rate_multiplier=1,driver_error=None,recording_pcm_sink_test_double=False,
            research_identity=dict(loaded_driver_sha256="a"*64,profile="adam",pending_count=12),
            pre_read_quiescence=dict(passed=True),
            route_audit=dict(input_word_count=100,input_lexical_piece_count=102,lexical_content_preserved_in_order=True,
                             raw_nonwhitespace_text_preserved=True,routing_passed=True))
        corr=dict(complete_reference_window_used=True,dynamic_warp_or_resampling_used=False,ncc_threshold=.98,
                  full_reference_transport_verified=True,no_new_transport_gap_verified=True)
        return result,corr,dict(gate_status="measured-software-only"),overlay

    def test_unchanged_full_gate(self):
        r,c,t,o=self.passing()
        self.assertTrue(trial.judge_trial(r,c,t,o)["all_independent_gates_passed"])
        for key in ("full_reference_transport_verified","no_new_transport_gap_verified"):
            bad=dict(c);bad[key]=False
            self.assertFalse(trial.judge_trial(r,bad,t,o)["strict_full_transport_verified"])
        for key,value in (("ncc_threshold",.9),("complete_reference_window_used",False),("dynamic_warp_or_resampling_used",True)):
            bad=dict(c);bad[key]=value
            self.assertFalse(trial.judge_trial(r,bad,t,o)["strict_full_transport_verified"])

    def test_open_clock_does_not_turn_into_pass(self):
        r,c,t,o=self.passing();t["gate_status"]="open"
        decision=trial.judge_trial(r,c,t,o)
        self.assertTrue(decision["strict_full_transport_verified"])
        self.assertFalse(decision["all_independent_gates_passed"])
        self.assertFalse(decision["acoustic_latency_verified"])
        self.assertFalse(decision["product_ready"])

    def test_wrong_profile_source_or_partial_workload_rejected(self):
        for field,value in (("profile","viktoriia"),("loaded_driver_sha256","b"*64),("pending_count",24)):
            r,c,t,o=self.passing();r["research_identity"][field]=value
            self.assertFalse(trial.judge_trial(r,c,t,o)["structural_workload_and_identity_verified"])
        for field,value in (("input_word_count",99),("input_lexical_piece_count",101),("raw_nonwhitespace_text_preserved",False),("routing_passed",False)):
            r,c,t,o=self.passing();r["route_audit"][field]=value
            self.assertFalse(trial.judge_trial(r,c,t,o)["structural_workload_and_identity_verified"])

    def test_six_trials_do_not_imply_production_fix(self):
        rows=[dict(pending_count=n,status="completed-research-trial",judgment=dict(strict_full_transport_verified=True,all_independent_gates_passed=False))
              for n in trial.ORDER]
        out=trial.summarize(rows)
        self.assertTrue(out["six_trials_completed"])
        self.assertFalse(out["production_fix_accepted"])
        self.assertEqual(out["counts"]["24"]["strict_transport_passes"],2)
        self.assertEqual(out["counts"]["24"]["independent_all_gate_passes"],0)

    def test_reordered_or_failed_trial_cannot_be_complete(self):
        rows=[dict(pending_count=n,status="completed-research-trial") for n in trial.ORDER]
        rows[0]["pending_count"]=32
        self.assertFalse(trial.summarize(rows)["six_trials_completed"])
        rows=[dict(pending_count=n,status="completed-research-trial") for n in trial.ORDER]
        rows[1]["status"]="failed"
        self.assertFalse(trial.summarize(rows)["six_trials_completed"])

    def test_owned_cleanup_keeps_reference_and_refuses_unreaped(self):
        with tempfile.TemporaryDirectory() as d:
            run=Path(d)/("nvda-"+"a"*32);run.mkdir()
            (run/"config").mkdir();(run/"portable").mkdir()
            (run/"longread-reference.pcm").write_bytes(b"\1\0")
            with self.assertRaisesRegex(RuntimeError,"reaping"):
                trial.remove_owned_payload(run,{})
            report=dict(owned_nvda_reaped=True,owned_helper_reaped=True,owned_worker_tree_reaped=True)
            trial.remove_owned_payload(run,report)
            self.assertFalse((run/"config").exists())
            self.assertFalse((run/"portable").exists())
            self.assertEqual((run/"longread-reference.pcm").read_bytes(),b"\1\0")

    def test_unsafe_cleanup_root_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError,"Nonce"):
                trial.remove_owned_payload(Path(d),dict(owned_nvda_reaped=True,owned_helper_reaped=True,owned_worker_tree_reaped=True))

    def test_evidence_hashes_complete_pcm(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"longread-reference.pcm";p.write_bytes(b"\1\0"*100)
            report=trial.evidence_index(Path(d))
            self.assertFalse(report["truncated"])
            self.assertEqual(report["files"][0]["bytes"],200)
            self.assertEqual(report["files"][0]["sha256"],hashlib.sha256(p.read_bytes()).hexdigest())

    def test_no_direct_device_action_outside_explicit_hosted_scope(self):
        args=types.SimpleNamespace(ephemeral_ci=False,output=Path("uncreated"))
        with patch("windows_virtual_audio_trial.WindowsPnP") as pnp:
            self.assertEqual(trial.run(args),1)
        pnp.assert_not_called()

    def test_workflow_manual_and_marker_trigger(self):
        path=ROOT.parent/".github/workflows/dordiai-source13-prefetch.yml"
        source=path.read_text("utf8")
        self.assertIn("[source13-prefetch]",source)
        self.assertIn("workflow_dispatch:",source)
        self.assertIn("run-id: 45049806570",source)
        self.assertIn("windows_prefetch_trials.py",source)
        self.assertNotIn("--addon-sha256 908a9825",source)
        self.assertNotIn("pull_request_target:",source)
        self.assertIn("PYTHONUTF8: '1'",source)

    def test_workflow_stages_early_failure_without_helper_or_trial(self):
        source=(ROOT.parent/".github/workflows/dordiai-source13-prefetch.yml").read_text("utf8")
        lines=source.splitlines()
        start=next(i for i,line in enumerate(lines) if "name: Stage only bounded exact owned longread evidence" in line)
        run=next(i for i in range(start,len(lines)) if lines[i].strip()=="run: |")
        block=[]
        for line in lines[run+1:]:
            if line and not line.startswith("          "):
                break
            block.append(line[10:] if line else "")
        with tempfile.TemporaryDirectory() as d:
            environment={"RUNNER_TEMP":d,"GITHUB_RUN_ID":"1234","GITHUB_SHA":"a"*40}
            with patch.dict(os.environ,environment,clear=True):
                exec(compile("\n".join(block),"<failed-prebuild-stage>","exec"),{})
            path=Path(d)/"dordiai-source13-prefetch-evidence-1234/evidence-index.json"
            receipt=json.loads(path.read_text("utf8"))
            self.assertTrue(receipt["early_failure_without_trials"])
            self.assertFalse(receipt["helper_root_created"])
            self.assertFalse(receipt["controller_report_present"])
            self.assertFalse(receipt["product_ready"])
            self.assertEqual(receipt["owned_trial_directories"],0)

    def test_workflow_python_blocks_compile(self):
        source=(ROOT.parent/".github/workflows/dordiai-source13-prefetch.yml").read_text("utf8")
        lines=source.splitlines()
        count=0
        for i,line in enumerate(lines):
            if line.strip()!="shell: python":
                continue
            run=next(j for j in range(i+1,len(lines)) if lines[j].strip()=="run: |")
            block=[]
            for entry in lines[run+1:]:
                if entry and not entry.startswith("          "):
                    break
                block.append(entry[10:] if entry else "")
            compile("\n".join(block),"<workflow-python-block>","exec")
            count+=1
        self.assertGreaterEqual(count,3)

    @unittest.skipUnless(os.name=="nt","Windows own-job API")
    def test_actual_owned_job_normal_exit_reaped(self):
        job=trial.OwnedProcessJob()
        process=subprocess.Popen([sys.executable,"-I","-B","-c","import time;time.sleep(.2)"])
        try:
            job.assign(process)
            process.wait(timeout=5)
            record=job.finish()
            self.assertFalse(record["forced_tree_termination"])
            self.assertEqual(record["active_after_cleanup"],0)
        finally:
            if process.poll() is None:process.kill();process.wait()
            if job.handle is not None:job.finish()

    @unittest.skipUnless(os.name=="nt","Windows own-job API")
    def test_actual_owned_job_forced_exit_is_reported(self):
        job=trial.OwnedProcessJob()
        process=subprocess.Popen([sys.executable,"-I","-B","-c","import time;time.sleep(5)"])
        try:
            job.assign(process)
            record=job.finish()
            process.wait(timeout=5)
            self.assertTrue(record["forced_tree_termination"])
            self.assertEqual(record["active_before_cleanup"],1)
            self.assertEqual(record["active_after_cleanup"],0)
        finally:
            if process.poll() is None:process.kill();process.wait()
            if job.handle is not None:job.finish()

if __name__=="__main__":unittest.main()

