"""Six tiny immutable byte fixtures; no model, network or release publication."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

TOOLS=Path(__file__).resolve().parents[1]/"tools"
spec=importlib.util.spec_from_file_location("draft_afri_dev11_backup_test",TOOLS/"draft_afri_dev11_backup.py")
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def release():
    return {"id":61,"tag_name":m.TAG,"target_commitish":m.STORAGE_ANCHOR,
            "name":m.TITLE,"body":m.BODY,"draft":True,"prerelease":True,"published_at":None}

class Fake:
    def __init__(self,existing=False):
        self.release=release() if existing else None
        self.data={};self.meta={};self.calls=[];self.tag=None
        self.bad_source=False;self.bad_integration=False;self.changed_anchor=False
    def request(self,method,path,payload=None,missing_ok=False):
        self.calls.append((method,path,payload))
        if path.endswith("/actions/runs/"+str(m.SOURCE_RUN)):
            return {"head_sha":"wrong" if self.bad_source else m.SOURCE_COMMIT,"status":"completed",
                    "conclusion":"success","path":".github/workflows/dordiai-afri-resources.yml"}
        if path.endswith("/actions/runs/"+str(m.INTEGRATION_RUN)):
            return {"head_sha":m.INTEGRATION_COMMIT,"status":"completed",
                    "conclusion":"failure" if self.bad_integration else "success",
                    "path":".github/workflows/dordiai-source11-integration.yml"}
        if path.endswith("/actions/artifacts/"+str(m.ARTIFACT_ID)):
            return {"name":m.ARTIFACT_NAME,"expired":False,"size_in_bytes":m.ARTIFACT_SIZE,
                    "digest":"sha256:"+m.ARTIFACT_SHA256,
                    "workflow_run":{"id":m.SOURCE_RUN,"head_sha":m.SOURCE_COMMIT}}
        if path.endswith("/branches/main"):
            return {"commit":{"sha":"e"*40 if self.changed_anchor else m.STORAGE_ANCHOR}}
        if "/git/ref/tags/" in path:return self.tag
        if path.endswith("/releases") and method=="POST":
            self.release=dict(payload,id=61,published_at=None);return self.release
        if path.endswith("/releases/61") and method=="GET":return self.release
        raise AssertionError((method,path))
    def pages(self,path):
        if path.endswith("/releases"):return iter([] if self.release is None else [self.release])
        if path.endswith("/releases/61/assets"):return iter(self.meta.values())
        raise AssertionError(path)
    def add_asset(self,name,raw):
        ident=200+len(self.meta);self.data[ident]=raw
        self.meta[name]={"id":ident,"name":name,"size":len(raw),"state":"uploaded",
                         "digest":"sha256:"+hashlib.sha256(raw).hexdigest()}
        return self.meta[name]
    def upload(self,release_id,name,stream,size):
        if name in self.meta:raise AssertionError("Overwrite")
        raw=stream.read()
        if len(raw)!=size:raise AssertionError("Upload size")
        self.calls.append(("UPLOAD",name,release_id))
        return self.add_asset(name,raw)
    def download_fingerprint(self,ident):
        raw=self.data[ident];self.calls.append(("DOWNLOAD",ident,None))
        return len(raw),hashlib.sha256(raw).hexdigest()

class SixPackBackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.packs=self.root/"six-packs";self.packs.mkdir()
        self.records={};self.payloads={}
        for name in m.PACKS:
            raw=("tiny immutable "+name).encode();self.payloads[name]=raw
            (self.packs/name).write_bytes(raw)
            self.records[name]={"size_bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()}
        identity=dict(m.IDENTITY,packs=self.records)
        marker="<!-- dordiai-afri-six-data-backup-v1 -->\n"
        body=m.BODY.split(marker)[0]+marker+json.dumps(identity,sort_keys=True,separators=(",",":"))+"\n"
        self.patch=mock.patch.multiple(m,PACKS=self.records,IDENTITY=identity,BODY=body)
        self.patch.start();self.addCleanup(self.patch.stop)
        self.receipt=self.root/"receipt.json"
    def test_six_distinct_assets_plus_receipt_readback_and_idempotent_draft(self):
        client=Fake();actual=m.run(self.packs,self.receipt,client)
        self.assertEqual(len(actual["pack_assets"]),6)
        self.assertTrue(actual["all6_download_sha256_verified"])
        self.assertTrue(all(row["download_sha256_verified"] for row in actual["pack_assets"].values()))
        self.assertFalse(actual["product_ready"]);self.assertFalse(actual["physical_audio_verified"])
        self.assertTrue(client.release["draft"]);self.assertEqual(client.release["make_latest"],"false")
        self.assertEqual(len([c for c in client.calls if c[0]=="UPLOAD"]),7)
        self.assertEqual(len([c for c in client.calls if c[0]=="DOWNLOAD"]),7)
        writes=len([c for c in client.calls if c[0] in ("POST","UPLOAD")])
        m.run(self.packs,self.receipt,client)
        self.assertEqual(writes,len([c for c in client.calls if c[0] in ("POST","UPLOAD")]))
        self.assertFalse(any(c[0] in ("PATCH","DELETE") for c in client.calls))
    def test_last_corrupt_pack_is_detected_before_any_remote_request(self):
        last=sorted(self.payloads)[-1];(self.packs/last).write_bytes(self.payloads[last]+b"x")
        client=Fake()
        with self.assertRaises(m.BackupError):m.run(self.packs,self.receipt,client)
        self.assertEqual(client.calls,[])
    def test_missing_or_unknown_file_cannot_be_silently_ignored(self):
        (self.packs/"other.zip").write_bytes(b"unowned");client=Fake()
        with self.assertRaises(m.BackupError):m.run(self.packs,self.receipt,client)
        self.assertEqual(client.calls,[])
    def test_generation_and_separate_actual_integration_are_both_mandatory(self):
        for field in ("bad_source","bad_integration"):
            client=Fake();setattr(client,field,True)
            with self.subTest(field=field),self.assertRaises(m.BackupError):
                m.run(self.packs,self.receipt,client)
            self.assertFalse(any(c[0] in ("POST","UPLOAD") for c in client.calls))
    def test_changed_storage_anchor_is_never_automatically_retargeted(self):
        client=Fake();client.changed_anchor=True
        with self.assertRaises(m.BackupError):m.run(self.packs,self.receipt,client)
        self.assertFalse(any(c[0] in ("POST","UPLOAD","PATCH") for c in client.calls))
    def test_published_unowned_or_wrong_tag_release_rejected(self):
        for key,value in (("draft",False),("published_at","2026-11-22"),
                          ("body","not owned"),("target_commitish",m.SOURCE_COMMIT)):
            client=Fake(existing=True);client.release[key]=value
            with self.subTest(key=key),self.assertRaises(m.BackupError):
                m.run(self.packs,self.receipt,client)
            self.assertFalse(any(c[0]=="UPLOAD" for c in client.calls))
        client=Fake();client.tag={"object":{"type":"commit","sha":"f"*40}}
        with self.assertRaises(m.BackupError):m.run(self.packs,self.receipt,client)
        self.assertFalse(any(c[0] in ("POST","UPLOAD") for c in client.calls))
    def test_unknown_asset_and_existing_corrupt_first_pack_never_overwritten(self):
        client=Fake(existing=True);client.add_asset("not-owned.bin",b"other")
        with self.assertRaises(m.BackupError):m.run(self.packs,self.receipt,client)
        self.assertFalse(any(c[0]=="UPLOAD" for c in client.calls))
        client=Fake(existing=True);name=sorted(self.payloads)[0]
        asset=client.add_asset(name,self.payloads[name]);client.data[asset["id"]]=b"x"*len(self.payloads[name])
        with self.assertRaises(m.BackupError):m.run(self.packs,self.receipt,client)
        self.assertFalse(any(c[0]=="UPLOAD" for c in client.calls))
    def test_publication_between_checks_aborts_before_upload(self):
        client=Fake(existing=True);original=client.request
        def request(method,path,*args,**kwargs):
            if path.endswith("/releases/61"):client.release["draft"]=False
            return original(method,path,*args,**kwargs)
        client.request=request
        with self.assertRaises(m.BackupError):m.run(self.packs,self.receipt,client)
        self.assertFalse(any(c[0]=="UPLOAD" for c in client.calls))
    def test_transport_upload_whitelist_has_only_pinned_six_plus_receipt(self):
        client=m.GitHub("synthetic-not-a-secret")
        with self.assertRaises(m.BackupError):
            client.upload(61,"unowned.zip",io.BytesIO(b"x"),1)

if __name__=="__main__":unittest.main()
