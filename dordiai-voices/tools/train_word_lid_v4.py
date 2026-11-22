#!/usr/bin/env python3
"""Train/evaluate an UNINSTALLED candidate from frozen v2 + v3 source artifacts.

All new outputs are confined to a newly created owned directory. Calibration uses
validation only; final-test results are never inputs to a fitting decision.
Source labels are weak membership evidence, not native quality or author intent.
"""
from array import array
from collections import Counter, defaultdict
import argparse
import base64
import gzip
from hashlib import sha1, sha256
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ROLES = {"train": 0, "validation": 1, "test": 2}
V2_CORPUS_SHA256 = "69372e3b5f5e76e4b5ab2dd568eea14575ea6586ae8f02ccbcdcccb92ac37859"
V3_CORPUS_SHA256 = "7fb87609dcd5034d0df7a429feb1c23173d72cf0fbdb8dc563661dd0d1ff96f6"
V3_REPORT_GIT_BLOB = "79a2fd02459f87b643e5531a761c7444783a9c76"
TRAINER_GIT_BLOB = "407515f23d87acf9e74fb125ccaadc3177634c3a"
RUNTIME_GIT_BLOB = "3cfaa50156333e12950e6fec98d39c4eabf289b8"
EVALUATOR_GIT_BLOB = "3dd63a1cfd1a67e15ab7256e517acc4ff6556f29"
THRESHOLDS = (.5, .6, .7, .8, .85, .9, .92, .95, .97, .98, .99, .995, .999, 1.)
MINIMUM_WORDS = 100
MINIMUM_CALIBRATION = 200
TARGET_PRECISION = .98
# Additional conservative evidence gate; empirical precision is still reported.
MINIMUM_WILSON_LOWER = .95


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def digest(path):
    state = sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            state.update(block)
    return state.hexdigest()


def git_blob(raw):
    return sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()


def pinned_module(path, expected, name):
    if git_blob(Path(path).read_bytes()) != expected:
        raise ValueError("Pinned preparation/evaluation source differs: " + Path(path).name)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def output_directory(path, inputs=()):
    path = Path(path).absolute()
    if path.exists() or path.is_symlink():
        raise FileExistsError("Candidate output directory must be new")
    for parent in (path, *path.parents):
        if parent.exists() and (parent.is_symlink() or getattr(parent, "is_junction", lambda: False)()):
            raise ValueError("Linked candidate output path")
    resolved = path.resolve()
    protected = [ROOT / name for name in ("source", "tools", "tests", "training-data", "evidence", "packages")]
    protected.append(ROOT.parent / ".github")
    for item in (*protected, *map(Path, inputs)):
        target = item.resolve()
        if resolved == target or resolved in target.parents or target in resolved.parents:
            raise ValueError("Candidate output overlaps protected inputs")
    return path


def load_v3(path, report_path, manifest_path, runtime, split_word):
    """Explicit v3 decoder: publisher roles survive; pilot split is only audited."""
    path, report_path, manifest_path = map(Path, (path, report_path, manifest_path))
    if digest(path) != V3_CORPUS_SHA256:
        raise ValueError("Frozen v3 corpus checksum differs")
    raw_report = report_path.read_bytes()
    if git_blob(raw_report) != V3_REPORT_GIT_BLOB:
        raise ValueError("Frozen v3 acquisition report differs")
    report = json.loads(raw_report)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (report.get("format") != "dordiai-word-lid-native-pilot-v3"
            or report.get("status") != "acquired-not-trained"
            or report.get("model_trained") is not False or report.get("model_installed") is not False
            or report.get("insufficient_labels") != []
            or report.get("corpus_lock_sha256") != digest(manifest_path)
            or report.get("corpus", {}).get("sha256") != V3_CORPUS_SHA256
            or report.get("corpus", {}).get("size_bytes") != path.stat().st_size):
        raise ValueError("Frozen v3 corpus/acquisition provenance differs")
    locked = {row["id"]: row for row in manifest["sources"] if row.get("pilot") is True}
    receipts = report.get("source_receipts")
    if (not isinstance(receipts, list) or {row.get("id") for row in receipts} != set(locked)
            or len(receipts) != len(locked)):
        raise ValueError("Missing or duplicate v3 pinned source receipts")
    for receipt in receipts:
        source = locked[receipt["id"]]
        keys = ("language", "source_language", "revision", "url", "license", "license_url", "attribution", "sha256")
        if any(receipt.get(key) != source.get(key) for key in keys):
            raise ValueError("V3 receipt differs from a pinned primary source")
        if source.get("bytes") is not None and receipt.get("bytes") != source["bytes"]:
            raise ValueError("V3 source byte count differs")
    allowed = set(manifest["pilot_languages"])
    corpus, overrides, previous = {}, {}, None
    stats = {code: Counter() for code in allowed}
    native_counts = {code: Counter() for code in allowed}
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        header = json.loads(stream.readline(1024 * 1024))
        if (header.get("format") != "dordiai-word-lid-native-pilot-v3"
                or header.get("not_consumable_as_current_v2_training_lock") is not True):
            raise ValueError("V3 converter received another corpus format")
        for line in stream:
            if len(line) > 1024 * 1024:
                raise ValueError("V3 spelling row exceeds bound")
            row = json.loads(line)
            word, labels, role = row.get("word"), row.get("labels"), row.get("publisher_role")
            if (not isinstance(word, str) or runtime.normalize_word(word) != word
                    or not runtime.is_valid_word(word) or previous is not None and word <= previous
                    or not isinstance(labels, list) or not labels
                    or any(not isinstance(code, str) or code not in allowed for code in labels)
                    or labels != sorted(set(labels))
                    or role not in ROLES):
                raise ValueError("Invalid v3 spelling, native label or publisher role")
            pilot_split = role if role != "train" else split_word(word)
            if row.get("effective_pilot_split") != pilot_split:
                raise ValueError("V3 original pilot partition does not reproduce")
            family = runtime.actual_native_family(word)
            for code in labels:
                rows = [source for source in locked.values() if source["language"] == code]
                if not any(family in source["native_families"]
                           and runtime.word_script(word) in source["expected_scripts"] for source in rows):
                    raise ValueError("V3 label is incompatible with its actual native-script source")
                native_counts[code][family] += 1
                if len(word) >= 4:
                    stats[code]["effective_" + pilot_split + "_words_min4"] += 1
            corpus[word] = set(labels)
            if role != "train":
                overrides[word] = role
            previous = word
    for code in allowed:
        expected = report["per_language"][code]
        if any(stats[code][key] != expected[key] for key in (
                "effective_train_words_min4", "effective_validation_words_min4", "effective_test_words_min4")):
            raise ValueError("V3 effective split count differs from its actual acquisition receipt")
    return corpus, overrides, {"input_report_git_blob": V3_REPORT_GIT_BLOB,
        "input_corpus_sha256": V3_CORPUS_SHA256, "source_receipts": receipts,
        "native_actual_family_word_counts": {code: dict(sorted(counts.items())) for code, counts in sorted(native_counts.items())}}


def merge_corpora(base, v2, v3, *publisher_maps):
    """Union all labels first; strongest publisher role applies to every label."""
    corpus = v2
    for evidence in (base, v3):
        for word, labels in evidence.items():
            corpus.setdefault(word, set()).update(labels)
    overrides = {}
    for evidence in publisher_maps:
        for word, role in evidence.items():
            if role not in ROLES:
                raise ValueError("Invalid global publisher role")
            if ROLES[role] > ROLES.get(overrides.get(word, "train"), 0):
                overrides[word] = role
    return corpus, overrides


def choose_codes(corpus, assignment, runtime, baseline_codes):
    support = Counter()
    for word, labels in corpus.items():
        if len(word) >= 4 and assignment(word) == "train":
            family = runtime.actual_native_family(word)
            for code in labels:
                support[code, family] += 1
    codes = sorted({code for (code, family), count in support.items()
                    if family is not None and count >= MINIMUM_WORDS})
    missing = set(baseline_codes) - set(codes)
    if missing:
        raise ValueError("Refusing candidate that loses original baseline labels: " + ",".join(sorted(missing)))
    return codes, support


def sample_training(corpus, assignment, runtime, codes, support, cap):
    """Reserve native-family minima, then fill each class's deterministic cap."""
    per_family = defaultdict(list)
    allowed_codes = frozenset(codes)
    for word, labels in corpus.items():
        if assignment(word) != "train":
            continue
        family = runtime.actual_native_family(word)
        for code in labels:
            if code in allowed_codes and support[code, family] >= MINIMUM_WORDS:
                per_family[code, family].append(word)
    selected = set()
    for code in codes:
        groups = [words for (label, _), words in per_family.items() if label == code]
        if len(groups) * MINIMUM_WORDS > cap:
            raise ValueError("Training cap cannot preserve actual native-family minima")
        candidates, chosen = [], set()
        for words in groups:
            words.sort(key=lambda word: sha256(("sample:" + word).encode("utf-8")).digest())
            chosen.update(words[:MINIMUM_WORDS])
            candidates.extend(words[MINIMUM_WORDS:])
        candidates.sort(key=lambda word: sha256(("sample:" + word).encode("utf-8")).digest())
        chosen.update(candidates[:cap-len(chosen)])
        selected.update((word, code) for word in chosen)
    return selected


def wilson_lower(correct, total):
    if not total:
        return 0.
    z = 1.959963984540054
    fraction = correct / total
    return (fraction + z*z/(2*total) - z*math.sqrt(fraction*(1-fraction)/total + z*z/(4*total*total))) / (1+z*z/total)


def calibrate_predicted_classes(records, codes):
    """Labels are consulted ONLY for validation; never change ranking or aliases."""
    by_code = defaultdict(list)
    for code, confidence, support, correct in records:
        if code is not None and support >= .25:
            by_code[code].append((confidence, correct))
    selected, detail = {}, {}
    for code in codes:
        attempts = []
        for threshold in THRESHOLDS:
            taken = [correct for confidence, correct in by_code[code] if confidence >= threshold]
            total, correct = len(taken), sum(taken)
            precision = correct / total if total else None
            lower = wilson_lower(correct, total)
            trusted = (total >= MINIMUM_CALIBRATION and precision >= TARGET_PRECISION
                       and lower >= MINIMUM_WILSON_LOWER)
            attempts.append({"threshold": threshold, "accepted": total, "reference_matches": correct,
                "reference_membership_precision": precision, "wilson95_lower": lower, "passes_validation_gate": trusted})
        passing = [row for row in attempts if row["passes_validation_gate"]]
        # Maximise accepted validation coverage subject to the fixed evidence gate.
        chosen = min(passing, key=lambda row: (-row["accepted"], row["threshold"])) if passing else None
        selected[code] = chosen["threshold"] if chosen else None
        detail[code] = {"selected_threshold": selected[code],
            "status": "validation-calibrated" if chosen else "untrusted-class-abstain",
            "validation_threshold_search": attempts}
    return selected, detail


def with_native_competition_guard(thresholds, calibration, families):
    """Do not accept a shared-script class with no learned native competitor."""
    shared = {"ARABIC", "BENGALI", "DEVANAGARI"}
    competitors = {family: sorted(code for code, values in families.items() if family in values)
                   for family in sorted({family for values in families.values() for family in values})}
    for code, values in families.items():
        missing = [family for family in values if family in shared and len(competitors[family]) < 2]
        if missing:
            thresholds[code] = None
            calibration[code]["selected_threshold"] = None
            calibration[code]["status"] = "untrained-native-script-competitors-abstain"
            calibration[code]["shared_families_without_competitors"] = missing
    return competitors


def write_merged_corpus(path, corpus, overrides, assignment):
    with Path(path).open("xb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as stream:
            stream.write((json.dumps({"format": "dordiai-word-lid-merged-candidate-v4",
                "publisher_priority_applies_globally": True}, sort_keys=True) + "\n").encode("utf-8"))
            for word, labels in sorted(corpus.items()):
                stream.write((json.dumps({"word": word, "labels": sorted(labels),
                    "publisher_role": overrides.get(word, "train"), "split": assignment(word)},
                    ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))


def train_candidate(args):
    paths = (args.v2_corpus, Path(str(args.v2_corpus) + ".receipt.json"), args.v3_corpus,
             args.v3_report, args.baseline_model, args.baseline_report)
    output = output_directory(args.output, paths)
    runtime = pinned_module(ROOT / "tools/vendor/word_classifier_candidate_v4.py", RUNTIME_GIT_BLOB, "_candidate_v4_runtime")
    trainer = pinned_module(ROOT / "tools/train_word_classifier.py", TRAINER_GIT_BLOB, "_candidate_v4_trainer")
    evaluator = pinned_module(ROOT / "tools/evaluate_word_classifier_candidate.py", EVALUATOR_GIT_BLOB, "_candidate_v4_evaluator")
    # The original trainer's split normalizer is stable; all new fitting remains
    # here and uses the pinned candidate runtime rather than production imports.
    trainer.load_runtime = lambda: runtime
    baseline_training = json.loads(args.baseline_report.read_text(encoding="utf-8"))
    if digest(args.baseline_model) != baseline_training["model_sha256"]:
        raise ValueError("Historical baseline model hash differs")
    legacy = evaluator.baseline_runtime_from_file(ROOT / "training-data/word-lid/audited-baseline/word_classifier_runtime_v1.py")
    old_model = evaluator.model_from_file(args.baseline_model, legacy)
    if list(old_model.codes) != baseline_training["languages"]:
        raise ValueError("Historical baseline labels differ")
    historical, _, _ = trainer.gather(legacy)
    old_codes = frozenset(old_model.codes)
    historical = {word: labels & old_codes for word, labels in historical.items() if labels & old_codes}
    old_partitions = evaluator.partition_digest_report(historical, {}, trainer.split_word)
    if (old_partitions["counts"] != baseline_training["split_words"]
            or old_partitions["digests"] != baseline_training["split_digests_sha256"]):
        raise ValueError("Original45 lexical holdouts do not reproduce")
    if digest(args.v2_corpus) != V2_CORPUS_SHA256:
        raise ValueError("Frozen v2 corpus hash differs")
    base, baseline_sources, _ = trainer.gather(runtime)
    v2, v2_overrides, v2_header = trainer.additional_word_corpus(args.v2_corpus, runtime)
    v3, v3_overrides, v3_receipt = load_v3(args.v3_corpus, args.v3_report,
        ROOT / "tools/data/word_lid_sources_v3_acquisition.json", runtime, trainer.split_word)
    fresh_v3_words = frozenset(word for word in v3 if word not in v2 and word not in base)
    corpus, overrides = merge_corpora(base, v2, v3, v2_overrides, v3_overrides)
    del v3, base
    assignment = lambda word: overrides.get(word) or trainer.split_word(word)
    codes, support = choose_codes(corpus, assignment, runtime, old_codes)
    allowed = frozenset(codes)
    for word in list(corpus):
        if len(word) < 4:
            del corpus[word]
            continue
        corpus[word].intersection_update(allowed)
        if not corpus[word]:
            del corpus[word]
    selected = sample_training(corpus, assignment, runtime, codes, support, args.max_words_per_language)
    counts = {code: Counter() for code in codes}
    script_support, family_support, trained_labels = Counter(), Counter(), Counter()
    train_words = set()
    ambiguities = []
    for word, labels in sorted(corpus.items()):
        if assignment(word) != "train":
            continue
        if len(labels) > 1:
            ambiguities.append(word)
        features = runtime.feature_indexes(word, args.dimensions)
        family, script = runtime.actual_native_family(word), runtime.word_script(word)
        for code in labels:
            if (word, code) not in selected:
                continue
            counts[code].update(features)
            script_support[code, script] += 1
            family_support[code, family] += 1
            trained_labels[code] += 1
            train_words.add(word)
    weights, defaults, scale, alpha = array("h"), [], 256, .2
    for code in codes:
        denominator = sum(counts[code].values()) + args.dimensions * alpha
        defaults.append(round(math.log(alpha / denominator) * scale))
        weights.extend(round(math.log((counts[code][feature] + alpha) / denominator) * scale)
                       for feature in range(args.dimensions))
    if sys.byteorder != "little":
        weights.byteswap()
    document = {"format": runtime.FORMAT, "codes": codes,
        "scripts": {code: sorted(script for (label, script), count in script_support.items()
                     if label == code and count >= MINIMUM_WORDS) for code in codes},
        "native_families": {code: sorted(family for (label, family), count in family_support.items()
                           if label == code and count >= MINIMUM_WORDS) for code in codes},
        "dimensions": args.dimensions, "quantization": scale, "ngrams": [2,3,4],
        "temperature": 1., "minimum_confidence": .5, "native_combining_marks": True,
        "known_ambiguous_spellings": ambiguities, "default_weights": defaults,
        "weights": base64.b64encode(weights.tobytes()).decode("ascii"),
        "per_predicted_class_thresholds": {code: None for code in codes},
        "release_status": "candidate-not-installed", "native_word_routing": {}}
    classifier = runtime.WordClassifier(document)
    partitions = evaluator.partition_digest_report(corpus, overrides, trainer.split_word)
    validation = [(word, corpus[word]) for word in sorted(corpus) if assignment(word) == "validation"]
    # Cache scores once. No test word is presented until policy parameters freeze.
    rankings = [(word, labels, classifier.scores(word)) for word, labels in validation]
    def nll(temperature):
        total = 0.
        for _, labels, rows in rankings:
            if not rows:
                total += 30.
                continue
            best = rows[0][1]
            numerator = sum(math.exp((score-best)/temperature) for code, score, _ in rows if code in labels)
            denominator = sum(math.exp((score-best)/temperature) for _, score, _ in rows)
            total -= math.log(max(1e-12, numerator/denominator))
        return total/max(1, len(rankings))
    losses = {value: nll(value) for value in (.5,1.,2.,4.,8.,16.)}
    temperature = min(losses, key=losses.get)
    records = []
    for word, labels, rows in rankings:
        if (not rows or not runtime.is_valid_word(word) or word in classifier.ambiguous_words):
            continue
        best = rows[0][1]
        confidence = 1./sum(math.exp((score-best)/temperature) for _, score, _ in rows)
        records.append((rows[0][0], confidence, rows[0][2], rows[0][0] in labels))
    thresholds, calibration = calibrate_predicted_classes(records, codes)
    competition = with_native_competition_guard(thresholds, calibration, document["native_families"])
    document["temperature"] = temperature
    document["per_predicted_class_thresholds"] = thresholds
    del rankings, records
    classifier = runtime.WordClassifier(document)
    unseen = {word for word in corpus if assignment(word) != "train"}
    if unseen & train_words or unseen & classifier.ambiguous_words:
        raise ValueError("Held-out spelling leaked into fitting or training-only homograph guard")
    del unseen
    # Freeze and serialize the complete policy BEFORE reading final-test labels.
    packed = gzip.compress(json.dumps(document, ensure_ascii=False, sort_keys=True,
        separators=(",", ":")).encode("utf-8"), mtime=0)
    output.mkdir(parents=True, exist_ok=False)
    model_path = output / "word-lid.candidate-v4.json.gz"
    model_path.write_bytes(packed)
    write_merged_corpus(output / "merged-corpus.jsonl.gz", corpus, overrides, assignment)
    validation_report = evaluator.evaluate_rows(classifier, validation)
    final_report = evaluator.evaluate_rows(classifier,
        ((word, corpus[word]) for word in partitions["test_words"]))
    fresh_test = [(word, corpus[word]) for word in partitions["test_words"] if word in fresh_v3_words]
    fresh_report = evaluator.evaluate_rows(classifier, fresh_test)
    shared = list(evaluator.comparison_rows(historical, overrides, trainer.split_word, old_codes))
    core = frozenset(("uk","en","ru"))
    core_rows = [(word, labels) for word, labels in shared if labels & core]
    comparisons = {}
    for name, rows, targets in (("historical45",shared,old_codes),("core_uk_en_ru",core_rows,core)):
        comparisons[name] = {"words": len(rows), "same_exact_reference_labels_and_test_words": True,
            "enabled_targets": sorted(targets), "full_candidate_ranking_before_enabled_filter": True,
            "word_list_sha256": sha256("\n".join(word for word, _ in rows).encode("utf-8")).hexdigest(),
            "reference_rows_sha256": sha256("\n".join(word+"\t"+",".join(sorted(labels))
                for word, labels in rows).encode("utf-8")).hexdigest(),
            "baseline": evaluator.evaluate_rows(old_model, rows, enabled=targets),
            "candidate": evaluator.evaluate_rows(classifier, rows, enabled=targets)}
    report = {"format": "dordiai-word-lid-candidate-evaluation-v4", "model_installed": False,
        "release_status": "unreviewed-candidate-not-installed", "native_router_capability_enabled": False,
        "weak_source_membership_is_not_author_intent_or_native_pronunciation": True,
        "sources": {"baseline": baseline_sources, "v2": v2_header,
            "v3": v3_receipt, "v2_corpus_sha256": V2_CORPUS_SHA256, "v3_corpus_sha256": V3_CORPUS_SHA256},
        "pins": {"trainer_git_blob": TRAINER_GIT_BLOB, "runtime_git_blob": RUNTIME_GIT_BLOB,
                 "evaluator_git_blob": EVALUATOR_GIT_BLOB, "baseline_model_sha256": digest(args.baseline_model),
                 "candidate_trainer_git_blob": git_blob(Path(__file__).read_bytes()),
                 "baseline_report_sha256": digest(args.baseline_report)},
        "languages": codes, "baseline_languages": list(old_model.codes),
        "lost_baseline_labels": sorted(old_codes-set(codes)), "new_labels": sorted(set(codes)-old_codes),
        "normalised_words": len(corpus), "trained_words": len(train_words),
        "training_words_per_language": dict(sorted(trained_labels.items())),
        "native_actual_family_training_counts": {code: {family: count for (label,family),count in family_support.items() if label==code} for code in codes},
        "native_actual_family_available_training_counts": {code: {family: count for (label,family),count in support.items() if label==code} for code in codes},
        "model_native_families": document["native_families"], "model_scripts": document["scripts"],
        "actual_native_family_competing_classes": competition,
        "split_policy": "ALL baseline/v2/v3 labels globally: publisher test > validation > original spelling hash80/10/10",
        "publisher_holdout_spellings": len(overrides), "split_counts": partitions["counts"],
        "split_digests_sha256": partitions["digests"], "split_overlap_words": 0,
        "historical45_partitions_reproduced": True,
        "known_training_ambiguities": len(ambiguities), "test_spellings_in_training_ambiguity_guard": 0,
        "calibration_policy": {"source_partition": "validation-only", "minimum_accepted_per_predicted_class": MINIMUM_CALIBRATION,
            "empirical_precision_target": TARGET_PRECISION, "wilson95_lower_minimum": MINIMUM_WILSON_LOWER,
            "class_disabled_policy": "null threshold => abstain, never rerank another class",
            "temperature_nll": losses, "selected_temperature": temperature,
            "validation_reuse_and_threshold_search_do_not_establish_population_guarantees": True},
        "per_predicted_class_calibration": calibration,
        "untrusted_classes": sorted(code for code,value in thresholds.items() if value is None),
        "baseline_classes_abstained_for_insufficient_validation_evidence": sorted(code for code in old_codes if thresholds[code] is None),
        "training_pairs_sha256": sha256("\n".join(word+"\t"+code for word,code in sorted(selected)).encode("utf-8")).hexdigest(),
        "model_sha256": digest(model_path), "model_bytes": len(packed),
        "merged_corpus_sha256": digest(output/"merged-corpus.jsonl.gz"),
        "validation": validation_report, "final_test": final_report, "paired_comparisons": comparisons,
        "test_scope": {"v2_final_test_previously_audited": True,
            "fixed_legacy_comparisons_are_reused_development_benchmarks": True,
            "no_final_test_rows_enter_temperature_or_class_threshold_fitting": True,
            "fresh_v3_only_test_excludes_every_baseline_and_v2_spelling": True,
            "fresh_v3_only_test_words": len(fresh_test),
            "fresh_v3_only_test_word_sha256": sha256("\n".join(word for word,_ in fresh_test).encode("utf-8")).hexdigest()},
        "fresh_v3_only_final_test": fresh_report,
        "native_word_routing": {}, "final_test_used_for_tuning": False}
    (output/"evaluation.json").write_bytes(json_bytes(report))
    print("WORD_LID_V4_SUMMARY "+json.dumps({key:report[key] for key in (
        "languages","lost_baseline_labels","new_labels","model_sha256","model_bytes","split_counts",
        "split_digests_sha256","untrusted_classes")}, ensure_ascii=True), flush=True)
    print("WORD_LID_V4_FINAL "+json.dumps(final_report["overall"]), flush=True)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--v2-corpus", type=Path, required=True)
    parser.add_argument("--v3-corpus", type=Path, required=True)
    parser.add_argument("--v3-report", type=Path, required=True)
    parser.add_argument("--baseline-model", type=Path, default=ROOT/"source/0.12.2/kx47Runtime/models/WordLanguage/word-lid.json.gz")
    parser.add_argument("--baseline-report", type=Path, default=ROOT/"evidence/word_classifier_evaluation.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dimensions", type=int, default=16384)
    parser.add_argument("--max-words-per-language", type=int, default=5000)
    args = parser.parse_args(argv)
    if not 256 <= args.dimensions <= 65536 or not MINIMUM_WORDS <= args.max_words_per_language <= 20000:
        parser.error("Training dimensions/cap outside reviewed bounds")
    train_candidate(args)


if __name__ == "__main__":
    main()
