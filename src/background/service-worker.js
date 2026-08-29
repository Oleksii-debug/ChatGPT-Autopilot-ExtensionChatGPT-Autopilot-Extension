import { StorageRepository } from '../core/storage.js';
import { reconcileAlarm, reconcileStateForStartup } from '../core/recovery.js';
import { CoreCommandDispatcher } from '../core/commands.js';

const repo = new StorageRepository(chrome);
const dispatcher = new CoreCommandDispatcher(repo);

export async function reconcileRuntime() {
  const state = await repo.update(draft => reconcileStateForStartup(draft));
  await reconcileAlarm(chrome, state);
  return state;
}

export async function dispatchUiMessage(message) {
  if (message?.channel !== 'autopilot-ui' || typeof message.command !== 'string') return null;
  return dispatcher.execute(message.command, message.payload || {});
}

chrome.runtime.onInstalled.addListener(() => { void reconcileRuntime(); });
chrome.runtime.onStartup.addListener(() => { void reconcileRuntime(); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'autopilot-core-wake') void reconcileRuntime();
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.channel !== 'autopilot-ui') return false;
  dispatchUiMessage(message)
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => sendResponse({ ok: false, error: { message: error?.message || 'Core command failed' } }));
  return true;
});
