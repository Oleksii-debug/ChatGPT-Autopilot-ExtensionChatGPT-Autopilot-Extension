# ChatGPT Autopilot 11.0.13 High — Source Baseline Evidence

Audit date: 2026-10-08.

## Exact source archive

Drive file:
`ChatGPT-Autopilot-11.0.13-HIGH-PostSend-Background-FIXED.zip`

Drive ID:
`1HHd4rNxf7Hlt0RqRzoBUX3M0JGF3usW2`

Drive URL:
https://drive.google.com/file/d/1HHd4rNxf7Hlt0RqRzoBUX3M0JGF3usW2/view

Observed size:
`5,174,898 bytes`

SHA-256 computed from the downloaded archive during this audit:
`ddf0527d03ca5b68c3b50e96dd3413e2d26afb0b7737ae3f502a3f960ae3c329`

ZIP integrity check:
PASS (no corrupt member reported by the ZIP CRC scan).

Archive entries:
308.

Root:
`ChatGPT-Autopilot-11.0.13/`

## Manifest readback

The archive contains `ChatGPT-Autopilot-11.0.13/manifest.json` with:
- manifest_version: 3
- name: ChatGPT Автопілот — High
- version: 11.0.13
- version_name: 11.0.13 High

The archive contains real product source, including `src/`, `companion/`, configuration, UI, interaction and core files. It is not only an installer shell.

## QA readback

`QA-11.0.13.txt` inside the archive reports:
- Core/integration regression suites: 81/81 passed.
- Interaction regression suite: 20/20 passed.
- UI regression suite: 15/15 passed.
- Release qualification suite: 8/8 passed after release metadata was added.
- The broad repository `npm test` did **not** complete successfully because unrelated pre-existing AI/Agent module-export/runtime failures remained.
- No live ChatGPT account / physical Windows Chrome acceptance was performed by that QA record.

Therefore 11.0.13 High is the correct source baseline, **not** a terminal whole-product PASS.

## Binding consequence

Current GitHub `main` still exposes manifest 0.9.19 and is stale relative to this source archive.

Before normal product-code Section closure:
1. import/synchronize this exact 11.0.13 High source lineage (or a proven newer direct successor) into canonical Git version control;
2. preserve provenance to this archive/hash;
3. run the relevant current tests on the imported exact tree;
4. then let Plans 1–4,6–7 proceed in parallel against that canonical 11.x tree.

Do **not** rebuild 11.x capability from the stale 0.9.19 `main`.
Do **not** treat the old QA limits as current terminal acceptance.
