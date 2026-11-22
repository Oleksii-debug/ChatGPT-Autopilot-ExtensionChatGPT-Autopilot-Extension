import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest

HERE=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("stream_tested",HERE/"tools/research/afri_native_stream_probe.py")
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class CancelTests(unittest.TestCase):
    def test_pre_cancel_never_invokes_graph(self):
        class Session:
            def run(self,*args,**kwargs):raise AssertionError("Graph must not run")
        owner=SimpleNamespace(cancelled=lambda:True,actual_graph_calls=0)
        with self.assertRaises(m.NativeStreamCancelled):m.CancelSession(Session(),owner).run(None,{})
        self.assertEqual(owner.actual_graph_calls,0)

    def test_cancel_raised_during_graph_discards_actual_result(self):
        owner=SimpleNamespace(cancelled=lambda:False,actual_graph_calls=0)
        class Session:
            def run(self,*args,**kwargs):
                owner.cancelled=lambda:True
                return ["actual result"]
        with self.assertRaises(m.NativeStreamCancelled):m.CancelSession(Session(),owner).run(None,{})
        self.assertEqual(owner.actual_graph_calls,1)

    def test_passthrough_does_not_change_state_options_or_outputs(self):
        result=object();values={"state":object()};option=object()
        class Session:
            def run(self,outputs,inputs,run_options):
                self.call=(outputs,inputs,run_options)
                return result
        session=Session();owner=SimpleNamespace(cancelled=lambda:False,actual_graph_calls=0)
        self.assertIs(m.CancelSession(session,owner).run(None,values,option),result)
        self.assertIs(session.call[1],values)
        self.assertIs(session.call[2],option)
        self.assertEqual(owner.actual_graph_calls,1)

    def test_stream_chunk_policies_reject_without_claiming_active_request(self):
        engine=object.__new__(m.StreamingCarrier)
        generator=engine.stream("",None,24000,chunk_frames=2)
        with self.assertRaises(ValueError):next(generator)
        self.assertFalse(getattr(engine,"active_stream",False))

try:
    # Optional actual core runtime tests use its own existing NumPy only.
    if os.environ.get("STREAM_PRIVATE_RUNTIME"):
        boot=Path(os.environ["STREAM_PRIVATE_RUNTIME"])/"windows_runtime.py"
        bs=importlib.util.spec_from_file_location("stream_test_private_bootstrap",boot)
        bootstrap=importlib.util.module_from_spec(bs);bs.loader.exec_module(bootstrap)
        bootstrap.reset_inherited_dll_directory()
    import numpy as np
except ImportError:
    np=None

@unittest.skipIf(np is None,"NumPy fake-graph tests run again inside unchanged private runtime")
class StreamingStateTests(unittest.TestCase):
    def engine(self):
        engine=object.__new__(m.StreamingCarrier)
        engine.np=np;engine.native_code="ssw";engine.cancelled=lambda:False
        engine.actual_graph_calls=0;engine.active_stream=False;engine.unknown_id=None
        engine.prefills=m.prefill.VoicePrefills();engine.voice_cache={};engine.trace=m.fresh_trace()
        engine.tokenizer=SimpleNamespace(encode=lambda text:SimpleNamespace(ids=[4,5]))
        engine.zero_state=lambda role,first:{"past":np.zeros((1,),np.float32)}
        engine.decoder_observations=[]
        class Session:
            def __init__(self,role):self.role=role
            def run(self,unused,values):
                if self.role=="encoder":return [np.ones((1,1,1024),np.float32)]
                if self.role=="text_conditioner":return [np.ones((1,2,1024),np.float32)]
                if self.role=="lm_main":
                    before=float(values["past"][0]);new=values["past"]+1
                    eos=np.asarray([0. if before>=4 else -10.],np.float32)
                    return [np.ones((1,32),np.float32),eos,new]
                if self.role=="lm_flow":return [np.zeros((1,32),np.float32)]
                frames=values["latent"];n=frames.shape[1];before=int(values["past"][0])
                engine.decoder_observations.append((before,n))
                audio=np.repeat(frames[0,:,0],1920).reshape(1,1,-1)
                return [audio,values["past"]+n]
        engine.sessions={role:m.CancelSession(Session(role),engine) for role in
                         ("encoder","text_conditioner","lm_main","lm_flow","decoder")}
        return engine

    def stream(self,engine,chunk=1,**kwargs):
        return engine.stream("native IPA",np.ones(512,np.float32),24000,chunk_frames=chunk,**kwargs)

    def test_first_chunk_precedes_generation_completion_and_keeps_decoder_state(self):
        engine=self.engine();generator=self.stream(engine)
        first=next(generator)
        self.assertEqual(len(first),1920)
        self.assertEqual(engine.stream_facts["frames_at_yield"],1)
        self.assertFalse(engine.stream_facts["generation_complete"])
        remaining=list(generator)
        self.assertTrue(remaining)
        self.assertEqual(engine.decoder_observations,[(i,1) for i in range(len(remaining)+1)])
        self.assertTrue(engine.stream_facts["closed"])
        self.assertFalse(engine.active_stream)
        self.assertEqual(engine.last_facts["latent_frames"],len(remaining)+1)

    def test_all_chunk_boundaries_reassemble_identical_fake_causal_output(self):
        baseline=None
        for chunk in m.CHUNKS:
            engine=self.engine();audio=np.concatenate(list(self.stream(engine,chunk)))
            if baseline is None:baseline=audio
            else:self.assertEqual(audio.tobytes(),baseline.tobytes())
            self.assertTrue(engine.stream_facts["closed"])
            self.assertEqual(sum(n for unused,n in engine.decoder_observations),engine.last_facts["latent_frames"])

    def test_cancel_and_generator_close_do_not_contaminate_fresh_request(self):
        engine=self.engine();flag=[False];generator=self.stream(engine,cancelled=lambda:flag[0])
        next(generator);before=engine.actual_graph_calls;flag[0]=True
        with self.assertRaises(m.NativeStreamCancelled):next(generator)
        self.assertEqual(engine.actual_graph_calls,before)
        self.assertFalse(engine.active_stream);self.assertTrue(engine.stream_facts["closed"])
        replay=np.concatenate(list(self.stream(engine)))
        fresh=np.concatenate(list(self.stream(self.engine())))
        self.assertEqual(replay.tobytes(),fresh.tobytes())
        abandoned=self.stream(engine);next(abandoned);abandoned.close()
        self.assertFalse(engine.active_stream)
        self.assertEqual(engine.stream_facts["lm_arrays_remaining"],0)
        self.assertEqual(engine.stream_facts["decoder_arrays_remaining"],0)

    def test_active_stream_cannot_be_replaced_by_second_generator(self):
        engine=self.engine();first=self.stream(engine);next(first)
        second=self.stream(engine)
        with self.assertRaises(RuntimeError):next(second)
        self.assertTrue(engine.active_stream)
        first.close()
        self.assertFalse(engine.active_stream)

    def test_graph_failure_drops_state_and_next_request_restarts_clean(self):
        engine=self.engine();original=engine.sessions["decoder"]
        class Failing:
            def run(self,*args,**kwargs):raise RuntimeError("real decoder failure")
        engine.sessions["decoder"]=Failing();generator=self.stream(engine)
        with self.assertRaisesRegex(RuntimeError,"real decoder failure"):next(generator)
        self.assertTrue(engine.stream_facts["closed"]);self.assertFalse(engine.active_stream)
        engine.sessions["decoder"]=original
        replay=np.concatenate(list(self.stream(engine)))
        fresh=np.concatenate(list(self.stream(self.engine())))
        self.assertEqual(replay.tobytes(),fresh.tobytes())

    def test_comparison_reports_numeric_partition_error_without_bit_identity(self):
        baseline=np.asarray([.1,.2,.3],np.float32);changed=baseline.copy()
        changed[1]=np.nextafter(changed[1],np.float32(1.))
        facts={"latent_sha256":["same"],"samples":3,"last_facts":{"eos":3},
               "float32_sha256":m.sha256(baseline.tobytes()).hexdigest(),
               "pcm16_sha256":m.sha256(m.pcm16(np,baseline).tobytes()).hexdigest()}
        actual=dict(facts,float32_sha256=m.sha256(changed.tobytes()).hexdigest(),decoder_boundaries=[1])
        actual["pcm16_sha256"]=m.sha256(m.pcm16(np,changed).tobytes()).hexdigest()
        result=m.compare(np,baseline,changed,facts,actual)
        self.assertFalse(result["float32_bit_identical"])
        self.assertTrue(result["within_preregistered_numerical_gate"])
        self.assertFalse(result["human_quality_verified"])
        self.assertGreater(result["boundary_max_absolute_float_error"],0.)
        actual["latent_sha256"]=["changed"]
        with self.assertRaises(ValueError):m.compare(np,baseline,changed,facts,actual)

if __name__=="__main__":unittest.main()
