# Actual v4 candidate evaluation — uninstalled

Actual GitHub Actions run45024624278, job137214829848, commit46dd8b5a61a348b6354807245559b6dd19070a2f completed successfully. All25 unit tests, exact v2/v3 artifact checks, corpus/report pins, original45 partition reconstruction, global publisher-holdout merge and training/evaluation completed. The run produced an uninstalled research candidate. The original production model remains unchanged.

The model learns70 labels and loses none of the original45 learned labels. It is1,985,058 bytes, SHA256 eaed8606875537079ff2a016c5973331856a06ef57e2be71f8c2b482de7b02a7. Validation disables45 output classes, including34 original classes, so only25 classes can emit predictions. Learned label count is not working output coverage.

Merged normalized corpus:5,788,344 spellings;132,717 actually fitted spellings;105,426 publisher-held-out spellings;355,790 training-only ambiguity guards. Final partitions are4,549,119 train /608,824 validation /630,401 test, with zero cross-partition overlap. Actual-family metadata distinguishes MEETEI and ORIYA despite historical OTHER labels. Assamese/Kashmiri outputs are disabled because their shared native-script families lack learned competitors.

Final source-membership test:242,834 accepted predictions,239,997 reference matches,38.5206% coverage,98.8317% pooled precision. Six active predicted classes fall below98% empirical test precision: Danish97.985%, English94.509%, French97.439%, Polish97.657%, Tswana97.811%, Ukrainian97.545%. These results are weak source-membership statistics, not independent native-language or intended-language accuracy.

On the SAME38,327 jointly unseen historical45 words/references:
- Original model:10,737 accepted,10,545 matches;28.0142% coverage,98.2118% precision.
- Candidate:13,869 accepted,13,655 matches;36.1860% coverage,98.4570% precision.

On the SAME11,647 jointly unseen core-reference words:
- Original model:2,032 accepted,2,022 matches;17.4466% coverage,99.5079% precision.
- Candidate:3,218 accepted,3,167 matches;27.6294% coverage,98.4152% precision.
- Candidate core predicted outputs: English317/317; Russian1,539/1,557; Ukrainian1,311/1,344.

Fresh v3-only effective-corpus test:64,044 spellings;38,994 accepted,38,989 matches;60.8863% coverage,99.9872% membership precision. Unique-script Oriya/Meetei outputs dominate this result. “Fresh” excludes normalized accepted baseline/v2 corpus spellings; it does not assert absence from every discarded raw source token. The prior v2/legacy test sets are reused development comparisons, not a newly blind benchmark.

Disposition: useful reproducible research candidate, rejected as a production replacement. Core precision regresses and most original output classes abstain. No model installation, native routing capability declaration, native pronunciation acceptance or perfect isolated-word claim follows from this run.

Durable evidence:
- Exact JSON report Git blob9e2ed4ccf8b5aebd96e32d223c2e2987faea691d.
- Exact report gzip Git blob8ba92c130c139ceaee9ef3ee0ca557dd89bb55e1; gzip SHA2565b646a8f2d1ea94fa9c19662a590ce2028ca987555f37aff5ff91878dd2755a5.
- Candidate/source/report artifact14755805270,32,448,976 bytes; ZIP SHA256887c653d1815f2360064924091bdf52f800c72a19f71007b278d2fe69a1caef2.
