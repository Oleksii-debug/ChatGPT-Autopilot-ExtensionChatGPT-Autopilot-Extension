"""Audio-device failures release constructor-owned resources, never fake success."""
from contextlib import ExitStack
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType,SimpleNamespace
import unittest
from unittest.mock import Mock,patch

from nvda_stubs import driver_module


class Worker:
    def __init__(self,*args,**kwargs):
        self.close=Mock()


class AudioInitializationTests(unittest.TestCase):
    def setUp(self):
        self.context=ExitStack()
        self.addCleanup(self.context.close)
        self.driver=self.context.enter_context(driver_module())
        self.temporary=self.context.enter_context(tempfile.TemporaryDirectory())
        self.models=Path(self.temporary)/"models"
        self.samples=self.models/"voices"
        self.samples.mkdir(parents=True)
        (self.models/"Holos").mkdir()
        (self.samples/"catalog.json").write_text(json.dumps({"sara":"Sara"}),encoding="utf-8")
        self.info={"referencesOnly":True,"referenceEngine":"holos",
                   "referenceModel":str(self.models/"Holos"),"referenceSamples":str(self.samples)}
        self.runtime=(Path(sys.executable),self.models,self.info)
        self.context.enter_context(patch.object(self.driver.SynthDriver,"_runtime_config",return_value=self.runtime))
        self.context.enter_context(patch.object(self.driver._wide,"refresh_personal",return_value={}))
        self.context.enter_context(patch.object(self.driver._wide,"PERSONAL",{}))
        self.workers=[]
        def make_worker(*args,**kwargs):
            worker=Worker(*args,**kwargs)
            self.workers.append(worker)
            return worker
        self.factory=self.context.enter_context(patch.object(self.driver,"SpeechWorker",side_effect=make_worker))
        self.thread=self.context.enter_context(patch.object(self.driver,"Thread"))
        self.sonic=ModuleType("synthDrivers._sonic")
        self.sonic.initialize=Mock()
        self.context.enter_context(patch.dict(sys.modules,{"synthDrivers._sonic":self.sonic}))
        self.player=SimpleNamespace(enableTrimmingLeadingSilence=Mock(),close=Mock())
        self.player_factory=self.context.enter_context(patch.object(self.driver.nvwave,"WavePlayer",return_value=self.player))
        self.release=self.context.enter_context(patch.object(self.driver,"release_shared_worker",
                                                           wraps=self.driver.release_shared_worker))
        self.context.callback(self.driver.close_shared_worker)

    def construct(self,cls=None):
        cls=cls or self.driver.SynthDriver
        obj=cls.__new__(cls)
        return obj,lambda:obj.__init__()

    def assert_failed_closed(self,obj,error,initialize):
        with self.assertRaises(type(error)) as caught:
            initialize()
        self.assertIs(caught.exception,error,"Cleanup must preserve the original audio exception object")
        self.assertTrue(obj._closed)
        self.assertIsNone(obj._player)
        self.assertIsNone(obj._worker_lease)
        self.assertIsNone(obj._engine)
        self.assertIsNone(obj._english_engine)
        self.thread.assert_not_called()
        obj.terminate()  # NVDA may dispose of a partially constructed instance.

    def test_missing_audio_device_releases_shared_lease_once_and_pool_is_reusable(self):
        error=OSError("[WinError -2147023728] Element not found")
        self.player_factory.side_effect=error
        for attempt in range(2):
            obj,initialize=self.construct()
            self.assert_failed_closed(obj,error,initialize)
            self.assertEqual(self.release.call_count,attempt+1)
            self.assertIsNone(self.driver._shared_entry["lease"])
        self.assertEqual(len(self.workers),1,"Failed selection must not leave a busy lease and force new private workers")
        self.workers[0].close.assert_not_called()
        self.player.close.assert_not_called()

    def test_trimming_failure_closes_created_player_before_releasing_shared_lease(self):
        error=OSError("Audio device became unavailable while configuring playback")
        self.player.enableTrimmingLeadingSilence.side_effect=error
        order=[]
        self.player.close.side_effect=lambda:order.append("player")
        # The existing wrapped release mock remains the actual pool operation.
        self.release.side_effect=lambda token:(order.append("lease"),self.release._mock_wraps(token))[1]
        obj,initialize=self.construct()
        self.assert_failed_closed(obj,error,initialize)
        self.player.close.assert_called_once()
        self.release.assert_called_once()
        self.assertEqual(order,["player","lease"])

    def test_sonic_failure_releases_lease_without_creating_a_player_or_thread(self):
        error=RuntimeError("Sonic initialization failed")
        self.sonic.initialize.side_effect=error
        obj,initialize=self.construct()
        self.assert_failed_closed(obj,error,initialize)
        self.release.assert_called_once()
        self.player_factory.assert_not_called()
        self.player.close.assert_not_called()

    def test_exclusive_primary_and_english_workers_close_when_audio_fails(self):
        class PrivateDriver(self.driver.SynthDriver):
            name="kx47PrivateTest"
        error=OSError("No Windows audio endpoint")
        self.player_factory.side_effect=error
        obj,initialize=self.construct(PrivateDriver)
        self.assert_failed_closed(obj,error,initialize)
        self.assertEqual(len(self.workers),2)
        for worker in self.workers:worker.close.assert_called_once()
        self.release.assert_not_called()

    def test_busy_shared_pool_private_fallback_closes_without_releasing_other_driver_lease(self):
        reference=(self.models/"Holos",self.samples,"holos")
        held,token=self.driver.acquire_shared_worker(Path(sys.executable),self.driver.RUNTIME/"nvda_worker.py",
                                                     self.models,reference,"mixed")
        error=OSError("No audio device")
        self.player_factory.side_effect=error
        obj,initialize=self.construct()
        self.assert_failed_closed(obj,error,initialize)
        self.assertEqual(len(self.workers),2)
        self.workers[1].close.assert_called_once()
        held.close.assert_not_called()
        self.assertIs(self.driver._shared_entry["lease"],token)
        self.release.assert_not_called()
        self.driver.release_shared_worker(token)

    def test_cleanup_failures_cannot_replace_original_error_and_all_workers_are_attempted(self):
        class PrivateDriver(self.driver.SynthDriver):
            name="kx47PrivateTest"
        error=OSError("Original audio error")
        self.player.enableTrimmingLeadingSilence.side_effect=error
        self.player.close.side_effect=RuntimeError("Player cleanup also failed")
        obj,initialize=self.construct(PrivateDriver)
        # Add a cleanup failure after worker acquisition, before audio setup.
        original_audio=obj._initialize_audio_output
        def audio_with_failed_worker_close():
            self.workers[0].close.side_effect=RuntimeError("Worker cleanup also failed")
            return original_audio()
        obj._initialize_audio_output=audio_with_failed_worker_close
        self.assert_failed_closed(obj,error,initialize)
        self.player.close.assert_called_once()
        for worker in self.workers:worker.close.assert_called_once()

    def test_successful_audio_setup_keeps_lease_and_starts_rendering_only_after_configuration(self):
        order=[]
        self.player.enableTrimmingLeadingSilence.side_effect=lambda value:order.append("configured")
        self.thread.return_value.start.side_effect=lambda:order.append("thread-started")
        obj,initialize=self.construct()
        initialize()
        self.assertFalse(obj._closed)
        self.assertIs(obj._player,self.player)
        self.assertIsNotNone(obj._worker_lease)
        self.assertIs(self.driver._shared_entry["lease"],obj._worker_lease)
        self.release.assert_not_called()
        self.player.close.assert_not_called()
        self.workers[0].close.assert_not_called()
        self.assertEqual(order,["configured","thread-started"])
        self.thread.assert_called_once()
        # The test thread is a mock, so it cannot execute _run's normal finally.
        self.driver.release_shared_worker(obj._worker_lease)
        obj._worker_lease=None
        obj._closed=True
        self.player.close()


if __name__=="__main__":
    unittest.main()
