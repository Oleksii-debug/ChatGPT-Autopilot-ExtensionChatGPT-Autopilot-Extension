"""Pinned original inference-only definitions; no historical TTS package import.

AST selection removes unrelated imports/training methods. Selected numerical
method bodies are compiled unchanged. This module has no Torch import at import.
"""
from __future__ import annotations
import __future__
import ast
from hashlib import sha1, sha256
from pathlib import Path
import re

REVISION = "42155940b5d0c4c78a554af04472925ddd326887"
PINS = {
    "TTS/utils/audio.py": "fc9d194201a9e3d8de3bdc4e3103e4a0254a6ea4",
    "TTS/tts/models/base_tts.py": "c86bd391b4281195478c79d332cb6dbbd33cdfb4",
    "TTS/tts/models/forward_tts.py": "a6568a49627f8479a1122056d8f802275dc174ab",
    "TTS/tts/layers/feed_forward/encoder.py": "caf939ffc73fedac299228e090b2df3bb4cc553c",
    "TTS/tts/layers/feed_forward/decoder.py": "34c586aab24e014ce99d5806a975585a242b81bd",
    "TTS/tts/layers/generic/transformer.py": "9b7ecee2bacb68cd330e18630531c97bc6f2e6a3",
    "TTS/tts/layers/generic/normalization.py": "c0270e405e4246e47b7bc0787e4cd4b069533f92",
    "TTS/tts/layers/glow_tts/duration_predictor.py": "e766ed6ab5a0348eaca8d1482be124003d8b8c68",
    "TTS/tts/layers/generic/pos_encoding.py": "2ed8d56786b5442c0038dc2af5eef9c68cdace56",
    "TTS/tts/layers/generic/aligner.py": "eef4c4b66d80f9bab83ddf81427e5b48d2a43b4b",
    "TTS/tts/utils/helpers.py": "c2e7f56146aa95b52824307189573bb32a17eaac",
    "TTS/tts/utils/text/characters.py": "1b375e4fca38c29d7929ddf65a3c2932e2168992",
    "TTS/tts/models/vits.py": "a6b1c74332a89757fe28c143acd18c938bd5f274",
    "TTS/tts/utils/text/tokenizer.py": "1569c634fb583a13a4040901d1e16b53703aa3dd",
    "TTS/tts/utils/text/cleaners.py": "f02f8fb48e23cce5ca604c0c86d3e13abeb42654",
    "TTS/vocoder/models/hifigan_generator.py": "fc15f3af1033470990001cc5106dfe08c2930749",
    "TTS/vocoder/models/__init__.py": "65901617b69d3ae708e09226c5e4ad903f89a929",
    "TTS/utils/synthesizer.py": "7c065eaf12dedbe02b2e8f7ead9e55d020ca2d75",
    "TTS/tts/utils/synthesis.py": "a74300dc948a4eeb88cdf9e936825203d68da9ca",
    "LICENSE.txt": "14e2f777f6c395e7e04ab4aa306bbcc4b0c1120e"
}
SELECTION = [
 ("TTS/tts/layers/generic/normalization.py", {"LayerNorm": None}),
 ("TTS/tts/layers/generic/transformer.py", {"FFTransformer": None, "FFTransformerBlock": None}),
 ("TTS/tts/layers/feed_forward/encoder.py", {"Encoder": None}),
 ("TTS/tts/layers/feed_forward/decoder.py", {"FFTransformerDecoder": None, "Decoder": None}),
 ("TTS/tts/layers/generic/pos_encoding.py", {"PositionalEncoding": None}),
 ("TTS/tts/layers/glow_tts/duration_predictor.py", {"DurationPredictor": None}),
 ("TTS/tts/layers/generic/aligner.py", {"AlignmentNetwork": None}),
 ("TTS/tts/utils/helpers.py", {"sequence_mask": None, "convert_pad_shape": None, "generate_path": None}),
 ("TTS/tts/models/base_tts.py", {"BaseTTS": {"__init__", "_set_model_args"}}),
 ("TTS/tts/models/forward_tts.py", {"ForwardTTS": {
    "__init__", "init_multispeaker", "generate_attn", "expand_encoder_outputs",
    "format_durations", "_forward_encoder", "_forward_decoder",
    "_forward_pitch_predictor", "_set_speaker_input", "inference", "inference2"}}),
 ("TTS/vocoder/models/hifigan_generator.py", {"get_padding": None, "ResBlock1": None,
    "ResBlock2": None, "HifiganGenerator": {"__init__", "forward", "inference"}}),
 ("TTS/tts/utils/text/characters.py", {"BaseCharacters": None}),
 ("TTS/tts/models/vits.py", {"VitsCharacters": None}),
 ("TTS/tts/utils/text/cleaners.py", {"lowercase": None, "collapse_whitespace": None,
    "replace_symbols": None, "remove_aux_symbols": None, "multilingual_cleaners": None}),
 ("TTS/tts/utils/text/tokenizer.py", {"TTSTokenizer": {
    "__init__", "characters", "encode", "decode", "text_to_ids",
    "ids_to_text", "pad_with_bos_eos", "intersperse_blank_char"}}),
]


def read_source(directory, path):
    raw = (Path(directory)/path).read_bytes()
    actual = sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()
    if actual != PINS[path]:
        raise ValueError("Original architecture source bytes differ: " + path)
    return raw.decode("utf-8")


def select(source, names):
    tree = ast.parse(source)
    body, found = [], set()
    for node in tree.body:
        if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in names:
            keep = names[node.name]
            if keep is not None:
                if not isinstance(node, ast.ClassDef):
                    raise ValueError("Method restriction requires class")
                methods = [item for item in node.body if isinstance(item, ast.FunctionDef) and item.name in keep]
                if {item.name for item in methods} != keep:
                    raise ValueError("Pinned original methods missing")
                node.body = methods
            body.append(node)
            found.add(node.name)
    if found != set(names):
        raise ValueError("Pinned original definitions missing")
    return ast.fix_missing_locations(ast.Module(body=body, type_ignores=[]))


def build_namespace(directory, torch):
    import math
    import typing
    namespace = {"__name__": "dordiai_pinned_mni_native", "torch": torch,
        "nn": torch.nn, "F": torch.nn.functional, "math": math, "re": re,
        "BaseTrainerModel": torch.nn.Module, "LRELU_SLOPE": 0.1,
        "Conv1d": torch.nn.Conv1d, "ConvTranspose1d": torch.nn.ConvTranspose1d,
        "weight_norm": torch.nn.utils.weight_norm,
        "remove_weight_norm": torch.nn.utils.remove_weight_norm,
        "_characters": "", "_punctuations": "", "_pad": "_", "_phonemes": "",
        "_whitespace_re": re.compile(r"\s+")}
    namespace.update({name: getattr(typing, name) for name in ("Dict", "List", "Tuple", "Union")})
    for path, names in SELECTION:
        tree = select(read_source(directory, path), names)
        code = compile(tree, path, "exec", flags=__future__.annotations.compiler_flag)
        exec(code, namespace)  # only exact pinned trusted-source definitions above
    return namespace


class NativeConfig(dict):
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError as error:
            raise AttributeError(key) from error
    def __setattr__(self, key, value):
        self[key] = value


def config_tree(value):
    if type(value) is dict:
        return NativeConfig({key: config_tree(item) for key, item in value.items()})
    if type(value) is list:
        return [config_tree(item) for item in value]
    return value


def make_tokenizer(namespace, config):
    if config.get("use_phonemes") is not False or config.get("add_blank") is not False or config.get("enable_eos_bos_chars") is not False:
        raise ValueError("Only this exact published grapheme frontend is audited")
    if config["characters"]["characters_class"] != "TTS.tts.models.vits.VitsCharacters":
        raise ValueError("Unexpected native character implementation")
    chars, _ = namespace["VitsCharacters"].init_from_config(config_tree(config))
    if chars.num_chars != 114 or config["model_args"]["num_chars"] != chars.num_chars:
        raise ValueError("Native114-token checkpoint vocabulary mismatch")
    return namespace["TTSTokenizer"](use_phonemes=False,
        text_cleaner=namespace["multilingual_cleaners"], characters=chars,
        add_blank=False, use_eos_bos=False)


def strict_ids(tokenizer, text):
    cleaned = tokenizer.text_cleaner(text)
    if not cleaned or len(cleaned) > 200:
        raise ValueError("Probe text is empty or exceeds bounded native utterance")
    unknown = sorted({char for char in cleaned if char not in tokenizer.characters._char_to_id})
    if unknown:
        raise ValueError("Unsupported native graphemes: " + repr(unknown))
    actual = tokenizer.text_to_ids(text)
    direct = [tokenizer.characters.char_to_id(char) for char in cleaned]
    if actual != direct or tokenizer.not_found_characters:
        raise ValueError("Native tokenizer silently dropped text")
    return cleaned, actual


def make_models(namespace, torch, fast_config, hifi_config, speakers, compact=False):
    import copy
    from types import SimpleNamespace
    cfg = copy.deepcopy(fast_config)
    if compact:
        cfg["model_args"]["use_aligner"] = False
    if cfg["model"] != "fast_pitch" or cfg["model_args"]["encoder_type"] != "fftransformer" or cfg["model_args"]["decoder_type"] != "fftransformer":
        raise ValueError("Unsupported original native architecture")
    if speakers != {"female": 0, "male": 1} or cfg["num_speakers"] != 2:
        raise ValueError("Original published speaker identity changed")
    model = namespace["ForwardTTS"](config_tree(cfg),
        speaker_manager=SimpleNamespace(num_speakers=2))
    if hifi_config["generator_model"] != "hifigan_generator":
        raise ValueError("Unexpected native vocoder architecture")
    generator = namespace["HifiganGenerator"](
        in_channels=hifi_config["audio"]["num_mels"], out_channels=1,
        **hifi_config["generator_model_params"])
    model.eval()
    generator.eval()
    return model, generator


def tensor_identity(tensor):
    if str(tensor.dtype) != "torch.float32" or str(tensor.device) != "cpu":
        raise ValueError("Every retained native weight must stay CPU FP32")
    array = tensor.detach().contiguous().numpy()
    return {"shape": list(tensor.shape), "dtype": str(tensor.dtype),
            "numel": tensor.numel(), "size_bytes": tensor.numel()*tensor.element_size(),
            "sha256": sha256(memoryview(array).cast("B")).hexdigest()}


def selected_states(checkpoint, vocoder):
    if not isinstance(checkpoint, dict) or not isinstance(vocoder, dict):
        raise ValueError("Expected native checkpoint mapping")
    fast = checkpoint["model"]
    raw_generator = vocoder["model"]
    if any(not key.startswith(("model_g.", "model_d.")) for key in raw_generator):
        raise ValueError("Unexpected generator/discriminator state namespace")
    generator = {key[len("model_g."):]: value for key, value in raw_generator.items() if key.startswith("model_g.")}
    if not fast or not generator:
        raise ValueError("Native model tensors missing")
    return fast, generator
