# AUTOPILOT FINAL PRODUCT NORTH STAR

Status: BINDING FINAL PRODUCT TARGET
Decision date: 2026-09-19
Owner objective: minimize TIME_TO_VERIFIED_FINISHED_OUTCOME for a non-programmer or professional working through ChatGPT and connected tools.
Canonical architecture authority remains GitHub #122. Whole-product authority is #149. Live execution/ownership is #150.

## 1. Product identity

Autopilot is not only a prompt sender, browser macro, ChatGPT extension, or single autonomous Agent.

The final product is a universal personal/team AI execution layer that converts a natural-language objective into a durable, observable, policy-controlled, verified finished result across chats, web, desktop, files, code, cloud services and connected applications.

The product should let a user spend dramatically less time on:
- repeating project context in new chats;
- copying text/files between chats and applications;
- manually coordinating many AI workers;
- launching the same workflow again;
- checking whether work really finished;
- finding the current version of a file, task or decision;
- watching long work merely to restart it;
- reconciling duplicate or conflicting worker output;
- doing repetitive browser/desktop/file operations;
- reconstructing what happened after a failure/restart.

The target experience is: state the outcome once, set authority/policy once, and let Autopilot plan, execute, verify, recover, report and continue until the observable completion contract is satisfied.

## 2. Non-negotiable architecture

Preserve:
- REUSE -> ADAPT -> THIN CUSTOM;
- one canonical Session/Task scheduler;
- one durable job/state authority;
- one recovery/exact-effect authority;
- one Browser Agent/browser authority;
- one AI Gateway/Router;
- one owner policy authority;
- one Native Companion local privileged boundary.

Do not create scheduler #2, Session/Task engine #2, durable store #2, recovery #2, Browser Agent #2, AI Router #2, policy engine #2 or generic agent framework #2.

External providers, MCP servers, coding agents, remote A2A agents, cloud execution and desktop automation are adapters/execution planes behind canonical Autopilot contracts.

## 3. Core productivity layer: features that reduce user work by multiples

### 3.1 Universal command surface

Provide a keyboard-first command surface available from the extension/sidebar and optionally system-wide through the Companion.

A user can:
- describe an outcome in natural language;
- act on the current page, current chat, selected text, clipboard content, local file or connected artifact without manual copy/paste;
- choose an existing Project/Session/Agent or create one;
- say "do this again", "do this for all", "continue", "watch this", "schedule this", or "turn this successful run into a reusable workflow";
- inspect status, pause, resume, stop, retry/reconcile or redirect work without opening developer tooling.

For NVDA, every operation must have semantic labels, headings, text status, deterministic focus behavior and keyboard-complete control.

### 3.2 Project Workspace and Context Fabric

Introduce Project as a durable logical scope over existing Sessions/Tasks/Agents, not a second scheduler.

Each Project maintains:
- owner goal and success definition;
- canonical instructions/policies;
- connected repositories, Drive folders/docs, sites, mailboxes and local paths;
- live tasks and agent tree;
- decisions and unresolved questions;
- artifact registry;
- source/provenance graph;
- semantic index;
- project memory;
- recent changes;
- concise current-state capsule.

Memory tiers:
- working memory for the current run;
- episodic run history/checkpoints;
- semantic project facts/decisions;
- procedural memory/Recipes;
- owner preferences that are explicitly allowed to cross projects.

Project memory must be source-aware, revision-aware, inspectable and correctable. A stale remembered fact must never outrank newer canonical live evidence.

### 3.3 Context Capsules

Autopilot automatically composes bounded, source-linked context packages for a new or continuing chat/agent:
- goal;
- current state;
- constraints;
- exact relevant files/issues/commits;
- decisions;
- unfinished work;
- ownership/claims;
- recent evidence;
- next executable actions.

This eliminates manual project re-explanation while preventing giant transcript dumping. Large sources remain ArtifactRefs with retrieval on demand.

Capsules are portable between chats, models, local/cloud planes and worker accounts.

### 3.4 Swarm Workspace / Multi-chat Multiplexer

Productize the multi-account/multi-chat workflow already being developed.

Required:
- worker pool across many chats/accounts/providers;
- durable worker identity;
- live queue;
- claim/lease/conflict keys;
- continuation of owned lineage;
- dependency DAG;
- completion-driven refill;
- duplicate-work prevention;
- merge/reviewer lane;
- coordinator rotation;
- result consolidation;
- bounded concurrency/rate policies;
- cross-account handoff through canonical control state.

A user should be able to ask for one large project and let the system safely distribute independent slices instead of manually opening and prompting ten chats.

### 3.5 Batch / Matrix execution

Any safe operation that works for one target should be expressible over a collection:
- many chat URLs;
- many repositories;
- many files;
- many pages;
- many records;
- many contacts/items;
- many sites/accounts when owner policy permits.

Batch jobs require per-item identity, retry/reconcile semantics, concurrency limits, progress, partial-failure handling and exportable result tables.

### 3.6 Recipe Recorder and Workflow Compiler

A successful exploratory run can become a reusable Recipe.

Pipeline:
exploratory run -> sanitize private/secret data -> infer parameters -> candidate Recipe -> deterministic replay -> verifier -> versioned promoted Recipe.

Recipe features:
- variables/forms/defaults;
- reusable steps;
- preconditions/postconditions;
- owner policy scopes;
- schedule/event trigger compatibility;
- versioning;
- rollback;
- drift detection;
- fallback to bounded agent reasoning when deterministic replay no longer matches;
- sharing/import/export.

The objective is that repeated work gets cheaper, faster and more deterministic over time.

### 3.7 Prompt and instruction assets

Prompts/instructions become versioned project assets:
- named prompt library;
- variables;
- Prompt2/Prompt3 and cadence;
- source binding from Drive/local/GitHub;
- history/diff;
- template generation;
- safe import/export;
- optional evaluation against a fixed task set;
- automatic selection only through explicit, inspectable policy.

Do not silently mutate owner instructions.

### 3.8 Event-driven proactive automation

Schedules are only one trigger family.

Add canonical trigger providers for:
- time/calendar occurrence;
- webhook;
- GitHub issue/PR/workflow events;
- new or changed email;
- Drive/file change;
- website/dashboard change;
- local filesystem change;
- external API event;
- agent/subagent terminal event.

Triggers create/continue canonical Tasks/Agents; they never own a second scheduler/recovery system.

### 3.9 Universal Inbox / Action Center

One accessible text-first surface must show:
- running Agents/Sessions/Tasks;
- waiting approvals only where owner policy resolves ASK;
- blocked tasks with exact unblock condition;
- missed/scheduled work;
- failed/reconciling effects;
- new results;
- notifications;
- important changes across connected projects;
- worker claims/leases;
- release/verification gaps.

Support "tell me only what needs my attention" and structured daily/project digests.

### 3.10 Global semantic search

Search one query across owner-authorized:
- Project memory;
- GitHub;
- Drive/Docs/Sheets/Slides;
- Gmail;
- browser history/artifacts where allowed;
- local files;
- generated artifacts;
- execution evidence and logs.

Results preserve source identity, recency and permissions.

### 3.11 Artifact Workspace

Files are first-class durable objects, not chat attachments that disappear into transcripts.

Support:
- docs, sheets, slides, PDFs, code, archives, images, audio/video and structured data;
- versions/checkpoints;
- diff;
- provenance;
- validation;
- conversion;
- templates;
- review/approval state;
- immutable evidence refs;
- final delivery bundle.

Autopilot should be able to take research through finished editable deliverables without manual file shuffling.

### 3.12 Cross-app transaction composer

Complex outcomes often span multiple systems.

Represent a multi-app workflow as one durable transaction graph:
prepare -> validate -> execute effect -> observe -> verify -> commit/reconcile.

Example: research -> update spreadsheet -> create document -> update GitHub -> send email -> monitor reply.

Every consequential external effect retains its own exact-effect identity and can be reconciled independently.

### 3.13 Selection / clipboard / current-page actions

High-frequency micro-work needs near-zero setup:
- summarize/rewrite/translate selected content;
- save selection to a Project;
- create task from selection;
- compare selected text with project source;
- extract structured data;
- send selected content to a Recipe;
- ask an Agent to continue from current page state.

This must work keyboard-first and never require mouse-only UI.

### 3.14 Cross-device continuity

A Project/Agent can be started from web/mobile/cloud, inspected elsewhere and resumed on desktop.

Local-only work waits for the authorized local device.
Cloud-capable work continues while the PC is off.
The same job identity, policy, artifacts and exact-effect state survive plane changes.

### 3.15 Team/shared mode

Later commercial/team mode must support:
- shared Projects;
- roles;
- per-user/per-agent authority;
- comments/handoffs;
- shared Recipes/skills;
- audit trail;
- separate credential ownership;
- agent identity;
- organization policies;
- exportable governance/evidence.

## 4. World-class Agent layer

### 4.1 Goal -> plan DAG -> execution

The Agent must maintain a durable plan graph with:
- objective;
- acceptance criteria;
- dependencies;
- critical path;
- conflict keys;
- owners;
- execution plane;
- budgets;
- observable completion conditions.

Planning is dynamic. The plan can be revised from evidence without losing completed work or blindly restarting.

### 4.2 Hierarchical multi-agent orchestration

Support:
- multiple top-level Agents;
- parent-created bounded subagents;
- dynamic decomposition;
- parallel specialists;
- clean isolated context per child;
- child authority <= parent authority;
- per-child model/tool/budget;
- terminal-event reconciliation;
- conflict detection;
- cancellation/pause/resume for one child or subtree;
- result synthesis and evidence merging.

A coordinator must be able to monitor children and reassign/re-plan when one fails.

### 4.3 Specialist registry

First-class specialists should include, as providers rather than new cores:
- Research;
- Coding;
- Browser/Web;
- Windows/Desktop;
- Data/SQL/Python;
- Document/Spreadsheet/Slides;
- Design/Frontend;
- QA/Verifier;
- Release/DevOps;
- CMS/Site;
- Media/Vision;
- Mail/Calendar/Communication.

Specialists expose capability descriptors and machine-readable result contracts.

### 4.4 Separate Actor and Verifier

For important work, the component that performs the action must not be the only component deciding success.

Verifier responsibilities:
- evaluate explicit success contract;
- inspect postconditions;
- run tests;
- compare before/after;
- inspect rendered UI;
- verify artifacts;
- verify source/provenance;
- detect partial completion;
- reopen work when evidence is insufficient.

Support independent reviewer/judge mode and, when useful, parallel candidate generation plus evidence-based selection.

### 4.5 Persistent cloud workspace / sandbox

Provide cloud execution environments for work that can continue while the user's machine is off:
- persistent task filesystem/workspace;
- terminal/code execution;
- browser;
- installed task tools under policy;
- resumable processes;
- artifact storage;
- checkpoints;
- isolation between Agents/Projects.

Local Companion remains separate for owner machine resources.

### 4.6 Desktop computer use

Windows execution hierarchy:
direct API/CLI/app object model -> UIA/Win32 semantic automation -> vision/screenshot -> OCR last.

Required:
- semantic control tree;
- stable target fingerprints;
- focus/state inspection;
- dialogs/files/windows;
- screenshots when useful;
- postcondition verification;
- safe recovery from UI drift;
- owner-scoped application/process/filesystem authority.

### 4.7 Web execution

Use multiple complementary paths:
- API/provider where available;
- semantic/text browser for research;
- existing Browser Agent for managed ChatGPT;
- Playwright deterministic automation for general web;
- accessibility snapshot/semantic agent browser;
- vision computer use only where semantic methods are insufficient.

Use BrowserTargetLease to prevent conflicting mutators.

### 4.8 MCP + provider ecosystem + A2A

MCP:
- explicit allowlist;
- exact dependency admission;
- server identity/version/provenance;
- discovery != permission;
- local stdio and approved remote transports;
- tool/resource schemas behind canonical policy.

A2A:
- support approved remote agent interoperability;
- Agent Cards/capability discovery;
- authenticated remote delegation;
- scoped task envelopes;
- no permission amplification;
- ArtifactRef-based result handoff;
- canonical Autopilot remains owner of task/policy/effect state.

### 4.9 Model Router / effort control

Existing AI Gateway/Router evolves to support:
- model capability registry;
- local/cloud providers;
- task-aware routing;
- fast/cheap vs deep/strong effort;
- escalation on verifier failure;
- model fallback;
- optional multi-model review;
- cost/latency/quality budgets;
- exact model identity in evidence.

Do not create router #2.

### 4.10 Long-horizon context management

Agent context must not grow as an unbounded transcript.

Use:
- ArtifactRefs;
- structured state;
- rolling summaries;
- source-aware retrieval;
- task-scoped memory;
- child isolation;
- context compaction with invariant preservation;
- pinned owner instructions;
- decision/evidence records;
- resumable checkpoints.

### 4.11 Self-healing and exact-effect recovery

Every effectful provider uses:
PREPARED -> EXECUTING -> OBSERVED -> VERIFIED -> COMMITTED.

Ambiguous result:
AMBIGUOUS -> RECONCILE -> VERIFIED | SAFE_RETRY | MANUAL_REVIEW.

Recovery includes:
- service-worker restart;
- browser restart;
- Companion restart;
- network failure;
- cloud worker restart;
- process crash;
- partial API response;
- lost child agent;
- stale browser/UI state.

Never blind replay.

### 4.12 Checkpoint, rewind and branchable experiments

Support durable checkpoints for:
- plan;
- conversation/context capsule;
- files/artifacts;
- recipe version;
- relevant execution state.

Allow user/Agent to compare or rewind safe internal work. External effects are not "undone" by pretending history changed; they require compensating actions under policy.

For coding/design, support isolated branches/worktrees/candidates and controlled merge.

### 4.13 Self-testing agent

Autopilot should routinely test the thing it creates:
- web/app interaction tests;
- screenshot/visual diffs;
- accessibility-tree diffs;
- API checks;
- unit/integration/e2e;
- link/form/navigation tests;
- artifact structure;
- deployment/site verification.

When a test fails, it should diagnose, repair and re-run within budget instead of immediately returning unfinished work.

### 4.14 Procedural learning without unsafe self-modification

Autopilot learns from successful executions through:
- promoted Recipes;
- skill templates;
- failure signatures;
- provider reliability statistics;
- routing performance;
- project conventions;
- accepted fixes.

Learning must be versioned, inspectable, reversible and evaluated before promotion.
Do not silently rewrite core safety/policy contracts or owner instructions.

### 4.15 World-state model

Maintain structured state of relevant external reality:
- which page/tab/window/file/repo/branch/issue is active;
- current revisions/SHAs;
- authenticated origin/account;
- leases/claims;
- expected vs observed state;
- stale observation detection.

Never act from an old observation when the target may have changed.

### 4.16 Prompt-injection and untrusted-content boundary

Treat web pages, emails, documents, code comments, tool metadata and remote-agent messages as potentially untrusted data.

Requirements:
- instruction/data separation;
- provenance labels;
- no automatic authority from retrieved content;
- secret/credential non-exposure;
- outbound data-flow policy;
- tool-scope enforcement;
- suspicious cross-domain instruction detection;
- verifier checks for consequential effects.

Owner autonomy remains authoritative, but external content cannot silently rewrite owner policy.

### 4.17 Observability / trace / evidence

Every long task needs an accessible trace:
- plan and DAG;
- agent tree;
- current state;
- tool/provider invocations;
- exact effects;
- checkpoints;
- artifacts;
- evidence;
- errors/retries/reconciliation;
- model/provider identity;
- runtime/cost/token/tool budgets where available;
- why a task is blocked;
- what requires owner attention.

Provide compact summaries plus drill-down, not raw noise.

### 4.18 Evaluation platform

Autopilot needs its own repeatable benchmark suite.

Benchmark families:
- chat/session automation;
- long-running scheduled work;
- browser tasks;
- authenticated flows;
- desktop/UIA;
- filesystem;
- Drive/Gmail/GitHub;
- coding issue-to-tested-PR;
- research with source verification;
- document/artifact generation;
- CMS/site work;
- accessibility;
- multi-agent coordination;
- restart/ambiguity/duplicate-effect chaos tests;
- prompt-injection/untrusted-content tests.

Track success rate, verifier pass rate, recovery rate, duplicate-effect rate, user interventions and time-to-verified-outcome by release.

### 4.19 Resource and budget governor

Per Project/Agent/subagent support:
- model/token/credit budget;
- wall-time budget;
- concurrency;
- browser/desktop slots;
- API limits;
- storage;
- retries;
- escalation policy.

The governor must optimize completion, not burn compute to appear busy.

### 4.20 Marketplace / portable skills

Support signed/versioned portable packages for:
- Recipes;
- skills;
- provider adapters;
- specialist definitions;
- MCP configurations;
- site adapters;
- validation packs.

Package admission includes origin, version, permissions, security review, update/rollback and tests.

## 5. Existing provider goals remain binding

The final product still requires:
- complete owner-scoped filesystem provider;
- Windows UIA/desktop capability;
- local + cloud planes;
- first-class Drive;
- first-class Gmail;
- first-class GitHub/coding;
- website/CMS administration;
- image/vision/media;
- professional design loop;
- calendar scheduling from #151, including text-first keyboard/NVDA date/time entry, non-AI Session occurrence schedules, and delayed whole-algorithm start for Scenario/Orchestration; binding detail: `docs/SCHEDULING_ACCESSIBILITY_AND_ALGORITHM_START.md`;
- CredentialBroker;
- owner authority ALLOW | ASK | DENY;
- physical Windows 11 + Chrome + NVDA acceptance.

These are not replaced by this North Star. They are incorporated into it.

## 6. Highest-leverage delivery waves

These waves are dependency guidance, not separate products or V1/V2/V3 final destinations.

### Wave A — current unblockers
Finish and merge current canonical MCP-001 and SCHED-001 lineages after live review/qualification.

### Wave B — provider foundation
- deterministic Playwright + BrowserTargetLease + Browser Verifier;
- MCP semantic web path;
- filesystem write/search/watch/archive;
- Windows UIA;
- cloud execution seam;
- local/cloud execution affinity.

### Wave C — Project/Context acceleration
- Project scope;
- Artifact Registry;
- Context Capsule;
- source/provenance graph;
- semantic search/index;
- memory tiers;
- current-state digest.

### Wave D — multi-agent productivity
- durable Agent Plan DAG;
- top-level Agents;
- bounded subagents;
- specialists;
- result merger;
- independent Verifier;
- swarm UI/control center.

### Wave E — reusable automation
- Recipe Recorder/Compiler;
- prompt assets;
- batch/matrix execution;
- event trigger providers;
- webhook/change monitoring;
- Action Center.

### Wave F — professional work surface
- docs/sheets/slides/PDF artifact workflows;
- data/analytics;
- CMS/site;
- vision/media;
- design critique/fix/verify;
- coding specialist;
- deployment/release specialist.

### Wave G — cloud/remote intelligence
- persistent cloud workspace;
- cross-device continuation;
- A2A remote agents;
- team/shared projects;
- agent identities;
- provider marketplace.

### Wave H — world-class reliability
- checkpoint/rewind;
- chaos/restart testing;
- prompt-injection boundary;
- observability;
- benchmark/eval dashboard;
- learned Recipe promotion;
- adaptive router/budget governor;
- physical accessibility acceptance.

## 7. Product-level acceptance outcomes

The product is not complete until a non-programmer can, through accessible natural-language and keyboard-first controls:

1. Create a Project and give it a broad goal once.
2. Connect permitted files/apps/sites/repositories.
3. Let Autopilot build and execute a durable plan.
4. Run multiple workers/subagents without duplicate work.
5. Continue cloud-capable work while the PC is off.
6. Resume local-only work safely when the PC returns.
7. Produce and revise real artifacts.
8. Research, code, test, operate sites/apps and communicate through providers.
9. Schedule and react to events.
10. Reuse successful work as Recipes.
11. Inspect exactly what happened and why.
12. Recover from crashes/ambiguous effects without duplicate destructive actions.
13. Search and reuse project knowledge without re-explaining the project.
14. Receive only material attention requests.
15. Verify the final real-world result before declaring success.
16. Operate core UI with Windows keyboard + NVDA.

## 8. North-star metrics

Track by release:
- median TIME_TO_VERIFIED_FINISHED_OUTCOME;
- owner interventions per completed job;
- repeated context manually re-entered;
- duplicate/conflicting worker rate;
- task success after restart;
- exact-effect ambiguity resolution rate;
- verifier reopen rate;
- Recipe reuse savings;
- tool/provider success rate;
- cloud/local handoff success;
- accessibility regression count;
- release benchmark success by capability family.

Optimize these metrics, not PR/commit/comment count.

## 9. Definition of finished product

"Finished" does not mean that one Agent demo works.

The final Autopilot is reached only when the same coherent platform can:
UNDERSTAND -> PLAN -> DELEGATE -> ACT -> VERIFY -> RECOVER -> LEARN PROCEDURES -> REUSE -> REPORT
across chats, web, desktop, files, code, data, communication and connected services, with owner-controlled authority, durable local/cloud continuity, evidence-bound completion and keyboard/NVDA usability.

This file is a binding end-state contract. Intermediate implementation ordering may change from live evidence; the final capability contract may only be narrowed by explicit owner decision.


## 10. Frontier productivity acceleration addendum — binding 2026-09-19

The following capabilities are additive final-scope requirements because they directly reduce coordination latency, waiting, context switching and manual supervision. They MUST reuse the canonical scheduler/Core/policy/recovery/Agent/Artifact authorities rather than create parallel engines.

### 10.1 Completion-driven swarm scheduling and work stealing
The current fixed recurring pulse model is a bootstrap/watchdog, not the final optimum. Where reliable terminal/change events exist, the finished product must refill work immediately on completion.

Required behavior:
- worker/agent terminal events immediately release capacity and wake reconciliation/refill;
- idle eligible workers may safely steal the highest-value unowned READY work after live conflict/dependency checks;
- critical-path and dependency-aware prioritization outranks round-robin fairness;
- account/model/provider rate limits, concurrency ceilings and temporary failures feed dispatch/backpressure;
- fixed interval pulses remain bounded watchdog/recovery fallback when event delivery is unavailable or suspect;
- dispatch sends delta Context Capsules instead of repeatedly resending full project history;
- no worker receives artificial busywork merely to keep a slot occupied.

Track queue latency, worker idle time while READY work exists, duplicate claim rate, critical-path completion time and manual coordination minutes per outcome.

### 10.2 Owner takeover -> observe -> handback
The owner must be able to take over a browser, desktop/app surface, code/artifact workspace or other interactive execution surface while an Agent is running, make a manual correction, then hand control back without losing the task.

Handback requires fresh world-state observation, stale-target invalidation, exact-effect reconciliation where needed and continuation from the new verified state. Manual intervention must not silently reset the task or duplicate already-completed effects. The flow must be keyboard/NVDA operable.

### 10.3 Plan-while-executing and live shared workboard
Planning and execution should not be artificially serialized. While existing work runs, the owner or another authorized collaborator/Agent may add requests, refine priorities or create new independent tasks.

Provide one accessible shared board/state view with at least Draft/Ready/Active/Review/Blocked/Done semantics, dependency/conflict visibility and agent ownership. New tasks are sequenced automatically from dependencies and capacity. Owner policy decides whether a merge/effect needs ASK; planning itself does not impose a hidden confirmation barrier.

### 10.4 Branch / Variant Laboratory
Support context-preserving parallel exploration for code, design, documents, prompts, plans and other reversible internal artifacts:
- isolated candidate branches/variants from one checkpoint;
- concurrent execution when safe;
- side-by-side comparison of artifacts, tests, visual/accessibility results, cost/time and verifier evidence;
- evidence-based select/merge or synthesis;
- explicit provenance, discard and rollback.

External real-world effects are not rewound by branching; they continue to use exact-effect/compensation semantics.

### 10.5 Artifact + Design Canvas with accessible semantic twin
Add an optional workspace where multiple artifacts can be explored together with live previews and variants: web/app UI, documents, slides, images, dashboards, data views and code-backed previews.

Direct manipulation must update the underlying versioned artifact rather than create a disconnected mockup. A visual canvas MUST have a keyboard/NVDA-accessible semantic twin: structured artifact tree, properties, variants, commands, status and comparison results. No core workflow may become canvas-only.

### 10.6 Provider / connector recommendation and capability discovery
Given an owner goal, Autopilot should determine which already-authorized provider, skill, Recipe, MCP server, direct API, browser path or local tool is the most deterministic path.

If a useful provider is missing, the UI may recommend it with explicit capability/permission/source information. Discovery/recommendation never grants permission and never silently installs or authenticates a provider. The capability registry must be machine-readable and feed planning/routing.

### 10.7 Continuous build -> publish -> operate loop
For owner-authorized software, websites and CMS work, completion can extend beyond producing source:

preview/staging -> automated tests -> accessibility/performance checks -> publish/deploy -> synthetic/live verification -> monitor -> detect regression/anomaly -> repair or rollback under policy.

Auto-publish/continuous operation is optional per Project and must use release identities, evidence, rollback points and exact-effect semantics. A successful local build is not proof of a healthy production deployment.

### 10.8 Meeting / recording / multimodal -> Project actions
Support owner-authorized meeting or recording ingestion as a first-class Project input:

transcript/notes/audio/video/artifacts -> decisions -> action items -> assigned Tasks -> calendar/follow-up drafts -> Project memory/source links.

The pipeline must separate verbatim source, extracted claims, decisions and inferred tasks; retain provenance; support correction; and respect recording/privacy policy.

### 10.9 First-class Data/Analytics Agent workflows
Beyond ad-hoc Python, provide source-aware data work across authorized spreadsheets, databases, warehouses/APIs and files:
- schema discovery;
- query/transform lineage;
- reproducible analysis;
- interactive/static dashboards and reports;
- anomaly/change detection;
- scheduled monitoring;
- verifier checks for calculations and source freshness;
- trigger downstream actions under owner policy.

Data conclusions must retain source/query/time provenance and expose uncertainty rather than silently convert stale data into durable Project facts.

### 10.10 Mobile and optional voice quick-control plane
Cross-device continuity should include a lightweight mobile control experience for status, notification, pause/resume/stop, owner ASK decisions, quick task creation and result review. Optional voice commands may accelerate hands-free operation but must map onto the same authenticated owner policy and have a complete non-voice keyboard/text equivalent. Mobile/voice is a surface over canonical jobs, never a second orchestration engine.

### 10.11 Readiness/evaluation gates, not demo-based confidence
Each provider/specialist/Agent release should expose a readiness view backed by repeatable test sets and observable acceptance contracts. Support curated golden cases plus generated/adversarial cases, regression history and capability-family pass/fail status.

A capability is not production-ready because one demo worked. Release/readiness requires applicable deterministic, recovery, policy, security, accessibility and end-to-end gates.

### 10.12 Project learning from accepted work
Projects may learn conventions, preferred structures, accepted fixes, routing outcomes and reusable domain procedures from completed tasks. Learning must be source-linked, inspectable and reversible. Repeated accepted behavior should be proposed for promotion into Project Skills/Recipes rather than silently rewriting owner instructions or Core policy.

## 11. Productivity metrics addendum

In addition to existing North-Star metrics, track where technically observable:
- READY-work queue latency;
- worker utilization and avoidable idle time;
- completion-driven refill latency;
- work-stealing success/conflict rate;
- context bytes/tokens resent per verified outcome;
- owner coordination minutes per Project;
- takeover/handback resume success;
- branch/variant merge success and conflict rate;
- time from accepted change to verified deployment;
- automated regression detection-to-repair time;
- provider recommendation acceptance/success rate;
- percentage of repeated workflows served by verified Recipes/Skills rather than fresh reasoning.

These metrics exist to minimize TIME_TO_VERIFIED_FINISHED_OUTCOME, not to maximize agent activity.


## 12. FINAL COMPETITIVE PARITY+ ADDENDUM — 2026-09-19

This section is binding final scope. It captures additional frontier patterns verified after the earlier North Star expansion and translates them into Autopilot product requirements without cloning any competitor's internal architecture.

### 12.1 Portable Skill Packs as a first-class product surface

Autopilot must support discoverable, composable, versioned Skill Packs that package procedural knowledge, scripts, resources, schemas, evaluators and provider bindings. A Skill Pack is not a new Agent Core: it is loaded on demand behind the canonical policy/orchestration/tool contracts.

Required properties:
- minimal relevant loading rather than dumping all skill instructions into every context;
- source/version/provenance/signature;
- declared capabilities and permission requirements;
- dependencies and compatibility constraints;
- tests/evals and readiness state;
- update/rollback;
- Project-level enable/disable;
- local/private and shared/team distributions;
- conversion path from a verified Recipe to a reusable Skill Pack;
- import/export and future marketplace/catalog support.

### 12.2 Wide parallel execution and research

The Agent must be able to decompose suitable goals into many independent parallel subtasks, with an owner-configurable fanout and global resource governor. This applies to research, coding, audits, migrations, content/catalog work, data analysis and verification.

The system must distinguish true parallelizable work from dependency-bound work. Parallelism must never create duplicate mutation ownership. Required mechanics include:
- plan DAG and critical path;
- dynamic fanout/fanin;
- isolated child context/workspace;
- live conflict keys/leases;
- result synthesis and contradiction detection;
- per-child budget/model/provider selection;
- early cancellation of redundant/low-value branches;
- work stealing/backpressure when one queue is blocked and another is executable;
- verifier-led merge of child results.

### 12.3 Cloud computer pool / execution fabric

Beyond one persistent cloud workspace, Autopilot should support a pool of isolated cloud execution environments for concurrent browser/code/data work when demand requires it.

The pool is an execution fabric behind the same canonical task identity, policy and exact-effect authority. Requirements:
- isolated per-Agent/Project workspace;
- warm/cold capacity management;
- browser/terminal/filesystem capability descriptors;
- resumable checkpoints and artifact sync;
- explicit local-vs-cloud affinity;
- capacity/rate/cost scheduling;
- no hidden duplication of scheduler/recovery/policy;
- secure teardown/scrubbing and evidence retention;
- deterministic handoff back to local execution when local-only resources are required.

### 12.4 Run Timeline, replay and evidence map

Every consequential long-running job needs an accessible run timeline that explains observable actions without exposing hidden chain-of-thought.

Surface:
- plan revisions;
- tasks/subagents and ownership changes;
- tool/provider invocations;
- external effects and exact-effect IDs;
- before/after state/evidence;
- screenshots or semantic snapshots where useful;
- test/verifier outcomes;
- errors/retries/reconciliation;
- checkpoints;
- artifacts;
- costs/runtime/tool usage where available;
- owner interventions/takeovers;
- final acceptance evidence.

Support replay for understanding/debugging and safe deterministic re-run only through Recipe/exact-effect rules; replay must never blindly repeat external effects.

### 12.5 Human supervision and escalation routing

ASK must become a complete supervision workflow, not merely a modal confirmation.

Support:
- named authorized reviewer(s) in team mode;
- reason + exact requested decision;
- bounded choices and data needed for the decision;
- timeout/escalation policy;
- mobile/notification delivery where available;
- durable WAITING_APPROVAL state;
- resume from the same durable step after decision;
- no loss of surrounding context/evidence;
- explicit difference between owner policy ASK and model uncertainty/clarification.

Human supervision is a workflow feature, not a safety guarantee. Exact-effect and technical validation remain mandatory.

### 12.6 Agent identity, RBAC and organizational governance

For shared/team/commercial operation, every human user, top-level Agent, subagent and remote Agent peer needs durable identity and auditable authority.

Required:
- role-based and resource-scoped grants;
- per-agent identity/service identity where providers support it;
- separate credential ownership;
- organization policies that constrain but do not silently broaden user authority;
- audit export;
- provider/data loss prevention rules;
- inventory of Agents, Skills, Recipes, providers and active executions;
- readiness/security status by capability;
- revocation/rotation without corrupting running durable state.

### 12.7 Capability Discovery and best-path planner

Before acting, the system should discover the safest/fastest available path for the requested outcome and rank execution methods by determinism and cost:
API/provider -> deterministic CLI/object model -> semantic browser/UIA -> visual computer use -> OCR fallback.

Capability discovery must consider:
- installed/connected providers;
- authenticated account/origin;
- current permissions;
- provider health/readiness;
- data locality;
- estimated latency/cost;
- required verification;
- Project policy;
- exact-effect support.

Recommendation/discovery never grants permission, installs software or authenticates implicitly.

### 12.8 Outcome Contract Builder

For a non-programmer, the system should translate a natural-language goal into an inspectable Outcome Contract containing:
- desired result;
- observable completion criteria;
- important constraints;
- source-of-truth locations;
- allowed authority;
- budget/time/concurrency boundaries;
- required deliverables;
- verifier plan;
- optional schedule/triggers.

The owner can accept/edit it, then the same contract drives planner, workers and verifier. This reduces prompt engineering and repeated clarification dramatically.

### 12.9 Project Bootstrap / instant onboarding

Create a Project from existing reality with minimal manual setup. Autopilot should be able to inspect owner-authorized repo(s), Drive folders/docs, websites/CMS, local folders, issue trackers and selected chats, then propose:
- Project goal/state summary;
- source-of-truth map;
- current architecture/assets;
- open blockers;
- candidate tasks;
- policies/credentials/providers needed;
- initial Context Capsule;
- initial eval/acceptance suite.

Nothing discovered becomes owner instruction automatically; the bootstrap is reviewable and source-linked.

### 12.10 Diff-first owner review

To reduce attention cost, default owner review should emphasize changes and exceptions rather than full transcripts.

Provide:
- what changed;
- why it changed at an outcome/evidence level;
- files/artifacts/effects changed;
- tests/verifier results;
- unresolved risks;
- only decisions needing attention;
- rollback/compensating options where applicable.

For blind/NVDA users this must be a complete text/semantic experience, not a visual diff-only surface.

### 12.11 Remote steering and cross-device control

A running Agent should be inspectable and steerable from another authorized device without moving the underlying local-only data off the local host unless policy permits.

Support:
- status;
- pause/resume/stop;
- add instruction;
- answer ASK/clarification;
- approve handoff to another execution plane;
- view compact trace/evidence;
- receive completion/blocker notifications.

Remote steering changes instructions/state through the same canonical durable control plane.

### 12.12 Continuous improvement loop

The product should improve from verified outcomes using a gated promotion loop:
run evidence -> failure/success classification -> candidate improvement -> regression/eval -> owner/team review where required -> versioned promotion.

Candidate improvements may target:
- Recipe/Skill procedure;
- provider selection heuristic;
- verifier rule;
- Context Capsule selection;
- retry/recovery strategy;
- Project convention.

Core owner policy and safety contracts are never silently self-modified.

### 12.13 Competitive acceptance criteria

World-class parity is not feature-count parity. A capability is competitive only if it demonstrates:
- real end-to-end completion;
- long-horizon continuation;
- restart/recovery;
- ambiguity reconciliation;
- low duplicate-work/effect rate;
- accessible owner control;
- observable evidence;
- bounded resource use;
- secure identity/credentials/data flow;
- current-source grounding;
- portable/reusable procedure where repetition exists.

### 12.14 Final user-value objective

The product should make a capable non-programmer able to operate many simultaneous software/research/operations projects with dramatically less coordination overhead. The dominant product KPI remains TIME_TO_VERIFIED_FINISHED_OUTCOME, accompanied by OWNER_ATTENTION_MINUTES_PER_OUTCOME and VERIFIED_AUTOMATION_REUSE_RATE.


## 13. POST-EXISTING PRIORITY — PRODUCTIVITY INTELLIGENCE LAYER

Status: BINDING ADDITIVE FINAL SCOPE, LOWER PRIORITY THAN THE CAPABILITY FAMILIES ALREADY DEFINED ABOVE.
Owner ordering decision: implement this layer AFTER the already-ratified North Star / competitive parity+ scope and its dependency-ordered delivery horizons, unless a narrowly scoped component is later proven to be a direct prerequisite for an already-prioritized capability. This addendum MUST NOT displace active MCP/SCHED/provider/Project/Agent/Recipe/cloud/reliability work merely because it is newer.

Purpose: after Autopilot already has the planned provider, Project/Context, Agent/subagent, Verifier, Recipe/Skill, artifact, cloud/local, observability, evaluation and reliability foundations, add a higher-order productivity layer whose job is to reduce owner attention, repeated context processing, duplicated work, unnecessary model reasoning and cross-project reinvention.

This layer extends the existing canonical Core. It MUST NOT create scheduler #2, Project/Context engine #2, memory authority #2, policy engine #2, router #2, recovery #2, Agent framework #2 or provider authority #2.

### 13.1 Attention OS / Owner Attention Optimizer

Treat owner attention as a scarce governed resource, not an unlimited fallback.

For every potential owner interruption, estimate at least:
- consequence/risk of a wrong autonomous decision;
- reversibility/compensability;
- cost of delay;
- deadline proximity;
- uncertainty;
- whether canonical sources can answer the question automatically;
- whether several questions can be batched into one decision;
- whether the task can safely continue around the unresolved point.

Required behavior:
- suppress routine status noise;
- batch related decisions;
- surface only material blockers/ASK items;
- provide bounded choices, evidence and consequence;
- resume the exact same durable step after the decision;
- never convert model uncertainty into owner interruption when a safe deterministic evidence-gathering action is available first.

Primary metric: OWNER_ATTENTION_MINUTES_PER_VERIFIED_OUTCOME.

### 13.2 Semantic Change Bus / Incremental Recompute Graph

Event triggers should carry semantic deltas, not only “something changed”.

Maintain dependency relationships between source changes and affected:
- Project facts;
- Context Capsules;
- plan nodes;
- artifacts;
- tests;
- verification requirements;
- Recipes/Skills;
- downstream tasks.

A change should invalidate/recompute only the affected subgraph when possible. Example: README-only change must not wake unrelated security/release workers; a scheduler contract change should invalidate only scheduler-dependent implementation/tests/UI/docs/release evidence.

Required primitives:
- change identity and source revision;
- semantic delta classification;
- dependency edges;
- invalidation set;
- recomputation priority;
- stale-derived-state marker;
- verifier coverage for incremental correctness.

Goal: reduce repeated full-project rereads and unnecessary worker/model activation.

### 13.3 Context Compiler / Delta Context Capsules

Evolve Context Capsules into an incrementally compiled context system.

Every reusable context fragment should preserve:
- source identity;
- source revision/SHA;
- authority class;
- dependencies;
- freshness/staleness state;
- hash;
- cached structured summary;
- retrieval pointer for full material.

When a worker already knows Project Capsule revision N, prefer a bounded delta from N -> N+1 rather than resending the entire project history. Large material remains referenced and retrieved on demand.

Track:
- context bytes/tokens resent per verified outcome;
- worker startup latency;
- stale-context incidents;
- invariant loss after compaction;
- cache/reuse hit rate.

### 13.4 Truth Arbitration Engine

Formalize fact-specific canonical truth resolution.

Different fact classes may have different authority order. Examples:
- deployed revision -> deployment/provider/live system;
- current source -> canonical Git main;
- owner product requirement -> latest explicit owner instruction / binding product authority;
- sent email -> mail provider state;
- document revision -> configured canonical document/provider.

Required:
- configurable truth rules by resource/fact class;
- provenance and revision;
- conflict detection;
- automatic refresh from the highest-authority available source;
- stale memory/summaries never outrank newer canonical evidence;
- unresolved conflicts become one bounded Attention OS item rather than repeated worker debate.

### 13.5 Cross-Project Intelligence Graph

Add a portfolio-level graph across owner-authorized Projects/repositories to prevent repeated engineering.

Index reusable:
- components/contracts;
- tests/invariants;
- providers;
- schedulers/recovery patterns;
- memory/context patterns;
- accessibility mechanisms;
- evaluation infrastructure;
- release/deployment mechanisms;
- known donor implementations.

Before a Project implements a generic infrastructure capability, query the graph for existing first-party implementations and produce:
- likely donor(s);
- semantic similarity;
- compatibility/gap summary;
- provenance/license boundary;
- reusable tests/invariants;
- thin-adapter opportunity;
- reason to reuse or reason not to.

This generalizes project-specific donor rules into an Autopilot-wide capability while preserving each Project's own domain authority.

### 13.6 Duplicate Work Radar

Claims/leases prevent exact ownership collision; Duplicate Work Radar must detect semantic/causal overlap even when task names differ.

Compare active/planned work by:
- affected subsystem/files/resources;
- intended outcome;
- dependencies;
- acceptance criteria;
- conflict keys;
- semantic similarity;
- expected side effects.

On high overlap:
- merge tasks;
- redirect one worker to independent verification/review;
- narrow scopes;
- delay one lineage;
- require explicit parallel-variant semantics if both are intentionally retained.

Track duplicate/conflicting worker rate and avoided duplicate work.

### 13.7 Agent-to-Automation Compiler

Repeated Agent reasoning should progressively become cheaper deterministic execution where evidence supports it.

Lifecycle:
Agent exploration -> verified successful trace -> secret/private-data sanitization -> parameter inference -> Candidate Recipe/Skill -> deterministic replay -> verifier/evals -> versioned promotion.

Optimization ladder:
deterministic algorithm/API/Recipe -> small/local model -> stronger/local model -> cloud model only when justified.

The system should identify repeated reasoning patterns and propose compilation when recurrence and stability justify it. Promotion never silently expands owner authority.

Primary metric: VERIFIED_AUTOMATION_REUSE_RATE plus saved model/runtime/owner attention.

### 13.8 Live Provider Canary Network

Readiness must be continuously observed, not only asserted at release time.

Run bounded harmless canaries appropriate to each provider/capability, such as:
- ChatGPT composer/state detectability;
- GitHub read path;
- Drive metadata/read path;
- MCP handshake/schema;
- Native Companion health/capabilities;
- UIA safe test enumeration;
- cloud checkpoint/resume;
- provider authentication/readiness without consequential mutation.

A failed canary may:
- lower provider readiness;
- remove the provider from critical routing;
- activate a safe fallback;
- create a repair task;
- block consequential work that lacks a verified execution path.

Never use a canary to perform destructive or economically consequential actions.

### 13.9 Shadow Mode / Autonomy Qualification

Provide an explicit SHADOW execution mode:
- observe live state;
- plan;
- choose tools/actions;
- predict effects and verification;
- record what would have been executed;
- do not perform external consequential effects.

Use shadow evidence to compare proposed autonomous behavior with verified human/production outcomes. Authority may progress by effect class through:
SHADOW -> ASK -> ALLOW,
only under owner policy and readiness/evaluation evidence.

### 13.10 Agent Workflow Debugger

Extend the Run Timeline into a professional debugging surface for Agent workflows.

Support:
- breakpoint before selected effect classes;
- inspect world-state snapshot at a checkpoint;
- inspect plan/task/provider/policy/evidence state;
- replay safe internal planning/tool-selection from a checkpoint;
- run an alternate model/router/plan branch without repeating external effects;
- create branch/variant continuations from internal checkpoints;
- compare divergences and verifier outcomes.

Replay/debugging MUST NOT reveal hidden chain-of-thought and MUST NOT blindly re-execute external effects.

### 13.11 Multi-Account Identity Graph

Credentials and identity are separate concepts. Maintain durable owner-authorized identity/account context for:
- browser profiles;
- ChatGPT accounts;
- Google accounts;
- GitHub identities/orgs;
- CMS environments;
- workspaces/tenants;
- staging vs production identities.

A job/provider invocation may require an explicit identity scope. Before consequential action, verify that observed authenticated identity matches the required identity. Wrong-account ambiguity blocks/reconciles rather than executing “the right action in the wrong account”.

### 13.12 Deadline / SLA Brain

Extend priority/resource governance with deadline-aware completion forecasting.

Estimate whether the current plan is likely to meet owner deadlines/SLA constraints using observed throughput, dependencies, queue state, provider readiness and uncertainty.

When risk increases, policy may:
- increase safe fanout;
- allocate stronger/faster models;
- activate cloud capacity;
- defer lower-value work;
- prune low-value speculative branches;
- prioritize dependency-unlocking tasks;
- surface an owner decision only when automatic reallocation cannot preserve the target.

Do not claim precise outcome probabilities without calibrated evidence; use bounded operational risk classes until sufficient empirical data exists.

### 13.13 Human-Time Economics

Resource optimization must include owner time, not only token/API cost.

Routing/governance should compare expected:
- machine/API cost;
- runtime/latency;
- probability of verifier pass;
- expected rework;
- owner review/coordination minutes;
- deadline cost.

A slightly more expensive model/provider may be preferred when it materially reduces owner attention or rework and remains within policy/budget.

### 13.14 Autopilot SDK / CLI / Local API

Expose the canonical Autopilot control plane programmatically without creating a second orchestration authority.

Future supported operations should include authenticated/scoped forms of:
- create/open Project;
- submit Outcome Contract;
- start/pause/resume/stop Agent;
- inspect status/plan/evidence;
- submit ASK decision;
- trigger Recipe/Skill;
- register/query provider capabilities;
- subscribe to canonical events;
- query artifacts/results.

CLI/API/SDK calls map onto the same durable identities, policy, scheduler, recovery and exact-effect semantics as the UI.

Goal: allow owner applications and other first-party Projects to use Autopilot as an execution platform instead of rebuilding automation infrastructure.

### 13.15 User-Facing ROI / Automation Opportunity Engine

Provide a simple evidence-backed productivity report, not vanity activity metrics.

Possible outputs:
- verified outcomes completed;
- estimated owner coordination time avoided;
- repeated context avoided;
- percentage of repeated workflows served by verified Recipes/Skills;
- model/provider/runtime spend;
- rework and verifier reopen rate;
- top causes of delay;
- top recurring manual workflows;
- recommended next automation/Recipe opportunity.

Recommendations must cite observable run history and must not fabricate precise time savings when only rough estimates are available.

## 14. Agent maturity reinforcement — no duplicate backlog

The earlier Agent requirements remain higher-priority and authoritative: broad tool/provider execution, durable Agent Plan DAG, hierarchical subagents, independent Verifier, long-horizon context, persistent cloud execution, world-state freshness, self-testing/repair, procedural learning, adaptive routing and exact-effect recovery.

This addendum does NOT create replacements for those items. It adds the following maturity criteria after their foundations exist:

- negative/failure memory: failed approaches and known failure signatures remain retrievable so Agents do not repeatedly rediscover the same dead ends;
- empirical routing: model/provider routing should increasingly use measured verifier pass rate, latency, cost, rework and task-class performance rather than static assumptions;
- world-state identity binding: account/environment/revision/lease freshness is verified before consequential actions;
- reasoning-to-determinism pressure: repeated stable work should migrate toward Recipes/APIs/algorithms;
- live readiness pressure: critical routing should prefer currently healthy, recently canary-verified providers;
- owner-attention pressure: Agents should gather evidence and resolve safe uncertainty before escalating to the owner.

## 15. Post-existing delivery order

The binding implementation rule for this addendum is:

1. Continue current active lineages and already-ratified North Star dependencies first.
2. Complete the existing provider/Project/Context/Agent/subagent/Verifier/Recipe/Artifact/cloud/observability/evaluation/reliability foundations in their dependency-driven order.
3. Do not open speculative parallel branches for this addendum while earlier prerequisite scope is unfinished.
4. When earlier foundations make these capabilities executable, auditors may promote the highest-leverage unowned Productivity Intelligence slice.
5. Exception: a narrow component may move earlier only when live evidence proves it is a direct dependency or materially shortens an already-prioritized critical path without duplicating authority.
6. Newness of this addendum alone is NEVER a reason to outrank earlier work.

Candidate post-existing slice IDs for future queueing:
ATTN-001, CHANGE-001, CTXCOMP-001, TRUTH-001, XPROJECT-001, DUPRADAR-001, AUTOCOMP-001, CANARY-001, SHADOW-001, DEBUG-001, IDGRAPH-001, SLA-001, HUMANCOST-001, SDK-001, ROI-001.

These IDs are planning labels only. They are not READY_NOW claims and must not be instantiated as mutation lineages until the live dependency/ownership auditor promotes them.

## 16. Extended value objective

After the already-defined whole-product capabilities are implemented, the next optimization ceiling is not “more Agent activity”. It is:

MINIMIZE
- TIME_TO_VERIFIED_FINISHED_OUTCOME;
- OWNER_ATTENTION_MINUTES_PER_VERIFIED_OUTCOME;
- REPEATED_CONTEXT_PROCESSING;
- DUPLICATE_CAUSAL_WORK;
- UNNECESSARY_MODEL_REASONING;
- CROSS_PROJECT_REINVENTION;

while maximizing:
- VERIFIED_AUTOMATION_REUSE_RATE;
- INCREMENTAL_RECOMPUTE_RATE;
- CONTEXT_DELTA_REUSE;
- PROVIDER_LIVE_READINESS;
- SAFE_AUTONOMY_COVERAGE;
- CROSS_PROJECT_COMPONENT_REUSE.

The final intended experience remains: the owner states the outcome and authority once; Autopilot chooses and coordinates the best available execution path, minimizes unnecessary owner involvement and repeated reasoning, proves the result, learns reusable procedure safely, and reuses existing first-party capability instead of rebuilding it.
