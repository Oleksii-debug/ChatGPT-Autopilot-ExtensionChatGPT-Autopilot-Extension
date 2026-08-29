import { StorageRepository } from '../core/storage.js';
import { CoreCommandDispatcher } from '../core/commands.js';
import { AutomaticSessionExecutor } from '../core/automatic-executor.js';
import { ChromeInteractionTransport } from '../core/interaction-transport.js';
import { reconcileRuntimeColdStart, runRuntimeCycle } from '../core/runtime-execution.js';

const EXECUTION_AVAILABLE = false;
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

let coldStartReconciled = false;
let coldStartBarrier = null;
function beginColdStartReconciliation() {
  if (coldStartReconciled) return Promise.resolve();
  if (coldStartBarrier) return coldStartBarrier;

  coldStartBarrier = reconcileRuntimeColdStart({
    repository: repo,
    chromeApi: chrome,
    executionAvailable: EXECUTION_AVAILABLE,
  }).then(
    () => {
      coldStartReconciled = true;
      coldStartBarrier = null;
    },
    error => {
      coldStartBarrier = null;
      console.error('ChatGPT Autopilot cold-start reconciliation failed safely.');
      throw error;
    },
  );
  return coldStartBarrier;
}

// Module evaluation may repair durable state and alarms, but never launches an
// executor cycle. A transient reconciliation failure is swallowed here so the
// event that woke this worker (or a later event) can retry through the same
// single-flight barrier instead of inheriting a permanently poisoned worker.
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
