# ChatGPT Autopilot Extension

Local Chrome Manifest V3 extension for durable, keyboard-first multi-session ChatGPT workflow automation.

## Current status

`ACTIVE_DEVELOPMENT`

The current integration branch contains the versioned Session/Task state model, deterministic scheduler primitives, restart protection, accessible options UI, semantic ChatGPT interaction adapter, reliability tests, and live runtime wiring between the UI, service worker, and content script.

The automatic Core execution loop that advances from a due task through durable insert, pre-send, submit, and verification phases is not connected yet. Installing this branch is useful for development verification only; it must not be treated as a finished automatic sender.

`HUMAN_TESTED=false`

`NVDA_VERIFIED=false`

## Automated verification

Requirements: Node.js 20 or newer. No package installation is required.

Run all deterministic tests:

```powershell
node --test
```

The suite covers Core scheduling/storage/recovery, the UI contract, Interaction safety, content-script/runtime wiring, stale UI writes, active URL ownership, unresolved-operation preservation, and concurrent storage updates.

## Load the unpacked development build in Chrome

These keyboard steps are intended for Windows 11 with NVDA:

1. Extract or clone the repository to a permanent folder. Do not load it from a temporary ZIP preview.
2. In Chrome press `Ctrl+L`, type `chrome://extensions`, and press `Enter`.
3. Use `Tab` to reach `Developer mode`, then press `Space` if it is off.
4. Use `Tab` to reach `Load unpacked`, then press `Enter`.
5. In the folder picker, type or navigate to the repository root containing `manifest.json`, then activate `Select Folder`.
6. Return to `chrome://extensions` and confirm that Chrome reports no extension error.
7. Open the extension's `Details`, then activate `Extension options` to open the semantic dashboard.

The toolbar action also opens the options page when the extension is loaded successfully.

## Safety boundaries

- Only `https://chatgpt.com/*` is permitted.
- No server, Python backend, cloud runner, external AI planner, CAPTCHA bypass, account-warning bypass, or rate-limit bypass is included.
- Cookies, ChatGPT sessions, browser profiles, credentials, private prompts, and private chat URLs must never be committed.
- A BUSY, error, unknown UI, rate limit, or uncertain submission is never recorded as a verified send.
- An unresolved submission checkpoint is preserved for reconciliation and cannot silently authorize a new Start.

## Project coordination

- [GitHub Issue #1 — v0.1 coordination](https://github.com/Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension/issues/1)
- [Google Drive project folder](https://drive.google.com/drive/folders/1esUXPkgC7UjPBY5mmtSDL-E7gOUyo5CU)

GitHub source, exact SHAs, PRs, and test evidence are technical truth. Drive contains the product scope and human-readable handoffs.
