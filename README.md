# ChatGPT Autopilot Extension

Local Chrome Manifest V3 extension for durable, keyboard-first multi-session ChatGPT workflow automation.

## Current status

`RELEASE_CANDIDATE / HUMAN_ACCEPTANCE_PENDING`

The current integration line contains the versioned Session/Task state model, deterministic scheduler, restart recovery, accessible options UI, semantic ChatGPT interaction adapter, durable phased executor, and service-worker startup/alarm wiring.

Automatic production execution is enabled in the canonical service worker after the integrated deterministic release gates passed on the enabled runtime line. A bounded programmatic smoke on this Windows host also completed in official Google Chrome for Testing against live ChatGPT: the candidate performed one verified physical Send with no duplicate, classified the live Stop control as BUSY without clicking it, survived extension/service-worker reload, and recovered a newly navigated worker tab. This is machine-collected browser evidence, not human or screen-reader acceptance. Real Windows 11 + Chrome + NVDA human acceptance is still required before `V01_READY=true` may be claimed.

`HUMAN_TESTED=false`

`NVDA_VERIFIED=false`

`V01_READY=false`

## Automated verification

Requirements: Node.js 20 or newer. No package installation is required.

Run all deterministic tests:

```powershell
node --test
```

The suite covers Core scheduling/storage/recovery, runtime startup/alarm behavior, the UI contract, Interaction safety, content-script/runtime wiring, stale UI writes, active URL ownership, unresolved-operation preservation, concurrent storage updates, and release-package validation.

## Build the canonical v0.1 candidate package

Run:

```powershell
npm run package:release
```

The command creates exactly these reusable outputs under `dist`:

- `ChatGPT-Autopilot-Extension-v0.1` — unpacked extension folder.
- `ChatGPT-Autopilot-Extension-v0.1.zip` — canonical ZIP with the same folder as its single root.

The release allowlist includes only `README.txt`, `manifest.json`, and `src/**`. Tests, GitHub metadata, package-manager files, browser profiles, cookies, credentials, storage dumps, and other development files are not copied into the extension package. Manifest-referenced resources are validated before packaging. ZIP entry order and timestamps are fixed so identical source produces an identical ZIP SHA-256.

Run the focused packaging gate with:

```powershell
npm run test:release
```

GitHub Actions also builds the same canonical ZIP as the `ChatGPT-Autopilot-Extension-v0.1` workflow artifact for release-candidate verification. Use the `SHA256:` line printed by `npm run package:release` to verify the canonical inner ZIP; GitHub also reports a separate digest for its downloadable artifact wrapper, and the two hashes are not expected to match.

## Load the unpacked candidate in Chrome on Windows 11 with NVDA

1. Extract `ChatGPT-Autopilot-Extension-v0.1.zip` to a permanent folder. Do not load it from the ZIP preview.
2. In Chrome press `Ctrl+L`, type `chrome://extensions`, and press `Enter`.
3. Use `Tab` to reach `Developer mode`. Press `Space` only if it is off.
4. Use `Tab` to reach `Load unpacked`, then press `Enter`.
5. In the folder picker, choose the extracted `ChatGPT-Autopilot-Extension-v0.1` folder containing `manifest.json`, then activate `Select Folder`.
6. Return to `chrome://extensions` and verify that Chrome reports `ChatGPT Автопілот` version `0.1.0` with no extension error.
7. Press `Ctrl+Shift+Y` to open the semantic dashboard directly. The toolbar action and `Details` → `Extension options` also open it.
8. The dashboard reports Chrome's actual assigned shortcut. If Chrome could not assign it because of a conflict, or if you want another combination, open `chrome://extensions/shortcuts`.

These steps are installation instructions, not an NVDA verification claim. `NVDA_VERIFIED` remains false until a real Windows 11 + Chrome + NVDA acceptance run is completed against an exact candidate SHA.

## Upgrade an unpacked candidate

1. Keep only one canonical folder named `ChatGPT-Autopilot-Extension-v0.1`.
2. Replace the old folder contents with a freshly extracted candidate; do not layer new files over an older `src` tree.
3. Open `chrome://extensions` and activate `Reload` for ChatGPT Autopilot Extension.
4. Verify version `0.1.0`, no extension error, and that `Extension options` opens.
5. If the candidate SHA changed, treat the previous ZIP as superseded rather than creating `final`, `fixed`, or `new` variants.

## Safety boundaries

- Only `https://chatgpt.com/*` is permitted.
- No server, Python backend, cloud runner, external AI planner, CAPTCHA bypass, account-warning bypass, or rate-limit bypass is included.
- The exact informational “Too many requests” acknowledgement returns `RATE_LIMITED`; Core waits for the Session's configured retry/backoff before any later check.
- Cookies, ChatGPT sessions, browser profiles, credentials, private prompts, and private chat URLs must never be committed or packaged.
- A BUSY, error, unknown UI, rate limit, or uncertain submission is never recorded as a verified send.
- An unresolved submission checkpoint is preserved for reconciliation and cannot silently authorize a new Start.
- A generated ZIP is only a candidate artifact. `V01_READY=true` requires integrated production gates plus human Chrome/Windows/NVDA acceptance.

## Project coordination

- [GitHub Issue #1 — v0.1 coordination](https://github.com/Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension/issues/1)
- [Google Drive project folder](https://drive.google.com/drive/folders/1esUXPkgC7UjPBY5mmtSDL-E7gOUyo5CU)

GitHub source, exact SHAs, PRs, and test evidence are technical truth. Drive contains the product scope and human-readable handoffs.
