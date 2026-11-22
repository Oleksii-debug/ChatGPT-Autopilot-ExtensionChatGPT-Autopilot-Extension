# Unpublished engineering backup and continuation

This document describes a backup mechanism. It does not assert that the backup job
has run or that the product is ready. The workflow receipt is the evidence of an
actual completed upload and verified read-back.

## Pinned dev9 bytes

- Source: `b364060750b4fda22eb7f06b5c52085c3f4e0bfc`.
- Source workflow run: `45014461174`.
- Source artifact: `dordiai-voices-development-core`, ID `14751826473`.
- Artifact wrapper SHA-256:
  `ef834320729e702fbbda4e4264f457605e1909a3a695e516631526e2f6d88fbf`.
- Actual installer: `dordiai-voices-0.13.1-dev.9.nvda-addon`.
- Installer size: 1,767,414,839 bytes (below the 2 GiB release-asset limit).
- Installer SHA-256:
  `9e59fb90b3ac8ed5ee322ce111234f9fbdf24a3d25a5f96c1097fc7cc25c9e8a`.

The wrapper checksum and installer checksum describe different files. Never
substitute one for the other. The source run completed with **failure** in its
Windows probe job; the installer artifact was produced before that failure.
Preserving it does not certify the failed job, pronunciation, live typing or
physical audio. `product_ready` remains false.

## Owned draft-only preservation

The isolated workflow is `.github/workflows/dordiai-core-backup.yml`.
It can run only in this repository on branch
`dordiai-voices/audit-20261122`, on explicit dispatch or a relevant push
whose commit contains `[backup-dev9]`. It requires `actions:read` to read
the existing artifact and `contents:write` for one unpublished draft.

The sole owned draft tag is
`dordiai-voices-dev9-engineering-backup`, targeted at the separate
storage anchor described below. The helper does not create or move Git refs, publish a release,
generate release notes, announce anything, or overwrite/delete assets.
The storage anchor is existing main commit
`096a5e8b0a3f97aa3199106ff88c3009e7fc7bc4`, **not** the binary's source commit.
The receipt separately records `storage_anchor_commit` and
`binary_source_commit=b364060750b4fda22eb7f06b5c52085c3f4e0bfc`.
GitHub restricts GITHUB_TOKEN when creating releases at commits that change
workflow files relative to the default branch; using the current main commit as
a storage anchor avoids requesting broader workflow permissions.
Before creating the draft, the helper verifies main still has exactly this
anchor. It never changes main or automatically retargets an existing tag/draft.
An existing tag must already resolve to the pinned storage-anchor commit.
An existing draft must match the exact ownership body, tag, target, title,
prerelease flag and unpublished status. Unknown or duplicate assets stop the job.

The helper first hashes the local installer. It creates the draft only after that
check and source/artifact API identity checks. Uploads stream in bounded chunks.
It verifies stored assets by downloading and hashing the actual bytes, strips
authorization before GitHub storage redirects, and never logs credentials or
signed URLs. Re-running the job accepts matching assets without replacement.
A failed or interrupted upload is left intact for inspection; the helper will
not silently replace it. Only a successful final receipt demonstrates completion.

The draft contains exactly the installer and
`dordiai-core-dev9-backup-receipt.json`. The receipt records the core
checksum, separate binary source/storage anchor, draft and asset IDs, verified
read-back and product limitations.
A small 90-day Actions receipt copy is optional convenience; the draft asset is
the long-lived copy and is retained until an owner deletes it or the repository.
Draft assets require repository write access. They are not public downloads.
No default branch is changed.

## Recover without the original Drive archive

Fetch the draft's installer asset through GitHub authentication, keep the token
out of logs, and verify its exact size and SHA above. Do not execute archived
code to inspect it. A future agent can run the standard-library recovery helper:

```sh
python dordiai-voices/tools/recover_core_baseline.py \
  --archive dordiai-voices-0.13.1-dev.9.nvda-addon \
  --expected-sha256 9e59fb90b3ac8ed5ee322ce111234f9fbdf24a3d25a5f96c1097fc7cc25c9e8a \
  --output recovered-dev9-baseline \
  --evidence recovered-dev9-baseline.json
```

Recovery verifies every declared payload hash, rejects unsafe ZIP members and
publishes a new baseline atomically. It omits the generated release manifest from
future builder inputs. It preserves the retained 45 profiles and all core model,
runtime and prepared-bank bytes. It does not reconstruct optional Piper, Wide,
Slovak, MMS, Rasa, Matcha or other resource packs absent from the core.

At the pinned source commit, a core-only rebuild can use that recovered baseline:

```sh
python dordiai-voices/tools/build_release.py \
  --baseline recovered-dev9-baseline \
  --source dordiai-voices/source/0.12.2 \
  --version 0.13.1-dev.9 --only core --output rebuilt-dev9
python dordiai-voices/tools/verify_release.py \
  rebuilt-dev9/dordiai-voices-0.13.1-dev.9.nvda-addon
```

This is a recovery recipe, not a newly claimed exact dev9 rebuild result.
Record the observed outer archive hash and full payload comparison if executed.
A future source overlay can target a new explicit version without altering the
immutable original backup.

The earlier four-part dev4 backup remains an independent recovery route.
Optional MMS native FP32 packs are reproducible through
`.github/workflows/dordiai-mms-packs.yml`; run `45014461158` built and
verified 29 separate packs with original weights, checksums and install/uninstall
round trips. Their Actions artifacts expire; the pinned source/model recipe and
durable report remain necessary. Do not claim that a source recipe itself
contains model binaries.

## Future supplemental prepared banks

The optional builder hook `--prepared-bank-overlay PATH.zip` uses
`tools/prepared_bank_overlay.py`. The overlay must contain the complete
180 retained letter/command bank files and its strict identity manifest. The
validator checks the original bank hashes and prefixes, append-only indices,
retained voice IDs, model/worker identity and generated clip provenance. The
runtime is not changed by this hook.

No generated supplemental overlay is included in the dev9 backup described here.
Exact newly generated PCM is not recoverable from source code alone. Before using
a generated overlay as a release-builder input, preserve its **actual ZIP bytes**,
size/SHA, generation report and exact generator/validator commit as a separately
authorized engineering-backup asset. Do not append it to this draft with a loose
filename wildcard: the current helper intentionally permits only the two dev9
asset names. Extend and test an explicit pinned asset identity first. A future
core built with an overlay must record the overlay hash and be kept separate from
the original dev9 archive.
