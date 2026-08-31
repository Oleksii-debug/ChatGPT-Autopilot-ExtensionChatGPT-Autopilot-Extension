import { normalizeChatUrl, TabStrategy } from './schema.js';

const workerHintKey = sessionId => `__session_worker__:${sessionId}`;
const DEFAULT_TAB_READY_TIMEOUT_MS = 30000;
const DEFAULT_TAB_READY_POLL_MS = 100;

export class TabReadinessError extends Error {
  constructor(safeDiagnosticCode, message, cause = null) {
    super(message);
    this.name = 'TabReadinessError';
    this.safeDiagnosticCode = safeDiagnosticCode;
    if (cause) this.cause = cause;
  }
}

function normalizedTabUrl(tab) {
  try {
    return tab?.url ? normalizeChatUrl(tab.url) : null;
  } catch {
    return null;
  }
}

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForTaskTabReady(chromeApi, tabId, expectedUrl, {
  timeoutMs = DEFAULT_TAB_READY_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_TAB_READY_POLL_MS,
  now = () => Date.now(),
  wait = waitMs,
} = {}) {
  if (!chromeApi?.tabs?.get) {
    throw new TabReadinessError(
      'TAB_READINESS_API_UNAVAILABLE',
      'Chrome tab readiness API is unavailable before CHECK_ONLY',
    );
  }

  let normalizedExpected;
  try {
    normalizedExpected = normalizeChatUrl(expectedUrl);
  } catch (error) {
    throw new TabReadinessError(
      'TAB_EXPECTED_URL_INVALID',
      'Selected task has an invalid ChatGPT URL before CHECK_ONLY',
      error,
    );
  }

  const startedAt = now();
  const deadline = startedAt + Math.max(0, timeoutMs);
  let lastTab = null;

  while (true) {
    try {
      lastTab = await chromeApi.tabs.get(tabId);
    } catch (error) {
      throw new TabReadinessError(
        'TAB_UNAVAILABLE_DURING_READINESS_CHECK',
        'Selected ChatGPT tab became unavailable before CHECK_ONLY',
        error,
      );
    }

    const observedUrl = normalizedTabUrl(lastTab);
    const documentReady = lastTab.status === 'complete' || lastTab.status == null;
    if (documentReady && observedUrl === normalizedExpected) return lastTab;

    if (now() >= deadline) {
      const code = documentReady && observedUrl && observedUrl !== normalizedExpected
        ? 'TAB_NAVIGATION_URL_MISMATCH'
        : 'TAB_NAVIGATION_TIMEOUT';
      throw new TabReadinessError(
        code,
        code === 'TAB_NAVIGATION_URL_MISMATCH'
          ? 'Selected ChatGPT tab completed at a different URL before CHECK_ONLY'
          : 'Selected ChatGPT tab did not finish navigation before CHECK_ONLY',
      );
    }

    await wait(Math.max(1, Math.min(pollIntervalMs, deadline - now())));
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

function hintStillRepresentsCurrentOwnership(state, hintKey, hint) {
  if (!hint?.sessionId) return false;
  const owner = state.sessionsById?.[hint.sessionId];
  if (!owner) return false;

  if (hint.kind === 'SESSION_WORKER') {
    return owner.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION
      && hintKey === workerHintKey(owner.id);
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
