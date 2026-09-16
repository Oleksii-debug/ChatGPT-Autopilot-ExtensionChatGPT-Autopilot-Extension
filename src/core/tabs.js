import { TabStrategy } from './schema.js';
import { getPromptCadenceConfig } from './prompt-cadence.js';

const CHAT_FLOW_ROOT_URL = 'https://chatgpt.com/';

function workerHintKey(sessionId) {
  return `__session_worker__:${sessionId}`;
}

function normalizedTabUrl(tab) {
  try {
    const url = new URL(tab?.url || '');
    if (url.origin !== 'https://chatgpt.com') return null;
    return url.pathname.replace(/\/$/, '') || '/';
  } catch {
    return null;
  }
}

async function getValidHintedTab(chromeApi, hint, expectation) {
  if (!hint?.tabId) return null;
  try {
    const tab = await chromeApi.tabs.get(hint.tabId);
    const currentUrl = normalizedTabUrl(tab);
    if (!currentUrl) return null;
    if (hint.sessionId !== expectation.sessionId) return null;
    if (hint.kind !== expectation.kind) return null;
    if (expectation.normalizedUrl && currentUrl !== expectation.normalizedUrl) return null;
    if (hint.normalizedUrl && expectation.kind !== 'CHAT_FLOW' && currentUrl !== hint.normalizedUrl) return null;
    return tab;
  } catch {
    return null;
  }
}

function hintStillRepresentsCurrentOwnership(state, hintKey, hint) {
  if (!hint?.sessionId) return false;
  const owner = state.sessionsById?.[hint.sessionId];
  if (!owner) return false;

  if (hint.kind === 'SESSION_WORKER') {
    return owner.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION
      && hintKey === workerHintKey(owner.id);
  }

  if (hint.kind === 'CHAT_FLOW') {
    return owner.tabStrategy !== TabStrategy.ONE_WORKER_TAB_PER_SESSION;
  }

  if (hint.kind != null && hint.kind !== 'TASK') return false;
  if (owner.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION) return false;
  const task = owner.tasksById?.[hintKey];
  if (!task) return false;
  return Boolean(hint.normalizedUrl) && hint.normalizedUrl === task.normalizedUrl;
}

function claimedTabIdsByOtherSessions(state, sessionId) {
  const claimed = new Set();
  for (const [hintKey, hint] of Object.entries(state.tabHintsByTaskId || {})) {
    if (hint?.tabId == null || hint.sessionId === sessionId) continue;
    if (hintStillRepresentsCurrentOwnership(state, hintKey, hint)) claimed.add(hint.tabId);
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

function chatFlowNeedsNewChat(session, config) {
  const count = Number.isInteger(session.cadenceVerifiedSendCount) && session.cadenceVerifiedSendCount >= 0
    ? session.cadenceVerifiedSendCount
    : 0;
  if (config.chatFlow.mode === 'new-chat-after') {
    return count > 0 && count % config.chatFlow.newChatEveryN === 0;
  }
  if (config.chatFlow.mode === 'staged') {
    const firstStageTotal = 1 + config.chatFlow.continueCount;
    return count === firstStageTotal;
  }
  return false;
}

async function bindChatFlowTaskTab(chromeApi, state, sessionId, task, session) {
  const config = getPromptCadenceConfig(state, sessionId);
  const key = task.id;
  const hint = state.tabHintsByTaskId[key];
  const sessionHint = state.tabHintsByTaskId[workerHintKey(sessionId)];
  const shouldCreateNew = chatFlowNeedsNewChat(session, config);

  if (!shouldCreateNew) {
    const hinted = await getValidHintedTab(chromeApi, hint, { sessionId, kind: 'CHAT_FLOW' })
      || await getValidHintedTab(chromeApi, sessionHint, { sessionId, kind: 'CHAT_FLOW' });
    if (hinted) {
      const currentUrl = normalizedTabUrl(hinted) || CHAT_FLOW_ROOT_URL;
      task.url = currentUrl;
      task.normalizedUrl = currentUrl;
      state.tabHintsByTaskId[workerHintKey(sessionId)] = {
        tabId: hinted.id,
        sessionId,
        normalizedUrl: currentUrl,
        kind: 'CHAT_FLOW',
        boundAt: Date.now(),
      };
      state.tabHintsByTaskId[key] = {
        tabId: hinted.id,
        sessionId,
        normalizedUrl: currentUrl,
        kind: 'CHAT_FLOW',
        boundAt: Date.now(),
      };
      return hinted;
    }
  }

  let tab = null;
  if (sessionHint?.tabId != null && shouldCreateNew) {
    try {
      tab = await chromeApi.tabs.update(sessionHint.tabId, { url: CHAT_FLOW_ROOT_URL, active: false });
    } catch {
      tab = null;
    }
  }

  if (!tab) {
    const initialUrl = shouldCreateNew ? CHAT_FLOW_ROOT_URL : (sessionHint?.normalizedUrl || task.normalizedUrl || CHAT_FLOW_ROOT_URL);
    const excluded = claimedTabIdsByOtherSessions(state, sessionId);
    const match = await findMatchingChatTab(chromeApi, initialUrl, excluded);
    tab = match || await chromeApi.tabs.create({ url: initialUrl, active: false });
  }

  const currentUrl = normalizedTabUrl(tab) || CHAT_FLOW_ROOT_URL;
  task.url = currentUrl;
  task.normalizedUrl = currentUrl;
  state.tabHintsByTaskId[workerHintKey(sessionId)] = {
    tabId: tab.id,
    sessionId,
    normalizedUrl: currentUrl,
    kind: 'CHAT_FLOW',
    boundAt: Date.now(),
  };
  state.tabHintsByTaskId[key] = {
    tabId: tab.id,
    sessionId,
    normalizedUrl: currentUrl,
    kind: 'CHAT_FLOW',
    boundAt: Date.now(),
  };
  return tab;
}

async function resolveWorkerTab(chromeApi, state, sessionId, task) {
  const key = workerHintKey(sessionId);
  const hint = state.tabHintsByTaskId[key];
  const hintedTab = await getValidHintedTab(chromeApi, hint, {
    sessionId,
    kind: 'SESSION_WORKER',
  });

  if (hintedTab) {
    const liveUrl = normalizedTabUrl(hintedTab);
    if (liveUrl === task.normalizedUrl) return hintedTab;
    try {
      return await chromeApi.tabs.update(hintedTab.id, { url: task.normalizedUrl, active: false });
    } catch {
      delete state.tabHintsByTaskId[key];
    }
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
  const chatFlow = getPromptCadenceConfig(state, sessionId).chatFlow;
  if (session && chatFlow.enabled === true && ['same-chat', 'new-chat-after', 'staged'].includes(chatFlow.mode)) {
    return bindChatFlowTaskTab(chromeApi, state, sessionId, task, session);
  }
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
