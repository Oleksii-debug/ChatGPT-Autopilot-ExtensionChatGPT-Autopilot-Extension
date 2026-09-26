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
    'ENSURE_HIGH_EFFORT',
    'INSERT_ONLY',
    'PREPARE_SEND',
    'SUBMIT_EXISTING',
    'INSERT_AND_SEND',
    'VERIFY_AFTER_UNCERTAIN_SUBMIT',
    'READ_ASSISTANT_REPORT'
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
  // Retain the pre-send baseline for late acknowledgement and worker restarts.
  // A page reload intentionally loses this evidence: history equality alone is unsafe.
  const textSubmissionEvidence = new Map();

  function evidenceUrlMatches(storedExpected, requestExpected) {
    const stored = normalizeUrl(storedExpected);
    const current = normalizeUrl(requestExpected);
    if (!stored || !current) return false;
    if (stored === current) return true;
    // After an uncertain first Send, Core may durably adopt the newly-created
    // exclusive /c/<id> URL as the recovery identity. Keep the operation-local
    // pre-send evidence bound across that one legitimate root -> conversation
    // transition; never broaden this to an unrelated conversation.
    return expectedPostSendLocation(current, stored);
  }

  function textEvidenceFor(request) {
    const evidence = textSubmissionEvidence.get(evidenceKey(request));
    return evidence?.promptText === request.promptText
      && evidenceUrlMatches(evidence.expectedUrl, request.expectedUrl) ? evidence : null;
  }

  function pendingPromptText(observed, expected) {
    if (promptTextMatches(observed, expected)) return { accepted: true, repeated: false, submittedText: String(observed ?? '') };
    if (repeatedExpectedPrompt(observed, expected)) return { accepted: true, repeated: true, submittedText: String(observed ?? '') };
    return { accepted: false, repeated: false, submittedText: String(observed ?? '') };
  }

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
      if (au.hostname !== bu.hostname) return false;
      if (au.pathname === bu.pathname) return true;

      // ChatGPT commonly canonicalizes an existing Custom GPT conversation
      // from /g/<gpt-slug>/c/<conversation-id> to /c/<conversation-id>.
      // The conversation id, not the presentation path, is the stable target.
      const observedConversationId = au.pathname.match(/\/c\/([^/]+)/)?.[1] || '';
      const expectedConversationId = bu.pathname.match(/\/c\/([^/]+)/)?.[1] || '';
      return Boolean(observedConversationId)
        && observedConversationId === expectedConversationId;
    } catch (_) {
      return false;
    }
  }


  // Sending the first message from a launch surface such as https://chatgpt.com/
  // legitimately changes the SPA URL to /c/<new-id>. This transition is allowed
  // only AFTER Send; SENT_VERIFIED still requires operation-local appended-message
  // evidence and never relies on the URL change itself.
  function expectedPostSendLocation(observed, expected) {
    if (sameExpectedChat(observed, expected)) return true;
    const a = normalizeUrl(observed);
    const b = normalizeUrl(expected);
    if (!a || !b) return false;
    try {
      const au = new URL(a);
      const bu = new URL(b);
      if (!CHATGPT_HOSTS.has(au.hostname) || !CHATGPT_HOSTS.has(bu.hostname) || au.hostname !== bu.hostname) return false;
      const observedConversationId = au.pathname.match(/\/c\/([^/]+)/)?.[1] || '';
      const expectedConversationId = bu.pathname.match(/\/c\/([^/]+)/)?.[1] || '';
      if (!observedConversationId || expectedConversationId) return false;
      if (bu.pathname === '/') return true;
      const expectedGpt = bu.pathname.match(/^\/g\/([^/]+)$/)?.[1] || '';
      if (!expectedGpt) return false;
      const observedGpt = au.pathname.match(/^\/g\/([^/]+)\/c\/[^/]+$/)?.[1] || '';
      return au.pathname === `/c/${observedConversationId}` || observedGpt === expectedGpt;
    } catch (_) {
      return false;
    }
  }

  function isFreshLaunchSurface(value) {
    const normalized = normalizeUrl(value);
    if (!normalized) return false;
    try {
      const url = new URL(normalized);
      return CHATGPT_HOSTS.has(url.hostname)
        && (url.pathname === '/' || /^\/g\/[^/]+$/u.test(url.pathname));
    } catch (_) { return false; }
  }

  function isExclusiveConversationLocation(value) {
    const normalized = normalizeUrl(value);
    if (!normalized) return false;
    try {
      const url = new URL(normalized);
      return CHATGPT_HOSTS.has(url.hostname) && /\/c\/[^/]+$/u.test(url.pathname);
    } catch (_) { return false; }
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

  function isSemanticallyUnavailable(el) {
    let node = el;
    while (node) {
      if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return true;
      const inertAttribute = node.getAttribute?.('inert');
      if (node.inert === true || (inertAttribute !== null && inertAttribute !== undefined)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled || el.matches?.(':disabled') || isSemanticallyUnavailable(el)) return false;
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

  const HIGH_EFFORT_LEVELS = new Set(['high', 'extra-high']);

  function normalizeEffortText(value) {
    let text = String(value || '').trim().toLowerCase();
    try { text = text.normalize('NFKC'); } catch (_) {}
    return text.replace(/[–—_]+/gu, '-').replace(/\s+/gu, ' ');
  }

  function classifyEffortLabel(value) {
    const text = normalizeEffortText(value);
    if (!text) return null;
    if (/\b(?:extra[ -]?high|xhigh|very high)\b/u.test(text)
        || /дуже висок|очень высок/u.test(text)) return 'extra-high';
    if (/\bhigh\b/u.test(text)
        || /(?:^|\s)(?:високий|высокий|vysoky|wysoki|hoch|eleve|alto)(?:\s|$)/u.test(text)) return 'high';
    if (/\bmedium\b/u.test(text)
        || /(?:^|\s)(?:середній|средний|stredny|stredni|sredni|mittel|moyen|medio)(?:\s|$)/u.test(text)) return 'medium';
    if (/\blow\b/u.test(text)
        || /(?:^|\s)(?:низький|низкий|nizky|niski|niedrig|faible|bajo)(?:\s|$)/u.test(text)) return 'low';
    if (/\binstant\b/u.test(text)
        || /миттєв|мгновенн/u.test(text)) return 'instant';
    return null;
  }

  function effortSemanticText(el) {
    return normalizeEffortText([
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('aria-valuetext'),
      el?.getAttribute?.('data-testid'),
      el?.getAttribute?.('name'),
      el?.title,
      textOf(el),
    ].filter(Boolean).join(' '));
  }

  function effortSemanticHint(text) {
    return /thinking|reasoning|effort|think level|thinking level|reasoning level|зусил|мислен|міркуван|размыш|усили/u.test(text);
  }

  function isInsideEffortChoiceSurface(el) {
    const parent = el?.closest?.('[role="menu"], [role="listbox"], [role="radiogroup"]');
    return Boolean(parent);
  }

  function findEffortControl(doc) {
    const candidates = Array.from(doc.querySelectorAll(
      'button, [role="button"], [role="combobox"], [role="slider"], input[type="range"]'
    ) || []).filter(isVisible).map((el) => {
      if (isInsideEffortChoiceSurface(el)) return null;
      const identity = effortSemanticText(el);
      const ariaValue = normalizeEffortText(el.getAttribute?.('aria-valuetext'));
      const level = classifyEffortLabel(ariaValue) || classifyEffortLabel(identity);
      const role = normalizeEffortText(el.getAttribute?.('role'));
      const popup = normalizeEffortText(el.getAttribute?.('aria-haspopup'));
      const testId = normalizeEffortText(el.getAttribute?.('data-testid'));
      const semantic = effortSemanticHint(identity);
      const hasPopup = popup === 'menu' || popup === 'listbox' || popup === 'dialog' || popup === 'true';
      const modelPicker = hasPopup && (/\bmodel\b|модель|модел|gpt[- ]?\d/u.test(identity)
        || /(model[-_](?:picker|selector|switcher)|model-switcher)/u.test(testId));
      let score = 0;
      if (semantic) score += 100;
      if (classifyEffortLabel(ariaValue)) score += 100;
      if (/(thinking|reasoning|effort)/u.test(testId)) score += 80;
      if (role === 'slider') score += 70;
      if (level && hasPopup) score += 60;
      if (level && semantic) score += 30;
      if (modelPicker) score += 45;
      if (!score) return null;
      return { element: el, level, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);

    if (!candidates.length) return { element: null, level: null, ambiguous: false };
    if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
      return { element: null, level: null, ambiguous: true };
    }
    return { ...candidates[0], ambiguous: false };
  }

  function effortOptionSelected(el) {
    const ariaChecked = normalizeEffortText(el?.getAttribute?.('aria-checked'));
    const ariaSelected = normalizeEffortText(el?.getAttribute?.('aria-selected'));
    const dataState = normalizeEffortText(el?.getAttribute?.('data-state'));
    const dataSelected = normalizeEffortText(el?.getAttribute?.('data-selected'));
    return ariaChecked === 'true'
      || ariaSelected === 'true'
      || dataSelected === 'true'
      || dataState === 'checked'
      || dataState === 'on'
      || dataState === 'selected';
  }

  function findSelectedEffortOption(doc) {
    const options = Array.from(doc.querySelectorAll(
      '[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"]'
    ) || []).filter(isVisible).filter(effortOptionSelected)
      .map((element) => ({ element, level: classifyEffortLabel(effortSemanticText(element)) }))
      .filter((entry) => entry.level);
    if (!options.length) return { element: null, level: null, ambiguous: false };
    if (options.length > 1) return { element: null, level: null, ambiguous: true };
    return { ...options[0], ambiguous: false };
  }

  function effortOptionScore(el) {
    const identity = effortSemanticText(el);
    if (classifyEffortLabel(identity) !== 'high') return 0;
    const role = normalizeEffortText(el.getAttribute?.('role'));
    const choiceRole = ['menuitemradio', 'option', 'radio', 'menuitem'].includes(role);
    const choiceSurface = el.closest?.('[role="menu"], [role="listbox"], [role="radiogroup"], [role="dialog"]');
    if (!choiceRole && !choiceSurface && !effortSemanticHint(identity)) return 0;
    let score = 10;
    if (choiceRole) score += 100;
    if (effortOptionSelected(el)) score += 20;
    if (choiceSurface) score += 30;
    return score;
  }

  function findHighEffortOption(doc) {
    const ranked = Array.from(doc.querySelectorAll(
      '[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"], button, [role="button"]'
    ) || []).filter(isVisible)
      .map((element) => ({ element, score: effortOptionScore(element) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) return { element: null, ambiguous: false };
    if (ranked.length > 1 && ranked[0].score === ranked[1].score) return { element: null, ambiguous: true };
    return { element: ranked[0].element, ambiguous: false };
  }

  function effortChoiceSurfaceOpen(doc) {
    return Array.from(doc.querySelectorAll(
      '[role="menu"], [role="listbox"], [role="radiogroup"], [role="dialog"]'
    ) || []).filter(isVisible).some(isEffortPickerSurface);
  }

  function closeEffortPickerIfOpen(doc, control) {
    if (!control || !effortChoiceSurfaceOpen(doc)) return;
    try { control.click?.(); } catch (_) {}
  }

  function isEffortPickerSurface(surface) {
    const text = effortSemanticText(surface);
    if (!text) return false;
    const levels = ['instant', 'low', 'medium', 'high', 'extra-high']
      .filter((level) => {
        if (level === 'extra-high') return /extra[ -]?high|xhigh|very high|дуже висок|очень высок/u.test(text);
        if (level === 'high') return /\bhigh\b|високий|высокий/u.test(text);
        if (level === 'medium') return /\bmedium\b|середній|средний/u.test(text);
        if (level === 'low') return /\blow\b|низький|низкий/u.test(text);
        return /\binstant\b|миттєв|мгновенн/u.test(text);
      });
    return levels.length >= 2 && (effortSemanticHint(text) || /instant|medium|high/u.test(text));
  }

  async function ensureHighEffort(doc, request, start, deps) {
    if (!sameExpectedChat(globalThis.location?.href || '', request.expectedUrl)) {
      return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'URL_MISMATCH_BEFORE_EFFORT' });
    }
    const blocking = detectBlockingState(doc);
    if (blocking) return resultBase(request, start, { status: blocking.status, safeDiagnosticCode: blocking.code + '_BEFORE_EFFORT' });

    const current = findEffortControl(doc);
    if (current.ambiguous) {
      return resultBase(request, start, { status: STATUS.UNKNOWN_UI, safeDiagnosticCode: 'EFFORT_CONTROL_AMBIGUOUS' });
    }
    if (HIGH_EFFORT_LEVELS.has(current.level)) {
      return resultBase(request, start, {
        status: STATUS.READY,
        effortLevel: current.level,
        safeDiagnosticCode: 'EFFORT_HIGH_CONFIRMED',
      });
    }

    let highOption = findHighEffortOption(doc);
    if (highOption.ambiguous) {
      return resultBase(request, start, { status: STATUS.UNKNOWN_UI, safeDiagnosticCode: 'EFFORT_HIGH_OPTION_AMBIGUOUS' });
    }

    if (!highOption.element) {
      if (!current.element) {
        return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'EFFORT_CONTROL_NOT_READY' });
      }
      try { current.element.focus?.(); current.element.click?.(); } catch (_) {
        return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'EFFORT_CONTROL_OPEN_FAILED' });
      }

      const deadline = nowMs() + 1500;
      do {
        await (deps?.wait || wait)(100);
        const alreadySelected = findSelectedEffortOption(doc);
        if (alreadySelected.ambiguous) {
          closeEffortPickerIfOpen(doc, current.element);
          return resultBase(request, start, { status: STATUS.UNKNOWN_UI, safeDiagnosticCode: 'EFFORT_SELECTED_OPTION_AMBIGUOUS' });
        }
        if (HIGH_EFFORT_LEVELS.has(alreadySelected.level)) {
          try { current.element.click?.(); } catch (_) {}
          return resultBase(request, start, {
            status: STATUS.READY,
            effortLevel: alreadySelected.level,
            safeDiagnosticCode: 'EFFORT_HIGH_CONFIRMED_IN_PICKER',
          });
        }
        highOption = findHighEffortOption(doc);
        if (highOption.ambiguous) {
          closeEffortPickerIfOpen(doc, current.element);
          return resultBase(request, start, { status: STATUS.UNKNOWN_UI, safeDiagnosticCode: 'EFFORT_HIGH_OPTION_AMBIGUOUS' });
        }
        if (highOption.element) break;
      } while (nowMs() < deadline);
    }

    if (!highOption.element) {
      const refreshed = findEffortControl(doc);
      if (!refreshed.ambiguous && HIGH_EFFORT_LEVELS.has(refreshed.level)) {
        return resultBase(request, start, {
          status: STATUS.READY,
          effortLevel: refreshed.level,
          safeDiagnosticCode: 'EFFORT_HIGH_CONFIRMED',
        });
      }
      closeEffortPickerIfOpen(doc, current.element);
      return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'EFFORT_HIGH_OPTION_NOT_READY' });
    }

    try { highOption.element.focus?.(); highOption.element.click?.(); } catch (_) {
      closeEffortPickerIfOpen(doc, current.element);
      return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'EFFORT_HIGH_SELECTION_CLICK_FAILED' });
    }

    const verifyDeadline = nowMs() + 1800;
    let reopenedForProof = false;
    do {
      await (deps?.wait || wait)(100);
      const verified = findEffortControl(doc);
      if (!verified.ambiguous && HIGH_EFFORT_LEVELS.has(verified.level)) {
        return resultBase(request, start, {
          status: STATUS.READY,
          effortLevel: verified.level,
          safeDiagnosticCode: 'EFFORT_HIGH_SELECTED_AND_VERIFIED',
        });
      }
      let selected = findHighEffortOption(doc);
      if (!selected.ambiguous && selected.element
          && effortOptionSelected(selected.element)) {
        return resultBase(request, start, {
          status: STATUS.READY,
          effortLevel: 'high',
          safeDiagnosticCode: 'EFFORT_HIGH_SELECTED_AND_VERIFIED',
        });
      }

      // Some ChatGPT layouts keep the top-level model picker labelled only with
      // the model name (for example GPT-5.6) and hide the selected effort once
      // the menu closes. Reopen that same semantic picker once and verify the
      // High option's checked/selected state; then close the picker again.
      if (!reopenedForProof && !verified.ambiguous && verified.element && !selected.element) {
        reopenedForProof = true;
        try { verified.element.click?.(); } catch (_) {}
        await (deps?.wait || wait)(100);
        selected = findHighEffortOption(doc);
        if (!selected.ambiguous && selected.element
            && effortOptionSelected(selected.element)) {
          try { verified.element.click?.(); } catch (_) {}
          return resultBase(request, start, {
            status: STATUS.READY,
            effortLevel: 'high',
            safeDiagnosticCode: 'EFFORT_HIGH_SELECTED_AND_VERIFIED',
          });
        }
        try { verified.element.click?.(); } catch (_) {}
      }
    } while (nowMs() < verifyDeadline);

    closeEffortPickerIfOpen(doc, current.element);
    return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'EFFORT_HIGH_SELECTION_NOT_PROVEN' });
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
    const dialogs = visibleModalSurfaces(doc).filter((dialog) => !isEffortPickerSurface(dialog));
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
      return /stop generating|stop response|stop streaming|stop generation|stop-button|зупинити (?:генерацію|відповідь|створення)|остановить (?:генерацию|ответ)/.test(label)
        || /^(?:stop|зупинити|остановить)$/.test(label);
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
    const exactSend = /^(?:send|send message|send prompt|надіслати|надіслати повідомлення|відправити|відправити повідомлення|отправить|отправить сообщение)$/u;
    if (exactSend.test(aria)) score += 50;
    if (exactSend.test(title)) score += 30;
    if (exactSend.test(text)) score += 20;
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

  // ChatGPT's contenteditable/ProseMirror composer may reflow the same inserted
  // prompt into paragraphs/BR nodes and may normalize NBSP/line endings. Durable
  // safety still requires exact non-whitespace content; only presentation-level
  // whitespace differences are ignored here. This prevents a real prompt swap
  // from being accepted while allowing semantically identical editor rendering.
  function normalizePromptText(value) {
    let text = String(value ?? '');
    try { text = text.normalize('NFC'); } catch (_) {}
    return text
      .replace(/\r\n?/g, '\n')
      .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu, ' ')
      .replace(/[\u200b-\u200d\u2060\ufeff]/gu, '')
      .replace(/\n{2,}/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .trim();
  }

  function compactPromptText(value) {
    return normalizePromptText(value).replace(/\s+/gu, ' ').trim();
  }

  function promptTextMatches(observed, expected) {
    const a = normalizePromptText(observed);
    const b = normalizePromptText(expected);
    return a === b;
  }

  function repeatedUnit(value, unit, separator = '') {
    if (!value || !unit || value === unit) return false;
    let offset = 0;
    let copies = 0;
    while (offset < value.length) {
      if (!value.startsWith(unit, offset)) return false;
      offset += unit.length;
      copies += 1;
      if (offset === value.length) return copies >= 2;
      if (separator) {
        if (!value.startsWith(separator, offset)) return false;
        offset += separator.length;
        if (offset === value.length) return false;
      }
    }
    return false;
  }

  function repeatedExpectedPrompt(observed, expected) {
    const a = normalizePromptText(observed);
    const b = normalizePromptText(expected);
    if (!a || !b || a === b) return false;
    if (repeatedUnit(a, b)) return true;

    // ProseMirror may place a whitespace boundary between copies even when the
    // same text was inserted more than once. Repetition is diagnostic only;
    // there is deliberately no copy-count ceiling and no prompt-length limit.
    const compactObserved = compactPromptText(observed);
    const compactExpected = compactPromptText(expected);
    return repeatedUnit(compactObserved, compactExpected, ' ');
  }

  function composerKind(el) {
    const tag = String(el?.tagName || 'unknown').toLowerCase();
    const editable = String(el?.getAttribute?.('contenteditable') || '').toLowerCase();
    const role = String(el?.getAttribute?.('role') || '').toLowerCase();
    return [tag, editable === 'true' ? 'contenteditable' : '', role].filter(Boolean).join('/');
  }

  function safeTextProofMessage(observed, expected, el) {
    return [
      `editor=${composerKind(el) || 'unknown'}`,
      `expectedLength=${String(expected ?? '').length}`,
      `observedLength=${String(observed ?? '').length}`,
      `expectedNormalizedLength=${normalizePromptText(expected).length}`,
      `observedNormalizedLength=${normalizePromptText(observed).length}`,
      `normalizedMatch=${promptTextMatches(observed, expected) ? 'yes' : 'no'}`
    ].join('; ');
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

  function replaceContentEditableText(el, value, doc) {
    const normalized = String(value ?? '').replace(/\r\n?/g, '\n');
    if (typeof el?.replaceChildren === 'function' && typeof doc?.createElement === 'function' && typeof doc?.createTextNode === 'function') {
      try {
        const fragment = typeof doc.createDocumentFragment === 'function' ? doc.createDocumentFragment() : null;
        const target = fragment || el;
        const lines = normalized.split('\n');
        for (const line of lines) {
          const paragraph = doc.createElement('p');
          if (line) paragraph.appendChild(doc.createTextNode(line));
          else paragraph.appendChild(doc.createElement('br'));
          target.appendChild(paragraph);
        }
        if (fragment) el.replaceChildren(fragment);
        return true;
      } catch (_) {}
    }
    try {
      el.textContent = normalized;
      return true;
    } catch (_) {
      return false;
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
      if (!replaceContentEditableText(el, value, doc)) return;
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
      || !evidenceUrlMatches(evidence.expectedUrl, request.expectedUrl)) {
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
      && compactPromptText(editorText(composer)) === '';
  }

  function semanticUserMessages(doc) {
    // Work renders a user turn as a keyed bubble without the legacy author
    // attributes. When these bubbles exist, article headings and assistant
    // quotations must not be mistaken for additional user messages: the
    // pre-send history and post-send history have to use the same units.
    const workBubbles = Array.from(doc.querySelectorAll('[data-user-message-bubble="true"]'));
    if (workBubbles.length) return workBubbles.filter(el => !workBubbles.some(other => other !== el && el.contains?.(other)));
    const candidates = [...new Set([
      ...doc.querySelectorAll('[data-message-author-role="user"], [data-author="user"], article'),
      ...doc.querySelectorAll('[data-testid="user-message"]'),
    ])]
      .filter((el) => {
        const role = String(el.getAttribute?.('data-message-author-role') || el.getAttribute?.('data-author') || '').toLowerCase();
        return role === 'user' || el.getAttribute?.('data-testid') === 'user-message'
          || /you said|user|ви сказали|вы сказали/.test(accessibleName(el));
      });
    // A turn article and its author-role child are ONE message, not two.
    return candidates.filter(el => !candidates.some(other => other !== el && el.contains?.(other)));
  }

  function userMessageText(el) {
    // Read the message body without the turn heading, copy/edit buttons or footer.
    if (el.getAttribute?.('data-user-message-bubble') === 'true') {
      const body = el.querySelector?.('.whitespace-pre-wrap, [data-message-content]');
      return textOf(body || el).trim();
    }
    const bodies = [...new Set([
      ...Array.from(el.querySelectorAll?.('.whitespace-pre-wrap, [data-message-content]') || []),
      ...Array.from(el.querySelectorAll?.('[data-user-message-bubble="true"]') || []),
    ])];
    const roots = bodies.filter(node => !bodies.some(other => other !== node && other.contains?.(node)));
    return (roots.length ? roots.map(textOf).join('\n') : textOf(el)).trim();
  }

  function latestUserMessages(doc) {
    return semanticUserMessages(doc).filter(isVisible);
  }

  function semanticAssistantMessages(doc) {
    const candidates = Array.from(doc.querySelectorAll('[data-message-author-role="assistant"], [data-author="assistant"], article, [data-turn-key] [data-chatgpt-search-unit-key]'))
      .filter((el) => {
        const role = String(el.getAttribute?.('data-message-author-role') || el.getAttribute?.('data-author') || '').toLowerCase();
        // Work exposes separate keyed units for the user and assistant within
        // one turn. The assistant unit has a role marker even when its heading
        // is localized; an arbitrary non-user search unit is not a reply.
        const workKey = String(el.getAttribute?.('data-chatgpt-search-unit-key') || '');
        const workUnit = el.hasAttribute?.('data-chatgpt-search-unit-key')
          && (el.querySelector?.('[data-conversation-role="assistant"]')
            || /:assistant$/.test(workKey))
          && el.querySelector?.('[data-markdown-text-style="assistant-message"]');
        return role === 'assistant' || /chatgpt said|chatgpt сказал|assistant|chatgpt сказав|chatgpt відповів|помічник/.test(accessibleName(el))
          || workUnit;
      });
    return candidates.filter(el => !candidates.some(other => other !== el && el.contains?.(other)));
  }

  function assistantMessageText(el) {
    const bodies = Array.from(el.querySelectorAll?.('.whitespace-pre-wrap, [data-message-content], [class*="markdown"], [data-markdown-text-style="assistant-message"]') || []);
    const roots = bodies.filter(node => !bodies.some(other => other !== node && other.contains?.(node)));
    return (roots.length ? roots.map(textOf).join('\n') : textOf(el)).trim();
  }

  function latestAssistantText(doc) {
    const messages = semanticAssistantMessages(doc);
    const latest = messages[messages.length - 1];
    return latest ? assistantMessageText(latest) : '';
  }

  function userMessageHistorySnapshot(doc) {
    return semanticUserMessages(doc).map(userMessageText);
  }

  // Some ChatGPT accounts render turns without historical author-role/test-id
  // attributes. Observe only an exact prompt inside the main conversation surface.
  // This is operation-local delta evidence, never historical equality proof.
  function unlabeledPromptCount(doc, promptText) {
    const main = doc.querySelector?.('main, [role="main"]');
    if (!main || !promptText || typeof main.querySelectorAll !== 'function') return 0;
    // Once this page exposes canonical user bubbles, the unlabeled fallback
    // must not count an assistant quote or a sidebar copy of the same prompt.
    if (main.querySelector?.('[data-user-message-bubble="true"]')) return 0;
    let count = 0;
    for (const node of main.querySelectorAll('p, div, span, pre, li, blockquote')) {
      if (!isVisible(node) || node.closest?.('form, [contenteditable="true"], nav, aside, [data-message-author-role="assistant"], [data-author="assistant"], [data-testid="assistant-message"]')) continue;
      if (!promptTextMatches(textOf(node), promptText)) continue;
      const nestedMatch = Array.from(node.children || []).some(child => promptTextMatches(textOf(child), promptText));
      if (!nestedMatch) count += 1;
    }
    return count;
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
      if (!promptTextMatches(after[i], before[i])) return false;
    }
    return promptTextMatches(after[after.length - 1], promptText);
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
    if (promptTextMatches(existing, request.promptText)) {
      if (attachmentNodes(found.element).length) {
        return resultBase(request, start, {
          status: STATUS.MANUAL_REVIEW_REQUIRED,
          composerState: 'VISIBLE_NONEMPTY',
          safeDiagnosticCode: 'UNEXPECTED_ATTACHMENT_WITH_EXISTING_PROMPT'
        });
      }
      // Do not reinsert a draft that already matches. On a background
      // contenteditable, native Select-All is not guaranteed to replace the
      // editor model and can append a second copy. Exact existing text is
      // already sufficient to proceed to the configured pre-send delay.
      return resultBase(request, start, {
        status: STATUS.INSERTED_NOT_SENT,
        composerState: 'VISIBLE_NONEMPTY',
        safeDiagnosticCode: 'PROMPT_ALREADY_INSERTED_MATCH',
        safeDiagnosticMessage: 'Existing matching draft accepted without reinsertion.'
      });
    }
    if (repeatedExpectedPrompt(existing, request.promptText)) {
      if (attachmentNodes(found.element).length) {
        return resultBase(request, start, {
          status: STATUS.MANUAL_REVIEW_REQUIRED,
          composerState: 'VISIBLE_NONEMPTY',
          safeDiagnosticCode: 'UNEXPECTED_ATTACHMENT_WITH_EXISTING_PROMPT'
        });
      }
      // Repeated copies of the configured prompt are acceptable in unattended
      // mode by product contract. Do not append yet another copy while trying
      // to prove insertion; proceed to the configured pre-send delay as-is.
      return resultBase(request, start, {
        status: STATUS.INSERTED_NOT_SENT,
        composerState: 'VISIBLE_NONEMPTY',
        safeDiagnosticCode: 'INSERTION_REPEATED_PROMPT_ACCEPTED',
        safeDiagnosticMessage: safeTextProofMessage(existing, request.promptText, found.element)
      });
    }
    if (compactPromptText(existing)) {
      // ChatGPT can restore an old draft into a brand-new root chat. In this
      // product the INSERT_ONLY phase owns the composer for the current task:
      // clear any stale/restored text, prove it is empty, then insert ours.
      setNativeValue(found.element, '');
      await (deps.wait || wait)(100);
      found = findVisibleComposer(doc);
      if (!found.element || found.ambiguous) {
        return resultBase(request, start, {
          status: STATUS.TEMPORARY_ERROR,
          composerState: 'UNKNOWN',
          safeDiagnosticCode: 'COMPOSER_NOT_READY_AFTER_CLEAR'
        });
      }
      if (compactPromptText(editorText(found.element))) {
        return resultBase(request, start, {
          status: STATUS.TEMPORARY_ERROR,
          composerState: 'VISIBLE_NONEMPTY',
          safeDiagnosticCode: 'COMPOSER_CLEAR_NOT_PROVEN'
        });
      }
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
    await writePrompt(found.element, request, deps);

    // React/ProseMirror can commit a long multi-paragraph insertion asynchronously.
    // Poll the same semantic proof for a bounded period instead of sampling once at 50 ms.
    const insertionDeadline = nowMs() + 2500;
    let lastFound = found;
    do {
      await (deps.wait || wait)(75);
      found = findVisibleComposer(doc);
      if (!found.element || found.ambiguous) {
        if (nowMs() >= insertionDeadline) {
          return resultBase(request, start, {
            status: STATUS.INSERTED_NOT_SENT,
            safeDiagnosticCode: 'COMPOSER_LOST_AFTER_INSERT'
          });
        }
        continue;
      }
      lastFound = found;

      const observedText = editorText(found.element);
      const afterAttachments = attachmentNodes(found.element);
      const pending = pendingPromptText(observedText, request.promptText);
      if (pending.accepted && afterAttachments.length === 0) {
        acceptedRepresentationEvidence.delete(evidenceKey(request));
        return resultBase(request, start, {
          status: STATUS.INSERTED_NOT_SENT,
          composerState: 'VISIBLE_NONEMPTY',
          safeDiagnosticCode: pending.repeated ? 'INSERTION_REPEATED_PROMPT_ACCEPTED' : 'INSERTION_TEXT_PROVEN',
          safeDiagnosticMessage: safeTextProofMessage(observedText, request.promptText, found.element)
        });
      }

      if (compactPromptText(observedText) === '' && afterAttachments.length === 1) {
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
    } while (nowMs() < insertionDeadline);

    const finalElement = lastFound?.element || found?.element;
    const finalText = finalElement ? editorText(finalElement) : '';
    return resultBase(request, start, {
      status: STATUS.INSERTED_NOT_SENT,
      composerState: compactPromptText(finalText) ? 'VISIBLE_NONEMPTY' : 'UNKNOWN',
      safeDiagnosticCode: 'INSERTION_NOT_PROVEN',
      safeDiagnosticMessage: safeTextProofMessage(finalText, request.promptText, finalElement)
    });
  }

  async function writePrompt(element, request, deps) {
    const doc = element.ownerDocument;
    // Background tabs are the normal unattended operating mode. CDP Ctrl+A
    // is not reliable there for ProseMirror/contenteditable and can append
    // instead of replace. Use the editor's DOM/input-event path in hidden tabs;
    // keep Chrome native input for visible tabs where it is useful.
    if (typeof deps.insert !== 'function' || doc?.visibilityState === 'hidden' || doc?.visibilityState === 'prerender') {
      setNativeValue(element, request.promptText);
      return;
    }
    element.focus();
    if (typeof element.select === 'function') element.select();
    else {
      const range = doc.createRange();
      range.selectNodeContents(element);
      const selection = doc.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    element.setAttribute('data-autopilot-native-target', request.requestId);
    try { await deps.insert(); }
    finally { element.removeAttribute('data-autopilot-native-target'); }
  }

  function prepareSend(doc, request, start) {
    const blocked = requireExpectedPage(doc, request, start, '_PRE_SEND');
    if (blocked) return blocked;

    const found = findVisibleComposer(doc);
    if (found.ambiguous) return resultBase(request, start, { status: STATUS.UNKNOWN_UI, safeDiagnosticCode: 'COMPOSER_AMBIGUOUS_PRE_SEND' });
    if (!found.element) return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'COMPOSER_NOT_READY_PRE_SEND' });

    const observedPendingText = editorText(found.element);
    const pendingText = pendingPromptText(observedPendingText, request.promptText);
    const exactTextPending = pendingText.accepted;
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
    // Duplicate delivery of the same operation may inspect, never click again.
    if (textEvidenceFor(request) || getAcceptedRepresentationEvidence(request)?.submitAttempted) {
      return verifyAfterUncertain(doc, request, start);
    }
    const ready = prepareSend(doc, request, start);
    if (ready.status !== STATUS.READY) return ready;

    const found = findVisibleComposer(doc);
    if (!found.element || found.ambiguous) {
      return resultBase(request, start, { status: STATUS.MANUAL_REVIEW_REQUIRED, safeDiagnosticCode: 'PROMPT_CHANGED_AT_SUBMIT_BOUNDARY' });
    }
    const observedPendingText = editorText(found.element);
    const pendingText = pendingPromptText(observedPendingText, request.promptText);
    const exactTextPending = pendingText.accepted && attachmentNodes(found.element).length === 0;
    const boundRepresentationPending = isBoundRepresentationPending(found.element, request);
    if (!exactTextPending && !boundRepresentationPending) {
      return resultBase(request, start, { status: STATUS.MANUAL_REVIEW_REQUIRED, safeDiagnosticCode: 'PROMPT_CHANGED_AT_SUBMIT_BOUNDARY' });
    }

    const send = findSendButton(doc, found.element);
    if (!send || send.disabled || send.getAttribute?.('aria-disabled') === 'true') {
      return resultBase(request, start, { status: STATUS.INSERTED_NOT_SENT, safeDiagnosticCode: 'SEND_CHANGED_AT_SUBMIT_BOUNDARY' });
    }

    const submittedText = exactTextPending ? observedPendingText : '';
    const beforeTextMessages = exactTextPending ? userMessageHistorySnapshot(doc) : null;
    const beforeUnlabeledMatches = exactTextPending ? unlabeledPromptCount(doc, submittedText) : 0;
    const assistantBaselineCount = semanticAssistantMessages(doc).length;
    if (exactTextPending) {
      if (textSubmissionEvidence.size >= 100) {
        textSubmissionEvidence.delete(textSubmissionEvidence.keys().next().value);
      }
      textSubmissionEvidence.set(evidenceKey(request), {
        promptText: request.promptText,
        submittedText,
        expectedUrl: normalizeUrl(request.expectedUrl),
        beforeMessages: beforeTextMessages,
        beforeUnlabeledMatches,
        assistantBaselineCount,
      });
    }
    const evidence = boundRepresentationPending ? getAcceptedRepresentationEvidence(request) : null;
    if (evidence) {
      evidence.submitAttempted = true;
      evidence.beforeMessages = userMessageRepresentationSnapshot(doc);
      evidence.assistantBaselineCount = assistantBaselineCount;
    }

    // Use the native submit path when this is a genuine submit button in its
    // composer form. This invokes validation and the form's submit handler once.
    // Non-submit controls still use their own click handler. Never do both.
    const form = found.element.closest?.('form');
    const isFormSubmitter = form && send.form === form
      && String(send.type || '').toLowerCase() === 'submit';
    const nativeSubmit = doc.defaultView?.HTMLFormElement?.prototype?.requestSubmit;
    let submitMethod = 'CLICK';
    let backgroundDocument = doc.visibilityState === 'hidden' || doc.visibilityState === 'prerender';
    if (backgroundDocument && !isFormSubmitter && typeof deps.activate === 'function') {
      const activated = await deps.activate();
      if (activated) {
        for (let attempt = 0; attempt < 10 && doc.visibilityState !== 'visible'; attempt += 1) {
          await (deps.wait || wait)(100);
        }
      }
      if (!activated || doc.visibilityState !== 'visible') {
        return resultBase(request, start, {
          status:STATUS.TEMPORARY_ERROR,
          submissionEvidence:'PROVEN_NO_EFFECT',
          safeDiagnosticCode:'SEND_TAB_NOT_VISIBLE_BEFORE_EFFECT',
        });
      }
      backgroundDocument = false;
    }
    if (backgroundDocument && isFormSubmitter && typeof nativeSubmit === 'function') {
      // CDP mouse events are unreliable in a hidden background tab. A genuine
      // form submitter can be invoked through the page's own form semantics
      // without activating the tab.
      submitMethod = 'BACKGROUND_FORM_REQUEST_SUBMIT';
      nativeSubmit.call(form, send);
    } else if (backgroundDocument) {
      submitMethod = 'BACKGROUND_DOM_CLICK';
      send.click();
    } else if (typeof deps.submit === 'function') {
      submitMethod = 'CHROME_NATIVE_CLICK';
      send.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = send.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = doc.elementFromPoint(x, y);
      if (hit !== send && !send.contains(hit)) {
        return resultBase(request, start, {
          status: STATUS.MANUAL_REVIEW_REQUIRED,
          safeDiagnosticCode: 'NATIVE_SEND_TARGET_OBSCURED'
        });
      }
      send.setAttribute('data-autopilot-native-target', request.requestId);
      try {
        await deps.submit({ x, y });
      } catch (error) {
        if (error?.safeDiagnosticCode === 'SEND_TAB_NOT_VISIBLE_BEFORE_EFFECT') {
          return resultBase(request, start, {
            status: STATUS.TEMPORARY_ERROR,
            submissionEvidence: 'PROVEN_NO_EFFECT',
            safeDiagnosticCode: 'SEND_TAB_NOT_VISIBLE_BEFORE_EFFECT',
          });
        }
        throw error;
      } finally {
        send.removeAttribute('data-autopilot-native-target');
        if (typeof deps.restore === 'function') await deps.restore();
      }
    } else if (isFormSubmitter && typeof nativeSubmit === 'function') {
      submitMethod = 'FORM_REQUEST_SUBMIT';
      nativeSubmit.call(form, send);
    } else {
      send.click();
    }
    const verifyDeadline = nowMs() + 15000;
    let activatedForAcknowledgement = false;
    while (nowMs() < verifyDeadline) {
      await (deps.wait || wait)(100);

      if (!expectedPostSendLocation(globalThis.location?.href || '', request.expectedUrl)) {
        return resultBase(request, start, {
          status: STATUS.SUBMISSION_UNCERTAIN,
          submissionEvidence: evidence ? 'OPERATION_BOUND_REPRESENTATION_UNCERTAIN' : 'UNCERTAIN',
          safeDiagnosticCode: 'URL_CHANGED_AFTER_SEND_CLICK'
        });
      }

      const afterTextMessages = exactTextPending ? userMessageHistorySnapshot(doc) : null;
      const textVerified = exactTextPending
        && hasStrictAppendedPrompt(beforeTextMessages, afterTextMessages, submittedText);
      const representationVerified = evidence
        && hasStrictAppendedRepresentation(evidence.beforeMessages, userMessageRepresentationSnapshot(doc), evidence.signature);

      const unlabeledVerified = exactTextPending && beforeUnlabeledMatches === 0
        && unlabeledPromptCount(doc, submittedText) === 1
        && !compactPromptText(editorText(findVisibleComposer(doc).element));
      // Some account variants defer the conversation DOM in a hidden tab even
      // after requestSubmit has created /c/<id> and cleared the composer. Wake
      // it once to observe the already attempted effect; never submit again.
      if (!textVerified && !unlabeledVerified && !representationVerified
        && submitMethod === 'BACKGROUND_FORM_REQUEST_SUBMIT'
        && !activatedForAcknowledgement
        && nowMs() >= verifyDeadline - 13000
        && typeof deps.activate === 'function') {
        activatedForAcknowledgement = true;
        if (await deps.activate({ observationOnly: true })) {
          for (let attempt = 0; attempt < 10 && doc.visibilityState !== 'visible'; attempt += 1) {
            await (deps.wait || wait)(100);
          }
        }
      }
      // URL transition, composer clearing and generation state do not identify
      // the submitted prompt. Completion requires operation-local exact evidence.
      if (!textVerified && !unlabeledVerified && !representationVerified) continue;

      const postFound = findVisibleComposer(doc);
      if (postFound.ambiguous) {
        return resultBase(request, start, {
          status: STATUS.SUBMISSION_UNCERTAIN,
          submissionEvidence: evidence ? 'OPERATION_BOUND_REPRESENTATION_UNCERTAIN' : 'UNCERTAIN',
          safeDiagnosticCode: 'COMPOSER_AMBIGUOUS_AFTER_SEND_CLICK'
        });
      }
      if (exactTextPending && postFound.element && promptTextMatches(editorText(postFound.element), submittedText)) {
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

      // A first Send from a fresh launch surface is physically special: ChatGPT
      // creates the conversation at the same boundary as the Send. Do not call
      // this SENT_VERIFIED merely because a matching user message appeared in the
      // DOM. Require the concrete exclusive conversation URL, an empty composer,
      // and independent evidence that generation/assistant progress started.
      if (isFreshLaunchSurface(request.expectedUrl)) {
        const observedUrl = globalThis.location?.href || '';
        const composerEmpty = !postFound.element || !compactPromptText(editorText(postFound.element));
        const postBlocking = detectBlockingState(doc);
        const generationStarted = postBlocking?.status === STATUS.BUSY
          || semanticAssistantMessages(doc).length > assistantBaselineCount;
        if (!isExclusiveConversationLocation(observedUrl) || !composerEmpty || (!generationStarted && !textVerified && !unlabeledVerified)) continue;
      }

      if (representationVerified) {
        acceptedRepresentationEvidence.delete(evidenceKey(request));
        return resultBase(request, start, {
          status: STATUS.SENT_VERIFIED,
          submissionEvidence: 'NEW_USER_MESSAGE_WITH_OPERATION_BOUND_REPRESENTATION',
          safeDiagnosticCode: 'SEND_VERIFIED_BOUND_REPRESENTATION',
          assistantBaselineCount
        });
      }

      return resultBase(request, start, {
        status: STATUS.SENT_VERIFIED,
        submissionEvidence: unlabeledVerified && !textVerified
          ? 'OPERATION_LOCAL_MAIN_PROMPT_APPEND'
          : 'NEW_USER_MESSAGE_MATCH',
        safeDiagnosticCode: unlabeledVerified && !textVerified
          ? 'SEND_VERIFIED_MAIN_PROMPT_APPEND'
          : 'SEND_VERIFIED_OPERATION_LOCAL_APPEND',
        assistantBaselineCount
      });
    }

    return resultBase(request, start, {
      status: STATUS.SUBMISSION_UNCERTAIN,
      submissionEvidence: evidence ? 'OPERATION_BOUND_REPRESENTATION_CLICK_UNCERTAIN' : 'UNCERTAIN',
      safeDiagnosticCode: 'SEND_CLICK_UNCERTAIN',
      safeDiagnosticMessage: submissionDiagnostic(doc, request, beforeTextMessages, submitMethod)
    });
  }

  function submissionDiagnostic(doc, request, before, method = 'RECOVERY') {
    const found = findVisibleComposer(doc);
    const composer = found.element;
    const blocking = detectBlockingState(doc);
    return [
      `method=${method}`,
      `composer=${found.ambiguous ? 'ambiguous' : !composer ? 'absent' : compactPromptText(editorText(composer)) ? 'nonempty' : 'empty'}`,
      `pendingMatch=${composer && promptTextMatches(editorText(composer), request.promptText) ? 'yes' : 'no'}`,
      `messagesBefore=${before?.length ?? 'unknown'}`,
      `messagesAfter=${userMessageHistorySnapshot(doc).length}`,
      `surface=${doc.documentElement?.getAttribute?.('data-codex-window-type') === 'browser' ? 'chatgpt-work' : 'chatgpt-web'}`,
      `mainExactMatches=${unlabeledPromptCount(doc, request.promptText)}`,
      `block=${blocking?.code || 'none'}`,
      `visibility=${doc.visibilityState || 'unknown'}`
    ].join('; ');
  }

  async function verifyAfterUncertain(doc, request, start) {
    if (!expectedPostSendLocation(globalThis.location?.href || '', request.expectedUrl)) {
      return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'URL_MISMATCH_RECOVERY' });
    }
    const blocking = detectBlockingState(doc);
    if (blocking && blocking.status !== STATUS.BUSY) {
      return resultBase(request, start, { status: blocking.status, safeDiagnosticCode: blocking.code + '_RECOVERY' });
    }

    const found = findVisibleComposer(doc);
    if (found.ambiguous) return resultBase(request, start, { status: STATUS.UNKNOWN_UI, safeDiagnosticCode: 'COMPOSER_AMBIGUOUS' });

    // Restart destroys the operation-local pre-send DOM baseline. Historical
    // content or generation in an arbitrary /c/<id> is not proof of this effect.
    // Keep recovery verification-only unless operation-local evidence survives.

    const textEvidence = textEvidenceFor(request);
    if (textEvidence) {
      const submittedText = textEvidence.submittedText || textEvidence.promptText;
      const pending = found.element && promptTextMatches(editorText(found.element), submittedText);
      const afterMessages = userMessageHistorySnapshot(doc);
      const appended = hasStrictAppendedPrompt(textEvidence.beforeMessages, afterMessages, submittedText);
      const unlabeledAppended = textEvidence.beforeUnlabeledMatches === 0
        && unlabeledPromptCount(doc, submittedText) === 1;
      const baselineCount = Number.isInteger(Number(textEvidence.assistantBaselineCount))
        ? Number(textEvidence.assistantBaselineCount)
        : 0;
      if ((appended || unlabeledAppended) && !pending) {
        return resultBase(request, start, {
          status: STATUS.SENT_VERIFIED,
          submissionEvidence: unlabeledAppended && !appended
            ? 'OPERATION_LOCAL_MAIN_PROMPT_APPEND'
            : 'NEW_USER_MESSAGE_MATCH',
          safeDiagnosticCode: unlabeledAppended && !appended
            ? 'RECOVERY_MAIN_PROMPT_VERIFIED'
            : 'RECOVERY_TEXT_OPERATION_VERIFIED',
          assistantBaselineCount: baselineCount
        });
      }
      // Unchanged draft text does not prove that a request was never dispatched.
      return resultBase(request, start, {
        status: STATUS.SUBMISSION_UNCERTAIN,
        submissionEvidence: pending ? 'PROMPT_STILL_PENDING' : 'UNCERTAIN',
        safeDiagnosticCode: pending ? 'RECOVERY_SEND_NOT_ACKNOWLEDGED' : 'RECOVERY_TEXT_ACK_PENDING',
        safeDiagnosticMessage: submissionDiagnostic(doc, request, textEvidence.beforeMessages)
      });
    }

    // Composer state is operation-local evidence and therefore outranks history.
    if (found.element && promptTextMatches(editorText(found.element), request.promptText)
      && attachmentNodes(found.element).length === 0) {
      return resultBase(request, start, {
        status: STATUS.SUBMISSION_UNCERTAIN,
        submissionEvidence: 'PROMPT_STILL_PENDING',
        safeDiagnosticCode: 'RECOVERY_BASELINE_MISSING',
        safeDiagnosticMessage: submissionDiagnostic(doc, request, null)
      });
    }

    const evidence = getAcceptedRepresentationEvidence(request);
    if (evidence) {
      if (found.element && isBoundRepresentationPending(found.element, request)) {
        return resultBase(request, start, {
          status: evidence.submitAttempted ? STATUS.SUBMISSION_UNCERTAIN : STATUS.INSERTED_NOT_SENT,
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
          safeDiagnosticCode: 'RECOVERY_BOUND_REPRESENTATION_VERIFIED',
          assistantBaselineCount: Number.isInteger(Number(evidence.assistantBaselineCount)) ? Number(evidence.assistantBaselineCount) : undefined
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
    const repeatedPromptSeen = recent.some((el) => promptTextMatches(userMessageText(el), request.promptText));
    return resultBase(request, start, {
      status: STATUS.SUBMISSION_UNCERTAIN,
      submissionEvidence: repeatedPromptSeen ? 'HISTORY_MATCH_NOT_OPERATION_BOUND' : 'UNCERTAIN',
      safeDiagnosticCode: repeatedPromptSeen ? 'RECOVERY_STALE_MATCH_UNPROVEN' : 'RECOVERY_UNCERTAIN',
      safeDiagnosticMessage: submissionDiagnostic(doc, request, null)
    });
  }

  function readAssistantReport(doc, request, start) {
    if (!expectedPostSendLocation(globalThis.location?.href || '', request.expectedUrl)) {
      return resultBase(request, start, { status: STATUS.TEMPORARY_ERROR, safeDiagnosticCode: 'REPORT_URL_MISMATCH' });
    }
    const blocking = detectBlockingState(doc);
    const assistantMessages = semanticAssistantMessages(doc);
    const text = latestAssistantText(doc);
    const baselineKnown = request.assistantBaselineKnown === true;
    const baselineCount = Math.max(0, Math.floor(Number(request.assistantBaselineCount || 0)));
    const hasNewAssistantTurn = baselineKnown && assistantMessages.length > baselineCount;
    if (blocking?.status === STATUS.BUSY) {
      return resultBase(request, start, {
        status: STATUS.BUSY,
        assistantText: hasNewAssistantTurn ? text : '',
        assistantComplete: false,
        safeDiagnosticCode: 'ASSISTANT_RESPONSE_STREAMING'
      });
    }
    if (blocking) {
      return resultBase(request, start, {
        status: blocking.status,
        assistantText: hasNewAssistantTurn ? text : '',
        assistantComplete: false,
        safeDiagnosticCode: `${blocking.code}_REPORT`
      });
    }
    if (!baselineKnown) {
      return resultBase(request, start, {
        status: STATUS.TEMPORARY_ERROR,
        assistantText: '',
        assistantComplete: false,
        safeDiagnosticCode: 'ASSISTANT_BASELINE_UNKNOWN'
      });
    }
    if (!hasNewAssistantTurn || !text) {
      return resultBase(request, start, {
        status: STATUS.TEMPORARY_ERROR,
        assistantText: '',
        assistantComplete: false,
        safeDiagnosticCode: hasNewAssistantTurn ? 'ASSISTANT_RESPONSE_NOT_READY' : 'ASSISTANT_NEW_RESPONSE_NOT_STARTED'
      });
    }
    return resultBase(request, start, {
      status: STATUS.READY,
      assistantText: text,
      assistantComplete: true,
      safeDiagnosticCode: 'ASSISTANT_RESPONSE_READY'
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

    if (request.mode === 'READ_ASSISTANT_REPORT') return readAssistantReport(doc, request, start);
    if (request.mode === 'CHECK_ONLY') return inspect(doc, request, start);
    if (request.mode === 'ENSURE_HIGH_EFFORT') return ensureHighEffort(doc, request, start, deps || {});
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
    normalizePromptText,
    promptTextMatches,
    findVisibleComposer,
    classifyEffortLabel,
    findEffortControl,
    detectBlockingState,
    execute
  };
});
