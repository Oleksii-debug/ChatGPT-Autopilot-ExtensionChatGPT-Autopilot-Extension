# ChatGPT Autopilot — повний реєстр самостійних розділів у незавершених планах

**Дата:** 2026-10-13. Повністю перевірено всі вісім планів: кожен самостійний розділ має верхньорівневий заголовок і власне завдання; нумерованих підпунктів немає. Історичні прогрес-нотатки архівні і не вважаються новими розділами.

**Робочий контракт:** NА/NБ/NВ/NГ — окремі рівноправні розділи. Початкове N в issue/PR/CI старих інструкціях означає сукупність всіх його нових розділів; N DONE лише після приймання кожного та загальної інтеграції. Не міняти чинні owner PR, 11.0.15 HIGH owner-final target, product source lineage; статуси WAITING/DEFERRED зберегти. Приклади і smoke tests не підміняють aggregate Release, власника або фізичний NVDA.

**Разом:** 297; DONE: 0; не DONE: 297.

## План 1: 45 самостійних розділів

[Актуальний Google Doc](https://docs.google.com/document/d/1EanwjZPzneKwTMvbomGfsFPWhzY-9b7azZcIgBdpj1g/edit)

| Розділ | Зміст | Статус |
| --- | --- | --- |
| 1А | Уніфікувати AgentJob/Definition/Plan/Node/Tool/Observation/Verification/Artifact/Handoff/Result contracts. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 1Б | Durable IDs охоплюють job/agent/parent/subagent/project/node/effect/artifact/checkpoint/control epoch/provider route. | Статус: PARTIAL_EXISTING_11_0_13 |
| 1В | Migration unknown-version fail-closed; restart/update не породжує duplicate/ownerless state. | Статус: PARTIAL_EXISTING_11_0_13 |
| 2А | Natural-language/prompt-first/reusable-definition/import paths converge to one validated job constructor. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 2Б | Outcome Contract defines observable DONE/evidence/constraints, not activity count. | Статус: PARTIAL_EXISTING_11_0_13 |
| 2В | Clarification only when required; safe deterministic evidence-gathering precedes owner interruption. | Статус: PARTIAL_EXISTING_11_0_13 |
| 3А | Create/edit/clone/import/export/version/enable/disable/delete with instructions/tags/capabilities/model defaults. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 3Б | Definition update never silently mutates active jobs; version binding explicit. | Статус: PARTIAL_EXISTING_11_0_13 |
| 3В | Library searchable/exportable and durable across extension updates. | Статус: PARTIAL_EXISTING_11_0_13 |
| 4А | Plan nodes have dependencies/conflicts/acceptance/evidence/owner and durable state. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 4Б | Replanning preserves completed work and records reason/version; stale async results cannot execute after revision. | Статус: PARTIAL_EXISTING_11_0_13 |
| 4В | Independent nodes run in parallel; dependency-bound nodes remain ordered. | Статус: PARTIAL_EXISTING_11_0_13 |
| 5А | One canonical job state machine and control epoch for owner intervention. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 5Б | Pause/Resume/Stop/follow-up invalidate stale model/tool callbacks and pending authority where required. | Статус: PARTIAL_EXISTING_11_0_13 |
| 5В | Cold wake/restart resumes exact state without duplicate external effects. | Статус: PARTIAL_EXISTING_11_0_13 |
| 6А | Reuse canonical scheduler only; MV3 alarms/watchdog are mechanisms, not scheduler #2. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 6Б | Time/window/event triggers survive worker termination/restart with no duplicate/missed effect within contract. | Статус: PARTIAL_EXISTING_11_0_13 |
| 6В | Long privileged local work runs via Companion while Core retains authority. | Статус: PARTIAL_EXISTING_11_0_13 |
| 7А | Checkpoint plan/context/artifacts/counters/pending reconciliation with exact hashes/version. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 7Б | Resume/rewind cannot falsify external-effect history; branch variants isolate internal work. | Статус: PARTIAL_EXISTING_11_0_13 |
| 7В | Recovery detects corrupt/stale checkpoints and provides bounded rollback. | Статус: PARTIAL_EXISTING_11_0_13 |
| 8А | Every consequential effect gets durable effect ID, precondition, attempt, observation and reconciliation state. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 8Б | Unknown/timeout/late response never blind-retries; read-after-write/reconcile before repeat. | Статус: PARTIAL_EXISTING_11_0_13 |
| 8В | Effect state survives crash, plane/provider/model changes. | Статус: PARTIAL_EXISTING_11_0_13 |
| 9А | Owner policy is sole permission authority; discovery/model/tool cannot self-authorize. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 9Б | ASK binds exact effect inputs/target/evidence/expiry; policy/follow-up change invalidates stale approval. | Статус: PARTIAL_EXISTING_11_0_13 |
| 9В | Batch/scoped approvals and durable WAITING_APPROVAL preserve accessible owner control. | Статус: PARTIAL_EXISTING_11_0_13 |
| 10А | Credentials remain opaque references in protected storage; never model/prompt/log/artifact payload. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 10Б | Origin/account/provider binding, expiry/revocation/rotation and least privilege explicit. | Статус: PARTIAL_EXISTING_11_0_13 |
| 10В | Login failure/security challenge never bypassed; user-owned manual intervention reconciles state. | Статус: PARTIAL_EXISTING_11_0_13 |
| 11А | Unify runtime/actions/model calls/tokens/USD/child agents/browser/desktop/storage/retry ceilings. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 11Б | Reserve/commit/refund usage against actual model/provider/tool routes, including reconciliation/retry semantics. | Статус: PARTIAL_EXISTING_11_0_13 |
| 11В | Budget exhaustion pauses/degrades deterministically; cannot silently overspend. | Статус: PARTIAL_EXISTING_11_0_13 |
| 12А | Versioned tool/capability descriptors include schemas/risk/health/provider/required policy. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 12Б | Normalize DOM/UIA/API/file/provider observations into provenance/freshness/uncertainty-aware world state. | Статус: PARTIAL_EXISTING_11_0_13 |
| 12В | Unknown/stale/contradictory facts stay explicit; discovery never grants permission. | Статус: PARTIAL_EXISTING_11_0_13 |
| 13А | Separate working/episodic/semantic-project/procedural memory; execution truth stays in canonical state. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 13Б | Compaction preserves invariants/source refs/negative failure memory and corrects stale memory. | Статус: PARTIAL_EXISTING_11_0_13 |
| 13В | Delta context capsules/retrieval minimize repeated rereads without outranking live source. | Статус: PARTIAL_EXISTING_11_0_13 |
| 14А | Artifacts bind source/effect/job/version/provenance/verification and lifecycle/retention. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 14Б | Deterministic No-AI path executes eligible recipes/tools without model dependency; Hybrid escalates only when needed. | Статус: PARTIAL_EXISTING_11_0_13 |
| 14В | Final result is verified artifact/effect outcome, not chat prose or model self-report. | Статус: PARTIAL_EXISTING_11_0_13 |
| 15А | Run long-horizon restart/control/effect/policy/budget/context/artifact/no-AI scenarios on exact 11.x candidate. | Статус міграції: OPEN |
| 15Б | Verify no duplicate effects, stale authority, hidden model dependency or context corruption. | Статус: OPEN |
| 15В | Record terminal Plan-1 DONE in multi-plan registry. | Статус: OPEN |

## План 2: 45 самостійних розділів

[Актуальний Google Doc](https://docs.google.com/document/d/1LWRjRhYYv1jQE3CXeDZg20Dn8WD3EJJbKtXNcsohsCo/edit)

| Розділ | Зміст | Статус |
| --- | --- | --- |
| 1А | DOM/ARIA/accessibility tree target identity, deterministic actions and postcondition verification. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 1Б | Handle navigation/forms/tables/dialogs/upload/download/common editors without coordinate dependence. | Статус: PARTIAL_EXISTING_11_0_13 |
| 1В | Prompt injection/untrusted page data never gains policy authority. | Статус: PARTIAL_EXISTING_11_0_13 |
| 2А | Fallback only when semantic path insufficient; screenshot/region/target evidence versioned. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 2Б | Coordinate actions require bounded target validation and postcondition; UI drift fails safely. | Статус: PARTIAL_EXISTING_11_0_13 |
| 2В | Retention/privacy limits and deterministic visual fixtures required. | Статус: PARTIAL_EXISTING_11_0_13 |
| 3А | Adopted user tabs never silently closed; extension-owned targets durable and restart-safe. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 3Б | BrowserTargetLease prevents mutating collisions among agents/providers. | Статус: PARTIAL_EXISTING_11_0_13 |
| 3В | Root/new-chat/concrete conversation semantics explicit and recoverable. | Статус: PARTIAL_EXISTING_11_0_13 |
| 4А | Scripts execute only in explicit sandbox/allowlist with provenance and effect IDs. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 4Б | Filesystem path roots/scopes, read/write/create/delete semantics and atomic writes versioned. | Статус: PARTIAL_EXISTING_11_0_13 |
| 4В | Downloads/uploads preserve hashes/source/job ownership and cleanup. | Статус: PARTIAL_EXISTING_11_0_13 |
| 5А | Authenticated handshake/version/capability negotiation; Core remains scheduler/policy/effect authority. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 5Б | Long local processes survive extension sleep with checkpoints/status/cancel/reconcile. | Статус: PARTIAL_EXISTING_11_0_13 |
| 5В | No unrestricted native command surface or silent privilege expansion. | Статус: PARTIAL_EXISTING_11_0_13 |
| 6А | Semantic UIA/window/process identity, accessible control patterns and postcondition evidence. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 6Б | App restart/UI drift/stale HWND recovery; prefer object/API/CLI when safer. | Статус: PARTIAL_EXISTING_11_0_13 |
| 6В | Physical Windows fixtures required before component terminal, final NVDA in Plan 8. | Статус: PARTIAL_EXISTING_11_0_13 |
| 7А | Typed command/API capabilities with cwd/env/input/output/exit/effect contracts. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 7Б | Sandbox/allowlist/secrets/redaction/timeout/cancel/reconcile enforced. | Статус: PARTIAL_EXISTING_11_0_13 |
| 7В | Direct deterministic path preferred over fragile UI automation. | Статус: PARTIAL_EXISTING_11_0_13 |
| 8А | Structured provider request/result contracts for Google/Microsoft/local office artifacts. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 8Б | Preserve document/spreadsheet/slide semantics, source refs, versioning and accessibility validation. | Статус: PARTIAL_EXISTING_11_0_13 |
| 8В | Final artifact inspected/verified before Agent marks outcome DONE. | Статус: PARTIAL_EXISTING_11_0_13 |
| 9А | Read/write repository/issues/PR/branches/checks through exact repository/identity/effect contracts. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 9Б | Refresh live state before mutation; preserve parallel work and reconcile conflicts. | Статус: PARTIAL_EXISTING_11_0_13 |
| 9В | Commit/PR/check/evidence refs stored in plan/verifier artifacts. | Статус: PARTIAL_EXISTING_11_0_13 |
| 10А | Use official providers where available; exact account/file/message/event/publish identities. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 10Б | Publishing/send/create/update/delete are consequential effects with verification/rollback/compensation where possible. | Статус: PARTIAL_EXISTING_11_0_13 |
| 10В | Browser fallback never becomes hidden second provider authority. | Статус: PARTIAL_EXISTING_11_0_13 |
| 11А | Allowlisted stdio/approved remote transports with server identity/version/license/provenance. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 11Б | Map MCP tools/resources into canonical Capability/Policy/Artifact/effect contracts. | Статус: PARTIAL_EXISTING_11_0_13 |
| 11В | Lifecycle/restart/server disappearance handled without second agent runtime. | Статус: PARTIAL_EXISTING_11_0_13 |
| 12А | Authenticated remote agent cards/capabilities and scoped task/result envelopes. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 12Б | Child/remote authority <= parent, context minimized, results locally verified. | Статус: PARTIAL_EXISTING_11_0_13 |
| 12В | Actual remote execution activation may be later Plan 5; protocol adapter closes here. | Статус: PARTIAL_EXISTING_11_0_13 |
| 13А | Fast owner-selected text/page/file/action entry maps into canonical jobs/effects. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 13Б | Cross-app multi-step effects use transaction/compensation/reconciliation semantics. | Статус: PARTIAL_EXISTING_11_0_13 |
| 13В | No hidden clipboard leakage or unverified chained side effects. | Статус: PARTIAL_EXISTING_11_0_13 |
| 14А | Preview/staging/test/accessibility/performance/publish/synthetic verify/monitor/repair/rollback as versioned recipe. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 14Б | Provider deployment state and external effects verified independently. | Статус: PARTIAL_EXISTING_11_0_13 |
| 14В | Generic loop reusable across websites/apps without owning project-specific business logic. | Статус: PARTIAL_EXISTING_11_0_13 |
| 15А | Run browser/files/Companion/Windows/CLI/docs/GitHub/Google/MCP/provider scenarios with failure/restart/injection fixtures. | Статус міграції: OPEN |
| 15Б | Verify exact-effect safety, target ownership, account identity and provider unavailability handling. | Статус: OPEN |
| 15В | Record terminal DONE. | Статус: OPEN |

## План 3: 48 самостійних розділів

[Актуальний Google Doc](https://docs.google.com/document/d/1FgqO_2mbIt3ljvn8GN0hX7G_KZCVkoMqcuTCU6YxViY/edit)

| Розділ | Зміст | Статус |
| --- | --- | --- |
| 1А | Versioned specialist definitions for research/code/browser/windows/data/artifact/design/QA/release/CMS/vision/communication. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 1Б | Readiness resolves provider/model/execution plane/budget/policy before lease. | Статус: PARTIAL_EXISTING_11_0_13 |
| 1В | Unavailable specialist degrades/blocks explicitly, not phantom-ready. | Статус: PARTIAL_EXISTING_11_0_13 |
| 2А | Parent→child purpose/node/capability/tool/model/budget/deadline/result envelope; child authority <= parent. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 2Б | Durable agent tree and lease/reconciliation survive restart. | Статус: PARTIAL_EXISTING_11_0_13 |
| 2В | No permission/budget/context amplification or orphan subagents. | Статус: PARTIAL_EXISTING_11_0_13 |
| 3А | Terminal/change events release capacity and trigger refill; watchdog pulse only fallback. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 3Б | Conflict keys/leases, contradiction detection, backpressure, fanout/fanin and early branch cancellation. | Статус: PARTIAL_EXISTING_11_0_13 |
| 3В | Parallelism minimizes critical path without duplicate mutation. | Статус: PARTIAL_EXISTING_11_0_13 |
| 4А | OpenHands-class/provider coding tasks run isolated with explicit repo/branch/artifact/evidence contracts. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 4Б | Result is diff/tests/commit/PR/evidence, not textual claim. | Статус: PARTIAL_EXISTING_11_0_13 |
| 4В | Conflicts/dirty worktree/stale base reconciled before integration. | Статус: PARTIAL_EXISTING_11_0_13 |
| 5А | Critical outcomes verified by independent role/provider/evidence, never same model self-assertion alone. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 5Б | Run relevant unit/integration/e2e/API/link/form/accessibility/artifact checks automatically. | Статус: PARTIAL_EXISTING_11_0_13 |
| 5В | Verifier can reject/return repair packet; no direct unauthorized mutation. | Статус: PARTIAL_EXISTING_11_0_13 |
| 6А | Successful verified traces become candidate deterministic Recipes/Skills after secret sanitization and parameter inference. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 6Б | Replay/evals/versioned promotion required; drift falls back to Agent reasoning. | Статус: PARTIAL_EXISTING_11_0_13 |
| 6В | Production recipes never self-modify outside gate. | Статус: PARTIAL_EXISTING_11_0_13 |
| 7А | Projects bind instructions/sources/repos/Drive/artifacts/decisions/tasks/unresolved work with revision-aware capsules. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 7Б | Live source outranks project memory; accepted outputs write back with provenance. | Статус: PARTIAL_EXISTING_11_0_13 |
| 7В | Cross-chat/model continuation requires no manual re-explanation. | Статус: PARTIAL_EXISTING_11_0_13 |
| 8А | Time/calendar/GitHub/email/Drive/web/file/terminal events start/continue canonical jobs. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 8Б | Action Center consolidates ASK/blocker/results requiring owner attention. | Статус: PARTIAL_EXISTING_11_0_13 |
| 8В | Event dedupe and replay survive restart. | Статус: PARTIAL_EXISTING_11_0_13 |
| 9А | Matrix tasks across files/repos/pages/records/chats/sites with per-cell identity and bounded fanout. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 9Б | Reusable prompt/instruction assets versioned/tested/provenanced; not hidden system authority. | Статус: PARTIAL_EXISTING_11_0_13 |
| 9В | Partial failures/retries/reconciliation do not duplicate completed cells. | Статус: PARTIAL_EXISTING_11_0_13 |
| 10А | Permission-aware search across Project/GitHub/Drive/Gmail/local/artifacts/evidence with freshness/source refs. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 10Б | Artifact workspace/canvas directly manipulates versioned artifact, never disconnected mock. | Статус: PARTIAL_EXISTING_11_0_13 |
| 10В | Complete keyboard/NVDA semantic twin for tree/properties/variants/commands/status/comparison. | Статус: PARTIAL_EXISTING_11_0_13 |
| 11А | Owner can take over browser/desktop/artifact, correct state, then hand back after fresh observation/reconciliation. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 11Б | Accessible Draft/Ready/Active/Review/Blocked/Done board supports plan-while-executing and dependency/conflict view. | Статус: PARTIAL_EXISTING_11_0_13 |
| 11В | Variants compare artifacts/tests/cost/evidence without replaying external effects. | Статус: PARTIAL_EXISTING_11_0_13 |
| 12А | Choose API/provider→CLI/object→semantic browser/UIA→visual fallback using health/cost/privacy/verification. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 12Б | Project Bootstrap discovers sources/repositories/artifacts/context and creates initial truth capsule safely. | Статус: PARTIAL_EXISTING_11_0_13 |
| 12В | Recommendation does not install/authenticate/grant permission. | Статус: PARTIAL_EXISTING_11_0_13 |
| 13А | Owner review surfaces changes/effects/evidence/risks/decisions only, fully accessible. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 13Б | Batch related decisions and gather safe evidence before escalation. | Статус: PARTIAL_EXISTING_11_0_13 |
| 13В | Measure/optimize owner attention, not agent activity. | Статус: PARTIAL_EXISTING_11_0_13 |
| 14А | Incremental invalidation/recompute from source changes; stale derived context invalidated. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 14Б | Contradictory sources resolved by explicit authority/freshness rules, never silent summary preference. | Статус: PARTIAL_EXISTING_11_0_13 |
| 14В | Cross-project reusable knowledge detects duplicates without leaking permissions/secrets. | Статус: PARTIAL_EXISTING_11_0_13 |
| 15А | Shadow autonomy executes/simulates under non-consequential policy and compares predicted vs verified effects. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 15Б | Run debugger replays evidence/state transitions without blindly re-executing effects; alternate model/plan branches safe. | Статус: PARTIAL_EXISTING_11_0_13 |
| 15В | Accepted work updates Project patterns/recipes/negative failure memory through gated learning. | Статус: PARTIAL_EXISTING_11_0_13 |
| 16А | Run multi-agent/subagent/project/verifier/recipe/batch/search/canvas/attention/change/debug scenarios with restart/conflict/adversarial cases. | Статус міграції: OPEN |
| 16Б | Measure duplicate-work rate, verified outcome synthesis, owner-attention and recovery. | Статус: OPEN |
| 16В | Record terminal DONE. | Статус: OPEN |

## План 4: 45 самостійних розділів

[Актуальний Google Doc](https://docs.google.com/document/d/1fx4sR_jCfIoKlFHPed7chAr5zy2eJKwWRQq_mjuALh4/edit)

| Розділ | Зміст | Статус |
| --- | --- | --- |
| 1А | Versioned Provider/Model/Profile/Route/Evidence identities and immutable config/evidence hashes. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 1Б | Endpoint profiles distinguish local/remote/account/origin/capabilities without embedding secrets. | Статус: PARTIAL_EXISTING_11_0_13 |
| 1В | Schema migration/fail-closed unknown versions and exact route provenance. | Статус: PARTIAL_EXISTING_11_0_13 |
| 2А | Opaque credential references; local endpoints may be credentialless only by explicit profile. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 2Б | Ollama/LM Studio/OpenAI-compatible adapters normalize capabilities/errors/usage. | Статус: PARTIAL_EXISTING_11_0_13 |
| 2В | Local-only policy never remote-fallbacks silently. | Статус: PARTIAL_EXISTING_11_0_13 |
| 3А | Adapter boundary normalizes models, usage, errors, streaming/tool/multimodal capabilities. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 3Б | Account/provider identity and privacy/locality metadata exact. | Статус: PARTIAL_EXISTING_11_0_13 |
| 3В | Unavailable/unconfigured provider is normal readiness state. | Статус: PARTIAL_EXISTING_11_0_13 |
| 4А | Discover/refresh models safely and cache source/version/freshness. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 4Б | Profiles bind role/capability/context/tool/multimodal/privacy/cost defaults. | Статус: PARTIAL_EXISTING_11_0_13 |
| 4В | Catalog availability is advisory; routing applies owner policy. | Статус: PARTIAL_EXISTING_11_0_13 |
| 5А | Versioned pricing/source timestamp; unknown cost never assumed free. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 5Б | Token/credit/USD usage attributed to job/agent/node/provider/model/attempt. | Статус: PARTIAL_EXISTING_11_0_13 |
| 5В | Global/per-agent/subagent budgets reserve/commit/reconcile across retries/failover. | Статус: PARTIAL_EXISTING_11_0_13 |
| 6А | Health distinguishes auth/quota/rate/network/model/capability failures with TTL/backoff. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 6Б | Role taxonomy and readiness combines health/capability/evals/policy. | Статус: PARTIAL_EXISTING_11_0_13 |
| 6В | Canaries bounded and never leak user content unnecessarily. | Статус: PARTIAL_EXISTING_11_0_13 |
| 7А | Primary/strong/hybrid plus pin/allow/deny/free-only/locality/max-cost/auto-switch policy. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 7Б | Candidate score uses task role/capability/health/context/cost/latency/privacy/eval evidence. | Статус: PARTIAL_EXISTING_11_0_13 |
| 7В | Policy always dominates adaptive recommendation. | Статус: PARTIAL_EXISTING_11_0_13 |
| 8А | Failover preserves Agent/job/node/effect identity and remaining budget/context. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 8Б | Quota/rate/token semantics feed back into dispatch; circuit/backoff avoids storms. | Статус: PARTIAL_EXISTING_11_0_13 |
| 8В | Cancellation/late response cannot execute stale action or double-account usage. | Статус: PARTIAL_EXISTING_11_0_13 |
| 9А | Allocate models across parallel agents by capacity/budget/priority/fairness. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 9Б | Context-window/prompt construction/truncation compatibility measured before route. | Статус: PARTIAL_EXISTING_11_0_13 |
| 9В | Cross-model handoff preserves task state/evidence/context identity, not prose-only summaries. | Статус: PARTIAL_EXISTING_11_0_13 |
| 10А | Vision/audio/multimodal route only to capable/allowed models with source/privacy refs. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 10Б | Tool/structured schemas validated before use; malformed/extra fields fail safely. | Статус: PARTIAL_EXISTING_11_0_13 |
| 10В | Model response is advisory until runtime/tool/verifier validates consequential claims. | Статус: PARTIAL_EXISTING_11_0_13 |
| 11А | Golden/generated/adversarial datasets versioned by role/task family. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 11Б | Readiness/promotion compares quality/latency/cost/rework/verifier-pass with rollback. | Статус: PARTIAL_EXISTING_11_0_13 |
| 11В | Council/multi-model review bounded; consensus never replaces evidence. | Статус: PARTIAL_EXISTING_11_0_13 |
| 12А | AI Manager observes routing/provider/model evidence and proposes bounded config changes. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 12Б | Auto-apply only within owner-approved safe policy with rollback and canary/shadow. | Статус: PARTIAL_EXISTING_11_0_13 |
| 12В | Web report/handoff exposes evidence/explanation, no hidden model authority. | Статус: PARTIAL_EXISTING_11_0_13 |
| 13А | Persist/migrate/backup model configs/routes/eval history safely. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 13Б | Keyboard/NVDA complete Models UI with readiness/eval/routing explanation and diagnostics. | Статус: PARTIAL_EXISTING_11_0_13 |
| 13В | Data-locality/security, restart/chaos, latency/large-pool scaling measured and enforced. | Статус: PARTIAL_EXISTING_11_0_13 |
| 14А | Stable API/SDK boundary for catalog/route/eval/policy/usage without second router. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 14Б | Adaptive best-route uses empirical verifier/cost/latency/rework; FAST/MEDIUM/SLOW effort is explicit policy input. | Статус: PARTIAL_EXISTING_11_0_13 |
| 14В | Shadow routing qualifies changes before production and supports rollback. | Статус: PARTIAL_EXISTING_11_0_13 |
| 15А | Run local+fixture remote provider, routing/failover/budget/eval/manager/security/restart/accessibility scenarios. | Статус міграції: OPEN |
| 15Б | Real provider/account acceptance remains Plan 8; unavailable accounts do not block engineering DONE. | Статус: OPEN |
| 15В | Record terminal Plan-4 DONE. | Статус: OPEN |

## План 5: 30 самостійних розділів

[Актуальний Google Doc](https://docs.google.com/document/d/1uSdYSarW52E9H7RkekA_wQ_7EgYR-xgiVdn51w5unQQ/edit)

| Розділ | Зміст | Статус |
| --- | --- | --- |
| 1А | Persistent cloud workspace maps onto same job/node/effect/policy/artifact identities as local Core. | Статус міграції: DEFERRED_LATER_WAVE |
| 1Б | Local↔cloud handoff must preserve exact task/effect state, checkpoints and policy; no scheduler/runtime #2. | Статус: DEFERRED_LATER_WAVE |
| 1В | Filesystem/browser/process resources isolated and scrubbed after job. | Статус: DEFERRED_LATER_WAVE |
| 2А | Authenticated status/instruction/ASK/pause/resume/stop/handoff over same durable job. | Статус міграції: DEFERRED_LATER_WAVE |
| 2Б | Remote command uses control epoch and cannot race stale local execution. | Статус: DEFERRED_LATER_WAVE |
| 2В | Evidence compact but sufficient; no second orchestration state. | Статус: DEFERRED_LATER_WAVE |
| 3А | Durable user/org/agent/service identities, project permissions, credential ownership and org policy. | Статус міграції: DEFERRED_LATER_WAVE |
| 3Б | Tenant isolation, audit attribution, revocation/rotation and shared handoffs/agents/recipes. | Статус: DEFERRED_LATER_WAVE |
| 3В | Subagent/remote identities remain bounded by parent/org policy. | Статус: DEFERRED_LATER_WAVE |
| 4А | Pack Agent definitions/Recipes/resources/evals/provider bindings with signatures/provenance/licenses/dependencies. | Статус міграції: DEFERRED_LATER_WAVE |
| 4Б | Import preview and permission/dependency review; no automatic trust or arbitrary-code escalation. | Статус: DEFERRED_LATER_WAVE |
| 4В | Local/private/team catalogs first; marketplace distribution behind explicit policy. | Статус: DEFERRED_LATER_WAVE |
| 5А | Isolated concurrent browser/code/data environments with warm/cold capacity and resumable checkpoints. | Статус міграції: DEFERRED_LATER_WAVE |
| 5Б | Capacity/rate/cost scheduling respects Plan-1 budgets and Plan-4 routing evidence. | Статус: DEFERRED_LATER_WAVE |
| 5В | Secure teardown/scrubbing, artifact sync and local-only capability affinity. | Статус: DEFERRED_LATER_WAVE |
| 6А | Lightweight status/notifications/ASK/pause/resume/stop/task/result review over canonical jobs. | Статус міграції: DEFERRED_LATER_WAVE |
| 6Б | Voice is optional convenience only; complete text/keyboard equivalent required. | Статус: DEFERRED_LATER_WAVE |
| 6В | Authenticated owner policy and control epochs unchanged. | Статус: DEFERRED_LATER_WAVE |
| 7А | Durable reviewer identity, exact decision/reason/options/evidence/timeout/escalation and same-step resume. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 7Б | Separate policy ASK from model uncertainty/clarification. | Статус: PARTIAL_EXISTING_11_0_13 |
| 7В | Deliver via available local/mobile/remote channels without losing authority semantics. | Статус: PARTIAL_EXISTING_11_0_13 |
| 8А | Map browser profiles/Google/GitHub/provider accounts/orgs without mixing credentials or effects. | Статус міграції: DEFERRED_LATER_WAVE |
| 8Б | Jobs/tools bind explicit account identity; cross-account changes require policy/evidence. | Статус: DEFERRED_LATER_WAVE |
| 8В | Account discovery cannot switch identity silently. | Статус: DEFERRED_LATER_WAVE |
| 9А | Versioned desired-state/control files map to canonical tasks and control epochs. | Статус міграції: DEFERRED_LATER_WAVE |
| 9Б | External adapters authenticate/reconcile state; polling/webhook retries idempotent. | Статус: DEFERRED_LATER_WAVE |
| 9В | No external controller becomes scheduler/policy authority. | Статус: DEFERRED_LATER_WAVE |
| 10А | When owner resumes, qualify cloud/remote/team/mobile/account/dispatch with restart/tenant/security/effect tests. | Статус міграції: DEFERRED_LATER_WAVE |
| 10Б | Prove local/cloud identity continuity and no duplicate execution. | Статус: DEFERRED_LATER_WAVE |
| 10В | Record terminal DONE only after activated later-wave scope. | Статус: DEFERRED_LATER_WAVE |

## План 6: 33 самостійних розділів

[Актуальний Google Doc](https://docs.google.com/document/d/1fr5Pm7ZbX7IxF-2CZ9nqWSE7vREMEGDCN2r0uHyr_Tk/edit)

| Розділ | Зміст | Статус |
| --- | --- | --- |
| 1А | Expose plan revisions, agent tree, tools/providers/effects, before/after evidence, errors/retries/checkpoints/artifacts/cost/owner interventions. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 1Б | Replay is inspection/debug evidence, not hidden chain-of-thought and not blind effect re-execution. | Статус: PARTIAL_EXISTING_11_0_13 |
| 1В | Keyboard/NVDA complete timeline navigation/filter/export. | Статус: PARTIAL_EXISTING_11_0_13 |
| 2А | Web/email/docs/code/tool metadata/remote-agent content treated as untrusted data. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 2Б | No untrusted text can alter owner policy, credentials, system/tool schemas or higher-priority instructions. | Статус: PARTIAL_EXISTING_11_0_13 |
| 2В | Data boundary persists across model/provider/context compaction. | Статус: PARTIAL_EXISTING_11_0_13 |
| 3А | Structured health/readiness/queue/effect/provider/model/budget/recovery metrics with redaction. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 3Б | One-click accessible support bundle includes versions/config-safe state/evidence without secrets. | Статус: PARTIAL_EXISTING_11_0_13 |
| 3В | Diagnostics distinguish degraded/unavailable/blocked/recovering and actionable next step. | Статус: PARTIAL_EXISTING_11_0_13 |
| 4А | All core controls keyboard/NVDA operable with headings/labels/status/live regions/focus restoration. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 4Б | Agent tree, plan, workboard, approvals, models/readiness/artifacts and errors have semantic nonvisual equivalents. | Статус: PARTIAL_EXISTING_11_0_13 |
| 4В | No canvas/visual-only core workflow; semantic twin mandatory. | Статус: PARTIAL_EXISTING_11_0_13 |
| 5А | Measure scheduling/refill/browser/provider/model/storage/UI latency under realistic parallel load. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 5Б | Backpressure/capacity limits avoid tab/process/model storms and starvation. | Статус: PARTIAL_EXISTING_11_0_13 |
| 5В | Long runs preserve bounded history/storage and responsiveness. | Статус: PARTIAL_EXISTING_11_0_13 |
| 6А | Inject service-worker death, browser/tab loss, Companion restart, provider timeout, model failover, storage/quota/network faults. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 6Б | No duplicate exact effects, stale callbacks or lost owner control; deterministic resume/reconcile. | Статус: PARTIAL_EXISTING_11_0_13 |
| 6В | Chaos matrix produces reproducible repair packets and permanent regression tests. | Статус: PARTIAL_EXISTING_11_0_13 |
| 7А | Backup Agent/Project/Recipe/Skill/model config/evidence metadata without secrets or stale runtime handles. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 7Б | Versioned migrations, partial/corrupt restore and rollback tested. | Статус: PARTIAL_EXISTING_11_0_13 |
| 7В | Import preview/conflict resolution preserves identities and provenance. | Статус: PARTIAL_EXISTING_11_0_13 |
| 8А | Central privacy/locality policy constrains models/providers/tools/cloud/export. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 8Б | Credential references opaque; logs/artifacts/support bundles redacted. | Статус: PARTIAL_EXISTING_11_0_13 |
| 8В | Cross-project/team/account boundaries fail closed and are audit-visible. | Статус: PARTIAL_EXISTING_11_0_13 |
| 9А | Deterministic extension/Companion artifacts bind source/dependencies/licenses/SBOM/config schemas and signatures. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 9Б | Update/rollback/migration preserve durable jobs and policy; no unsigned/unknown origin fallback. | Статус: PARTIAL_EXISTING_11_0_13 |
| 9В | Package source must correspond to canonical 11.x lineage, never stale main by accident. | Статус: PARTIAL_EXISTING_11_0_13 |
| 10А | Golden/generated/adversarial/restart/accessibility/provider/browser/model suites tied to capability readiness. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 10Б | A demo is not readiness; history shows regressions and applicable evidence gates. | Статус: PARTIAL_EXISTING_11_0_13 |
| 10В | Capability change invalidates stale readiness evidence. | Статус: PARTIAL_EXISTING_11_0_13 |
| 11А | Run security/injection/accessibility/performance/chaos/migration/package/support scenarios on exact candidate. | Статус міграції: OPEN |
| 11Б | Physical NVDA and authenticated services deferred to Plan 8, not faked. | Статус: OPEN |
| 11В | Record terminal DONE. | Статус: OPEN |

## План 7: 27 самостійних розділів

[Актуальний Google Doc](https://docs.google.com/document/d/1hMDxTh8AtFgGR_6z_f9DwvdC3ybWtbaCSSou4UxjGpU/edit)

| Розділ | Зміст | Статус |
| --- | --- | --- |
| 1А | Stable start/pause/resume/stop/query/artifact/project/model/provider/evidence APIs over same durable identities. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 1Б | SDK/CLI cannot bypass UI policy/approval/budget/exact-effect checks. | Статус: PARTIAL_EXISTING_11_0_13 |
| 1В | Versioned compatibility and local authentication. | Статус: PARTIAL_EXISTING_11_0_13 |
| 2А | Measure candidate automations by recurring time/model/runtime/owner-attention savings and verification confidence. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 2Б | Recommend deterministic Recipe/smaller model/tool path where evidence supports it. | Статус: PARTIAL_EXISTING_11_0_13 |
| 2В | ROI recommendation never self-authorizes deployment/effects. | Статус: PARTIAL_EXISTING_11_0_13 |
| 3А | Versioned products/features/plans/seat/device/org entitlements with signed/offline grace policy. | Статус міграції: PARTIAL_EXISTING_FUTURE |
| 3Б | License checks gate commercial feature availability, never corrupt durable user data/jobs on transient outage. | Статус: PARTIAL_EXISTING_FUTURE |
| 3В | No license server becomes task/policy/effect authority. | Статус: PARTIAL_EXISTING_FUTURE |
| 4А | Store-compliant manifest/privacy disclosures/minimal permissions and reproducible signed release. | Статус міграції: PARTIAL_EXISTING_FUTURE |
| 4Б | Telemetry opt-in/necessary-product metrics minimize content capture and respect privacy/locality. | Статус: PARTIAL_EXISTING_FUTURE |
| 4В | Upgrade/downgrade preserves data and clearly explains entitlement changes. | Статус: PARTIAL_EXISTING_FUTURE |
| 5А | Optional service carries authenticated desired state/events/notifications with idempotency and revision numbers. | Статус міграції: PARTIAL_EXISTING_FUTURE |
| 5Б | Core reconciles service state; service never becomes hidden scheduler/effect executor. | Статус: PARTIAL_EXISTING_FUTURE |
| 5В | Offline/degraded mode remains understandable and recoverable. | Статус: PARTIAL_EXISTING_FUTURE |
| 6А | Accessible dashboard shows capability readiness/evidence/regressions/provider/model health and product maturity. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 6Б | Track TIME_TO_VERIFIED_FINISHED_OUTCOME, duplicate work, verifier pass, recovery, owner attention, automation reuse, cost/latency. | Статус: PARTIAL_EXISTING_11_0_13 |
| 6В | Metrics cannot reward activity volume over verified outcomes. | Статус: PARTIAL_EXISTING_11_0_13 |
| 7А | Negative/failure memory, empirical routing, bounded uncertainty resolution and owner-attention pressure integrated. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 7Б | Autonomy level increases only after shadow/eval/recovery/security evidence; regression demotes automatically. | Статус: PARTIAL_EXISTING_11_0_13 |
| 7В | No maturity score can override hard policy/permission/effect checks. | Статус: PARTIAL_EXISTING_11_0_13 |
| 8А | Plan scheduling incorporates deadlines/dependencies/capacity/provider rate limits and owner-time costs. | Статус міграції: PARTIAL_EXISTING_11_0_13 |
| 8Б | Escalate only when delay/risk justifies attention; batch decisions where possible. | Статус: PARTIAL_EXISTING_11_0_13 |
| 8В | SLA optimization never bypasses safety/policy or creates duplicate work. | Статус: PARTIAL_EXISTING_11_0_13 |
| 9А | Run SDK/license/store/control-service/metrics/ROI/maturity/SLA scenarios on Core fixtures and exact candidate. | Статус міграції: OPEN |
| 9Б | Verify offline/degraded commercial services never break local durable Agent work. | Статус: OPEN |
| 9В | Record terminal DONE. | Статус: OPEN |

## План 8: 24 самостійних розділів

[Актуальний Google Doc](https://docs.google.com/document/d/1usWSVOrznz7nqWfIGq0zGgUhZeQ9KVEFh9Jxh1MykQM/edit)

| Розділ | Зміст | Статус |
| --- | --- | --- |
| 1А | Import/synchronize exact Drive archive `ChatGPT-Autopilot-11.0.13-HIGH-PostSend-Background-FIXED.zip` (Drive ID `1HHd4rNxf7Hlt0RqRzoBUX3M0JGF3usW2`) into canonical Git version control before normal product-code closure. | Статус міграції: ACTIONABLE_SOURCE_IMPORT |
| 1Б | Preserve provenance to archive SHA-256 `ddf0527d03ca5b68c3b50e96dd3413e2d26afb0b7737ae3f502a3f960ae3c329`, verify imported manifest/source tree, and treat current GitHub main 0.9.19 as stale predecessor. | Статус: ACTIONABLE_SOURCE_IMPORT |
| 1В | Run current relevant tests on the imported exact 11.0.13 tree, then establish one canonical 11.x source lineage; supersede stale duplicate/pre-11.x lineages without erasing history. | Статус: ACTIONABLE_SOURCE_IMPORT |
| 2А | Compose Agent Core, execution providers, multi-agent/projects, Models, reliability/UI and commercial claimed features. | Статус міграції: WAITING_UPSTREAM |
| 2Б | One scheduler/policy/router/recovery/browser/provider/effect authority each; no duplicate cores. | Статус: WAITING_UPSTREAM |
| 2В | Run end-to-end outcome contracts with model and No-AI/hybrid paths. | Статус: WAITING_UPSTREAM |
| 3А | On exact packaged candidate test Chrome/MV3/Native Messaging/Companion/UIA/files/browser and actually configured services/accounts. | Статус міграції: WAITING_SECTION2 |
| 3Б | Service unavailable is explicit unsupported/unconfigured, not fake PASS. | Статус: WAITING_SECTION2 |
| 3В | Verify restart/recovery/credential revocation/account identity and exact external effects. | Статус: WAITING_SECTION2 |
| 4А | Keyboard-only/NVDA operate session/simple/orchestration/scenario/Agent/Models/projects/approvals/workboard/artifacts/settings/error/recovery. | Статус міграції: WAITING_SECTION2 |
| 4Б | Focus/live-region/labels/headings/tables/tree/canvas semantic twin and no mouse-only critical action. | Статус: WAITING_SECTION2 |
| 4В | Findings repair owning plan then rebuild/requalify same release candidate lineage. | Статус: WAITING_SECTION2 |
| 5А | Після explicit owner resume завершити Plan 5 terminal і інтегрувати той самий durable identity/policy/effect state; до resume цей Section чесно WAITING_OWNER, але не вилучений із фінального scope. | Статус міграції: WAITING_OWNER_RESUME_THEN_PLAN5 |
| 5Б | Run local↔cloud/cross-device/team isolation/remote steering recovery evidence. | Статус: WAITING_OWNER_RESUME_THEN_PLAN5 |
| 5В | До explicit resume не витрачати активну capacity на Plan 5; після resume він стає обов’язковим prerequisite фінального whole-product gate, а не optional capability. | Статус: WAITING_OWNER_RESUME_THEN_PLAN5 |
| 6А | User/admin/developer docs for installation, Agent/Models/projects/tools/permissions/recovery/backup/providers/troubleshooting. | Статус міграції: WAITING_UPSTREAM |
| 6Б | Provider/model onboarding shows health/readiness/privacy/cost and safe credential setup. | Статус: WAITING_UPSTREAM |
| 6В | Docs match exact release behavior and accessible keyboard flows. | Статус: WAITING_UPSTREAM |
| 7А | Map every mandatory North-Star capability, включно з Plan 5 після його resume, to exact source/package/test/recovery/security/accessibility/provider/account evidence. | Статус міграції: WAITING_ALL_MANDATORY_SCOPE |
| 7Б | No unresolved P0/P1, stale 0.9.x lineage, hidden NOT_READY capability or unsupported claim. | Статус: WAITING_ALL_MANDATORY_SCOPE |
| 7В | North-Star metrics and TIME_TO_VERIFIED_FINISHED_OUTCOME measured on representative long jobs. | Статус: WAITING_ALL_MANDATORY_SCOPE |
| 8А | Publish exact signed extension/Companion/release artifacts, rollback predecessor and reproducibility bundle. | Статус міграції: WAITING_SECTION7 |
| 8Б | Clean install/update/restart/restore long-horizon acceptance and support handoff. | Статус: WAITING_SECTION7 |
| 8В | Terminal DONE only after all mandatory North-Star capabilities in Plans 1–7 are integrated/evidenced; parked Plan 5 must first be explicitly resumed and terminally completed. | Статус: WAITING_SECTION7 |
