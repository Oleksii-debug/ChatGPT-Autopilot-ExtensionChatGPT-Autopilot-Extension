'use strict';

(function installInteractionListener(root) {
  const runtime = root.chrome?.runtime;
  const adapter = root.ChatGPTInteractionAdapter;
  if (!runtime?.onMessage || !adapter?.execute) return;

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function elementText(element) {
    return normalizeText([
      element?.getAttribute?.('aria-label'),
      element?.innerText,
      element?.textContent,
      element?.value,
    ].filter(Boolean).join(' '));
  }

  function isVisibleControl(element) {
    if (!element || element.isConnected === false || element.hidden || element.disabled) return false;
    if (element.getAttribute?.('aria-hidden') === 'true' || element.getAttribute?.('aria-disabled') === 'true') return false;

    const style = typeof root.getComputedStyle === 'function' ? root.getComputedStyle(element) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;

    if (typeof element.getBoundingClientRect === 'function') {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
    }
    return true;
  }

  function isWhitelistedRateLimitNotice(text) {
    const ukrainian = text.includes('забагато запитів')
      && text.includes('надсилаєте запити надто швидко')
      && text.includes('зачекайте кілька хвилин');
    const english = text.includes('too many requests')
      && text.includes('requests too quickly')
      && text.includes('wait a few minutes');
    return ukrainian || english;
  }

  function isWhitelistedAcknowledgeButton(button) {
    const label = elementText(button);
    return label === 'зрозуміло' || label === 'got it';
  }

  function dismissWhitelistedRateLimitNotice(doc) {
    if (!doc?.querySelectorAll) return false;

    const dialogs = Array.from(doc.querySelectorAll(
      '[role="dialog"], dialog, [role="alertdialog"], [aria-modal="true"]'
    )).filter(isVisibleControl);
    const matches = dialogs.filter((dialog) => isWhitelistedRateLimitNotice(elementText(dialog)));
    if (matches.length !== 1) return false;

    const dialog = matches[0];
    const buttons = Array.from(dialog.querySelectorAll?.('button, [role="button"]') || [])
      .filter(isVisibleControl)
      .filter(isWhitelistedAcknowledgeButton);
    if (buttons.length !== 1) return false;

    buttons[0].click();
    return true;
  }

  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.channel !== 'autopilot-interaction') return false;

    Promise.resolve()
      .then(() => {
        const dismissed = dismissWhitelistedRateLimitNotice(root.document);
        if (!dismissed || typeof root.setTimeout !== 'function') return undefined;
        return new Promise((resolve) => root.setTimeout(resolve, 50));
      })
      .then(() => adapter.execute(message.request || {}))
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
