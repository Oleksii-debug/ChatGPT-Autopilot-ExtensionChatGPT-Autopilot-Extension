'use strict';

(function installInteractionListener(root) {
  const runtime = root.chrome?.runtime;
  const adapter = root.ChatGPTInteractionAdapter;
  if (!runtime?.onMessage || !adapter?.execute) return;

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
      && includesAny(text, [
        'надсилаєте запити надто швидко',
        'надсилаєте запити занадто швидко',
        'запити надсилаються надто швидко',
        'запити надсилаються занадто швидко',
      ])
      && includesAny(text, ['тимчасово обмежили доступ', 'тимчасово обмежено доступ'])
      && includesAny(text, ['зачекайте кілька хвилин', 'спробуйте ще раз через кілька хвилин']);
    const english = text.includes('too many requests')
      && text.includes('requests too quickly')
      && text.includes('temporarily limited access to your conversations')
      && text.includes('wait a few minutes');
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
    const buttons = Array.from(dialog.querySelectorAll?.('button, [role="button"]') || [])
      .filter(isVisibleControl)
      .filter(isWhitelistedAcknowledgeButton);
    if (buttons.length !== 1) return false;

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

  function findComposerForm(doc) {
    const candidates = visibleComposerCandidates(doc)
      .map((element) => {
        const form = element.closest?.('form');
        if (!form) return null;
        let score = 0;
        if (element.id === 'prompt-textarea') score += 100;
        const testId = normalizeText(element.getAttribute?.('data-testid'));
        const name = normalizeText([
          element.getAttribute?.('aria-label'),
          element.getAttribute?.('placeholder'),
          testId,
          form.getAttribute?.('data-testid'),
          form.getAttribute?.('aria-label'),
        ].filter(Boolean).join(' '));
        if (/prompt|message|composer|chat|ask/.test(name)) score += 20;
        if (testId.includes('composer')) score += 10;
        return { form, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    if (!candidates.length) return null;
    if (candidates.length > 1 && candidates[0].score === candidates[1].score && candidates[0].form !== candidates[1].form) {
      return null;
    }
    return candidates[0].form;
  }

  function compatibleSendCandidate(doc) {
    const form = findComposerForm(doc);
    if (!form?.querySelectorAll) return null;
    const buttons = Array.from(form.querySelectorAll('button, [role="button"]')).filter(isVisibleControl);

    const strong = buttons.filter((button) => isStrongSendControl(button) && !isUnsafeControl(button));
    if (strong.length === 1) return strong[0];
    if (strong.length > 1) return null;

    // Last-resort structural compatibility: only a unique, visible, enabled submit button
    // inside the exact composer form. Never choose among multiple submit controls.
    const submit = buttons.filter((button) => {
      const type = normalizeText(button.getAttribute?.('type') || button.type);
      return type === 'submit' && !isUnsafeControl(button);
    });
    return submit.length === 1 ? submit[0] : null;
  }

  function temporarilyExposeSendIdentity(button) {
    if (!button?.setAttribute) return () => {};
    const originalTestId = button.getAttribute?.('data-testid');
    const alreadyRecognized = /(?:^|[-_])send-button(?:$|[-_])/.test(normalizeText(originalTestId));
    if (alreadyRecognized) return () => {};

    button.setAttribute('data-autopilot-send-compat', 'true');
    const compatibilityTestId = originalTestId
      ? `${originalTestId} autopilot-send-button`
      : 'autopilot-send-button';
    button.setAttribute('data-testid', compatibilityTestId);

    return () => {
      try {
        button.removeAttribute?.('data-autopilot-send-compat');
        if (originalTestId === null || originalTestId === undefined) button.removeAttribute?.('data-testid');
        else button.setAttribute('data-testid', originalTestId);
      } catch (_) {}
    };
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

  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.channel !== 'autopilot-interaction') return false;

    Promise.resolve()
      .then(async () => {
        const request = message.request || {};
        const dismissed = dismissWhitelistedRateLimitNotice(root.document);
        if (dismissed) {
          return {
            status: 'RATE_LIMITED',
            requestId: request.requestId || null,
            taskId: request.taskId || null,
            safeDiagnosticCode: 'RATE_LIMIT_DIALOG_ACKNOWLEDGED',
          };
        }

        const restoreSendIdentity = await prepareSendControlCompatibility(root.document, request.mode);
        try {
          return await adapter.execute(request);
        } finally {
          restoreSendIdentity();
        }
      })
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
