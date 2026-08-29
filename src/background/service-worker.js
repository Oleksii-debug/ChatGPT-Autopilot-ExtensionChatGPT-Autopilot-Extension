import { StorageRepository } from '../core/storage.js';
import { reconcileAlarm, reconcileStateForStartup } from '../core/recovery.js';
const repo = new StorageRepository(chrome);
export async function reconcileRuntime() {
  const state = await repo.update(draft => reconcileStateForStartup(draft));
  await reconcileAlarm(chrome, state);
  return state;
}
chrome.runtime.onInstalled.addListener(() => { void reconcileRuntime(); });
chrome.runtime.onStartup.addListener(() => { void reconcileRuntime(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'autopilot-core-wake') void reconcileRuntime(); });
