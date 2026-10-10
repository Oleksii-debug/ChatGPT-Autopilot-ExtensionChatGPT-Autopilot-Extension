# Incident 11.0.13 — Fresh Work send has no mounted user bubble

**Recorded:** 2026-10-03 02:21 UTC  
**Input:** four user-provided diagnostics from 11.0.12, captured 2026-10-03 around 01:55–01:56 UTC.  
**Baseline:** 11.0.12, with the 11.0.11 dispatch behavior restored.

## Evidence and failure

The reports showed attempted sends where the composer was empty, the tab had transitioned from the new-chat surface to an exclusive `/c/<id>` URL, and Work exposed generation-in-progress state, while the diagnostic snapshot had zero user bubbles. The submit path already contained a strict fresh-chat confirmation for exactly this sequence. However, the scenario-only `requireGenerationAcknowledgement` branch ran first and rejected any send without an appended user bubble. The fresh-chat proof below it could never execute for managed scenarios. A physical submit could therefore be mislabeled uncertain, omitted from the sent counter, and left without an answer anchor even while generation ran.

That ordering is a concrete code defect matching the supplied state; it does not explain every missing response in every profile. In the reports, several tabs were also repeatedly frozen, and replacements accumulated. Frozen observation delays response accounting, but evidence does not establish that each frozen poll corresponded to a missing answer.

## Fix

1. Evaluate the strict fresh-conversation generation proof before the generic managed-scenario bubble gate. It still requires an exact prompt pending before the single submit, a root/launch-to-exclusive-conversation transition, an empty composer, and an independent busy/assistant-generation signal.
2. Persist whether the verified send used this fresh-conversation proof. The scenario response probe may accept a new assistant response without a rendered user bubble only for that persisted proof with an assistant baseline of zero. Existing conversations and later scenario turns still need their operation-local user bubble/key or marker.
3. Clear this proof when a new prompt is inserted or when a send is uncertain. Recovery remains observation-only; no automatic second Send is introduced.
4. Remove duplicate global rendering of each pool's progress line. The same total was previously shown in both a summary and its clickable pool entry; it was one counter displayed twice, not duplicate sends.

## Interpretation of supplied counters

`Надіслано промптів` means Core accepted a verified local Send effect and advanced its scenario accounting. It does not establish the remote service received or stored that prompt. `Отримано відповідей` means the scenario manager accepted a completed answer associated with that turn; it is not merely text visible in a tab. A supplied historical value of 46 cannot be confirmed as 46 server receipts from these diagnostic files.

Four reports showed several pool slots and limited response completion, but event logs are bounded and can omit earlier events. Do not infer total sends solely by counting submit-response events in the retained window. Likewise `replacementsUsed` is cumulative replacement activity, not the simultaneous open-tab count.

## Verification

Core/integration: 81/81; interaction: 20/20; UI: 15/15. Focused tests cover managed fresh send with no bubble, existing-chat conservative rejection, response tracking with persisted fresh proof, clearing stale proof, and dashboard count rendering. Full repository `npm test` is not green in this checkout: unrelated AI/agent tests fail on missing exports/runtime behavior and the aggregate process stalled. No live ChatGPT request or Windows browser qualification was performed.

A small supervised field run should verify one fresh scenario prompt and its answer counter before increasing concurrency. This is qualification guidance, not proof of server receipt.
