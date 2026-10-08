# Plan 7 Sections 1–2 — 11.0.13 source-level handoff

**Engineering status:** IN_PROGRESS; neither section terminal DONE. The canonical 11.x product source is PR #654's `fix/11.0.13-post-send-dwell-background` branch at `ca7062e1f8e47b26d7e024c46bb432d341621dd4`. **Do not** ship or merge this PR into stale 0.9.19 `main` as though it were the 11.x product.

## Section 1: SDK / CLI / Local API

Reused `src/core/autopilot-programmatic-control.js` and test fixtures from PR #414 (original programmatic contract); no scheduler or policy fork. The protocol remains numeric `schemaVersion:1` and rejects unknown operations or mismatched `principalId`, `projectId`, `requestId`, `operation`, target/payload identity, scope lifetime and dispatch receipt.

New opt-in Native Companion entrypoint:
- `companion/local-api/server.mjs` exports `startAutopilotLocalApiLoopbackV1({token,dependencies}, port)`, binds explicitly to `127.0.0.1` and does not start at import time. No LAN/cloud service or implicit enable flag.
- `dependencies` **must** be supplied by the privileged existing Core/Native integration with `resolveTrustedScope`, `dispatchCanonicalControl`, `now`. Only the canonical Core may grant ALLOW/ASK/DENY, budget, approval, exact-effect and identity rights; the Local API cannot mint them.
- Provide a fresh high-entropy owner-scoped token outside source/config committed to Git. Do not put API tokens in argv, JSON request bodies, local journals, telemetry or PR comments. Rotate/revoke it through an existing trusted companion credential lifecycle. The new adapter **does not implement token lifecycle by itself**.
- `POST http://127.0.0.1:<trusted port>/v1/control`, `Authorization: Bearer <token>`, `Content-Type: application/json`, at most 65,536 bytes. Any Origin or preflight request is rejected; no CORS grant. Unknown API versions fail closed.
- `companion/local-api/client.mjs` sends the same canonical request identity. A failed HTTP response, timeout, malformed receipt or disconnection is `UNKNOWN_NETWORK_RESULT`, not confirmation that no effect occurred. **Do not retry** until the canonical job/effect authority has reconciled the exact requestId.
- The Ukrainian CLI `node companion/local-api/cli.mjs --help` is keyboard/screen-reader compatible; it reads requests from stdin and outputs plain UTF-8 JSON, but should not be exposed or advertised to end users while the production Companion binding is not wired.

Supported protocol enums currently include agent start/pause/resume/stop, status/plan/evidence, project, outcome, artifact, provider capabilities, read-only model catalog, approval decision, Recipe/Skill triggers and event subscription command forwarding. Existence of an enum **does not** imply that the production Native Companion has activated that canonical route.

## Section 2: ROI / owner-time economy

- Original `src/core/roi-opportunity-engine.js` is the trusted proof-based projector, not a second ledger. Unsafe resolver accessors are rejected before invocation.
- `src/core/roi-owner-advisory.js` is local-only, read-only and advisory. Offline state does not serve cached metrics as current. Insufficient evidence has no numeric ROI. Estimated time savings remain an interval, observed savings are separate, negative net owner time is allowed, and spend is explicitly USD micros.
- Automated/deployed model routing claims are forbidden absent trusted comparative source evidence. `shorterModelPath='NOT_EVALUATED'`. Recipe/tool suggestions require independently approved owner policy and Core qualification.
- `src/ui/roi-owner-view.js` renders a semantic landmark, named heading, polite live region, definition list and captioned table using `textContent`. It has no visual-only control or hidden action.

## Focused qualification

`.github/workflows/plan7-sdk-roi-qualification.yml` runs Node 22 syntax and test cases on **Ubuntu and Windows**, bound to exact PR head. Separate baseline regressions and release packaging workflows must be checked, not assumed.

Cases include: schema mismatch, wrong scope/identity, malformed getters/accessors, host/origin/authorization denial, too-large malformed payload, local Core failure, network ambiguity/no blind retry, CLI error redaction/help, trusted ROI history/freshness, offline/no evidence, exact money/owner-time bounds and UI semantics/injection safety.

## Remaining acceptance blockers (do not label DONE)

1. Sync/import exact 11.x source into canonical product branch and qualify source/provenance without overwriting 0.9.19 or invalidating other owner lanes.
2. Production Native Companion lifecycle and owner-specific auth/token rotation, durable request identity reconciliation, schema migration and policy/budget/approval/effect integration. No credential secrets in Git.
3. Owner-visible live UI/API wiring to canonical run evidence, restart/migration and human-time accounting; tests of actual state persistence and accessibility semantics.
4. Exact-head green Ubuntu/Windows/security tests, post-integration/packaging readback and synced GitHub+Drive Plan 7 terminal evidence. Physical Windows Chrome/NVDA is separately Plan 8; never fabricate `NVDA_VERIFIED`.
