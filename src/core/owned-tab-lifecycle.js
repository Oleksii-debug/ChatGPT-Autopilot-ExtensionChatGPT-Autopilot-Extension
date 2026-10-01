import { assertSessionWindow } from './window-binding.js';
import { TabStrategy } from './schema.js';
import { appendDiagnostic } from './diagnostics.js';

const queues = new WeakMap();
const PLACEHOLDER_PREFIX = 'about:blank#autopilot-owned:';
const tabAbsent = error => /no tab with id|invalid tab id|tab not found/iu.test(String(error?.message || error));

// All Core and Scenario bindings share this queue. Storage writes stay short;
// Chrome effects never hold StorageRepository's update queue.
export function withTabLifecycle(repository, action) {
  const previous = queues.get(repository) || Promise.resolve();
  const result = previous.catch(() => undefined).then(action);
  queues.set(repository, result);
  return result.finally(() => {
    if (queues.get(repository) === result) queues.delete(repository);
  });
}

export async function createRecordedOwnedTab(repository, chromeApi, owner, options) {
  const { hintKey, sessionId, kind = 'TASK' } = owner;
  const targetUrl = options.url;
  const before = await repository.load();
  const sessionBefore = before.sessionsById?.[sessionId];
  const transient = sessionBefore?.tabStrategy === TabStrategy.OPEN_CLOSE_PER_TASK
    || sessionBefore?.scenarioWork?.managed === true;
  // Resident Scenario documents are bounded by their durable participants,
  // not the number of concurrent executor requests. A whole prompt sequence
  // must remain open; an operation cap of 3/10 cannot admit a 15-chat pool.
  if (transient && sessionBefore?.scenarioWork?.managed !== true) {
    const limit = Math.max(1, Math.min(1000,
      Math.floor(Number(before.profile?.maxConcurrentSessionOperations) || 10)));
    let live = 0;
    for (const [key, hint] of Object.entries(before.tabHintsByTaskId || {})) {
      if (key === hintKey || hint.ownedByExtension !== true) continue;
      const other = before.sessionsById?.[hint.sessionId];
      if (other?.tabStrategy !== TabStrategy.OPEN_CLOSE_PER_TASK || other?.scenarioWork?.managed === true) continue;
      try { await chromeApi.tabs.get(hint.tabId); live += 1; }
      catch (error) { if (!tabAbsent(error)) throw error; }
    }
    if (live >= limit) {
      const error = new Error('Live owned tab budget is full; wait for an existing tab to close');
      error.safeDiagnosticCode = 'TAB_RESOURCE_CAPACITY_WAIT';
      throw error;
    }
  }
  let previousId = before.tabHintsByTaskId?.[hintKey]?.tabId;
  if (previousId != null) {
    let present = null;
    try { present = await chromeApi.tabs.get(previousId); }
    catch (error) { if (!tabAbsent(error)) throw error; }
    if (present && before.tabHintsByTaskId[hintKey].ownedByExtension === true) throw new Error('TAB_BINDING_ALREADY_EXISTS');
    if (present) {
      await repository.update(state => {
        const hint = state.tabHintsByTaskId?.[hintKey];
        if (hint?.tabId === previousId && hint.ownedByExtension !== true) delete state.tabHintsByTaskId[hintKey];
        return state;
      });
      previousId = null;
    }
  }
  const marker = `${PLACEHOLDER_PREFIX}${encodeURIComponent(sessionId)}:${encodeURIComponent(hintKey)}`;
  // A crash before the ID is committed leaves only a recognizable blank page,
  // never an untracked ChatGPT document consuming network and accepting prompts.
  const candidates = await chromeApi.tabs.query({});
  let tab = (candidates || []).find(item => item.url === marker || item.pendingUrl === marker);
  if (!tab) tab = await chromeApi.tabs.create({ ...options, url: marker });
  assertSessionWindow(sessionBefore, tab);
  try {
    await repository.update(state => {
      const session = state.sessionsById?.[sessionId];
      if (!session || !session.tasksById?.[owner.taskId || hintKey]) throw new Error('TAB_OWNER_REMOVED');
      if (session.enabled === false || (!['RUNNING', 'RECOVERING'].includes(session.runState)
          && !(owner.allowVerifiedResponse && session.runState !== 'PAUSED'
            && session.operation?.phase === 'SENT_VERIFIED'))) throw new Error('TAB_OWNER_QUIESCED');
      const prior = state.tabHintsByTaskId?.[hintKey];
      if (prior?.tabId != null && prior.tabId !== tab.id && prior.tabId !== previousId) throw new Error('TAB_BINDING_ALREADY_EXISTS');
      state.tabHintsByTaskId[hintKey] = {
        sessionId, kind, tabId: tab.id, normalizedUrl: targetUrl,
        ownedByExtension: true, opening: true, retirePending: false, boundAt: Date.now(),
        boundSendCount: Number(session.successfulSendCount || 0),
      };
      appendDiagnostic(state, { event: 'ВЛАСНУ_ВКЛАДКУ_ЗАПИСАНО_ДО_НАВІГАЦІЇ', sessionId,
        taskId: owner.taskId || hintKey, tabId: tab.id, target: targetUrl,
        message: 'owned=true; вкладка має durable власника перед переходом на ChatGPT.' });
      if (Number.isInteger(tab.windowId)) {
        session.tabWindowId = tab.windowId;
        if (session.scenarioWork && !Number.isInteger(session.scenarioWork.preferredWindowId)) session.scenarioWork.preferredWindowId = tab.windowId;
      }
      return state;
    });
  } catch (error) {
    // A lost persistence acknowledgement may have written the binding. Retain
    // that evidence; otherwise remove only this positively owned blank page.
    const current = await repository.load().catch(() => null);
    if (current && current.tabHintsByTaskId?.[hintKey]?.tabId !== tab.id) {
      try { await chromeApi.tabs.remove(tab.id); } catch { /* marker survives for recovery */ }
    }
    throw error;
  }
  return chromeApi.tabs.update(tab.id, { url: targetUrl, active: false });
}

export async function reconcileOwnedPlaceholders(repository, chromeApi) {
  if (!chromeApi.tabs?.query || !chromeApi.tabs?.remove) return;
  return withTabLifecycle(repository, async () => {
    const state = await repository.load();
    const tabs = await chromeApi.tabs.query({});
    for (const tab of tabs || []) {
      if (!String(tab.url || '').startsWith(PLACEHOLDER_PREFIX)) continue;
      const hint = Object.values(state.tabHintsByTaskId || {}).find(item => item.tabId === tab.id && item.ownedByExtension === true);
      if (!hint) await chromeApi.tabs.remove(tab.id);
      // Recorded placeholders are resumed by the owning bind, not by startup:
      // a stopped session must never be navigated or sent on startup.
    }
  });
}

export async function reconcileCompletedOpenCloseTabs(repository) {
  return repository.update(state => {
    for (const [key, hint] of Object.entries(state.tabHintsByTaskId || {})) {
      const session = state.sessionsById?.[hint.sessionId];
      if (session?.tabStrategy !== TabStrategy.OPEN_CLOSE_PER_TASK || hint.ownedByExtension === false) continue;
      const task = session.tasksById?.[key];
      if (session.operation?.taskId !== key || session.operation.phase !== 'SENT_VERIFIED'
          || !task?.lastVerifiedSendAt) continue;
      if (hint.boundSendCount != null
          ? Number(session.successfulSendCount || 0) <= hint.boundSendCount
          : Number(hint.boundAt || 0) > task.lastVerifiedSendAt) continue;
      hint.ownedByExtension = true;
      hint.retirePending = true;
    }
    return state;
  });
}
