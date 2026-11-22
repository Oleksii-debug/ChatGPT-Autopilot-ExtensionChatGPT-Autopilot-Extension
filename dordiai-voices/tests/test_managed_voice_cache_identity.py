"""A same-ID managed replacement must never inherit the old speaker's PCM."""
import base64
from collections import OrderedDict
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import Mock,patch
import wave

import numpy as np
from nvda_stubs import driver_module

ROOT=Path(__file__).resolve().parents[1]
RUNTIME=ROOT/"source/0.12.2/kx47Runtime"
sys.path.insert(0,str(RUNTIME))
import navigation_cache
import voice_assets
import voice_packages


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli=load("_managed_identity_voice_cli",ROOT/"tools/voice_packages.py")
bank_module=load("_managed_identity_letter_bank",ROOT/"source/0.12.2/synthDrivers/_dordiai_letter_bank.py")
OLD_PCM=struct.pack("<hhh",100,-100,0)*100
NEW_PCM=struct.pack("<hhh",900,-900,0)*100


class ManagedVoiceCacheIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base=Path(self.temporary.name)
        self.references=self.base/"models/voices"
        self.references.mkdir(parents=True)
        self.source=self.base/"prepared"
        self.source.mkdir()
        np.save(self.source/"new-identity.npy",np.full((1,256),.9,np.float32))
        self.recipe={"voice_id":"viktoriia","version":"1.0.0","name":"Replacement Viktoriia",
                     "engine":{"id":"holos","compatibility_version":1},"languages":["uk"],
                     "provenance":{"source":"Explicit synthetic test profile","license":"CC0-1.0"},
                     "roles":{"new-identity.npy":"holos_profile"}}
        key=bank_module.bank_key("uk","бе")
        for folder in ("native_letters","native_commands"):
            directory=self.references/folder
            directory.mkdir()
            (directory/"viktoriia.json").write_text(json.dumps({key:[0,len(OLD_PCM)]}),encoding="utf-8")
            (directory/"viktoriia.pcm").write_bytes(OLD_PCM)
        for folder in ("navigation","navigation_native","navigation_profile"):
            path=self.references/folder/"viktoriia"/navigation_cache.cache_name("uk","бе")
            path.parent.mkdir(parents=True)
            with wave.open(str(path),"wb") as stream:
                stream.setnchannels(1);stream.setsampwidth(2);stream.setframerate(24000);stream.writeframes(OLD_PCM)
        self.context=driver_module()
        self.driver=self.context.__enter__()
        self.addCleanup(lambda:self.context.__exit__(None,None,None))
        self.addCleanup(self.driver.close_shared_worker)
        self.request={"mode":"reference","profile":"viktoriia","language":"uk","text":"бе",
                      "character":True,"speed":1.,"controls":{"pitch":50,"timbre":50,"volume":100}}
        voice_assets.clear_cache()
        self.addCleanup(voice_assets.clear_cache)

    def install(self):
        manifest=cli.prepare_manifest(self.source,**self.recipe)
        path=self.base/(self.recipe["version"]+".dordiai-voice")
        voice_packages.create_package(self.source,manifest,path)
        return voice_assets.install_voice_package(path,self.references)

    def worker(self):
        return self.driver.SpeechWorker(sys.executable,"must-not-run.py",self.base/"models",
            (self.base/"models/Holos",self.references,"holos"))

    def test_optional_managed_bank_absence_cannot_borrow_same_id_builtin_pcm(self):
        reader=bank_module.NativeLetterBank(self.references)
        self.assertEqual(reader.read("viktoriia","uk","бе"),OLD_PCM)
        self.install()
        self.assertIsNone(reader.read("viktoriia","uk","бе"))
        commands=bank_module.NativeLetterBank(self.references,"native_commands")
        self.assertIsNone(commands.read("viktoriia","uk","бе"))
        self.assertIsNone(navigation_cache.load_clip(self.references,"viktoriia","uk","бе",1.))

    def test_new_managed_session_skips_all_legacy_navigation_and_old_epoch_memory(self):
        old=self.worker()
        old._remember_clip(old._epoch_clip_key(self.request),OLD_PCM)
        self.install()
        worker=self.worker()
        worker._clips=old._clips.copy()
        worker._navigation[("navigation","viktoriia","uk","бе",False)]=OLD_PCM
        self.assertIsNone(worker.fast_clip(self.request))
        self.assertIsNone(worker.fast_clip({**self.request,"character":False}))
        # New same-version live synthesis may still use the bounded PCM cache.
        worker._remember_clip(worker._epoch_clip_key(self.request),NEW_PCM)
        self.assertEqual(worker.fast_clip(self.request),NEW_PCM)
        self.assertIsNone(worker._process)

    def test_mid_session_index_change_rejects_old_memory_and_neural_worker_until_reload(self):
        worker=self.worker()
        worker._remember_clip(worker._epoch_clip_key(self.request),OLD_PCM)
        self.install()
        with patch.object(worker,"_send") as send:
            for action in (lambda:worker.fast_clip(self.request),lambda:worker._cached_clip(self.request),
                           lambda:list(worker.stream(self.request,lambda:False)),lambda:worker.preload()):
                with self.subTest(action=action),self.assertRaisesRegex(RuntimeError,"перезапустіть"):
                    action()
            send.assert_not_called()

    def test_epoch_change_during_bank_read_cannot_return_mixed_old_pcm(self):
        worker=self.worker()
        def activate_during_read(*args):
            self.install()
            return OLD_PCM
        with patch.object(worker._letterBank,"read",side_effect=activate_during_read):
            with self.assertRaisesRegex(RuntimeError,"перезапустіть"):
                worker.fast_clip(self.request)

    def test_epoch_change_while_model_runs_discards_the_completed_old_result(self):
        worker=self.worker()
        def changed_result(*args):
            self.install()
            return {"pcm":base64.b64encode(OLD_PCM).decode("ascii")}
        with patch.object(worker,"_send") as send,patch.object(worker,"_receive",side_effect=changed_result):
            with self.assertRaisesRegex(RuntimeError,"перезапустіть"):
                list(worker.stream(self.request,lambda:False))
            send.assert_called_once()
        self.assertEqual(worker._clips,OrderedDict())

    def test_new_driver_pool_epoch_retires_old_process_and_model_caches(self):
        arguments=(sys.executable,"must-not-run.py",self.base/"models",
                   (self.base/"models/Holos",self.references,"holos"),"mixed")
        old,token=self.driver.acquire_shared_worker(*arguments)
        self.driver.release_shared_worker(token)
        old_close=Mock(wraps=old.close)
        old.close=old_close
        self.install()
        new,new_token=self.driver.acquire_shared_worker(*arguments)
        self.assertIsNot(new,old)
        old_close.assert_called_once()
        self.assertNotEqual(old._resource_epoch,new._resource_epoch)
        self.assertEqual(new._clips,OrderedDict())
        self.driver.release_shared_worker(new_token)

    def test_corrupt_managed_index_fails_closed_instead_of_old_builtin_identity(self):
        root=voice_assets.package_root(self.references)
        root.mkdir()
        (root/"voice-packages.json").write_text("invalid JSON",encoding="utf-8")
        with self.assertRaises(ValueError):
            bank_module.NativeLetterBank(self.references).read("viktoriia","uk","бе")
        with self.assertRaises(ValueError):
            navigation_cache.load_clip(self.references,"viktoriia","uk","бе",1.)
        with self.assertRaises(ValueError):
            self.worker().fast_clip(self.request)


if __name__=="__main__":unittest.main()
