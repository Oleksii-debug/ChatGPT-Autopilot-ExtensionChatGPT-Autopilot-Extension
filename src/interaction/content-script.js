'use strict';

(function installInteractionListener(root) {
  const runtime = root.chrome?.runtime;
  const adapter = root.ChatGPTInteractionAdapter;
  if (!runtime?.onMessage || !adapter?.execute) return;

  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.channel !== 'autopilot-interaction') return false;

    Promise.resolve(adapter.execute(message.request || {}))
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch(() => sendResponse({
        ok: false,
        error: {
          code: 'INTERACTION_FAILED_SAFE',
          message: 'Chat interaction failed safely. No result was recorded as sent.',
        },
      }));
    return true;
  });
})(globalThis);
