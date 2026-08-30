# ChatGPT Autopilot — Configuration File and Orchestration V2

Status: implementation contract / active development
Base at claim time: `9049ade235dc4b2dd3a2a6493319c6874c90baeb`

## 1. Problem statement

The extension must remain usable when one Session contains tens of ChatGPT conversations and when several Sessions contain tens or hundreds of prompts. Manual creation of one Task field at a time is not an acceptable primary configuration workflow.

The options page must also remain responsive under runtime status updates and must not discard an unsaved configuration draft merely because the page is backgrounded/reloaded.

## 2. Configuration paths

The product supports three complementary paths rather than replacing one with another:

1. Manual per-Task configuration for small Sessions.
2. Bulk URL entry: paste many ChatGPT URLs in one textarea. URLs may be separated by whitespace/newlines and may appear in numbered prose. The UI extracts only valid `https://chatgpt.com` URLs, normalizes them, removes duplicates, and creates one Task per unique URL up to the 50-Task Session limit.
3. Portable JSON configuration file for large or AI-authored setups. The installed extension imports the file; the user does not reinstall the whole extension for every Session change.

## 3. Configuration file contract

Format identity: `chatgpt-autopilot-config`
Version: `1`
Modes:
- `replace-safe`: replace current Sessions only when every current Session is STOPPED/PAUSED/ERROR and there is no unresolved operation.
- `add`: add Sessions without overwriting existing ones; total Session limit remains 5.

The file may contain:
- 1–5 Sessions;
- 1–50 Tasks per Session;
- shared or unique prompt mode;
- shared prompt / per-Task prompt;
- continuous or one-pass run mode;
- send interval, pre-send delay, busy recheck, retry/backoff;
- tab strategy;
- optional autoStart per Session.

IDs are optional for AI-authored files. The Core generates durable IDs when absent.

Import is two-step in the UI:
1. select file -> parse/validate -> readable preview;
2. explicit Apply button -> atomic Core import.

A malformed file, unsupported version, duplicate identity, URL collision, unsafe replacement, unresolved send, or invalid prompt fails closed before partial mutation.

Top-level unknown documentation fields such as `_instructions` are ignored, so the bundled blank template can explain itself to another AI without becoming runtime state.

## 4. Portable AI workflow

The extension bundles a blank template JSON. The user can give this template to ChatGPT, Work, Gemini, or another assistant and describe the desired Sessions/URLs/prompts/timing. The assistant returns only a filled configuration file. The user imports it into the already-installed extension.

Private ChatGPT conversation URLs and private prompts must not be committed to the public repository. A filled configuration file is user-private data.

This same file contract is the future boundary for an embedded configuration AI: the AI produces constrained configuration data; deterministic Core validation remains authoritative.

## 5. UI stability contract

Runtime `STATUS_CHANGED` events must not rebuild the entire Session navigation list on every operation phase.

Required behavior:
- the background broadcasts only materially changed Session status;
- the UI coalesces status updates;
- selected Session runtime status/log/actions may update without re-rendering editable configuration fields;
- unselected Session state/count update in place;
- navigation DOM is rebuilt only for structural changes such as create/delete/duplicate/save/rename or explicit full reload;
- background status never steals focus;
- unsaved configuration draft is cached separately from canonical Core state and restored only if the canonical Session version has not changed;
- stale drafts are discarded rather than overwriting newer canonical data.

Human Windows 11/NVDA acceptance is still required before `NVDA_VERIFIED=true`.

## 6. Orchestration model — do not hardcode one development workflow

The scheduler should evolve from one round-robin behavior into orthogonal policies. A Session workflow is the composition of:

### Selection policy
- `ROUND_ROBIN`: stable 1 -> N -> 1 order.
- `READY_FIRST`: scan eligible Tasks; BUSY Tasks are skipped; act on the first ready Task.
- `FIXED_TASK`: one conversation repeated continuously.
- future `PRIORITY`: explicit Task priority without changing Task identity.

### Dispatch/cadence policy
- `SERIAL_THROTTLED`: current minimum gap between verified actual Sends.
- `READY_IMMEDIATE`: no artificial long Session cooldown after a Task becomes ready; physical Sends remain serialized and platform rate-limit evidence still causes backoff.
- `BATCH_WINDOW`: monitor/check Tasks during a window, then dispatch the eligible set when the configured batch deadline is reached.
- future scheduled windows may be added without changing Task semantics.

### Completion/trigger policy
- `WHEN_READY`: send when the selected Task is ready.
- `EVERY_INTERVAL`: execute on a configured Session interval.
- `BATCH_DEADLINE`: collect readiness and act at the batch deadline.

These dimensions cover, without separate ad-hoc products:
- one URL continuously;
- ten URLs, send to each as soon as it becomes ready;
- ten URLs monitored for 25 minutes, then dispatch a batch;
- several Sessions using different policies concurrently.

The profile-wide Send Arbiter remains authoritative for physical Send serialization and duplicate-send prevention. Rate limits are never bypassed.

## 7. Development-swarm configuration guidance

Repository evidence from the project family shows that extreme numbers of unconstrained workers create ownership collisions, superseded PRs and integration debt. The recommended product-level preset is persistent role lanes, not disposable waves with regenerated prompts after every cycle.

Recommended default for a large coding project:
- 1 coordinator/integrator Session;
- 1 independent auditor Session;
- 6–10 persistent developer Sessions with disjoint semantic ownership;
- optional 1 release/NVDA lane near candidate convergence.

Each developer keeps the same lane across repeated AUTOPULSE prompts. GitHub issue/PR state is the task queue and durable checkpoint. Coordinator assigns only unowned P0/P1 packages. Auditor tests exact owner heads and does not create competing Product code.

For a very large new phase, a wave may create/retire lanes, but the normal inner loop should not require an auditor to rewrite ten new prompts on Drive every round. That introduces latency and stale handoffs.

## 8. Acceptance gates for this package

- bulk paste accepts newline/space/numbered URL lists and deduplicates them;
- 50-Task cap remains enforced;
- options status traffic does not rebuild the whole navigation list per runtime event;
- unsaved Session name/prompt/Task edits survive options page background/reload when canonical version is unchanged;
- stale draft cannot overwrite a newer canonical Session revision;
- blank template downloads successfully;
- current configuration exports without runtime operation/log/private browser state;
- file import previews before apply;
- import is atomic/fail-closed;
- `replace-safe` refuses active/unresolved Sessions;
- `add` refuses duplicate Session identity and unsafe active/unresolved conversation ownership;
- autoStart uses the normal durable runtime, not a second executor;
- no public repository file contains user-private ChatGPT URLs/prompts;
- existing Core/Interaction/duplicate-send tests remain green;
- Windows/NVDA remains HUMAN_TESTED=false / NVDA_VERIFIED=false until real acceptance.
