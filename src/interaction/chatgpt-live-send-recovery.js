'use strict';

/**
 * Live ChatGPT compatibility guard.
 *
 * Two deliberately bounded responsibilities live here:
 * 1. Best-effort select the High reasoning level before an actual Send. This is
 *    never allowed to block delivery: at most two selection attempts are made.
 * 2. Recover a physically successful Send when ChatGPT Work/background tabs omit
 *    the just-submitted user message from the rendered DOM. The main adapter still
 *    owns insertion and the one-and-only Send attempt; this layer only upgrades an
 *    already-uncertain result when strong post-click evidence is simultaneously
 *    present (correct conversation + empty composer + active generation).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.ChatGPTLiveSendRecovery = api;
    if (root.ChatGPTInteractionAdapter) api.install(root, root.ChatGPTInteractionAdapter);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SUBMIT_MODES = new Set(['SUBMIT_EXISTING', 'INSERT_AND_SEND']);
  const HIGH_ALIASES = new Set([
    'high',
    'високий',
    'висока',
    'високе',
    'высокий',
    'высокая',
    'alto',
    'alta'
  ]);
  const EXTRA_HIGH_ALIASES = new Set([
    'extra high',
    'дуже високий',
    'дуже висока',
    'очень высокий',
    'очень высокая'
  ]);
  const CURRENT_LEVEL_ALIASES = new Set([
    'instant', 'medium', 'high', 'extra high',
    'миттєво', 'миттєвий', 'середній', 'високий', 'дуже високий',
    'мгновенно', 'средний', 'высокий', 'очень высокий'
  ]);

  function waitDefault(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function compact(value) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim().toLowerCase();
  }

  function visible(el) {
    if (!el || !el.isConnected || el.hidden || el.disabled) return false;
    if (el.getAttribute?.('aria-hidden') === 'true' || el.getAttribute?.('aria-disabled') === 'true') return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
    }
    return true;
  }

  function elementLabel(el) {
    return compact([
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('data-value'),
      el?.getAttribute?.('data-testid'),
      el?.getAttribute?.('title'),
      el?.getAttribute?.('value'),
      el?.innerText,
      el?.textContent
    ].filter(Boolean).join(' '));
  }

  function exactLevelFromLabel(label) {
    const text = compact(label);
    if (!text) return '';
    for (const alias of EXTRA_HIGH_ALIASES) {
      if (text === alias || text.endsWith(` ${alias}`) || text.startsWith(`${alias} `)) return 'EXTRA_HIGH';
    }
    for (const alias of HIGH_ALIASES) {
      if (text === alias || text.endsWith(` ${alias}`) || text.startsWith(`${alias} `)) return 'HIGH';
    }
    for (const alias of CURRENT_LEVEL_ALIASES) {
      if (text === alias || text.endsWith(` ${alias}`) || text.startsWith(`${alias} `)) return alias.toUpperCase();
    }
    return '';
  }

  function effortScope(doc, adapter) {
    const found = adapter?.findVisibleComposer?.(doc);
    const composer = found?.element;
    if (!composer || found?.ambiguous) return doc;
    return composer.closest?.('form') || composer.parentElement?.parentElement || composer.parentElement || doc;
  }

  function findCurrentEffortControl(doc, adapter) {
    const scope = effortScope(doc, adapter);
    const candidates = Array.from(scope.querySelectorAll?.('button, [role="button"], [aria-haspopup]') || [])
      .filter(visible)
      .map((el) => ({ el, label: elementLabel(el) }))
      .filter(({ label }) => Boolean(exactLevelFromLabel(label)));
    if (!candidates.length && scope !== doc) {
      return Array.from(doc.querySelectorAll('button, [role="button"], [aria-haspopup]'))
        .filter(visible)
        .map((el) => ({ el, label: elementLabel(el) }))
        .find(({ label }) => Boolean(exactLevelFromLabel(label)))?.el || null;
    }
    return candidates[0]?.el || null;
  }

  function currentEffortLevel(doc, adapter) {
    const control = findCurrentEffortControl(doc, adapter);
    const level = control ? exactLevelFromLabel(elementLabel(control)) : '';
    return { control, level };
  }

  function findHighOption(doc) {
    const selectors = [
      '[role="option"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="radio"]',
      'button'
    ];
    const candidates = Array.from(doc.querySelectorAll(selectors.join(',')))
      .filter(visible)
      .map((el) => ({ el, label: elementLabel(el) }));
    return candidates.find(({ label }) => exactLevelFromLabel(label) === 'HIGH')?.el || null;
  }

  async function closePicker(doc, control, wait) {
    try {
      doc.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      doc.dispatchEvent?.(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
    } catch (_) { /* synthetic keyboard events are best effort */ }
    await wait(40);
    // If an effort menu remained open, toggling the same control is safer than
    // leaving a modal surface behind for the main adapter to classify as blocking.
    const stillOpen = findHighOption(doc);
    if (stillOpen && control?.isConnected) {
      try { control.click(); } catch (_) { /* best effort */ }
      await wait(40);
    }
  }

  async function ensureHighEffort(doc, adapter, deps) {
    const wait = typeof deps?.wait === 'function' ? deps.wait : waitDefault;
    let clicks = 0;
    let last = currentEffortLevel(doc, adapter);
    if (last.level === 'HIGH' || last.level === 'EXTRA_HIGH') {
      return { outcome: 'ALREADY_HIGH', attempts: 0 };
    }

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      last = currentEffortLevel(doc, adapter);
      if (last.level === 'HIGH' || last.level === 'EXTRA_HIGH') {
        return { outcome: 'HIGH_SELECTED', attempts: attempt - 1 };
      }
      if (!last.control) {
        await wait(80);
        continue;
      }

      try {
        last.control.click();
        clicks += 1;
      } catch (_) {
        await wait(80);
        continue;
      }
      await wait(120);

      const high = findHighOption(doc);
      if (!high) {
        await closePicker(doc, last.control, wait);
        continue;
      }

      try {
        high.click();
        clicks += 1;
      } catch (_) {
        await closePicker(doc, last.control, wait);
        continue;
      }
      await wait(160);

      const verified = currentEffortLevel(doc, adapter);
      if (verified.level === 'HIGH' || verified.level === 'EXTRA_HIGH') {
        return { outcome: 'HIGH_SELECTED', attempts: attempt, clicks };
      }
      // Some ChatGPT variants close the menu after a successful choice before
      // updating the button label. A selected/checked High option is equivalent.
      const selectedHigh = Array.from(doc.querySelectorAll('[aria-checked="true"], [aria-selected="true"], [data-state="checked"]'))
        .filter(visible)
        .some((el) => exactLevelFromLabel(elementLabel(el)) === 'HIGH');
      if (selectedHigh) return { outcome: 'HIGH_SELECTED', attempts: attempt, clicks };
      await closePicker(doc, last.control, wait);
    }

    return { outcome: 'HIGH_UNAVAILABLE_CONTINUE_SEND', attempts: 2, clicks };
  }

  function parseUrl(value) {
    try { return new URL(value); } catch (_) { return null; }
  }

  function conversationId(value) {
    const url = parseUrl(value);
    return url?.pathname?.match(/\/c\/([^/]+)/u)?.[1] || '';
  }

  function isFreshLaunch(value) {
    const url = parseUrl(value);
    return Boolean(url) && (url.pathname === '/' || /^\/g\/[^/]+\/?$/u.test(url.pathname));
  }

  function sameHost(a, b) {
    const left = parseUrl(a);
    const right = parseUrl(b);
    return Boolean(left && right && left.hostname.toLowerCase() === right.hostname.toLowerCase());
  }

  function routeProvesExpectedConversation(observed, expected) {
    const observedId = conversationId(observed);
    if (!observedId || !sameHost(observed, expected)) return false;
    if (isFreshLaunch(expected)) return true;
    const expectedId = conversationId(expected);
    return Boolean(expectedId) && expectedId === observedId;
  }

  function composerIsEmpty(doc, adapter) {
    const found = adapter?.findVisibleComposer?.(doc);
    if (!found || found.ambiguous || !found.element) return false;
    const value = String(found.element.value ?? found.element.innerText ?? found.element.textContent ?? '');
    return compact(value) === '';
  }

  function countAssistantMessages(doc) {
    const nodes = Array.from(doc.querySelectorAll?.('[data-message-author-role="assistant"], [data-author="assistant"]') || []);
    return new Set(nodes).size;
  }

  function canUpgradeUncertainSubmit(doc, adapter, request, result) {
    if (!SUBMIT_MODES.has(request?.mode)) return false;
    if (result?.status !== 'SUBMISSION_UNCERTAIN') return false;
    if (!['SEND_CLICK_UNCERTAIN', 'POST_CLICK_PROMPT_STILL_PENDING'].includes(result?.safeDiagnosticCode)) return false;
    const observed = result.normalizedObservedUrl || (typeof location !== 'undefined' ? location.href : '');
    if (!routeProvesExpectedConversation(observed, request.expectedUrl)) return false;
    if (!composerIsEmpty(doc, adapter)) return false;
    const blocking = adapter?.detectBlockingState?.(doc);
    return blocking?.status === 'BUSY';
  }

  function upgradeResult(result, assistantBaselineCount) {
    return Object.assign({}, result, {
      status: 'SENT_VERIFIED',
      submissionEvidence: 'ROUTE_EMPTY_COMPOSER_ACTIVE_GENERATION',
      safeDiagnosticCode: 'SEND_VERIFIED_ACTIVE_GENERATION_FALLBACK',
      safeDiagnosticMessage: [result?.safeDiagnosticMessage, 'Recovered from hidden-Work DOM omission: correct route + empty composer + active generation.']
        .filter(Boolean).join(' | '),
      assistantBaselineCount
    });
  }

  function decorateEffort(result, effort) {
    if (!result || !effort) return result;
    return Object.assign({}, result, {
      effortSelection: effort.outcome,
      effortSelectionAttempts: effort.attempts
    });
  }

  function install(root, adapter) {
    if (!adapter || typeof adapter.execute !== 'function' || adapter.__liveSendRecoveryInstalled) return false;
    const originalExecute = adapter.execute.bind(adapter);
    Object.defineProperty(adapter, '__liveSendRecoveryInstalled', { value: true, enumerable: false });
    adapter.execute = async function patchedExecute(request, deps) {
      const doc = deps?.document || root?.document;
      const submitMode = SUBMIT_MODES.has(request?.mode);
      const assistantBaselineCount = submitMode && doc?.querySelectorAll ? countAssistantMessages(doc) : undefined;
      let effort = null;
      if (submitMode && doc?.querySelectorAll) {
        // Failure to select High is intentionally non-fatal. Two attempts max.
        try { effort = await ensureHighEffort(doc, adapter, deps || {}); }
        catch (_) { effort = { outcome: 'HIGH_SELECTION_ERROR_CONTINUE_SEND', attempts: 2 }; }
      }

      const result = await originalExecute(request, deps);
      if (doc?.querySelectorAll && canUpgradeUncertainSubmit(doc, adapter, request, result)) {
        return decorateEffort(upgradeResult(result, assistantBaselineCount ?? 0), effort);
      }
      return decorateEffort(result, effort);
    };
    return true;
  }

  return {
    install,
    ensureHighEffort,
    routeProvesExpectedConversation,
    canUpgradeUncertainSubmit,
    countAssistantMessages
  };
});