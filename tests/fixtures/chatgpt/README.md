# ChatGPT interaction fixture matrix

These fixtures/tests belong only to the content-script interaction seam. They contain no real user chats, prompts, credentials, cookies, or account data.

P0 scenarios to preserve as the DOM harness expands:

- F01 ready empty composer -> `READY`.
- F02 visible Stop-generating control -> `BUSY`, zero insertion/send actions.
- F03 hidden decoy composer + one visible composer -> select visible composer only.
- F04 two equally plausible visible editors -> `UNKNOWN_UI`, zero clicks.
- F05 exact Unicode/multiline prompt -> acceptance must preserve exact configured text before Send.
- F06 raw value mutation without framework acceptance -> fail closed; do not Send.
- F09 chat becomes busy during pre-send delay -> abort Send.
- F10 accepted prompt but Send remains disabled -> `INSERTED_NOT_SENT`.
- F11 Send followed by matching new user message -> `SENT_VERIFIED`.
- F12 Send click with no strong post-submit evidence -> `SUBMISSION_UNCERTAIN`.
- F13 uncertain recovery finds matching recent user message -> `SENT_VERIFIED`, never resend.
- F14 uncertain recovery finds prompt still pending -> `INSERTED_NOT_SENT`.
- F15 sign-in/auth surface -> `AUTH_REQUIRED`.
- F16 too-many-requests/rate-limit surface -> `RATE_LIMITED`, no retry click.
- F17 unknown confirmation/security dialog -> `MANUAL_REVIEW_REQUIRED`.
- F20 tab URL changed to another conversation -> fail closed before composer action.
- F22 composer detached/replaced around action -> bounded re-resolution only; never stale click.
- F24 malformed request/delay out of 1..30 seconds -> fail closed before DOM mutation.

P1 scenarios:

- F07 large prompt transformed into a newly associated attachment-like pending representation.
- F08 large prompt truncated -> no Send.
- F18 known benign Retry visible while policy disabled -> report only, no click.
- F19 known benign Retry enabled -> at most one Core-authorized recovery action.
- F21 repeated invocation on same stable task/tab -> no duplicate insertion.
- F23 offline/navigation failure -> `TEMPORARY_ERROR`.

Implementation rule: semantic attributes/roles and visibility are primary evidence; coordinates, OCR, pixel matching, generic nth-child selectors, CAPTCHA/account/rate-limit bypasses, and unknown confirmation auto-acceptance are prohibited.
