"""Isolated exact-weight MMS shared-graph experiment; never changes the addon.

The original model files remain byte-for-byte intact. One initializer-free
graph consumes per-language float32 views into read-only memory-mapped ONNX
files. A mathematical graph fingerprint, every weight name/type/shape, the
original pinned file hash, and native embedding bounds are checked first.
"""
from __future__ import annotations
import argparse
import gc
from hashlib import sha256
import json
import math
import mmap
import os
from pathlib import Path
import statistics
import subprocess
import sys
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
DEFAULT_MODELS = ROOT / "model-packs/mms/kx47Runtime/models/MMS"
EMBEDDING = "model.enc_p.emb.weight"
INPUTS = {"x", "x_length", "noise_scale", "length_scale", "noise_scale_w"}


def digest(path):
    value = sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def read_varint(buffer, position, end):
    value = 0
    for shift in range(0, 70, 7):
        if position >= end:
            raise ValueError("Truncated ONNX protobuf varint")
        byte = buffer[position]
        position += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, position
    raise ValueError("Invalid ONNX protobuf varint")


def fields(buffer, start, end):
    position = start
    while position < end:
        tag, position = read_varint(buffer, position, end)
        number, kind = tag >> 3, tag & 7
        if number == 0:
            raise ValueError("Invalid ONNX protobuf field")
        if kind == 0:
            value, position = read_varint(buffer, position, end)
            yield number, kind, value, position
            continue
        if kind == 2:
            size, position = read_varint(buffer, position, end)
        elif kind in (1, 5):
            size = 8 if kind == 1 else 4
        else:
            raise ValueError("Unsupported ONNX protobuf wire type")
        stop = position + size
        if stop > end:
            raise ValueError("ONNX protobuf field exceeds file bounds")
        yield number, kind, position, stop
        position = stop


def tensor_offsets(path):
    """Locate TensorProto.raw_data directly; do not copy or rewrite weights."""
    records = []
    with path.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as buffer:
        graphs = [(start, end) for number, kind, start, end in fields(buffer, 0, len(buffer)) if number == 7 and kind == 2]
        if len(graphs) != 1:
            raise ValueError("Expected one native ONNX graph")
        for number, kind, start, end in fields(buffer, *graphs[0]):
            if number != 5 or kind != 2:
                continue
            name, dtype, shape, raw = None, None, [], None
            for field, wire, low, high in fields(buffer, start, end):
                if field == 1:
                    if wire == 0:
                        shape.append(low)
                    elif wire == 2:
                        while low < high:
                            dimension, low = read_varint(buffer, low, high)
                            shape.append(dimension)
                elif field == 2 and wire == 0:
                    dtype = low
                elif field == 8 and wire == 2:
                    name = buffer[low:high].decode("utf-8")
                elif field == 9 and wire == 2:
                    raw = (low, high - low)
            if (name is None or dtype != 1 or raw is None or any(not 0 < x <= 1000000 for x in shape)
                    or raw[1] != math.prod(shape) * 4):
                raise ValueError("Prototype accepts only complete raw float32 MMS initializers")
            records.append({"name": name, "offset": raw[0], "bytes": raw[1], "dtype": "<f4", "shape": shape})
    if len({row["name"] for row in records}) != len(records):
        raise ValueError("Duplicate MMS initializer names")
    return records


def graph_fingerprint(model):
    import onnx
    copy = onnx.ModelProto()
    copy.CopyFrom(model)
    copy.graph.ClearField("initializer")
    copy.ClearField("metadata_props")
    copy.doc_string = copy.graph.doc_string = ""
    return sha256(copy.SerializeToString(deterministic=True)).hexdigest()


def check_shapes(reference, actual):
    if [x["name"] for x in actual] != [x["name"] for x in reference]:
        raise ValueError("MMS initializer names/order differ")
    for base, row in zip(reference, actual):
        shape = row["shape"]
        if row["dtype"] != "<f4" or base["dtype"] != "<f4":
            raise ValueError("MMS initializer dtype differs")
        if row["name"] == EMBEDDING:
            if len(shape) != 2 or not 1 <= shape[0] <= 4096 or shape[1] != 192:
                raise ValueError("Invalid native vocabulary embedding shape")
        elif shape != base["shape"]:
            raise ValueError("Non-vocabulary MMS weight shape differs: " + row["name"])


def build(models, output, codes):
    import onnx
    if output.resolve().is_relative_to(models.resolve()):
        raise ValueError("Prototype output must be outside the immutable model resources")
    output.mkdir(parents=True, exist_ok=True)
    source = json.loads((ROOT / "tools/mms_model_sources.json").read_text(encoding="utf-8"))
    reference, reference_hash, skeleton, entries = None, None, None, {}
    family_scan = {}
    for code in codes:
        path = models / code / "model.onnx"
        expected = source["models"][code]["assets"]["model.onnx"]
        actual_hash = digest(path)
        if actual_hash != expected["sha256"] or path.stat().st_size != expected["bytes"]:
            raise ValueError("Original MMS model differs from the pinned source: " + code)
        model = onnx.load(path, load_external_data=False)
        meta = {item.key: item.value for item in model.metadata_props}
        if (meta.get("comment") != "mms" or meta.get("frontend") != "characters" or meta.get("sample_rate") != "16000"
                or {x.name for x in model.graph.input} != INPUTS):
            raise ValueError("Not the selected native MMS graph family")
        rows = tensor_offsets(path)
        fingerprint = graph_fingerprint(model)
        if reference is None:
            reference, reference_hash = rows, fingerprint
            # The sole variable initializer dimension belongs to this exact
            # Gather(axis=0) vocabulary table; no other dimensions may vary.
            consumers = [node for node in model.graph.node if EMBEDDING in node.input]
            if (len(consumers) != 1 or consumers[0].op_type != "Gather"
                    or list(consumers[0].input) != [EMBEDDING, "x"]
                    or any(a.name == "axis" and a.i != 0 for a in consumers[0].attribute)):
                raise ValueError("Embedding is not the audited native Gather(axis=0)")
            model.graph.ClearField("initializer")
            for row in rows:
                shape = ["native_vocab_rows", 192] if row["name"] == EMBEDDING else row["shape"]
                model.graph.input.append(onnx.helper.make_tensor_value_info(row["name"], onnx.TensorProto.FLOAT, shape))
            skeleton = model
        else:
            if fingerprint != reference_hash:
                raise ValueError("MMS mathematical graph differs: " + code)
            check_shapes(reference, rows)
        entries[code] = {"path": str(path.resolve()), "bytes": path.stat().st_size, "sha256": actual_hash,
                         "graph_fingerprint": fingerprint, "weights": rows,
                         "native_vocab_rows": next(row["shape"][0] for row in rows if row["name"] == EMBEDDING)}
        family_scan[code] = {"fingerprint": fingerprint, "weight_count": len(rows), "native_vocab_rows": entries[code]["native_vocab_rows"]}
        if skeleton is not model:
            del model
        gc.collect()
    path = output / "shared-graph.onnx"
    # The pinned exporter left its diagnostic durations output untyped; ORT
    # accepts it, while the ONNX checker correctly rejects the metadata defect.
    # Infer and copy only the missing output type, leaving every node unchanged.
    inferred = onnx.shape_inference.infer_shapes(skeleton)
    annotated_outputs = []
    for original, typed in zip(skeleton.graph.output, inferred.graph.output):
        if not original.HasField("type"):
            if not typed.HasField("type"):
                raise ValueError("Could not infer the original diagnostic output type")
            original.type.CopyFrom(typed.type)
            annotated_outputs.append(original.name)
    onnx.checker.check_model(skeleton)
    onnx.save_model(skeleton, path)
    mutated = json.loads(json.dumps(reference))
    next(row for row in mutated if row["name"] != EMBEDDING)["shape"][0] += 1
    try:
        check_shapes(reference, mutated)
    except ValueError:
        shape_guard = True
    else:
        raise AssertionError("Invalid non-vocabulary shape was accepted")
    mutated_model = onnx.ModelProto()
    mutated_model.CopyFrom(skeleton)
    mutated_model.graph.node[0].op_type = "Identity"
    topology_guard = graph_fingerprint(mutated_model) != graph_fingerprint(skeleton)
    if not topology_guard:
        raise AssertionError("Changed graph topology was accepted")
    index = {"format": "dordiai-mms-shared-graph-prototype-v1", "shared_graph": str(path.resolve()),
             "shared_graph_sha256": digest(path), "shared_graph_bytes": path.stat().st_size,
             "original_family_fingerprint": reference_hash, "initializer_count": len(reference), "models": entries,
             "metadata_only_output_annotations": annotated_outputs,
             "family_scan": family_scan, "guards": {"non_vocabulary_shape_rejected": shape_guard,
                                                       "changed_topology_rejected": topology_guard}}
    (output / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return index


def memory():
    result = {}
    for line in Path("/proc/self/smaps_rollup").read_text().splitlines():
        key, _, value = line.partition(":")
        if key in {"Rss", "Pss", "Private_Clean", "Private_Dirty", "Shared_Clean", "Shared_Dirty", "Anonymous"}:
            result[key + "_bytes"] = int(value.split()[0]) * 1024
    return result


def settings(ort, optimization):
    options = ort.SessionOptions()
    options.intra_op_num_threads, options.inter_op_num_threads = 2, 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.log_severity_level = 3
    if optimization == "disabled":
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    return options


class SharedWeights:
    def __init__(self, session, entry):
        import numpy as np
        path = Path(entry["path"])
        if path.stat().st_size != entry["bytes"] or digest(path) != entry["sha256"]:
            raise ValueError("MMS model changed since family validation")
        actual = tensor_offsets(path)
        if actual != entry["weights"]:
            raise ValueError("MMS mmap descriptor differs from the actual pinned TensorProto fields")
        graph_inputs = {item.name: item for item in session.get_inputs() if item.name not in INPUTS}
        if set(graph_inputs) != {row["name"] for row in actual}:
            raise ValueError("MMS graph does not match the supplied native weight names")
        for row in actual:
            node = graph_inputs[row["name"]]
            expected = ["native_vocab_rows", 192] if row["name"] == EMBEDDING else row["shape"]
            if node.type != "tensor(float)" or node.shape != expected:
                raise ValueError("MMS graph weight shape/type differs from its guarded family")
        if entry["native_vocab_rows"] != next(row["shape"][0] for row in actual if row["name"] == EMBEDDING):
            raise ValueError("Native vocabulary bound differs from its real embedding")
        self.session = session
        self.mapping = np.memmap(path, dtype=np.uint8, mode="r")
        self.weights = {row["name"]: np.ndarray(row["shape"], dtype=row["dtype"], buffer=self.mapping, offset=row["offset"])
                        for row in entry["weights"]}
        self.entry = entry
    def run(self, values):
        x = values["x"]
        if x.dtype.name != "int64" or x.ndim != 2 or x.size == 0 or int(x.min()) < 0 or int(x.max()) >= self.entry["native_vocab_rows"]:
            raise ValueError("Native text IDs exceed this language's actual vocabulary")
        if set(values) != INPUTS:
            raise ValueError("Unexpected shared MMS inference inputs")
        return self.session.run(None, self.weights | values)[0].reshape(-1)


def feed(folder, text, speed=1.):
    import numpy as np
    from wide_mms import MMSFrontend, read_tokens
    config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
    ids = MMSFrontend(config, read_tokens(folder / "tokens.txt")).ids(text)
    return {"x": np.asarray([ids], np.int64), "x_length": np.asarray([len(ids)], np.int64),
            "noise_scale": np.asarray([0.], np.float32), "length_scale": np.asarray([1. / speed], np.float32),
            "noise_scale_w": np.asarray([0.], np.float32)}


def worker(args):
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1")
    sys.path.insert(0, str(RUNTIME))
    import numpy as np
    import onnxruntime as ort
    if ort.__version__ != "1.27.0":
        raise ValueError("This isolated experiment requires safe ONNX Runtime1.27.0")
    ort.disable_telemetry_events()
    index = json.loads((args.output / "index.json").read_text(encoding="utf-8"))
    if digest(Path(index["shared_graph"])) != index["shared_graph_sha256"]:
        raise ValueError("Shared MMS graph changed after validation")
    codes = args.languages.split(",")
    texts = {"ha": ["sannu", "Ina kwana?"], "so": ["salaan", "Subax wanaagsan."], "yo": ["bawo", "Bawo ni?"]}
    values = {(code, item): feed(args.models / code, text) for code in codes for item, text in enumerate(texts[code])}
    before = memory()
    sessions, opened = {}, []
    shared = None
    if args.mode.startswith("shared"):
        started = perf_counter()
        shared = ort.InferenceSession(index["shared_graph"], sess_options=settings(ort, args.optimization), providers=["CPUExecutionProvider"])
        opened.append({"scope": "one-shared-graph", "seconds": perf_counter() - started})
    def activate(code):
        if code in sessions:
            return
        started = perf_counter()
        if shared is not None:
            sessions[code] = SharedWeights(shared, index["models"][code])
        else:
            sessions[code] = ort.InferenceSession(str(args.models / code / "model.onnx"),
                sess_options=settings(ort, args.optimization), providers=["CPUExecutionProvider"])
        opened.append({"scope": code, "seconds": perf_counter() - started})
    if not args.switch_on_demand:
        for code in codes:
            activate(code)
    after_open = memory()
    def render(code, item):
        activate(code)
        if shared is not None:
            return sessions[code].run(values[code, item])
        return sessions[code].run(None, values[code, item])[0].reshape(-1)
    cold, outputs = [], args.output / args.mode
    outputs.mkdir(parents=True, exist_ok=True)
    for code in codes:
        for item in range(2):
            started = perf_counter(); audio = render(code, item); seconds = perf_counter() - started
            if len(audio) < 32 or not np.isfinite(audio).all() or np.max(np.abs(audio)) < .001:
                raise ValueError("Invalid actual native PCM")
            np.save(outputs / (code + str(item) + ".npy"), audio, allow_pickle=False)
            cold.append({"code": code, "item": item, "seconds": seconds, "samples": len(audio), "text": texts[code][item]})
    warm = []
    for code in codes:
        for repeat in range(args.repeats):
            started = perf_counter(); audio = render(code, 0); seconds = perf_counter() - started
            warm.append({"code": code, "repeat": repeat, "seconds": seconds, "samples": len(audio)})
    alternating = []
    for repeat in range(args.repeats):
        for code in codes:
            started = perf_counter(); audio = render(code, 0); seconds = perf_counter() - started
            alternating.append({"code": code, "repeat": repeat, "seconds": seconds, "samples": len(audio)})
    guard_checks = {}
    if shared is not None:
        code = codes[0]
        damaged = json.loads(json.dumps(index["models"][code]))
        damaged["weights"][0]["offset"] += 4
        try:
            SharedWeights(shared, damaged)
        except ValueError:
            guard_checks["tampered_weight_offset_rejected"] = True
        else:
            raise AssertionError("Tampered mmap offset was accepted")
        bad = dict(values[code, 0])
        bad["x"] = np.asarray([[index["models"][code]["native_vocab_rows"]]], np.int64)
        try:
            sessions[code].run(bad)
        except ValueError:
            guard_checks["out_of_native_vocabulary_id_rejected"] = True
        else:
            raise AssertionError("Out-of-range native vocabulary ID was accepted")
    result = {"mode": args.mode, "onnxruntime": ort.__version__, "runtime_module": str(ort.__file__),
              "thread_count": 2, "optimization": args.optimization, "original_weights_unchanged": True,
              "switch_on_demand": args.switch_on_demand,
              "strict_original_tensor_descriptor_and_ort_shape_revalidation": shared is not None,
              "guard_checks": guard_checks,
              "before": before, "after_open": after_open, "after_inference": memory(),
              "opened": opened, "cold": cold, "warm": warm, "alternating": alternating}
    (args.output / (args.mode + ".json")).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"mode": args.mode, "open_seconds": sum(row["seconds"] for row in opened),
                      "warm_median_seconds": statistics.median(row["seconds"] for row in warm),
                      "rss_after_inference": result["after_inference"]["Rss_bytes"]}), flush=True)


def parity(first, second):
    import numpy as np
    if first.dtype != np.float32 or second.dtype != np.float32 or first.shape != second.shape:
        raise ValueError("Native MMS parity requires identical float32 sample dimensions")
    if not np.isfinite(first).all() or not np.isfinite(second).all():
        raise ValueError("Nonfinite samples in MMS parity comparison")
    pcm_first = np.rint(np.clip(first, -1, 1) * 32767).astype(np.int16)
    pcm_second = np.rint(np.clip(second, -1, 1) * 32767).astype(np.int16)
    difference = np.abs(pcm_first.astype(np.int32) - pcm_second.astype(np.int32))
    x, y = first.astype(np.float64), second.astype(np.float64)
    return {"samples": len(first), "float32_bitwise_equal": bool(np.array_equal(first, second)),
            "max_float_error": float(np.max(np.abs(x - y))),
            "cosine": float(np.dot(x, y) / (np.linalg.norm(x) * np.linalg.norm(y))),
            "pcm16_bitwise_equal": bool(np.array_equal(pcm_first, pcm_second)),
            "pcm16_different_samples": int(np.count_nonzero(difference)),
            "pcm16_max_lsb_difference": int(np.max(difference))}


def conversion_probe(args):
    """Pass the measured native arrays through the actual existing projection."""
    import numpy as np
    import onnxruntime as ort
    from types import SimpleNamespace
    if ort.__version__ != "1.27.0":
        raise ValueError("Projection probe requires safe ONNX Runtime1.27.0")
    ort.disable_telemetry_events()
    sys.path.insert(0, str(RUNTIME))
    from converted_voices import resample
    from wide_voice import WideVoices
    from voice_policy import require_voice_allowed
    require_voice_allowed("viktoriia")
    baseline = ROOT / "packages/0.12.2/kx47Runtime/models"
    started = perf_counter()
    flow = ort.InferenceSession(str(baseline / "OpenVoiceV2/encoder-flow.onnx"),
                               sess_options=settings(ort, "default"), providers=["CPUExecutionProvider"])
    decoder = ort.InferenceSession(str(baseline / "OpenVoiceV2/decoder.onnx"),
                                  sess_options=settings(ort, "default"), providers=["CPUExecutionProvider"])
    load_seconds = perf_counter() - started
    context = SimpleNamespace(owner=SimpleNamespace(check_cancelled=lambda: None),
                              converter=SimpleNamespace(flow=flow, decoder=decoder))
    target_path = baseline / "voices/viktoriia.npy"
    target = np.load(target_path, allow_pickle=False)
    if target.shape != (1, 256, 1) or not np.isfinite(target).all():
        raise ValueError("Invalid actual selected-speaker embedding")
    results = []
    for code in args.languages.split(","):
        source_path = args.models / code / "source.npy"
        source = np.load(source_path, allow_pickle=False)
        projected, timings = {}, {}
        for mode in ("original", "shared"):
            native = np.load(args.output / mode / (code + "0.npy"), allow_pickle=False)
            audio = resample(native, 16000, 22050)
            started = perf_counter()
            projected[mode] = np.concatenate(list(WideVoices.converted(context, audio, source, target, character=True)))
            timings[mode] = perf_counter() - started
        row = {"code": code, "target": "viktoriia", "source_sha256": digest(source_path),
               "target_sha256": digest(target_path), "seconds": timings,
               "parity": parity(projected["original"], projected["shared"])}
        results.append(row)
    report = {"scope": "actual WideVoices.converted with original OpenVoice flow/decoder and allowed target embedding",
              "converter_model_hashes": {"flow": digest(baseline / "OpenVoiceV2/encoder-flow.onnx"),
                                         "decoder": digest(baseline / "OpenVoiceV2/decoder.onnx")},
              "graph_load_seconds": load_seconds, "languages": results,
              "nvda_or_audio_device_verified": False}
    (args.output / "conversion.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"conversion_languages": len(results), "parity": [x["parity"] for x in results]}), flush=True)
    return report


def describe(rows):
    values = sorted(row["seconds"] for row in rows)
    return {"count": len(values), "median_seconds": statistics.median(values),
            "p95_seconds": values[min(len(values) - 1, math.ceil(len(values) * .95) - 1)],
            "minimum_seconds": values[0], "maximum_seconds": values[-1]}


def analyze(args):
    import numpy as np
    index = json.loads((args.output / "index.json").read_text(encoding="utf-8"))
    names = ("original", "shared", "original-disabled", "shared-disabled", "original-repeat", "shared-repeat",
             "original-ondemand", "shared-ondemand")
    runs = {name: json.loads((args.output / (name + ".json")).read_text(encoding="utf-8")) for name in names}
    comparisons = []
    valid = True
    for code in args.languages.split(","):
        for item in range(2):
            first = np.load(args.output / "original" / (code + str(item) + ".npy"), allow_pickle=False)
            second = np.load(args.output / "shared" / (code + str(item) + ".npy"), allow_pickle=False)
            row = dict(code=code, item=item, **parity(first, second))
            # Predeclared tight numerical guard: identical length, max float
            # difference<=1e-6 and at most one PCM16 least-significant bit.
            valid = valid and row["max_float_error"] <= 1e-6 and row["pcm16_max_lsb_difference"] <= 1
            comparisons.append(row)
    summaries = {name: {"open_seconds": sum(row["seconds"] for row in value["opened"]),
                        "warm": describe(value["warm"]), "alternating": describe(value["alternating"]),
                        "rss_after_inference": value["after_inference"]["Rss_bytes"],
                        "anonymous_after_inference": value["after_inference"]["Anonymous_bytes"]}
                 for name, value in runs.items()}
    pairs = [("original", "shared"), ("original-repeat", "shared-repeat")]
    no_measured_slowdown = all(summaries[shared][metric]["median_seconds"] <= summaries[original][metric]["median_seconds"]
                               for original, shared in pairs for metric in ("warm", "alternating"))
    per_language = {}
    for code in args.languages.split(","):
        per_language[code] = {}
        for metric in ("warm", "alternating"):
            normal = [row for name in ("original", "original-repeat") for row in runs[name][metric] if row["code"] == code]
            shared = [row for name in ("shared", "shared-repeat") for row in runs[name][metric] if row["code"] == code]
            first, second = describe(normal), describe(shared)
            per_language[code][metric] = {"original": first, "shared": second,
                "median_ratio_shared_over_original": second["median_seconds"] / first["median_seconds"]}
    no_language_median_regression = all(row[metric]["median_ratio_shared_over_original"] <= 1.
                                         for row in per_language.values() for metric in ("warm", "alternating"))
    switches = {}
    for code in args.languages.split(","):
        normal = next(row["seconds"] for row in runs["original-ondemand"]["cold"] if row["code"] == code and row["item"] == 0)
        shared = next(row["seconds"] for row in runs["shared-ondemand"]["cold"] if row["code"] == code and row["item"] == 0)
        switches[code] = {"original_activate_and_first_word_seconds": normal,
                          "shared_activate_and_first_word_seconds": shared,
                          "shared_common_graph_setup_excluded_seconds": next(row["seconds"] for row in runs["shared-ondemand"]["opened"] if row["scope"] == "one-shared-graph")}
    report = {"format": "dordiai-mms-shared-graph-research-v1", "status": "prototype-only-not-integrated",
              "production_files_changed": False, "models_quantized_or_retrained": False,
              "graph_bytes": index["shared_graph_bytes"], "graph_sha256": index["shared_graph_sha256"],
              "original_family_fingerprint": index["original_family_fingerprint"], "initializer_count": index["initializer_count"],
              "metadata_only_output_annotations": index["metadata_only_output_annotations"],
              "guards": index["guards"], "family_scan": index["family_scan"],
              "pinned_models": {code: {k: row[k] for k in ("sha256", "bytes", "native_vocab_rows")}
                                for code, row in index["models"].items()},
              "environment": {"onnxruntime": "1.27.0", "threads": 2, "fresh_process_per_case": True,
                              "model_file_disk_cache": "OS cache was not flushed; cold means fresh ORT session, not cold disk",
                              "RSS_note": "File-backed mappings remain resident after touching weights; anonymous bytes measure non-reclaimable heap separately."},
              "native_parity": comparisons, "native_numerical_guard_passed": valid,
              "native_waveform_always_bit_identical": all(row["float32_bitwise_equal"] for row in comparisons),
              "repeat_pairs_have_no_measured_median_slowdown": no_measured_slowdown,
              "combined_each_language_has_no_measured_median_slowdown": no_language_median_regression,
              "per_language_combined_fresh_process_pairs": per_language,
              "actual_on_demand_switches": switches,
              "summaries": summaries, "raw_fresh_process_measurements": runs,
              "decision": "candidate-for-separate-reviewed-integration" if valid and no_measured_slowdown and no_language_median_regression else "reject-or-further-investigate",
              "scope_limits": ["Three actual native languages measured, not all29 language pronunciation or NVDA behavior.",
                               "Zero-noise validation; production stochastic settings need independent guard tests.",
                               "Yoruba has tiny numerical rounding differences; exact float/PCM equality is reported per sample.",
                               "Shared graph does not share or shrink trained weights; no600-language size claim.",
                               "Concurrency, cancellation, resource replacement and memory pressure are not production-validated."]}
    conversion = args.output / "conversion.json"
    if conversion.is_file():
        report["actual_selected_voice_conversion"] = json.loads(conversion.read_text(encoding="utf-8"))
        converted_ok = all(row["parity"]["max_float_error"] <= 1e-6 and row["parity"]["pcm16_max_lsb_difference"] <= 1
                           for row in report["actual_selected_voice_conversion"]["languages"])
        report["converted_numerical_guard_passed"] = converted_ok
        if not converted_ok:
            report["decision"] = "reject-or-further-investigate"
    guarded = args.output / "shared-final-guarded.json"
    if guarded.is_file():
        report["final_guarded_descriptor_validation"] = json.loads(guarded.read_text(encoding="utf-8"))
    all_family = args.output.parent / "mms-family-prototype-all29/index.json"
    if all_family.is_file():
        all_index = json.loads(all_family.read_text(encoding="utf-8"))
        if all_index["original_family_fingerprint"] == index["original_family_fingerprint"]:
            report["additional_read_only_all29_family_scan"] = all_index["family_scan"]
    target = ROOT / "evidence/mms_shared_graph_research.json"
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(target), "decision": report["decision"], "native_guard_passed": valid,
                      "no_measured_median_slowdown": no_measured_slowdown}), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", type=Path, default=DEFAULT_MODELS)
    parser.add_argument("--output", type=Path, default=ROOT / "downloads/mms-family-prototype")
    parser.add_argument("--languages", default="ha,so,yo")
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--conversion", action="store_true")
    parser.add_argument("--analyze", action="store_true")
    parser.add_argument("--run-all", action="store_true")
    parser.add_argument("--mode", default="original")
    parser.add_argument("--optimization", choices=["default", "disabled"], default="default")
    parser.add_argument("--switch-on-demand", action="store_true")
    args = parser.parse_args()
    if args.run_all:
        build(args.models, args.output, args.languages.split(","))
        variants = [("original", "default", False, args.repeats), ("shared", "default", False, args.repeats),
                    ("original-disabled", "disabled", False, args.repeats), ("shared-disabled", "disabled", False, args.repeats),
                    ("original-repeat", "default", False, args.repeats + 3), ("shared-repeat", "default", False, args.repeats + 3),
                    ("original-ondemand", "default", True, 2), ("shared-ondemand", "default", True, 2)]
        for name, optimization, on_demand, repeats in variants:
            command = [sys.executable, str(Path(__file__).resolve()), "--worker", "--mode", name,
                       "--optimization", optimization, "--repeats", str(repeats), "--output", str(args.output),
                       "--models", str(args.models), "--languages", args.languages]
            if on_demand:
                command.append("--switch-on-demand")
            subprocess.run(command, check=True)
        conversion_probe(args)
        analyze(args)
    elif args.build:
        index = build(args.models, args.output, args.languages.split(","))
        print(json.dumps({"graph_bytes": index["shared_graph_bytes"], "languages": len(index["models"]), "guards": index["guards"]}), flush=True)
    elif args.worker:
        worker(args)
    elif args.conversion:
        conversion_probe(args)
    elif args.analyze:
        analyze(args)
    else:
        parser.error("Select --build or --worker; benchmark cases run in separate fresh processes")


if __name__ == "__main__":
    main()
