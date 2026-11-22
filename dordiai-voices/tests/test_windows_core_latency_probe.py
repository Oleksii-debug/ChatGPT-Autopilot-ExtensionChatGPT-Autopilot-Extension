"""Safety and experiment scheduling checks; not acoustic acceptance."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

PATH=Path(__file__).resolve().parents[1]/'tools/windows_core_latency_probe.py'
SPEC=importlib.util.spec_from_file_location('core_latency_probe',PATH)
probe=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class LatencyDiagnosisTests(unittest.TestCase):
    def test_balanced_rotating_schedule_preserves_all_new_phrases(self):
        rows=probe.schedule((40,20,10),2,3)
        self.assertEqual(len(rows),18)
        for repeat in range(2):
            for phrase in range(3):
                values=[frames for r,p,frames in rows if (r,p)==(repeat,phrase)]
                self.assertCountEqual(values,[40,20,10])
        self.assertNotEqual(rows[:3],rows[3:6])

    def test_package_snapshot_detects_runtime_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            package=Path(temporary)
            for name in probe.FILES:
                file=package/name; file.parent.mkdir(parents=True,exist_ok=True)
                file.write_bytes(name.encode())
            before=probe.snapshot(package)
            (package/'kx47Runtime/nvda_worker.py').write_bytes(b'changed')
            self.assertNotEqual(before,probe.snapshot(package))

    def test_child_is_syntactically_valid_and_has_no_audio_device(self):
        compile(probe.CHILD,'isolated packaged probe','exec')
        self.assertNotIn('WavePlayer',probe.CHILD)
        self.assertNotIn('write_text',probe.CHILD)
        compile(probe.CHILD_PRIORITY,'owned priority experiment','exec')

    def test_priority_scope_restores_both_owned_handles_after_cancellation(self):
        class Cancelled(BaseException):pass
        class Kernel:
            values={1:0x4000,2:0x4000}
            def GetPriorityClass(self,handle):return self.values[handle]
            def SetPriorityClass(self,handle,value):self.values[handle]=value;return True
        kernel=Kernel()
        with self.assertRaises(Cancelled):
            with probe.owned_priority_scope(kernel,[1,2],0x20):
                self.assertEqual(kernel.values,{1:0x20,2:0x20})
                raise Cancelled()
        self.assertEqual(kernel.values,{1:0x4000,2:0x4000})
        with self.assertRaises(ValueError):
            with probe.owned_priority_scope(kernel,[1],0x80):pass

    def test_failed_second_restore_does_not_leave_first_handle_boosted(self):
        class Kernel:
            values={1:0x4000,2:0x4000}
            def GetPriorityClass(self,handle):return self.values[handle]
            def SetPriorityClass(self,handle,value):
                if handle==2 and value==0x4000:return False
                self.values[handle]=value;return True
        kernel=Kernel()
        with self.assertRaisesRegex(RuntimeError,'restore'):
            with probe.owned_priority_scope(kernel,[1,2],0x20):pass
        self.assertEqual(kernel.values[1],0x4000)


if __name__=='__main__':unittest.main()
