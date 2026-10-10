// Serialize extension-owned focus changes within one Chrome window. Keep this
// separate from storage and tab lifecycle queues; observations may await a read.
const queuesByOwner = new WeakMap();

export function withWindowFocus(owner, windowId, action) {
  let queues = queuesByOwner.get(owner);
  if (!queues) { queues = new Map(); queuesByOwner.set(owner, queues); }
  const previous = queues.get(windowId) || Promise.resolve();
  const result = previous.catch(() => undefined).then(action);
  queues.set(windowId, result);
  return result.finally(() => {
    if (queues.get(windowId) === result) queues.delete(windowId);
    if (!queues.size) queuesByOwner.delete(owner);
  });
}

export function windowHasPendingSend(state, windowId) {
  return Object.values(state.sessionsById || {}).some(session => {
    const operation = session?.operation;
    if (!operation) return false;
    if (Number(operation.previousSendTabId || 0) > 0
        && operation.previousSendWindowId === windowId) return true;
    const boundWindow = session.scenarioWork?.managed === true
      ? session.scenarioWork.preferredWindowId : session.tabWindowId;
    return operation.phase === 'SUBMITTING' && boundWindow === windowId;
  });
}
