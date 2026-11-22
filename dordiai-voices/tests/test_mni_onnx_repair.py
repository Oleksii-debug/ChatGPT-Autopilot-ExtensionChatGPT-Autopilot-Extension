"""Synthetic shape-only graph fixtures, no actual speech-quality claim."""
from hashlib import sha256
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location("mni_repair_test",Path(__file__).resolve().parents[1]/"tools"/"research"/"repair_mni_onnx.py")
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
try:
    import numpy as np
    import onnx
    from onnx import numpy_helper
except ImportError:
    np=None
    onnx=None

class PinTests(unittest.TestCase):
    def test_exact_frozen_existing_proof_helper(self):
        self.assertEqual(m.INSPECTOR_BLOB,"de8cb45548d91fedf7ac973182b3f74cf0c2d1ff")
        self.assertEqual(m.STATE_REPORT_BLOB,"1bf30a01b477adb3041db449a5fb8a71ee9ccc83")
        p=m.load_inspector().probe_tool()
        self.assertEqual(p.FLOAT_ATOL,1e-5)
        self.assertEqual(p.PCM_LSB_LIMIT,1)
        self.assertEqual(m.TORCH_HOLDOUTS,4)

@unittest.skipIf(onnx is None or np is None,"Synthetic graph fixtures need isolated ONNX parser")
class ShapeRepairTests(unittest.TestCase):
    def fixture(self,family="encoder",sequence=None,allowzero=0):
        prefix="/encoder/encoder/" if family=="encoder" else "/decoder/decoder/transformer_block/"
        count=3 if family=="encoder" else 71
        count=count if sequence is None else sequence
        nodes=[]
        outputs=[]
        for layer in range(6):
            for part in (4,5):
                base=prefix+"fft_layers."+str(layer)+"/self_attn"
                tag=base+"/unit"+str(part)
                nodes.extend([
                    onnx.helper.make_node("Constant",[],[tag+"len"],value=numpy_helper.from_array(np.array(count,dtype=np.int64)),name=tag+"length"),
                    onnx.helper.make_node("Constant",[],[tag+"axis"],value=numpy_helper.from_array(np.array([0],dtype=np.int64)),name=tag+"axisnode"),
                    onnx.helper.make_node("Unsqueeze",[tag+"len",tag+"axis"],[tag+"first"],name=tag+"unsqueeze"),
                    onnx.helper.make_node("Constant",[],[tag+"batch"],value=numpy_helper.from_array(np.array([1],dtype=np.int64)),name=tag+"batchnode"),
                    onnx.helper.make_node("Constant",[],[tag+"head"],value=numpy_helper.from_array(np.array([512],dtype=np.int64)),name=tag+"headnode"),
                    onnx.helper.make_node("Concat",[tag+"first",tag+"batch",tag+"head"],[tag+"shape"],axis=0,name=tag+"concat"),
                    onnx.helper.make_node("Reshape",["data",tag+"shape"],[tag+"result"],allowzero=allowzero,name=base+"/Reshape_"+str(part))])
                outputs.append(onnx.helper.make_tensor_value_info(tag+"result",onnx.TensorProto.FLOAT,[None,1,512]))
        weight=numpy_helper.from_array(np.array([.25,-.5],dtype=np.float32),name="synthetic_learned_weight")
        graph=onnx.helper.make_graph(nodes,"metadata-only-synthetic",
            [onnx.helper.make_tensor_value_info("data",onnx.TensorProto.FLOAT,[None,1,512])],outputs,[weight])
        return onnx.helper.make_model(graph,opset_imports=[onnx.helper.make_opsetid("",17)])

    def test_exact12_shape_inputs_changed_weights_and_all_other_nodes_preserved(self):
        graph=self.fixture()
        original={node.name:node.SerializeToString() for node in graph.graph.node}
        weights=[row.SerializeToString() for row in graph.graph.initializer]
        edits=m.patch_graph(graph,"encoder",onnx,np)
        self.assertEqual(len(edits),12)
        self.assertEqual(weights,[row.SerializeToString() for row in graph.graph.initializer])
        changed={row["concat"] for row in edits}
        added={row["new_first_input"] for row in edits}
        for node in graph.graph.node:
            if node.name in original and node.name not in changed:
                self.assertEqual(node.SerializeToString(),original[node.name])
            if node.name in changed:
                self.assertIn(node.input[0],added)
        self.assertEqual(len(graph.graph.node),len(original)+12)
        onnx.checker.check_model(graph)

    def test_decoder71_supported_without_touching_encoder3(self):
        graph=self.fixture("decoder")
        edits=m.patch_graph(graph,"decoder",onnx,np)
        self.assertTrue(all(row["original_frozen_sequence"]==71 for row in edits))

    def test_wrong_frozen_sequence_rejected(self):
        with self.assertRaises(ValueError):
            m.patch_graph(self.fixture(sequence=4),"encoder",onnx,np)

    def test_allowzero1_rejected(self):
        with self.assertRaises(ValueError):
            m.patch_graph(self.fixture(allowzero=1),"encoder",onnx,np)

    def test_missing_native_layer_target_rejected(self):
        graph=self.fixture()
        target=next(node for node in graph.graph.node if node.name.endswith("/Reshape_5"))
        target.name="foreign-name"
        with self.assertRaises(ValueError):
            m.patch_graph(graph,"encoder",onnx,np)

    def test_shared_shape_producer_rejected(self):
        graph=self.fixture()
        target=next(node for node in graph.graph.node if node.name.endswith("/Reshape_4"))
        graph.graph.node.append(onnx.helper.make_node("Identity",[target.input[1]],["forbidden-shared-shape"],name="shared"))
        with self.assertRaises(ValueError):
            m.patch_graph(graph,"encoder",onnx,np)

    def test_wrong_concat_axis_rejected(self):
        graph=self.fixture()
        target=next(node for node in graph.graph.node if node.op_type=="Concat")
        target.attribute[0].i=1
        with self.assertRaises(ValueError):
            m.patch_graph(graph,"encoder",onnx,np)

if __name__=="__main__":
    unittest.main()
