# AUTOPILOT COMPETITIVE AGENT GAP MATRIX — 2026-09-19

Status: RESEARCH / IMPLEMENTATION INPUT
Purpose: convert current frontier-agent product patterns into concrete Autopilot requirements without cloning a competitor's architecture.

## Research principle

Autopilot should reuse proven product patterns while preserving its own canonical scheduler, exact-effect/recovery model, owner policy, Browser Agent, AI Gateway/Router and Native Companion.

Competitor claims are evidence of useful capability patterns, not proof that their implementation is appropriate for Autopilot.

## OpenAI / ChatGPT Work + Agents API

Observed public patterns in 2026:
- long-running work across apps/files;
- work can persist for hours;
- local files/apps plus built-in browser on desktop;
- connected applications;
- Scheduled Tasks including recurring and event/change monitoring;
- cross-device start/status/continuation;
- finished editable artifacts;
- managed cloud agent infrastructure;
- subagent coordination and persistent environments in Agents API.

Autopilot gap/response:
- persistent cloud execution plane;
- cross-device continuation;
- trigger/event providers beyond cron;
- Project/Artifact workspace;
- subagent orchestration;
- context harness;
- finished artifact pipelines.

References:
- OpenAI, "ChatGPT is now a partner for your most ambitious work", 2026-07-09.
- OpenAI, "Introducing the Agents API", 2026-09-10.
- OpenAI Scheduled Tasks documentation, updated 2026.

## Anthropic / Claude Code + Claude platform

Observed patterns:
- subagents;
- background tasks;
- hooks;
- checkpoints and rewind;
- project/user instruction memory;
- reusable skills/plugins;
- MCP;
- autonomous permission modes with containment;
- long-running coding;
- fleet/dynamic-workflow patterns;
- team/channel integration and proactive future work.

Autopilot gap/response:
- safe checkpoint/rewind for internal state;
- trigger/hook layer;
- clearer Project memory tiers;
- skill/Recipe packages;
- sandbox/containment profiles;
- agent fleet UI and clean child contexts;
- policy-aware automation that reduces approval fatigue without silently broadening authority.

References:
- Anthropic, "Enabling Claude Code to work more autonomously".
- Anthropic, "Steering Claude Code: when to use CLAUDE.md, skills, hooks, and subagents", 2026-06-18.
- Anthropic, "How we built Claude Code auto mode", 2026-03-25.
- Anthropic MCP documentation.

## Google / Gemini CLI

Observed patterns:
- specialized subagents with independent context windows;
- per-subagent tools and MCP servers;
- tool isolation and per-agent policies;
- automatic delegation;
- custom agent definitions;
- remote subagents via Agent2Agent (A2A).

Autopilot gap/response:
- specialist registry with isolated context/tool grants;
- explicit child capability narrowing;
- approved remote-agent/A2A interoperability;
- portable specialist definitions;
- remote Agent Cards/capability discovery.

References:
- Gemini CLI Subagents documentation.
- Gemini CLI Remote Subagents documentation.
- A2A Protocol 1.0 documentation.

## Microsoft Copilot Studio

Observed patterns:
- computer use for websites and desktop applications;
- hosted browser / cloud PC / bring-your-own machine choices;
- reusable skills;
- persistent memory;
- async long-running flows;
- MCP tools;
- agent identity/governance;
- runtime/readiness observability.

Autopilot gap/response:
- execution-plane abstraction including managed cloud environments;
- reusable skill packages;
- memory controls;
- stronger operational dashboard/readiness;
- agent identity and team governance for shared mode;
- first-class desktop semantics and computer-use fallback.

References:
- Microsoft Learn, Computer Use in Copilot Studio, updated 2026.
- Microsoft Copilot Studio What's New, 2026.

## Devin

Observed patterns:
- coordinator can create/manage multiple child Devins in parallel;
- each child has isolated environment, terminal, browser and tests;
- coordinator monitors, messages, pauses/stops and merges results;
- child execution trajectories feed future decomposition;
- recurring scheduled Devin sessions.

Autopilot gap/response:
- coordinator-managed child Agent tree;
- per-child isolated workspace;
- child progress/budget telemetry;
- result merger;
- learned decomposition signals;
- scheduled autonomous specialist work through canonical #151 scheduler.

References:
- Cognition, "Devin can now Manage Devins", 2026-03-19.
- Cognition, "Devin can now Schedule Devins", 2026-03-20.

## Replit Agent

Observed patterns:
- extended Max Autonomy runs;
- self-management over longer task lists;
- browser testing of created applications;
- automatic repair after failures;
- ability to build agents and automations.

Autopilot gap/response:
- self-testing verifier loop;
- app/site browser acceptance as normal completion work;
- autonomous repair/retest;
- natural-language automation/Recipe generation.

Reference:
- Replit, "Introducing Agent 3: Our Most Autonomous Agent Yet", 2025-09-10.

## Manus

Observed patterns:
- persistent always-on Cloud Computer;
- desktop "My Computer" with local files/CLI/apps;
- cross-device continuation;
- background use of local resources.

Autopilot gap/response:
- persistent cloud workspace;
- robust LOCAL vs CLOUD execution affinity;
- durable plane handoff;
- local CLI/files/app capability through Native Companion;
- cross-device status/continuation.

References:
- Manus Help Center, "What is the Cloud Computer?", 2026-06-05.
- Manus Help Center, "What is the My Computer feature capable of?", 2026-03-24.

## OpenHands

Observed patterns:
- model-agnostic agent SDK;
- custom agent behavior;
- tool/API integrations;
- model routing;
- fine-grained execution control;
- isolated coding workflows;
- large-codebase understanding and parallel work.

Autopilot gap/response:
- keep OpenHands behind CodingSpecialistProvider;
- use structured codebase/repo mapping;
- isolated workspaces;
- verifier-owned completion;
- model-agnostic specialist interface.

Reference:
- OpenHands SDK product/documentation, current 2026.

## Cross-competitor patterns that Autopilot must match or exceed

1. Long-running autonomous execution.
2. Persistent cloud environment.
3. Local computer access.
4. Multi-agent parallelism.
5. Child-agent isolation.
6. Persistent Project memory.
7. Reusable skills/workflows.
8. Event-driven triggers.
9. Connected apps/data.
10. Browser + desktop computer use.
11. Coding issue-to-tested-result loop.
12. Self-testing and repair.
13. Checkpoint/rewind.
14. Cross-device continuation.
15. Observability and governance.
16. Tool interoperability via MCP.
17. Agent interoperability via A2A.
18. Artifact generation and editing.
19. Model/provider routing.
20. Secure credentials and scoped authority.

## Areas where Autopilot should deliberately go beyond common competitor UX

### A. Exact-effect correctness as a first-class cross-provider primitive
Many products emphasize autonomy. Autopilot should make ambiguity/reconciliation and duplicate-effect prevention visible, generic and testable across every provider.

### B. Accessibility as architecture, not polish
Keyboard/NVDA operation, text-first trace and semantic computer-use targeting should be release gates rather than optional accessibility overlays.

### C. User-owned autonomy
Keep explicit ALLOW | ASK | DENY inheritance and transparent scope instead of forcing one universal confirmation policy.

### D. Procedural learning via verified Recipes
Do not merely remember prose. Turn successful runs into versioned, tested, deterministic workflows with drift fallback.

### E. Source/provenance-aware Project memory
Memory facts must retain evidence, revision and staleness semantics so old summaries cannot silently override current technical truth.

### F. One exact control plane across local and cloud
Do not fork scheduler/policy/recovery between browser extension, Windows Companion and cloud worker.

### G. Swarm coordination for ordinary users
Make multi-chat/multi-agent delegation, claims, conflicts and result merging usable without requiring GitHub expertise.

### H. Built-in verifier and acceptance contracts
The agent should prove the observable outcome instead of treating "I attempted it" or green partial CI as completion.

## Competitive acceptance bar

A capability is not considered competitive because a button exists. It must pass:
- long-run continuation;
- restart/recovery;
- exact-effect semantics;
- policy/credential enforcement;
- provenance;
- observability;
- accessibility semantics;
- adversarial/untrusted-content tests where relevant;
- real end-to-end vertical acceptance.

The final North Star is defined in docs/FINAL_PRODUCT_NORTH_STAR.md and GitHub #149.


## 2026-09-19 late verification addendum

Fresh public-product verification after the initial matrix confirms several frontier patterns that remain binding inputs for Autopilot:

### OpenAI / ChatGPT Work + Workspace Agents + Data Agent
- ChatGPT Work is positioned as end-to-end work across apps/files with long-running execution, editable finished artifacts, built-in browser use, local desktop context, cross-device continuation and Scheduled Tasks that can run on a schedule, trigger, or monitor for changes.
- Workspace Agents add reusable/publishable agents with model/effort choice, connected tools/apps, sharing, Slack use, scheduling and API triggering.
- The 2026 Data Agent pattern adds natural-language investigation over trusted company data plus interactive dashboards and action, reinforcing the need for a first-class Data/Analytics specialist and artifact/dashboard pipeline rather than treating analytics as ad-hoc chat.

Autopilot consequence: Project/Context Fabric, event triggers, plugin/provider packaging, reusable agent/skill definitions, cross-device cloud/local continuity, first-class data connectors, dashboard/artifact generation and governance remain final-product requirements.

### Google / Gemini computer use
- Gemini 3.5 Flash integrates computer use natively for browser/mobile/desktop action and long-horizon knowledge-work/testing scenarios.

Autopilot consequence: semantic desktop/browser execution with strong postcondition verification must be a first-class tool path, while deterministic API/CLI/UIA methods remain preferred when available.

### Manus Cloud Computer + My Computer
- Manus combines a persistent always-on cloud computer with local-machine access through the desktop app, including local files, CLI tools and applications.

Autopilot consequence: persistent cloud workspace plus owner-authorized local execution and durable plane handoff are competitive baseline capabilities, not optional extras.

### OpenHands Agent Control Plane
- OpenHands Enterprise explicitly frames scaling agents as a control-plane problem: central access control, workflow reuse/standardization, observability, audit trail, cost visibility and performance improvement over time.

Autopilot consequence: Swarm Workspace, agent identity, audit/trace, reusable Recipes/skills, cost/runtime telemetry, policy control and evaluation loops must be product surfaces, not hidden internals.

### Replit Agent evaluation/self-testing loop
- Replit emphasizes browser-based testing, automatic repair and continuous evaluation of whether generated applications actually work for users.

Autopilot consequence: Actor != Verifier, self-testing/retest loops and benchmark-driven improvement remain core completion semantics.

### Competitive interpretation
These findings do not justify cloning competitor architecture. They strengthen the existing North Star: one canonical Autopilot control plane should combine durable orchestration, owner policy, exact-effect recovery, local+cloud execution, Project memory/context, multi-agent delegation, reusable Recipes, first-class providers, finished artifacts, observability, accessibility and evidence-bound verification.


## 2026-09-19 frontier productivity verification addendum

Fresh verification adds several product patterns that were not explicit enough in the initial matrix.

### Replit Agent 4 — parallel build, shared board, plan-while-building, canvas/variants
Verified public 2026 patterns include:
- planning can continue while other agent tasks build in parallel;
- tasks run in isolated environments and surface on a shared task board;
- agent-assisted conflict/merge handling reduces manual Git coordination;
- a design canvas supports direct manipulation, live previews and side-by-side UI variants;
- multiple artifact types can share one project context.

Autopilot consequence:
- completion-driven multi-worker refill/work stealing and a live shared Swarm/Project board;
- plan-while-executing rather than forced plan -> wait -> build sequencing;
- Branch/Variant Laboratory and Artifact/Design Canvas with an NVDA-accessible semantic twin;
- automatic conflict detection/merge assistance as part of result consolidation rather than owner busywork.

Evidence reviewed: Replit “What’s changed from Agent 3 to Agent 4” (2026-03-19), “Introducing Replit Agent 4: Built for Creativity” (2026-03-11), and Agent 4 launch material (2026-03-23).

### Manus — Branch, Plan Mode, Auto-Publish, Project Skills, learning Projects and connector recommendation
Verified 2026 product catalog patterns include Branch, Plan Mode, Auto-Publish, persistent Cloud Computer, My Computer, Scheduled Tasks 2.0, Project Skills, Projects that learn from every task, connector recommendation, Meeting Minutes, preferred browser, multi-account Google connections and broad app connectors.

Autopilot consequence:
- Project Skills/Recipes and source-linked project learning remain final scope;
- provider/connector recommendation should use capability discovery but never silently grant/install/authenticate;
- continuous preview/publish/monitor/rollback should be a first-class release/operations workflow;
- meeting/recording -> actions/project-memory should be a first-class pipeline;
- branch/variant and local/cloud handoff must be product UX, not hidden implementation detail.

Evidence reviewed: Manus 2026 product announcements, Cloud Computer help (2026-06-05), and My Computer help (2026-03-24).

### Microsoft Copilot Studio — readiness and evaluation as product surfaces
Verified 2026 Microsoft material exposes computer-use operations, MCP/tool integration, agent inventories, readiness/status views, usage/cost telemetry and customizable evaluation test sets.

Autopilot consequence:
- provider/Agent readiness must be shown as observable tested state;
- golden + generated/adversarial test sets should feed release gates;
- cost/runtime/result telemetry belongs in Swarm/Project observability;
- desktop computer use remains a managed capability behind policy rather than an opaque model action.

### Anthropic / Claude Code — subagents, MCP, hooks and encoded team conventions
Verified 2026 Anthropic guidance emphasizes subagents, hooks, MCP and context strategies for scaling real codebases and encoding team conventions.

Autopilot consequence:
- Project Skills/Recipes + event hooks/triggers should encode reusable team procedure;
- child agents need isolated context/tool scope;
- conventions learned from accepted work can be promoted into explicit versioned skills, never silently into Core authority.

### Human takeover / handback
Modern computer-use agents expose a practical need for the user to take control when automation is blocked or the user wants to intervene. Autopilot must make this reversible collaboration explicit:

take over -> mutate -> fresh observation -> reconcile -> hand back -> resume same durable job.

### Resulting high-leverage additions to the competitive baseline
21. Completion-driven dispatch/refill; timer polling only as watchdog fallback where events are unavailable.
22. Adaptive work stealing/backpressure across worker/account/model/provider capacity.
23. Takeover -> handback with world-state re-observation and safe resume.
24. Plan-while-executing shared task board.
25. Branch/Variant Laboratory with isolated candidates and evidence-based merge.
26. Artifact/Design Canvas plus complete accessible semantic twin.
27. Provider/connector recommendation without implicit permission.
28. Continuous build/publish/monitor/repair/rollback loop.
29. Meeting/recording -> decisions/tasks/project-memory pipeline.
30. First-class data/dashboard/anomaly workflows.
31. Mobile/optional voice quick control over the same canonical jobs.
32. Readiness/evaluation dashboard with repeatable golden/generated/adversarial tests.
33. Project learning that promotes accepted patterns into versioned Skills/Recipes.

These additions strengthen the same final North Star and do not authorize scheduler/Core/policy/recovery/browser/router duplication.
