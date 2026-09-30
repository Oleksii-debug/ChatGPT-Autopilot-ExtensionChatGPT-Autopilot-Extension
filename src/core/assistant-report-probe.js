import { createChatTab, sameChatConversationUrl } from './tabs.js';

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
  } catch {
    return null;
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

  try {
    const hinted = await getTab(chromeApi, job?.managedTabId);
    // A managed Scenario must inspect its bound tab, not the first matching
    // conversation in Chrome (which may be a manually opened user tab).
    const tabs = await chromeApi.tabs.query({ url: 'https://chatgpt.com/*' });
    let existing = persistentManagedTab
      ? (hinted && matchesConversation(hinted, conversationUrl) ? hinted
        : null)
      : (tabs || []).find(tab => tab?.id != null && matchesConversation(tab, conversationUrl));
    // Frozen/discarded documents cannot run the receiver. Wake this owned
    // physical tab, without focusing a window or replacing its conversation.
    if (persistentManagedTab && job?.managedTabOwned === true && existing?.id != null
        && (existing.frozen === true || existing.discarded === true) && chromeApi.tabs?.update) {
      try {
        const activeTabs = await chromeApi.tabs.query({ active: true, windowId: existing.windowId });
        const prior = (activeTabs || []).find(item => item.active === true && item.windowId === existing.windowId);
        if (prior?.id != null && prior.id !== existing.id) restoreActiveTabId = prior.id;
        existing = await chromeApi.tabs.update(existing.id, { active: true, autoDiscardable: false });
      } catch { /* Bounded recovery below retains the physical identity. */ }
    }
    const recoveryAction = String(job?.recoveryAction || '').trim();

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
      if (hinted.status === 'loading') {
        return temporaryReport('ASSISTANT_RESPONSE_TAB_NAVIGATION_PENDING', {
          tabRecoveryPending: true,
        });
      }
      if (job?.managedTabOwned === true && chromeApi.tabs?.update) {
        try {
          await chromeApi.tabs.update(hinted.id, { url: conversationUrl, active: false });
          return temporaryReport('ASSISTANT_RESPONSE_TAB_NAVIGATION_PENDING', {
            tabRecoveryPending: true,
            recoveredManagedTabId: hinted.id,
          });
        } catch { /* Leave the saved identity intact for bounded recovery. */ }
      }
      return temporaryReport('CHATGPT_RECOVERY_CONVERSATION_IDENTITY_LOST', {
        chatRecoveryRequired: true,
        recoveryPending: true,
        recoveryCategory: 'CONVERSATION_IDENTITY_LOST',
        recoveryErrorLabel: 'Managed tab left the saved conversation URL',
        retryButtonLabel: '',
        retryAvailable: false,
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
      if (persistentManagedTab && job?.managedTabOwned === true && chromeApi.tabs?.update) {
        try { await chromeApi.tabs.update(tabId, { autoDiscardable: false }); } catch { /* optional Chrome hint */ }
      }

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

      if (persistentManagedTab && existing.frozen === true) {
        return temporaryReport('ASSISTANT_RESPONSE_TAB_FROZEN', {
          tabRecoveryPending: true,
          chatRecoveryRequired: true,
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
      expectedUrl: conversationUrl,
      promptText: '',
      assistantBaselineCount: Number(job.assistantBaselineCount || 0),
      assistantBaselineKnown: job.assistantBaselineKnown === true,
      submittedUserMessageKey: String(job.submittedUserMessageKey || ''),
      responseCorrelationToken: String(job.responseCorrelationToken || ''),
      submittedPromptText: String(job.submittedPromptText || ''),
      requireStableResponse: job.requireStableResponse === true,
    };
    if (recoveryAction === 'RETRY_BUTTON') request.mode = 'RECOVER_CHAT_ERROR_SURFACE';
    return await transport.execute(tabId, request);
  } finally {
    if (restoreActiveTabId != null) {
      try { await chromeApi.tabs.update(restoreActiveTabId, { active: true }); } catch { /* prior tab closed */ }
    }
    if (temporaryTab && tabId != null) {
      try { await chromeApi.tabs.remove(tabId); } catch (_) {}
    }
  }
}
