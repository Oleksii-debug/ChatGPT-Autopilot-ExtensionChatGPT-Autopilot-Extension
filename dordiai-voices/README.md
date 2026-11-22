# dordiai-voices — recovered baseline, 22 November 2026

This directory is an isolated workspace inside the temporarily reused Autopilot repository. Its existing application is independent of this work.

- `source/0.12.2/`: exact recovered editable Python, documentation and selected JSON configuration from the main NVDA add-on.
- `source/unified-0.3.10/`: corresponding snapshot from the unified add-on.
- `AUDIT_UK.md`: findings and next steps in Ukrainian.
- `evidence/summary.json`: machine-readable validation results.
- `evidence/archive_inventory.json.gz`: complete file inventory, checksums and duplicate verification.
- `tools/restore.py`: download and restore the exact binary baselines from the user's shared archive. Uses only Python's standard library. No connected Google Drive account is required.
- `tools/validate.py`: check syntax, registered resources and voice/language counts without starting NVDA or loading Windows DLLs.

## Restore and inspect

```sh
python dordiai-voices/tools/restore.py
python dordiai-voices/tools/validate.py
```

`restore.py` writes models and bundled Windows dependencies to ignored `packages/`. The source archive contains duplicate copies of the same two add-ons; only one verified copy of each unique package is needed. It checks SHA-256 of the download and both packages and rejects escaping archive paths and symbolic links before extraction. Allow approximately 17 GB of local space when starting from scratch, including retained downloads. Restoration depends on the original shared archive remaining available.

The snapshots are exact baseline files, not a new release. Make future edits in `source/` and overlay them into the corresponding restored package when preparing a candidate. Do not publish a candidate until it has been tested on Windows with NVDA. This Linux session checked code/data only; it did not verify audible quality, startup latency, interruption behavior, DirectML performance or screen-reader interaction.

The full original development tree, training material, native build sources and previous session logs were not included. No 1,800 MB installer was found. The included main package registers 121 language variants and 53 voice profiles; the unified package enables 10 languages and 3 voice profiles.
