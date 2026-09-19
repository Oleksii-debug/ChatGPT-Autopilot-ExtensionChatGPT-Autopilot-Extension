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
