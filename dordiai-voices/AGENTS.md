# dordiai-voices work instructions

The user authorized implementation on 22 November 2026 by saying `старт`.
The user explicitly authorizes subagents, automatic technical decisions and
available noncommercial model resources. Do not repeatedly ask for confirmation
or ask the user to perform technical setup. Record source licenses in packages.
These instructions do not override platform requirements or authorize access
to gated third-party resources without the required access.

## Product contract

- Read `FINAL_PRODUCT_SPEC_UK.md`, `selected_languages.json` and `WORK_STATE.json`.
- Target the complete selected catalogue and 45 allowed profiles, with native
  language/voice routing, correct character echo, accessible NVDA settings,
  low measured latency and reusable modular voice/model packages.
- Preserve original archives and `packages/0.12.2`. Put new acoustic resources
  under ignored `model-packs/`; keep preparation recipes and provenance in Git.
- Do not develop unified-0.3.10 or modify the unrelated Autopilot application.
- Exclude kostia, inna, dina, vira, innesa, veronika_classmate, anatolii and
  veronika from new active voices, request execution and release packaging.
- Keep existing multilingual routing independent of speaker-specific assets.
- No assembly/native-code rewrite is part of this task.

## Truthful acceptance and continuation

- Resource presence, a successful import or nonzero audio is not pronunciation,
  character-echo, latency or Windows/NVDA acceptance.
- Distinguish complete language coverage, explicit partial catalogue groups,
  text-only support and experimental slow engines. Do not silently substitute
  related languages or reduce requirements to match actual results.
- Continue independent work while another requirement is blocked. Do not end
  just because a timer expired, one change landed or a progress report was sent.
- Persist exact completed/open work and concrete external blockers. Never
  claim the full product complete while mandatory requirements are unverified.
- Give concise Ukrainian progress updates, without tables or re-listing all
  languages. Do not promise background work after a response has ended.

## Reproduction

Run the regression suite using `tests/requirements.txt`. Real model preparation
uses `tools/requirements-models.txt` and pinned local assets. Disable telemetry
before creating inference sessions; model execution must work locally without
network requests. Explicit downloads are a separate preparation operation.

GitHub branch: `dordiai-voices/audit-20261122` in the temporary repository.
Root coordinates external commits and branch updates; subagents work in
disjoint files and do not push or overwrite another agent's changes.

Use the versioned `evidence/source_snapshot_*.json.gz` and release reports;
the earliest dev.1 snapshot has its historical filename
`evidence/dev1_source_snapshot.json.gz`. Check exact source and archive hashes
before attributing a Windows run to a build.

Do not require the user to provide the original large archive again. A verified
core resource backup is saved as four `dordiai-core-0.13.1-dev.4-backup-00N.zip`
files plus its tools ZIP. `tools/restore_core_backup.py` reconstructs the exact
core SHA b80f0f2a428ba097b37437ccfd028ce41630b73fd92c5cfa9539da1b08a1b90e.
This old development build has a known Windows bootstrap bug; use it as
verified resource data, then overlay the latest code before launching the
add-on. Do not present the old build as an accepted installer. `tools/recover_core_baseline.py`
verifies and extracts only its payload, excluding generated release metadata.
An actual core4 + frozen source5 rebuild produced the identical dev5 ZIP:
see `evidence/recovered_core4_to_dev5_rebuild.json`. This recovers core resources,
not optional language models which were absent from that core.
