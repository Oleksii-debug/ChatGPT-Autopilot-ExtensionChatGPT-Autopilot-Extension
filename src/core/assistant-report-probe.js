import { createChatTab, sameChatConversationUrl, isChatAuthUrl } from './tabs.js';

// Chrome freezes background documents independently of their tab lifetime.
// Wake only one owned tab per window per interval, so large pools cannot spin
// through activation and make the browser unresponsive.
const lastFrozenWakeByWindow = new Map();
const FROZEN_WAKE_INTERVAL_MS = 15_000;

function temporaryReport(code, extra = {}) {
  return {
    status: 'TEMPORARY_ERROR',
    assistantComplete: false,
    assistantText: '',
    safeDiagnosticCode: code,
    ...extra,
  };
}

function tabConversationUrl(tab) {
  const pending = String(tab?.pendingUrl || '').trim();
  const current = String(tab?.url || '').trim();
  return pending || current;
}

function matchesConversation(tab, conversationUrl) {
  return sameChatConversationUrl(tabConversationUrl(tab), conversationUrl)
    || sameChatConversationUrl(String(tab?.url || '').trim(), conversationUrl);
}

async function startSafeReload(chromeApi, tab) {
  if (!chromeApi?.tabs?.reload || tab?.id == null) return false;
  try {
    await chromeApi.tabs.reload(tab.id);
    return true;
  } catch {
    return false;
  }
}

async function getTab(chromeApi, tabId) {
  if (tabId == null || !chromeApi?.tabs?.get) return null;
  try {
    return await chromeApi.tabs.get(tabId);
  } catch (error) {
    if (/no tab with id|invalid tab id|tab not found/iu.test(String(error?.message || error))) return null;
    // A slow/unavailable Chrome API does not prove physical absence.
    throw error;
  }
}

async function navigateSameConversation(chromeApi, tab, conversationUrl) {
  if (tab?.id == null) return null;
  if (matchesConversation(tab, conversationUrl)) {
    const reloaded = await startSafeReload(chromeApi, tab);
    return reloaded ? tab : null;
  }
  if (!chromeApi?.tabs?.update) return null;
  try {
    return await chromeApi.tabs.update(tab.id, {
      url: conversationUrl,
      active: false,
    });
  } catch {
    return null;
  }
}

async function reopenSameConversation(chromeApi, tab, conversationUrl, owned, preferredWindowId) {
  if (tab?.id != null && owned === true && chromeApi?.tabs?.remove) {
    try {
      await chromeApi.tabs.remove(tab.id);
    } catch {
      // Chrome may refuse removal while the tab still exists. Reuse the bound
      // owned tab instead of creating an untracked duplicate conversation tab.
      const stillPresent = await getTab(chromeApi, tab.id);
      return stillPresent
        ? navigateSameConversation(chromeApi, stillPresent, conversationUrl)
        : createChatTab(chromeApi, conversationUrl, preferredWindowId);
    }
    return createChatTab(chromeApi, conversationUrl, preferredWindowId);
  }
  if (tab?.id != null) return navigateSameConversation(chromeApi, tab, conversationUrl);
  return createChatTab(chromeApi, conversationUrl, preferredWindowId);
}

export async function probeAssistantConversation(chromeApi, transport, job) {
  const conversationUrl = String(job?.conversationUrl || '').trim();
  if (!conversationUrl) throw new Error('Assistant report probe requires conversationUrl');

  const persistentManagedTab = job?.persistentManagedTab === true;
  let tabId = null;
  let temporaryTab = false;
  let restoreActiveTabId = null;
  let wokeTabId = null;
  let wokeWindowId = null;

  try {
    let hinted = await getTab(chromeApi, job?.managedTabId);
    if (persistentManagedTab && job?.requireWindowBinding && !Number.isInteger(job.preferredWindowId)) {
      return temporaryReport('SCENARIO_WINDOW_BINDING_REQUIRED');
    }
    if (persistentManagedTab && hinted && Number.isInteger(job?.preferredWindowId) && hinted.windowId !== job.preferredWindowId) {
      return temporaryReport('SCENARIO_TAB_WINDOW_MISMATCH', { observedTabId: hinted.id });
    }
    if (persistentManagedTab && job?.managedTabOwned === true && hinted?.autoDiscardable === false && chromeApi.tabs?.update) {
      try { hinted = await chromeApi.tabs.update(hinted.id, { autoDiscardable: true }); } catch { /* preserve identity */ }
    }
    // A managed Scenario must inspect its bound tab, not the first matching
    // conversation in Chrome (which may be a manually opened user tab).
    const tabs = persistentManagedTab ? [] : await chromeApi.tabs.query({ url: 'https://chatgpt.com/*' });
    const correlateBoundDocument = persistentManagedTab && job?.managedTabOwned === true
      && Boolean(job?.responseCorrelationToken);
    let existing = persistentManagedTab
      ? (hinted && (matchesConversation(hinted, conversationUrl) || correlateBoundDocument) ? hinted
        : null)
      : (tabs || []).find(tab => tab?.id != null && matchesConversation(tab, conversationUrl));
    const recoveryAction = String(job?.recoveryAction || '').trim();
    if (persistentManagedTab && hinted?.id != null && isChatAuthUrl(hinted.url)) {
      return temporaryReport('AUTH_SURFACE_VISIBLE_REPORT', { status: 'AUTH_REQUIRED',
        normalizedObservedUrl: hinted.url || '', observedTabId: hinted.id });
    }

    if (persistentManagedTab && hinted?.id != null && !matchesConversation(hinted, conversationUrl)
        && ['SAME_URL_RELOAD', 'SAME_URL_REOPEN'].includes(recoveryAction)) {
      // A provisional /c/id may have been canonicalized by the server. Never
      // navigate a living sending document back to an unproven old identity.
      return temporaryReport('ASSISTANT_BOUND_CONVERSATION_UNPROVEN', {
        normalizedObservedUrl: hinted.url || '', observedTabId: hinted.id,
      });
    }

    if (recoveryAction === 'SAME_URL_RELOAD') {
      const recovered = persistentManagedTab && job?.managedTabOwned !== true
        ? await createChatTab(chromeApi, conversationUrl, job?.preferredWindowId)
        : await navigateSameConversation(chromeApi, existing || hinted, conversationUrl);
      return temporaryReport('CHATGPT_RECOVERY_SAME_URL_RELOAD_STARTED', {
        tabRecoveryPending: true,
        recoveryPending: true,
        recoveryAction: 'SAME_URL_RELOAD',
        recoveredManagedTabId: recovered?.id ?? null,
      });
    }

    if (recoveryAction === 'SAME_URL_REOPEN') {
      const reused = job?.createOwnedTab === true && existing?.id != null;
      const recovered = reused
        ? existing
        : job?.createOwnedTab === true || (persistentManagedTab && job?.managedTabOwned !== true)
        ? await createChatTab(chromeApi, conversationUrl, job?.preferredWindowId)
        : await reopenSameConversation(
          chromeApi,
          existing || hinted,
          conversationUrl,
          job?.managedTabOwned === true,
          job?.preferredWindowId,
        );
      return temporaryReport('CHATGPT_RECOVERY_SAME_URL_REOPEN_STARTED', {
        tabRecoveryPending: true,
        recoveryPending: true,
        recoveryAction: 'SAME_URL_REOPEN',
        recoveredManagedTabId: recovered?.id ?? null,
        recoveredManagedTabOwned: reused ? job?.managedTabOwned === true : true,
      });
    }

    if (!existing && persistentManagedTab && hinted?.id != null) {
      if (isChatAuthUrl(hinted.url)) return temporaryReport('AUTH_SURFACE_VISIBLE_REPORT', { status: 'AUTH_REQUIRED' });
      if (hinted.status === 'loading') {
        return temporaryReport('ASSISTANT_RESPONSE_TAB_NAVIGATION_PENDING', {
          tabRecoveryPending: true,
        });
      }
      return temporaryReport('ASSISTANT_BOUND_CONVERSATION_UNPROVEN', {
        normalizedObservedUrl: hinted.url || '', observedTabId: hinted.id,
      });
    }

    if (persistentManagedTab && job?.managedTabOwned !== true
        && recoveryAction === 'RETRY_BUTTON') {
      return temporaryReport('ASSISTANT_RESPONSE_TAB_NOT_OWNED', {
        chatRecoveryRequired: true,
        recoveryPending: true,
        recoveryCategory: 'TAB_NOT_OWNED',
        recoveryErrorLabel: 'Scenario recovery cannot click Retry in a user-owned tab',
        retryButtonLabel: '',
        retryAvailable: false,
      });
    }

    if (existing?.id != null) {
      tabId = existing.id;

      if (persistentManagedTab && existing.discarded === true) {
        return temporaryReport('ASSISTANT_RESPONSE_TAB_DISCARDED', {
          tabRecoveryPending: true,
          chatRecoveryRequired: true,
          recoveryPending: true,
          recoveryCategory: 'TAB_DISCARDED',
          recoveryErrorLabel: 'Scenario conversation tab was discarded by Chrome',
          retryButtonLabel: '',
          retryAvailable: false,
        });
      }

      if (persistentManagedTab && (existing.frozen === true
          || Number(job?.observationAgeMs || 0) >= 90_000 && existing.active !== true)) {
        const windowId = existing.windowId;
        const previousWake = lastFrozenWakeByWindow.get(windowId) || 0;
        if (job?.managedTabOwned === true && Number.isInteger(windowId)
            && (!Number.isInteger(job?.preferredWindowId) || windowId === job.preferredWindowId)
            && Date.now() - previousWake >= FROZEN_WAKE_INTERVAL_MS
            && chromeApi.tabs?.query && chromeApi.tabs?.update) {
          lastFrozenWakeByWindow.set(windowId, Date.now());
          try {
            const active = await chromeApi.tabs.query({ active: true, windowId });
            const previous = active?.[0];
            if (previous?.id !== existing.id) {
              const woken = await chromeApi.tabs.update(existing.id, { active: true });
              wokeTabId = existing.id;
              wokeWindowId = windowId;
              restoreActiveTabId = previous?.id ?? null;
              existing = woken || await getTab(chromeApi, existing.id);
            } else existing = await getTab(chromeApi, existing.id);
          } catch { /* never navigate, duplicate, or retry Send to wake a tab */ }
        }
        if (existing?.frozen === true) return temporaryReport('ASSISTANT_RESPONSE_TAB_FROZEN', {
          tabRecoveryPending: true,
          recoveryPending: true,
          recoveryCategory: 'TAB_FROZEN',
          recoveryErrorLabel: 'Scenario conversation tab was frozen by Chrome',
          retryButtonLabel: '',
          retryAvailable: false,
        });
      }

      if (persistentManagedTab && existing.status === 'loading'
          && existing.pendingUrl && !sameChatConversationUrl(existing.pendingUrl, conversationUrl)) {
        return temporaryReport('ASSISTANT_RESPONSE_TAB_NAVIGATION_PENDING', {
          tabRecoveryPending: true,
        });
      }
    } else {
      if (persistentManagedTab) {
        return temporaryReport('ASSISTANT_RESPONSE_TAB_MISSING', {
          tabRecoveryPending: true,
          chatRecoveryRequired: true,
          recoveryPending: true,
          recoveryCategory: 'TAB_MISSING',
          recoveryErrorLabel: 'Scenario conversation tab is missing',
          retryButtonLabel: '',
          retryAvailable: false,
        });
      }
      const tab = await createChatTab(chromeApi, conversationUrl, job?.preferredWindowId);
      tabId = tab?.id ?? null;
      if (tabId == null) throw new Error('Assistant report probe could not resolve a ChatGPT tab');
      temporaryTab = true;
    }

    if (tabId == null) throw new Error('Assistant report probe could not resolve a ChatGPT tab');
    const request = {
      requestId: `assistant-report:${job.id || job.workerId || job.taskId || 'probe'}:${Date.now()}`,
      taskId: job.taskId || job.workerId || 'assistant-report',
      mode: 'READ_ASSISTANT_REPORT',
      expectedWindowId: persistentManagedTab ? job?.preferredWindowId : undefined,
      requireWindowBinding: job?.requireWindowBinding === true,
      expectedUrl: correlateBoundDocument && existing?.url ? existing.url : conversationUrl,
      allowCorrelatedConversationRebind: correlateBoundDocument,
      boundConversationUrl: conversationUrl,
      promptText: '',
      assistantBaselineCount: Number(job.assistantBaselineCount || 0),
      assistantBaselineKnown: job.assistantBaselineKnown === true,
      submittedUserMessageKey: String(job.submittedUserMessageKey || ''),
      responseCorrelationToken: String(job.responseCorrelationToken || ''),
      submittedPromptText: String(job.submittedPromptText || ''),
      requireStableResponse: job.requireStableResponse === true,
    };
    if (recoveryAction === 'RETRY_BUTTON') request.mode = 'RECOVER_CHAT_ERROR_SURFACE';
    const report = await transport.execute(tabId, request);
    return { ...report, observedTabId: tabId };
  } finally {
    if (wokeTabId != null && restoreActiveTabId != null && chromeApi.tabs?.update) {
      try {
        const active = await chromeApi.tabs.query({ active: true, windowId: wokeWindowId });
        if (active?.[0]?.id === wokeTabId) await chromeApi.tabs.update(restoreActiveTabId, { active: true });
      } catch { /* leave the user's newly selected tab alone */ }
    }
    if (temporaryTab && tabId != null) {
      try { await chromeApi.tabs.remove(tabId); } catch (_) {}
    }
  }
}
