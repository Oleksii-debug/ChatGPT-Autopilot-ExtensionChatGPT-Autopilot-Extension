# Future source13 optional-default candidate: actual configuration API proof

The held-back driver/helper candidate uses exact base driver a2759e35a5091a7c2c0c1bc9a09c780eadad4b88. Source12 remains unchanged.

The chosen optional default applies only to genuinely unmarked segments. It preserves named/typed origin priority, restores an observed original locale when NVDA omits a redundant same-locale command, and leaves forced/disabled primary policy authoritative. The original speech sequence and its source objects are not mutated.

Choices are filtered by verified PERSONAL metadata, installed catalog entries and enabled languages. The legacy external PERSONAL catalog is not imported into the selected installed catalog by this patch; normal stock behavior therefore remains Auto. No optional language/model support is added or claimed.

The actual frozen NVDA 2026.3.1 host passed all 29 configuration invariants in run 45046562415. It confirmed actual DriverSetting(useConfig=False), actual classmethod spec generation and MRO, enabled-state-before-choice loading, actual two-profile disk isolation, absent/disabled reset and save, and cleanup. The built-in silence synth remained selected, and both owned profiles were removed.

This was a configuration-only fixture on actual NVDA classes using seven exact candidate methods and the real PreferencesMixin. Gagauz and its voice entry were explicitly metadata-only fixtures. No product addon, model, private interpreter or audio engine was installed; optional-language synthesis and physical audio remain unverified.

Twenty-one policy/profile unit tests passed. The isolated snapshot plus candidate/probe overlays passed 1,325 tests total (1,273 passed, 52 skipped). This was restored snapshot 09f4 plus the listed overlays, not the latest complete root branch; combined source13 integration checks remain necessary.

Exact host report: a962e2cdcddb1b04f98b06d729b260ed929467cd.
Exact engineering gzip: f74cdddbe41404fd087185224bc3298c5eb0c1f1.
The companion candidate index records complete paths, base hashes, artifact hashes and scope.
