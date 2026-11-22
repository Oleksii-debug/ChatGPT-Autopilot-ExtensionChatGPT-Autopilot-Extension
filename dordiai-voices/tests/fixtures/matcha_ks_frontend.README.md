The JSON fixture contains actual native Kashmiri tokenizer and normalization
tables from gaash-lab/Bolbosh (MIT), source revision
7435b77029a691cc00a335356013ca6ee78f794a, and Abdul Muizz's
KashmiriNormalizer (MIT), revision 9bb966e76b88caf875bfb9facf3036bef706427e.
Exact source URLs and SHA256 pins are in tools/matcha_checkpoint_sources.json.
The fixture permits meaningful token-preservation tests without downloading a
large acoustic model in every source-only CI job.
