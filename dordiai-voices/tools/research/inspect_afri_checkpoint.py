"""Inspect the pinned Afri export and original checkpoint metadata, without inference.

Reuses the verified native-proof model cache. Only the original safetensors
header is range-read; full checkpoint tensor bytes are not acquired or verified.
Actual ONNX input shapes and unabridged representative names distinguish unique
transformer blocks from optimizer-generated naming branches.
"""
from __future__ import annotations
import argparse
from hashlib import sha256
import importlib.util
import json
import math
from pathlib import Path
import re
import struct
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("afri_probe_inspection_base", HERE / "afri_sherpa_probe.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def checkpoint_header(record, url):
    request = Request(url, headers={"Range": "bytes=0-2097159", "User-Agent": "dordiai-checkpoint-header-inspection"})
    with urlopen(request, timeout=60) as response:
        status = response.status
        content_range = response.headers.get("Content-Range")
        if status == 206 and (not content_range or not content_range.startswith("bytes 0-")):
            raise ValueError("Checkpoint range does not start at byte0")
        first = response.read(8)
        if len(first) != 8:
            raise ValueError("Truncated safetensors header length")
        amount = struct.unpack("<Q", first)[0]
        if not 2 <= amount <= 2 * 1024 * 1024:
            raise ValueError("Unexpected safetensors header size")
        raw = response.read(amount)
    if len(raw) != amount:
        raise ValueError("Truncated safetensors metadata")
    values = json.loads(raw)
    layers, examples, dtypes, parameters = set(), {}, {}, 0
    for name, value in values.items():
        if name == "__metadata__":
            continue
        shape = value["shape"]
        if any(type(x) is not int or x < 0 for x in shape):
            raise ValueError("Invalid checkpoint tensor shape")
        count = math.prod(shape)
        parameters += count
        dtypes[value["dtype"]] = dtypes.get(value["dtype"], 0) + count
        match = re.search(r"(?:^|\.)flow_lm\.transformer\.layers\.(\d+)\.", name)
        if match:
            layer = int(match.group(1))
            layers.add(layer)
            if layer in {0, 5, 6, 23} and len(examples.setdefault(str(layer), [])) < 3:
                examples[str(layer)].append({"name": name, "shape": shape, "dtype": value["dtype"]})
    return {
        "url": url, "expected_full_file_pin": record,
        "full_checkpoint_sha256_verified": False,
        "only_header_received_bytes": amount + 8, "http_status": status, "content_range": content_range,
        "header_sha256": sha256(raw).hexdigest(), "tensor_count": len(values) - int("__metadata__" in values),
        "parameter_count_from_header_shapes": parameters, "parameter_counts_by_dtype": dtypes,
        "strict_flow_lm_layer_ids": sorted(layers), "representative_flow_lm_tensors": examples,
        "header_metadata": values.get("__metadata__"),
        "scope": "Header observation at immutable URL, not verification/execution of the full checkpoint tensor payload.",
    }


def value_info(value, onnx):
    kind = value.type.tensor_type
    shape = []
    for item in kind.shape.dim:
        shape.append(item.dim_param if item.HasField("dim_param") else item.dim_value if item.HasField("dim_value") else None)
    return {"name": value.name, "dtype": onnx.TensorProto.DataType.Name(kind.elem_type), "shape": shape}


def inspect_graph(path):
    import onnx
    graph = onnx.load_model(str(path), load_external_data=False).graph
    tensor_examples, node_examples, layer_ids = {}, {}, set()
    for value in graph.initializer:
        matched = re.search(r"((?:.+\.)?transformer\.layers\.(\d+))\.", value.name)
        if matched:
            layer = int(matched.group(2))
            layer_ids.add(layer)
            if layer in {0, 5, 6, 23} and len(tensor_examples.setdefault(str(layer), [])) < 4:
                tensor_examples[str(layer)].append({"name": value.name, "shape": list(value.dims),
                                                   "dtype": onnx.TensorProto.DataType.Name(value.data_type)})
    for node in graph.node:
        for layer in (0, 5, 6, 23):
            if re.search(r"layers[./]" + str(layer) + r"(?:[./]|$)", node.name):
                if len(node_examples.setdefault(str(layer), [])) < 3:
                    node_examples[str(layer)].append({"name": node.name, "op_type": node.op_type,
                                                     "inputs": list(node.input), "outputs": list(node.output)})
    inputs = [value_info(value, onnx) for value in graph.input]
    states = inputs[2:]
    pairs = []
    for position in range(0, len(states) - 1, 2):
        cache, offset = states[position:position + 2]
        matches = (cache["dtype"] == "FLOAT" and len(cache["shape"]) == 5 and cache["shape"][0] == 2
                   and offset["dtype"] == "INT64" and offset["shape"] == [1])
        pairs.append({"cache": cache["name"], "offset": offset["name"], "matches_primary_attention_state_layout": matches})
    return {"file_sha256": base.digest(path), "inputs": inputs,
            "outputs": [value_info(value, onnx) for value in graph.output],
            "strict_transformer_layer_ids_from_initializer_prefixes": sorted(layer_ids),
            "representative_initializers": tensor_examples, "representative_nodes": node_examples,
            "state_input_count": len(states), "consecutive_cache_offset_pairs": pairs,
            "all_state_pairs_match_one_primary_attention_cache_and_offset":
                len(states) > 0 and len(states) % 2 == 0 and all(row["matches_primary_attention_state_layout"] for row in pairs)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.report.resolve().is_relative_to(args.cache.resolve()):
        parser.error("Report must be outside model inputs")
    if args.report.exists() or args.report.is_symlink():
        parser.error("Refusing to replace an existing inspection report")
    result = {"format": "dordiai-afri-export-checkpoint-inspection-v1", "status": "running",
              "model_revision": base.MODEL_REVISION, "full_checkpoint_executed": False, "product_integrated": False}
    base.write_json(args.report, result, overwrite=False)
    try:
        index = json.loads((args.cache / "source-index.json").read_text(encoding="utf-8"))
        if index.get("revision") != base.MODEL_REVISION:
            raise ValueError("Wrong native-proof model cache revision")
        lm = index["files"]["lm_main"]
        if not base.verify_file(lm["path"], lm):
            raise ValueError("Cached LMmain differs from its immutable pin")
        metadata = base.read_json_url(f"https://huggingface.co/api/models/{base.MODEL_REPO}/revision/{base.MODEL_REVISION}?blobs=true")
        if metadata.get("sha") != base.MODEL_REVISION:
            raise ValueError("Wrong immutable checkpoint metadata revision")
        siblings = {row["rfilename"]: row for row in metadata["siblings"]}
        checkpoint = base.artifact_record(siblings["model.safetensors"])
        url = f"https://huggingface.co/{base.MODEL_REPO}/resolve/{base.MODEL_REVISION}/model.safetensors"
        result["original_checkpoint"] = checkpoint_header(checkpoint, url)
        result["original_fp32_export_inputs"] = {
            name: dict(base.artifact_record(siblings[name]),
                       url=f"https://huggingface.co/{base.MODEL_REPO}/resolve/{base.MODEL_REVISION}/{name}")
            for name in ("model.safetensors", "config.yaml", "tokenizer.json")}
        config = next(row for row in index["files"].values() if row.get("repository_path") == "config.yaml")
        if not base.verify_file(config["path"], config):
            raise ValueError("Cached original config differs")
        result["original_config_yaml"] = Path(config["path"]).read_text(encoding="utf-8")
        result["network_guard_before_graph_inspection"] = base.deny_native_network()
        result["published_onnx_lm_main"] = inspect_graph(lm["path"])
        result["primary_state_layout_sources"] = {
            "exporter_commit": base.SOURCE_REVISION,
            "exporter_path": "export/onnx/export_onnx.py",
            "attention_init": "offset:int64[batch] plus cache:float32[2,batch,capacity,kv_heads,head_dim]",
            "make_state": "one flattened entry for each StatefulModule.init_state item, sorted by key",
            "pocket_tts_source": "a922b912dfa366975294afb568d815b305acde5d",
            "transformer_path": "pocket_tts/modules/transformer.py",
            "transformer_structure": "ModuleList of num_layers StreamingTransformerLayer; one self_attn per layer",
            "sherpa_source": base.SHERPA_REVISION,
            "sherpa_path": "sherpa-onnx/csrc/offline-tts-pocket-model.cc",
            "sherpa_state_layout": "opaque input states after first two graph inputs; no assumed four-state block layout"}
        result["status"] = "inspected-metadata-only"
        base.write_json(args.report, result)
        print(json.dumps({"status": result["status"],
                          "checkpoint_lm_layer_ids": result["original_checkpoint"]["strict_flow_lm_layer_ids"],
                          "onnx_strict_layer_ids": result["published_onnx_lm_main"]["strict_transformer_layer_ids_from_initializer_prefixes"],
                          "onnx_states": result["published_onnx_lm_main"]["state_input_count"]}), flush=True)
        return 0
    except Exception as error:
        result.update(status="failed", error_type=type(error).__name__, error=str(error))
        base.write_json(args.report, result)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
