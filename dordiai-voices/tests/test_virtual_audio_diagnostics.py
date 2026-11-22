"""No native APIs: bounded worker dispatch and error propagation fixtures only."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

TOOLS=Path(__file__).resolve().parents[1]/"tools"
sys.path.insert(0,str(TOOLS))
import windows_virtual_audio_diagnostics as diagnostic


class NativeDiagnosticTests(unittest.TestCase):
    def test_six_argument_worker_dispatch_is_exact(self):
        argv=["worker.py","--native-worker","in","0","48000","2"]
        with mock.patch.object(sys,"argv",argv),mock.patch.object(diagnostic,"native_worker",return_value={"query":{"mmresult":1}}) as worker,\
             redirect_stdout(io.StringIO()) as output:
            self.assertEqual(diagnostic.main(),0)
        worker.assert_called_once_with("in",0,48000,2)
        self.assertEqual(json.loads(output.getvalue())["query"]["mmresult"],1)

    def test_worker_timeout_is_not_open_success(self):
        error=subprocess.TimeoutExpired(["owned-child"],10)
        with mock.patch.object(diagnostic.subprocess,"run",side_effect=error):
            result=diagnostic.isolated_trial("in",0,48000,2)
        self.assertTrue(result["worker_timeout"])
        self.assertNotIn("actual_open",result)

    def test_worker_error_is_preserved_without_guessing_format_support(self):
        completed=subprocess.CompletedProcess(["owned-child"],1,stdout="",stderr="native fixture failure")
        with mock.patch.object(diagnostic.subprocess,"run",return_value=completed):
            result=diagnostic.isolated_trial("out",0,44100,1)
        self.assertEqual(result["returncode"],1)
        self.assertIn("native fixture failure",result["worker_error"])
        self.assertNotIn("actual_open",result)

    def test_native_result_and_subprocess_bound_preserved(self):
        data={"query":{"mmresult":0},"actual_open":{"mmresult":1,"error_text":"Unspecified error"}}
        completed=subprocess.CompletedProcess(["owned-child"],0,stdout=json.dumps(data),stderr="")
        with mock.patch.object(diagnostic.subprocess,"run",return_value=completed) as run:
            result=diagnostic.isolated_trial("in",0,48000,2)
        self.assertEqual(result,data)
        self.assertEqual(run.call_args.kwargs["timeout"],10)
        self.assertIn("--native-worker",run.call_args.args[0])
        self.assertFalse(run.call_args.kwargs["check"])


    def test_wasapi_gate_requires_six_observed_failures(self):
        rows=[{"actual_open":{"mmresult":1}} for _ in range(5)]
        with mock.patch.object(diagnostic.subprocess,"run") as child:
            result=diagnostic.wasapi_after_six_failures(rows,{"name":"CABLE Output"},"ROOT\\fixture",Path("unused"))
        self.assertEqual(result["status"],"not-attempted")
        child.assert_not_called()
        rows.append({"worker_timeout":True})
        with mock.patch.object(diagnostic.subprocess,"run") as child:
            self.assertEqual(diagnostic.wasapi_after_six_failures(rows,{"name":"CABLE Output"},"ROOT\\fixture",Path("unused"))["status"],
                             "not-attempted")
        child.assert_not_called()


if __name__=="__main__":
    unittest.main()
