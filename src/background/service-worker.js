import { StorageRepository } from '../core/storage.js';
import { reconcileAlarm, reconcileStateForStartup } from '../core/recovery.js';
import { CoreCommandDispatcher } from '../core/commands.js';

const repo = new StorageRepository(chrome);
const dispatcher = new CoreCommandDispatcher(repo);
const runSafely = (operation) => {
  void operation.catch(() => console.error('ChatGPT Autopilot operation failed safely.'));
};

export async function reconcileRuntime({ startup = false } = {}) {
  const state = startup
    ? await repo.update(draft => reconcileStateForStartup(draft))
    : await repo.load();
  await reconcileAlarm(chrome, state);
  return state;
}

export async function dispatchUiMessage(message) {
  if (message?.channel !== 'autopilot-ui' || typeof message.command !== 'string') return null;
  const result = await dispatcher.execute(message.command, message.payload || {});
  await reconcileRuntime();
  return result;
}

chrome.runtime.onInstalled.addListener(() => { runSafely(reconcileRuntime({ startup: true })); });
chrome.runtime.onStartup.addListener(() => { runSafely(reconcileRuntime({ startup: true })); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'autopilot-core-wake') runSafely(reconcileRuntime());
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.channel !== 'autopilot-ui') return false;
  dispatchUiMessage(message)
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => sendResponse({ ok: false, error: { message: error?.message || 'Core command failed' } }));
  return true;
});
chrome.action?.onClicked.addListener(() => { runSafely(chrome.runtime.openOptionsPage()); });

runSafely(reconcileRuntime({ startup: true }));
