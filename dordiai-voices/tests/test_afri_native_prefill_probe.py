import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec=importlib.util.spec_from_file_location("prefill_tested",Path(__file__).resolve().parents[1]/"tools/research/afri_native_prefill_probe.py")
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Array:
    def __init__(self,values):self.values=list(values);self.nbytes=len(values)*4;self.flags=SimpleNamespace(writeable=True)
    def copy(self,order="C"):return Array(self.values)

def trace():return {"seconds":{},"lm_calls":0,"voice_prefill_skipped":False,"latent_sha256":[]}

class PrefillTests(unittest.TestCase):
    def test_snapshot_and_per_request_clone_never_share_state(self):
        cache=m.VoicePrefills(32)
        state={"past":Array([1,2])};t=trace()
        cache.put(("zul","ref"),state,t);state["past"].values[0]=99
        first=cache.take(("zul","ref"),trace())
        self.assertEqual(first["past"].values,[1,2])
        self.assertTrue(first["past"].flags.writeable)
        first["past"].values[1]=88
        second=cache.take(("zul","ref"),trace())
        self.assertEqual(second["past"].values,[1,2])
        self.assertFalse(cache.states[("zul","ref")][0]["past"].flags.writeable)

    def test_real_bytes_lru_not_model_count_guess_and_oversized_skip(self):
        cache=m.VoicePrefills(16)
        for code in ("ssw","ven"):cache.put((code,"r"),{"p":Array([1,2])},trace())
        cache.take(("ssw","r"),trace())
        cache.put(("zul","r"),{"p":Array([3,4])},trace())
        self.assertNotIn(("ven","r"),cache.states)
        self.assertIn(("ssw","r"),cache.states)
        self.assertEqual(cache.bytes,16)
        self.assertFalse(cache.put(("wol","r"),{"p":Array([0]*5)},trace()))
        self.assertLessEqual(cache.peak_bytes,16)

    def test_entry_cap_independent_of_remaining_byte_budget(self):
        cache=m.VoicePrefills(128,max_entries=3)
        for code in ("ssw","ven","zul","nso","wol"):cache.put((code,"r"),{"p":Array([1])},trace())
        self.assertEqual([key[0] for key in cache.states],["zul","nso","wol"])
        self.assertEqual(cache.evictions,["ssw","ven"])
        self.assertEqual(cache.bytes,12)

    def test_illegal_cache_budget_rejected(self):
        for amount in (0,m.MAX_BUDGET+1):
            with self.assertRaises(ValueError):m.VoicePrefills(amount)
        with self.assertRaises(ValueError):m.VoicePrefills(16,max_entries=45)

    def test_readonly_snapshot_tampering_detected(self):
        cache=m.VoicePrefills(16);cache.put(("zul","r"),{"p":Array([1])},trace())
        cache.states[("zul","r")][0]["p"].flags.writeable=True
        with self.assertRaises(RuntimeError):cache.take(("zul","r"),trace())

    def test_passive_main_stage_timing_respects_skipped_voice_call(self):
        class Session:
            def run(self,*args,**kwargs):return ["same"]
        owner=SimpleNamespace(trace=trace());wrapped=m.TimedSession("lm_main",Session(),owner)
        for unused in range(3):self.assertEqual(wrapped.run(None,{}),["same"])
        self.assertEqual(set(owner.trace["seconds"]),{"voice_prefill","text_prefill","ar_lm"})
        owner.trace=trace();owner.trace["voice_prefill_skipped"]=True
        wrapped.run(None,{});wrapped.run(None,{})
        self.assertEqual(set(owner.trace["seconds"]),{"text_prefill","ar_lm"})

    def test_fifteen_golden_cases_exact_five_native_codes(self):
        data="\n".join(code+"\ttext"+str(i)+"\tipa"+str(i) for code in m.LANGUAGES for i in range(3))
        cases=m.fixtures(data)
        self.assertEqual(len(cases),15)
        self.assertEqual({row["language"] for row in cases},set(m.LANGUAGES))
        with self.assertRaises(ValueError):m.fixtures(data.replace("wol\t","other\t"))

if __name__=="__main__":unittest.main()
