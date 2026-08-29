import { normalizeChatUrl, TabStrategy } from './schema.js';

const workerHintKey = sessionId => `__session_worker__:${sessionId}`;

async function getValidHintedTab(chromeApi, hint) {
  if (hint?.tabId == null) return null;
  try {
    const tab = await chromeApi.tabs.get(hint.tabId);
    return tab?.url ? tab : null;
  } catch {
    return null;
  }
}

async function findMatchingChatTab(chromeApi, normalizedUrl) {
  const tabs = await chromeApi.tabs.query({ url: 'https://chatgpt.com/*' });
  return tabs.find(tab => {
    try {
      return tab.url && normalizeChatUrl(tab.url) === normalizedUrl;
    } catch {
      return false;
    }
  }) || null;
}

async function resolveWorkerTab(chromeApi, state, sessionId, task) {
  const key = workerHintKey(sessionId);
  const hint = state.tabHintsByTaskId[key];
  const hintedTab = await getValidHintedTab(chromeApi, hint);

  if (hintedTab) {
    let currentUrl = '';
    try { currentUrl = normalizeChatUrl(hintedTab.url); } catch {}
    if (currentUrl === task.normalizedUrl) return hintedTab;

    const navigated = await chromeApi.tabs.update(hintedTab.id, {
      url: task.normalizedUrl,
      active: false,
    });
    state.tabHintsByTaskId[key] = {
      tabId: navigated.id,
      sessionId,
      normalizedUrl: task.normalizedUrl,
      kind: 'SESSION_WORKER',
      boundAt: Date.now(),
    };
    return navigated;
  }

  delete state.tabHintsByTaskId[key];
  const match = await findMatchingChatTab(chromeApi, task.normalizedUrl);
  const tab = match || await chromeApi.tabs.create({ url: task.normalizedUrl, active: false });
  state.tabHintsByTaskId[key] = {
    tabId: tab.id,
    sessionId,
    normalizedUrl: task.normalizedUrl,
    kind: 'SESSION_WORKER',
    boundAt: Date.now(),
  };
  return tab;
}

export async function resolveTaskTab(chromeApi, state, sessionId, task) {
  const session = state.sessionsById?.[sessionId];
  if (session?.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION) {
    return resolveWorkerTab(chromeApi, state, sessionId, task);
  }

  const hint = state.tabHintsByTaskId[task.id];
  if (hint?.tabId != null) {
    const tab = await getValidHintedTab(chromeApi, hint);
    if (tab) {
      try {
        if (normalizeChatUrl(tab.url) === task.normalizedUrl) return tab;
      } catch {}
    }
    delete state.tabHintsByTaskId[task.id];
  }

  const match = await findMatchingChatTab(chromeApi, task.normalizedUrl);
  const tab = match || await chromeApi.tabs.create({ url: task.normalizedUrl, active: false });
  state.tabHintsByTaskId[task.id] = {
    tabId: tab.id,
    sessionId,
    normalizedUrl: task.normalizedUrl,
    kind: 'TASK',
    boundAt: Date.now(),
  };
  return tab;
}
