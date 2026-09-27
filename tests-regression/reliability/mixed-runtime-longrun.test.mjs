import test from 'node:test';
import assert from 'node:assert/strict';

import { StorageRepository } from '../../src/core/storage.js';
import { AutomaticSessionExecutor } from '../../src/core/automatic-executor.js';
import { runRuntimeCycle } from '../../src/core/runtime-execution.js';
import { createSession, createTask, RunState, TabStrategy } from '../../src/core/schema.js';
import { CoreCommand, InteractionResult } from '../../src/shared/protocol.js';
import { CoreCommandDispatcher } from '../../src/core/commands.js';
import { BrowserAgentManager } from '../../src/core/browser-agent-manager.js';
import { ScenarioWorkManager } from '../../src/core/scenario-work-manager.js';
import { ScenarioWorkMode } from '../../src/core/scenario-work.js';
import { OrchestrationV2Controller } from '../../src/core/orchestration-v2-controller.js';
import { ORCHESTRATION_CONTROL_MARKER } from '../../src/core/orchestration-v2.js';

class SharedChrome {
  constructor() {
    this.data = {};
    this.alarmsMap = new Map();
    this.tabsMap = new Map();
    this.nextTabId = 1;
    this.removeAttempts = 0;
    this.removeFailures = 0;
    this.created = 0;
    this.removed = 0;
    this.failedCloseOnce = new Set();
    this.pageVersion = new Map();

    this.storage = { local: {
      get: async key => {
        if (key == null) return structuredClone(this.data);
        if (Array.isArray(key)) return Object.fromEntries(key.filter(k => k in this.data).map(k => [k, structuredClone(this.data[k])]));
        if (typeof key === 'object') {
          const out = structuredClone(key);
          for (const k of Object.keys(key)) if (k in this.data) out[k] = structuredClone(this.data[k]);
          return out;
        }
        return key in this.data ? { [key]: structuredClone(this.data[key]) } : {};
      },
      set: async record => { Object.assign(this.data, structuredClone(record)); },
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key]; },
    }};

    this.alarms = {
      create: async (name, info) => { this.alarmsMap.set(name, structuredClone(info || {})); },
      clear: async name => this.alarmsMap.delete(name),
      get: async name => this.alarmsMap.has(name) ? { name, ...structuredClone(this.alarmsMap.get(name)) } : undefined,
    };

    this.permissions = { contains: async () => true };

    this.tabs = {
      query: async queryInfo => {
        let tabs = [...this.tabsMap.values()];
        const pattern = queryInfo?.url;
        if (pattern === 'https://chatgpt.com/*') tabs = tabs.filter(tab => String(tab.url || '').startsWith('https://chatgpt.com/'));
        return tabs.map(tab => structuredClone(tab));
      },
      create: async ({ url, active = false, openerTabId = undefined }) => {
        const id = this.nextTabId++;
        const tab = { id, url, active, status: 'complete', lastAccessed: id * 10, ...(Number.isInteger(openerTabId) ? { openerTabId } : {}) };
        this.tabsMap.set(id, tab);
        this.pageVersion.set(id, 0);
        this.created += 1;
        return structuredClone(tab);
      },
      get: async id => {
        const tab = this.tabsMap.get(id);
        if (!tab) throw new Error('No tab with id');
        return structuredClone(tab);
      },
      update: async (id, patch) => {
        const tab = this.tabsMap.get(id);
        if (!tab) throw new Error('No tab with id');
        Object.assign(tab, patch, { status: 'complete', lastAccessed: Number(tab.lastAccessed || 0) + 1 });
        this.pageVersion.set(id, (this.pageVersion.get(id) || 0) + 1);
        return structuredClone(tab);
      },
      remove: async id => {
        this.removeAttempts += 1;
        if (this.tabsMap.has(id) && !this.failedCloseOnce.has(id)) {
          this.failedCloseOnce.add(id);
          this.removeFailures += 1;
          throw new Error('synthetic transient tabs.remove failure');
        }
        if (!this.tabsMap.has(id)) throw new Error('No tab with id');
        this.tabsMap.delete(id);
        this.pageVersion.delete(id);
        this.removed += 1;
      },
      reload: async id => {
        if (!this.tabsMap.has(id)) throw new Error('No tab with id');
        this.pageVersion.set(id, (this.pageVersion.get(id) || 0) + 1);
      },
      goBack: async id => {
        if (!this.tabsMap.has(id)) throw new Error('No tab with id');
        this.pageVersion.set(id, (this.pageVersion.get(id) || 0) + 1);
      },
    };

    this.scripting = {
      executeScript: async details => {
        const name = details.func?.name || '';
        const tabId = details.target?.tabId;
        const tab = this.tabsMap.get(tabId);
        if (!tab) throw new Error('No tab with id');
        if (name === 'snapshotBrowserPage') {
          return [{ frameId: 0, result: {
            snapshotId: details.args?.[0],
            url: tab.url,
            title: 'Mixed Agent Page',
            text: `version ${this.pageVersion.get(tabId) || 0}`,
            elements: [{ ref: 'r1', tag: 'button', role: 'button', type: 'button', name: 'Continue', checked: false, selected: false }],
          } }];
        }
        if (name === 'executeBrowserPageAction') {
          this.pageVersion.set(tabId, (this.pageVersion.get(tabId) || 0) + 1);
          return [{ frameId: details.target?.frameIds?.[0] || 0, result: { ok: true } }];
        }
        if (name === 'proveBrowserNativeClick') return [{ frameId: 0, result: { x: 20, y: 20 } }];
        throw new Error(`unexpected script ${name}`);
      },
    };

    this.debugger = { attach: async () => {}, sendCommand: async () => ({}), detach: async () => {} };
  }
}

function controlBody(payload) {
  return `${ORCHESTRATION_CONTROL_MARKER}\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

function controlPayload({ revision, now, actions }) {
  return {
    schema_version: 2,
    project_id: 'mixed-project',
    revision,
    coordinator_generation: 1,
    generated_at: new Date(now).toISOString(),
    expires_at: new Date(now + 3_600_000).toISOString(),
    mode: 'RUN',
    actions,
  };
}

function orchTask(id) {
  return {
    task_id: id,
    prompt: `Mixed orchestration task ${id}`,
    priority: 10,
    dependencies: [],
    conflict_key: '',
    generation: 1,
    launch_mode: 'FRESH_CHAT',
    continue_worker_id: '',
    exact_once_key: `${id}@1`,
    not_before: null,
    expires_at: null,
    target_repository: 'owner/mixed-project',
  };
}

function response(payload) {
  return { ok: true, status: 200, headers: { get: () => '100' }, async json() { return structuredClone(payload); } };
}

test('mixed long-run keeps Ordinary, Browser Agent, Scenario Work and Orchestration V2 progressing together through restart and tab-close faults', async () => {
  const chrome = new SharedChrome();
  const core = new StorageRepository(chrome);
  let now = Date.parse('2026-09-14T12:00:00Z');
  let generatedConversation = 0;
  const uncertainOnce = new Set();
  const verifyAttempts = new Map();

  await core.update(state => {
    for (let i = 1; i <= 2; i += 1) {
      const id = `ordinary-mixed-${i}`;
      const session = createSession({
        id,
        name: id,
        tasks: [createTask({ id: `${id}:task`, url: 'https://chatgpt.com/' })],
        sharedPrompt: `ordinary ${i}`,
        minimumSendIntervalMs: 5_000,
        preSendDelayMs: 0,
        retryBackoffMs: 1_000,
        tabStrategy: TabStrategy.OPEN_CLOSE_PER_TASK,
        now,
      });
      session.runState = RunState.RUNNING;
      state.sessionsById[id] = session;
      state.sessionOrder.push(id);
    }
    return state;
  });

  const transport = {
    execute: async (tabId, request) => {
      if (request.mode === 'CHECK_ONLY') return { status: InteractionResult.READY, safeDiagnosticCode: 'READY', normalizedObservedUrl: request.expectedUrl };
      if (request.mode === 'ENSURE_HIGH_EFFORT') return { status: InteractionResult.READY, effortLevel: 'high', safeDiagnosticCode: 'EFFORT_HIGH_CONFIRMED', normalizedObservedUrl: request.expectedUrl };
      if (request.mode === 'INSERT_ONLY') return { status: InteractionResult.INSERTED_NOT_SENT, safeDiagnosticCode: 'INSERTION_TEXT_PROVEN', composerState: 'VISIBLE_NONEMPTY', normalizedObservedUrl: request.expectedUrl };
      if (request.mode === 'PREPARE_SEND') return { status: InteractionResult.READY, safeDiagnosticCode: 'PENDING_PROMPT_READY_TO_SUBMIT', normalizedObservedUrl: request.expectedUrl };
      if (request.mode === 'SUBMIT_EXISTING') {
        generatedConversation += 1;
        // The first Send creates a conversation. Subsequent Scenario turns
        // stay at their existing /c/ URL, as the real persistent chat does.
        const url = /\/c\//.test(request.expectedUrl)
          ? request.expectedUrl : `https://chatgpt.com/c/mixed-${generatedConversation}`;
        const tab = chrome.tabsMap.get(tabId);
        if (tab) tab.url = url;
        const ordinary = String(request.taskId || '').startsWith('ordinary-mixed-');
        const key = `${request.taskId}:${generatedConversation}`;
        if (ordinary && generatedConversation % 9 === 0) {
          uncertainOnce.add(key);
          return { status: InteractionResult.SUBMISSION_UNCERTAIN, safeDiagnosticCode: 'SEND_CLICK_UNCERTAIN', normalizedObservedUrl: url };
        }
        return { status: InteractionResult.SENT_VERIFIED, safeDiagnosticCode: 'SEND_VERIFIED_FRESH_STRUCTURAL_APPEND', normalizedObservedUrl: url, assistantBaselineCount: 0 };
      }
      if (request.mode === 'VERIFY_AFTER_UNCERTAIN_SUBMIT') {
        const key = request.operationId || request.requestId || String(request.taskId);
        const n = (verifyAttempts.get(key) || 0) + 1;
        verifyAttempts.set(key, n);
        const tab = chrome.tabsMap.get(tabId);
        if (n === 1) return { status: InteractionResult.SUBMISSION_UNCERTAIN, safeDiagnosticCode: 'RECOVERY_STALE_MATCH_UNPROVEN', normalizedObservedUrl: tab?.url || request.expectedUrl };
        return { status: InteractionResult.SENT_VERIFIED, safeDiagnosticCode: 'RECOVERY_VERIFIED', normalizedObservedUrl: tab?.url || request.expectedUrl, assistantBaselineCount: 0 };
      }
      throw new Error(`unexpected transport mode ${request.mode}`);
    },
  };

  let executor = new AutomaticSessionExecutor(core, chrome, transport, { now: () => now });

  let agentCalls = 0;
  const agentRoute = async () => {
    agentCalls += 1;
    return agentCalls % 2 === 1
      ? { text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1' }), usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, modelCalls: 1 } }
      : { text: JSON.stringify({ type: 'done', summary: 'monitor cycle complete' }), usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, modelCalls: 1 } };
  };
  let agent = new BrowserAgentManager({ chromeApi: chrome, routePrompt: agentRoute, now: () => now, createId: () => 'mixed-agent' });
  await agent.create({ id: 'mixed-agent', goal: 'Monitor the mixed test page', startUrl: 'https://ais.example.edu/app', startFromActiveTab: false, repeatMode: 'INTERVAL', intervalSeconds: 4, stepDelayMs: 0, closeOwnedTabsOnStop: true });
  await agent.start('mixed-agent');

  let scenario = new ScenarioWorkManager({
    coreRepository: core,
    chromeApi: chrome,
    now: () => now,
    createId: () => 'mixed-scenario',
    collectAssistantReport: async () => ({ status: 'READY', assistantComplete: true, assistantText: 'Scenario turn complete' }),
  });
  await scenario.create({ mode: ScenarioWorkMode.CHAT_CYCLE, config: {
    steps: Array.from({ length: 8 }, (_, index) => ({ prompt: `SCENARIO MIXED ${index + 1}` })),
    minimumLaunchGapSeconds: 0
  } });
  await scenario.start('mixed-scenario');

  let controlRevision = 0;
  let workerAdded = false;
  const fetchFn = async () => {
    controlRevision += 1;
    const actions = workerAdded
      ? [{ type: 'NO_ACTION' }]
      : [{ type: 'ADD_TASKS', tasks: [orchTask('mixed-worker')] }];
    workerAdded = true;
    const payload = controlPayload({ revision: controlRevision, now, actions });
    return response({ id: 99, body: controlBody(payload), html_url: 'https://github.com/owner/mixed-project/issues/1#issuecomment-99' });
  };
  const orchConfig = {
    enabled: true,
    projectId: 'mixed-project',
    targetRepository: 'owner/mixed-project',
    controlRepository: 'owner/mixed-project',
    controlIssueNumber: 1,
    controlCommentId: 99,
    masterCoordinatorPrompt: 'MIXED COORDINATOR',
    defaultDesiredWorkers: 1,
    absoluteMaxWorkers: 2,
    watchdogIntervalSeconds: 30,
    workerProbeIntervalSeconds: 1,
    maxCoordinatorTurns: 50,
    maxLaunchesPerWindow: 30,
    launchWindowSeconds: 60,
    minimumLaunchIntervalSeconds: 0,
  };
  let orchestration = new OrchestrationV2Controller({
    coreRepository: core,
    chromeApi: chrome,
    fetchFn,
    collectAssistantReport: async () => ({ status: 'READY', assistantComplete: true, assistantText: 'Mixed orchestration report complete' }),
    now: () => now,
  });
  await orchestration.updateConfig(orchConfig);

  let maxTabs = 0;
  const start = now;
  const end = start + 20 * 60_000;
  let cycles = 0;
  while (now <= end && cycles < 50) {
    await runRuntimeCycle({ repository: core, chromeApi: chrome, executor, startup: false, executionAvailable: true, now: () => now });
    await runRuntimeCycle({ repository: core, chromeApi: chrome, executor, startup: false, executionAvailable: true, now: () => now });
    await orchestration.syncAfterCoreCycle({ nowMs: now });
    await scenario.syncAfterCoreCycle();

    if (cycles % 2 === 0) await scenario.cycleAll();
    if (cycles % 3 === 0) await orchestration.cycle({ nowMs: now });
    if (cycles % 2 === 0) await agent.cycleAll();

    maxTabs = Math.max(maxTabs, chrome.tabsMap.size);

    if (cycles === 15) {
      // Cold-reconstruct every higher-level manager while keeping the same durable
      // Core state, Chrome storage/tabs and virtual clock.
      executor = new AutomaticSessionExecutor(core, chrome, transport, { now: () => now });
      agent = new BrowserAgentManager({ chromeApi: chrome, routePrompt: agentRoute, now: () => now, createId: () => 'unused' });
      scenario = new ScenarioWorkManager({
        coreRepository: core, chromeApi: chrome, now: () => now, createId: () => 'unused',
        collectAssistantReport: async () => ({ status: 'READY', assistantComplete: true, assistantText: 'Scenario turn complete' }),
      });
      orchestration = new OrchestrationV2Controller({
        coreRepository: core, chromeApi: chrome, fetchFn,
        collectAssistantReport: async () => ({ status: 'READY', assistantComplete: true, assistantText: 'Mixed orchestration report complete' }),
        now: () => now,
      });
      await agent.reconcileAlarm();
      await scenario.reconcileAlarm();
      await orchestration.reconcileAlarm({ nowMs: now });
    }

    now += 60_000;
    cycles += 1;
  }

  // Give every subsystem a few extra cleanup/reconciliation opportunities.
  for (let i = 0; i < 6; i += 1) {
    await runRuntimeCycle({ repository: core, chromeApi: chrome, executor, startup: false, executionAvailable: true, now: () => now });
    await orchestration.syncAfterCoreCycle({ nowMs: now });
    await scenario.syncAfterCoreCycle();
    await scenario.cycleAll();
    await orchestration.cycle({ nowMs: now });
    await agent.cycleAll();
    now += 1000;
  }

  assert.ok(cycles < 50, 'mixed runtime must progress through virtual time without hot-looping');
  assert.ok(chrome.removeFailures > 0, 'mixed test must inject real tabs.remove failures');
  assert.ok(maxTabs <= 12, `tab population must remain bounded under four concurrent runtimes, observed ${maxTabs}`);

  const state = await core.load();
  for (let i = 1; i <= 2; i += 1) {
    const session = state.sessionsById[`ordinary-mixed-${i}`];
    assert.ok(session.successfulSendCount >= 5, `ordinary ${i} must continue progressing, got ${session.successfulSendCount}`);
    assert.ok([RunState.RUNNING, RunState.RECOVERING].includes(session.runState));
  }

  const agentState = (await agent.get('mixed-agent')).job;
  assert.ok(agentState.runtime.completedCycles >= 8, `Browser Agent must complete repeated cycles, got ${agentState.runtime.completedCycles}`);
  assert.ok(agentState.runtime.modelCalls >= agentState.runtime.completedCycles, 'Browser Agent must retain durable model usage across restart');

  const scenarioState = (await scenario.get('mixed-scenario')).scenario;
  assert.ok(scenarioState.runtime.totalCompletedTurns >= 4, `Scenario Work must keep advancing, got ${scenarioState.runtime.totalCompletedTurns}`);

  const orchStatus = await orchestration.getStatus();
  assert.ok(orchStatus.runtime.workerCounts.COMPLETED >= 1, 'Orchestration worker must reach terminal completion');
  assert.ok(orchStatus.runtime.lastAppliedControlRevision >= 1, 'Orchestration coordinator must apply durable control');

  const retirePending = Object.values(state.tabHintsByTaskId || {}).filter(hint => hint?.retirePending);
  assert.ok(retirePending.length <= 2, `active open-close Sessions may each have one first-close retry pending, observed ${retirePending.length}`);
  assert.ok(retirePending.every(hint => ['ordinary-mixed-1', 'ordinary-mixed-2'].includes(hint.sessionId)),
    'Scenario/Orchestration/Agent retirement obligations must drain during mixed running load');
  assert.equal(new Set(retirePending.map(hint => hint.sessionId)).size, retirePending.length,
    'at most one retirement obligation may remain per active Ordinary Session');

  // Stronger quiescence proof: after both continuously-running Ordinary Sessions
  // are explicitly stopped through the real command layer, their outstanding
  // first-close failures must be retried and ownership must fully disappear.
  // This distinguishes a bounded live-session retry from a true orphan leak.
  const dispatcher = new CoreCommandDispatcher(core, () => now, { executionAvailable: true, chromeApi: chrome });
  await dispatcher.execute(CoreCommand.STOP_SESSION, { sessionId: 'ordinary-mixed-1' });
  await dispatcher.execute(CoreCommand.STOP_SESSION, { sessionId: 'ordinary-mixed-2' });
  for (let i = 0; i < 3; i += 1) {
    await runRuntimeCycle({ repository: core, chromeApi: chrome, executor, startup: false, executionAvailable: true, now: () => now });
    await orchestration.syncAfterCoreCycle({ nowMs: now });
    await scenario.syncAfterCoreCycle();
    await agent.cycleAll();
    now += 1000;
  }
  const quiesced = await core.load();
  const remainingOrdinaryHints = Object.values(quiesced.tabHintsByTaskId || {})
    .filter(hint => ['ordinary-mixed-1', 'ordinary-mixed-2'].includes(hint?.sessionId));
  assert.equal(remainingOrdinaryHints.length, 0,
    `explicit Stop must fully retire both Ordinary owned tabs after transient close failures, remaining=${remainingOrdinaryHints.length}`);
  assert.equal(quiesced.sessionsById['ordinary-mixed-1'].runState, RunState.STOPPED);
  assert.equal(quiesced.sessionsById['ordinary-mixed-2'].runState, RunState.STOPPED);
  assert.ok(chrome.alarmsMap.size >= 1, 'at least one durable runtime alarm should remain scheduled for continuing higher-level work');
});
