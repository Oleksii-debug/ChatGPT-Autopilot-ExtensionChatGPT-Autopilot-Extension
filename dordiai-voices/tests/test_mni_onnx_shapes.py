"""Metadata-only synthetic fixtures; no model quality or speech evidence."""
from io import BytesIO
import importlib.util
from pathlib import Path
from urllib.error import HTTPError
import unittest
from unittest.mock import Mock,patch
DIRECTORY=Path(__file__).resolve().parents[1]/"tools"/"research"
spec=importlib.util.spec_from_file_location("mni_onnx_shape_unit",DIRECTORY/"inspect_mni_onnx_shapes.py")
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class SourceSafetyTests(unittest.TestCase):
    def test_exact_existing_failed_export_artifact_pin(self):
        self.assertEqual(m.ARTIFACT_ID,14757527796)
        self.assertEqual(m.ARTIFACT_SIZE,547019006)
        self.assertEqual(m.ARTIFACT_SHA,"81b5dc8fa87f3f6604264de435c05c9e6feb2deeb6d3e889f6808b6d6764d51a")
        self.assertEqual(len(m.GRAPHS),3)
        self.assertEqual(m.PROOF_BLOB,"c74f720a09a3f2a9bc9d2dc7acc23ee5fa2db797")

    def test_frozen_proof_helper_pin(self):
        self.assertEqual(m.probe_tool().PCM_LSB_LIMIT,1)

    def test_redirect_handler_never_forwards_github_credentials(self):
        self.assertIsNone(m.NoRedirect().redirect_request(None,None,302,"",{},"https://example.invalid"))

    def test_auth_sent_only_to_exact_api_before_returning_uncredentialed_location(self):
        fake=Mock()
        fake.open.side_effect=HTTPError("synthetic",302,"Found",
            {"Location":"https://example.blob.core.windows.net/file?sig=synthetic"},BytesIO())
        with patch.object(m,"build_opener",return_value=fake):
            location=m.signed_artifact_location("synthetic-token")
        request=fake.open.call_args.args[0]
        self.assertTrue(request.full_url.startswith("https://api.github.com/repos/"))
        self.assertEqual(request.get_header("Authorization"),"Bearer synthetic-token")
        self.assertNotIn("synthetic-token",location)

    def test_foreign_or_non_https_redirect_rejected(self):
        for location in ("http://example.blob.core.windows.net/a",
                         "https://example.invalid/a",
                         "https://user:pass@example.blob.core.windows.net/a"):
            fake=Mock()
            fake.open.side_effect=HTTPError("synthetic",302,"Found",{"Location":location},BytesIO())
            with patch.object(m,"build_opener",return_value=fake):
                with self.assertRaises(ValueError):
                    m.signed_artifact_location("synthetic-token")

    def test_empty_or_header_injected_token_rejected(self):
        for token in ("","a\r\nBad:evil"):
            with self.assertRaises(ValueError):
                m.signed_artifact_location(token)

try:
    import onnx
    from onnx import numpy_helper
    import numpy as np
except ImportError:
    onnx=None
    np=None

@unittest.skipIf(onnx is None or np is None,"Bounded shape fixtures require isolated ONNX")
class ShapeExpressionTests(unittest.TestCase):
    def test_actual_constant_shape_values_reported_without_model_execution(self):
        shape=numpy_helper.from_array(np.array([71,1,512],dtype=np.int64))
        constant=onnx.helper.make_node("Constant",[],["shape"],value=shape,name="native-shape")
        graph=onnx.helper.make_graph([constant],"synthetic",[],[])
        result=m.expression(graph,"shape",onnx,np)
        self.assertEqual(result["constant"],[71,1,512])

    def test_dynamic_input_shape_not_guessed_from_example(self):
        node=onnx.helper.make_node("Shape",["expanded"],["shape"],name="dynamic-shape")
        graph=onnx.helper.make_graph([node],"synthetic",[],[])
        result=m.expression(graph,"shape",onnx,np)
        self.assertEqual(result["kind"],"Shape")
        self.assertEqual(result["inputs"][0]["kind"],"graph-input-or-unresolved")
        self.assertNotIn("constant",result)

    def test_cycle_is_bounded(self):
        a=onnx.helper.make_node("Identity",["b"],["a"])
        b=onnx.helper.make_node("Identity",["a"],["b"])
        graph=onnx.helper.make_graph([a,b],"synthetic-invalid-metadata-only",[],[])
        result=m.expression(graph,"a",onnx,np)
        self.assertEqual(result["inputs"][0]["inputs"][0]["kind"],"depth-or-cycle-bound")

    def test_large_constant_payload_not_expanded_into_report(self):
        node=onnx.helper.make_node("Constant",[],["large"],
            value=numpy_helper.from_array(np.zeros(1000,dtype=np.float32)))
        graph=onnx.helper.make_graph([node],"synthetic",[],[])
        result=m.expression(graph,"large",onnx,np)
        self.assertNotIn("constant",result)

if __name__=="__main__":
    unittest.main()
