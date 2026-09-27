import { keepChatTabResident, sameChatConversationUrl } from './tabs.js';

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

async function protect(chromeApi, tab) {
  return keepChatTabResident(chromeApi, tab);
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

export async function probeAssistantConversation(chromeApi, transport, job) {
  const conversationUrl = String(job?.conversationUrl || '').trim();
  if (!conversationUrl) throw new Error('Assistant report probe requires conversationUrl');

  const persistentManagedTab = job?.persistentManagedTab === true;
  let tabId = null;
  let temporaryTab = false;

  try {
    const tabs = await chromeApi.tabs.query({ url: 'https://chatgpt.com/*' });
    let existing = (tabs || []).find(tab => tab?.id != null && matchesConversation(tab, conversationUrl));

    if (existing?.id != null) {
      existing = await protect(chromeApi, existing);
      tabId = existing.id;

      if (persistentManagedTab && existing.discarded === true) {
        const reloaded = await startSafeReload(chromeApi, existing);
        return temporaryReport(
          reloaded ? 'ASSISTANT_RESPONSE_TAB_RELOAD_STARTED' : 'ASSISTANT_RESPONSE_TAB_DISCARDED',
          { tabRecoveryPending: true },
        );
      }

      if (persistentManagedTab && existing.frozen === true) {
        const reloaded = await startSafeReload(chromeApi, existing);
        return temporaryReport(
          reloaded ? 'ASSISTANT_RESPONSE_TAB_RELOAD_STARTED' : 'ASSISTANT_RESPONSE_TAB_FROZEN',
          { tabRecoveryPending: true },
        );
      }

      if (persistentManagedTab && existing.status === 'loading') {
        return temporaryReport('ASSISTANT_RESPONSE_TAB_NAVIGATION_PENDING', {
          tabRecoveryPending: true,
        });
      }
    } else {
      let tab = await chromeApi.tabs.create({ url: conversationUrl, active: false });
      tab = await protect(chromeApi, tab);
      tabId = tab?.id ?? null;
      if (tabId == null) throw new Error('Assistant report probe could not resolve a ChatGPT tab');

      if (persistentManagedTab) {
        return temporaryReport('ASSISTANT_RESPONSE_TAB_REOPENED_WAITING', {
          tabRecoveryPending: true,
        });
      }
      temporaryTab = true;
    }

    if (tabId == null) throw new Error('Assistant report probe could not resolve a ChatGPT tab');
    return await transport.execute(tabId, {
      requestId: `assistant-report:${job.id || job.workerId || job.taskId || 'probe'}:${Date.now()}`,
      taskId: job.taskId || job.workerId || 'assistant-report',
      mode: 'READ_ASSISTANT_REPORT',
      expectedUrl: conversationUrl,
      promptText: '',
      assistantBaselineCount: Number(job.assistantBaselineCount || 0),
      assistantBaselineKnown: job.assistantBaselineKnown === true,
    });
  } finally {
    if (temporaryTab && tabId != null) {
      try { await chromeApi.tabs.remove(tabId); } catch (_) {}
    }
  }
}
