# ChatGPT Autopilot — Canonical Multi-Plan Index

## CRITICAL SOURCE-LINEAGE NOTE

Drive Agent/Models plans inspected 2026-10-08 explicitly identify **11.0.13 High** as the migration baseline.
The current GitHub `main` manifest still reports **0.9.19**.
Therefore this control file is authoritative for planning/coordination, but workers MUST NOT treat the 0.9.19 main tree as the latest product source or downgrade/reimplement 11.x capabilities. Before product-source mutation, resolve/synchronize the exact 11.0.13 High-or-newer source lineage into canonical version control.

Canonical Drive folder:
https://drive.google.com/drive/folders/11g-e0-mv_vaKlTg7uYYKh8iTak6YfP_u

## Plans

1. Перший план — Agent Core, durable робота, policy, memory та artifacts
https://docs.google.com/document/d/1EanwjZPzneKwTMvbomGfsFPWhzY-9b7azZcIgBdpj1g/edit

2. Другий план — Browser, Windows, files, GitHub, Google, MCP та execution providers
https://docs.google.com/document/d/1LWRjRhYYv1jQE3CXeDZg20Dn8WD3EJJbKtXNcsohsCo/edit

3. Третій план — Multi-Agent, subagents, Projects, Verifier, Recipes та productivity
https://docs.google.com/document/d/1FgqO_2mbIt3ljvn8GN0hX7G_KZCVkoMqcuTCU6YxViY/edit

4. Четвертий план — Models, providers, routing, failover, evals та AI Manager
https://docs.google.com/document/d/1fx4sR_jCfIoKlFHPed7chAr5zy2eJKwWRQq_mjuALh4/edit

5. П’ятий план — Cloud, remote, team, identity та cross-device control
https://docs.google.com/document/d/1uSdYSarW52E9H7RkekA_wQ_7EgYR-xgiVdn51w5unQQ/edit

6. Шостий план — UI, accessibility, security, reliability, observability та packaging
https://docs.google.com/document/d/1fr5Pm7ZbX7IxF-2CZ9nqWSE7vREMEGDCN2r0uHyr_Tk/edit

7. Сьомий план — Commercial, licensing, distribution, SDK, Control Service та metrics
https://docs.google.com/document/d/1hMDxTh8AtFgGR_6z_f9DwvdC3ybWtbaCSSou4UxjGpU/edit

8. Восьмий план — Whole-product convergence, physical acceptance та go-live
https://docs.google.com/document/d/1usWSVOrznz7nqWfIGq0zGgUhZeQ9KVEFh9Jxh1MykQM/edit

## Dependency model

Plans 1–4, 6 and 7 are independent engineering plans and may finish in any order after the 11.x source lineage is available to the worker.
Plan 5 remains the binding owner-deferred cloud/remote later wave from the existing roadmap; do not redirect active capacity there without owner resume or a proven dependency.
Plan 8 is final convergence. It ultimately requires terminal outputs from Plans 1–7. Plan 5 stays deferred in priority until explicit owner resume, but it remains mandatory final North-Star scope before terminal whole-product go-live.

Old Agent 0–99 and Models 0–54 sequential plans are SUPERSEDED FOR WORK SELECTION and retained only for audit/coverage.
Detailed mapping: LEGACY_AGENT_MODELS_TO_MULTIPLAN_COVERAGE.md.
