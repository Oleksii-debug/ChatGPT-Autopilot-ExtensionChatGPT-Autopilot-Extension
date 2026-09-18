import { normalizeChatUrl, TabStrategy } from './schema.js';
import { getPromptCadenceConfig } from './prompt-cadence.js';
import { isSessionFunctionEnabled, SessionFunctionId } from './session-functions.js';

const workerHintKey = sessionId => `__session_worker__:${sessionId}`;
const chatFlowHintKey = sessionId => `__chat_flow__:${sessionId}`;
const DEFAULT_TAB_READY_TIMEOUT_MS = 30000;
const DEFAULT_TAB_READY_POLL_MS = 100;
const CHAT_FLOW_ROOT_URL = 'https://chatgpt.com/';

export class TabReadinessError extends Error {
  constructor(safeDiagnosticCode, message, cause = null) { super(message); this.name = 'TabReadinessError'; this.safeDiagnosticCode = safeDiagnosticCode; if (cause) this.cause = cause; }
}
function normalizedTabUrl(tab) { try { return tab?.url ? normalizeChatUrl(tab.url) : null; } catch { return null; } }
function waitMs(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
export async function waitForTaskTabReady(chromeApi, tabId, expectedUrl, { timeoutMs = DEFAULT_TAB_READY_TIMEOUT_MS, pollIntervalMs = DEFAULT_TAB_READY_POLL_MS, now = () => Date.now(), wait = waitMs } = {}) {
  if (!chromeApi?.tabs?.get) throw new TabReadinessError('TAB_READINESS_API_UNAVAILABLE', 'Chrome tab readiness API is unavailable before CHECK_ONLY');
  let normalizedExpected; try { normalizedExpected = normalizeChatUrl(expectedUrl); } catch (error) { throw new TabReadinessError('TAB_EXPECTED_URL_INVALID', 'Selected task has an invalid ChatGPT URL before CHECK_ONLY', error); }
  const deadline = now() + Math.max(0, timeoutMs);
  while (true) {
    let lastTab; try { lastTab = await chromeApi.tabs.get(tabId); } catch (error) { throw new TabReadinessError('TAB_UNAVAILABLE_DURING_READINESS_CHECK', 'Selected ChatGPT tab became unavailable before CHECK_ONLY', error); }
    const observedUrl = normalizedTabUrl(lastTab); const documentReady = lastTab.status === 'complete' || lastTab.status == null;
    if (documentReady && observedUrl === normalizedExpected) return lastTab;
    if (now() >= deadline) { const code = documentReady && observedUrl && observedUrl !== normalizedExpected ? 'TAB_NAVIGATION_URL_MISMATCH' : 'TAB_NAVIGATION_TIMEOUT'; throw new TabReadinessError(code, code === 'TAB_NAVIGATION_URL_MISMATCH' ? 'Selected ChatGPT tab completed at a different URL before CHECK_ONLY' : 'Selected ChatGPT tab did not finish navigation before CHECK_ONLY'); }
    await wait(Math.max(1, Math.min(pollIntervalMs, deadline - now())));
  }
}
function hintHasExpectedOwnership(hint, { sessionId, kind, normalizedUrl = null }) {
  if (!hint || hint.tabId == null) return false;
  if (kind === 'SESSION_WORKER') return hint.sessionId === sessionId && hint.kind === 'SESSION_WORKER' && Boolean(hint.normalizedUrl);
  if (kind === 'CHAT_FLOW') return hint.sessionId === sessionId && hint.kind === 'CHAT_FLOW';
  if (hint.sessionId != null && hint.sessionId !== sessionId) return false;
  if (hint.kind != null && hint.kind !== 'TASK') return false;
  const identityUrl = hint.normalizedUrl || normalizedUrl; return Boolean(identityUrl) && (!normalizedUrl || identityUrl === normalizedUrl);
}
async function getValidHintedTab(chromeApi, hint, expected) { if (!hintHasExpectedOwnership(hint, expected)) return null; try { return await chromeApi.tabs.get(hint.tabId); } catch { return null; } }
function hintStillRepresentsCurrentOwnership(state, hintKey, hint) {
  if (!hint?.sessionId) return false; const owner = state.sessionsById?.[hint.sessionId]; if (!owner) return false;
  if (hint.kind === 'SESSION_WORKER') return owner.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION && hintKey === workerHintKey(owner.id);
  if (hint.kind === 'CHAT_FLOW') return owner.tabStrategy !== TabStrategy.ONE_WORKER_TAB_PER_SESSION && isSessionFunctionEnabled(owner.activeFunctions, SessionFunctionId.PROMPT_CADENCE);
  if (hint.kind != null && hint.kind !== 'TASK') return false; if (owner.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION) return false;
  const task = owner.tasksById?.[hintKey]; return Boolean(task && hint.normalizedUrl && hint.normalizedUrl === task.normalizedUrl);
}
function claimedTabIdsByOtherSessions(state, sessionId) { const claimed = new Set(); for (const [hintKey, hint] of Object.entries(state.tabHintsByTaskId || {})) if (hint?.tabId != null && hint.sessionId !== sessionId && hintStillRepresentsCurrentOwnership(state, hintKey, hint)) claimed.add(hint.tabId); return claimed; }
async function findMatchingChatTab(chromeApi, normalizedUrl, excludedTabIds = new Set()) { const tabs = await chromeApi.tabs.query({ url: 'https://chatgpt.com/*' }); return tabs.find(tab => !excludedTabIds.has(tab.id) && normalizedTabUrl(tab) === normalizedUrl) || null; }
function chatFlowVerifiedCount(session) { return Number.isInteger(session.cadenceVerifiedSendCount) && session.cadenceVerifiedSendCount >= 0 ? session.cadenceVerifiedSendCount : 0; }
function chatFlowNeedsNewChat(session, config, sessionHint = null) { const count = chatFlowVerifiedCount(session); let boundaryReached = false; if (config.chatFlow.mode === 'new-chat-after') boundaryReached = count > 0 && count % config.chatFlow.newChatEveryN === 0; else if (config.chatFlow.mode === 'staged') boundaryReached = count === 1 + config.chatFlow.continueCount; return boundaryReached && sessionHint?.rotatedAtCount !== count; }
function priorRotatedAtCount(sessionHint, taskHint) { if (Number.isInteger(sessionHint?.rotatedAtCount)) return sessionHint.rotatedAtCount; if (Number.isInteger(taskHint?.rotatedAtCount)) return taskHint.rotatedAtCount; return 0; }
async function bindChatFlowTaskTab(chromeApi, state, sessionId, task, session) {
  const config = getPromptCadenceConfig(state, sessionId); const key = task.id; const hint = state.tabHintsByTaskId[key]; const sessionHint = state.tabHintsByTaskId[chatFlowHintKey(sessionId)]; const shouldCreateNew = chatFlowNeedsNewChat(session, config, sessionHint);
  if (!shouldCreateNew) { const hinted = await getValidHintedTab(chromeApi, hint, { sessionId, kind: 'CHAT_FLOW' }) || await getValidHintedTab(chromeApi, sessionHint, { sessionId, kind: 'CHAT_FLOW' }); if (hinted) { const currentUrl = normalizedTabUrl(hinted) || CHAT_FLOW_ROOT_URL; task.url = currentUrl; task.normalizedUrl = currentUrl; const sharedHint = { tabId: hinted.id, sessionId, normalizedUrl: currentUrl, kind: 'CHAT_FLOW', rotatedAtCount: priorRotatedAtCount(sessionHint, hint), boundAt: Date.now() }; state.tabHintsByTaskId[chatFlowHintKey(sessionId)] = { ...sharedHint }; state.tabHintsByTaskId[key] = { ...sharedHint }; return hinted; } }
  let tab = null; const rotationHint = sessionHint || hint;
  if (rotationHint?.tabId != null) { try { tab = shouldCreateNew ? await chromeApi.tabs.update(rotationHint.tabId, { url: CHAT_FLOW_ROOT_URL, active: false }) : await chromeApi.tabs.get(rotationHint.tabId); } catch { tab = null; } }
  if (!tab) { const initialUrl = shouldCreateNew ? CHAT_FLOW_ROOT_URL : (sessionHint?.normalizedUrl || task.normalizedUrl || task.url); const excluded = claimedTabIdsByOtherSessions(state, sessionId); tab = await findMatchingChatTab(chromeApi, initialUrl, excluded) || await chromeApi.tabs.create({ url: initialUrl, active: false }); }
  const currentUrl = normalizedTabUrl(tab) || CHAT_FLOW_ROOT_URL; task.url = currentUrl; task.normalizedUrl = currentUrl; const rotatedAtCount = shouldCreateNew ? chatFlowVerifiedCount(session) : priorRotatedAtCount(sessionHint, hint); const sharedHint = { tabId: tab.id, sessionId, normalizedUrl: currentUrl, kind: 'CHAT_FLOW', rotatedAtCount, boundAt: Date.now() }; state.tabHintsByTaskId[chatFlowHintKey(sessionId)] = { ...sharedHint }; state.tabHintsByTaskId[key] = { ...sharedHint }; return tab;
}
async function resolveWorkerTab(chromeApi, state, sessionId, task) {
  const key = workerHintKey(sessionId); const hint = state.tabHintsByTaskId[key]; const hintedTab = await getValidHintedTab(chromeApi, hint, { sessionId, kind: 'SESSION_WORKER' });
  if (hintedTab) { const currentUrl = normalizedTabUrl(hintedTab); if (currentUrl === task.normalizedUrl) return hintedTab; if (currentUrl === hint.normalizedUrl) { try { const navigated = await chromeApi.tabs.update(hintedTab.id, { url: task.normalizedUrl, active: false }); state.tabHintsByTaskId[key] = { tabId: navigated.id, sessionId, normalizedUrl: task.normalizedUrl, kind: 'SESSION_WORKER', boundAt: Date.now() }; return navigated; } catch {} } }
  delete state.tabHintsByTaskId[key]; const excluded = claimedTabIdsByOtherSessions(state, sessionId); const tab = await findMatchingChatTab(chromeApi, task.normalizedUrl, excluded) || await chromeApi.tabs.create({ url: task.normalizedUrl, active: false }); state.tabHintsByTaskId[key] = { tabId: tab.id, sessionId, normalizedUrl: task.normalizedUrl, kind: 'SESSION_WORKER', boundAt: Date.now() }; return tab;
}
export async function resolveTaskTab(chromeApi, state, sessionId, task) {
  const session = state.sessionsById?.[sessionId]; const cadenceActive = session && isSessionFunctionEnabled(session.activeFunctions, SessionFunctionId.PROMPT_CADENCE); const chatFlow = cadenceActive ? getPromptCadenceConfig(state, sessionId).chatFlow : { enabled: false };
  if (session && chatFlow.enabled === true && ['same-chat', 'new-chat-after', 'staged'].includes(chatFlow.mode)) return bindChatFlowTaskTab(chromeApi, state, sessionId, task, session);
  if (session?.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION) return resolveWorkerTab(chromeApi, state, sessionId, task);
  const hint = state.tabHintsByTaskId[task.id]; if (hint?.tabId != null) { const tab = await getValidHintedTab(chromeApi, hint, { sessionId, kind: 'TASK', normalizedUrl: task.normalizedUrl }); if (tab) return tab; delete state.tabHintsByTaskId[task.id]; }
  const excluded = claimedTabIdsByOtherSessions(state, sessionId); const tab = await findMatchingChatTab(chromeApi, task.normalizedUrl, excluded) || await chromeApi.tabs.create({ url: task.normalizedUrl, active: false }); state.tabHintsByTaskId[task.id] = { tabId: tab.id, sessionId, normalizedUrl: task.normalizedUrl, kind: 'TASK', boundAt: Date.now() }; return tab;
}
