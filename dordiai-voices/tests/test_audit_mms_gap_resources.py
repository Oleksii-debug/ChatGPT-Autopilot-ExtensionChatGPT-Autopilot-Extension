import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location("mms_gap_audit",Path(__file__).resolve().parents[1]/"tools/audit_mms_gap_resources.py")
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)

class GapAuditTests(unittest.TestCase):
    def test_exact_native_paths_reject_neighbour_codes(self):
        files=["models/ton/G_100000.pth","models/tn/G_100000.pth","models/nde/G_100000.pth",
               "models/nbl/G_100000.pth","models/hmo.tar.gz","models/meu.tar.gz","models/tonic.bin"]
        self.assertEqual(audit.matching_paths(files,"ton"),["models/ton/G_100000.pth"])
        self.assertEqual(audit.matching_paths(files,"nbl"),["models/nbl/G_100000.pth"])
        self.assertEqual(audit.matching_paths(files,"hmo"),["models/hmo.tar.gz"])

    def test_wrong_official_repository_identity_rejected(self):
        with self.assertRaises(ValueError):
            audit.repo_summary({"http_status":200,"json":{"id":"facebook/mms-tts-nde","sha":"a"*40}},"facebook/mms-tts-nbl")

    def test_404_401_transport_distinct_and_no_ready_claim(self):
        def fetch(url):
            if url.endswith("/api/models/facebook/mms-tts"):
                return {"url":url,"http_status":200,"json":{"id":"facebook/mms-tts","sha":"a"*40,
                    "siblings":[{"rfilename":"models/hau/G_100000.pth"}],"cardData":None}}
            if url.endswith("/api/models/facebook/mms-tts-hau"):
                return {"url":url,"http_status":200,"json":{"id":"facebook/mms-tts-hau","sha":"b"*40,
                    "siblings":[{"rfilename":"model.safetensors"}]}}
            if url.endswith("/models/hau"):
                return {"url":url,"http_status":200,"json":[{"type":"file","path":"models/hau/G_100000.pth"}]}
            if url.endswith("/api/models/facebook/mms-tts-ton"):
                return {"url":url,"http_status":404}
            if url.endswith("/api/models/facebook/mms-tts-hmo"):
                return {"url":url,"http_status":401}
            return {"url":url,"http_status":None,"classification":"transport-error"}
        result=audit.audit(fetch)
        rows={row["native_iso639_3"]:row for row in result["checks"]}
        self.assertEqual(rows["ton"]["individual_lookup_result"],"actual-primary-HTTP404")
        self.assertEqual(rows["hmo"]["individual_lookup_result"],"public-access-denied-or-hidden-not-proof-of-nonexistence")
        self.assertEqual(rows["aar"]["individual_lookup_result"],"inconclusive-transport-or-response")
        self.assertTrue(all(not row["model_ready"] for row in result["checks"]))
        self.assertTrue(rows["ton"]["directory_pattern_verified_by_actual_hau"])

if __name__=="__main__":unittest.main()
