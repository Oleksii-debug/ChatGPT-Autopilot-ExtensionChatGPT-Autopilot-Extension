# Architecture hardening checkpoint — provider capability-bound agent I/O

Date: 2026-09-12
Baseline: ChatGPT-Autopilot-0.9.0-QA-GITHUB-REVISION-RACE-HARDENING-SOURCE

This additive hardening binds each versioned agent action/event semantic that depends on a provider behavior to the existing capability registry.

- SUBMIT_PROMPT -> VERIFIED_PROMPT_SUBMIT
- PROBE_COMPLETION -> ASSISTANT_COMPLETION_PROBE
- RECOVER_INTERACTION -> SAFE_RESTART_RECOVERY
- COMPLETION_OBSERVED -> ASSISTANT_COMPLETION_PROBE
- RATE_LIMIT_OBSERVED -> RATE_LIMIT_CLASSIFICATION
- RECOVERY_REQUIRED -> SAFE_RESTART_RECOVERY
- generic action lifecycle events remain capability-neutral

The action-handler registry now validates the provider capability before handler registration as well as before action execution. Unsupported action/event types remain fail-closed.

No scheduler, queue, retry loop, parallel agent engine, or replacement orchestration runtime was added. The existing Autopilot Core remains the sole scheduling/send/recovery authority.
