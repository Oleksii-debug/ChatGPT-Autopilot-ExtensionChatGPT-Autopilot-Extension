'use strict';

/**
 * ChatGPT interaction seam for the local Manifest V3 extension.
 * This module deliberately owns no scheduling, persistence, tab creation, or retry loops.
 * Core supplies one bounded request; this adapter inspects/mutates only the current page.
 *
 * Durable automatic execution MUST use the phased modes:
 * CHECK_ONLY -> INSERT_ONLY -> PREPARE_SEND -> (Core persists SUBMITTING) ->
 * SUBMIT_EXISTING -> VERIFY_AFTER_UNCERTAIN_SUBMIT when required.
 *
 * INSERT_AND_SEND remains only as a compatibility mode for non-durable/manual callers.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatGPTInteractionAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STATUS = Object.freeze({
    READY: 'READY',
    BUSY: 'BUSY',
    SENT_VERIFIED: 'SENT_VERIFIED',
    TEMPORARY_ERROR: 'TEMPORARY_ERROR',
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    UNKNOWN_UI: 'UNKNOWN_UI',
    RATE_LIMITED: 'RATE_LIMITED',
    MANUAL_REVIEW_REQUIRED: 'MANUAL_REVIEW_REQUIRED',
    INSERTED_NOT_SENT: 'INSERTED_NOT_SENT',
    SUBMISSION_UNCERTAIN: 'SUBMISSION_UNCERTAIN'
  });

  const MODES = new Set([
    'CHECK_ONLY',
    'INSERT_ONLY',
    'PREPARE_SEND',
    'SUBMIT_EXISTING',
    'INSERT_AND_SEND',
    'VERIFY_AFTER_UNCERTAIN_SUBMIT'
  ]);
  const PROMPT_REQUIRED_MODES = new Set([
    'INSERT_ONLY',
    'PREPARE_SEND',
    'SUBMIT_EXISTING',
    'INSERT_AND_SEND',
    'VERIFY_AFTER_UNCERTAIN_SUBMIT'
  ]);
  const CHATGPT_HOSTS = new Set(['chatgpt.com', 'www.chatgpt.com']);

  // Operation-local evidence only. Core remains the sole durable state owner. If this
  // content-script context is lost, long-prompt representation recovery fails closed.
  const acceptedRepresentationEvidence = new Map();

  function nowMs() { return Date.now(); }
  function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function normalizeUrl(value) {
    try {
      const url = new URL(value);
      url.hash = '';
      url.search = '';
      url.hostname = url.hostname.toLowerCase();
      url.pathname = url.pathname.replace(/\/+$/, '') || '/';
      return url.toString();
    } catch (_) {
      return null;
    }
  }

  function sameExpectedChat(observed, expected) {
    const a = normalizeUrl(observed);
    const b = normalizeUrl(expected);
    if (!a || !b) return false;
    try {
      const au = new URL(a);
      const bu = new URL(b);
      if (!CHATGPT_HOSTS.has(au.hostname) || !CHATGPT_HOSTS.has(bu.hostname)) return false;
      return au.hostname === bu.hostname && au.pathname === bu.pathname;
    } catch (_) {
      return false;
    }
  }

  function validateRequest(request) {
    if (!request || typeof request !== 'object') return 'REQUEST_NOT_OBJECT';
    if (!request.requestId || !request.taskId) return 'REQUEST_ID_OR_TASK_ID_MISSING';
    if (!MODES.has(request.mode)) return 'MODE_INVALID';
    if (!normalizeUrl(request.expectedUrl)) return 'EXPECTED_URL_INVALID';
    if (PROMPT_REQUIRED_MODES.has(request.mode) && typeof request.promptText !== 'string') return 'PROMPT_MISSING';
    if (request.mode === 'INSERT_AND_SEND') {
      const delay = Number(request.preSendDelayMs);
      if (!Number.isInteger(delay) || delay < 1000 || delay > 30000) return 'PRE_SEND_DELAY_INVALID';
    }
    return null;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.hidden || el.disabled || el.getAttribute?.('aria-hidden') === 'true') return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    if (typeof el.getBoundingClientRect === 'function') {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
    }
    return true;
  }

  function textOf(el) {
    return String(el?.innerText ?? el?.textContent ?? el?.value ?? '');
  }

  function accessibleName(el) {
    return [
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('placeholder'),
      el?.getAttribute?.('data-placeholder'),
      el?.getAttribute?.('data-testid'),
      el?.getAttribute?.('name'),
      el?.id,
      el?.title
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function findVisibleComposer(doc) {
    const candidates = Array.from(doc.querySelectorAll(
      'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]'
    )).filter(isVisible).filter((el) => {
      if (el.getAttribute?.('aria-disabled') === 'true') return false;
      const name = accessibleName(el);
      const form = el.closest?.('form');
      const formText = [
        form?.getAttribute?.('data-type'),
        form?.getAttribute?.('aria-label'),
        form?.getAttribute?.('data-testid'),
        form?.id
      ].filter(Boolean).join(' ').toLowerCase();
      return /prompt|message|chat|ask|composer/.test(name + ' ' + formText);
    });

    if (candidates.length === 1) return { element: candidates[0], ambiguous: false };
    if (candidates.length === 0) return { element: null, ambiguous: false };

    const ranked = candidates.map((el) => {
      let score = 0;
      const name = accessibleName(el);
      if (/prompt|message|ask/.test(name)) score += 4;
      if (el.closest?.('form')) score += 2;
      if (el.getAttribute?.('contenteditable') === 'true') score += 1;
      return { el, score };
    }).sort((a, b) => b.score - a.score);

    if (ranked[0].score > ranked[1].score) return { element: ranked[0].el, ambiguous: false };
    return { element: null, ambiguous: true };
  }

  function findVisibleButton(doc, predicate) {
    return Array.from(doc.querySelectorAll('button, [role="button"]'))
      .filter(isVisible)
      .find(predicate) || null;
  }

  function visibleStatusText(doc) {
    return Array.from(doc.querySelectorAll('[role="alert"], [role="status"], [aria-live="assertive"]'))
      .filter(isVisible)
      .map((el) => (accessibleName(el) + ' ' + textOf(el)).trim().toLowerCase())
      .filter(Boolean)
      .join('\n');
  }

  function visibleModalSurfaces(doc) {
    const candidates = [
      ...Array.from(doc.querySelectorAll('[role="dialog"], dialog')),
      ...Array.from(doc.querySelectorAll('[role="alertdialog"]')),
      ...Array.from(doc.querySelectorAll('[aria-modal="true"]'))
    ];
    return Array.from(new Set(candidates)).filter(isVisible);
  }

  function detectBlockingState(doc) {
    // Any visible semantic modal outranks page-underlay evidence. We do not auto-click
    // dialogs here: CAPTCHA/security/account/payment/confirmation and localized/unknown
    // modal surfaces all require manual review unless a future control is explicitly whitelisted.
    const dialogs = visibleModalSurfaces(doc);
    if (dialogs.length) {
      const dialogText = dialogs.map((dialog) => (accessibleName(dialog) + ' ' + textOf(dialog)).toLowerCase()).join('\n');
      if (/captcha|verify|verification|security|confirm|account|payment|billing|purchase|subscribe/.test(dialogText)) {
        return { status: STATUS.MANUAL_REVIEW_REQUIRED, code: 'UNKNOWN_OR_SECURITY_DIALOG' };
      }
      return { status: STATUS.MANUAL_REVIEW_REQUIRED, code: 'UNRECOGNIZED_DIALOG' };
    }

    const signIn = findVisibleButton(doc, (b) => /log[ -]?in|sign[ -]?in|login/.test(accessibleName(b) + ' ' + textOf(b).toLowerCase()));
    if (signIn && !findVisibleComposer(doc).element) return { status: STATUS.AUTH_REQUIRED, code: 'AUTH_SURFACE_VISIBLE' };

    // Error classification is based on dedicated accessibility status surfaces rather
    // than the entire page body. Conversation text can legitimately contain phrases
    // such as "try again later" and must never manufacture a retry/rate-limit state.
    const statusText = visibleStatusText(doc);
    if (/too many requests|rate limit|rate limited|try again later/.test(statusText)) {
      return { status: STATUS.RATE_LIMITED, code: 'RATE_LIMIT_SURFACE_VISIBLE' };
    }
    if (/something went wrong|network error|temporary error|error generating|failed to (?:load|generate)|please try again/.test(statusText)) {
      return { status: STATUS.TEMPORARY_ERROR, code: 'TEMPORARY_ERROR_SURFACE_VISIBLE' };
    }

    const stop = findVisibleButton(doc, (b) => {
      const label = (accessibleName(b) + ' ' + textOf(b)).trim().toLowerCase();
      return /stop generating|stop response|stop streaming|stop generation|stop-button/.test(label) || label === 'stop';
    });
    if (stop) return { status: STATUS.BUSY, code: 'STOP_CONTROL_VISIBLE' };

    return null;
  }

  function sendControlScore(button) {
    const testId = String(button?.getAttribute?.('data-testid') || '').trim().toLowerCase();
    const aria = String(button?.getAttribute?.('aria-label') || '').trim().toLowerCase();
    const title = String(button?.title || '').trim().toLowerCase();
    const text = textOf(button).trim().toLowerCase();
    let score = 0;

    if (/(^|[-_])send-button($|[-_])/.test(testId)) score += 100;
    if (/^(send|send message|send prompt)$/.test(aria)) score += 50;
    if (/^(send|send message|send prompt)$/.test(title)) score += 30;
    if (/^(send|send message|send prompt)$/.test(text)) score += 20;
    return score;
  }

  function findSendButton(doc, composer) {
    const form = composer?.closest?.('form') || doc;
    const ranked = Array.from(form.querySelectorAll?.('button, [role="button"]') || [])
      .filter(isVisible)
      .map((button) => ({ button, score: sendControlScore(button) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) return null;
    if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
    return ranked[0].button;
  }

  function editorText(el) {
    const tag = String(el?.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return String(el.value || '');
    return String(el?.innerText ?? el?.textContent ?? '');
  }

  function eventConstructor(doc, preferred) {
    const view = doc?.defaultView;
    if (preferred === 'input' && typeof view?.InputEvent === 'function') return view.InputEvent;
    if (preferred === 'input' && typeof globalThis.InputEvent === 'function') return globalThis.InputEvent;
    if (typeof view?.Event === 'function') return view.Event;
    if (typeof globalThis.Event === 'function') return globalThis.Event;
    return null;
  }

  function dispatchEditorEvent(el, type, init) {
    const doc = el?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const EventCtor = eventConstructor(doc, type === 'input' || type === 'beforeinput' ? 'input' : 'event');
    if (!EventCtor || typeof el?.dispatchEvent !== 'function') return true;
    try {
      return el.dispatchEvent(new EventCtor(type, init));
    } catch (_) {
      try {
        const BasicCtor = eventConstructor(doc, 'event');
        return BasicCtor ? el.dispatchEvent(new BasicCtor(type, { bubbles: true })) : true;
      } catch (_) {
        return true;
      }
    }
  }

  function setNativeValue(el, value) {
    const tag = String(el.tagName || '').toLowerCase();
    const doc = el?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const view = doc?.defaultView || globalThis;
    if (tag === 'textarea' || tag === 'input') {
      const NativeCtor = tag === 'textarea'
        ? (view?.HTMLTextAreaElement || globalThis.HTMLTextAreaElement)
        : (view?.HTMLInputElement || globalThis.HTMLInputElement);
      const descriptor = NativeCtor?.prototype
        ? Object.getOwnPropertyDescriptor(NativeCtor.prototype, 'value')
        : null;
      if (descriptor?.set) descriptor.set.call(el, value);
      else el.value = value;
      dispatchEditorEvent(el, 'input', { bubbles: true, composed: true, inputType: 'insertText', data: value });
      dispatchEditorEvent(el, 'change', { bubbles: true });
      return;
    }

    el.focus?.();
    const selection = view?.getSelection?.() || globalThis.getSelection?.();
    if (selection && typeof doc?.createRange === 'function') {
      try {
        const range = doc.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (_) {}
    }

    let inserted = false;
    try {
      if (typeof doc?.execCommand === 'function') {
        inserted = doc.execCommand('insertText', false, value) === true;
      }
    } catch (_) {}

    if (!inserted) {
      const allowed = dispatchEditorEvent(el, 'beforeinput', {
        bubbles: true,
        composed: true,
        cancelable: true,
        inputType: 'insertText',
        data: value
      });
      if (allowed === false) return;
      el.textContent = value;
      dispatchEditorEvent(el, 'input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: value
      });
    }
  }

  function fileLikeNodes(root) {
    if (!root?.querySelectorAll) return [];
    return Array.from(root.querySelectorAll(
      '[data-testid*="attachment"], [aria-label*="attachment" i], [class*="attachment" i]'
    )).filter(isVisible);
  }

  function attachmentNodes(composer) {
    const root = composer?.closest?.('form') || composer?.parentElement;
    return fileLikeNodes(root);
  }

  function normalizedRepresentationSignature(node) {
    const value = `${accessibleName(node)} ${textOf(node)}`.replace(/\s+/g, ' ').trim().toLowerCase();
    return value || null;
  }

  function evidenceKey(request) {
    return `${request.requestId}\u0000${request.taskId}`;
  }

  function getAcceptedRepresentationEvidence(request) {
    const key = evidenceKey(request);
    const evidence = acceptedRepresentationEvidence.get(key);
    if (!evidence) return null;
    if (evidence.promptText !== request.promptText
      || evidence.expectedUrl !== normalizeUrl(request.expectedUrl)) {
      acceptedRepresentationEvidence.delete(key);
      return null;
    }
    return evidence;
  }

  function bindAcceptedRepresentation(request, node) {
    const signature = normalizedRepresentationSignature(node);
    if (!signature) return null;
    const evidence = {
      requestId: request.requestId,
      taskId: request.taskId,
      promptText: request.promptText,
      expectedUrl: normalizeUrl(request.expectedUrl),
      node,
      signature,
      submitAttempted: false,
      beforeMessages: null
    };
    acceptedRepresentationEvidence.set(evidenceKey(request), evidence);
    return evidence;
  }

  function isBoundRepresentationPending(composer, request) {
    const evidence = getAcceptedRepresentationEvidence(request);
    if (!evidence) return false;
    const attachments = attachmentNodes(composer);
    return attachments.length === 1
      && attachments[0] === evidence.node
      && normalizedRepresentationSignature(attachments[0]) === evidence.signature
      && editorText(composer).trim() === '';
  }

  function semanticUserMessages(doc) {
    return Array.from(doc.querySelectorAll('[data-message-author-role="user"], [data-author="user"], article'))
      .filter((el) => {
        const role = String(el.getAttribute?.('data-message-author-role') || el.getAttribute?.('data-author') || '').toLowerCase();
        return role === 'user' || /you said|user/.test(accessibleName(el));
      });
  }

  function latestUserMessages(doc) {
    return semanticUserMessages(doc).filter(isVisible);
  }

  function userMessageHistorySnapshot(doc) {
    return semanticUserMessages(doc).map((el) => textOf(el).trim());
  }

  function userMessageRepresentationSnapshot(doc) {
    return semanticUserMessages(doc).map((el) => ({
      text: textOf(el).trim(),
      representations: fileLikeNodes(el)
        .map(normalizedRepresentationSignature)
        .filter(Boolean)
    }));
  }

  function hasStrictAppendedPrompt(before, after, promptText) {
    if (after.length !== before.length + 1) return false;
    for (let i = 0; i < before.length; i += 1) {
      if (after[i] !== before[i]) return false;
    }
    return after[after.length - 1] === String(promptText).trim();
  }

  function sameRepresentationMessage(a, b) {
    if (!a || !b || a.text !== b.text) return false;
    if (a.representations.length !== b.representations.length) return false;
    return a.representations.every((value, index) => value === b.representations[index]);
  }

  function hasStrictAppendedRepresentation(before, after, signature) {
    if (!Array.isArray(before) || after.length !== before.length + 1) return false;
    for (let i = 0; i < before.length; i += 1) {
      if (!sameRepresentationMessage(before[i], after[i])) return false;
    }
    const appended = after[after.length - 1];
    return appended.representations.length === 1 && appended.representations[0] === signature;
  }

  function resultBase(request, start, extra) {
    return Object.assign({
      requestId: request?.requestId ?? null,
      taskId: request?.taskId ?? null,
      normalizedObservedUrl: normalizeUrl(globalThis.location?.href || ''),
      elapsedMs: nowMs() - start
    }, extra || {});
  }

  function inspect(doc, request, start) {
    if (!sameExpectedChat(globalThis.location?.href || '', request.expectedUrl)) {
      return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'URL_MISMATCH' });
    }
    const blocking = detectBlockingState(doc);
    if (blocking) return resultBase(request, start, { status: blocking.status, safeDiagnosticCode: blocking.code });

    const found = findVisibleComposer(doc);
    if (found.ambiguous) return resultBase(request, start, { status: STATUS.UNKNOWN_UI, safeDiagnosticCode: 'COMPOSER_AMBIGUOUS' });
    if (!found.element) return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'COMPOSER_NOT_READY' });

    return resultBase(request, start, {
      status: STATUS.READY,
      composerState: editorText(found.element) ? 'VISIBLE_NONEMPTY' : 'VISIBLE_EMPTY',
      sendEvidence: findSendButton(doc, found.element) ? 'SEND_VISIBLE_ENABLED' : 'SEND_ABSENT',
      safeDiagnosticCode: 'READY'
    });
  }

  function requireExpectedPage(doc, request, start, suffix) {
    if (!sameExpectedChat(globalThis.location?.href || '', request.expectedUrl)) {
      return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'URL_MISMATCH' + (suffix || '') });
    }
    const blocking = detectBlockingState(doc);
    if (blocking) return resultBase(request, start, { status: blocking.status, safeDiagnosticCode: blocking.code + (suffix || '') });
    return null;
  }

  async function insertOnly(doc, request, start, deps) {
    const blocked = requireExpectedPage(doc, request, start, '_BEFORE_INSERT');
    if (blocked) return blocked;

    let found = findVisibleComposer(doc);
    if (found.ambiguous) return resultBase(request, start, { status: STATUS.UNKNOWN_UI, safeDiagnosticCode: 'COMPOSER_AMBIGUOUS' });
    if (!found.element) return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'COMPOSER_NOT_READY' });

    const existing = editorText(found.element);
    if (existing === request.promptText) {
      if (attachmentNodes(found.element).length) {
        return resultBase(request, start, {
          status: STATUS.MANUAL_REVIEW_REQUIRED,
          composerState: 'VISIBLE_NONEMPTY',
          safeDiagnosticCode: 'UNEXPECTED_ATTACHMENT_WITH_EXISTING_PROMPT'
        });
      }
      return resultBase(request, start, {
        status: STATUS.INSERTED_NOT_SENT,
        composerState: 'VISIBLE_NONEMPTY',
        safeDiagnosticCode: 'PROMPT_ALREADY_INSERTED_MATCH'
      });
    }
    if (existing) {
      return resultBase(request, start, {
        status: STATUS.MANUAL_REVIEW_REQUIRED,
        composerState: 'VISIBLE_NONEMPTY',
        safeDiagnosticCode: 'COMPOSER_CONTAINS_OTHER_CONTENT'
      });
    }

    const beforeAttachments = attachmentNodes(found.element);
    if (beforeAttachments.length) {
      return resultBase(request, start, {
        status: STATUS.MANUAL_REVIEW_REQUIRED,
        composerState: 'VISIBLE_EMPTY',
        safeDiagnosticCode: 'PREEXISTING_ATTACHMENT_BLOCKS_AUTOMATION'
      });
    }

    found.element.focus?.();
    setNativeValue(found.element, request.promptText);
    await (deps.wait || wait)(50);

    found = findVisibleComposer(doc);
    if (!found.element || found.ambiguous) {
      return resultBase(request, start, { status: STATUS.INSERTED_NOT_SENT, safeDiagnosticCode: 'COMPOSER_LOST_AFTER_INSERT' });
    }

    const afterAttachments = attachmentNodes(found.element);
    if (editorText(found.element) === request.promptText && afterAttachments.length === 0) {
      acceptedRepresentationEvidence.delete(evidenceKey(request));
      return resultBase(request, start, {
        status: STATUS.INSERTED_NOT_SENT,
        composerState: 'VISIBLE_NONEMPTY',
        safeDiagnosticCode: 'INSERTION_TEXT_PROVEN'
      });
    }

    if (editorText(found.element).trim() === '' && afterAttachments.length === 1) {
      const evidence = bindAcceptedRepresentation(request, afterAttachments[0]);
      if (evidence) {
        return resultBase(request, start, {
          status: STATUS.INSERTED_NOT_SENT,
          composerState: 'ACCEPTED_ATTACHMENT_LIKE',
          insertionEvidence: 'OPERATION_BOUND_ACCEPTED_REPRESENTATION',
          safeDiagnosticCode: 'INSERTION_ATTACHMENT_OPERATION_BOUND'
        });
      }
      return resultBase(request, start, {
        status: STATUS.MANUAL_REVIEW_REQUIRED,
        composerState: 'ACCEPTED_ATTACHMENT_LIKE',
        safeDiagnosticCode: 'ATTACHMENT_REPRESENTATION_HAS_NO_SEMANTIC_SIGNATURE'
      });
    }

    if (afterAttachments.length > 1) {
      return resultBase(request, start, {
        status: STATUS.MANUAL_REVIEW_REQUIRED,
        composerState: 'UNKNOWN',
        safeDiagnosticCode: 'ATTACHMENT_REPRESENTATION_AMBIGUOUS'
      });
    }

    return resultBase(request, start, {
      status: STATUS.INSERTED_NOT_SENT,
      composerState: 'UNKNOWN',
      safeDiagnosticCode: 'INSERTION_NOT_PROVEN'
    });
  }

  function prepareSend(doc, request, start) {
    const blocked = requireExpectedPage(doc, request, start, '_PRE_SEND');
    if (blocked) return blocked;

    const found = findVisibleComposer(doc);
    if (found.ambiguous) return resultBase(request, start, { status: STATUS.UNKNOWN_UI, safeDiagnosticCode: 'COMPOSER_AMBIGUOUS_PRE_SEND' });
    if (!found.element) return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'COMPOSER_NOT_READY_PRE_SEND' });

    const exactTextPending = editorText(found.element) === request.promptText;
    const boundRepresentationPending = isBoundRepresentationPending(found.element, request);
    if (exactTextPending && attachmentNodes(found.element).length) {
      return resultBase(request, start, {
        status: STATUS.MANUAL_REVIEW_REQUIRED,
        composerState: 'VISIBLE_NONEMPTY',
        safeDiagnosticCode: 'UNEXPECTED_ATTACHMENT_PRE_SEND'
      });
    }
    if (!exactTextPending && !boundRepresentationPending) {
      return resultBase(request, start, {
        status: STATUS.MANUAL_REVIEW_REQUIRED,
        composerState: editorText(found.element) ? 'VISIBLE_NONEMPTY' : 'VISIBLE_EMPTY',
        safeDiagnosticCode: attachmentNodes(found.element).length
          ? 'PENDING_REPRESENTATION_NOT_OPERATION_BOUND_PRE_SEND'
          : 'PENDING_PROMPT_MISMATCH_PRE_SEND'
      });
    }

    const send = findSendButton(doc, found.element);
    if (!send || send.disabled || send.getAttribute?.('aria-disabled') === 'true') {
      return resultBase(request, start, {
        status: STATUS.INSERTED_NOT_SENT,
        composerState: boundRepresentationPending ? 'ACCEPTED_ATTACHMENT_LIKE' : 'VISIBLE_NONEMPTY',
        sendEvidence: send ? 'SEND_VISIBLE_DISABLED' : 'SEND_ABSENT',
        safeDiagnosticCode: 'SEND_NOT_ENABLED_PRE_SEND'
      });
    }

    return resultBase(request, start, {
      status: STATUS.READY,
      composerState: boundRepresentationPending ? 'ACCEPTED_ATTACHMENT_LIKE' : 'VISIBLE_NONEMPTY',
      insertionEvidence: boundRepresentationPending ? 'OPERATION_BOUND_ACCEPTED_REPRESENTATION' : undefined,
      sendEvidence: 'SEND_VISIBLE_ENABLED',
      safeDiagnosticCode: boundRepresentationPending
        ? 'PENDING_ATTACHMENT_OPERATION_BOUND_READY'
        : 'PENDING_PROMPT_READY_TO_SUBMIT'
    });
  }

  async function submitExisting(doc, request, start, deps) {
    const ready = prepareSend(doc, request, start);
    if (ready.status !== STATUS.READY) return ready;

    const found = findVisibleComposer(doc);
    if (!found.element || found.ambiguous) {
      return resultBase(request, start, { status: STATUS.MANUAL_REVIEW_REQUIRED, safeDiagnosticCode: 'PROMPT_CHANGED_AT_SUBMIT_BOUNDARY' });
    }
    const exactTextPending = editorText(found.element) === request.promptText
      && attachmentNodes(found.element).length === 0;
    const boundRepresentationPending = isBoundRepresentationPending(found.element, request);
    if (!exactTextPending && !boundRepresentationPending) {
      return resultBase(request, start, { status: STATUS.MANUAL_REVIEW_REQUIRED, safeDiagnosticCode: 'PROMPT_CHANGED_AT_SUBMIT_BOUNDARY' });
    }

    const send = findSendButton(doc, found.element);
    if (!send || send.disabled || send.getAttribute?.('aria-disabled') === 'true') {
      return resultBase(request, start, { status: STATUS.INSERTED_NOT_SENT, safeDiagnosticCode: 'SEND_CHANGED_AT_SUBMIT_BOUNDARY' });
    }

    const beforeTextMessages = exactTextPending ? userMessageHistorySnapshot(doc) : null;
    const evidence = boundRepresentationPending ? getAcceptedRepresentationEvidence(request) : null;
    if (evidence) {
      evidence.submitAttempted = true;
      evidence.beforeMessages = userMessageRepresentationSnapshot(doc);
    }

    send.click();
    const verifyDeadline = nowMs() + 5000;
    while (nowMs() < verifyDeadline) {
      await (deps.wait || wait)(100);

      if (!sameExpectedChat(globalThis.location?.href || '', request.expectedUrl)) {
        return resultBase(request, start, {
          status: STATUS.SUBMISSION_UNCERTAIN,
          submissionEvidence: evidence ? 'OPERATION_BOUND_REPRESENTATION_UNCERTAIN' : 'UNCERTAIN',
          safeDiagnosticCode: 'URL_CHANGED_AFTER_SEND_CLICK'
        });
      }

      const textVerified = exactTextPending
        && hasStrictAppendedPrompt(beforeTextMessages, userMessageHistorySnapshot(doc), request.promptText);
      const representationVerified = evidence
        && hasStrictAppendedRepresentation(evidence.beforeMessages, userMessageRepresentationSnapshot(doc), evidence.signature);
      if (!textVerified && !representationVerified) continue;

      const postFound = findVisibleComposer(doc);
      if (postFound.ambiguous) {
        return resultBase(request, start, {
          status: STATUS.SUBMISSION_UNCERTAIN,
          submissionEvidence: evidence ? 'OPERATION_BOUND_REPRESENTATION_UNCERTAIN' : 'UNCERTAIN',
          safeDiagnosticCode: 'COMPOSER_AMBIGUOUS_AFTER_SEND_CLICK'
        });
      }
      if (exactTextPending && postFound.element && editorText(postFound.element).trim() === request.promptText.trim()) {
        return resultBase(request, start, {
          status: STATUS.SUBMISSION_UNCERTAIN,
          submissionEvidence: 'PROMPT_STILL_PENDING',
          safeDiagnosticCode: 'POST_CLICK_PROMPT_STILL_PENDING'
        });
      }
      if (evidence && postFound.element && isBoundRepresentationPending(postFound.element, request)) {
        return resultBase(request, start, {
          status: STATUS.SUBMISSION_UNCERTAIN,
          submissionEvidence: 'OPERATION_BOUND_REPRESENTATION_STILL_PENDING',
          safeDiagnosticCode: 'POST_CLICK_REPRESENTATION_STILL_PENDING'
        });
      }

      if (representationVerified) {
        acceptedRepresentationEvidence.delete(evidenceKey(request));
        return resultBase(request, start, {
          status: STATUS.SENT_VERIFIED,
          submissionEvidence: 'NEW_USER_MESSAGE_WITH_OPERATION_BOUND_REPRESENTATION',
          safeDiagnosticCode: 'SEND_VERIFIED_BOUND_REPRESENTATION'
        });
      }

      return resultBase(request, start, {
        status: STATUS.SENT_VERIFIED,
        submissionEvidence: 'NEW_USER_MESSAGE_MATCH',
        safeDiagnosticCode: 'SEND_VERIFIED_OPERATION_LOCAL_APPEND'
      });
    }

    return resultBase(request, start, {
      status: STATUS.SUBMISSION_UNCERTAIN,
      submissionEvidence: evidence ? 'OPERATION_BOUND_REPRESENTATION_CLICK_UNCERTAIN' : 'UNCERTAIN',
      safeDiagnosticCode: 'SEND_CLICK_UNCERTAIN'
    });
  }

  async function verifyAfterUncertain(doc, request, start) {
    const blocked = requireExpectedPage(doc, request, start, '_RECOVERY');
    if (blocked && blocked.status !== STATUS.BUSY) return blocked;

    const found = findVisibleComposer(doc);
    if (found.ambiguous) return resultBase(request, start, { status: STATUS.UNKNOWN_UI, safeDiagnosticCode: 'COMPOSER_AMBIGUOUS' });

    // Composer state is operation-local evidence and therefore outranks history.
    if (found.element && editorText(found.element).trim() === request.promptText.trim()
      && attachmentNodes(found.element).length === 0) {
      return resultBase(request, start, {
        status: STATUS.INSERTED_NOT_SENT,
        submissionEvidence: 'NONE',
        safeDiagnosticCode: 'RECOVERY_PROMPT_PENDING'
      });
    }

    const evidence = getAcceptedRepresentationEvidence(request);
    if (evidence) {
      if (found.element && isBoundRepresentationPending(found.element, request)) {
        return resultBase(request, start, {
          status: STATUS.INSERTED_NOT_SENT,
          composerState: 'ACCEPTED_ATTACHMENT_LIKE',
          insertionEvidence: 'OPERATION_BOUND_ACCEPTED_REPRESENTATION',
          submissionEvidence: 'NONE',
          safeDiagnosticCode: 'RECOVERY_BOUND_REPRESENTATION_PENDING'
        });
      }
      if (evidence.submitAttempted && Array.isArray(evidence.beforeMessages)
        && hasStrictAppendedRepresentation(
          evidence.beforeMessages,
          userMessageRepresentationSnapshot(doc),
          evidence.signature
        )) {
        acceptedRepresentationEvidence.delete(evidenceKey(request));
        return resultBase(request, start, {
          status: STATUS.SENT_VERIFIED,
          submissionEvidence: 'NEW_USER_MESSAGE_WITH_OPERATION_BOUND_REPRESENTATION',
          safeDiagnosticCode: 'RECOVERY_BOUND_REPRESENTATION_VERIFIED'
        });
      }
      return resultBase(request, start, {
        status: STATUS.SUBMISSION_UNCERTAIN,
        submissionEvidence: 'OPERATION_BOUND_REPRESENTATION_UNCERTAIN',
        safeDiagnosticCode: 'RECOVERY_BOUND_REPRESENTATION_UNCERTAIN'
      });
    }

    // Plain historical text equality is not operation identity. In recurring workflows
    // an older user message can be byte-for-byte identical to the current prompt.
    const recent = latestUserMessages(doc).slice(-5);
    const repeatedPromptSeen = recent.some((el) => textOf(el).trim() === request.promptText.trim());
    return resultBase(request, start, {
      status: STATUS.SUBMISSION_UNCERTAIN,
      submissionEvidence: repeatedPromptSeen ? 'HISTORY_MATCH_NOT_OPERATION_BOUND' : 'UNCERTAIN',
      safeDiagnosticCode: repeatedPromptSeen ? 'RECOVERY_STALE_MATCH_UNPROVEN' : 'RECOVERY_UNCERTAIN'
    });
  }

  async function insertAndSend(doc, request, start, deps) {
    const inserted = await insertOnly(doc, request, start, deps);
    if (inserted.status !== STATUS.INSERTED_NOT_SENT
      || !['VISIBLE_NONEMPTY', 'ACCEPTED_ATTACHMENT_LIKE'].includes(inserted.composerState)) return inserted;
    await (deps.wait || wait)(request.preSendDelayMs);
    return submitExisting(doc, request, start, deps);
  }

  async function execute(request, deps) {
    const start = nowMs();
    const validation = validateRequest(request);
    if (validation) return resultBase(request, start, { status: STATUS.MANUAL_REVIEW_REQUIRED, safeDiagnosticCode: validation });
    const doc = deps?.document || globalThis.document;
    if (!doc?.querySelectorAll) return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'DOCUMENT_UNAVAILABLE' });

    if (request.mode === 'CHECK_ONLY') return inspect(doc, request, start);
    if (request.mode === 'INSERT_ONLY') return insertOnly(doc, request, start, deps || {});
    if (request.mode === 'PREPARE_SEND') return prepareSend(doc, request, start);
    if (request.mode === 'SUBMIT_EXISTING') return submitExisting(doc, request, start, deps || {});
    if (request.mode === 'VERIFY_AFTER_UNCERTAIN_SUBMIT') return verifyAfterUncertain(doc, request, start);
    return insertAndSend(doc, request, start, deps || {});
  }

  return {
    STATUS,
    normalizeUrl,
    sameExpectedChat,
    validateRequest,
    findVisibleComposer,
    detectBlockingState,
    execute
  };
});
