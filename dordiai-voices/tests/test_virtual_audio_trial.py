"""No driver or device installation; guarded files and synthetic PnP API contracts."""
import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC=importlib.util.spec_from_file_location("virtual_trial_test",Path(__file__).resolve().parents[1]/"tools/windows_virtual_audio_trial.py")
m=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class TrialGuards(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.package=self.root/"package-123"
        self.package.mkdir()
        self.output=self.root/"report-123"
        self.environment={"GITHUB_ACTIONS":"true","RUNNER_ENVIRONMENT":"github-hosted",
                          "GITHUB_REPOSITORY":m.REPOSITORY,"GITHUB_RUN_ID":"123",
                          "RUNNER_ARCH":"X64","RUNNER_TEMP":str(self.root)}

    def test_only_owned_hosted_windows64_and_run_bound_paths_allowed(self):
        m.guard_environment(self.environment,self.package,self.output,platform_name="nt",pointer_bytes=8)
        for key,value in (("GITHUB_ACTIONS","false"),("RUNNER_ENVIRONMENT","self-hosted"),
                          ("GITHUB_REPOSITORY","other/repo"),("RUNNER_ARCH","ARM64")):
            with self.subTest(key=key),self.assertRaises(m.TrialBlocked):
                m.guard_environment(dict(self.environment,**{key:value}),self.package,self.output,
                                    platform_name="nt",pointer_bytes=8)
        for platform,size in (("posix",8),("nt",4)):
            with self.assertRaises(m.TrialBlocked):
                m.guard_environment(self.environment,self.package,self.output,platform_name=platform,pointer_bytes=size)
        with self.assertRaises(m.TrialBlocked):
            m.guard_environment(self.environment,self.package,self.root.parent/"foreign-report",
                                platform_name="nt",pointer_bytes=8)

    def test_nested_and_foreign_run_output_rejected(self):
        for target in (self.package/"report-123",self.root/"report-456"):
            with self.assertRaises(m.TrialBlocked):
                m.guard_environment(self.environment,self.package,target,platform_name="nt",pointer_bytes=8)

    def fixture_proof(self):
        payload=b"synthetic fixture; never a driver"
        names=list(m.EXPECTED)
        for name in names:
            (self.package/name).write_bytes(payload)
        pins={name:hashlib.sha256(payload).hexdigest() for name in names}
        proof={"format":"dordiai-vb46-catalogue-verification",
               "package_sha256":"bc44e8974191a5a2427d6c979e2dab08dbb09925f3f435dfa2f0ba3e45b6eb90",
               "catalogue_members":{name:True for name in sorted(m.CAT_MEMBERS)},
               "authenticode_valid":True,"signtool_authenticode_valid":True}
        path=self.root/"validation.json"
        path.write_text(json.dumps(proof),encoding="utf-8")
        return pins,path,proof

    def test_every_hash_and_all_catalogue_members_required(self):
        pins,path,proof=self.fixture_proof()
        with mock.patch.object(m,"EXPECTED",pins):
            self.assertEqual(m.verify_package(self.package,path),proof)
            (self.package/list(pins)[0]).write_bytes(b"tampered")
            with self.assertRaisesRegex(m.TrialBlocked,"hash mismatch"):
                m.verify_package(self.package,path)

    def test_missing_catalogue_member_or_invalid_signature_proof_rejected(self):
        pins,path,proof=self.fixture_proof()
        for field in ("authenticode_valid","signtool_authenticode_valid"):
            path.write_text(json.dumps(dict(proof,**{field:False})),encoding="utf-8")
            with mock.patch.object(m,"EXPECTED",pins),self.assertRaises(m.TrialBlocked):
                m.verify_package(self.package,path)
        proof["catalogue_members"].pop(next(iter(proof["catalogue_members"])))
        path.write_text(json.dumps(proof),encoding="utf-8")
        with mock.patch.object(m,"EXPECTED",pins),self.assertRaises(m.TrialBlocked):
            m.verify_package(self.package,path)

    def test_environment_rejection_never_writes_foreign_output(self):
        output=self.root/"existing"
        output.mkdir()
        args=argparse.Namespace(ephemeral_ci=True,package=self.package,validation=self.root/"none",output=output)
        with mock.patch.object(m,"guard_environment",side_effect=m.TrialBlocked("not owned")):
            self.assertEqual(m.run(args),2)
        self.assertEqual(list(output.iterdir()),[])


    def test_only_expected_no_endpoint_service_result_is_accepted(self):
        report={"format":"dordiai-audio-endpoint-setup","format_version":1,
                "physical_audio_verified":False,"driver_installed":False,"wave_player_verified":False,
                "services":[{"service":name,"after":{"state":4}} for name in ("AudioEndpointBuilder","Audiosrv")],
                "wave_out_devices_before":0,"wave_out_devices_after":0,"status":"blocked",
                "reason":"No Windows audio output endpoint is present. The reviewed virtual driver requires reboot; unattended driver installation was not attempted."}
        self.assertEqual(m.check_audio_service_receipt(report,2),"expected-no-endpoint")
        for patch in ({"reason":"unrelated failure"},{"services":[]},{"driver_installed":True},
                      {"wave_out_devices_after":None}):
            with self.subTest(patch=patch),self.assertRaises(m.TrialBlocked):
                m.check_audio_service_receipt(dict(report,**patch),2)
        with self.assertRaises(m.TrialBlocked):
            m.check_audio_service_receipt(report,1)

    def test_service_control_failure_is_never_silenced(self):
        report={"format":"dordiai-audio-endpoint-setup","format_version":1,
                "physical_audio_verified":False,"driver_installed":False,"wave_player_verified":False,
                "services":[{"service":"AudioEndpointBuilder","after":{"state":4}},
                            {"service":"Audiosrv","start_error":{"winerror":5},"after":{"state":1}}],
                "wave_out_devices_before":0,"wave_out_devices_after":0,"status":"blocked"}
        with self.assertRaisesRegex(m.TrialBlocked,"did not start cleanly"):
            m.check_audio_service_receipt(report,2)

    def test_existing_endpoint_service_success_does_not_claim_audio(self):
        report={"format":"dordiai-audio-endpoint-setup","format_version":1,
                "physical_audio_verified":False,"driver_installed":False,"wave_player_verified":False,
                "services":[{"service":name,"after":{"state":4}} for name in ("AudioEndpointBuilder","Audiosrv")],
                "wave_out_devices_before":1,"wave_out_devices_after":1,"status":"endpoint-present"}
        self.assertEqual(m.check_audio_service_receipt(report,0),"existing-endpoint")


class OwnedPnPContracts(unittest.TestCase):
    def fake(self,reboot=False,preexisting=False):
        pnp=object.__new__(m.WindowsPnP)
        calls=[]
        state={"registered":False,"name":None}
        pnp.create_list=lambda *args:1234
        def create(handle,name,*args):
            state["name"]=name
            calls.append("create")
            return 1
        pnp.create=create
        pnp.instance_id=lambda *args:"ROOT\\"+state["name"]+"\\0000"
        def matching():
            if preexisting:return ["ROOT\\UNRELATED\\0000"]
            return [pnp.instance_id()] if state["registered"] else []
        pnp.matching=matching
        pnp.set_property=lambda *args:1
        def install(code,*args):
            calls.append(("DIF",code))
            if code==0x19:state["registered"]=True
            return 1
        pnp.class_install=install
        def update(parent,hardware,inf,flags,need):
            calls.append(("update",hardware,flags))
            need._obj.value=int(reboot)
            return 1
        pnp.update=update
        def status(flags,problem,*args):
            flags._obj.value=8
            problem._obj.value=0
            return 0
        pnp.node_status=status
        pnp.set_class=lambda *args:1
        pnp.destroy=lambda *args:calls.append("destroy")
        pnp.instance_exists=lambda instance:False
        return pnp,calls

    def test_only_new_owned_instance_noninteractive_and_finally_removed(self):
        pnp,calls=self.fake()
        report={}
        with pnp.owned_device(Path("fixture.inf"),report) as instance:
            self.assertTrue(instance.startswith("ROOT\\DORDIAI_VBCABLE_"))
        self.assertIn(("update",m.HARDWARE_ID,4),calls)
        self.assertIn(("DIF",5),calls)
        self.assertTrue(report["cleanup"]["removed"])
        self.assertFalse(report["windows_requires_reboot"])

    def test_reboot_needed_is_blocked_and_owned_instance_still_removed(self):
        pnp,calls=self.fake(reboot=True)
        report={}
        with self.assertRaisesRegex(m.TrialBlocked,"reboot"):
            with pnp.owned_device(Path("fixture.inf"),report):
                self.fail("Reboot-required device cannot be used")
        self.assertTrue(report["windows_requires_reboot"])
        self.assertTrue(report["cleanup"]["removed"])
        self.assertIn(("DIF",5),calls)

    def test_preexisting_matching_hardware_is_never_updated_or_removed(self):
        pnp,calls=self.fake(preexisting=True)
        with self.assertRaisesRegex(m.TrialBlocked,"already exists"):
            with pnp.owned_device(Path("fixture.inf"),{}):
                self.fail("Cannot own an existing device")
        self.assertEqual(calls,[])


    def test_removal_success_without_actual_absence_is_not_removed(self):
        pnp,calls=self.fake()
        pnp.instance_exists=lambda instance:True
        report={}
        with mock.patch.object(m.time,"monotonic",side_effect=[0,10]):
            with pnp.owned_device(Path("fixture.inf"),report):
                pass
        self.assertTrue(report["cleanup"]["removal_requested"])
        self.assertFalse(report["cleanup"]["removed"])
        self.assertFalse(report["cleanup"]["absence_verified"])

    def test_unknown_absence_query_error_is_not_treated_as_gone(self):
        pnp,calls=self.fake()
        instance="ROOT\\DORDIAI_VBCABLE_FIXTURE\\0000"
        for value,expected in ((0,True),(13,False)):
            pnp.locate_node=lambda *args:value
            self.assertEqual(m.WindowsPnP.instance_exists(pnp,instance),expected)
        pnp.locate_node=lambda *args:99
        with self.assertRaisesRegex(m.TrialBlocked,"could not be established"):
            m.WindowsPnP.instance_exists(pnp,instance)

    def test_cleanup_failure_is_exit1_even_if_install_was_blocked(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            args=argparse.Namespace(ephemeral_ci=True,package=root/"package",validation=root/"validation",
                                    output=root/"output")
            @contextmanager
            def lease(inf,report):
                report["cleanup"]={"attempted":True,"removed":False,"removal_requested":True}
                raise m.TrialBlocked("Install blocked and cleanup deferred")
                yield
            fake=mock.Mock()
            fake.owned_device=lease
            with mock.patch.object(m,"guard_environment"),mock.patch.object(m,"verify_package",return_value={}),\
                 mock.patch.object(m,"endpoints",return_value={}),mock.patch.object(m,"WindowsPnP",return_value=fake):
                self.assertEqual(m.run(args),1)
            report=json.loads((args.output/"endpoint-trial.json").read_text(encoding="utf-8"))
            self.assertEqual(report["status"],"failed")
            self.assertTrue(report["cleanup_failure"])


if __name__=="__main__":
    unittest.main()
