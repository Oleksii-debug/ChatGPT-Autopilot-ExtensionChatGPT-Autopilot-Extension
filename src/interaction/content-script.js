'use strict';

(function installInteractionListener(root) {
  const runtime = root.chrome?.runtime;
  const adapter = root.ChatGPTInteractionAdapter;
  if (!runtime?.onMessage || !adapter?.execute) return;

  const listenerKey = '__CHATGPT_AUTOPILOT_INTERACTION_LISTENER__';
  const existing = root[listenerKey];
  if (existing?.runtime === runtime) {
    try {
      if (!runtime.onMessage.hasListener || runtime.onMessage.hasListener(existing.listener)) return;
    } catch (_) {
      // A stale extension runtime can throw after an unpacked extension reload.
      // Continue and install one listener through the current runtime object.
    }
  }

  const SEND_COMPAT_MODES = new Set(['PREPARE_SEND', 'SUBMIT_EXISTING', 'INSERT_AND_SEND']);
  const SEND_LABELS = new Set([
    'send',
    'send message',
    'send prompt',
    'надіслати',
    'надіслати повідомлення',
    'надіслати запит',
    'відправити',
    'відправити повідомлення',
    'відправити запит',
    'отправить',
    'отправить сообщение',
    'odoslať',
    'odoslať správu',
    'odeslat',
    'odeslat zprávu',
    'wyślij',
    'wyślij wiadomość',
    'senden',
    'nachricht senden',
    'envoyer',
    'envoyer le message',
    'enviar',
    'enviar mensaje',
    'invia',
    'invia messaggio',
  ]);
  const UNSAFE_CONTROL_RE = /(?:stop|cancel|voice|microphone|mic\b|record|attach|upload|add file|зупин|скас|голос|мікроф|прикріп|завантаж|останов|отмен|голос|микроф|прикреп|stopp|abbrechen|arrêter|annuler)/i;

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function safeInteractionExceptionCode(error) {
    const explicit = String(error?.safeDiagnosticCode || '');
    if (/^[A-Z][A-Z0-9_]{2,79}$/.test(explicit)) return explicit;
    const name = String(error?.name || '');
    if (name === 'TypeError') return 'CONTENT_SCRIPT_TYPE_ERROR';
    if (name === 'RangeError') return 'CONTENT_SCRIPT_RANGE_ERROR';
    return 'CONTENT_SCRIPT_EXCEPTION';
  }

  function includesAny(text, values) {
    return values.some((value) => text.includes(value));
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
    const ukrainian = includesAny(text, ['забагато запитів', 'занадто багато запитів'])
      && includesAny(text, ['зачекайте кілька хвилин', 'спробуйте ще раз через кілька хвилин'])
      && includesAny(text, ['тимчасово обмежили доступ', 'тимчасово обмежено доступ']);
    const english = text.includes('too many requests')
      && includesAny(text, ['wait a few minutes', 'try again in a few minutes'])
      && includesAny(text, ['temporarily limited access', 'temporarily limited']);
    return ukrainian || english;
  }

  function isWhitelistedAcknowledgeButton(button) {
    const label = normalizeText(
      button?.getAttribute?.('aria-label')
      || button?.innerText
      || button?.textContent
      || button?.value
    );
    return label === 'зрозуміло' || label === 'підтвердити' || label === 'got it';
  }

  function dismissWhitelistedRateLimitNotice(doc) {
    if (!doc?.querySelectorAll) return false;

    const dialogs = Array.from(doc.querySelectorAll(
      '[role="dialog"], dialog, [role="alertdialog"], [aria-modal="true"]'
    )).filter(isVisibleControl);
    const matches = dialogs.filter((dialog) => isWhitelistedRateLimitNotice(elementText(dialog)));
    if (dialogs.length !== 1 || matches.length !== 1) return false;

    const dialog = matches[0];
    let buttons = Array.from(dialog.querySelectorAll?.('button, [role="button"]') || [])
      .filter(isVisibleControl)
      .filter(isWhitelistedAcknowledgeButton);

    // Some ChatGPT builds render the acknowledgement control in a portal adjacent
    // to the dialog rather than as a DOM child. Accept it only when there is one
    // exact visible acknowledgement control on the page and one verified rate-limit dialog.
    if (buttons.length === 0) {
      buttons = Array.from(doc.querySelectorAll('button, [role="button"]') || [])
        .filter(isVisibleControl)
        .filter(isWhitelistedAcknowledgeButton);
    }
    if (buttons.length !== 1) return false;

    try { buttons[0].focus?.(); } catch (_) {}
    buttons[0].click();
    return true;
  }

  function semanticValues(element) {
    return [
      element?.getAttribute?.('aria-label'),
      element?.getAttribute?.('title'),
      element?.innerText,
      element?.textContent,
      element?.value,
    ].map(normalizeText).filter(Boolean);
  }

  function isStrongSendControl(button) {
    const testId = normalizeText(button?.getAttribute?.('data-testid'));
    if (/(?:^|[-_])send-button(?:$|[-_])/.test(testId)) return true;
    if (/^(?:composer[-_])?(?:send|submit)(?:[-_]button)?$/.test(testId)) return true;
    if (/^(?:send|submit)[-_](?:message|prompt)(?:[-_]button)?$/.test(testId)) return true;
    return semanticValues(button).some((value) => SEND_LABELS.has(value));
  }

  function isUnsafeControl(button) {
    const identity = normalizeText([
      button?.getAttribute?.('data-testid'),
      button?.getAttribute?.('aria-label'),
      button?.getAttribute?.('title'),
      button?.innerText,
      button?.textContent,
    ].filter(Boolean).join(' '));
    return UNSAFE_CONTROL_RE.test(identity);
  }

  function visibleComposerCandidates(doc) {
    if (!doc?.querySelectorAll) return [];
    return Array.from(doc.querySelectorAll(
      '#prompt-textarea, textarea, [contenteditable="true"], [role="textbox"]'
    )).filter(isVisibleControl).filter((element) => element.getAttribute?.('aria-disabled') !== 'true');
  }

  function findComposerScope(doc) {
    const candidates = visibleComposerCandidates(doc)
      .map((element) => {
        const form = element.closest?.('form') || null;
        let score = 0;
        if (element.id === 'prompt-textarea') score += 100;
        const testId = normalizeText(element.getAttribute?.('data-testid'));
        const name = normalizeText([
          element.getAttribute?.('aria-label'),
          element.getAttribute?.('placeholder'),
          testId,
          form?.getAttribute?.('data-testid'),
          form?.getAttribute?.('aria-label'),
        ].filter(Boolean).join(' '));
        if (/prompt|message|composer|chat|ask/.test(name)) score += 20;
        if (testId.includes('composer')) score += 10;
        return {
          element,
          scope: form || doc,
          allowStructuralFallback: Boolean(form),
          score,
        };
      })
      .sort((a, b) => b.score - a.score);

    if (!candidates.length) return null;
    if (candidates.length > 1 && candidates[0].score === candidates[1].score) return null;
    return candidates[0];
  }

  function compatibleSendCandidate(doc) {
    const selected = findComposerScope(doc);
    const scope = selected?.scope;
    if (!scope?.querySelectorAll) return null;
    const buttons = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(isVisibleControl);

    const strong = buttons.filter((button) => isStrongSendControl(button) && !isUnsafeControl(button));
    if (strong.length === 1) return strong[0];
    if (strong.length > 1) return null;

    // Structural fallback is intentionally restricted to a real composer <form>.
    // When the current ChatGPT layout has no form wrapper, only one exact semantic
    // Send identity may be bridged from the document; generic submit buttons remain untouched.
    if (!selected.allowStructuralFallback) return null;
    const submit = buttons.filter((button) => {
      const type = normalizeText(button.getAttribute?.('type') || button.type);
      return type === 'submit' && !isUnsafeControl(button);
    });
    return submit.length === 1 ? submit[0] : null;
  }

  const activeSendIdentities = new WeakMap();

  function temporarilyExposeSendIdentity(button) {
    if (!button?.setAttribute) return () => {};
    const active = activeSendIdentities.get(button);
    if (active) {
      active.count += 1;
      return active.release();
    }
    const originalTestId = button.getAttribute?.('data-testid');
    const alreadyRecognized = /(?:^|[-_])send-button(?:$|[-_])/.test(normalizeText(originalTestId));
    if (alreadyRecognized) return () => {};

    button.setAttribute('data-autopilot-send-compat', 'true');
    const compatibilityTestId = originalTestId
      ? `${originalTestId} autopilot-send-button`
      : 'autopilot-send-button';
    button.setAttribute('data-testid', compatibilityTestId);

    const lease = {
      count: 1,
      release() {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          if (--lease.count > 0) return;
          activeSendIdentities.delete(button);
          try {
            if (button.getAttribute?.('data-autopilot-send-compat') === 'true') {
              button.removeAttribute?.('data-autopilot-send-compat');
            }
            // A page rerender may change its own identity during the request.
            // Never restore an old attribute over the site's new control.
            if (button.getAttribute?.('data-testid') === compatibilityTestId) {
              if (originalTestId === null || originalTestId === undefined) button.removeAttribute?.('data-testid');
              else button.setAttribute('data-testid', originalTestId);
            }
          } catch (_) {}
        };
      },
    };
    activeSendIdentities.set(button, lease);
    return lease.release();
  }

  async function prepareSendControlCompatibility(doc, mode) {
    if (!SEND_COMPAT_MODES.has(mode) || !doc?.querySelectorAll) return () => {};

    const deadline = Date.now() + 2000;
    do {
      const candidate = compatibleSendCandidate(doc);
      if (candidate) return temporarilyExposeSendIdentity(candidate);
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (true);

    return () => {};
  }

  const listener = (message, _sender, sendResponse) => {
    if (message?.channel !== 'autopilot-interaction') return false;

    Promise.resolve()
      .then(async () => {
        const request = message.request || {};
        const dismissed = dismissWhitelistedRateLimitNotice(root.document);
        if (dismissed) {
          // The exact ChatGPT informational notice is an acknowledgement gate, not
          // automatically a failed task. Keep the current extension-owned tab and
          // continue the SAME interaction request as soon as the dialog disappears.
          // Only fall back to Core's configurable account-wide cooldown when the
          // notice stubbornly remains visible after acknowledgement.
          const deadline = Date.now() + 2000;
          let stillBlocked = false;
          do {
            const dialogs = Array.from(root.document?.querySelectorAll?.(
              '[role="dialog"], dialog, [role="alertdialog"], [aria-modal="true"]'
            ) || []).filter(isVisibleControl);
            stillBlocked = dialogs.some((dialog) => isWhitelistedRateLimitNotice(elementText(dialog)));
            if (!stillBlocked || Date.now() >= deadline) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          } while (true);

          if (stillBlocked) {
            return {
              status: 'RATE_LIMITED',
              requestId: request.requestId || null,
              taskId: request.taskId || null,
              safeDiagnosticCode: 'RATE_LIMIT_DIALOG_ACKNOWLEDGED_BUT_STILL_VISIBLE',
            };
          }
        }

        const restoreSendIdentity = await prepareSendControlCompatibility(root.document, request.mode);
        let previousSendTabId = 0;
        const restoreActivatedSendTab = async () => {
          const previous = previousSendTabId;
          if (!previous) return true;
          try {
            const response = await runtime.sendMessage({
              channel:'autopilot-send-tab-activation', action:'restore',
              requestId:request.requestId, taskId:request.taskId, previousTabId:previous,
            });
            if (response?.ok) {
              previousSendTabId = 0;
              return true;
            }
          } catch (_) { /* Cold-start/executor reconciliation retries durable restoration. */ }
          return false;
        };
        try {
          const nativeInput = async (kind, point = {}) => {
            const response = await runtime.sendMessage({
              channel: 'autopilot-native-input',
              kind,
              requestId: request.requestId,
              taskId: request.taskId,
              ...point,
            });
            if (!response?.ok) {
              const error = new Error('Chrome native input failed');
              error.safeDiagnosticCode = response?.error?.safeDiagnosticCode || 'NATIVE_INPUT_FAILED';
              throw error;
            }
          };
          return await adapter.execute(request, {
            insert: () => nativeInput('insert'),
            submit: point => nativeInput('submit', point),
            activate: async () => {
              const response = await runtime.sendMessage({
                channel:'autopilot-send-tab-activation', action:'activate',
                requestId:request.requestId, taskId:request.taskId,
              });
              if (!response?.ok) return false;
              previousSendTabId = Number(response.data?.previousTabId || 0);
              return true;
            },
            restore: restoreActivatedSendTab,
          });
        } finally {
          restoreSendIdentity();
          await restoreActivatedSendTab();
        }
      })
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((error) => sendResponse({
        ok: false,
        error: {
          code: 'INTERACTION_FAILED_SAFE',
          safeDiagnosticCode: safeInteractionExceptionCode(error),
          message: 'Chat interaction failed safely. No result was recorded as sent.',
        },
      }));
    return true;
  };

  runtime.onMessage.addListener(listener);
  root[listenerKey] = { runtime, listener };
})(globalThis);
