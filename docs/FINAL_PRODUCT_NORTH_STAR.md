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
- calendar scheduling from #151;
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
