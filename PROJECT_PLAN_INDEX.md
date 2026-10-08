# ChatGPT Autopilot — Canonical Multi-Plan Index

## CRITICAL SOURCE-LINEAGE NOTE

The exact Drive source archive **ChatGPT-Autopilot-11.0.13-HIGH-PostSend-Background-FIXED.zip** has been located and inspected. It contains 308 entries, a full `src/` + `companion/` source tree, and manifest **11.0.13 High**. Audit SHA-256: `ddf0527d03ca5b68c3b50e96dd3413e2d26afb0b7737ae3f502a3f960ae3c329`.
The current GitHub `main` manifest still reports **0.9.19** and is stale. The missing source problem is resolved; the remaining bootstrap task is to import/synchronize this exact 11.0.13 source archive (or a proven newer direct successor) into canonical Git, then qualify it. Do not reconstruct 11.x from 0.9.19. See `AUTOPILOT_11_0_13_SOURCE_BASELINE.md`.

Canonical Drive folder:
https://drive.google.com/drive/folders/11g-e0-mv_vaKlTg7uYYKh8iTak6YfP_u

## File/folder naming invariant

Inside the project Drive root there is exactly one canonical subfolder named **`Проєктні плани`**.
The plan file names are deliberately identical across projects and contain **no thematic suffix**:

1. `1. Перший план`
2. `2. Другий план`
3. `3. Третій план`
4. `4. Четвертий план`
5. `5. П’ятий план`
6. `6. Шостий план`
7. `7. Сьомий план`
8. `8. Восьмий план`

The thematic scope lives **inside** each document and in this index. Workers MUST NOT rename the Drive files to include subsystem names.

## Plans

1. Drive file: `1. Перший план`
   Internal scope: Agent Core, durable робота, policy, memory та artifacts
https://docs.google.com/document/d/1EanwjZPzneKwTMvbomGfsFPWhzY-9b7azZcIgBdpj1g/edit

2. Drive file: `2. Другий план`
   Internal scope: Browser, Windows, files, GitHub, Google, MCP та execution providers
https://docs.google.com/document/d/1LWRjRhYYv1jQE3CXeDZg20Dn8WD3EJJbKtXNcsohsCo/edit

3. Drive file: `3. Третій план`
   Internal scope: Multi-Agent, subagents, Projects, Verifier, Recipes та productivity
https://docs.google.com/document/d/1FgqO_2mbIt3ljvn8GN0hX7G_KZCVkoMqcuTCU6YxViY/edit

4. Drive file: `4. Четвертий план`
   Internal scope: Models, providers, routing, failover, evals та AI Manager
https://docs.google.com/document/d/1fx4sR_jCfIoKlFHPed7chAr5zy2eJKwWRQq_mjuALh4/edit

5. Drive file: `5. П’ятий план`
   Internal scope: Cloud, remote, team, identity та cross-device control
https://docs.google.com/document/d/1uSdYSarW52E9H7RkekA_wQ_7EgYR-xgiVdn51w5unQQ/edit

6. Drive file: `6. Шостий план`
   Internal scope: UI, accessibility, security, reliability, observability та packaging
https://docs.google.com/document/d/1fr5Pm7ZbX7IxF-2CZ9nqWSE7vREMEGDCN2r0uHyr_Tk/edit

7. Drive file: `7. Сьомий план`
   Internal scope: Commercial, licensing, distribution, SDK, Control Service та metrics
https://docs.google.com/document/d/1hMDxTh8AtFgGR_6z_f9DwvdC3ybWtbaCSSou4UxjGpU/edit

8. Drive file: `8. Восьмий план`
   Internal scope: Whole-product convergence, physical acceptance та go-live
https://docs.google.com/document/d/1usWSVOrznz7nqWfIGq0zGgUhZeQ9KVEFh9Jxh1MykQM/edit

## Dependency model

Plans 1–4, 6 and 7 are independent engineering plans and may finish in any order after the 11.x source lineage is available to the worker.
Plan 5 remains the binding owner-deferred cloud/remote later wave from the existing roadmap; do not redirect active capacity there without owner resume or a proven dependency.
Plan 8 is final convergence. It ultimately requires terminal outputs from Plans 1–7. Plan 5 stays deferred in priority until explicit owner resume, but it remains mandatory final North-Star scope before terminal whole-product go-live.

Old Agent 0–99 and Models 0–54 sequential plans are SUPERSEDED FOR WORK SELECTION and retained only for audit/coverage.
Detailed mapping: LEGACY_AGENT_MODELS_TO_MULTIPLAN_COVERAGE.md.
