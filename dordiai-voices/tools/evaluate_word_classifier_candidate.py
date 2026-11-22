#!/usr/bin/env python3
"""Evaluation-only audit of one frozen word-classifier candidate.

Never trains, tunes thresholds, edits dictionaries or installs a model. Language
labels are weak lexical/source membership, not intended-language or TTS quality.
"""
import argparse
from collections import Counter, defaultdict
import gzip
from hashlib import sha1, sha256
import importlib.util
import json
import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BASELINE_RUNTIME_GIT_BLOB = "e1d1d1cb691039d2c6804781f4cd785cd6d05573"


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(path):
    state = sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            state.update(chunk)
    return state.hexdigest()


def baseline_runtime_from_file(path):
    raw = Path(path).read_bytes()
    identity = sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()
    if identity != BASELINE_RUNTIME_GIT_BLOB:
        raise ValueError("Historical baseline runtime differs from the frozen original Git object")
    return load_module(path, "_historical_word_runtime")


def validate_output_path(output, protected_files=(), protected_roots=()):
    output = Path(output)
    if output.is_symlink():
        raise ValueError("Evaluation output cannot be a symlink")
    resolved = output.resolve(strict=False)
    for source in protected_files:
        source = Path(source)
        if resolved == source.resolve(strict=False):
            raise ValueError("Evaluation output overlaps a protected input")
        if output.exists() and source.exists() and os.path.samefile(output, source):
            raise ValueError("Evaluation output aliases a protected input")
    for root in protected_roots:
        root = Path(root).resolve(strict=False)
        if resolved == root or resolved.is_relative_to(root):
            raise ValueError("Evaluation output is inside an audited source directory")
    if output.exists():
        raise FileExistsError("Evaluation output already exists; refusing to overwrite")
    return resolved


def write_atomic_report(output, document, protected_files=(), protected_roots=()):
    output = validate_output_path(output, protected_files, protected_roots)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent,
                prefix="word-lid-posthoc-", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(document, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        validate_output_path(output, protected_files, protected_roots)
        # Same-directory hard-link publication is atomic and fails if any
        # destination appears concurrently; unlike replace(), it never clobbers.
        os.link(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return output


def model_from_file(path, runtime):
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return runtime.WordClassifier(json.load(source))


def empty_counts():
    return {"words": 0, "accepted": 0, "reference_membership_matches": 0}


def add_counts(counts, accepted, matches):
    counts["words"] += 1
    counts["accepted"] += int(accepted)
    counts["reference_membership_matches"] += int(accepted and matches)


def finalize_counts(counts):
    result = dict(counts)
    result["coverage"] = counts["accepted"] / counts["words"] if counts["words"] else 0.
    result["accepted_reference_membership_precision"] = (
        counts["reference_membership_matches"] / counts["accepted"] if counts["accepted"] else None)
    return result


def evaluate_rows(classifier, rows, *, enabled=None, examples_limit=30):
    """One prediction per frozen test row; no fitting or reference-informed veto."""
    overall = empty_counts()
    reference_groups = {"single_label_reference": empty_counts(), "multiple_label_reference": empty_counts()}
    per_predicted = defaultdict(empty_counts)
    errors = []
    for word, labels in rows:
        labels = frozenset(labels)
        code, confidence = classifier.predict(word, enabled)
        accepted = code is not None
        matches = code in labels if accepted else False
        add_counts(overall, accepted, matches)
        group = "single_label_reference" if len(labels) == 1 else "multiple_label_reference"
        add_counts(reference_groups[group], accepted, matches)
        if accepted:
            add_counts(per_predicted[code], True, matches)
            if not matches and len(errors) < examples_limit:
                errors.append({"word": word, "reference_labels": sorted(labels), "predicted": code,
                               "model_confidence": confidence})
    predicted_report = {}
    visible_codes = set(getattr(classifier, "codes", ())) if enabled is None else set(enabled)
    for code in sorted(visible_codes | set(per_predicted)):
        counts = per_predicted.get(code, empty_counts())
        row = finalize_counts(counts)
        row.pop("coverage", None)
        row["emitted_words"] = row.pop("words")
        row["incorrect_accepted"] = counts["accepted"] - counts["reference_membership_matches"]
        row["fewer_than_20_accepted_examples"] = counts["accepted"] < 20
        row["meets_existing_98_percent_empirical_reference_gate"] = (
            counts["accepted"] >= 20 and row["accepted_reference_membership_precision"] >= .98)
        predicted_report[code] = row
    return {"overall": finalize_counts(overall),
            "reference_groups": {key: finalize_counts(value) for key, value in reference_groups.items()},
            "per_predicted_class": predicted_report, "incorrect_accepted_examples": errors,
            "membership_precision_is_not_native_language_or_author_intent_accuracy": True,
            "multiple_label_reference_intention_is_unresolved": True}


def partition_digest_report(corpus, overrides, split_word):
    counts = Counter()
    states = {name: sha256() for name in ("train", "validation", "test")}
    test_words = []
    for word in sorted(corpus):
        role = overrides.get(word) or split_word(word)
        if counts[role]:
            states[role].update(b"\n")
        states[role].update(word.encode("utf-8"))
        counts[role] += 1
        if role == "test":
            test_words.append(word)
    return {"counts": {key: counts[key] for key in states},
            "digests": {key: value.hexdigest() for key, value in states.items()},
            "test_words": test_words}


def named_entity_tag_case_impact(header, source_lock):
    """Quantify exact rows affected; missing original tag counts stay unknown."""
    lock = {row["id"]: row for row in source_lock["sources"]}
    rows = []
    complete = True
    affected = 0
    for receipt in header["sources"]:
        source = lock[receipt["id"]]
        if source["kind"] != "aksharantar-jsonl-zip":
            continue
        counts = receipt.get("parser_counts")
        tags = {key[len("publisher_source:"):]: value for key, value in counts.items()
                if key.startswith("publisher_source:")} if isinstance(counts, dict) else {}
        if (not isinstance(counts, dict) or not tags
                or any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in tags.values())):
            complete = False
            rows.append({"id": source["id"], "original_tag_counts_available": False})
            continue
        old_exclusions = frozenset(source.get("exclude_sources", ()))
        new_exclusions = {value.strip().casefold() for value in old_exclusions}
        affected_tags = {tag: value for tag, value in tags.items()
                         if tag not in old_exclusions and tag.strip().casefold() in new_exclusions}
        affected += sum(affected_tags.values())
        rows.append({"id": source["id"], "original_tag_counts_available": True,
                     "all_observed_original_tags": tags,
                     "rows_kept_by_old_rule_but_excluded_by_new_rule": sum(affected_tags.values()),
                     "affected_tags": affected_tags})
    expected = {row["id"] for row in source_lock["sources"] if row["kind"] == "aksharantar-jsonl-zip"}
    complete = complete and bool(expected) and {row["id"] for row in rows} == expected
    return {"complete_original_tag_evidence": complete, "sources": rows,
            "affected_rows": affected if complete else None,
            "same_prepared_corpus_can_be_bound_to_casefix_without_retraining": complete and affected == 0}


def comparison_rows(baseline_corpus, overrides, split_word, targets):
    """Require test membership for BOTH recipes; exclude old training/validation."""
    targets = frozenset(targets)
    for word in sorted(baseline_corpus):
        labels = baseline_corpus[word] & targets
        if (labels and split_word(word) == "test"
                and (overrides.get(word) or split_word(word)) == "test"):
            yield word, labels


def audit(args):
    protected_files = (args.model, args.training_report, args.corpus, Path(str(args.corpus) + ".receipt.json"),
                       args.baseline_model, args.baseline_report, args.baseline_runtime)
    protected_roots = (ROOT / "source", ROOT / "tools", ROOT / "tests", ROOT / "training-data", ROOT.parent / ".github")
    output = validate_output_path(args.output, protected_files, protected_roots)
    trainer = load_module(ROOT / "tools/train_word_classifier.py", "_posthoc_word_trainer")
    runtime = trainer.load_runtime()
    training = json.loads(args.training_report.read_text(encoding="utf-8"))
    if digest(args.model) != training["model_sha256"]:
        raise ValueError("Candidate model bytes differ from its frozen training report")
    if digest(args.corpus) != args.expected_corpus_sha256:
        raise ValueError("Prepared corpus differs from the pinned full-training artifact")
    candidate = model_from_file(args.model, runtime)
    if (list(candidate.codes) != training["languages"]
            or candidate.threshold != training["confidence_threshold_selected_on_validation"]
            or candidate.temperature != training["temperature_selected_on_validation"]):
        raise ValueError("Candidate parameters differ from the frozen training report")
    baseline_training = json.loads(args.baseline_report.read_text(encoding="utf-8"))
    if digest(args.baseline_model) != baseline_training["model_sha256"]:
        raise ValueError("Baseline model bytes differ from the historical evaluation")
    legacy_runtime = baseline_runtime_from_file(args.baseline_runtime)
    baseline_model = model_from_file(args.baseline_model, legacy_runtime)
    if list(baseline_model.codes) != baseline_training["languages"]:
        raise ValueError("Historical baseline language labels differ")
    extra, overrides, header = trainer.additional_word_corpus(args.corpus, runtime)
    baseline, _, _ = trainer.gather(runtime)
    historical_baseline, _, _ = trainer.gather(legacy_runtime)
    baseline_codes = frozenset(baseline_model.codes)
    historical_baseline = {word: labels & baseline_codes for word, labels in historical_baseline.items() if labels & baseline_codes}
    historical_partitions = partition_digest_report(historical_baseline, {}, trainer.split_word)
    if (historical_partitions["counts"] != baseline_training["split_words"]
            or historical_partitions["digests"] != baseline_training["split_digests_sha256"]):
        raise ValueError("Historical baseline lexical partitions differ from its frozen evaluation")
    # Merge into the large extra dictionary, avoiding another multi-million-word
    # duplicate. Preserve baseline reference-label sets for the paired comparison.
    corpus = extra
    for word, labels in baseline.items():
        if word in corpus:
            corpus[word].update(labels)
        else:
            corpus[word] = set(labels)
    labels = frozenset(candidate.codes)
    for word in list(corpus):
        if len(word) < 4:
            del corpus[word]
            continue
        corpus[word].intersection_update(labels)
        if not corpus[word]:
            del corpus[word]
    partitions = partition_digest_report(corpus, overrides, trainer.split_word)
    if partitions["counts"] != training["split_words"] or partitions["digests"] != training["split_digests_sha256"]:
        raise ValueError("Reconstructed word partitions differ from frozen training")
    leaked_guards = set(partitions["test_words"]) & set(candidate.ambiguous_words)
    if leaked_guards:
        raise ValueError("Final-test spellings appear in the model's training-only ambiguity guard")
    report = {"format": "dordiai-word-lid-posthoc-v1",
              "scope": "Frozen-model weak-reference membership audit; no threshold tuning/retraining/model installation",
              "model_installed": False, "native_language_quality_verified": False,
              "input_artifact_id": args.input_artifact_id,
              "candidate_model_sha256": digest(args.model), "candidate_model_bytes": args.model.stat().st_size,
              "prepared_corpus_sha256": digest(args.corpus),
              "baseline_model_sha256": digest(args.baseline_model),
              "baseline_runtime_git_blob": BASELINE_RUNTIME_GIT_BLOB,
              "historical_baseline_partitions_reproduced": True,
              "candidate_codes": list(candidate.codes), "baseline_codes": list(baseline_model.codes),
              "split_counts_reproduced": partitions["counts"], "split_digests_reproduced": partitions["digests"],
              "test_spellings_in_training_ambiguity_guard": 0,
              "candidate_added_labels": sorted(set(candidate.codes) - set(baseline_model.codes)),
              "candidate_lost_baseline_labels": sorted(set(baseline_model.codes) - set(candidate.codes)),
              "selected_source_labels_without_trained_candidate_class": sorted(
                  {row["language"] for row in header["sources"]} - set(candidate.codes)),
              "final_test_must_not_be_used_to_tune_thresholds": True}
    report["candidate_final_test"] = evaluate_rows(candidate,
        ((word, corpus[word]) for word in partitions["test_words"]), examples_limit=args.examples_limit)
    report["training_rank_only_test_metrics"] = training["test"]
    observed = report["candidate_final_test"]["overall"]
    report["predict_policy_vs_rank_only_test_delta"] = {
        "accepted": observed["accepted"] - training["test"]["accepted"],
        "reference_membership_matches": observed["reference_membership_matches"] - training["test"]["correct_accepted"]}
    targets = frozenset(baseline_model.codes)
    shared_rows = list(comparison_rows(historical_baseline, overrides, trainer.split_word, targets))
    report["historical_45_label_comparison"] = {
        "scope": "Identical original-baseline reference labels; only spellings held out by BOTH recipes",
        "words": len(shared_rows), "enabled_targets": sorted(targets),
        "candidate_still_ranks_all_candidate_competitors_before_enabled_filter": True,
        "baseline": evaluate_rows(baseline_model, shared_rows, enabled=targets, examples_limit=args.examples_limit),
        "candidate": evaluate_rows(candidate, shared_rows, enabled=targets, examples_limit=args.examples_limit)}
    core = frozenset(("uk", "en", "ru"))
    core_rows = [(word, references) for word, references in shared_rows if references & core]
    report["core_uk_en_ru_comparison"] = {
        "scope": "Same jointly held-out baseline words containing a core reference label; all original reference alternatives retained",
        "enabled_targets": sorted(core), "words": len(core_rows),
        "baseline": evaluate_rows(baseline_model, core_rows, enabled=core, examples_limit=args.examples_limit),
        "candidate": evaluate_rows(candidate, core_rows, enabled=core, examples_limit=args.examples_limit)}
    source_lock = json.loads((ROOT / "tools/data/word_lid_sources_v2.json").read_text(encoding="utf-8"))
    report["named_entity_tag_casefix_impact"] = named_entity_tag_case_impact(header, source_lock)
    write_atomic_report(output, report, protected_files, protected_roots)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--training-report", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--expected-corpus-sha256", required=True)
    parser.add_argument("--input-artifact-id", type=int, required=True)
    parser.add_argument("--baseline-runtime", type=Path, default=ROOT / "training-data/word-lid/audited-baseline/word_classifier_runtime_v1.py")
    parser.add_argument("--baseline-model", type=Path, default=ROOT / "source/0.12.2/kx47Runtime/models/WordLanguage/word-lid.json.gz")
    parser.add_argument("--baseline-report", type=Path, default=ROOT / "evidence/word_classifier_evaluation.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--examples-limit", type=int, default=30)
    args = parser.parse_args(argv)
    if not 0 <= args.examples_limit <= 100:
        parser.error("--examples-limit must be between 0 and 100")
    report = audit(args)
    print("WORD_LID_POSTHOC " + json.dumps(report, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    main()
