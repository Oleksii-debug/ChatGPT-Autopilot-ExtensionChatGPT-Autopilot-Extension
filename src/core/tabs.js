import { normalizeChatUrl, OperationPhase, TabStrategy } from './schema.js';

const workerHintKey = sessionId => `__session_worker__:${sessionId}`;
const DEFAULT_TAB_READY_TIMEOUT_MS = 90000;
const DEFAULT_TAB_READY_POLL_MS = 250;

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

function conversationId(url) {
  try {
    return new URL(url).pathname.match(/\/c\/([^/]+)/u)?.[1] || null;
  } catch {
    return null;
  }
}

// ChatGPT can canonicalize a Custom GPT conversation from
// /g/<gpt-slug>/c/<conversation-id> to /c/<conversation-id>.  The stable
// conversation id is the authority; treating the canonical redirect as a
// different Task causes an endless navigation/retry loop.
export function sameChatConversationUrl(observed, expected) {
  if (!observed || !expected) return false;
  if (observed === expected) return true;
  try {
    const observedUrl = new URL(observed);
    const expectedUrl = new URL(expected);
    const observedId = conversationId(observedUrl.href);
    const expectedId = conversationId(expectedUrl.href);
    return observedUrl.hostname === expectedUrl.hostname
      && Boolean(observedId)
      && observedId === expectedId;
  } catch {
    return false;
  }
}


// A launch surface (/ or /g/<slug>) legitimately becomes a newly-created
// conversation after Send. During an unresolved post-submit operation the
// extension must keep ownership of that same tab instead of discarding the
// hint and opening another root ChatGPT tab.
export function expectedPostSendConversationUrl(observed, expected) {
  if (!observed || !expected) return false;
  try {
    const observedUrl = new URL(observed);
    const expectedUrl = new URL(expected);
    if (observedUrl.hostname !== expectedUrl.hostname) return false;
    const observedId = conversationId(observedUrl.href);
    if (!observedId || conversationId(expectedUrl.href)) return false;
    if (expectedUrl.pathname === '/') return /^\/c\/[^/]+(?:\/)?$/u.test(observedUrl.pathname);
    const expectedGpt = expectedUrl.pathname.match(/^\/g\/([^/]+)\/?$/u)?.[1] || '';
    if (!expectedGpt) return false;
    const observedGpt = observedUrl.pathname.match(/^\/g\/([^/]+)\/c\/[^/]+(?:\/)?$/u)?.[1] || '';
    return observedGpt === expectedGpt || /^\/c\/[^/]+(?:\/)?$/u.test(observedUrl.pathname);
  } catch {
    return false;
  }
}

function operationAllowsPostSendTab(session, task) {
  const operation = session?.operation;
  return operation?.taskId === task?.id
    && [OperationPhase.SUBMITTING, OperationPhase.AMBIGUOUS].includes(operation.phase)
    && Number(operation.submitStartedAt || 0) > 0;
}

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForTaskTabReady(chromeApi, tabId, expectedUrl, {
  timeoutMs = DEFAULT_TAB_READY_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_TAB_READY_POLL_MS,
  now = () => Date.now(),
  wait = waitMs,
  allowPostSendNavigation = false,
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
    if (documentReady && (sameChatConversationUrl(observedUrl, normalizedExpected)
      || (allowPostSendNavigation && expectedPostSendConversationUrl(observedUrl, normalizedExpected)))) return lastTab;

    if (now() >= deadline) {
      const expectedLocation = sameChatConversationUrl(observedUrl, normalizedExpected)
        || (allowPostSendNavigation && expectedPostSendConversationUrl(observedUrl, normalizedExpected));
      const code = documentReady && observedUrl && !expectedLocation
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


async function retireOwnedHintBeforeReuse(chromeApi, state, hintKey, hint) {
  if (!hint?.retirePending || hint?.ownedByExtension !== true || hint.tabId == null) return false;
  try {
    await chromeApi.tabs.remove(hint.tabId);
  } catch (error) {
    try {
      await chromeApi.tabs.get(hint.tabId);
    } catch {
      delete state.tabHintsByTaskId[hintKey];
      return true;
    }
    throw new TabReadinessError(
      'TAB_RETIRE_PENDING',
      'Extension-owned ChatGPT tab is pending retirement before reuse',
      error,
    );
  }
  delete state.tabHintsByTaskId[hintKey];
  return true;
}

async function retireStaleOwnedOpenCloseHint(chromeApi, state, hintKey, hint) {
  if (!hint || hint.tabId == null || hint.ownedByExtension === false) {
    delete state.tabHintsByTaskId[hintKey];
    return;
  }
  try {
    await chromeApi.tabs.remove(hint.tabId);
    delete state.tabHintsByTaskId[hintKey];
  } catch (error) {
    try {
      await chromeApi.tabs.get(hint.tabId);
    } catch {
      delete state.tabHintsByTaskId[hintKey];
      return;
    }
    hint.ownedByExtension = true;
    hint.retirePending = true;
    state.tabHintsByTaskId[hintKey] = hint;
    throw new TabReadinessError(
      'TAB_RETIRE_PENDING',
      'Stale extension-owned ChatGPT tab could not be retired safely',
      error,
    );
  }
}

async function getValidHintedTab(chromeApi, hint, expected) {
  if (!hintHasExpectedOwnership(hint, expected)) return null;
  const identityUrl = hint.normalizedUrl || expected.normalizedUrl;
  try {
    const tab = await chromeApi.tabs.get(hint.tabId);
    const observed = normalizedTabUrl(tab);
    if (sameChatConversationUrl(observed, identityUrl)) return tab;
    if (expected.allowPostSendNavigation && expectedPostSendConversationUrl(observed, identityUrl)) return tab;
    return null;
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
  if (!task || !hint.normalizedUrl) return false;
  if (hint.normalizedUrl === task.normalizedUrl) return true;

  // A fresh-launch Task is rebound to its concrete /c/<id> while an attempted
  // Send is unresolved. The ownership hint deliberately retains the original
  // launch surface so recovery can prove that this is the exact extension-owned
  // tab instead of adopting another user's tab. Treat that root→conversation
  // transition as live ownership until the operation becomes terminal.
  return operationAllowsPostSendTab(owner, task)
    && expectedPostSendConversationUrl(task.normalizedUrl, hint.normalizedUrl);
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
    return sameChatConversationUrl(normalizedTabUrl(tab), normalizedUrl);
  }) || null;
}

async function resolveWorkerTab(chromeApi, state, sessionId, task) {
  const key = workerHintKey(sessionId);
  let hint = state.tabHintsByTaskId[key];
  const session = state.sessionsById?.[sessionId];
  if (hint?.retirePending && hint?.ownedByExtension === true) {
    await retireOwnedHintBeforeReuse(chromeApi, state, key, hint);
    hint = state.tabHintsByTaskId[key];
  }
  const preserveCurrentPostSend = operationAllowsPostSendTab(session, task);
  const terminalOperationOwnsGeneratedChat = Boolean(
    session?.operation?.phase === OperationPhase.SENT_VERIFIED
    && Number(session.operation.submitStartedAt || 0) > 0
    && session.operation.targetUrl
    && hint?.normalizedUrl === session.operation.targetUrl
  );
  const hintedTab = await getValidHintedTab(chromeApi, hint, {
    sessionId,
    kind: 'SESSION_WORKER',
    allowPostSendNavigation: preserveCurrentPostSend || terminalOperationOwnsGeneratedChat,
  });

  if (hintedTab) {
    const currentUrl = normalizedTabUrl(hintedTab);
    if (sameChatConversationUrl(currentUrl, task.normalizedUrl)
        || (preserveCurrentPostSend && expectedPostSendConversationUrl(currentUrl, task.normalizedUrl))) return hintedTab;

    const navigated = await chromeApi.tabs.update(hintedTab.id, {
      url: task.normalizedUrl,
      active: false,
    });
    state.tabHintsByTaskId[key] = {
      tabId: navigated.id,
      sessionId,
      normalizedUrl: task.normalizedUrl,
      kind: 'SESSION_WORKER',
      ownedByExtension: hint?.ownedByExtension === true,
      retirePending: false,
      boundAt: Date.now(),
    };
    return navigated;
  }

  delete state.tabHintsByTaskId[key];
  const excluded = claimedTabIdsByOtherSessions(state, sessionId);
  // A launch surface (/ or /g/<slug>) has no durable conversation identity.
  // Never adopt an arbitrary existing launch tab: concurrent Sessions could
  // otherwise race on the same composer. Concrete /c/<id> targets may reuse
  // an unclaimed matching tab because the conversation identity is exclusive.
  const match = conversationId(task.normalizedUrl)
    ? await findMatchingChatTab(chromeApi, task.normalizedUrl, excluded)
    : null;
  const tab = match || await chromeApi.tabs.create({ url: task.normalizedUrl, active: false });
  state.tabHintsByTaskId[key] = {
    tabId: tab.id,
    sessionId,
    normalizedUrl: task.normalizedUrl,
    kind: 'SESSION_WORKER',
    ownedByExtension: !match,
    retirePending: false,
    boundAt: Date.now(),
  };
  return tab;
}

export async function resolveTaskTab(chromeApi, state, sessionId, task) {
  const session = state.sessionsById?.[sessionId];
  if (session?.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION) {
    return resolveWorkerTab(chromeApi, state, sessionId, task);
  }

  let hint = state.tabHintsByTaskId[task.id];
  if (hint?.retirePending && hint?.ownedByExtension === true) {
    await retireOwnedHintBeforeReuse(chromeApi, state, task.id, hint);
    hint = state.tabHintsByTaskId[task.id];
  }
  if (hint?.tabId != null) {
    const postSendRecovery = operationAllowsPostSendTab(session, task);
    // During a fresh-launch ambiguous Send, applyInteractionResult binds the
    // Task to the observed concrete /c/<id>, while the tab hint still records
    // the root launch surface that this extension created. Validate against the
    // hint identity in that one proven transition so we reuse the same physical
    // tab. Otherwise the root hint would look stale, a second tab would be
    // opened, and the original extension-owned tab would become orphaned.
    const preservesFreshLaunchOwnership = postSendRecovery
      && hint.normalizedUrl
      && expectedPostSendConversationUrl(task.normalizedUrl, hint.normalizedUrl);
    const tab = await getValidHintedTab(chromeApi, hint, {
      sessionId,
      kind: 'TASK',
      normalizedUrl: preservesFreshLaunchOwnership ? hint.normalizedUrl : task.normalizedUrl,
      allowPostSendNavigation: postSendRecovery,
    });
    if (tab) return tab;
    if (session?.tabStrategy === TabStrategy.OPEN_CLOSE_PER_TASK
        || hint?.ownedByExtension === true) {
      // OPEN_CLOSE is always extension-owned. KEEP_TASK can also be safely
      // retired when provenance explicitly proves this extension created the
      // stale tab. Adopted/user tabs are only unbound, never physically closed.
      await retireStaleOwnedOpenCloseHint(chromeApi, state, task.id, hint);
    } else {
      delete state.tabHintsByTaskId[task.id];
    }
  }

  // Open-and-close mode owns only tabs it creates.  It must never adopt a
  // manually opened conversation tab and then close the user's tab later.
  if (session?.tabStrategy === TabStrategy.OPEN_CLOSE_PER_TASK) {
    const tab = await chromeApi.tabs.create({ url: task.normalizedUrl, active: false });
    state.tabHintsByTaskId[task.id] = {
      tabId: tab.id,
      sessionId,
      normalizedUrl: task.normalizedUrl,
      kind: 'TASK',
      ownedByExtension: true,
      retirePending: false,
      boundAt: Date.now(),
    };
    return tab;
  }

  const excluded = claimedTabIdsByOtherSessions(state, sessionId);
  // A launch surface (/ or /g/<slug>) has no durable conversation identity.
  // Never adopt an arbitrary existing launch tab: concurrent Sessions could
  // otherwise race on the same composer. Concrete /c/<id> targets may reuse
  // an unclaimed matching tab because the conversation identity is exclusive.
  const match = conversationId(task.normalizedUrl)
    ? await findMatchingChatTab(chromeApi, task.normalizedUrl, excluded)
    : null;
  const tab = match || await chromeApi.tabs.create({ url: task.normalizedUrl, active: false });
  state.tabHintsByTaskId[task.id] = {
    tabId: tab.id,
    sessionId,
    normalizedUrl: task.normalizedUrl,
    kind: 'TASK',
    ownedByExtension: !match,
    retirePending: false,
    boundAt: Date.now(),
  };
  return tab;
}
