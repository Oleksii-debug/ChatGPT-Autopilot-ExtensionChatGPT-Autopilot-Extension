import { normalizeChatUrl, TabStrategy } from './schema.js';

const workerHintKey = sessionId => `__session_worker__:${sessionId}`;

function normalizedTabUrl(tab) {
  try {
    return tab?.url ? normalizeChatUrl(tab.url) : null;
  } catch {
    return null;
  }
}

function hintHasExpectedOwnership(hint, { sessionId, kind, normalizedUrl = null }) {
  if (!hint || hint.tabId == null) return false;

  if (kind === 'SESSION_WORKER') {
    if (hint.sessionId !== sessionId) return false;
    if (hint.kind !== 'SESSION_WORKER') return false;
    return Boolean(hint.normalizedUrl);
  }

  if (hint.sessionId != null && hint.sessionId !== sessionId) return false;
  if (hint.kind != null && hint.kind !== 'TASK') return false;
  const identityUrl = hint.normalizedUrl || normalizedUrl;
  if (!identityUrl) return false;
  if (normalizedUrl && identityUrl !== normalizedUrl) return false;
  return true;
}

async function getValidHintedTab(chromeApi, hint, expected) {
  if (!hintHasExpectedOwnership(hint, expected)) return null;
  const identityUrl = hint.normalizedUrl || expected.normalizedUrl;
  try {
    const tab = await chromeApi.tabs.get(hint.tabId);
    return normalizedTabUrl(tab) === identityUrl ? tab : null;
  } catch {
    return null;
  }
}

function claimedTabIdsByOtherSessions(state, sessionId) {
  const claimed = new Set();
  for (const hint of Object.values(state.tabHintsByTaskId || {})) {
    if (hint?.tabId == null) continue;
    if (hint.sessionId && hint.sessionId !== sessionId) claimed.add(hint.tabId);
  }
  return claimed;
}

async function findMatchingChatTab(chromeApi, normalizedUrl, excludedTabIds = new Set()) {
  const tabs = await chromeApi.tabs.query({ url: 'https://chatgpt.com/*' });
  return tabs.find(tab => {
    if (excludedTabIds.has(tab.id)) return false;
    return normalizedTabUrl(tab) === normalizedUrl;
  }) || null;
}

async function resolveWorkerTab(chromeApi, state, sessionId, task) {
  const key = workerHintKey(sessionId);
  const hint = state.tabHintsByTaskId[key];
  const hintedTab = await getValidHintedTab(chromeApi, hint, {
    sessionId,
    kind: 'SESSION_WORKER',
  });

  if (hintedTab) {
    const currentUrl = normalizedTabUrl(hintedTab);
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
  const excluded = claimedTabIdsByOtherSessions(state, sessionId);
  const match = await findMatchingChatTab(chromeApi, task.normalizedUrl, excluded);
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
    const tab = await getValidHintedTab(chromeApi, hint, {
      sessionId,
      kind: 'TASK',
      normalizedUrl: task.normalizedUrl,
    });
    if (tab) return tab;
    delete state.tabHintsByTaskId[task.id];
  }

  const excluded = claimedTabIdsByOtherSessions(state, sessionId);
  const match = await findMatchingChatTab(chromeApi, task.normalizedUrl, excluded);
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
