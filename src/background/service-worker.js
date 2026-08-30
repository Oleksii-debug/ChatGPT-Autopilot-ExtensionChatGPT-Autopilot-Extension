import { StorageRepository } from '../core/storage.js';
import { CoreCommandDispatcher } from '../core/commands.js';
import { AutomaticSessionExecutor } from '../core/automatic-executor.js';
import { ChromeInteractionTransport } from '../core/interaction-transport.js';
import { reconcileRuntimeColdStart, runRuntimeCycle } from '../core/runtime-execution.js';
import { applyBundledBootstrapProfile } from '../core/bootstrap.js';
import { BUNDLED_BOOTSTRAP_PROFILE } from '../config/bootstrap-profile.js';
import { importConfigurationDocument, exportConfigurationDocument } from '../core/configuration-file.js';

const EXECUTION_AVAILABLE = true;
const repo = new StorageRepository(chrome);
const transport = new ChromeInteractionTransport(chrome);
const executor = new AutomaticSessionExecutor(repo, chrome, transport);
const dispatcher = new CoreCommandDispatcher(repo, undefined, { executionAvailable: EXECUTION_AVAILABLE });
const runSafely = (operation) => {
  void operation.catch(() => console.error('ChatGPT Autopilot operation failed safely.'));
};

const lastUiStatusSignatureBySession = new Map();

function uiStatusSignature(state, sessionId) {
  const session = state?.sessionsById?.[sessionId];
  if (!session) return '';
  const tasks = session.taskOrder.map(taskId => session.tasksById[taskId]).filter(Boolean);
  const currentTask = tasks[session.currentTaskIndex] || null;
  const log = state.logs?.[sessionId] || [];
  const lastLog = log.at(-1) || null;
  return JSON.stringify([
    session.name,
    session.runState,
    session.currentTaskIndex,
    session.nextAllowedSendAt,
    session.lastSuccessfulSendAt,
    session.lastError,
    session.operation?.phase || 'NONE',
    currentTask?.status || 'IDLE',
    currentTask?.retryAfterAt || 0,
    currentTask?.manualReviewReason || '',
    tasks.filter(task => task.enabled).length,
    log.length,
    lastLog?.at || 0,
    lastLog?.message || '',
  ]);
}

async function notifyStatusChanged(state, { forceSessionIds = [] } = {}) {
  if (!chrome.runtime?.sendMessage) return;
  const liveSessionIds = new Set(Object.keys(state?.sessionsById || {}));
  for (const knownSessionId of lastUiStatusSignatureBySession.keys()) {
    if (!liveSessionIds.has(knownSessionId)) lastUiStatusSignatureBySession.delete(knownSessionId);
  }
  const forced = new Set(forceSessionIds);
  for (const sessionId of liveSessionIds) {
    const signature = uiStatusSignature(state, sessionId);
    if (!forced.has(sessionId) && lastUiStatusSignatureBySession.get(sessionId) === signature) continue;
    lastUiStatusSignatureBySession.set(sessionId, signature);
    try {
      await chrome.runtime.sendMessage({
        channel: 'autopilot-core',
        type: 'STATUS_CHANGED',
        sessionId,
      });
    } catch {
      // The options page is normally closed. Initial UI load reads canonical truth directly.
    }
  }
}

let bootstrapBarrier = null;
function ensureBundledBootstrapApplied() {
  if (bootstrapBarrier) return bootstrapBarrier;
  bootstrapBarrier = applyBundledBootstrapProfile({
    repository: repo,
    chromeApi: chrome,
    profile: BUNDLED_BOOTSTRAP_PROFILE,
  }).catch(error => {
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
    await reconcileRuntimeColdStart({
      repository: repo,
      chromeApi: chrome,
      executionAvailable: EXECUTION_AVAILABLE,
    });
    coldStartReconciled = true;
    coldStartBarrier = null;
  })().catch(error => {
    coldStartBarrier = null;
    console.error('ChatGPT Autopilot cold-start reconciliation failed safely.');
    throw error;
  });
  return coldStartBarrier;
}

// Module evaluation may install an explicitly bundled first-run profile and
// repair durable state/alarms, but never launches an executor cycle. A transient
// reconciliation failure is swallowed here so the event that woke this worker
// (or a later event) can retry through the same single-flight barrier.
void beginColdStartReconciliation().catch(() => undefined);

async function ensureColdStartReconciled() {
  if (coldStartReconciled) return;
  await beginColdStartReconciliation();
}

let executionCycleInFlight = null;
export function runExecutionCycle() {
  if (executionCycleInFlight) return executionCycleInFlight;

  const cycle = (async () => {
    await ensureColdStartReconciled();
    const result = await runRuntimeCycle({
      repository: repo,
      chromeApi: chrome,
      executor,
      startup: false,
      executionAvailable: EXECUTION_AVAILABLE,
    });
    await notifyStatusChanged(result.state);
    return result;
  })();

  executionCycleInFlight = cycle.then(
    result => {
      executionCycleInFlight = null;
      return result;
    },
    error => {
      executionCycleInFlight = null;
      throw error;
    },
  );
  return executionCycleInFlight;
}

export async function reconcileRuntime() {
  await ensureColdStartReconciled();
  const cycle = await runRuntimeCycle({
    repository: repo,
    chromeApi: chrome,
    executor,
    startup: false,
    executionAvailable: false,
  });
  await notifyStatusChanged(cycle.state);
  return cycle.state;
}

export async function dispatchUiMessage(message) {
  if (message?.channel !== 'autopilot-ui' || typeof message.command !== 'string') return null;
  await ensureColdStartReconciled();
  const result = await dispatcher.execute(message.command, message.payload || {});
  await reconcileRuntime();
  return result;
}

export async function dispatchConfigurationMessage(message) {
  if (message?.channel !== 'autopilot-config' || typeof message.type !== 'string') return null;
  await ensureColdStartReconciled();
  if (message.type === 'EXPORT_CONFIGURATION') {
    return { document: await exportConfigurationDocument({ repository: repo }) };
  }
  if (message.type === 'IMPORT_CONFIGURATION') {
    const result = await importConfigurationDocument({
      repository: repo,
      document: message.payload?.document,
    });
    if (result.sessionsAutoStarted > 0) {
      await runExecutionCycle();
    } else {
      const state = await repo.load();
      await notifyStatusChanged(state, { forceSessionIds: result.sessionIds });
    }
    return result;
  }
  throw new Error('Unsupported configuration-file command');
}

chrome.runtime.onInstalled.addListener(() => { runSafely(runExecutionCycle()); });
chrome.runtime.onStartup.addListener(() => { runSafely(runExecutionCycle()); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'autopilot-core-wake') runSafely(runExecutionCycle());
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.channel === 'autopilot-ui') {
    dispatchUiMessage(message)
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: { message: error?.message || 'Core command failed' } }));
    return true;
  }
  if (message?.channel === 'autopilot-config') {
    dispatchConfigurationMessage(message)
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: { message: error?.message || 'Configuration import failed' } }));
    return true;
  }
  return false;
});
chrome.action?.onClicked.addListener(() => { runSafely(chrome.runtime.openOptionsPage()); });
