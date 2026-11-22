# Immutable core10 backup and future continuation

Actual build45021069771 at source
`2bdababb86378f3cc6e58b934265175da589d703` produced
`dordiai-voices-0.13.1-dev.10.nvda-addon`, 1,974,796,411 bytes,
SHA-256 `437bb9394df5b44cb1a99edee21312f6255b8cc74622c0bcc15b3513e6c328d8`.
Its core artifact is14753953381, outer wrapper1,974,916,807 bytes,
wrapper SHA-256 `8759b0924bc9412332960b06c6e0a1736e7841416c864dbfda98fcd64f34bbe1`.

Actual Windows checks completed:812 tests/29skips, core and sampled additional
engines, native/shared MMS,176-character requests and300 repeated/cancel/switch
requests, nine real typing cases, and genuine missing-resource recovery.
The same archive checksum appears in all three actual NVDA controller reports.
This does not certify physical audio or pronunciation. The actual typing cases
also include word echo; their key-to-PCM times are not the2–3ms prepared-bank
microbenchmark. Detailed original reports:
`evidence/windows_dev10_run_45021069771.json.gz`.

The core includes the proved supplemental native banks:45 profiles,180 complete
bank files, all7,920 mapped prepared requests found, zero live-worker candidates
under the audited default mapping. The build validated9,939 source identity
inputs and preservation of old index entries/PCM prefixes. This is structural
and source binding evidence, not independent speaker/pronunciation acceptance.

## Separate draft backup

`.github/workflows/dordiai-core10-backup.yml` runs only on explicit
`[backup-dev10]` pushes or dispatch on the audit branch. It downloads the
one pinned existing artifact and runs `tools/draft_core10_backup.py`.
The isolated tool has explicit core10 constants; core9's helper, draft and assets
are unchanged.

The sole core10 draft tag is `dordiai-voices-dev10-engineering-backup`.
Its storage anchor is existing main commit
`096a5e8b0a3f97aa3199106ff88c3009e7fc7bc4`, distinct from the binary
source commit above. The helper never moves main, publishes, deletes or replaces
assets. It validates ownership, draft/unpublished state and exact names, then
verifies actual stored asset bytes by downloading/hashing them. It stores the
core and `dordiai-core-dev10-backup-receipt.json`. Re-runs reuse matching
assets and reject any conflict. The receipt includes merged-bank provenance and
`product_ready=false`.

This document records the recipe; only an actual successful backup/read-back
receipt proves that the core10 draft upload has completed.

## Resume without the original archive

After downloading and verifying the exact core10 asset, recover it with:

```sh
python dordiai-voices/tools/recover_core_baseline.py \
  --archive dordiai-voices-0.13.1-dev.10.nvda-addon \
  --expected-sha256 437bb9394df5b44cb1a99edee21312f6255b8cc74622c0bcc15b3513e6c328d8 \
  --output recovered-core10-baseline \
  --evidence recovered-core10-baseline.json
```

This verifies every payload before extraction, preserves the exact bank bytes,
and omits the generated release manifest from future builder inputs. It recovers
core resources only; optional language packs absent from core are not recovered.

For a future source11 build, supply the recovered core10 baseline and the future
reviewed source checkout, with an explicit new version. **Do not reapply the old
supplemental overlay1**: its source old-bank hashes describe core8/9, while core10
already contains the merged output. Without an overlay flag, the builder retains
those baseline native-bank assets automatically. No neural regeneration is
needed merely to continue source development.

Any later appended-bank overlay must bind to its actual new baseline and voice/
model identity. Never weaken identity guards to apply an older overlay twice.
The independent core9 draft plus separately preserved overlay1 remain a recovery
route for constructing core10 from the older bank baseline, subject to matching
source identity checks. No new exact rebuild is claimed by this document.
