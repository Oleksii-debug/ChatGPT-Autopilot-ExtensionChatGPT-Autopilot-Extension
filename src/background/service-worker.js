import { StorageRepository } from '../core/storage.js';
import { CoreCommandDispatcher } from '../core/commands.js';
import { AutomaticSessionExecutor } from '../core/automatic-executor.js';
import { ChromeInteractionTransport } from '../core/interaction-transport.js';
import { reconcileRuntimeColdStart, runRuntimeCycle } from '../core/runtime-execution.js';
import { applyBundledBootstrapProfile } from '../core/bootstrap.js';
import { BUNDLED_BOOTSTRAP_PROFILE } from '../config/bootstrap-profile.js';

const EXECUTION_AVAILABLE = true;
const READ_ONLY_UI_COMMANDS = new Set([
  'LIST_SESSIONS',
  'GET_SESSION',
  'GET_SNAPSHOT',
  'PREVIEW_PORTABLE_PROFILE',
  'EXPORT_PORTABLE_PROFILE',
]);
const repo = new StorageRepository(chrome);
const transport = new ChromeInteractionTransport(chrome);
const executor = new AutomaticSessionExecutor(repo, chrome, transport);
const dispatcher = new CoreCommandDispatcher(repo, undefined, { executionAvailable: EXECUTION_AVAILABLE });
const runSafely = (operation) => {
  void operation.catch(() => console.error('ChatGPT Autopilot operation failed safely.'));
};

async function notifyStatusChanged(state) {
  if (!chrome.runtime?.sendMessage) return;
  for (const sessionId of Object.keys(state?.sessionsById || {})) {
    try {
      await chrome.runtime.sendMessage({
        channel: 'autopilot-core',
        type: 'STATUS_CHANGED',
        sessionId,
      });
    } catch {
      // The options page is normally closed. Lack of a UI receiver must never fail a runtime cycle.
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
  // Read-only status/configuration queries must not create a STATUS_CHANGED
  // feedback loop with the options page. Only state-changing UI commands need
  // alarm reconciliation and a status broadcast.
  if (!READ_ONLY_UI_COMMANDS.has(message.command)) await reconcileRuntime();
  return result;
}

chrome.runtime.onInstalled.addListener(() => { runSafely(runExecutionCycle()); });
chrome.runtime.onStartup.addListener(() => { runSafely(runExecutionCycle()); });
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
chrome.action?.onClicked.addListener(() => { runSafely(chrome.runtime.openOptionsPage()); });
