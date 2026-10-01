# 11.0.10 recheck — 2026-10-02T01:17:36+02:00

The user requested a critical recheck of 11.0.9 and reported that ChatGPT service errors have become less frequent. We do not infer that server errors explain the remaining extension failures. Source comparison with the pre-11 release a4436cf shows that strict appended-message proof already existed before 11; weakening it is not the proposed fix.

## Reproduced failures

Five new negative/positive regression cases all FAIL against the unchanged 11.0.9 production modules (1c3de1e), using a deterministic clock that advances by 15,001 ms per sweep of fifteen frozen tabs. The five failures cover starvation (only slot 10 ever read), focus stealing during SUBMITTING, asynchronous thaw, stale physical button after activation, and false submit evidence after a failed activation with zero physical effect. Output: validation/11.0.10/before-11.0.9.txt.

## Final implementation

A FIFO wake queue scoped by local repository and physical window admits all observed waiting tabs without bulk activation; stale candidates expire. A focus queue shares authority with native Send activation. The probe refuses to switch while that window has a SUBMITTING operation or a durable Send focus lease. It holds focus only for wake/read/restore, and does not lock ordinary passive reads. A race test starts a Send after an observation begins and verifies that the Send waits, then records/restores the original tab instead of the temporary observation tab. A bounded 1-second thaw wait preserves the owned conversation without reload/new tab.

Send rechecks its composer, prompt, button and message baseline after activation, before recording a physical attempt. Proven native pre-dispatch loss of visibility also clears only that no-effect attempt record. Actual uncertain Send still remains verification-only. Exact operation-bound append and APSTEP response correlation are unchanged.

## Alternatives and limits

No URL-only success fallback, replay of unknown Send, bulk reload/activation, hidden parallel-chat cap or account/session manipulation was added. The observation cooldown remains per physical window. Automated mocked Chrome/DOM tests do not prove actual server receipt, responsiveness of the user's PC, or delivery in four Windows Chrome profiles. No physical browser executable is installed in this workspace, so native browser qualification is unavailable. Existing reports cannot retrospectively prove that the historical counter 46 represented 46 server-accepted messages.

Final results and release hashes: QA-11.0.10.txt and releases/11.0.10/SHA256SUMS.txt. The installer and complete Git snapshot are archived separately; private user diagnostics are excluded.
