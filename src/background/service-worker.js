import { StorageRepository } from '../core/storage.js';
import { CoreCommandDispatcher } from '../core/commands.js';
import { AutomaticSessionExecutor } from '../core/automatic-executor.js';
import { ChromeInteractionTransport } from '../core/interaction-transport.js';
import { reconcileRuntimeColdStart, runRuntimeCycle } from '../core/runtime-execution.js';
import { applyBundledBootstrapProfile } from '../core/bootstrap.js';
import { BUNDLED_BOOTSTRAP_PROFILE } from '../config/bootstrap-profile.js';
import { CadencedRepository, getPromptCadenceConfig, setPromptCadenceConfig } from '../core/prompt-cadence.js';
import { getDriveAccessToken, inspectDriveOAuthConfig } from '../core/drive-auth.js';
import { extractDriveFileId, listAuthorizedDriveFiles, readAuthorizedDriveSnapshot } from '../core/drive-api.js';
import { acceptDriveSnapshot, getDriveSourceConfig, setDriveSourceConfig } from '../core/drive-source.js';
import { batchChatFlowSnapshot, configureBatchChatFlow, startBatchChatFlow } from '../core/batch-chat-flow-service.js';

const EXECUTION_AVAILABLE = true;
const READ_ONLY_UI_COMMANDS = new Set([
  'LIST_SESSIONS', 'GET_SESSION', 'GET_SNAPSHOT', 'PREVIEW_PORTABLE_PROFILE', 'EXPORT_PORTABLE_PROFILE',
  'GET_PROMPT_CADENCE', 'GET_DRIVE_AUTH_STATUS', 'GET_DRIVE_SOURCE', 'LIST_DRIVE_FILES', 'GET_BATCH_CHAT_FLOW',
]);
const repo = new StorageRepository(chrome);
const executorRepo = new CadencedRepository(repo);
const transport = new ChromeInteractionTransport(chrome);
const executor = new AutomaticSessionExecutor(executorRepo, chrome, transport);
const dispatcher = new CoreCommandDispatcher(repo, undefined, { executionAvailable: EXECUTION_AVAILABLE });
const runSafely = operation => { void operation.catch(() => console.error('ChatGPT Autopilot operation failed safely.')); };

async function notifyStatusChanged(state) {
  if (!chrome.runtime?.sendMessage) return;
  for (const sessionId of Object.keys(state?.sessionsById || {})) {
    try {
      await chrome.runtime.sendMessage({ channel: 'autopilot-core', type: 'STATUS_CHANGED', sessionId });
    } catch { /* UI may be closed. */ }
  }
}

let bootstrapBarrier = null;
function ensureBundledBootstrapApplied() {
  if (bootstrapBarrier) return bootstrapBarrier;
  bootstrapBarrier = applyBundledBootstrapProfile({ repository: repo, chromeApi: chrome, profile: BUNDLED_BOOTSTRAP_PROFILE })
    .catch(error => {
      bootstrapBarrier = null;
      console.error('ChatGPT Autopilot bundled bootstrap failed safely.');
      throw error;
    });
  return bootstrapBarrier;
}

let coldStartReconciled = false;
let coldStartBarrier = null;
function beginColdStartReconciliation() {
  if (coldStartReconciled) return Promise.resolve();
  if (coldStartBarrier) return coldStartBarrier;
  coldStartBarrier = (async () => {
    await ensureBundledBootstrapApplied();
    await reconcileRuntimeColdStart({ repository: repo, chromeApi: chrome, executionAvailable: EXECUTION_AVAILABLE });
    coldStartReconciled = true;
    coldStartBarrier = null;
  })().catch(error => {
    coldStartBarrier = null;
    console.error('ChatGPT Autopilot cold-start reconciliation failed safely.');
    throw error;
  });
  return coldStartBarrier;
}
void beginColdStartReconciliation().catch(() => undefined);
async function ensureColdStartReconciled() {
  if (!coldStartReconciled) await beginColdStartReconciliation();
}

let executionCycleInFlight = null;
export function runExecutionCycle() {
  if (executionCycleInFlight) return executionCycleInFlight;
  const cycle = (async () => {
    await ensureColdStartReconciled();
    const result = await runRuntimeCycle({ repository: repo, chromeApi: chrome, executor, startup: false, executionAvailable: EXECUTION_AVAILABLE });
    await notifyStatusChanged(result.state);
    return result;
  })();
  executionCycleInFlight = cycle.then(
    result => { executionCycleInFlight = null; return result; },
    error => { executionCycleInFlight = null; throw error; },
  );
  return executionCycleInFlight;
}

export async function reconcileRuntime() {
  await ensureColdStartReconciled();
  const cycle = await runRuntimeCycle({ repository: repo, chromeApi: chrome, executor, startup: false, executionAvailable: false });
  await notifyStatusChanged(cycle.state);
  return cycle.state;
}

async function dispatchPromptCadenceCommand(command, payload) {
  if (command === 'GET_PROMPT_CADENCE') {
    const state = await repo.load();
    const session = state.sessionsById[payload.sessionId];
    if (!session) throw new Error('Session not found');
    return { config: getPromptCadenceConfig(state, payload.sessionId), verifiedSendCount: Number.isInteger(session.cadenceVerifiedSendCount) ? session.cadenceVerifiedSendCount : 0 };
  }
  if (command === 'SET_PROMPT_CADENCE') {
    let config;
    const state = await repo.update(draft => {
      config = setPromptCadenceConfig(draft, payload.sessionId, payload.config || {});
      return draft;
    });
    return { config, verifiedSendCount: Number.isInteger(state.sessionsById[payload.sessionId]?.cadenceVerifiedSendCount) ? state.sessionsById[payload.sessionId].cadenceVerifiedSendCount : 0 };
  }
  return null;
}

async function dispatchBatchCommand(command, payload) {
  if (command === 'GET_BATCH_CHAT_FLOW') {
    const state = await repo.load();
    return batchChatFlowSnapshot(state, payload.sessionId);
  }
  if (command === 'SET_BATCH_CHAT_FLOW') {
    let session;
    const state = await repo.update(draft => {
      session = configureBatchChatFlow(draft, payload.sessionId, payload.config || {}, Date.now());
      return draft;
    });
    return batchChatFlowSnapshot(state, payload.sessionId);
  }
  if (command === 'START_BATCH_CHAT_FLOW') {
    let session;
    const state = await repo.update(draft => {
      session = startBatchChatFlow(draft, payload.sessionId, Date.now());
      return draft;
    });
    return { ...batchChatFlowSnapshot(state, payload.sessionId), sessionId: session.id };
  }
  return null;
}

async function dispatchDriveCommand(command, payload) {
  if (command === 'GET_DRIVE_AUTH_STATUS') return { ...inspectDriveOAuthConfig(chrome.runtime.getManifest()), scope: 'https://www.googleapis.com/auth/drive.file' };
  if (command === 'GET_DRIVE_SOURCE') {
    const state = await repo.load();
    return { source: getDriveSourceConfig(state, payload.sessionId) };
  }
  if (command === 'SET_DRIVE_SOURCE') {
    let source;
    const state = await repo.update(draft => {
      const parsed = extractDriveFileId(payload.sourceUrl);
      source = setDriveSourceConfig(draft, payload.sessionId, { fileId: parsed.fileId, sourceUrl: payload.sourceUrl, target: payload.target });
      return draft;
    });
    return { source, session: state.sessionsById[payload.sessionId] };
  }
  if (command === 'LIST_DRIVE_FILES') {
    const token = await getDriveAccessToken(chrome, { interactive: true });
    return { files: await listAuthorizedDriveFiles({ accessToken: token }) };
  }
  if (command === 'SYNC_DRIVE_SOURCE') {
    const before = await repo.load();
    const source = getDriveSourceConfig(before, payload.sessionId);
    if (!source.fileId) throw new Error('Спочатку прив’яжіть файл Google Drive до Session.');
    const token = await getDriveAccessToken(chrome, { interactive: true });
    const snapshot = await readAuthorizedDriveSnapshot({ fileId: source.fileId, accessToken: token });
    let acceptance;
    const state = await repo.update(draft => {
      acceptance = acceptDriveSnapshot(draft, payload.sessionId, snapshot);
      return draft;
    });
    return { acceptance, source: getDriveSourceConfig(state, payload.sessionId) };
  }
  return null;
}

export async function dispatchUiMessage(message) {
  if (message?.channel !== 'autopilot-ui' || typeof message.command !== 'string') return null;
  await ensureColdStartReconciled();
  const specialPrompt = await dispatchPromptCadenceCommand(message.command, message.payload || {});
  const specialBatch = specialPrompt === null ? await dispatchBatchCommand(message.command, message.payload || {}) : null;
  const specialDrive = specialPrompt === null && specialBatch === null ? await dispatchDriveCommand(message.command, message.payload || {}) : null;
  const result = specialPrompt !== null ? specialPrompt : specialBatch !== null ? specialBatch : specialDrive !== null ? specialDrive : await dispatcher.execute(message.command, message.payload || {});
  if (!READ_ONLY_UI_COMMANDS.has(message.command)) await reconcileRuntime();
  return result;
}

chrome.runtime.onInstalled.addListener(() => {
  runSafely(runExecutionCycle());
});
chrome.runtime.onStartup.addListener(() => {
  runSafely(runExecutionCycle());
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'autopilot-core-wake') runSafely(runExecutionCycle());
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.channel !== 'autopilot-ui') return false;
  dispatchUiMessage(message)
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => sendResponse({ ok: false, error: { message: error?.message || 'Core command failed' } }));
  return true;
});
chrome.action?.onClicked.addListener(() => {
  runSafely(chrome.runtime.openOptionsPage());
});
