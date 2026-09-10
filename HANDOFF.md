# Native send 0.1.6 handoff — 2026-09-10

Progress thread: https://github.com/Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension/issues/119

This branch preserves the fix based on the user-supplied complete 0.1.5 archive, which is newer than the prior public main manifest. Do not rebase by blindly discarding uploaded improvements.

The user needs functional automatic sending and accessible controls, not timing advice. They requested short real-time intervals, multiple URLs/prompts, a chess profile delivered privately, and checkpoints approximately every two minutes during active work.

Implemented: native Chrome input via chrome.debugger; strict sender/tab/operation/URL validation; fresh hit test after debugger attachment; durable once-only submit checkpoint; retained message baselines; nested message deduplication; bounded uncertain recovery; accessible explicit recovery controls. See QA-0.1.6.txt.

Validation at first checkpoint: 351 automated tests pass. Real Chromium fixture reproduces failure in old adapter (untrusted click, zero messages) and success in revised production adapter/content script/transport/executor/native bridge. Extended six-scenario real-time matrix passed: all six SENT_VERIFIED, one trusted click and receipt per task; pauses 2–5 seconds, acknowledgements delayed up to 9 seconds. See native-browser-result.json and issue #119. Chrome APIs are bridged in that test; actual extension installation, Chrome debugger permission UI, live ChatGPT, and NVDA are still unvalidated. Never claim those gates passed. The fixture intentionally requires trusted events; the user's old diagnostics alone do not establish that as their actual live root cause.

Run npm test. For browser matrix install Playwright and a supported Chromium, then npm run test:native-browser; AUTOPILOT_CHROMIUM_EXECUTABLE optionally points at an existing binary. AUTOPILOT_BASELINE_ADAPTER optionally points at the original 0.1.5 adapter for the negative comparison. All page routes are intercepted/aborted; no messages reach ChatGPT. The test restarts the executor after insertion and asserts exactly one native send per task.

Private Chess-profile.json is deliberately absent from this public branch. The corresponding regression test uses a synthetic long prompt when the private profile is absent. Obtain the user's archive directly if exact private profile reproduction is needed.

Next gate: test the installed extension in an authorized real Chrome/ChatGPT session, including debugger permission grant and the same uncertain-state recovery. Preserve safety after uncertain submit; never retry blindly. Do not post private diagnostic reports, conversation URLs, or chess prompts to this public repository.
