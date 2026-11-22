"""Synthetic/unit checks; actual native weights/audio proof is separate."""
import ast
from hashlib import sha256
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

DIRECTORY=Path(__file__).resolve().parents[1]/"tools"/"research"
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
n=load("mni_definitions_unit",DIRECTORY/"mni_native_definitions.py")
p=load("mni_probe_unit",DIRECTORY/"probe_mni_native.py")

class DefinitionsTests(unittest.TestCase):
    def test_source_whitelist_excludes_top_level_side_effects(self):
        text="raise RuntimeError('must not execute')\ndef keep(x): return x+1\ndef unwanted(): raise RuntimeError()\n"
        selected=n.select(text,{"keep":None})
        namespace={}
        exec(compile(selected,"synthetic-source","exec"),namespace)
        self.assertEqual(namespace["keep"](2),3)
        self.assertNotIn("unwanted",namespace)

    def test_methods_not_requested_are_removed(self):
        tree=n.select("class Example:\n def kept(self): return 3\n def unsafe(self): raise RuntimeError()\n",{"Example":{"kept"}})
        namespace={}
        exec(compile(tree,"synthetic-source","exec"),namespace)
        self.assertEqual(namespace["Example"]().kept(),3)
        self.assertFalse(hasattr(namespace["Example"],"unsafe"))

    def test_missing_method_fails_closed(self):
        with self.assertRaises(ValueError):
            n.select("class Example: pass",{"Example":{"required"}})

    def test_missing_class_fails_closed(self):
        with self.assertRaises(ValueError):
            n.select("def other(): pass",{"required":None})

    def test_config_tree_preserves_dict_and_attribute_semantics(self):
        cfg=n.config_tree({"model_args":{"num_chars":114},"sample":[{"a":2}]})
        self.assertEqual(cfg.model_args.num_chars,114)
        self.assertEqual(cfg["model_args"]["num_chars"],114)
        self.assertEqual(cfg.sample[0].a,2)
        self.assertIn("Config",type(cfg).__name__)

    def test_real_state_names_are_not_fake_mni_aliases(self):
        model={"model":{"emb.weight":"synthetic"}}
        vocoder={"model":{"model_g.conv.weight":"g","model_d.conv.weight":"d"}}
        fast,generator=n.selected_states(model,vocoder)
        self.assertEqual(generator,{"conv.weight":"g"})
        self.assertEqual(fast,{"emb.weight":"synthetic"})
        with self.assertRaises(ValueError):
            n.selected_states(model,{"model":{"foreign.weight":"bad"}})

    def test_stage_overlap_rejected_before_any_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with self.assertRaises(ValueError):
                p.validate_stages(root/"inputs"/"sources"/"a.py",root/"inputs")
            with self.assertRaises(ValueError):
                p.validate_stages(root/"raw.zip",root/"inputs",root/"inputs"/"output")
            p.validate_stages(root/"raw.zip",root/"inputs",root/"output")
            self.assertEqual(list(root.iterdir()),[])

    def test_reference_source_pin_rejects_modified_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"TTS"/"tts"/"models"/"forward_tts.py"
            path.parent.mkdir(parents=True)
            path.write_text("# synthetic changed source",encoding="utf-8")
            with self.assertRaises(ValueError):
                n.read_source(directory,"TTS/tts/models/forward_tts.py")

    def test_unsupported_glyph_is_never_silently_dropped(self):
        tokenizer=Mock()
        tokenizer.text_cleaner=lambda value:value
        tokenizer.characters._char_to_id={"a":0}
        with self.assertRaises(ValueError):
            n.strict_ids(tokenizer,"ab")
        tokenizer.text_to_ids.assert_not_called()

try:
    import numpy as np
except ImportError:
    np=None
try:
    import torch
except ImportError:
    torch=None

@unittest.skipIf(np is None,"Numerical unit fixtures require NumPy")
class NumericalUnits(unittest.TestCase):
    def test_expand_exact_values_variable_duration(self):
        actual=p.expand_numpy(np.array([[[1,2,3]]],dtype=np.float32),np.array([[1,3,2]],dtype=np.float32),np)
        np.testing.assert_array_equal(actual,np.array([[[1,2,2,2,3,3]]],dtype=np.float32))

    def test_expand_does_not_round_fractional_or_empty_duration(self):
        for value in ([1.2],[0],[-1],[float("nan")],[p.MAX_FRAMES+1]):
            with self.assertRaises(ValueError):
                p.expand_numpy(np.ones((1,1,1),dtype=np.float32),np.array([value]),np)

    def test_signed_zero_is_numerically_equal_but_not_bit_exact(self):
        result=p.comparison(np.array([0.],dtype=np.float32),np.array([-0.],dtype=np.float32),np)
        self.assertTrue(result["float_pass"])
        self.assertFalse(result["bit_exact"])

    def test_shape_mismatch_cannot_be_called_parity(self):
        with self.assertRaises(ValueError):
            p.comparison(np.ones(2),np.ones(3),np)

    def test_pcm_failure_preserves_numeric_evidence(self):
        result=p.comparison(np.zeros(2),np.array([0,.01]),np,pcm=True)
        self.assertFalse(result["float_pass"])
        self.assertFalse(result["pcm_pass"])
        self.assertGreater(result["pcm_max_lsb"],p.PCM_LSB_LIMIT)

    def test_empty_nonfinite_and_silent_wave_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            for index,values in enumerate(([],[float("nan")],[0,0])):
                with self.assertRaises(ValueError):
                    p.save_wave(Path(directory)/str(index),values,np)

    def test_wave_write_is_no_clobber(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"synthetic.wav"
            record=p.save_wave(path,[.1,-.1],np)
            self.assertEqual(record["samples"],2)
            old=path.read_bytes()
            with self.assertRaises(FileExistsError):
                p.save_wave(path,[.2,-.2],np)
            self.assertEqual(path.read_bytes(),old)

@unittest.skipIf(torch is None or np is None,"Tiny tensor fixtures require isolated CPU Torch/NumPy")
class TinyTensorUnits(unittest.TestCase):
    def test_identity_is_exact_fp32_raw_bytes(self):
        value=torch.tensor([[.25,-.5]],dtype=torch.float32)
        record=n.tensor_identity(value)
        self.assertEqual(record["sha256"],sha256(value.numpy().tobytes()).hexdigest())
        self.assertEqual(record["shape"],[1,2])
        with self.assertRaises(ValueError):
            n.tensor_identity(value.half())

    @unittest.skipUnless(os.environ.get("MNI_PINNED_SOURCE_DIRECTORY"),"Pinned original sources are acquired only in isolated research")
    def test_original_source_definitions_and_tokenizer(self):
        source=Path(os.environ["MNI_PINNED_SOURCE_DIRECTORY"])
        namespace=n.build_namespace(source,torch)
        cfg={
          "use_phonemes":False,"add_blank":False,"enable_eos_bos_chars":False,
          "model_args":{"num_chars":114},
          "characters":{"characters_class":"TTS.tts.models.vits.VitsCharacters",
            "pad":"<PAD>","punctuations":"!¡'(),-.:;¿? ",
            "phonemes":None,
            "characters":" ,-./0123456789acefghkmnoprvwঁংঅআইঈউঊএঐওঔকখগঘঙচছজঝঞটঠডণতথদধনপফবভমযরলশষসহ়ািীুূৃেৈোৌ্ৎয়০১২৩৪৫৬৭৮৯ৰৱ৷"}}
        tokenizer=n.make_tokenizer(namespace,cfg)
        self.assertEqual(tokenizer.characters.num_chars,114)
        self.assertEqual(tokenizer.characters.vocab[0],"<PAD>")
        self.assertEqual(tokenizer.characters.vocab[-1],"<BLNK>")
        clean,ids=n.strict_ids(tokenizer,"মথং")
        self.assertEqual(clean,"মথং")
        self.assertTrue(ids)
        self.assertEqual(tokenizer.decode(ids),"মথং")
        self.assertNotIn("train_step",namespace["ForwardTTS"].__dict__)
        self.assertNotIn("load_checkpoint",namespace["HifiganGenerator"].__dict__)

if __name__=="__main__":
    unittest.main()
