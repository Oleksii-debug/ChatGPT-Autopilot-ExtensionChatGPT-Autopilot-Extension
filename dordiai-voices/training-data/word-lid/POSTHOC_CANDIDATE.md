# Frozen classifier posthoc audit

Run the workflow with [word-lid-evaluate] or manual dispatch. It downloads only the exact 26 MB training artifact 14753180217 from run45017654339; the API identity, source commit, byte count and artifact digest are pinned. It does not reacquire source archives, retrain, change thresholds or install a model. Output paths cannot overlap frozen inputs or audited source directories; reports publish atomically to new destinations without overwriting existing files.

The evaluator verifies candidate model bytes against evaluation.json, the prepared corpus against its fixed SHA256, and every train/validation/test count and digest against the frozen training report. Test spellings cannot appear in the training-only ambiguity guard.

Per-predicted-class precision counts only outputs actually emitted by that class. Single-label and multiple-label reference groups are separate. A match means membership in the weak source-label set; it does not establish the intended language of a homograph, native pronunciation or TTS quality. The 20-sample/98% reference flag is descriptive and cannot replace independent acceptance or justify threshold tuning on the final test.

The historical baseline uses the exact original runtime Git object e1d1d1cb691039d2c6804781f4cd785cd6d05573, not the expanded runtime. Its model and all original lexical partition digests must reproduce the historical report too. Paired comparisons use identical baseline reference labels and only spellings unseen by both recipes. Reports include the complete original target set and the Ukrainian/English/Russian enabled subset; both predictors retain their full model competition before enabled filtering.

Original archive parser tag counts determine whether the named-entity case fix changes any actual rows. Missing evidence stays unknown. If every affected-row count is zero, the same frozen prepared corpus/model can be bound to that harmless source-code correction. A nonzero count requires rebuilding the affected corpus and reconsidering the model.

CLI inputs and report fields are reusable with another reviewed frozen artifact; the workflow is deliberately pinned to this one. Model quality, release readiness, physical speech and automatic installation remain unverified/disabled.
