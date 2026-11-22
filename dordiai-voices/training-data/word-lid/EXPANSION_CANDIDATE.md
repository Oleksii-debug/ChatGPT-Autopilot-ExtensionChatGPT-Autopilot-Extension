# Expanded isolated-word classifier candidate

This source candidate acquires real publisher data for 21 currently missing classifier labels. It does not establish 21 additional accepted languages. The existing model has 45 learned labels, 296,117 compressed bytes and approximately 28% accepted held-out lexical spellings at its selected threshold; the labels are weak source evidence, not author-intent annotations.

The reviewed lock has 51 pinned objects: three European UD treebanks (nine original files), six AI4Bharat native-word ZIPs, and twelve exact selected MasakhaPOS languages (36 original files). No Twi-to-Akan, Serbian-to-Bosnian/Montenegrin, Bodo-Parja-to-Bodo, or neighboring-language substitution is included. Other selected languages remain open.

## Reproduce in an isolated CI checkout

The workflow dordiai-word-lid-sources.yml runs the small source preflight on a push containing [word-lid-preflight]. Full acquisition and training require the separate [word-lid-train] flag. Manual dispatch defaults to the small preflight. Neither path installs the candidate model.

Apply the candidate Unicode runtime, trainer, preparer, source lock and tests together. They do not require speech models, PyTorch, an account, payment, NVDA or user audio.

```bash
python -m unittest discover -s dordiai-voices/tests -p test_word_lid_sources.py
python dordiai-voices/tools/prepare_word_lid_sources.py --cache word-source-cache --output word-lid-expanded
python dordiai-voices/tools/train_word_classifier.py --additional-corpus word-lid-expanded/extra-corpus.jsonl.gz --output word-lid-expanded/word-lid.candidate.json.gz --lexicon-output word-lid-expanded/cyrillic-lexicon.candidate.json.gz --report word-lid-expanded/evaluation.json
python -m unittest discover -s dordiai-voices/tests -p test_word_classifier.py
```

The last command checks the unchanged bundled baseline model and its historical report; it does not silently substitute the new candidate. Archive word-lid-expanded, the source lock and the full CI log. Keep source archives in a cache, outside the add-on. Run the preparer with --languages brx doi first for a small archive-schema preflight if desired.

Training outputs are explicit candidate paths and never replace the packaged model automatically. Only real receipts can establish archive schemas, row counts, language counts, sizes and evaluation quality. No Python execution or new model quality is claimed by this handoff.

## Data and license provenance

* AI4Bharat/Aksharantar: Hugging Face revision e418c1fc928d9f5393af33268472cf20c1891be8. Six publisher SHA256 pins are in the source lock. Native-word JSONL fields and language identifiers are checked; romanized words are never treated as native-script labels. Named-entity source categories are excluded. The publisher distinguishes CC-BY for manually collected data (no version specified in its statement) and CC0 packaging for mined/existing data; source text terms remain relevant. The lock preserves that distinction.
* Masakhane-POS: revision 376f4161f0425584d4bd7664122b56fa026926d3. Raw files have both exact byte counts and Git object hashes. Dataset terms are CC-BY-NC-4.0, separate from the repository's MIT software license.
* Universal Dependencies r2.19: exact commit and object pins are recorded separately for each treebank. Croatian and Serbian datasets use CC-BY-SA-4.0; Greek GDT uses CC-BY-NC-SA-3.0.

Publisher links and attribution travel in preparation receipts and the evaluation report. The presence of noncommercial/share-alike data is not concealed as an unrestricted code license.

## Word and split safeguards

The former isalpha-only filter rejected native vowel signs, viramas and many decomposed tone marks. Existing bundled models keep the former mark-abstention behavior until an expanded trained model explicitly declares the new native-mark policy. Actual Unicode base/mark families are checked separately from historical model labels: Tamil, Telugu, Gujarati, Kannada, Malayalam, Sinhala and Meetei retain OTHER while accepting their own attached marks in an enabled new model; unrelated OTHER families are not merged. The candidate preserves native Unicode combining marks attached to a letter, retains NFC and the existing Cyrillic stress policy, and rejects leading/detached marks, foreign script marks, mixed scripts, spaces and joiners. Unsupported orthographic cases are counted rather than romanized or relabeled.

A SQLite preparation index merges every observed language label for each normalized spelling. Publisher test spellings globally override validation/train, and publisher validation spellings override train. The trainer applies these exclusions to the existing baseline corpus too. Other spellings keep the original global SHA256 80/10/10 assignment. Splits therefore need not end at exactly 80/10/10 after publisher exclusions.

Minimum training evidence is measured on actual training spellings per script. Runtime script eligibility is checked against the selected training sample, rather than inferred merely from a language code. Known shared spellings derive an explicit abstention list only from the training partition, before low-support labels are removed. Publisher test labels cannot enter that list.

The current model's character 2/3/4-gram features, quantization, enabled-language confidence policy, explicit language selection and existing routing code remain in place. No voice-specific retraining is required. Existing exact lexical resources are not part of this classifier evaluation: the report explicitly leaves integrated-router holdout acceptance unverified.

Before deployment, inspect accepted precision, coverage and sample counts separately for each language and script, with additional unseen words and deliberate homographs. A larger learned-label count or pooled 98% source-label match is not sufficient to accept every new label. Ambiguous isolated spellings cannot be made unambiguous by more dictionary entries.
