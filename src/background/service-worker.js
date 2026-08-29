import { StorageRepository } from '../core/storage.js';
import { CoreCommandDispatcher } from '../core/commands.js';
import { AutomaticSessionExecutor } from '../core/automatic-executor.js';
import { ChromeInteractionTransport } from '../core/interaction-transport.js';
import { runRuntimeCycle } from '../core/runtime-execution.js';

const EXECUTION_AVAILABLE = false;
const repo = new StorageRepository(chrome);
const transport = new ChromeInteractionTransport(chrome);
const executor = new AutomaticSessionExecutor(repo, chrome, transport);
const dispatcher = new CoreCommandDispatcher(repo, undefined, { executionAvailable: EXECUTION_AVAILABLE });
const runSafely = (operation) => {
  void operation.catch(() => console.error('ChatGPT Autopilot operation failed safely.'));
};

export async function runExecutionCycle({ startup = false } = {}) {
  return runRuntimeCycle({
    repository: repo,
    chromeApi: chrome,
    executor,
    startup,
    executionAvailable: EXECUTION_AVAILABLE,
  });
}

export async function reconcileRuntime() {
  const cycle = await runRuntimeCycle({
    repository: repo,
    chromeApi: chrome,
    executor,
    startup: false,
    executionAvailable: false,
  });
  return cycle.state;
}

export async function dispatchUiMessage(message) {
  if (message?.channel !== 'autopilot-ui' || typeof message.command !== 'string') return null;
  const result = await dispatcher.execute(message.command, message.payload || {});
  await reconcileRuntime();
  return result;
}

chrome.runtime.onInstalled.addListener(() => { runSafely(runExecutionCycle({ startup: true })); });
chrome.runtime.onStartup.addListener(() => { runSafely(runExecutionCycle({ startup: true })); });
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

runSafely(runExecutionCycle({ startup: true }));
