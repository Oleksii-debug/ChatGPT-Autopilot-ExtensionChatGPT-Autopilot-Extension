"""Reproduce the compact word LID model from restored lexical resources.

Standard-library only. All normalized spellings have one global, deterministic
train/validation/test assignment across sources and language labels. Source
labels are weak lexical evidence, not independent human-annotated truth.
"""
from array import array
from collections import Counter, defaultdict
from functools import lru_cache
import argparse
import base64
import gzip
from hashlib import sha256
import importlib.util
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "source/0.12.2/kx47Runtime"
BASELINE = ROOT / "packages/0.12.2/kx47Runtime"
SEED = "dordiai-word-split-v1:"
LATIN_CODES = ("en", "sk", "pl", "de", "fr", "da", "it", "es")


def lexical_source(relative, baseline=BASELINE, bundled=None):
    """Use audited restored resources or their small, exact CI copies.

    The acoustic models are deliberately absent from git. Reproducing word
    splits needs only these two lexical gzip files, not the entire add-on.
    """
    original = Path(baseline) / relative
    if original.is_file():
        return original.read_bytes()
    directory = Path(bundled) if bundled is not None else ROOT / "training-data/word-lid/audited-baseline"
    manifest = json.loads((directory / "sources.json").read_text(encoding="utf-8"))
    expected = next((row for row in manifest.get("files", []) if row.get("path") == relative), None)
    if expected is None:
        raise ValueError("No audited lexical source record: " + relative)
    blob = (directory / relative).read_bytes()
    if len(blob) != expected["bytes"] or sha256(blob).hexdigest() != expected["sha256"]:
        raise ValueError("Audited lexical source checksum mismatch: " + relative)
    return blob


@lru_cache(maxsize=1)
def load_runtime():
    spec = importlib.util.spec_from_file_location("training_word_classifier", RUNTIME / "word_classifier.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def split_word(word):
    word = load_runtime().normalize_word(word)
    bucket = int.from_bytes(sha256((SEED + word).encode("utf8")).digest()[:4], "big") % 100
    return "train" if bucket < 80 else "validation" if bucket < 90 else "test"


def canonical(code):
    return {"no": "nb", "nn": "nb", "zh": "cmn"}.get(code, code)


def gather(runtime, baseline=BASELINE, training_data=None):
    selected = json.loads((ROOT / "selected_languages.json").read_text(encoding="utf8"))
    allowed = {canonical(row["id"]) for row in selected["languages"]}
    corpus = defaultdict(set)
    sources = []
    for relative in ("latin_dictionary.json.gz", "models/WideLanguages/wide_words.json.gz"):
        blob = lexical_source(relative, baseline)
        sources.append({"path": relative, "sha256": sha256(blob).hexdigest(), "bytes": len(blob)})
        data = json.loads(gzip.decompress(blob))
        for raw_word, labels in data.items():
            word = runtime.normalize_word(raw_word)
            if len(word) < 4 or len(word) > 48 or not all(char.isalpha() or char in "'-" for char in word):
                continue
            if runtime.word_script(word) is None:
                continue
            if relative.startswith("latin_"):
                if not isinstance(labels, str) or len(labels) != len(LATIN_CODES):
                    continue
                best = max(map(ord, labels))
                labels = [code for code, value in zip(LATIN_CODES, labels) if value != " " and best - ord(value) <= 24]
            elif isinstance(labels, str):
                labels = [labels]
            elif not isinstance(labels, (list, tuple, dict)):
                continue
            corpus[word].update(canonical(code) for code in labels if canonical(code) in allowed)
    cyrillic_lexicon = defaultdict(set)
    training_data = training_data or ROOT / "training-data/word-lid"
    manifest = json.loads((training_data / "sources.json").read_text(encoding="utf8"))
    frequency_by_language = {}
    frequency_totals = {}
    for row in manifest["sources"]:
        path = training_data / row["path"]
        stored = path.read_bytes()
        if sha256(stored).hexdigest() != row["stored_sha256"]:
            raise ValueError("Training source checksum mismatch: " + str(path))
        original = gzip.decompress(stored)
        if sha256(original).hexdigest() != row["source_sha256"]:
            raise ValueError("Original training source checksum mismatch: " + str(path))
        code = canonical(row["language"])
        sources.append(dict(row, path=path.relative_to(ROOT).as_posix()))
        if code not in allowed:
            continue
        word_frequencies = Counter()
        for line in original.decode("utf8").splitlines():
            try:
                raw_word, frequency = line.rsplit(" ", 1)
                int(frequency)
            except ValueError:
                continue
            word = runtime.normalize_word(raw_word)
            if not word or len(word) > 48 or not all(char.isalpha() or char in "'-" for char in word):
                continue
            if runtime.word_script(word) != "CYRILLIC":
                continue
            word_frequencies[word] += int(frequency)
        frequency_by_language[code] = word_frequencies
        frequency_totals[code] = sum(word_frequencies.values())
    # Subtitle files contain borrowing and mixed-language tokens. In particular,
    # the Ukrainian file includes many Russian tokens; presence is not a clean
    # language label. Retain alternatives within a 2x NORMALISED frequency band.
    # This remains weak statistical evidence and does not prove lexical absence.
    for word in sorted(set().union(*(rows.keys() for rows in frequency_by_language.values()))):
        scores = {code: rows[word] / frequency_totals[code]
                  for code, rows in frequency_by_language.items() if rows[word]}
        peak = max(scores.values())
        labels = {code for code, value in scores.items() if value >= peak / 2.}
        cyrillic_lexicon[word].update(labels)
        if len(word) >= 4:
            corpus[word].update(labels)
    return {word: labels for word, labels in corpus.items() if labels}, sources, cyrillic_lexicon


def additional_word_corpus(path, runtime):
    """Read a checksummed prepared corpus and retain global publisher holdouts."""
    path = Path(path)
    receipt_path = Path(str(path) + ".receipt.json")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if sha256(path.read_bytes()).hexdigest() != receipt.get("corpus_sha256"):
        raise ValueError("Prepared native-word corpus checksum mismatch")
    corpus, overrides = {}, {}
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        header = json.loads(stream.readline(8 * 1024 * 1024))
        if header.get("format") != "dordiai-word-lid-extra-v1" or header.get("sources") != receipt.get("sources"):
            raise ValueError("Prepared native-word corpus provenance mismatch")
        source_lock = json.loads((ROOT / "tools/data/word_lid_sources_v2.json").read_text(encoding="utf-8"))
        locked_hash = sha256(json.dumps(source_lock, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        if header.get("source_lock_sha256") != locked_hash:
            raise ValueError("Prepared native-word source lock differs from the reviewed source lock")
        locked_sources = {row["id"]: row for row in source_lock["sources"]}
        if not isinstance(header.get("sources"), list) or not header["sources"]:
            raise ValueError("Prepared native-word corpus has no pinned source receipts")
        for source in header["sources"]:
            locked = locked_sources.get(source.get("id")) if isinstance(source, dict) else None
            if (locked is None or any(source.get(key) != locked.get(key) for key in
                    ("language", "source_language", "url", "revision", "license", "license_url", "attribution"))
                    or locked.get("sha256") is not None and source.get("sha256") != locked["sha256"]
                    or locked.get("bytes") is not None and source.get("bytes") != locked["bytes"]):
                raise ValueError("Prepared native-word receipt differs from its pinned primary source")
        allowed = {canonical(row["id"]) for row in json.loads((ROOT / "selected_languages.json").read_text(encoding="utf-8"))["languages"]}
        previous = None
        for line in stream:
            if len(line) > 1024 * 1024:
                raise ValueError("Prepared native-word row is too large")
            row = json.loads(line)
            word, labels, role = row.get("word"), row.get("labels"), row.get("publisher_role")
            if (not isinstance(word, str) or runtime.normalize_word(word) != word
                    or not runtime.is_valid_word(word) or previous is not None and word <= previous
                    or not isinstance(labels, list) or not labels
                    or any(not isinstance(code, str) or code not in allowed for code in labels)
                    or len(set(labels)) != len(labels)
                    or role not in ("train", "validation", "test")):
                raise ValueError("Invalid prepared native-word spelling, labels or publisher split")
            corpus[word] = set(labels)
            if role != "train":
                overrides[word] = role
            previous = word
    if len(corpus) != header.get("normalised_words"):
        raise ValueError("Prepared native-word corpus count differs from provenance")
    return corpus, overrides, header


def metrics(classifier, rows, threshold=None, temperature=None):
    accepted = correct = top_correct = 0
    by_language = defaultdict(lambda: {"words": 0, "accepted": 0, "correct": 0})
    predictions = []
    for word, labels in rows:
        code, confidence, support = classifier.rank(word, temperature)
        okay = code in labels
        top_correct += okay
        take = confidence >= (classifier.threshold if threshold is None else threshold) and support >= .25
        accepted += take
        correct += take and okay
        for label in labels:
            row = by_language[label]
            row["words"] += 1
            row["accepted"] += take
            row["correct"] += take and okay
        predictions.append((word, labels, code, confidence, support))
    size = len(rows)
    return {"words": size, "top1_label_match": top_correct / size if size else None,
            "accepted": accepted, "correct_accepted": correct,
            "coverage": accepted / size if size else 0.,
            "selective_label_match": correct / accepted if accepted else None,
            "per_language": dict(sorted(by_language.items()))}, predictions


def train(args):
    runtime = load_runtime()
    corpus, sources, cyrillic_lexicon = gather(runtime, args.baseline, args.training_data)
    extra_header, publisher_overrides = None, {}
    if getattr(args, "additional_corpus", None) is not None:
        extra, publisher_overrides, extra_header = additional_word_corpus(args.additional_corpus, runtime)
        for word, labels in extra.items():
            if len(word) >= 4:
                corpus.setdefault(word, set()).update(labels)
        sources.extend(extra_header["sources"])
    def assignment(word):
        return publisher_overrides.get(word) or split_word(word)
    support = Counter(code for labels in corpus.values() for code in labels)
    actual_script_support = Counter((code, runtime.word_script(word))
        for word, labels in corpus.items() if assignment(word) == "train" for code in labels) if extra_header is not None else Counter()
    eligible_training_codes = {code for (code, script), count in actual_script_support.items()
                               if script is not None and count >= args.minimum_words}
    codes = sorted(code for code, count in support.items() if count >= args.minimum_words
                   and (extra_header is None or code in eligible_training_codes))
    training_ambiguities = sorted(word for word, labels in corpus.items()
        if len(labels) > 1 and assignment(word) == "train") if extra_header is not None else []
    allowed = set(codes)
    corpus = {word: labels & allowed for word, labels in corpus.items() if labels & allowed}
    # Cap training contribution per label without touching held-out assignments.
    label_words = defaultdict(list)
    for word, labels in corpus.items():
        if assignment(word) == "train":
            for code in labels:
                label_words[code].append(word)
    selected_pairs = set()
    for code, words in label_words.items():
        words.sort(key=lambda word: sha256(("sample:" + word).encode("utf8")).digest())
        selected_pairs.update((word, code) for word in words[:args.max_words_per_language])
    counts = {code: Counter() for code in codes}
    scripts = {code: set() for code in codes}
    train_words = set()
    train_labels = Counter()
    trained_script_support = Counter()
    for word, labels in sorted(corpus.items()):
        if assignment(word) != "train":
            continue
        features = runtime.feature_indexes(word, args.dimensions)
        for code in labels:
            if (word, code) not in selected_pairs:
                continue
            counts[code].update(features)
            scripts[code].add(runtime.word_script(word))
            train_words.add(word)
            train_labels[code] += 1
            trained_script_support[code, runtime.word_script(word)] += 1
    if extra_header is not None:
        scripts = {code: {script for script in scripts[code]
                    if trained_script_support[code, script] >= args.minimum_words} for code in codes}
    weights = array("h")
    defaults = []
    scale = 256
    alpha = .2
    for code in codes:
        denominator = sum(counts[code].values()) + args.dimensions * alpha
        base = round(math.log(alpha / denominator) * scale)
        defaults.append(base)
        weights.extend(round(math.log((counts[code][feature] + alpha) / denominator) * scale)
                       for feature in range(args.dimensions))
    if sys.byteorder != "little":
        weights.byteswap()
    document = {"format": runtime.FORMAT, "codes": codes, "scripts": {c: sorted(scripts[c]) for c in codes},
                "dimensions": args.dimensions, "quantization": scale, "ngrams": [2, 3, 4],
                "temperature": 1., "minimum_confidence": .99,
                "default_weights": defaults, "weights": base64.b64encode(weights.tobytes()).decode("ascii")}
    if extra_header is not None:
        document["native_combining_marks"] = True
        document["known_ambiguous_spellings"] = training_ambiguities
    classifier = runtime.WordClassifier(document)
    validation = [(word, labels) for word, labels in sorted(corpus.items()) if assignment(word) == "validation"]
    testing = [(word, labels) for word, labels in sorted(corpus.items()) if assignment(word) == "test"]
    # Temperature is selected ONLY on validation. The final test is evaluated
    # once after the confidence policy is fixed.
    rankings = [(classifier.scores(word), labels) for word, labels in validation]
    def nll(temperature):
        total = 0.
        for ranking, labels in rankings:
            if not ranking:
                total += 30.
                continue
            best = ranking[0][1]
            numerator = sum(math.exp((score - best) / temperature) for code, score, _ in ranking if code in labels)
            denominator = sum(math.exp((score - best) / temperature) for _, score, _ in ranking)
            total -= math.log(max(1e-12, numerator / denominator))
        return total / max(1, len(rankings))
    temperatures = {temperature: nll(temperature) for temperature in (.5, 1., 2., 4., 8., 16.)}
    temperature = min(temperatures, key=temperatures.get)
    threshold_rows = []
    selected_threshold = 1.
    for threshold in (.50, .60, .70, .80, .85, .90, .92, .95, .97, .98, .99, .995, .999):
        accepted = correct = 0
        for ranking, labels in rankings:
            if not ranking:
                continue
            best = ranking[0][1]
            confidence = 1. / sum(math.exp((score - best) / temperature) for _, score, _ in ranking)
            take = confidence >= threshold and ranking[0][2] >= .25
            accepted += take
            correct += take and ranking[0][0] in labels
        precision = correct / accepted if accepted else None
        threshold_rows.append({"threshold": threshold, "accepted": accepted, "label_match": precision})
        if accepted >= 20 and precision >= args.target_precision and selected_threshold == 1.:
            selected_threshold = threshold
    document["temperature"] = temperature
    document["minimum_confidence"] = selected_threshold
    classifier = runtime.WordClassifier(document)
    validation_stats, _ = metrics(classifier, validation)
    test_stats, predictions = metrics(classifier, testing)
    packed = gzip.compress(json.dumps(document, separators=(",", ":"), sort_keys=True).encode("utf8"), mtime=0)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(packed)
    lexicon_document = {"format": "dordiai-cyrillic-lexicon-v1", "codes": ["uk", "ru"],
                        "words": {word: sum(1 << index for index, code in enumerate(("uk", "ru")) if code in labels)
                                  for word, labels in sorted(cyrillic_lexicon.items())}}
    lexicon_packed = gzip.compress(json.dumps(lexicon_document, separators=(",", ":"), ensure_ascii=False).encode("utf8"), mtime=0)
    args.lexicon_output.parent.mkdir(parents=True, exist_ok=True)
    args.lexicon_output.write_bytes(lexicon_packed)
    # Split membership digests permit auditing without publishing a duplicate
    # corpus. All words are assigned globally after NFC/case/stress normalisation.
    partition_words = {name: sorted(word for word in corpus if assignment(word) == name)
                       for name in ("train", "validation", "test")}
    assert not (set(partition_words["train"]) & set(partition_words["validation"]) or
                set(partition_words["train"]) & set(partition_words["test"]) or
                set(partition_words["validation"]) & set(partition_words["test"]))
    report = {"format": "dordiai-word-lid-evaluation-v1", "sources": sources,
              "label_quality": "Weak lexical labels; this is not a human-annotated language benchmark",
              "label_policy": "Merge plausible labels per normalised spelling; Latin encoded frequency band <=24; subtitle Cyrillic labels within2x normalized per-language frequency; shared labels retained",
              "split_policy": "SHA256('" + SEED + "' + normalised_word), 80/10/10, global across source/label",
              "normalised_words": len(corpus), "trained_words": len(train_words),
              "training_words_per_language": dict(sorted(train_labels.items())),
              "split_words": {name: len(words) for name, words in partition_words.items()},
              "split_digests_sha256": {name: sha256("\n".join(words).encode("utf8")).hexdigest() for name, words in partition_words.items()},
              "word_overlap_train_validation_test": 0,
              "languages": codes, "not_a_claim_of_support_for_all_selected_languages": True,
              "dimensions": args.dimensions, "max_words_per_language": args.max_words_per_language,
              "character_features": "binary presence of hashed character 2/3/4-grams with word boundaries; no whole-word lookup feature",
              "algorithm": "multinomial naive Bayes, uniform class prior, alpha=.2, quantised log likelihoods",
              "temperature_selected_on_validation": temperature, "validation_nll_by_temperature": temperatures,
              "confidence_threshold_selected_on_validation": selected_threshold, "threshold_search": threshold_rows,
              "validation": validation_stats, "test": test_stats,
              "model_bytes": len(packed), "model_sha256": sha256(packed).hexdigest(),
              "supplemental_cyrillic_lexicon": {"words": len(cyrillic_lexicon),
                  "ambiguous_words": sum(len(labels) > 1 for labels in cyrillic_lexicon.values()),
                  "bytes": len(lexicon_packed), "sha256": sha256(lexicon_packed).hexdigest()},
              "abstention": "Fewer than 4 characters, mixed/unknown script, low selected confidence, <25% seen grams, disabled predicted language",
              "test_failure_examples": [{"word": word, "labels": sorted(labels), "predicted": code, "score": confidence}
                                        for word, labels, code, confidence, _ in predictions if code not in labels][:30]}
    if extra_header is not None:
        report["split_policy"] = "Publisher test > publisher validation > global SHA256 80/10/10; applies to ALL baseline/new labels of the normalised spelling"
        report["additional_corpus"] = {"source_lock_sha256": extra_header["source_lock_sha256"],
            "publisher_holdout_spellings": len(publisher_overrides),
            "known_training_homographs_abstained": len(document["known_ambiguous_spellings"]),
            "languages_rejected_for_insufficient_training_spellings": sorted(set(support) - set(codes)),
            "available_training_spellings_per_language_script": {code: {script: count for (label, script), count in actual_script_support.items() if label == code} for code in sorted(support)},
            "selected_training_words_per_language_script": {code: {script: count for (label, script), count in trained_script_support.items() if label == code} for code in codes},
            "per_language_holdout_acceptance_requires_review": True,
            "integrated_router_holdout_verified": False,
            "exact_lexicon_not_used_in_classifier_evaluation": True}
        report["character_features"] += "; native combining marks retained; training-only known homographs explicitly abstain"
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"languages": len(codes), "model_bytes": len(packed), "trained_words": len(train_words),
                      "validation": {k:v for k,v in validation_stats.items() if k != "per_language"},
                      "test": {k:v for k,v in test_stats.items() if k != "per_language"}}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=BASELINE)
    parser.add_argument("--training-data", type=Path, default=ROOT / "training-data/word-lid")
    parser.add_argument("--additional-corpus", type=Path, help="Pinned-source prepared corpus; publisher holdouts override baseline/train spellings globally")
    parser.add_argument("--output", type=Path, default=RUNTIME / "models/WordLanguage/word-lid.json.gz")
    parser.add_argument("--lexicon-output", type=Path, default=RUNTIME / "models/WordLanguage/cyrillic-lexicon.json.gz")
    parser.add_argument("--report", type=Path, default=ROOT / "evidence/word_classifier_evaluation.json")
    parser.add_argument("--dimensions", type=int, default=16384)
    parser.add_argument("--minimum-words", type=int, default=100)
    parser.add_argument("--max-words-per-language", type=int, default=5000)
    parser.add_argument("--target-precision", type=float, default=.98)
    train(parser.parse_args())


if __name__ == "__main__":
    main()
