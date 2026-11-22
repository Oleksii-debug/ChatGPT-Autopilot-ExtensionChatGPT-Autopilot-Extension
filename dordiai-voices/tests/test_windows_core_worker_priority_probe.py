import importlib.util
from pathlib import Path
import sys
import unittest

TOOLS=Path(__file__).resolve().parents[1]/'tools'
sys.path.insert(0,str(TOOLS))
SPEC=importlib.util.spec_from_file_location('worker_priority_probe',TOOLS/'windows_core_worker_priority_probe.py')
probe=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(probe)


class WorkerPriorityTraceTests(unittest.TestCase):
    def test_balanced_scope_and_phase_are_observed(self):
        text='''DORDIAI_PHASE {"phase":"error","mode":"reference"}
DORDIAI_PRIORITY {"handle":1,"before":16384,"target":32,"after":32,"ok":true}
DORDIAI_PRIORITY {"handle":1,"before":32,"target":16384,"after":16384,"ok":true}'''
        result=probe.trace_summary(text)
        self.assertTrue(result['all_observed_restored_below_normal'])
        self.assertEqual(result['phases'][0]['phase'],'error')

    def test_unrestored_or_failed_priority_is_not_accepted(self):
        text='DORDIAI_PRIORITY {"handle":1,"before":16384,"target":32,"after":32,"ok":true}'
        self.assertFalse(probe.trace_summary(text)['all_observed_restored_below_normal'])
        self.assertFalse(probe.trace_summary('')['all_observed_restored_below_normal'])

    def test_actual_worker_wrapper_compiles(self):
        compile(probe.WRAPPER,'owned worker observer','exec')

    def test_known_child_exit_and_pipe_closure_are_required(self):
        closed='DORDIAI_RU_CLOSE {"pid":12,"held_handle":99,"exit_code":1,"process_cleared":true,"stdin_closed":true,"stdout_closed":true}'
        self.assertTrue(probe.trace_summary(closed)['all_known_native_children_reaped'])
        self.assertFalse(probe.trace_summary(closed.replace('"exit_code":1','"exit_code":null'))['all_known_native_children_reaped'])
        self.assertFalse(probe.trace_summary(closed.replace('"stdout_closed":true','"stdout_closed":false'))['all_known_native_children_reaped'])


if __name__=='__main__':unittest.main()
