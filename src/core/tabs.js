import { normalizeChatUrl } from './schema.js';

export async function resolveTaskTab(chromeApi, state, sessionId, task) {
  const hint = state.tabHintsByTaskId[task.id];
  if (hint?.tabId != null) {
    try {
      const tab = await chromeApi.tabs.get(hint.tabId);
      if (tab?.url && normalizeChatUrl(tab.url) === task.normalizedUrl) return tab;
    } catch {}
    delete state.tabHintsByTaskId[task.id];
  }
  const tabs = await chromeApi.tabs.query({ url: 'https://chatgpt.com/*' });
  const match = tabs.find(t => {
    try { return t.url && normalizeChatUrl(t.url) === task.normalizedUrl; } catch { return false; }
  });
  const tab = match || await chromeApi.tabs.create({ url: task.normalizedUrl, active: false });
  state.tabHintsByTaskId[task.id] = { tabId: tab.id, sessionId, normalizedUrl: task.normalizedUrl, boundAt: Date.now() };
  return tab;
}
