# Preserve supplemental prepared-bank bytes

The core9 backup has an independently verified draft-only upload/read-back:
workflow45018540296, release454406176. It does not contain subsequently generated
supplemental bank data. Keep the original core and its receipt unchanged.

## Commit an exact generated-data identity

The separate workflow is `.github/workflows/dordiai-bank-backup.yml`.
It is dormant without an explicit relevant push containing `[backup-banks]`
(or dispatch on the audited branch). Before triggering it, commit the reviewed
`dordiai-voices/evidence/supplementary_bank_backup_identity.json`
using **actual completed generation output and GitHub artifact metadata**.

The standard-library helper rejects missing fields, extra fields and loose
wildcards. Its exact identity fields are:

- `format`: `dordiai-data-backup-identity`; `format_version`: 1.
- `repository`: the existing Oleksii-debug project repository.
- `kind`: `prepared-bank-overlay`.
- `version`: the immutable generated overlay version.
- `storage_anchor_commit`: `096a5e8b0a3f97aa3199106ff88c3009e7fc7bc4`.
- `binary_source_commit`: exact generator workflow head commit.
- `source_workflow`: `.github/workflows/dordiai-supplementary-banks.yml`.
- `source_run_id`: completed successful generation run ID.
- `source_artifact`: exact `id`, `name` and `wrapper_sha256`.
  Name must be `supplementary-bank-overlay-VERSION`.
- `archive`: exact `filename`, `size_bytes` and `sha256`
  of the inner `dordiai-supplementary-banks-VERSION.zip`.
- `manifest`: exact `filename`, `size_bytes` and `sha256`
  of its `dordiai-prepared-bank-overlay.json` member.
- `source_core`: the overlay manifest's exact source-core
  `filename`, `size_bytes` and `sha256` record.
- `catalogue_sha256`: the overlay manifest's catalogue hash.
- `product_ready`: false.
- `quality_validation`: pronunciation, NVDA and physical_audio all
  `pending`, matching the generator's data-only declaration.

The full generation report records the inner archive record. The bounded
generation receipt or the exact hash-verified inner ZIP supplies the manifest
record. The source artifact wrapper hash is obtained from GitHub's artifact API;
it is **not** the inner ZIP hash. Do not infer any missing value.

The storage anchor is only the draft tag's target. It is distinct from both
the generator commit and the immutable acoustic source core. Using the pinned
default-branch anchor avoids GITHUB_TOKEN workflow-write restrictions while
leaving main unchanged. The helper verifies this anchor before initially
creating its isolated tag/draft; an existing owned draft must match it exactly.

## Verification and storage

The workflow tests the core and data backup helpers, downloads the one pinned
artifact, and verifies the inner archive hash before any remote mutation.
Without extracting or executing archived code, it checks the manifest hash,
exact45 profiles/excluded8 policy, source/catalogue identity, pending quality
declaration, exact180 data member paths and every new member's size/SHA.
All memory-heavy reads are streamed; no original model or OpenVoice weights are
copied into a bank overlay.

This backup check preserves declared new data bytes and structure. It does not
independently rerun neural generation, compare old bank prefixes against a core,
or certify pronunciation. The generation validator and release-builder overlay
hook perform the original-prefix/model binding checks when the overlay is
created or applied.

The owned release tag is
`dordiai-voices-banks-VERSION-engineering-backup`.
It remains a DRAFT. Only the exact overlay ZIP and
`dordiai-prepared-banks-backup-receipt.json` are permitted. Both assets
are downloaded and hashed after storage. Existing matching assets are reused;
mismatches, published drafts, unknown assets or changed ownership fail without
overwrite, deletion or publication. Neither a successful generation nor a
successful backup makes the product ready.

No backup identity with fabricated values is included in this recipe.
No actual supplemental overlay backup is claimed until its workflow completes
and the exact asset/read-back receipt is available.

## Resume

Download the draft overlay asset through GitHub authentication, verify its
recorded size/SHA, recover the required core baseline using the existing helper,
and use the matching generator/validator and source checkout. The optional
release-builder flag is `--prepared-bank-overlay VERIFIED_OVERLAY.zip`.
The validator must succeed against the supplied original bank bytes and model/
worker identity; never bypass it merely because a backup checksum matches.
Keep source snapshots, bank overlay bytes, generated core and their checksums
as separate immutable objects.
