import { StorageRepository } from '../core/storage.js';
import { CoreCommandDispatcher } from '../core/commands.js';
import { AutomaticSessionExecutor } from '../core/automatic-executor.js';
import { ChromeInteractionTransport } from '../core/interaction-transport.js';
import { InteractionProviderRouter } from '../core/interaction-provider-router.js';
import { AgentProviderId, getAgentProvider } from '../core/capability-registry.js';
import { reconcileRuntimeColdStart, runRuntimeCycle } from '../core/runtime-execution.js';
import { applyBundledBootstrapProfile } from '../core/bootstrap.js';
import { BUNDLED_BOOTSTRAP_PROFILE } from '../config/bootstrap-profile.js';
import { performNativeInput } from '../core/native-input.js';
import { LocalAiClient } from '../core/local-ai-provider.js';
import { AiGatewayClient } from '../core/ai-gateway-client.js';
import { AiOrchestrator } from '../core/ai-orchestrator.js';
import { AiAutonomyManager } from '../core/ai-manager.js';
import { RemoteDispatchController, REMOTE_DISPATCH_ALARM } from '../core/remote-dispatch-controller.js';
import { OrchestrationV2Manager } from '../core/orchestration-v2-manager.js';
import { ScenarioWorkManager } from '../core/scenario-work-manager.js';
import { BrowserAgentManager } from '../core/browser-agent-manager.js';
import { BROWSER_AGENT_ALARM } from '../core/browser-agent.js';
import { sameChatConversationUrl } from '../core/tabs.js';
import {
  DRIVE_SCALAR_PROVIDER_V1,
  DriveScalarProviderV1,
  createGoogleDriveScalarReader,
  getChromeDriveAccessToken,
  inspectChromeDriveOAuth,
} from '../core/orchestration-drive-scalar-provider.js';

const EXECUTION_AVAILABLE = true;
const READ_ONLY_UI_COMMANDS = new Set([
  'LIST_SESSIONS',
  'GET_SESSION',
  'GET_SNAPSHOT',
  'GET_DIAGNOSTIC_REPORT',
  'RECORD_DIAGNOSTIC_SNAPSHOT',
  'PREVIEW_PORTABLE_PROFILE',
  'EXPORT_PORTABLE_PROFILE',
  'GET_LOCAL_AI_SETTINGS',
  'TEST_LOCAL_AI_CONNECTION',
  'RUN_LOCAL_AI_PROMPT',
  'GET_AI_ROUTER_SETTINGS',
  'TEST_AI_GATEWAY',
  'LIST_AI_ROUTER_MODELS',
  'GET_AI_MANAGER_SETTINGS',
  'GET_REMOTE_DISPATCH_STATUS',
  'TEST_REMOTE_DISPATCH_FEED',
  'GET_ORCHESTRATION_V2_STATUS',
  'LIST_ORCHESTRATION_V2_ORCHESTRAS',
  'PREVIEW_ORCHESTRATION_V2_PROFILE',
  'EXPORT_ORCHESTRATION_V2_PROFILE',
  'LIST_SCENARIO_WORK',
  'GET_SCENARIO_WORK',
  'LIST_BROWSER_AGENT_JOBS',
  'GET_BROWSER_AGENT_JOB',
]);
const repo = new StorageRepository(chrome);
const chatgptProvider = getAgentProvider(AgentProviderId.CHATGPT_BROWSER);
const chatgptTransport = new ChromeInteractionTransport(chrome, { siteAdapterId: chatgptProvider.siteAdapterId });
const transport = new InteractionProviderRouter().register(AgentProviderId.CHATGPT_BROWSER, chatgptTransport);
const executor = new AutomaticSessionExecutor(repo, chrome, transport);
const localAiClient = new LocalAiClient({ fetchFn: (...args) => fetch(...args) });
const aiGatewayClient = new AiGatewayClient({ fetchFn: (...args) => fetch(...args) });
const aiOrchestrator = new AiOrchestrator({ gatewayClient: aiGatewayClient });
const remoteDispatch = new RemoteDispatchController({ coreRepository: repo, chromeApi: chrome, fetchFn: (...args) => fetch(...args) });

const orchestrationV2 = new OrchestrationV2Manager({
  coreRepository: repo,
  chromeApi: chrome,
  fetchFn: (...args) => fetch(...args),
  collectAssistantReport: probeAssistantConversation,
  resolveHierarchyProvider: resolveOrchestrationHierarchyProvider,
});
const scenarioWork = new ScenarioWorkManager({
  coreRepository: repo,
  chromeApi: chrome,
  collectAssistantReport: probeAssistantConversation,
});
const AI_REPORT_ALARM = 'autopilot-ai-report-wake';
const AI_MANAGER_ALARM = 'autopilot-ai-manager-wake';

async function resolveOrchestrationHierarchyProvider({ binding } = {}) {
  if (binding?.providerId !== DRIVE_SCALAR_PROVIDER_V1) return null;
  if (!binding.sourceId) return null;
  const reader = createGoogleDriveScalarReader({
    fileId: binding.sourceId,
    getAccessToken: () => getChromeDriveAccessToken(chrome, { interactive: false }),
    fetchFn: (...args) => fetch(...args),
  });
  return new DriveScalarProviderV1({
    readMetadata: reader.readMetadata,
    readContent: reader.readContent,
  });
}

async function probeAssistantConversation(job) {
  const conversationUrl = String(job?.conversationUrl || '').trim();
  if (!conversationUrl) throw new Error('Assistant report probe requires conversationUrl');
  let tabId = null;
  let temporaryTab = false;
  try {
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    const existing = (tabs || []).find(tab => tab?.id != null && sameChatConversationUrl(tab.url, conversationUrl));
    if (existing?.id != null) {
      tabId = existing.id;
    } else {
      const tab = await chrome.tabs.create({ url: conversationUrl, active: false });
      tabId = tab?.id ?? null;
      temporaryTab = true;
    }
    if (tabId == null) throw new Error('Assistant report probe could not resolve a ChatGPT tab');
    return await transport.execute(tabId, {
      requestId: `assistant-report:${job.id || job.workerId || job.taskId || 'probe'}:${Date.now()}`,
      taskId: job.taskId || job.workerId || 'assistant-report',
      mode: 'READ_ASSISTANT_REPORT',
      expectedUrl: conversationUrl,
      promptText: '',
      assistantBaselineCount: Number(job.assistantBaselineCount || 0),
      assistantBaselineKnown: job.assistantBaselineKnown === true,
    });
  } finally {
    if (temporaryTab && tabId != null) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
  }
}

async function collectWebReportFromConversation(job) {
  const result = await probeAssistantConversation(job);
  if (result.status === 'READY' && result.assistantComplete && String(result.assistantText || '').trim()) {
    return { ready: true, text: String(result.assistantText).trim(), code: result.safeDiagnosticCode || 'ASSISTANT_RESPONSE_READY' };
  }
  return { ready: false, code: result.safeDiagnosticCode || result.status || 'ASSISTANT_RESPONSE_NOT_READY' };
}
const dispatcher = new CoreCommandDispatcher(repo, undefined, { executionAvailable: EXECUTION_AVAILABLE, localAiClient, aiGatewayClient, aiOrchestrator, chromeApi: chrome });
const aiManager = new AiAutonomyManager({
  repository: repo,
  routePrompt: payload => dispatchSerializedAiRoute(payload),
  collectWebReport: collectWebReportFromConversation,
});
const browserAgent = new BrowserAgentManager({
  chromeApi: chrome,
  routePrompt: payload => dispatchSerializedAiRoute(payload),
});
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
    await remoteDispatch.reconcileAlarm();
    // Reconstruct only deterministic alarms here. Ordinary MV3 service-worker
    // restarts are common and must not manufacture a coordinator reasoning tick.
    await orchestrationV2.reconcileAlarm();
    await scenarioWork.reconcileAlarm();
    await browserAgent.reconcileAlarm();
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

async function reconcileAiReportAlarm() {
  const wakeAt = await aiManager.nextReportWakeAt();
  if (!wakeAt) {
    try { await chrome.alarms.clear(AI_REPORT_ALARM); } catch (_) {}
    return 0;
  }
  await chrome.alarms.create(AI_REPORT_ALARM, { when: Math.max(Date.now() + 250, wakeAt) });
  return wakeAt;
}

async function reconcileAiManagerAlarm() {
  const wakeAt = await aiManager.nextDecisionWakeAt();
  if (!wakeAt) {
    try { await chrome.alarms.clear(AI_MANAGER_ALARM); } catch (_) {}
    return 0;
  }
  await chrome.alarms.create(AI_MANAGER_ALARM, { when: Math.max(Date.now() + 250, wakeAt) });
  return wakeAt;
}

let aiManagerCycleInFlight = null;
function managerNeedsCoreReconcile(result) {
  if (result?.kind !== 'AI_MANAGER_DECISION_APPLIED' || !Array.isArray(result.applied)) return false;
  return result.applied.some(action => ['RETRY_NOW', 'PAUSE_SESSION', 'RESUME_SESSION', 'RESTART_COMPLETED_SESSION'].includes(action?.type));
}

async function stateAfterManager(result) {
  if (!managerNeedsCoreReconcile(result)) return repo.load();
  const reconciled = await runRuntimeCycle({
    repository: repo,
    chromeApi: chrome,
    executor,
    startup: false,
    executionAvailable: false,
  });
  return reconciled.state;
}
function runAiManagerCycle() {
  if (aiManagerCycleInFlight) return aiManagerCycleInFlight;
  const cycle = (async () => {
    await ensureColdStartReconciled();
    const manager = await aiManager.process();
    await reconcileAiManagerAlarm();
    await reconcileAiReportAlarm();
    const state = await stateAfterManager(manager);
    await notifyStatusChanged(state);
    return { manager, state };
  })();
  aiManagerCycleInFlight = cycle.finally(() => { aiManagerCycleInFlight = null; });
  return aiManagerCycleInFlight;
}

let aiReportCycleInFlight = null;
function runAiReportCycle() {
  if (aiReportCycleInFlight) return aiReportCycleInFlight;
  const cycle = (async () => {
    await ensureColdStartReconciled();
    const report = await aiManager.collectOneDueReport();
    const manager = await aiManager.process();
    await reconcileAiReportAlarm();
    await reconcileAiManagerAlarm();
    const state = await stateAfterManager(manager);
    await notifyStatusChanged(state);
    return { report, manager, state };
  })();
  aiReportCycleInFlight = cycle.finally(() => { aiReportCycleInFlight = null; });
  return aiReportCycleInFlight;
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
    const remoteSync = await remoteDispatch.syncAfterCoreCycle();
    const orchestrationSync = await orchestrationV2.syncAfterCoreCycle();
    const scenarioSync = await scenarioWork.syncAfterCoreCycle();
    const orchestrationLaunched = orchestrationSync?.materialized?.launched?.length
      || orchestrationSync?.results?.some(item => item.result?.materialized?.launched?.length);
    const scenarioLaunched = scenarioSync?.results?.some(item => item.result?.launched?.length);
    if (orchestrationLaunched || scenarioLaunched) {
      // V2 may have filled newly-free worker slots after observing a verified
      // core Send. Reconcile the canonical core alarm, but never execute a
      // second nested browser cycle here.
      await runRuntimeCycle({
        repository: repo,
        chromeApi: chrome,
        executor,
        startup: false,
        executionAvailable: false,
      });
    }
    const stateAfterRemoteSync = await repo.load();
    await aiManager.capture(result.outcomes, stateAfterRemoteSync);
    const manager = await aiManager.process();
    await reconcileAiReportAlarm();
    await reconcileAiManagerAlarm();
    // Reconcile the core scheduler only when the manager actually changed a
    // scheduler-relevant state. A pure handoff/summary must not duplicate the
    // canonical core alarm on every wake.
    const state = await stateAfterManager(manager);
    await notifyStatusChanged(state);
    return { ...result, state, manager, remoteSync, orchestrationSync, scenarioSync };
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


let remoteDispatchCycleInFlight = null;
export function runRemoteDispatchCycle({ execute = true } = {}) {
  if (remoteDispatchCycleInFlight) return remoteDispatchCycleInFlight;
  const cycle = (async () => {
    await ensureColdStartReconciled();
    const remote = await remoteDispatch.poll();
    const state = await reconcileRuntime();
    if (execute && ['APPLIED', 'CACHED_AFTER_FETCH_ERROR'].includes(remote.kind)) {
      const execution = await runExecutionCycle();
      return { remote, state: execution.state, execution };
    }
    return { remote, state };
  })();
  remoteDispatchCycleInFlight = cycle.finally(() => { remoteDispatchCycleInFlight = null; });
  return remoteDispatchCycleInFlight;
}

let orchestrationV2CycleInFlight = null;
export function runOrchestrationV2Cycle() {
  if (orchestrationV2CycleInFlight) return orchestrationV2CycleInFlight;
  const cycle = (async () => {
    await ensureColdStartReconciled();
    const orchestration = await orchestrationV2.cycleAll();
    if (orchestration?.kind === 'DISABLED') {
      return { orchestration, state: await repo.load() };
    }
    // Controller decisions only materialize canonical Sessions/Tasks. The
    // existing scheduler remains the sole browser execution authority. An
    // enabled V2 cycle may create/update a coordinator or worker Session, so
    // reconcile (but never execute) the canonical core alarm afterward.
    const state = await reconcileRuntime();
    return { orchestration, state };
  })();
  orchestrationV2CycleInFlight = cycle.finally(() => { orchestrationV2CycleInFlight = null; });
  return orchestrationV2CycleInFlight;
}

async function runStartupCycle() {
  await ensureColdStartReconciled();
  await remoteDispatch.poll();
  // V2 must reconcile recovered coordinator/worker/control state before Core is
  // allowed to resume sends. Controller itself never performs browser sends.
  const orchestration = await orchestrationV2.cycleAll();
  const scenario = await scenarioWork.cycleAll();
  const agent = await browserAgent.cycleAll();
  const execution = await runExecutionCycle();
  return { execution, orchestration, scenario, agent };
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

let aiRouteQueue = Promise.resolve();
function dispatchSerializedAiRoute(payload) {
  const run = aiRouteQueue.then(() => dispatcher.execute('RUN_AI_ROUTED_PROMPT', payload || {}));
  aiRouteQueue = run.catch(() => undefined);
  return run;
}

export async function dispatchUiMessage(message) {
  if (message?.channel !== 'autopilot-ui' || typeof message.command !== 'string') return null;
  await ensureColdStartReconciled();
  let result;
  if (message.command === 'LIST_ORCHESTRATION_V2_ORCHESTRAS') {
    result = await orchestrationV2.list();
  } else if (message.command === 'CREATE_ORCHESTRATION_V2_ORCHESTRA') {
    result = await orchestrationV2.create(message.payload || {});
  } else if (message.command === 'SELECT_ORCHESTRATION_V2_ORCHESTRA') {
    result = await orchestrationV2.select(message.payload?.id);
  } else if (message.command === 'RENAME_ORCHESTRATION_V2_ORCHESTRA') {
    result = await orchestrationV2.rename(message.payload?.id, message.payload?.name);
  } else if (message.command === 'START_ORCHESTRATION_V2_ORCHESTRA') {
    const legacy = await remoteDispatch.getStatus();
    if (legacy?.config?.enabled) throw new Error('Disable Remote Dispatch V1 before enabling Orchestration V2.');
    result = await orchestrationV2.start(message.payload?.id || '');
  } else if (message.command === 'PAUSE_ORCHESTRATION_V2_ORCHESTRA') {
    result = await orchestrationV2.pause(message.payload?.id || '');
  } else if (message.command === 'RESUME_ORCHESTRATION_V2_ORCHESTRA') {
    result = await orchestrationV2.resume(message.payload?.id || '');
  } else if (message.command === 'DELETE_ORCHESTRATION_V2_ORCHESTRA') {
    result = await orchestrationV2.delete(message.payload?.id || '');
  } else if (message.command === 'GET_ORCHESTRATION_V2_STATUS') {
    result = {
      ...(await orchestrationV2.getStatus()),
      driveOAuth: inspectChromeDriveOAuth(chrome.runtime?.getManifest?.()),
    };
  } else if (message.command === 'PREVIEW_ORCHESTRATION_V2_PROFILE') {
    result = { preview: await orchestrationV2.previewProfile(message.payload?.profile) };
  } else if (message.command === 'IMPORT_ORCHESTRATION_V2_PROFILE') {
    result = await orchestrationV2.importProfile(message.payload?.profile);
  } else if (message.command === 'EXPORT_ORCHESTRATION_V2_PROFILE') {
    result = { profile: await orchestrationV2.exportProfile(message.payload?.name || 'Orchestration') };
  } else if (message.command === 'CONFIGURE_ORCHESTRATION_V2_HIERARCHY_TEMPLATE') {
    result = await orchestrationV2.configureHierarchyTemplate(message.payload || {});
  } else if (message.command === 'AUTHORIZE_ORCHESTRATION_V2_DRIVE') {
    await getChromeDriveAccessToken(chrome, { interactive: true });
    result = {
      authorized: true,
      oauth: inspectChromeDriveOAuth(chrome.runtime?.getManifest?.()),
    };
  } else if (message.command === 'TEST_ORCHESTRATION_V2_CONTROL') {
    result = await orchestrationV2.testControl(message.payload?.settings || null);
  } else if (message.command === 'UPDATE_ORCHESTRATION_V2_SETTINGS') {
    const requested = message.payload?.settings || {};
    const before = await orchestrationV2.getStatus();
    if (requested.enabled === true) {
      const legacy = await remoteDispatch.getStatus();
      if (legacy?.config?.enabled) throw new Error('Disable Remote Dispatch V1 before enabling Orchestration V2.');
    }
    let status = await orchestrationV2.updateConfig(requested);
    let startedNow = false;
    if (requested.enabled === true && before?.config?.enabled !== true && status?.ownerPaused !== true) {
      status = await orchestrationV2.start(status.selectedId || '');
      startedNow = true;
    }
    result = { config: status.config, status, startedNow };
  } else if (message.command === 'SAVE_AND_START_ORCHESTRATION_V2') {
    const requested = { ...(message.payload?.settings || {}), enabled: true };
    const legacy = await remoteDispatch.getStatus();
    if (legacy?.config?.enabled) throw new Error('Disable Remote Dispatch V1 before enabling Orchestration V2.');
    const saved = await orchestrationV2.updateConfig(requested);
    const status = await orchestrationV2.start(saved.selectedId || '');
    result = { config: status.config, status, startedNow: true };
  } else if (message.command === 'RUN_ORCHESTRATION_V2_NOW') {
    result = await runOrchestrationV2Cycle();
  } else if (message.command === 'EMERGENCY_STOP_ORCHESTRATION_V2') {
    result = await orchestrationV2.emergencyStop();
  } else if (message.command === 'LIST_SCENARIO_WORK') {
    result = await scenarioWork.list();
  } else if (message.command === 'GET_SCENARIO_WORK') {
    result = await scenarioWork.get(message.payload?.id || '');
  } else if (message.command === 'CREATE_SCENARIO_WORK') {
    result = await scenarioWork.create(message.payload || {});
  } else if (message.command === 'SELECT_SCENARIO_WORK') {
    result = await scenarioWork.select(message.payload?.id || '');
  } else if (message.command === 'UPDATE_SCENARIO_WORK') {
    result = await scenarioWork.updateConfig(message.payload?.id || '', message.payload?.config || {});
  } else if (message.command === 'START_SCENARIO_WORK') {
    result = await scenarioWork.start(message.payload?.id || '');
  } else if (message.command === 'PAUSE_SCENARIO_WORK') {
    result = await scenarioWork.pause(message.payload?.id || '');
  } else if (message.command === 'RESUME_SCENARIO_WORK') {
    result = await scenarioWork.resume(message.payload?.id || '');
  } else if (message.command === 'STOP_SCENARIO_WORK') {
    result = await scenarioWork.stop(message.payload?.id || '');
  } else if (message.command === 'DELETE_SCENARIO_WORK') {
    result = await scenarioWork.delete(message.payload?.id || '');
  } else if (message.command === 'RUN_SCENARIO_WORK_NOW') {
    result = await scenarioWork.cycleAll();
  } else if (message.command === 'LIST_BROWSER_AGENT_JOBS') {
    result = await browserAgent.list();
  } else if (message.command === 'GET_BROWSER_AGENT_JOB') {
    result = await browserAgent.get(message.payload?.id || '');
  } else if (message.command === 'CREATE_BROWSER_AGENT_JOB') {
    result = await browserAgent.create(message.payload || {});
  } else if (message.command === 'SELECT_BROWSER_AGENT_JOB') {
    result = await browserAgent.select(message.payload?.id || '');
  } else if (message.command === 'UPDATE_BROWSER_AGENT_JOB') {
    result = await browserAgent.updateConfig(message.payload?.id || '', message.payload?.config || {});
  } else if (message.command === 'START_BROWSER_AGENT_JOB') {
    result = await browserAgent.start(message.payload?.id || '');
  } else if (message.command === 'PAUSE_BROWSER_AGENT_JOB') {
    result = await browserAgent.pause(message.payload?.id || '');
  } else if (message.command === 'RESUME_BROWSER_AGENT_JOB') {
    result = await browserAgent.resume(message.payload?.id || '');
  } else if (message.command === 'STOP_BROWSER_AGENT_JOB') {
    result = await browserAgent.stop(message.payload?.id || '');
  } else if (message.command === 'STEP_BROWSER_AGENT_JOB') {
    result = await browserAgent.step(message.payload?.id || '');
  } else if (message.command === 'ADD_BROWSER_AGENT_INSTRUCTION') {
    result = await browserAgent.addInstruction(message.payload?.id || '', message.payload?.text || '');
  } else if (message.command === 'RUN_BROWSER_AGENT_BURST') {
    result = await browserAgent.runBurst(message.payload?.id || '', { maxCycles: 25, maxWallMs: 25000 });
  } else if (message.command === 'APPROVE_BROWSER_AGENT_ACTION') {
    result = await browserAgent.approvePendingAction(message.payload?.id || '');
  } else if (message.command === 'REJECT_BROWSER_AGENT_ACTION') {
    result = await browserAgent.rejectPendingAction(message.payload?.id || '');
  } else if (message.command === 'DELETE_BROWSER_AGENT_JOB') {
    result = await browserAgent.delete(message.payload?.id || '');
  } else if (message.command === 'RUN_BROWSER_AGENT_NOW') {
    result = await browserAgent.cycleAll();
  } else if (message.command === 'GET_REMOTE_DISPATCH_STATUS') {
    result = await remoteDispatch.getStatus();
  } else if (message.command === 'TEST_REMOTE_DISPATCH_FEED') {
    result = await remoteDispatch.testFeed(message.payload?.settings || null);
  } else if (message.command === 'UPDATE_REMOTE_DISPATCH_SETTINGS') {
    const requested = message.payload?.settings || {};
    if (requested.enabled === true) {
      const v2 = await orchestrationV2.list();
      if (v2.orchestras.some(item => item.config?.enabled)) throw new Error('Disable all Orchestration V2 orchestras before enabling legacy Remote Dispatch V1.');
    }
    const settings = await remoteDispatch.updateConfig(requested);
    const remote = settings.enabled && !settings.intakePaused ? await remoteDispatch.poll() : null;
    result = { settings, remote, status: await remoteDispatch.getStatus() };
  } else if (message.command === 'RUN_REMOTE_DISPATCH_NOW') {
    result = await runRemoteDispatchCycle({ execute: true });
  } else {
    result = message.command === 'RUN_AI_ROUTED_PROMPT'
      ? await dispatchSerializedAiRoute(message.payload || {})
      : message.command === 'RUN_AI_MANAGER_NOW'
        ? await aiManager.process({ force: true })
        : await dispatcher.execute(message.command, message.payload || {});
  }
  // Read-only status/configuration queries must not create a STATUS_CHANGED
  // feedback loop with the options page. Only state-changing UI commands need
  // alarm reconciliation and a status broadcast.
  if (!READ_ONLY_UI_COMMANDS.has(message.command)) {
    await reconcileRuntime();
    await reconcileAiReportAlarm();
    await reconcileAiManagerAlarm();
  }
  return result;
}

chrome.runtime.onInstalled.addListener(() => { runSafely(runStartupCycle()); });
chrome.runtime.onStartup.addListener(() => { runSafely(runStartupCycle()); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'autopilot-core-wake') runSafely(runExecutionCycle());
  if (alarm.name === AI_REPORT_ALARM) runSafely(runAiReportCycle());
  if (alarm.name === AI_MANAGER_ALARM) runSafely(runAiManagerCycle());
  if (alarm.name === BROWSER_AGENT_ALARM) runSafely(browserAgent.cycleAll());
  if (alarm.name === REMOTE_DISPATCH_ALARM) runSafely(runRemoteDispatchCycle());
  if (orchestrationV2.isAlarm(alarm.name)) runSafely((async () => { await ensureColdStartReconciled(); const orchestration = await orchestrationV2.cycleAlarm(alarm.name); const state = await reconcileRuntime(); return { orchestration, state }; })());
  if (scenarioWork.isAlarm(alarm.name)) runSafely((async () => { await ensureColdStartReconciled(); const scenario = await scenarioWork.cycleAll(); const state = await reconcileRuntime(); return { scenario, state }; })());
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.channel === 'autopilot-native-input') {
    performNativeInput(chrome, repo, message, _sender)
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: {
        safeDiagnosticCode: error?.safeDiagnosticCode || 'NATIVE_INPUT_FAILED',
      } }));
    return true;
  }
  if (message?.channel !== 'autopilot-ui') return false;
  dispatchUiMessage(message)
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => sendResponse({ ok: false, error: { message: error?.message || 'Core command failed' } }));
  return true;
});
chrome.action?.onClicked.addListener(() => { runSafely(chrome.runtime.openOptionsPage()); });
