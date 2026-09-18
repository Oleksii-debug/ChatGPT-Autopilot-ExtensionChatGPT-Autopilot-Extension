# ChatGPT Autopilot — Agent Platform V1

Decision date: 2026-09-14
Status: ACTIVE DESIGN + IMPLEMENTATION

## Product definition

Autopilot Agent Platform is not a form-driven macro system. The primary user experience is agent-style delegation: the owner writes one natural-language task in a large task composer, presses **Start**, and the AI autonomously plans and executes the work until the task is complete, blocked by a required approval, or stopped by owner policy/budget.

**AI = reasoning brain/operator. Autopilot = durable body/runtime.** The model owns task-level planning and action choice. Autopilot owns browser execution, observation, permissions, budgets, scheduling, durable state, recovery, audit and kill switch.

Structured actions are tool calls. They are not evidence that Autopilot is the planner. This matches modern agent architecture: the model reasons and invokes validated tools; the runtime performs those calls and returns observations.

## Primary UX

Default Agent surface is a task composer, similar to a chat/agent prompt box:

1. user writes the task in natural language;
2. presses **Start**;
3. Agent begins immediately using current browser context or navigates as needed;
4. status/history/results are readable as text;
5. Pause / Continue / Stop are always available.

No URL, max-step count, interval or model setting is mandatory before normal one-off execution. Advanced policy/configuration is secondary and optional.

## Agent loop

`owner goal -> observe -> reason/plan -> tool call(s) -> execute -> verify -> update state -> continue`

The agent may run many steps without owner interaction. Runtime must support low-latency continuation and small safe tool batches where that reduces model round-trips without using stale DOM references after navigation.

## Body / capability model

### Eyes
- DOM + ARIA/accessibility snapshots;
- visible text, controls and form state;
- iframe context;
- page/url/title metadata;
- later: screenshots/vision and OCR only when needed.

### Hands
- click and native click;
- fill/type/contenteditable;
- select, checkbox/radio;
- key input;
- scroll;
- safe form submission;
- files upload/download;
- later: drag/drop and richer editor actions.

### Legs
- navigate;
- back/forward/reload;
- open/follow links;
- switch/create/close agent-owned tabs/windows.

### Ears
- alarms/timers;
- page-change monitoring;
- download completion;
- provider/rate-limit events;
- task events/notifications.

### Brain
- API model(s);
- local model(s);
- hybrid router;
- deterministic/no-AI recipes;
- durable memory/planner state.

## Execution modes

1. **API Agent** — one or multiple remote API models.
2. **Local Agent** — one or multiple local AI models via Ollama/OpenAI-compatible/local gateway.
3. **Hybrid AI** — local + API routing/fallback/escalation.
4. **Deterministic No-AI Agent** — recipes, parsers, monitors and state machines.
5. **Full Hybrid** — deterministic engine + local AI + API AI cooperate in one durable job.

Reuse the existing AI Gateway/Router/provider registry. Do not create a competing AI stack or second browser-send scheduler.

## Policy / budget layer

Policies are optional owner limits, not required task fields. Defaults permit: write prompt -> Start.

Global and per-job policy should support:
- max input tokens;
- max output tokens;
- max total tokens;
- max monetary spend;
- max AI/API calls;
- max runtime duration;
- max browser actions safety ceiling;
- allowed/blocked origins/domains;
- approval policy for consequential actions;
- preferred model/provider and fallback order;
- run now / fixed time / time window / recurring interval / continuous 24x7 while runtime is available;
- monitoring frequency and notification policy.

Budgets are enforced by runtime rather than merely included in model instructions.

## Safety / approval

Web content is untrusted input and cannot override owner goal/policy. Pause/Stop is authoritative over late model responses.

Consequential operations use policy-aware approval boundaries. Examples include purchases, destructive deletion, publishing, security/account changes, and submitting important forms/applications unless the owner explicitly delegated that class of action.

Passwords, cookies, session tokens and browser secrets are not included in model prompts.

## Trusted script fallback

Normal DOM/ARIA/native-input capabilities are preferred. A later Trusted Script capability may execute JavaScript when ordinary interaction cannot operate a site. It must be explicit/opt-in, auditable, origin-scoped and policy-limited. AI-authored arbitrary JavaScript must never execute silently inside authenticated pages.

## Intended work classes

- inaccessible university/AIS systems: subjects, timetable, forms;
- housing search across sites;
- ticket monitoring/search;
- grant/research discovery;
- continuous monitoring/alerts;
- download/file collection;
- extraction/comparison/calculation;
- multi-site research;
- web-form/application preparation and filling using owner data;
- long-running work while PC/Chrome is available.

## Urgent MVP

One configured AI provider through existing AI Gateway + generic browser operator.

Required:
- chat-like task composer;
- Start / Pause / Continue / Stop;
- automatic navigation from natural-language goal;
- generic DOM/ARIA observation;
- click/fill/select/check/key/scroll/navigation;
- native-click fallback;
- iframe handling;
- multi-tab ownership;
- effect verification;
- readable audit/history;
- origin permissions;
- owner kill switch.

Advanced policy/config is optional and secondary.

## Milestones

- M1: task-composer UX + single AI model autonomous loop.
- M2: robust forms/editors/iframes/multi-tab/downloads/files/effect verification.
- M3: token/cost/time/action budgets + approvals.
- M4: scheduling, time windows, intervals and continuous monitoring.
- M5: local AI + hybrid routing inside same agent loop.
- M6: deterministic recipes/no-AI agents.
- M7: screenshots/vision and richer computer-use fallback.
- M8: Trusted Script capability.
- M9: optional companion providers such as Playwright/Stagehand/browser-use behind adapters, without second scheduler.
- M10: cloud runner for 24x7 without owner PC when separately deployed.

## Architectural invariants

- Existing Core Session/Task executor remains authoritative for existing ChatGPT browser-send workflows.
- Browser Agent has a durable job lifecycle and shared capability/policy/backpressure concepts.
- Every tool action belongs to one job, one control epoch and one observation/action cycle.
- Agent-owned tab ownership/cleanup is durable; adopted user tabs are never auto-closed as owned tabs.
- Owner Pause/Stop wins over stale async model responses.
- Model is planner/operator; runtime is safety/execution authority.

## Accessibility / keyboard contract

All primary controls are native keyboard-accessible HTML, with explicit labels, logical headings, role=status/live announcements where useful. The first control in Agent view is the task composer, not configuration. Advanced settings are secondary/collapsible. History/result is readable as text without visual inspection.

## 0.9.14 implementation direction

Current development already adds generic Browser Agent core using `chrome.scripting` and `chrome.debugger`, routed through the existing AI layer. The UI and execution contract must follow this document: prompt-first task delegation, model-owned planning, optional policy limits, durable lifecycle and generic browser capabilities.

## 0.9.14 implementation checkpoint — 2026-09-14 evening

Implemented in the current WIP source, subject to final release qualification:

- prompt-first Agent tab in Options; normal execution does not require URL/max-step/schedule configuration;
- AI-owned autonomous `observe -> reason -> tool -> verify` loop with fast multi-step burst execution;
- owner follow-up instructions and durable control epoch so Pause/Stop/new instruction invalidates stale model actions;
- generic DOM/ARIA observation and validated click/fill/select/check/batch/key/scroll/navigation/back/reload/wait/done tools;
- native CDP click fallback;
- adopted user-tab versus agent-owned tab distinction, opener-proven child-tab ownership, transactional tab cleanup and retry;
- origin permission boundary including cross-origin redirects/clicks;
- bounded durable recovery for provider failure, invalid planner output, stale DOM, browser action failure and partial batch execution;
- token/model-call/runtime/action/monetary budgets with provider usage accounting and runtime enforcement;
- repeat policy ONCE / CONTINUOUS / INTERVAL, absolute start/end, daily active windows including overnight windows, and cold-restart alarm recovery;
- API Router/Gateway usage support for OpenAI Responses, OpenAI-compatible and Ollama token counters;
- generic Browser Agent Chromium form E2E: real Chromium snapshot + fill/select/check/contenteditable/legacy onclick/click/submit + post-action verification;
- alarm namespaces kept disjoint from Ordinary Core, Scenario Work and per-orchestra alarms;
- Scenario Work write-ahead cleanup, durable cleanup obligations, owner lifecycle epoch, restart-safe managed Session identity and dependency semantics;
- legacy Pair/Auditor+Group timeout/replacement stall fixes;
- Orchestration V2 transactional managed-tab retirement;
- Ordinary Session seconds/minutes cadence selector and compact shared/shared logical cycle count up to 1,000,000.

Automated checkpoint before version freeze:
- full AI/Scenario/Agent suite: 377/377 PASS;
- Core/integration: 272/272 PASS after final stopped-tab retirement hardening;
- UI: 62/62 PASS;
- release: 14/14 PASS under current pre-freeze 0.9.13 metadata;
- reliability constituent tests: 26/26 PASS including the mixed-runtime long-run gate;
- native Chromium gate PASS including generic Browser Agent form E2E;
- Chrome keyboard/accessibility gate PASS.

Final pre-package hardening also proved:
- mixed Ordinary + Browser Agent + Scenario Work + Orchestration V2 progression under one shared Chrome/storage environment, cold restart, ambiguous Send and tabs.remove faults;
- Orchestration coordinator terminal operation is cleared before durable conversation rebind, preserving strict Core URL-binding validation;
- stopped-session retirePending ownership remains canonical core-alarm work with exponential retry and is not delayed by provider rate-limit; final quiescence drains owned Ordinary hints to zero.

Current frozen automated matrix: 884/884 Node tests PASS; native Chromium generic Agent form E2E PASS; Chromium keyboard/accessibility PASS; syntax 209/209; JSON 6/6; secret-prefix scan 0 hits.

Not yet claimed: physical Windows owner test, physical NVDA verification, or real UKF AIS execution. Final 0.9.14 still requires deterministic packaging and exact-final-artifact rerun.

## 0.9.15 implementation checkpoint — Agent body expansion / safety / deterministic monitoring

Implemented and automatically qualified in the 0.9.15 source candidate:

- explicit consequential-action approval boundary with ALLOW_ALL only as owner opt-in;
- approval target TOCTOU protection for same-URL SPAs, including effective form action/method identity;
- targeted Enter/Space native-key actions so keyboard cannot bypass submit approval;
- AI-owned multi-tab tools with ephemeral tabRef and durable owned/adopted provenance;
- tracked Agent downloads with durable no-model-call download wait;
- approved upload of only a completed file downloaded by this Agent, without exposing local paths to the model;
- on-demand ephemeral screenshot/vision through the existing Router/Gateway;
- optional system notifications for meaningful monitoring results;
- deterministic wait_for_change semantic page watch: Chrome polls without model inference until actual change or timeout, survives restart, and is interrupted immediately by a newer owner instruction;
- owner follow-up supersedes an armed pending approval instead of leaving stale action authority live;
- maxSteps is enforced as a physical/tool-action ceiling after already-authorized durable obligations settle; final DONE reasoning can still complete the job;
- bounded provider/planner/browser-action recovery and partial batch evidence;
- Ordinary/Scenario/Orchestration timing and ownership contracts remain authoritative and unchanged unless the owner explicitly edits policy.

Automated qualification at functional freeze: 921/921 Node tests PASS; native Chromium generic Agent form E2E PASS; Chromium keyboard/accessibility PASS; syntax 209/209; JSON 6/6; secret-prefix scan 0 hits. Physical Windows/NVDA/real UKF AIS acceptance remains explicitly unclaimed.

## 0.9.16 implementation checkpoint — vision computer-use coordinate fallback

Implemented on top of the fully qualified 0.9.15 Agent body:

- new `click_at` tool for visible custom/canvas/icon UI when screenshot vision is necessary and no reliable DOM/ARIA ref exists;
- `click_at` is accepted only on the exact reasoning turn with an attached runtime screenshot, and only inside that screenshot's current CSS viewport;
- runtime probes the live element under the point, promotes a semantic actionable ancestor where possible, and records only bounded target evidence;
- consequential/submit coordinate targets reuse the normal approval policy; pure visual-only targets require owner approval under default CONSEQUENTIAL policy, while ALLOW_ALL remains explicit owner opt-in;
- coordinate approval uses TOCTOU fingerprint revalidation, and native mouse execution revalidates the same target immediately before CDP input;
- real Chromium generic Browser Agent smoke proves a visual-only canvas target can be probed and physically clicked with native browser input;
- Ordinary Session cadence/recovery, Scenario Work and Orchestration V2 remain separate authoritative runtimes and are not rewritten by this capability.


## 0.9.17 implementation checkpoint — visual drag/type + isolated per-Agent routing

Implemented on top of 0.9.16 coordinate click:

- screenshot-turn-only `drag_at` with bounded source/destination coordinates, owner approval by default, durable source/destination fingerprints, post-attach TOCTOU revalidation and native CDP held-button movement;
- screenshot-turn-only `type_at` for visible text/editor surfaces, post-attach target revalidation and native `Input.insertText`; password/file targets remain blocked;
- visual drag has real bounded duration rather than a zero-time burst of CDP events;
- per-Agent AI routing policy can inherit profile Router or override primary/strong/hybrid mode plus provider/model;
- job-local Router runtime persists route counters/history without mutating profile-wide Router runtime;
- Agent Options policy exposes these AI routing controls while natural-language task composer remains first and sufficient for ordinary use;
- real Chromium smoke covers canvas coordinate click, visual drag/drop and coordinate editor typing;
- no change to Ordinary Session cadence, Scenario Work scheduling, or Orchestration V2 ownership semantics.

Qualification target for this checkpoint: exact full Node matrix + reliability + native Chromium + keyboard/accessibility + static scans + deterministic double packaging; physical owner Windows/NVDA/real UKF AIS remains a separate acceptance step.
