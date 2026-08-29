# Interaction: benign “Too many requests” acknowledgement

The content-script message bridge may dismiss one explicitly whitelisted informational ChatGPT modal before an automation interaction request proceeds.

Accepted notice signatures:
- Ukrainian body containing `Забагато запитів`, `надсилаєте запити надто швидко`, and `Зачекайте кілька хвилин`, with exactly one visible acknowledgement control named `Зрозуміло`.
- English body containing `Too many requests`, `requests too quickly`, and `wait a few minutes`, with exactly one visible acknowledgement control named `Got it`.

Safety boundary:
- This only dismisses the informational modal. It does not alter server-side rate limiting or retry timing.
- Unknown confirmations, security/account/payment dialogs, and notices with non-whitelisted action labels remain untouched and continue through the existing fail-closed Interaction policy.
- The acknowledgement is attempted only when the extension receives an `autopilot-interaction` request, so ordinary manual browsing does not trigger background acknowledgement clicks.
