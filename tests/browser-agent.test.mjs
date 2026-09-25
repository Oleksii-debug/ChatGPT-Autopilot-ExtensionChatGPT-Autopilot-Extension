import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBrowserAgentConfig,
  parseBrowserAgentAction,
  buildBrowserAgentPlannerPrompt,
  BrowserAgentRepeatMode,
  BrowserAgentApprovalMode,
  BrowserAgentPolicyDecision,
  normalizeBrowserAgentSiteRules,
  resolveBrowserAgentOwnerPolicy,
  resolveBrowserAgentCredentialPolicy,
  browserAgentScheduleDecision,
  classifyBrowserAgentActionRisk,
  browserSnapshotSignature,
  verifyBrowserAgentOutcomeEvidence,
} from '../src/core/browser-agent.js';
import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { AiOrchestrator } from '../src/core/ai-orchestrator.js';

function makeChrome({ permission = true } = {}) {
  const storage = {};
  const tabs = new Map([[1, { id: 1, url: 'https://ais.example.edu/app', active: true, status: 'complete', lastAccessed: 10 }]]);
  const alarms = new Map();
  const actionCalls = [];
  let nextTabId = 2;
  let pageVersion = 0;
  let permissionAllowed = permission;

  const api = {
    storage: { local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(values) { Object.assign(storage, structuredClone(values)); },
    } },
    tabs: {
      async query() { return [...tabs.values()].map(tab => structuredClone(tab)); },
      async get(id) { if (!tabs.has(id)) throw new Error('missing tab'); return structuredClone(tabs.get(id)); },
      async create({ url, active = false }) { const tab = { id: nextTabId++, url, active, status: 'complete', lastAccessed: 20 }; tabs.set(tab.id, tab); return structuredClone(tab); },
      async update(id, patch) { const tab = tabs.get(id); if (!tab) throw new Error('missing tab'); Object.assign(tab, patch); if (patch.url) tab.status = 'complete'; pageVersion += 1; return structuredClone(tab); },
      async remove(id) { tabs.delete(id); },
      async reload(id) { if (!tabs.has(id)) throw new Error('missing tab'); pageVersion += 1; },
      async goBack(id) { if (!tabs.has(id)) throw new Error('missing tab'); pageVersion += 1; },
    },
    permissions: {
      async contains() { return permissionAllowed; },
      setAllowed(value) { permissionAllowed = value; },
    },
    alarms: {
      async create(name, info) { alarms.set(name, info); },
      async clear(name) { alarms.delete(name); return true; },
    },
    scripting: {
      async executeScript(details) {
        const name = details.func?.name || '';
        if (name === 'snapshotBrowserPage') {
          const snapshotId = details.args[0];
          const tab = tabs.get(details.target.tabId);
          return [{ frameId: 0, result: {
            snapshotId,
            url: tab?.url || 'https://ais.example.edu/app',
            title: 'AIS',
            text: `page version ${pageVersion}`,
            elements: [{ ref: 'r1', tag: 'button', role: '', type: '', name: 'Add course', checked: false, selected: false }],
            viewport: { width: 1280, height: 720, scrollY: 0, documentHeight: 1600 },
          } }];
        }
        if (name === 'readBrowserCredentialFrameOrigin') {
          const tab = tabs.get(details.target.tabId);
          const url = tab?.url || 'https://ais.example.edu/app';
          return [{ frameId: details.target.frameIds?.[0] || 0, result: { url, origin: new URL(url).origin } }];
        }
        if (name === 'executeBrowserPageAction') {
          actionCalls.push(structuredClone(details.args[1]));
          pageVersion += 1;
          return [{ frameId: details.target.frameIds?.[0] || 0, result: { ok: true } }];
        }
        if (name === 'proveBrowserNativeClick') return [{ frameId: 0, result: { x: 10, y: 10 } }];
        if (name === 'verifyBrowserApprovalTarget') return [{ frameId: details.target.frameIds?.[0] || 0, result: { ok: true } }];
        if (name === 'focusBrowserAgentTarget') return [{ frameId: details.target.frameIds?.[0] || 0, result: { ok: true } }];
        throw new Error(`unexpected script ${name}`);
      },
    },
    debugger: {
      async attach() {}, async sendCommand() {}, async detach() {},
    },
    _actionCalls: actionCalls,
    _tabs: tabs,
    _alarms: alarms,
    _bumpPage() { pageVersion += 1; },
  };
  return api;
}

test('native click rechecks the same target after debugger attach and uses its new coordinates', async () => {
  const chrome = makeChrome();
  const calls = [];
  let attached = false;
  chrome.scripting.executeScript = async ({ func, args }) => {
    assert.equal(func.name, 'proveBrowserNativeClick');
    assert.deepEqual(args, ['snapshot-1', 'r1']);
    return [{ result: { x: attached ? 45 : 10, y: attached ? 50 : 15, url: 'https://ais.example.edu/app' } }];
  };
  chrome.debugger.attach = async () => { attached = true; };
  chrome.debugger.detach = async () => { attached = false; };
  chrome.debugger.sendCommand = async (_target, _method, params) => { calls.push(params); };
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  assert.equal(await manager.nativeClick(1, 0, 'snapshot-1', 'r1'), true);
  assert.deepEqual(calls.map(({ x, y }) => [x, y]), [[45, 50], [45, 50]]);
  assert.equal(attached, false);
});

test('native click never dispatches when the proven target disappears after debugger attach', async () => {
  const chrome = makeChrome();
  let attached = false;
  let dispatches = 0;
  let detached = false;
  chrome.scripting.executeScript = async () => [{ result: attached ? null : { x: 10, y: 15, url: 'https://ais.example.edu/app' } }];
  chrome.debugger.attach = async () => { attached = true; };
  chrome.debugger.detach = async () => { detached = true; };
  chrome.debugger.sendCommand = async () => { dispatches += 1; };
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  assert.equal(await manager.nativeClick(1, 0, 'snapshot-1', 'r1'), false);
  assert.equal(dispatches, 0);
  assert.equal(detached, true);
});

function config(overrides = {}) {
  return normalizeBrowserAgentConfig({
    id: 'job-1',
    goal: 'Add a course safely',
    maxSteps: 20,
    stepDelayMs: 0,
    ...overrides,
  }, { id: 'job-1' });
}

test('prompt-first config allows empty URL and keeps policy as optional ceilings', () => {
  const value = config();
  assert.equal(value.startUrl, '');
  assert.equal(value.startFromActiveTab, true);
  assert.equal(value.maxSteps, 20);
  assert.equal(value.allowCrossOriginNavigation, true);
});

test('Browser Agent project identity uses the canonical Project id grammar', () => {
  assert.equal(config({ projectId: 'project-1' }).projectId, 'project-1');
  assert.equal(config().projectId, '');
  assert.throws(() => config({ projectId: ' project-1 ' }), /projectId is invalid/);
  assert.throws(() => config({ projectId: 'project id' }), /projectId is invalid/);
  assert.throws(() => config({ projectId: 1 }), /projectId is invalid/);
});

test('Browser Agent persists immutable job-to-Project identity across restart', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }) });
  await manager.create({ id:'job-project', projectId:'project-1', goal:'Produce project evidence' });

  const binding = await manager.resolveJobProjectBinding('job-project');
  assert.deepEqual(binding, { schemaVersion:1, jobId:'job-project', projectId:'project-1', planId:'' });
  assert.equal(Object.isFrozen(binding), true);

  const restarted = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }) });
  assert.deepEqual(await restarted.resolveJobProjectBinding('job-project'), binding);
  await assert.rejects(
    () => restarted.updateConfig('job-project', { projectId:'project-2' }),
    /projectId is immutable/,
  );
  await assert.rejects(
    () => restarted.updateConfig('job-project', { projectId:'' }),
    /projectId is immutable/,
  );
});

test('legacy Browser Agent may bind a Project exactly once before execution history exists', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }) });
  await manager.create({ id:'job-legacy', goal:'Bind before execution' });
  await assert.rejects(() => manager.resolveJobProjectBinding('job-legacy'), /not bound to a Project/);

  await manager.updateConfig('job-legacy', { projectId:'project-legacy' });
  assert.deepEqual(await manager.resolveJobProjectBinding('job-legacy'), {
    schemaVersion:1,
    jobId:'job-legacy',
    projectId:'project-legacy',
    planId:'',
  });

  await assert.rejects(
    () => manager.updateConfig('job-legacy', { projectId:'project-other' }),
    /projectId is immutable/,
  );
});

test('Browser Agent refuses retroactive Project binding after execution evidence exists', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }) });
  await manager.create({ id:'job-history', goal:'Already executed' });
  await manager.update(store => {
    store.byId['job-history'].runtime.history.push({ at:1, type:'effect', message:'existing evidence' });
    return store;
  });
  await assert.rejects(
    () => manager.updateConfig('job-history', { projectId:'project-late' }),
    /must be bound before the job produces execution history/,
  );
  await assert.rejects(() => manager.resolveJobProjectBinding('job-history'), /not bound to a Project/);
});

test('Browser Agent Project update rejects accessor-backed identity without executing it', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }) });
  await manager.create({ id:'job-accessor', goal:'No getter execution' });
  let reads = 0;
  const update = {};
  Object.defineProperty(update, 'projectId', {
    enumerable:true,
    get() {
      reads += 1;
      return 'project-accessor';
    },
  });
  await assert.rejects(
    () => manager.updateConfig('job-accessor', update),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);
});

test('job-to-Project resolver composes exact persisted AgentPlan identity and fails closed on mismatch', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }) });
  await manager.create({ id:'job-plan-project', projectId:'project-plan', goal:'Plan within project' });
  await manager.update(store => {
    store.byId['job-plan-project'].runtime.plan = {
      schemaVersion:1,
      planId:'plan-project',
      jobId:'job-plan-project',
      objective:'Produce verified project result',
      successCriteria:['Verified'],
      createdAt:'2026-09-25T03:00:00.000Z',
      updatedAt:'2026-09-25T03:00:00.000Z',
      revision:1,
      nodes:[{
        nodeId:'work',
        title:'Work',
        objective:'Produce result',
        dependsOn:[],
        conflictKeys:[],
        ownerId:'parent',
        executionPlane:'BROWSER',
        acceptanceCriteria:[],
        budget:{},
        state:'PENDING',
        evidence:'',
        updatedAt:'2026-09-25T03:00:00.000Z',
      }],
    };
    return store;
  });
  assert.deepEqual(await manager.resolveJobProjectBinding('job-plan-project'), {
    schemaVersion:1,
    jobId:'job-plan-project',
    projectId:'project-plan',
    planId:'plan-project',
  });

  await manager.update(store => {
    store.byId['job-plan-project'].runtime.plan = {
      ...store.byId['job-plan-project'].runtime.plan,
      jobId: 'other-job',
    };
    return store;
  });
  await assert.rejects(
    () => manager.resolveJobProjectBinding('job-plan-project'),
    /AgentPlan jobId does not match the durable job/,
  );
});

test('Browser Agent persists a bounded external specialist handoff and requires an independent verifier', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }), now: () => Date.parse('2026-09-23T12:00:00.000Z') });
  await manager.create({ id:'job-1', goal:'Complete a mixed-plane task' });
  await manager.update(store => {
    store.byId['job-1'].runtime.plan = {
      schemaVersion:1, planId:'plan-1', jobId:'job-1', objective:'Complete safely', successCriteria:['Verified'], createdAt:'2026-09-23T12:00:00.000Z', updatedAt:'2026-09-23T12:00:00.000Z', revision:1,
      nodes:[
        { nodeId:'inspect', title:'Inspect', objective:'Inspect page', dependsOn:[], conflictKeys:['web'], ownerId:'parent', executionPlane:'BROWSER', acceptanceCriteria:[], budget:{}, state:'VERIFIED', evidence:'Observed', updatedAt:'2026-09-23T12:00:00.000Z' },
        { nodeId:'archive', title:'Archive', objective:'Create archive', dependsOn:['inspect'], conflictKeys:['files'], ownerId:'parent', executionPlane:'LOCAL', acceptanceCriteria:['Archive exists'], budget:{}, state:'PENDING', evidence:'', updatedAt:'2026-09-23T12:00:00.000Z' },
      ],
    };
    return store;
  });
  const prepared = await manager.prepareSpecialistHandoff('job-1', {
    nodeId:'archive', specialistId:'native-companion', requestedCapabilityIds:['filesystem.archive'], parentCapabilityIds:['filesystem.archive'], policyEnvelopeId:'policy:archive', deadlineAt:'2026-09-23T13:00:00.000Z', priority:5,
  });
  assert.equal(prepared.reused, false);
  assert.equal((await manager.listSpecialistHandoffs('job-1')).handoffs.length, 1);
  await manager.update(store => { store.byId['job-1'].runtime.runState = 'RUNNING'; return store; });
  const pending = await manager.cycleOne('job-1');
  assert.equal(pending.kind, 'SPECIALIST_PENDING', 'a durable handoff prevents duplicate external-dispatch requests');
  const claimed = await manager.claimSpecialistHandoffs('job-1', { availableSlots:1, leaseSeconds:60 });
  assert.equal(claimed.claimed.length, 1);
  const completed = await manager.completeSpecialistHandoff('job-1', { agentId:claimed.claimed[0], leaseId:claimed.assignments[0].leaseId, resultArtifactIds:['artifact:1'] });
  assert.equal(completed.verificationRequired, claimed.claimed[0]);
  await assert.rejects(
    () => manager.verifySpecialistHandoff('job-1', {
      agentId:claimed.claimed[0],
      verifierId:'verifier-forged-but-distinct',
      verificationAuthorityId:'policy:archive',
      evidence:'Caller-created text claims fresh artifact evidence.',
    }),
    /trusted verifier provenance/,
  );
  const after = await manager.listSpecialistHandoffs('job-1');
  const durable = await manager.get('job-1');
  assert.equal(durable.job.runtime.plan.nodes.find(node => node.nodeId === 'archive').state, 'RUNNING');
  assert.equal(after.handoffs[0].state, 'COMPLETED');
  assert.equal(after.executionOwnerships[0].state, 'OWNED');
});

test('Browser Agent keeps ambiguous specialist effect fenced across forged proof and restart', async () => {
  const chrome = makeChrome();
  let clock = Date.parse('2026-09-23T12:00:00.000Z');
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }), now: () => clock });
  await manager.create({ id:'job-retry', goal:'Recover an ambiguous specialist effect' });
  await manager.update(store => {
    store.byId['job-retry'].runtime.plan = {
      schemaVersion:1, planId:'plan-retry', jobId:'job-retry', objective:'Recover safely', successCriteria:['Verified'], createdAt:'2026-09-23T12:00:00.000Z', updatedAt:'2026-09-23T12:00:00.000Z', revision:1,
      nodes:[
        { nodeId:'inspect', title:'Inspect', objective:'Inspect page', dependsOn:[], conflictKeys:['web:retry'], ownerId:'parent', executionPlane:'BROWSER', acceptanceCriteria:[], budget:{}, state:'VERIFIED', evidence:'Observed', updatedAt:'2026-09-23T12:00:00.000Z' },
        { nodeId:'archive', title:'Archive', objective:'Create archive', dependsOn:['inspect'], conflictKeys:['files:retry'], ownerId:'parent', executionPlane:'LOCAL', acceptanceCriteria:['Archive exists'], budget:{}, state:'PENDING', evidence:'', updatedAt:'2026-09-23T12:00:00.000Z' },
      ],
    };
    return store;
  });
  await manager.prepareSpecialistHandoff('job-retry', {
    nodeId:'archive', specialistId:'native-companion', requestedCapabilityIds:['filesystem.archive'], parentCapabilityIds:['filesystem.archive'], policyEnvelopeId:'policy:retry', deadlineAt:'2026-09-23T13:00:00.000Z',
  });
  const claimed = await manager.claimSpecialistHandoffs('job-retry', { availableSlots:1, leaseSeconds:30 });
  const agentId = claimed.claimed[0];
  const leaseId = claimed.assignments[0].leaseId;
  clock = Date.parse('2026-09-23T12:01:00Z');
  const expired = await manager.claimSpecialistHandoffs('job-retry', { availableSlots:1 });
  assert.deepEqual(expired.claimed, []);
  assert.equal(expired.executionOwnerships[0].state, 'RECONCILE');

  const verification = {
    schemaVersion:1,
    verificationId:'verification-no-effect-job-retry',
    invocationId:'invoke-safe-retry-job-retry',
    observationId:'observation-no-effect-job-retry',
    status:'VERIFIED',
    reasonCode:'NO_EFFECT_OBSERVED',
    summary:'Caller-shaped no-effect assertion.',
    evidenceArtifactIds:['artifact:no-effect-job-retry'],
    verifiedAt:'2026-09-23T12:01:01.000Z',
    verifierId:'provider-observer',
    verificationAuthorityId:'policy:retry',
    effectId:claimed.executionOwnerships[0].effectId,
    executionId:leaseId,
    attempt:1,
  };
  await assert.rejects(() => manager.authorizeSpecialistSafeRetry('job-retry', {
    agentId,
    leaseId,
    verification,
  }), /trusted verifier provenance/);

  const durable = await manager.get('job-retry');
  assert.equal(durable.job.runtime.specialistHandoffs[0].state, 'LEASED');
  assert.equal(durable.job.runtime.specialistHandoffs[0].leaseId, leaseId);
  assert.equal(durable.job.runtime.specialistExecutionOwnerships[0].state, 'RECONCILE');
  assert.notEqual(durable.job.runtime.history.at(-1).type, 'specialist-handoff-safe-retry-authorized');

  const restarted = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }), now: () => clock + 2_000 });
  const beforeAdmission = await restarted.listSpecialistHandoffs('job-retry');
  assert.equal(beforeAdmission.handoffs[0].state, 'LEASED');
  const reclaimed = await restarted.claimSpecialistHandoffs('job-retry', { availableSlots:1, leaseSeconds:30 });
  assert.deepEqual(reclaimed.claimed, []);
  assert.equal(reclaimed.executionOwnerships[0].state, 'RECONCILE');
});

test('product-wide specialist admission is durable across Browser Agent jobs and restart', async () => {
  const chrome = makeChrome();
  const at = '2026-09-23T12:00:00.000Z';
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }), now: () => Date.parse(at) });
  for (const jobId of ['job-1', 'job-2']) {
    await manager.create({ id:jobId, goal:`Complete ${jobId}` });
    await manager.update(store => {
      store.byId[jobId].runtime.plan = {
        schemaVersion:1, planId:`plan-${jobId}`, jobId, objective:'Complete safely', successCriteria:['Verified'], createdAt:at, updatedAt:at, revision:1,
        nodes:[
          { nodeId:'inspect', title:'Inspect', objective:'Inspect page', dependsOn:[], conflictKeys:[`web:${jobId}`], ownerId:'parent', executionPlane:'BROWSER', acceptanceCriteria:[], budget:{}, state:'VERIFIED', evidence:'Observed', updatedAt:at },
          { nodeId:'archive', title:'Archive', objective:'Create archive', dependsOn:['inspect'], conflictKeys:[`files:${jobId}`], ownerId:'parent', executionPlane:'LOCAL', acceptanceCriteria:['Archive exists'], budget:{}, state:'PENDING', evidence:'', updatedAt:at },
        ],
      };
      return store;
    });
    await manager.prepareSpecialistHandoff(jobId, { nodeId:'archive', specialistId:'native-companion', requestedCapabilityIds:['filesystem.archive'], parentCapabilityIds:['filesystem.archive'], policyEnvelopeId:`policy:${jobId}`, deadlineAt:'2026-09-23T13:00:00.000Z' });
  }
  const first = await manager.claimSpecialistHandoffsAcrossJobs({ maxConcurrentHandoffs:1, leaseSeconds:60, at });
  assert.deepEqual(first.claimed.map(item => item.jobId), ['job-1']);
  assert.equal((await manager.listSpecialistHandoffs('job-2')).handoffs[0].state, 'READY');
  const restarted = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }), now: () => Date.parse('2026-09-23T12:00:30.000Z') });
  const afterRestart = await restarted.claimSpecialistHandoffsAcrossJobs({ maxConcurrentHandoffs:1, leaseSeconds:60, at:'2026-09-23T12:00:30.000Z' });
  assert.equal(afterRestart.claimed.length, 0, 'a restart must retain the product-wide lease fence');
  assert.equal((await restarted.listSpecialistHandoffs('job-2')).handoffs[0].state, 'READY');

  const afterExpiry = await restarted.claimSpecialistHandoffsAcrossJobs({
    maxConcurrentHandoffs:1,
    leaseSeconds:60,
    at:'2026-09-23T12:02:00.000Z',
  });
  assert.equal(afterExpiry.activeLeases, 0, 'expired lease labels are not the capacity authority');
  assert.equal(afterExpiry.capacityObligations, 1, 'unresolved canonical effect ownership still consumes one slot');
  assert.equal(afterExpiry.remainingSlots, 0);
  assert.equal(afterExpiry.claimed.length, 0, 'RECONCILE must block admitting another effectful specialist job');
  assert.deepEqual(afterExpiry.reconciliationRequired.map(item => item.jobId), ['job-1']);
  assert.equal((await restarted.listSpecialistHandoffs('job-1')).executionOwnerships[0].state, 'RECONCILE');
  assert.equal((await restarted.listSpecialistHandoffs('job-2')).handoffs[0].state, 'READY');
});

test('per-Agent AI routing is optional, isolated, and explicit provider overrides require an explicit model', () => {
  const inherited = config();
  assert.equal(inherited.aiRoutingMode, 'inherit');
  assert.equal(inherited.aiPrimaryProvider, 'inherit');
  assert.equal(inherited.aiStrongProvider, 'inherit');
  const overridden = config({
    aiRoutingMode: 'hybrid-auto',
    aiPrimaryProvider: 'ollama',
    aiPrimaryModel: 'qwen-local',
    aiStrongProvider: 'openai',
    aiStrongModel: 'gpt-strong',
  });
  assert.equal(overridden.aiRoutingMode, 'hybrid-auto');
  assert.equal(overridden.aiPrimaryProvider, 'ollama');
  assert.equal(overridden.aiPrimaryModel, 'qwen-local');
  assert.equal(overridden.aiStrongProvider, 'openai');
  assert.equal(overridden.aiStrongModel, 'gpt-strong');
  assert.throws(() => config({ aiPrimaryProvider: 'openai', aiPrimaryModel: '' }), /primary provider override requires an explicit primary model/);
  assert.throws(() => config({ aiStrongProvider: 'ollama', aiStrongModel: '' }), /strong provider override requires an explicit strong model/);
});

test('Browser Agent sends per-job router overrides with isolated durable router runtime', async () => {
  const chrome = makeChrome();
  const payloads = [];
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async payload => {
      payloads.push(structuredClone(payload));
      return {
        result: {
          text: JSON.stringify({ type: 'done', summary: 'routed' }),
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, modelCalls: 1 },
          runtime: { requestCount: 1, primaryCount: 0, strongCount: 1, lastRoute: 'strong', lastStrongAt: 1234, strongHistoryAt: [1234] },
        },
      };
    },
    now: () => 2000,
  });
  await manager.create({
    id: 'job-1', goal: 'Use the strong API model for this job',
    aiRoutingMode: 'strong', aiStrongProvider: 'openai', aiStrongModel: 'gpt-strong', stepDelayMs: 0,
  });
  await manager.start('job-1', { runInitial: false });
  const result = await manager.cycleOne('job-1');
  assert.equal(result.kind, 'COMPLETED');
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].isolatedRuntime, true);
  assert.equal(payloads[0].routerOverride.mode, 'strong');
  assert.equal(payloads[0].routerOverride.strong.provider, 'openai');
  assert.equal(payloads[0].routerOverride.strong.model, 'gpt-strong');
  const live = await manager.get('job-1');
  assert.equal(live.job.runtime.aiRouterRuntime.requestCount, 1);
  assert.equal(live.job.runtime.aiRouterRuntime.strongCount, 1);
  assert.equal(live.job.runtime.aiRouterRuntime.lastRoute, 'strong');
});

test('consequential approval is default policy and classifies multilingual final actions', () => {
  const value = config();
  assert.equal(value.approvalMode, BrowserAgentApprovalMode.CONSEQUENTIAL);
  const snapshot = { frames: [{ frameId: 0, elements: [
    { ref: 'r1', name: 'Potvrdiť zápis predmetov', href: '' },
    { ref: 'r2', name: 'Search', href: '' },
    { ref: 'r3', name: 'Save', href: '', submitLike: true },
  ] }] };
  assert.equal(classifyBrowserAgentActionRisk(snapshot, { type: 'click', frameId: 0, ref: 'r1' }).requiresApproval, true);
  assert.equal(classifyBrowserAgentActionRisk(snapshot, { type: 'click', frameId: 0, ref: 'r2' }).requiresApproval, false);
  assert.equal(classifyBrowserAgentActionRisk(snapshot, { type: 'click', frameId: 0, ref: 'r3' }).requiresApproval, true, 'neutral text still requires approval when the live control is a form submit');
});

test('fill_credential parser accepts only a current broker ref and current password field', () => {
  const snapshot = {
    url: 'https://ais.example.edu/login',
    frames: [{ frameId: 0, url: 'https://ais.example.edu/login', elements: [
      { ref: 'r1', tag: 'input', role: '', type: 'text', name: 'Username', sensitive: false },
      { ref: 'r2', tag: 'input', role: '', type: 'password', name: 'Password', sensitive: true },
      { ref: 'r3', tag: 'input', role: '', type: 'text', name: 'Other', sensitive: false },
    ] }],
    credentials: [{
      ref: 'c1', credentialId: 'ais-main', brokerId: 'native-companion', kind: 'username-password',
      scope: ['https://ais.example.edu'], expiresAt: null, targetOrigin: 'https://ais.example.edu', frameIds: [0],
    }],
  };
  const action = parseBrowserAgentAction(JSON.stringify({
    type: 'fill_credential',
    credentialRef: 'c1',
    usernameFrameId: 0,
    usernameRef: 'r1',
    passwordFrameId: 0,
    passwordRef: 'r2',
  }), snapshot);
  assert.equal(action.type, 'fill_credential');
  assert.equal(action.credentialId, 'ais-main');
  assert.equal(action.credentialOrigin, 'https://ais.example.edu');
  assert.equal(action.usernameRef, 'r1');
  assert.equal(action.passwordRef, 'r2');

  assert.throws(() => parseBrowserAgentAction(JSON.stringify({
    type: 'fill_credential',
    credentialRef: 'missing',
    passwordFrameId: 0,
    passwordRef: 'r2',
  }), snapshot), /credential outside the current snapshot/);

  assert.throws(() => parseBrowserAgentAction(JSON.stringify({
    type: 'fill_credential',
    credentialRef: 'c1',
    passwordFrameId: 0,
    passwordRef: 'r3',
  }), snapshot), /password target must be a current password input/);

  const crossOrigin = structuredClone(snapshot);
  crossOrigin.frames[0].url = 'https://login.other.example/sign-in';
  assert.throws(() => parseBrowserAgentAction(JSON.stringify({
    type: 'fill_credential',
    credentialRef: 'c1',
    passwordFrameId: 0,
    passwordRef: 'r2',
  }), crossOrigin), /not bound to the current password frame origin/);
});

test('credential discovery is scoped to the exact password frame origin, not the top-level page', async () => {
  const chrome = makeChrome();
  const listedOrigins = [];
  const nativeCompanionClient = {
    async listCredentials({ targetOrigin }) {
      listedOrigins.push(targetOrigin);
      return {
        credentialRefs: [{
          schemaVersion: 1,
          credentialId: 'login-main',
          brokerId: 'native-companion',
          kind: 'username-password',
          scope: ['https://login.example.edu'],
          expiresAt: null,
        }],
      };
    },
  };
  chrome.scripting.executeScript = async details => {
    if (details.func?.name !== 'snapshotBrowserPage') throw new Error(`unexpected script ${details.func?.name}`);
    const snapshotId = details.args[0];
    return [
      { frameId: 0, result: {
        snapshotId,
        url: 'https://ais.example.edu/app',
        title: 'Portal',
        text: 'Embedded sign in',
        elements: [],
        viewport: { width: 1280, height: 720, scrollY: 0, documentHeight: 900 },
      } },
      { frameId: 7, result: {
        snapshotId,
        url: 'https://login.example.edu/embed',
        title: 'Login',
        text: 'Sign in',
        elements: [{ ref: 'r1', tag: 'input', role: '', type: 'password', name: 'Password', sensitive: true }],
        viewport: { width: 640, height: 480, scrollY: 0, documentHeight: 600 },
      } },
    ];
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    nativeCompanionClient,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'done', summary: 'unused' }) }),
  });
  await manager.create({ id: 'job-1', goal: 'Inspect login', credentialDecision: 'ALLOW' });
  const live = await manager.get('job-1');
  const snapshot = await manager.collectSnapshot(1, live.job);
  assert.deepEqual(listedOrigins, ['https://login.example.edu']);
  assert.equal(snapshot.credentials.length, 1);
  assert.equal(snapshot.credentials[0].targetOrigin, 'https://login.example.edu');
  assert.deepEqual(snapshot.credentials[0].frameIds, [7]);
});

test('credential ALLOW runs autonomous login fill while keeping secret out of prompt and durable history', async () => {
  const chrome = makeChrome();
  const nativeCalls = [];
  const executionArgs = [];
  const secretValue = 'NeverExpose-123!';
  const usernameValue = 'owner@example.edu';
  const nativeCompanionClient = {
    async listCredentials({ targetOrigin }) {
      nativeCalls.push(['list', targetOrigin]);
      return {
        credentialRefs: [{
          schemaVersion: 1,
          credentialId: 'ais-main',
          brokerId: 'native-companion',
          kind: 'username-password',
          scope: ['https://ais.example.edu'],
          expiresAt: null,
        }],
      };
    },
    async resolveCredential(input) {
      nativeCalls.push(['resolve', structuredClone(input)]);
      return {
        credentialId: 'ais-main',
        kind: 'username-password',
        targetOrigin: input.targetOrigin,
        username: usernameValue,
        secret: secretValue,
      };
    },
  };
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: {
        snapshotId,
        url: 'https://ais.example.edu/login',
        title: 'AIS login',
        text: 'Sign in',
        elements: [
          { ref: 'r1', tag: 'input', role: '', type: 'text', name: 'Username', sensitive: false, editable: true },
          { ref: 'r2', tag: 'input', role: '', type: 'password', name: 'Password', sensitive: true, editable: false },
        ],
        viewport: { width: 1280, height: 720, scrollY: 0, documentHeight: 900 },
      } }];
    }
    if (details.func?.name === 'executeBrowserCredentialFill') {
      executionArgs.push(structuredClone(details.args));
      return [{ frameId: 0, result: { ok: true, usernameFilled: true, passwordFilled: true, url: 'https://ais.example.edu/login' } }];
    }
    return original(details);
  };

  const prompts = [];
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    nativeCompanionClient,
    routePrompt: async payload => {
      prompts.push(structuredClone(payload));
      return {
        text: JSON.stringify({
          type: 'fill_credential',
          credentialRef: 'c1',
          usernameFrameId: 0,
          usernameRef: 'r1',
          passwordFrameId: 0,
          passwordRef: 'r2',
        }),
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, modelCalls: 1 },
      };
    },
    now: (() => { let n = 140_000; return () => ++n; })(),
  });

  await manager.create({
    id: 'job-1',
    goal: 'Log in autonomously',
    approvalMode: 'ALLOW_ALL',
    credentialDecision: 'ALLOW',
    stepDelayMs: 0,
  });
  await manager.start('job-1', { runInitial: false });
  const result = await manager.cycleOne('job-1');
  assert.equal(result.kind, 'ACTION');
  assert.deepEqual(nativeCalls, [
    ['list', 'https://ais.example.edu'],
    ['resolve', { credentialId: 'ais-main', targetOrigin: 'https://ais.example.edu' }],
  ]);
  assert.equal(executionArgs.length, 1);
  assert.equal(executionArgs[0][2], usernameValue);
  assert.equal(executionArgs[0][3], secretValue);

  const promptText = JSON.stringify(prompts);
  assert.equal(promptText.includes(secretValue), false, 'secret must never enter model prompt');
  assert.equal(promptText.includes(usernameValue), false, 'username remains behind credential execution boundary');
  assert.match(promptText, /ais-main/);

  const live = await manager.get('job-1');
  const history = JSON.stringify(live.job.runtime.history);
  assert.equal(history.includes(secretValue), false, 'secret must never enter durable history');
  assert.equal(history.includes(usernameValue), false, 'resolved username must never enter durable history');
  assert.match(history, /fill_credential/);
  assert.match(history, /ais-main/);
});

test('credential ASK waits for owner confirmation before broker resolve and then executes exactly once', async () => {
  const chrome = makeChrome();
  let resolveCalls = 0;
  let credentialExecutions = 0;
  const nativeCompanionClient = {
    async listCredentials() {
      return {
        credentialRefs: [{
          schemaVersion: 1,
          credentialId: 'ais-main',
          brokerId: 'native-companion',
          kind: 'username-password',
          scope: ['https://ais.example.edu'],
          expiresAt: null,
        }],
      };
    },
    async resolveCredential(input) {
      resolveCalls += 1;
      return {
        credentialId: input.credentialId,
        kind: 'username-password',
        targetOrigin: input.targetOrigin,
        username: 'owner@example.edu',
        secret: 'approval-secret',
      };
    },
  };
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: {
        snapshotId,
        url: 'https://ais.example.edu/app',
        title: 'AIS',
        text: 'Login',
        elements: [
          { ref: 'r1', tag: 'input', role: '', type: 'text', name: 'Username', sensitive: false, editable: true },
          { ref: 'r2', tag: 'input', role: '', type: 'password', name: 'Password', sensitive: true, editable: false },
        ],
        viewport: { width: 1280, height: 720, scrollY: 0, documentHeight: 900 },
      } }];
    }
    if (details.func?.name === 'executeBrowserCredentialFill') {
      credentialExecutions += 1;
      return [{ frameId: 0, result: { ok: true, usernameFilled: true, passwordFilled: true, url: 'https://ais.example.edu/app' } }];
    }
    return original(details);
  };

  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    nativeCompanionClient,
    routePrompt: async () => ({
      text: JSON.stringify({
        type: 'fill_credential',
        credentialRef: 'c1',
        usernameFrameId: 0,
        usernameRef: 'r1',
        passwordFrameId: 0,
        passwordRef: 'r2',
      }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 },
    }),
    now: (() => { let n = 150_000; return () => ++n; })(),
  });

  await manager.create({ id: 'job-1', goal: 'Log in', credentialDecision: 'ASK', stepDelayMs: 0 });
  await manager.start('job-1', { runInitial: false });
  const first = await manager.cycleOne('job-1');
  assert.equal(first.kind, 'WAITING_APPROVAL');
  assert.equal(resolveCalls, 0, 'ASK must not decrypt before approval');
  assert.equal(credentialExecutions, 0);

  await manager.approvePendingAction('job-1', { runInitial: false });
  assert.equal(resolveCalls, 1);
  assert.equal(credentialExecutions, 1);
  const live = await manager.get('job-1');
  assert.equal(live.job.runtime.runState, 'RUNNING');
  assert.equal(JSON.stringify(live.job.runtime.history).includes('approval-secret'), false);
});

test('credential resolve is discarded if page origin changes before secret insertion', async () => {
  const chrome = makeChrome();
  let credentialExecutions = 0;
  const nativeCompanionClient = {
    async listCredentials() {
      return { credentialRefs: [{
        schemaVersion: 1,
        credentialId: 'ais-main',
        brokerId: 'native-companion',
        kind: 'username-password',
        scope: ['https://ais.example.edu'],
        expiresAt: null,
      }] };
    },
    async resolveCredential(input) {
      chrome._tabs.get(1).url = 'https://evil.example/phish';
      return {
        credentialId: input.credentialId,
        kind: 'username-password',
        targetOrigin: input.targetOrigin,
        username: 'owner@example.edu',
        secret: 'must-not-be-inserted',
      };
    },
  };
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: {
        snapshotId,
        url: 'https://ais.example.edu/app',
        title: 'AIS',
        text: 'Login',
        elements: [
          { ref: 'r1', tag: 'input', role: '', type: 'text', name: 'Username', sensitive: false, editable: true },
          { ref: 'r2', tag: 'input', role: '', type: 'password', name: 'Password', sensitive: true, editable: false },
        ],
        viewport: { width: 1280, height: 720, scrollY: 0, documentHeight: 900 },
      } }];
    }
    if (details.func?.name === 'executeBrowserCredentialFill') {
      credentialExecutions += 1;
      return [{ frameId: 0, result: { ok: true, passwordFilled: true } }];
    }
    return original(details);
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    nativeCompanionClient,
    routePrompt: async () => ({
      text: JSON.stringify({
        type: 'fill_credential',
        credentialRef: 'c1',
        usernameFrameId: 0,
        usernameRef: 'r1',
        passwordFrameId: 0,
        passwordRef: 'r2',
      }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 },
    }),
    now: (() => { let n = 160_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Login only to AIS', credentialDecision: 'ALLOW', approvalMode: 'ALLOW_ALL', stepDelayMs: 0 });
  await manager.start('job-1', { runInitial: false });
  const result = await manager.cycleOne('job-1');
  assert.equal(result.kind, 'ACTION_RETRY');
  assert.equal(credentialExecutions, 0, 'stale origin must block credential insertion');
  const live = await manager.get('job-1');
  assert.match(live.job.runtime.lastError, /AGENT_CREDENTIAL_ORIGIN_STALE/);
  assert.equal(JSON.stringify(live.job.runtime.history).includes('must-not-be-inserted'), false);
});

test('credential resolve is discarded if the password frame origin changes while the top-level page stays stable', async () => {
  const chrome = makeChrome();
  let frameUrl = 'https://login.example.edu/embed';
  let credentialExecutions = 0;
  const nativeCalls = [];
  const secretValue = 'cross-origin-secret-must-not-leak';
  const nativeCompanionClient = {
    async listCredentials({ targetOrigin }) {
      nativeCalls.push(['list', targetOrigin]);
      return { credentialRefs: [{
        schemaVersion: 1,
        credentialId: 'login-main',
        brokerId: 'native-companion',
        kind: 'username-password',
        scope: ['https://login.example.edu'],
        expiresAt: null,
      }] };
    },
    async resolveCredential(input) {
      nativeCalls.push(['resolve', structuredClone(input)]);
      frameUrl = 'https://evil.example/phish';
      return {
        credentialId: input.credentialId,
        kind: 'username-password',
        targetOrigin: input.targetOrigin,
        username: 'owner@example.edu',
        secret: secretValue,
      };
    },
  };
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [
        { frameId: 0, result: {
          snapshotId,
          url: 'https://ais.example.edu/app',
          title: 'Portal',
          text: 'Embedded sign in',
          elements: [],
          viewport: { width: 1280, height: 720, scrollY: 0, documentHeight: 900 },
        } },
        { frameId: 7, result: {
          snapshotId,
          url: frameUrl,
          title: 'Login',
          text: 'Sign in',
          elements: [{ ref: 'r2', tag: 'input', role: '', type: 'password', name: 'Password', sensitive: true, editable: false }],
          viewport: { width: 640, height: 480, scrollY: 0, documentHeight: 600 },
        } },
      ];
    }
    if (details.func?.name === 'readBrowserCredentialFrameOrigin') {
      return [{ frameId: 7, result: { url: frameUrl, origin: new URL(frameUrl).origin } }];
    }
    if (details.func?.name === 'executeBrowserCredentialFill') {
      credentialExecutions += 1;
      return [{ frameId: 7, result: { ok: true, passwordFilled: true, url: frameUrl } }];
    }
    return original(details);
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    nativeCompanionClient,
    routePrompt: async () => ({
      text: JSON.stringify({
        type: 'fill_credential',
        credentialRef: 'c1',
        passwordFrameId: 7,
        passwordRef: 'r2',
      }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 },
    }),
    now: (() => { let n = 170_000; return () => ++n; })(),
  });
  await manager.create({
    id: 'job-1',
    goal: 'Use the embedded login',
    credentialDecision: 'ALLOW',
    approvalMode: 'ALLOW_ALL',
    stepDelayMs: 0,
  });
  await manager.start('job-1', { runInitial: false });
  const result = await manager.cycleOne('job-1');
  assert.equal(result.kind, 'ACTION_RETRY');
  assert.deepEqual(nativeCalls, [
    ['list', 'https://login.example.edu'],
    ['resolve', { credentialId: 'login-main', targetOrigin: 'https://login.example.edu' }],
  ]);
  assert.equal(chrome._tabs.get(1).url, 'https://ais.example.edu/app', 'top-level page must remain unchanged in this regression');
  assert.equal(credentialExecutions, 0, 'changed password-frame origin must block secret insertion');
  const live = await manager.get('job-1');
  assert.match(live.job.runtime.lastError, /AGENT_CREDENTIAL_ORIGIN_STALE/);
  assert.equal(JSON.stringify(live.job.runtime.history).includes(secretValue), false);
});

test('owner site policy overrides global autonomy and supports credentials independently', () => {
  const value = config({
    approvalMode: 'ALLOW_ALL',
    credentialDecision: 'ALLOW',
    siteRules: [
      { pattern: '*.example.edu', defaultDecision: 'ASK', actionDecisions: { trusted_script: 'DENY', credentials: 'ASK' } },
      { pattern: 'ais.example.edu', defaultDecision: 'ALLOW', actionDecisions: { upload_download: 'DENY', credentials: 'ALLOW' } },
    ],
  });
  assert.equal(value.credentialDecision, BrowserAgentPolicyDecision.ALLOW);
  assert.deepEqual(value.siteRules, normalizeBrowserAgentSiteRules(value.siteRules));
  const snapshot = { url: 'https://ais.example.edu/app', frames: [] };
  assert.equal(resolveBrowserAgentOwnerPolicy(value, snapshot, { type: 'click' }, { requiresApproval: true }).decision, BrowserAgentPolicyDecision.ALLOW);
  assert.equal(resolveBrowserAgentOwnerPolicy(value, snapshot, { type: 'upload_download' }, { requiresApproval: true }).decision, BrowserAgentPolicyDecision.DENY);
  assert.equal(resolveBrowserAgentCredentialPolicy(value, snapshot.url).decision, BrowserAgentPolicyDecision.ALLOW);

  const wildcardSnapshot = { url: 'https://other.example.edu/app', frames: [] };
  assert.equal(resolveBrowserAgentOwnerPolicy(value, wildcardSnapshot, { type: 'click' }, { requiresApproval: false }).decision, BrowserAgentPolicyDecision.ASK);
  assert.equal(resolveBrowserAgentOwnerPolicy(value, wildcardSnapshot, { type: 'trusted_script' }, { requiresApproval: true }).decision, BrowserAgentPolicyDecision.DENY);
  assert.equal(resolveBrowserAgentCredentialPolicy(value, wildcardSnapshot.url).decision, BrowserAgentPolicyDecision.ASK);
});

test('site policy governs destination for navigate, new-tab and visible link clicks', () => {
  const value = config({
    approvalMode: 'ALLOW_ALL',
    siteRules: [
      { pattern: 'blocked.example', defaultDecision: 'DENY', actionDecisions: {} },
      { pattern: 'ask.example', defaultDecision: 'ASK', actionDecisions: {} },
    ],
  });
  const source = {
    url: 'https://allowed.example/start',
    frames: [{ frameId: 0, elements: [
      { ref: 'r1', tag: 'a', name: 'Blocked destination', href: 'https://blocked.example/next' },
    ] }],
  };
  const nav = resolveBrowserAgentOwnerPolicy(value, source, { type: 'navigate', url: 'https://blocked.example/path' });
  assert.equal(nav.decision, BrowserAgentPolicyDecision.DENY);
  assert.match(nav.policyUrl, /blocked\.example/);

  const tab = resolveBrowserAgentOwnerPolicy(value, source, { type: 'new_tab', url: 'https://ask.example/path' });
  assert.equal(tab.decision, BrowserAgentPolicyDecision.ASK);

  const click = resolveBrowserAgentOwnerPolicy(value, source, { type: 'click', frameId: 0, ref: 'r1' });
  assert.equal(click.decision, BrowserAgentPolicyDecision.DENY);
});

test('site policy validation rejects ambiguous duplicates and unsupported action keys', () => {
  assert.throws(() => config({ siteRules: [
    { pattern: 'example.com', defaultDecision: 'ALLOW' },
    { pattern: 'example.com', defaultDecision: 'DENY' },
  ] }), /Duplicate Browser Agent site policy/);
  assert.throws(() => config({ siteRules: [
    { pattern: 'example.com', defaultDecision: 'ALLOW', actionDecisions: { arbitrary_shell: 'ALLOW' } },
  ] }), /Unsupported Browser Agent policy action/);
});

test('vision coordinate click is allowed only for the screenshot turn and stays inside the current viewport', () => {
  const base = { frames: [{ frameId: 0, viewport: { width: 1000, height: 600 }, elements: [] }] };
  assert.throws(
    () => parseBrowserAgentAction(JSON.stringify({ type: 'click_at', x: 400, y: 250 }), base),
    /requires a screenshot attached to this exact reasoning turn/,
  );
  const vision = { ...base, visionAttached: true, visionViewport: { width: 1000, height: 600 } };
  assert.deepEqual(parseBrowserAgentAction(JSON.stringify({ type: 'click_at', x: 400.25, y: 250.75 }), vision), { type: 'click_at', x: 400.3, y: 250.8 });
  assert.throws(
    () => parseBrowserAgentAction(JSON.stringify({ type: 'click_at', x: 1000, y: 250 }), vision),
    /outside the current visible viewport/,
  );
});

test('coordinate click risk reuses live semantics and fails closed for visual-only targets', () => {
  const snapshot = { frames: [{ frameId: 0, elements: [] }] };
  const benign = { type: 'click_at', x: 10, y: 10, coordinateTarget: { tag: 'button', name: 'Open details', href: '', submitLike: false, formAssociated: false, visualOnly: false } };
  const submit = { type: 'click_at', x: 20, y: 20, coordinateTarget: { tag: 'button', name: 'Save', href: '', submitLike: true, formAssociated: true, visualOnly: false } };
  const canvas = { type: 'click_at', x: 30, y: 30, coordinateTarget: { tag: 'canvas', name: '', href: '', submitLike: false, formAssociated: false, visualOnly: true } };
  assert.equal(classifyBrowserAgentActionRisk(snapshot, benign).requiresApproval, false);
  assert.equal(classifyBrowserAgentActionRisk(snapshot, submit).requiresApproval, true);
  assert.equal(classifyBrowserAgentActionRisk(snapshot, canvas).requiresApproval, true);
});

test('vision coordinate drag is screenshot-turn-only, viewport-bounded and always consequential by default', () => {
  const base = { frames: [{ frameId: 0, viewport: { width: 1000, height: 600 }, elements: [] }] };
  assert.throws(
    () => parseBrowserAgentAction(JSON.stringify({ type: 'drag_at', startX: 100, startY: 100, endX: 500, endY: 300 }), base),
    /requires a screenshot attached to this exact reasoning turn/,
  );
  const vision = { ...base, visionAttached: true, visionViewport: { width: 1000, height: 600 } };
  assert.deepEqual(
    parseBrowserAgentAction(JSON.stringify({ type: 'drag_at', startX: 100.25, startY: 100.75, endX: 500.15, endY: 300.85, durationMs: 700 }), vision),
    { type: 'drag_at', startX: 100.3, startY: 100.8, endX: 500.2, endY: 300.9, durationMs: 700 },
  );
  assert.throws(
    () => parseBrowserAgentAction(JSON.stringify({ type: 'drag_at', startX: 100, startY: 100, endX: 1000, endY: 300 }), vision),
    /outside the current visible viewport/,
  );
  assert.throws(
    () => parseBrowserAgentAction(JSON.stringify({ type: 'drag_at', startX: 100, startY: 100, endX: 101, endY: 101 }), vision),
    /distinct start\/end coordinates/,
  );
  const risk = classifyBrowserAgentActionRisk(vision, {
    type: 'drag_at',
    coordinateStartTarget: { tag: 'div', name: 'Course A', visualOnly: true },
    coordinateEndTarget: { tag: 'div', name: 'Monday 10:00', visualOnly: true },
  });
  assert.equal(risk.requiresApproval, true);
  assert.match(risk.reason, /drag\/drop/i);
});

test('vision coordinate typing is screenshot-turn-only and visual-only targets require approval', () => {
  const base = { frames: [{ frameId: 0, viewport: { width: 1000, height: 600 }, elements: [] }] };
  assert.throws(
    () => parseBrowserAgentAction(JSON.stringify({ type: 'type_at', x: 400, y: 250, text: 'Course note' }), base),
    /requires a screenshot attached to this exact reasoning turn/,
  );
  const vision = { ...base, visionAttached: true, visionViewport: { width: 1000, height: 600 } };
  assert.deepEqual(
    parseBrowserAgentAction(JSON.stringify({ type: 'type_at', x: 400.25, y: 250.75, text: 'Course note' }), vision),
    { type: 'type_at', x: 400.3, y: 250.8, text: 'Course note' },
  );
  assert.throws(
    () => parseBrowserAgentAction(JSON.stringify({ type: 'type_at', x: 400, y: 250, text: '' }), vision),
    /requires non-empty text/,
  );
  const semantic = { type: 'type_at', x: 10, y: 10, text: 'A', coordinateTarget: { tag: 'textarea', name: 'Note', editable: true, sensitive: false, visualOnly: false } };
  const visual = { type: 'type_at', x: 20, y: 20, text: 'A', coordinateTarget: { tag: 'div', name: 'Custom editor', editable: false, sensitive: false, visualOnly: true } };
  assert.equal(classifyBrowserAgentActionRisk(vision, semantic).requiresApproval, false);
  assert.equal(classifyBrowserAgentActionRisk(vision, visual).requiresApproval, true);
});


test('Enter/Space activation keys require an exact snapshot target and Enter on a form cannot bypass approval', () => {
  const snapshot = { frames: [{ frameId: 0, elements: [
    { ref: 'r1', tag: 'input', role: '', type: 'text', name: 'Course code', formAssociated: true, formAction: 'https://ais.example.edu/save', formMethod: 'post' },
    { ref: 'r2', tag: 'button', role: '', type: 'button', name: 'Open details', formAssociated: false },
  ] }] };
  assert.throws(() => parseBrowserAgentAction(JSON.stringify({ type: 'key', key: 'Enter' }), snapshot), /requires an exact current snapshot/);
  const enter = parseBrowserAgentAction(JSON.stringify({ type: 'key', key: 'Enter', frameId: 0, ref: 'r1' }), snapshot);
  assert.equal(enter.ref, 'r1');
  assert.equal(classifyBrowserAgentActionRisk(snapshot, enter).requiresApproval, true, 'Enter in a form must not bypass consequential approval');
  const space = parseBrowserAgentAction(JSON.stringify({ type: 'key', key: 'Space', frameId: 0, ref: 'r2' }), snapshot);
  assert.equal(classifyBrowserAgentActionRisk(snapshot, space).requiresApproval, false, 'benign targeted Space remains autonomous');
  assert.doesNotThrow(() => parseBrowserAgentAction(JSON.stringify({ type: 'key', key: 'Tab' }), snapshot), 'navigation-only keys may remain untargeted');
});

test('approved Enter focuses the exact approved form control before native key dispatch', async () => {
  const chrome = makeChrome();
  let focused = 0;
  const keyCommands = [];
  const originalScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: {
        snapshotId, url: 'https://ais.example.edu/app', title: 'AIS', text: 'Course form',
        elements: [{ ref: 'r1', tag: 'input', role: '', type: 'text', name: 'Course code', formAssociated: true, formAction: 'https://ais.example.edu/save', formMethod: 'post' }],
      } }];
    }
    if (details.func?.name === 'focusBrowserAgentTarget') { focused += 1; return [{ frameId: 0, result: { ok: true } }]; }
    return originalScript(details);
  };
  chrome.debugger = {
    async attach() {},
    async sendCommand(_target, method, params) { keyCommands.push([method, params]); return {}; },
    async detach() {},
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'key', key: 'Enter', frameId: 0, ref: 'r1' }), usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, modelCalls: 1 } }),
  });
  await manager.create({ id: 'job-1', goal: 'Submit the form only after approval' });
  await manager.start('job-1', { runInitial: false });
  assert.equal((await manager.cycleOne('job-1')).kind, 'WAITING_APPROVAL');
  assert.equal(keyCommands.length, 0, 'Enter must not dispatch before approval');
  await manager.approvePendingAction('job-1', { runInitial: false });
  assert.equal(focused, 1, 'approved key must focus the exact snapshot target first');
  assert.equal(keyCommands.filter(([method]) => method === 'Input.dispatchKeyEvent').length, 2);
});

test('consequential click pauses before physical action and explicit approval executes exact pending action', async () => {
  const chrome = makeChrome();
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: {
        snapshotId,
        url: 'https://ais.example.edu/app',
        title: 'AIS',
        text: 'Final registration',
        elements: [{ ref: 'r1', tag: 'button', role: '', type: 'submit', name: 'Confirm enrollment', submitLike: true }],
      } }];
    }
    return original(details);
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1' }), usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, modelCalls: 1 } }),
  });
  await manager.create({ id: 'job-1', goal: 'Prepare and confirm enrollment only after owner approval' });
  await manager.start('job-1', { runInitial: false });
  const result = await manager.cycleOne('job-1');
  let live = await manager.get('job-1');
  assert.equal(result.kind, 'WAITING_APPROVAL');
  assert.equal(live.job.runtime.runState, 'WAITING_APPROVAL');
  assert.equal(chrome._actionCalls.length, 0, 'consequential click must not execute before approval');
  assert.equal(live.job.runtime.pendingApproval.targetName, 'Confirm enrollment');
  await manager.approvePendingAction('job-1', { runInitial: false });
  live = await manager.get('job-1');
  assert.equal(chrome._actionCalls.length, 1, 'approved exact action should execute once');
  assert.equal(live.job.runtime.runState, 'RUNNING');
  assert.equal(live.job.runtime.pendingApproval, null);
  assert.equal(live.job.runtime.stepCount, 1);
});

test('approved submit click is never automatically repeated by native fallback on an unchanged page', async () => {
  const chrome = makeChrome();
  const nativeCommands = [];
  chrome.debugger = {
    async attach() {},
    async sendCommand(_target, method, params) { nativeCommands.push([method, params]); return {}; },
    async detach() {},
  };
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: {
        snapshotId,
        url: 'https://ais.example.edu/app',
        title: 'AIS',
        text: 'Unchanged form after async submit',
        elements: [{ ref: 'r1', tag: 'button', role: '', type: 'submit', name: 'Save', submitLike: true }],
      } }];
    }
    return original(details);
  };
  const replies = [
    { text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1' }), usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'done', summary: 'Submission click was issued once' }), usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, modelCalls: 1 } },
  ];
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => replies.shift(), now: (() => { let n = 50_000; return () => ++n; })() });
  await manager.create({ id: 'job-1', goal: 'Save this form once after approval' });
  await manager.start('job-1', { runInitial: false });
  const pending = await manager.cycleOne('job-1');
  assert.equal(pending.kind, 'WAITING_APPROVAL');
  await manager.approvePendingAction('job-1', { runInitial: false });
  let live = await manager.get('job-1');
  assert.equal(chrome._actionCalls.length, 1);
  assert.equal(live.job.runtime.nativeFallbackTried, true, 'approved submit must mark fallback consumed to prevent duplicate physical submit');

  const final = await manager.cycleOne('job-1');
  live = await manager.get('job-1');
  assert.equal(final.kind, 'COMPLETED');
  assert.equal(chrome._actionCalls.length, 1, 'DOM submit must execute exactly once');
  assert.equal(nativeCommands.filter(([method]) => method === 'Input.dispatchMouseEvent').length, 0, 'no second native submit is allowed after owner approval');
});

test('snapshot signature observes filled state changes but ignores out-of-page notify semantics', () => {
  const base = { url: 'https://ais.example.edu/app', frames: [{ frameId: 0, url: 'https://ais.example.edu/app', text: 'Form', elements: [{ tag: 'input', role: '', type: 'text', name: 'Course', filled: false, disabled: false }] }] };
  const filled = structuredClone(base);
  filled.frames[0].elements[0].filled = true;
  assert.notEqual(browserSnapshotSignature(base), browserSnapshotSignature(filled));
});

test('pending approval preserves full form fingerprint across manager restart', async () => {
  const chrome = makeChrome();
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: {
        snapshotId, url: 'https://ais.example.edu/app', title: 'AIS', text: 'Final form',
        elements: [{ ref: 'r1', tag: 'button', role: '', type: 'submit', name: 'Save', submitLike: true, formAssociated: true, formAction: 'https://ais.example.edu/enrollment/save', formMethod: 'post' }],
      } }];
    }
    return original(details);
  };
  const routePrompt = async () => ({ text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1' }), usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, modelCalls: 1 } });
  const first = new BrowserAgentManager({ chromeApi: chrome, routePrompt });
  await first.create({ id: 'job-1', goal: 'Save after approval' });
  await first.start('job-1', { runInitial: false });
  assert.equal((await first.cycleOne('job-1')).kind, 'WAITING_APPROVAL');
  const before = (await first.get('job-1')).job.runtime.pendingApproval.targetFingerprint;
  assert.equal(before.formAction, 'https://ais.example.edu/enrollment/save');
  assert.equal(before.formMethod, 'post');
  assert.equal(before.formAssociated, true);

  const restarted = new BrowserAgentManager({ chromeApi: chrome, routePrompt });
  const after = (await restarted.get('job-1')).job.runtime.pendingApproval.targetFingerprint;
  assert.deepEqual(after, before, 'restart must not weaken the approved form identity');
  await restarted.approvePendingAction('job-1', { runInitial: false });
  assert.equal((await restarted.get('job-1')).job.runtime.stepCount, 1);
});

test('approval fails closed when the live target fingerprint changes before owner confirmation', async () => {
  const chrome = makeChrome();
  let changed = false;
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: {
        snapshotId, url: 'https://ais.example.edu/app', title: 'AIS', text: 'Final registration',
        elements: [{ ref: 'r1', tag: 'button', role: '', type: 'submit', name: 'Save', submitLike: true }],
      } }];
    }
    if (details.func?.name === 'verifyBrowserApprovalTarget') {
      return [{ frameId: 0, result: changed ? { ok: false, reason: 'target-fingerprint-changed' } : { ok: true } }];
    }
    return original(details);
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1' }), usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, modelCalls: 1 } }),
    now: (() => { let n = 55_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Save only the exact control I approve' });
  await manager.start('job-1', { runInitial: false });
  assert.equal((await manager.cycleOne('job-1')).kind, 'WAITING_APPROVAL');
  changed = true;
  await manager.approvePendingAction('job-1', { runInitial: false });
  const live = await manager.get('job-1');
  assert.equal(live.job.runtime.runState, 'PAUSED');
  assert.equal(live.job.runtime.pendingApproval, null);
  assert.equal(chrome._actionCalls.length, 0, 'stale approved target must never execute');
  assert.match(live.job.runtime.lastError, /target control changed/);
});

test('rejecting consequential action pauses agent and never executes pending click', async () => {
  const chrome = makeChrome();
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: {
        snapshotId, url: 'https://ais.example.edu/app', title: 'AIS', text: 'Final',
        elements: [{ ref: 'r1', tag: 'button', role: '', type: 'submit', name: 'Odoslať prihlášku', submitLike: true }],
      } }];
    }
    return original(details);
  };
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1' }) }) });
  await manager.create({ id: 'job-1', goal: 'Fill application' });
  await manager.start('job-1', { runInitial: false });
  await manager.cycleOne('job-1');
  await manager.rejectPendingAction('job-1');
  const live = await manager.get('job-1');
  assert.equal(live.job.runtime.runState, 'PAUSED');
  assert.equal(live.job.runtime.pendingApproval, null);
  assert.equal(chrome._actionCalls.length, 0);
  assert.match(live.job.runtime.lastError, /Owner rejected consequential action/);
});

test('ALLOW_ALL approval policy keeps fully autonomous click execution available', async () => {
  const chrome = makeChrome();
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: {
        snapshotId, url: 'https://ais.example.edu/app', title: 'AIS', text: 'Final',
        elements: [{ ref: 'r1', tag: 'button', role: '', type: 'submit', name: 'Confirm enrollment', submitLike: true }],
      } }];
    }
    return original(details);
  };
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1' }) }) });
  await manager.create({ id: 'job-1', goal: 'Autonomously confirm enrollment', approvalMode: 'ALLOW_ALL' });
  await manager.start('job-1', { runInitial: false });
  const result = await manager.cycleOne('job-1');
  const live = await manager.get('job-1');
  assert.equal(result.kind, 'ACTION');
  assert.equal(live.job.runtime.runState, 'RUNNING');
  assert.equal(chrome._actionCalls.length, 1);
});

test('monetary budget is rejected when no token pricing exists', () => {
  assert.throws(() => config({ maxCostUsd: 5 }), /requires input and\/or output token pricing/);
});

test('owner outcome contract is normalized and completion evidence must bind every criterion to the fresh snapshot', () => {
  const config = normalizeBrowserAgentConfig({ id: 'job-contract', goal: 'Verify selected course', acceptanceCriteria: ['The selected course is visible', 'The timetable has no conflict'] });
  assert.deepEqual(config.acceptanceCriteria, ['The selected course is visible', 'The timetable has no conflict']);
  assert.throws(() => normalizeBrowserAgentConfig({ id: 'job-contract', goal: 'x', acceptanceCriteria: ['same', 'Same'] }), /Duplicate Browser Agent acceptance criterion/);
  const snapshot = { url: 'https://ais.example.edu/app', frames: [{ frameId: 0, url: 'https://ais.example.edu/app', text: 'Course A selected; no conflicts', elements: [] }] };
  const signature = browserSnapshotSignature(snapshot);
  const complete = { type: 'done', evidence: { snapshotSignature: signature, checks: [{ criterion: 1, detail: 'Course A is selected.' }, { criterion: 2, detail: 'No conflict marker is present.' }] } };
  assert.equal(verifyBrowserAgentOutcomeEvidence(config, complete, snapshot).ok, true);
  assert.match(verifyBrowserAgentOutcomeEvidence(config, { ...complete, evidence: { ...complete.evidence, checks: [complete.evidence.checks[0]] } }, snapshot).reason, /incomplete/);
  assert.match(verifyBrowserAgentOutcomeEvidence(config, { ...complete, evidence: { ...complete.evidence, snapshotSignature: 'stale' } }, snapshot).reason, /current semantic page snapshot/);
});

test('Browser Agent does not complete an explicit outcome contract on model assertion alone', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'done', summary: 'I think it is complete' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }),
  });
  await manager.create({ id: 'job-contract', goal: 'Verify course', acceptanceCriteria: ['Course A is selected'] });
  await manager.start('job-contract', { runInitial: false });
  await manager.cycleOne('job-contract');
  const live = await manager.get('job-contract');
  assert.equal(live.job.runtime.runState, 'RUNNING');
  assert.equal(live.job.runtime.completedAt, 0);
  assert.match(live.job.runtime.lastError, /Outcome contract requires evidence/);
});

test('Browser Agent requires a separate read-only verifier before completing an explicit outcome contract', async () => {
  const chrome = makeChrome();
  let verifierCalls = 0;
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async payload => {
      if (payload.systemPrompt.startsWith('Return only a read-only Browser Agent outcome-verification')) {
        verifierCalls += 1;
        return { text: JSON.stringify({ verified: true, checks: [{ criterion: 1, detail: 'Current semantic page shows page version 0.' }] }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } };
      }
      const marker = 'CURRENT SNAPSHOT:\n';
      const snapshot = JSON.parse(payload.prompt.slice(payload.prompt.lastIndexOf(marker) + marker.length));
      return { text: JSON.stringify({ type: 'done', summary: 'Verified', evidence: { snapshotSignature: browserSnapshotSignature(snapshot), checks: [{ criterion: 1, detail: 'page version 0' }] } }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } };
    },
  });
  await manager.create({ id: 'job-contract-independent', goal: 'Verify page', acceptanceCriteria: ['The current page is observed'] });
  await manager.start('job-contract-independent', { runInitial: false });
  const result = await manager.cycleOne('job-contract-independent');
  const live = await manager.get('job-contract-independent');
  assert.equal(result.kind, 'COMPLETED');
  assert.equal(verifierCalls, 1);
  assert.equal(live.job.runtime.verifiedOutcome.checks[0].detail, 'Current semantic page shows page version 0.');
  assert.equal(live.job.runtime.modelCalls, 2);
});

test('Browser Agent persists a planner-proposed DAG without treating planning as a browser effect', async () => {
  const chrome = makeChrome();
  const at = new Date().toISOString();
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'plan', plan: {
      schemaVersion: 1, planId: 'plan-1', jobId: 'job-plan', objective: 'Inspect course', successCriteria: ['Course is visible'], createdAt: at, updatedAt: at, revision: 1,
      nodes: [{ nodeId: 'inspect', title: 'Inspect course', objective: 'Read the course page', dependsOn: [], conflictKeys: ['ais-page'], ownerId: 'browser-agent', executionPlane: 'BROWSER', acceptanceCriteria: ['Course text observed'], budget: {}, state: 'PENDING', evidence: '', updatedAt: at }],
    } }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }),
  });
  await manager.create({ id: 'job-plan', goal: 'Inspect course' });
  await manager.start('job-plan', { runInitial: false });
  const result = await manager.cycleOne('job-plan');
  const live = await manager.get('job-plan');
  assert.equal(result.kind, 'PLAN_UPDATED');
  assert.equal(live.job.runtime.plan.nodes[0].state, 'READY');
  assert.equal(live.job.runtime.stepCount, 0);
});

test('Browser Agent independently verifies a READY Browser plan node and unblocks durable completion', async () => {
  const chrome = makeChrome();
  const at = new Date().toISOString();
  let phase = 0;
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async payload => {
      if (payload.systemPrompt.startsWith('Return only a read-only Browser Agent outcome-verification')) {
        return { text: JSON.stringify({ verified: true, checks: [{ criterion: 1, detail: 'page version 0 is visible in the current semantic snapshot.' }] }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } };
      }
      if (phase++ === 0) return { text: JSON.stringify({ type: 'plan', plan: {
        schemaVersion: 1, planId: 'plan-node', jobId: 'job-plan-node', objective: 'Inspect page', successCriteria: ['Page inspected'], createdAt: at, updatedAt: at, revision: 1,
        nodes: [{ nodeId: 'inspect', title: 'Inspect page', objective: 'Read the page', dependsOn: [], conflictKeys: ['ais-page'], ownerId: 'browser-agent', executionPlane: 'BROWSER', acceptanceCriteria: ['page version 0 is visible'], budget: {}, state: 'PENDING', evidence: '', updatedAt: at }],
      } }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } };
      const marker = 'CURRENT SNAPSHOT:\n';
      const snapshot = JSON.parse(payload.prompt.slice(payload.prompt.lastIndexOf(marker) + marker.length));
      return { text: JSON.stringify({ type: 'verify_plan_node', nodeId: 'inspect', evidence: { snapshotSignature: browserSnapshotSignature(snapshot), checks: [{ criterion: 1, detail: 'page version 0' }] } }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } };
    },
  });
  await manager.create({ id: 'job-plan-node', goal: 'Inspect page' });
  await manager.start('job-plan-node', { runInitial: false });
  assert.equal((await manager.cycleOne('job-plan-node')).kind, 'PLAN_UPDATED');
  const result = await manager.cycleOne('job-plan-node');
  const live = await manager.get('job-plan-node');
  assert.equal(result.kind, 'PLAN_NODE_VERIFIED');
  assert.equal(live.job.runtime.plan.nodes[0].state, 'VERIFIED');
  assert.match(live.job.runtime.plan.nodes[0].evidence, /page version 0/);
});

test('Browser Agent atomically claims the referenced READY plan node before a physical action', async () => {
  const chrome = makeChrome();
  const at = new Date().toISOString();
  let phase = 0;
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => phase++ === 0
      ? ({ text: JSON.stringify({ type: 'plan', plan: {
        schemaVersion: 1, planId: 'plan-claim', jobId: 'job-plan-claim', objective: 'Act once', successCriteria: ['Clicked'], createdAt: at, updatedAt: at, revision: 1,
        nodes: [{ nodeId: 'act', title: 'Act', objective: 'Click Add course', dependsOn: [], conflictKeys: ['ais-page'], ownerId: 'browser-agent', executionPlane: 'BROWSER', acceptanceCriteria: ['Page changes'], budget: {}, state: 'PENDING', evidence: '', updatedAt: at }],
      } }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } })
      : ({ text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1', planNodeId: 'act' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }),
  });
  await manager.create({ id: 'job-plan-claim', goal: 'Act once', approvalMode: 'ALLOW_ALL' });
  await manager.start('job-plan-claim', { runInitial: false });
  await manager.cycleOne('job-plan-claim');
  const result = await manager.cycleOne('job-plan-claim');
  const live = await manager.get('job-plan-claim');
  assert.equal(result.kind, 'ACTION');
  assert.equal(live.job.runtime.plan.nodes[0].state, 'RUNNING');
  assert.equal(chrome._actionCalls[0].planNodeId, 'act');
});

test('Browser Agent exposes ready non-Browser work as a bounded specialist handoff instead of pretending to execute it', async () => {
  const chrome = makeChrome();
  const at = new Date().toISOString();
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'plan', plan: {
      schemaVersion: 1, planId: 'plan-specialist', jobId: 'job-specialist', objective: 'Inspect remote source', successCriteria: ['Source inspected'], createdAt: at, updatedAt: at, revision: 1,
      nodes: [{ nodeId: 'remote-inspect', title: 'Inspect source', objective: 'Read remote source', dependsOn: [], conflictKeys: ['repo:main'], ownerId: 'specialist', executionPlane: 'REMOTE', acceptanceCriteria: ['Evidence returned'], budget: {}, state: 'PENDING', evidence: '', updatedAt: at }],
    } }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }),
  });
  await manager.create({ id: 'job-specialist', goal: 'Inspect remote source' });
  await manager.start('job-specialist', { runInitial: false });
  assert.equal((await manager.cycleOne('job-specialist')).kind, 'PLAN_UPDATED');
  const result = await manager.cycleOne('job-specialist');
  assert.equal(result.kind, 'SPECIALIST_REQUIRED');
  assert.equal(result.node.executionPlane, 'REMOTE');
});

test('schedule policy validates paired active-window fields and ordered absolute bounds', () => {
  assert.throws(() => config({ activeWindowStart: '08:00' }), /requires both start and end times/);
  assert.throws(() => config({ scheduleStartAt: 20_000, scheduleEndAt: 10_000 }), /schedule end must be after start/);
  const value = config({ repeatMode: BrowserAgentRepeatMode.INTERVAL, intervalSeconds: 7, activeWindowStart: '08:00', activeWindowEnd: '18:30' });
  assert.equal(value.repeatMode, 'INTERVAL');
  assert.equal(value.intervalSeconds, 7);
});

test('daily schedule decision supports daytime and overnight windows in browser local time', () => {
  const local = (hour, minute = 0) => { const d = new Date(2026, 8, 14, hour, minute, 0, 0); return d.getTime(); };
  assert.equal(browserAgentScheduleDecision({ activeWindowStart: '08:00', activeWindowEnd: '18:00' }, local(10)).allowed, true);
  const beforeDay = browserAgentScheduleDecision({ activeWindowStart: '08:00', activeWindowEnd: '18:00' }, local(7));
  assert.equal(beforeDay.allowed, false);
  assert.equal(new Date(beforeDay.nextWakeAt).getHours(), 8);
  assert.equal(browserAgentScheduleDecision({ activeWindowStart: '22:00', activeWindowEnd: '06:00' }, local(23)).allowed, true);
  assert.equal(browserAgentScheduleDecision({ activeWindowStart: '22:00', activeWindowEnd: '06:00' }, local(3)).allowed, true);
  assert.equal(browserAgentScheduleDecision({ activeWindowStart: '22:00', activeWindowEnd: '06:00' }, local(12)).allowed, false);
});

test('future scheduled start survives as WAITING_SCHEDULE and cycleAll activates it when due', async () => {
  const chrome = makeChrome();
  let now = 100_000;
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    now: () => now,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'done', summary: 'scheduled pass done' }), usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4, modelCalls: 1 } }),
  });
  await manager.create({ id: 'job-1', goal: 'Scheduled check', scheduleStartAt: 120_000 });
  await manager.start('job-1', { runInitial: false });
  let live = await manager.get('job-1');
  assert.equal(live.job.runtime.runState, 'WAITING_SCHEDULE');
  assert.equal(live.job.runtime.nextWakeAt, 120_000);
  assert.ok(chrome._alarms.size > 0);
  now = 120_001;
  await manager.cycleAll();
  live = await manager.get('job-1');
  assert.equal(live.job.runtime.runState, 'COMPLETED');
  assert.equal(live.job.runtime.completedCycles, 1);
});

test('WAITING_SCHEDULE survives manager restart and rebuilds the same wake alarm', async () => {
  const chrome = makeChrome();
  let now = 300_000;
  const routePrompt = async () => ({ text: JSON.stringify({ type: 'done', summary: 'done after restart' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } });
  const first = new BrowserAgentManager({ chromeApi: chrome, now: () => now, routePrompt });
  await first.create({ id: 'job-1', goal: 'Scheduled restart proof', scheduleStartAt: 330_000 });
  await first.start('job-1', { runInitial: false });
  assert.equal((await first.get('job-1')).job.runtime.runState, 'WAITING_SCHEDULE');
  chrome._alarms.clear();
  const restarted = new BrowserAgentManager({ chromeApi: chrome, now: () => now, routePrompt });
  const wake = await restarted.reconcileAlarm();
  assert.equal(wake, 330_000);
  assert.ok(chrome._alarms.size > 0, 'cold manager must recreate durable scheduled wake');
  now = 330_001;
  await restarted.cycleAll();
  const live = await restarted.get('job-1');
  assert.equal(live.job.runtime.runState, 'COMPLETED');
  assert.equal(live.job.runtime.completedCycles, 1);
});

test('INTERVAL completion schedules the next autonomous cycle instead of ending the job', async () => {
  const chrome = makeChrome();
  let now = 200_000;
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    now: () => now,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'done', summary: 'monitor pass done' }), usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4, modelCalls: 1 } }),
  });
  await manager.create({ id: 'job-1', goal: 'Monitor AIS', repeatMode: 'INTERVAL', intervalSeconds: 5 });
  const first = await manager.start('job-1');
  assert.equal(first.job.runtime.runState, 'RUNNING');
  assert.equal(first.job.runtime.completedCycles, 1);
  assert.equal(first.job.runtime.nextWakeAt, 205_000);
  now = 205_001;
  await manager.cycleAll();
  const live = await manager.get('job-1');
  assert.equal(live.job.runtime.runState, 'RUNNING');
  assert.equal(live.job.runtime.completedCycles, 2);
  assert.equal(live.job.runtime.nextWakeAt, 210_001);
});

test('planner parser accepts bounded fill/select/check batch and rejects invented refs', () => {
  const snapshot = { frames: [{ frameId: 0, elements: [{ ref: 'r1' }, { ref: 'r2' }] }] };
  const action = parseBrowserAgentAction(JSON.stringify({ type: 'batch', actions: [
    { type: 'fill', frameId: 0, ref: 'r1', text: 'A' },
    { type: 'select', frameId: 0, ref: 'r2', value: 'B' },
  ] }), snapshot);
  assert.equal(action.type, 'batch');
  assert.equal(action.actions.length, 2);
  assert.throws(() => parseBrowserAgentAction(JSON.stringify({ type: 'click', frameId: 0, ref: 'r999' }), snapshot), /outside the current snapshot/);
});

test('planner prompt makes AI the autonomous operator and includes owner follow-up', () => {
  const prompt = buildBrowserAgentPlannerPrompt(config(), { stepCount: 2, modelCalls: 3, totalTokens: 400, ownerInstructions: ['Do not choose Friday'], history: [] }, { frames: [] });
  assert.match(prompt, /autonomous reasoning brain and operator/i);
  assert.match(prompt, /Do not choose Friday/);
  assert.match(prompt, /MODEL CALLS: 3/);
});

test('start runs a fast multi-step burst on an adopted owner tab until done', async () => {
  const chrome = makeChrome();
  const replies = [
    { text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1' }), usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'done', summary: 'Course page updated' }), usage: { inputTokens: 90, outputTokens: 8, totalTokens: 98, modelCalls: 1 } },
  ];
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => replies.shift(), now: (() => { let n = 1000; return () => ++n; })() });
  await manager.create({ id: 'job-1', goal: 'Add a course safely', stepDelayMs: 0 });
  const result = await manager.start('job-1');
  assert.equal(result.job.runtime.runState, 'COMPLETED');
  assert.equal(result.job.runtime.stepCount, 1);
  assert.equal(result.job.runtime.modelCalls, 2);
  assert.equal(chrome._actionCalls.length, 1);
  assert.deepEqual(result.job.runtime.ownedTabIds, [], 'the pre-existing owner tab must not become extension-owned');
  assert.equal(result.job.runtime.tabId, 1);
});

test('owner pause while model is reasoning cancels the stale physical action', async () => {
  const chrome = makeChrome();
  let release;
  let called;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { called = resolve; });
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => { called(); await gate; return { text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1' }), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, modelCalls: 1 } }; },
  });
  await manager.create({ id: 'job-1', goal: 'Add a course safely', stepDelayMs: 0 });
  const startPromise = manager.start('job-1');
  await entered;
  await manager.pause('job-1');
  release();
  await startPromise;
  const live = await manager.get('job-1');
  assert.equal(live.job.runtime.runState, 'PAUSED');
  assert.equal(chrome._actionCalls.length, 0, 'stale model output must not touch the page after Pause');
});

test('last allowed model call may execute its returned action and pauses before the next call', async () => {
  const chrome = makeChrome();
  let calls = 0;
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => { calls += 1; return { text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1' }), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, modelCalls: 1 } }; },
  });
  await manager.create({ id: 'job-1', goal: 'Add a course safely', maxModelCalls: 1, stepDelayMs: 0 });
  const result = await manager.start('job-1');
  assert.equal(calls, 1);
  assert.equal(chrome._actionCalls.length, 1, 'the action from the permitted model call must execute');
  assert.equal(result.job.runtime.runState, 'PAUSED');
  assert.match(result.job.runtime.lastError, /maximum model-call budget reached/);
});

test('three-route model failover preserves Browser Agent job identity and executes the returned external effect exactly once', async () => {
  const chrome = makeChrome();
  const providerCalls = [];
  const gateway = { async complete(request) {
    providerCalls.push(structuredClone(request));
    if (request.model === 'route-a') throw Object.assign(new Error('quota exhausted'), { status:429, code:'AI_PROVIDER_QUOTA_EXHAUSTED' });
    if (request.model === 'route-b') throw Object.assign(new Error('provider unavailable'), { status:503, code:'AI_PROVIDER_UNAVAILABLE' });
    return { text:JSON.stringify({ type:'click', frameId:0, ref:'r1' }), usage:{ inputTokens:10, outputTokens:5, totalTokens:15 } };
  } };
  let clock = 100_000;
  const orchestrator = new AiOrchestrator({ gatewayClient:gateway, now:() => ++clock });
  const settings = {
    enabled:true,
    mode:'primary',
    routes:[
      { routeId:'a', provider:'openai-compatible', endpointId:'team-a', model:'route-a', roles:['planner'], priority:30, costClass:'paid', inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
      { routeId:'b', provider:'openai', model:'route-b', roles:['planner'], priority:20, costClass:'paid', inputPricePerMillionUsd:1, outputPricePerMillionUsd:2 },
      { routeId:'c', provider:'ollama', model:'route-c', roles:['planner'], priority:10 },
    ],
    routePolicy:{ autoSwitch:true, retryBackoffSeconds:60, circuitBreakerFailures:2, circuitBreakerSeconds:300 },
  };
  const manager = new BrowserAgentManager({
    chromeApi:chrome,
    now:() => ++clock,
    routePrompt:payload => orchestrator.run(settings, payload.routerRuntime, payload.prompt, {
      systemPrompt:payload.systemPrompt,
      maxOutputTokens:payload.maxOutputTokens,
      maxModelCallsForRequest:payload.maxModelCallsForRequest,
      taskRole:payload.taskRole,
    }),
  });
  await manager.create({ id:'job-failover-effect', goal:'Add a course safely', maxModelCalls:3, stepDelayMs:0 });
  const result = await manager.start('job-failover-effect');
  assert.deepEqual(providerCalls.map(call => call.model), ['route-a','route-b','route-c']);
  assert.equal(new Set(providerCalls.map(call => call.prompt)).size, 1, 'the exact planner context must survive route failover');
  assert.equal(chrome._actionCalls.length, 1, 'multiple model attempts must yield only one external browser effect');
  assert.equal(result.job.config.id, 'job-failover-effect');
  assert.equal(result.job.runtime.modelCalls, 3, 'all provider attempts consume one monotonic job budget');
  assert.deepEqual(result.job.runtime.aiRouterRuntime.lastFailoverChain.map(item => item.routeId), ['a','b','c']);
});

test('USD budget caps output tokens before the provider call', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  const job = {
    config: config({ maxCostUsd: 1, inputPricePerMillionUsd: 10, outputPricePerMillionUsd: 20, maxOutputTokensPerCall: 200000 }),
    runtime: { estimatedCostUsd: 0, outputTokens: 0, totalTokens: 0 },
  };
  assert.equal(manager.outputBudgetForCall(job, 50000), 25000);
});

test('missing site permission records the exact requested origin for prompt-first UX', async () => {
  const chrome = makeChrome({ permission: false });
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  await manager.create({ id: 'job-1', goal: 'Inspect AIS' });
  const result = await manager.start('job-1');
  assert.equal(result.job.runtime.runState, 'WAITING_PERMISSION');
  assert.equal(result.job.runtime.permissionOrigin, 'https://ais.example.edu');
  assert.equal(result.job.runtime.currentUrl, 'https://ais.example.edu/app');
});

test('provider failure becomes durable bounded retry instead of escaping cycleOne', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => { throw new Error('provider temporarily unavailable'); },
    now: (() => { let n = 20_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Inspect AIS' });
  await manager.start('job-1', { runInitial: false });
  const result = await manager.cycleOne('job-1');
  const live = await manager.get('job-1');
  assert.equal(result.kind, 'MODEL_RETRY');
  assert.equal(live.job.runtime.runState, 'RUNNING');
  assert.equal(live.job.runtime.consecutiveModelErrors, 1);
  assert.match(live.job.runtime.lastError, /provider temporarily unavailable/);
  assert.ok(live.job.runtime.nextWakeAt > 0);
  assert.equal(live.job.runtime.history.at(-1).type, 'model-error');
});

test('invalid planner JSON is durable model retry and does not lose usage', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: 'not-json', usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14, modelCalls: 1 } }),
    now: (() => { let n = 30_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Inspect AIS' });
  await manager.start('job-1', { runInitial: false });
  const result = await manager.cycleOne('job-1');
  const live = await manager.get('job-1');
  assert.equal(result.kind, 'MODEL_RETRY');
  assert.equal(live.job.runtime.modelCalls, 1);
  assert.equal(live.job.runtime.totalTokens, 14);
  assert.match(live.job.runtime.lastError, /Invalid Browser Agent planner JSON/);
});

test('page action exception becomes durable action retry and is bounded by maxSteps accounting', async () => {
  const chrome = makeChrome();
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'executeBrowserPageAction') throw new Error('AGENT_TARGET_STALE');
    return original(details);
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1' }), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, modelCalls: 1 } }),
    now: (() => { let n = 40_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Inspect AIS', maxSteps: 20 });
  await manager.start('job-1', { runInitial: false });
  const result = await manager.cycleOne('job-1');
  const live = await manager.get('job-1');
  assert.equal(result.kind, 'ACTION_RETRY');
  assert.equal(live.job.runtime.runState, 'RUNNING');
  assert.equal(live.job.runtime.stepCount, 1, 'failed planner decisions still consume the safety step ceiling');
  assert.equal(live.job.runtime.consecutiveActionErrors, 1);
  assert.match(live.job.runtime.lastError, /AGENT_TARGET_STALE/);
});

test('partial batch preserves successful prefix evidence and replans instead of crashing', async () => {
  const chrome = makeChrome();
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: {
        snapshotId, url: 'https://ais.example.edu/app', title: 'AIS', text: 'form',
        elements: [{ ref: 'r1', tag: 'input', role: '', type: 'text', name: 'A' }, { ref: 'r2', tag: 'select', role: '', type: '', name: 'B', options: ['X'] }],
      } }];
    }
    if (details.func?.name === 'executeBrowserPageAction' && details.args[1]?.ref === 'r2') throw new Error('select changed under us');
    return original(details);
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'batch', actions: [
      { type: 'fill', frameId: 0, ref: 'r1', text: 'hello' },
      { type: 'select', frameId: 0, ref: 'r2', value: 'X' },
    ] }), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, modelCalls: 1 } }),
    now: (() => { let n = 50_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Fill form' });
  await manager.start('job-1', { runInitial: false });
  const result = await manager.cycleOne('job-1');
  const live = await manager.get('job-1');
  assert.equal(result.kind, 'ACTION');
  assert.equal(live.job.runtime.runState, 'RUNNING');
  assert.equal(live.job.runtime.stepCount, 1);
  const history = live.job.runtime.history.at(-1);
  assert.equal(history.partial, true);
  assert.equal(history.completedCount, 1);
  assert.equal(history.failedIndex, 1);
  assert.match(history.error, /select changed under us/);
});

test('five consecutive browser action failures transition job to ERROR instead of spinning forever', async () => {
  const chrome = makeChrome();
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'executeBrowserPageAction') throw new Error('browser action unavailable');
    return original(details);
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }),
    now: (() => { let n = 60_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Click reliably' });
  await manager.start('job-1', { runInitial: false });
  for (let i = 0; i < 5; i += 1) await manager.cycleOne('job-1');
  const live = await manager.get('job-1');
  assert.equal(live.job.runtime.runState, 'ERROR');
  assert.equal(live.job.runtime.consecutiveActionErrors, 5);
  assert.equal(live.job.runtime.nextWakeAt, 0);
  assert.match(live.job.runtime.history.at(-1).message, /stopped after 5 consecutive action failures/i);
});

test('live cross-origin redirect becomes WAITING_PERMISSION before snapshot scripting retries', async () => {
  const chrome = makeChrome();
  chrome.permissions.contains = async ({ origins }) => !String(origins?.[0] || '').startsWith('https://other.example/');
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: JSON.stringify({ type: 'done', summary: 'x' }) }) });
  await manager.create({ id: 'job-1', goal: 'Inspect redirect' });
  await manager.start('job-1', { runInitial: false });
  chrome._tabs.get(1).url = 'https://other.example/after-redirect';
  chrome._tabs.get(1).status = 'complete';
  const result = await manager.cycleOne('job-1');
  const live = await manager.get('job-1');
  assert.equal(result.kind, 'WAITING_PERMISSION');
  assert.equal(live.job.runtime.runState, 'WAITING_PERMISSION');
  assert.equal(live.job.runtime.permissionOrigin, 'https://other.example');
  assert.equal(live.job.runtime.currentUrl, 'https://other.example/after-redirect');
});

test('Stop keeps failed owned-tab close as durable retirePending and alarm retries it', async () => {
  const chrome = makeChrome();
  let first = true;
  const originalRemove = chrome.tabs.remove;
  chrome.tabs.remove = async id => {
    if (id === 2 && first) { first = false; throw new Error('transient remove failure'); }
    return originalRemove(id);
  };
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: JSON.stringify({ type: 'done', summary: 'x' }) }) });
  await manager.create({ id: 'job-1', goal: 'Use isolated tab', startUrl: 'https://ais.example.edu/app', startFromActiveTab: false, closeOwnedTabsOnStop: true });
  await manager.start('job-1', { runInitial: false });
  await manager.ensureTab((await manager.get('job-1')).job);
  let live = await manager.get('job-1');
  assert.deepEqual(live.job.runtime.ownedTabIds, [2]);
  await manager.stop('job-1');
  live = await manager.get('job-1');
  assert.equal(live.job.runtime.runState, 'STOPPED');
  assert.deepEqual(live.job.runtime.retirePendingTabIds, [2]);
  assert.ok(chrome._alarms.size > 0, 'retirement retry must remain scheduled even for STOPPED job');
  await manager.cycleAll();
  live = await manager.get('job-1');
  assert.deepEqual(live.job.runtime.ownedTabIds, []);
  assert.deepEqual(live.job.runtime.retirePendingTabIds, []);
  assert.equal(chrome._tabs.has(2), false);
});

test('Delete is durable across transient tabs.remove failure and finalizes automatically after retirement', async () => {
  const chrome = makeChrome();
  let failures = 1;
  const originalRemove = chrome.tabs.remove;
  chrome.tabs.remove = async id => {
    if (id === 2 && failures-- > 0) throw new Error('remove failed once');
    return originalRemove(id);
  };
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  await manager.create({ id: 'job-1', goal: 'Use isolated tab', startUrl: 'https://ais.example.edu/app', startFromActiveTab: false });
  await manager.start('job-1', { runInitial: false });
  await manager.ensureTab((await manager.get('job-1')).job);
  await manager.stop('job-1');
  const pending = await manager.delete('job-1');
  assert.equal(pending.job.runtime.deletePending, true);
  assert.deepEqual(pending.job.runtime.retirePendingTabIds, [2]);
  await manager.cycleAll();
  assert.equal((await manager.get('job-1')).job, null);
  assert.equal(chrome._tabs.has(2), false);
});

test('new unrelated active tab is never claimed as child ownership without opener proof', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  await manager.create({ id: 'job-1', goal: 'Inspect' });
  await manager.start('job-1', { runInitial: false });
  chrome._tabs.set(99, { id: 99, url: 'https://unrelated.example/', active: true, status: 'complete' });
  const child = await manager.adoptNewChildTab('job-1', [1], 1);
  assert.equal(child, null);
  const live = await manager.get('job-1');
  assert.deepEqual(live.job.runtime.ownedTabIds, []);
  assert.equal(live.job.runtime.tabId, null, 'start has not yet adopted its context until ensureTab/cycle');
});

test('planner tab actions use ephemeral snapshot refs and never authorize closing an adopted owner tab', () => {
  const snapshot = {
    frames: [{ frameId: 0, elements: [] }],
    tabs: [
      { ref: 't1', tabId: 1, url: 'https://ais.example.edu/app', current: true, owned: false },
      { ref: 't2', tabId: 2, url: 'https://ais.example.edu/help', current: false, owned: true },
    ],
  };
  assert.deepEqual(
    parseBrowserAgentAction(JSON.stringify({ type: 'new_tab', url: 'https://ais.example.edu/parallel' }), snapshot),
    { type: 'new_tab', url: 'https://ais.example.edu/parallel' },
  );
  assert.deepEqual(
    parseBrowserAgentAction(JSON.stringify({ type: 'switch_tab', tabRef: 't2' }), snapshot),
    { type: 'switch_tab', tabRef: 't2', tabId: 2 },
  );
  assert.deepEqual(
    parseBrowserAgentAction(JSON.stringify({ type: 'close_tab', tabRef: 't2' }), snapshot),
    { type: 'close_tab', tabRef: 't2', tabId: 2 },
  );
  assert.throws(
    () => parseBrowserAgentAction(JSON.stringify({ type: 'close_tab', tabRef: 't1' }), snapshot),
    /only agent-owned tabs/,
  );
  assert.throws(
    () => parseBrowserAgentAction(JSON.stringify({ type: 'switch_tab', tabRef: 't99' }), snapshot),
    /outside the current snapshot/,
  );
});

test('AI can create, switch between, and close its own tab while preserving the adopted owner tab', async () => {
  const chrome = makeChrome();
  const replies = [
    { type: 'new_tab', url: 'https://ais.example.edu/parallel' },
    { type: 'switch_tab', tabRef: 't2' },
    { type: 'close_tab', tabRef: 't2' },
  ];
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: JSON.stringify(replies.shift()), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }),
    now: (() => { let n = 70_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Compare two AIS pages without losing the owner tab', stepDelayMs: 0 });
  await manager.start('job-1', { runInitial: false });

  let result = await manager.cycleOne('job-1');
  assert.equal(result.kind, 'ACTION');
  let live = await manager.get('job-1');
  assert.equal(live.job.runtime.tabId, 2, 'new_tab becomes the current agent tab');
  assert.deepEqual(live.job.runtime.ownedTabIds, [2]);
  assert.deepEqual(new Set(live.job.runtime.knownTabIds), new Set([1, 2]));
  assert.equal(chrome._tabs.has(1), true, 'owner tab remains present');
  assert.equal(chrome._tabs.has(2), true, 'agent-created tab exists');

  result = await manager.cycleOne('job-1');
  assert.equal(result.kind, 'ACTION');
  live = await manager.get('job-1');
  assert.equal(live.job.runtime.tabId, 1, 'switch_tab returns to the adopted owner tab via the current snapshot ref');
  assert.deepEqual(live.job.runtime.ownedTabIds, [2], 'switching does not change provenance');

  result = await manager.cycleOne('job-1');
  assert.equal(result.kind, 'ACTION');
  live = await manager.get('job-1');
  assert.equal(chrome._tabs.has(2), false, 'agent-owned tab is physically closed');
  assert.equal(chrome._tabs.has(1), true, 'adopted owner tab is never closed');
  assert.equal(live.job.runtime.tabId, 1);
  assert.deepEqual(live.job.runtime.ownedTabIds, []);
  assert.deepEqual(live.job.runtime.knownTabIds, [1]);
  assert.equal(JSON.stringify(live.job.runtime.history).includes('\"tabId\"'), false, 'raw Chrome tab ids must not re-enter model-visible durable history');
});

test('failed model-requested close retains durable retirement ownership instead of orphaning the tab', async () => {
  const chrome = makeChrome();
  const originalRemove = chrome.tabs.remove;
  let failClose = true;
  chrome.tabs.remove = async id => {
    if (id === 2 && failClose) { failClose = false; throw new Error('close temporarily rejected'); }
    return originalRemove(id);
  };
  const replies = [
    { type: 'new_tab', url: 'https://ais.example.edu/parallel' },
    { type: 'close_tab', tabRef: 't1' },
  ];
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: JSON.stringify(replies.shift()), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }),
    now: (() => { let n = 80_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Open then close a temporary AIS tab' });
  await manager.start('job-1', { runInitial: false });
  await manager.cycleOne('job-1');
  const result = await manager.cycleOne('job-1');
  let live = await manager.get('job-1');
  assert.equal(result.kind, 'ACTION_RETRY');
  assert.equal(chrome._tabs.has(2), true, 'failed physical close must leave the real tab visible to ownership tracking');
  assert.deepEqual(live.job.runtime.ownedTabIds, [2]);
  assert.deepEqual(live.job.runtime.retirePendingTabIds, [2]);
  assert.ok(live.job.runtime.knownTabIds.includes(2));

  await manager.cycleAll();
  live = await manager.get('job-1');
  assert.equal(chrome._tabs.has(2), false, 'next reconciliation retires the tab after the transient failure');
  assert.deepEqual(live.job.runtime.ownedTabIds, []);
  assert.deepEqual(live.job.runtime.retirePendingTabIds, []);
  assert.equal(chrome._tabs.has(1), true);
});

test('unchanged page after DOM and native click is surfaced as effect-not-observed before replanning', async () => {
  const chrome = makeChrome();
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'executeBrowserPageAction') {
      chrome._actionCalls.push(structuredClone(details.args[1]));
      return [{ frameId: 0, result: { ok: true, kind: 'click', url: 'https://ais.example.edu/app' } }];
    }
    return original(details);
  };
  const replies = [
    { text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'done', summary: 'No-op detected and replanned' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } },
  ];
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => replies.shift(),
    now: (() => { let n = 90_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Use control only if it really changes the page', stepDelayMs: 0 });
  await manager.start('job-1', { runInitial: false });
  assert.equal((await manager.cycleOne('job-1')).kind, 'ACTION');
  assert.equal((await manager.cycleOne('job-1')).kind, 'NATIVE_CLICK_FALLBACK');
  const final = await manager.cycleOne('job-1');
  assert.equal(final.kind, 'COMPLETED');
  const live = await manager.get('job-1');
  const evidence = live.job.runtime.history.find(item => item.type === 'effect-not-observed');
  assert.ok(evidence, 'the reasoning model must receive durable evidence that both click paths produced no observable effect');
  assert.match(evidence.message, /No observable page effect after click/);
});

test('wait_for_change parser creates a bounded deterministic page-watch policy', () => {
  const snapshot = { frames: [{ frameId: 0, elements: [] }] };
  const action = parseBrowserAgentAction(JSON.stringify({ type: 'wait_for_change', pollSeconds: 2, timeoutSeconds: 30 }), snapshot);
  assert.deepEqual(action, { type: 'wait_for_change', pollSeconds: 2, timeoutSeconds: 30 });
  const bounded = parseBrowserAgentAction(JSON.stringify({ type: 'wait_for_change', pollSeconds: 0, timeoutSeconds: 999999 }), snapshot);
  assert.equal(bounded.pollSeconds, 1);
  assert.equal(bounded.timeoutSeconds, 86400);
});

test('durable wait_for_change survives manager restart and spends no model calls until the page changes', async () => {
  const chrome = makeChrome();
  let now = 80_000;
  let calls = 0;
  const routePrompt = async () => {
    calls += 1;
    return calls === 1
      ? { text: JSON.stringify({ type: 'wait_for_change', pollSeconds: 5, timeoutSeconds: 60 }), usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, modelCalls: 1 } }
      : { text: JSON.stringify({ type: 'done', summary: 'Change detected' }), usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, modelCalls: 1 } };
  };
  const first = new BrowserAgentManager({ chromeApi: chrome, routePrompt, now: () => now });
  await first.create({ id: 'job-1', goal: 'Wait until this page changes and then report it' });
  await first.start('job-1', { runInitial: false });
  assert.equal((await first.cycleOne('job-1')).kind, 'ACTION');
  let live = await first.get('job-1');
  assert.ok(live.job.runtime.pendingPageWatch);
  assert.equal(live.job.runtime.modelCalls, 1);

  const restarted = new BrowserAgentManager({ chromeApi: chrome, routePrompt, now: () => now });
  now += 5_000;
  assert.equal((await restarted.cycleOne('job-1')).kind, 'WAITING_PAGE_CHANGE');
  live = await restarted.get('job-1');
  assert.equal(calls, 1, 'unchanged deterministic polls must not call the model');
  assert.equal(live.job.runtime.modelCalls, 1);
  assert.ok(live.job.runtime.pendingPageWatch, 'watch obligation must remain durable');

  chrome._bumpPage();
  now += 5_000;
  const result = await restarted.cycleOne('job-1');
  live = await restarted.get('job-1');
  assert.equal(result.kind, 'COMPLETED');
  assert.equal(calls, 2, 'model resumes only after actual semantic page change');
  assert.equal(live.job.runtime.pendingPageWatch, null);
  assert.equal(live.job.runtime.resultSummary, 'Change detected');
  assert.ok(live.job.runtime.history.some(item => item.type === 'page-change-detected'));
});

test('last allowed browser step may settle a durable page watch and still return DONE', async () => {
  const chrome = makeChrome();
  let now = 87_000;
  let calls = 0;
  const routePrompt = async () => {
    calls += 1;
    return calls === 1
      ? { text: JSON.stringify({ type: 'wait_for_change', pollSeconds: 1, timeoutSeconds: 10 }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }
      : { text: JSON.stringify({ type: 'done', summary: 'Observed the change at the step ceiling' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } };
  };
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt, now: () => now });
  await manager.create({ id: 'job-1', goal: 'Watch once and finish', maxSteps: 1 });
  await manager.start('job-1', { runInitial: false });
  assert.equal((await manager.cycleOne('job-1')).kind, 'ACTION');
  let live = await manager.get('job-1');
  assert.equal(live.job.runtime.stepCount, 1);
  chrome._bumpPage();
  now += 1_000;
  assert.equal((await manager.cycleOne('job-1')).kind, 'COMPLETED', 'settling the already-authorized last step must not be preempted by maxSteps');
  live = await manager.get('job-1');
  assert.equal(live.job.runtime.resultSummary, 'Observed the change at the step ceiling');
  assert.equal(live.job.runtime.stepCount, 1);
});

test('owner follow-up interrupts durable page watch immediately and replans without waiting for timeout', async () => {
  const chrome = makeChrome();
  let now = 88_000;
  let calls = 0;
  const prompts = [];
  const routePrompt = async ({ prompt }) => {
    prompts.push(prompt);
    calls += 1;
    return calls === 1
      ? { text: JSON.stringify({ type: 'wait_for_change', pollSeconds: 30, timeoutSeconds: 3600 }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }
      : { text: JSON.stringify({ type: 'done', summary: 'Owner changed the plan' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } };
  };
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt, now: () => now });
  await manager.create({ id: 'job-1', goal: 'Monitor this page' });
  await manager.start('job-1', { runInitial: false });
  await manager.cycleOne('job-1');
  assert.ok((await manager.get('job-1')).job.runtime.pendingPageWatch);
  now += 100;
  await manager.addInstruction('job-1', 'Не чекай більше; заверши перевірку зараз.');
  let live = await manager.get('job-1');
  assert.equal(live.job.runtime.pendingPageWatch, null);
  assert.equal(live.job.runtime.runState, 'RUNNING');
  assert.ok(live.job.runtime.history.some(item => item.type === 'page-watch-interrupted'));
  assert.equal((await manager.cycleOne('job-1')).kind, 'COMPLETED');
  assert.equal(calls, 2);
  assert.match(prompts.at(-1), /Не чекай більше/);
});

test('new owner instruction supersedes an armed approval instead of leaving stale action executable', async () => {
  const chrome = makeChrome();
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: { snapshotId, url: 'https://ais.example.edu/app', title: 'AIS', text: 'Final', elements: [{ ref: 'r1', tag: 'button', role: '', type: 'submit', name: 'Save', submitLike: true, formAssociated: true, formAction: 'https://ais.example.edu/save', formMethod: 'post' }] } }];
    }
    return original(details);
  };
  let calls = 0;
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => (++calls === 1
      ? { text: JSON.stringify({ type: 'click', frameId: 0, ref: 'r1' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }
      : { text: JSON.stringify({ type: 'done', summary: 'Did not submit' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }),
  });
  await manager.create({ id: 'job-1', goal: 'Prepare the form' });
  await manager.start('job-1', { runInitial: false });
  assert.equal((await manager.cycleOne('job-1')).kind, 'WAITING_APPROVAL');
  assert.equal(chrome._actionCalls.length, 0);
  await manager.addInstruction('job-1', 'Не надсилай форму. Просто заверши.');
  let live = await manager.get('job-1');
  assert.equal(live.job.runtime.pendingApproval, null);
  assert.equal(live.job.runtime.runState, 'RUNNING');
  assert.ok(live.job.runtime.history.some(item => item.type === 'approval-superseded'));
  await assert.rejects(() => manager.approvePendingAction('job-1', { runInitial: false }), /no pending action/);
  assert.equal((await manager.cycleOne('job-1')).kind, 'COMPLETED');
  assert.equal(chrome._actionCalls.length, 0, 'superseded approved action must remain impossible to execute');
});

test('wait_for_change timeout resumes reasoning once without token-burning polls', async () => {
  const chrome = makeChrome();
  let now = 90_000;
  let calls = 0;
  const routePrompt = async () => {
    calls += 1;
    return calls === 1
      ? { text: JSON.stringify({ type: 'wait_for_change', pollSeconds: 3, timeoutSeconds: 9 }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }
      : { text: JSON.stringify({ type: 'done', summary: 'No change before timeout' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } };
  };
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt, now: () => now });
  await manager.create({ id: 'job-1', goal: 'Watch briefly' });
  await manager.start('job-1', { runInitial: false });
  await manager.cycleOne('job-1');
  for (const delta of [3_000, 3_000]) {
    now += delta;
    assert.equal((await manager.cycleOne('job-1')).kind, 'WAITING_PAGE_CHANGE');
  }
  assert.equal(calls, 1);
  now += 3_000;
  assert.equal((await manager.cycleOne('job-1')).kind, 'COMPLETED');
  assert.equal(calls, 2);
  const live = await manager.get('job-1');
  assert.ok(live.job.runtime.history.some(item => item.type === 'page-watch-timeout'));
});

test('maxSteps allows final reasoning but blocks any additional physical action beyond the ceiling', async () => {
  const chrome = makeChrome();
  let calls = 0;
  const routePrompt = async () => {
    calls += 1;
    return { text: JSON.stringify({ type: 'scroll', direction: 'down', amount: 0.5 }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } };
  };
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt });
  await manager.create({ id: 'job-1', goal: 'Do at most one browser action', maxSteps: 1 });
  await manager.start('job-1', { runInitial: false });
  assert.equal((await manager.cycleOne('job-1')).kind, 'ACTION');
  const beforeActions = chrome._actionCalls.length;
  assert.equal((await manager.cycleOne('job-1')).kind, 'MAX_STEPS');
  assert.equal(chrome._actionCalls.length, beforeActions, 'second physical action must not execute');
  assert.equal((await manager.get('job-1')).job.runtime.runState, 'ERROR');
  assert.equal(calls, 2, 'one final reasoning call is allowed to decide DONE, but its extra action is rejected');
});

test('download action resolves only a visible observed link href', () => {
  const snapshot = { frames: [{ frameId: 0, elements: [
    { ref: 'r1', tag: 'a', role: '', type: '', name: 'PDF', href: 'https://ais.example.edu/files/plan.pdf' },
    { ref: 'r2', tag: 'button', role: '', type: 'button', name: 'No link' },
  ] }], tabs: [] };
  const action = parseBrowserAgentAction(JSON.stringify({ type: 'download', frameId: 0, ref: 'r1' }), snapshot);
  assert.equal(action.type, 'download');
  assert.equal(action.url, 'https://ais.example.edu/files/plan.pdf');
  assert.throws(() => parseBrowserAgentAction(JSON.stringify({ type: 'download', frameId: 0, ref: 'r2' }), snapshot), /visible link/);
});

test('download waits for optional Chrome capability, then tracks only Agent-started download metadata', async () => {
  const chrome = makeChrome();
  let downloadsAllowed = false;
  chrome.permissions.contains = async ({ permissions }) => permissions?.includes('downloads') ? downloadsAllowed : true;
  const downloadItems = new Map();
  chrome.downloads = {
    async download({ url, saveAs }) {
      assert.equal(saveAs, false);
      assert.equal(url, 'https://ais.example.edu/files/plan.pdf');
      downloadItems.set(42, { id: 42, filename: '/home/user/Downloads/plan.pdf', state: 'in_progress', bytesReceived: 12, totalBytes: 100, error: '' });
      return 42;
    },
    async search() { return [...downloadItems.values()].map(item => structuredClone(item)); },
  };
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: {
        snapshotId,
        url: 'https://ais.example.edu/app',
        title: 'AIS',
        text: 'Download study plan',
        elements: [{ ref: 'r1', tag: 'a', role: '', type: '', name: 'Study plan PDF', href: 'https://ais.example.edu/files/plan.pdf' }],
      } }];
    }
    return original(details);
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'download', frameId: 0, ref: 'r1' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }),
    now: (() => { let n = 100_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Download the visible study-plan PDF' });
  await manager.start('job-1', { runInitial: false });
  let result = await manager.cycleOne('job-1');
  let live = await manager.get('job-1');
  assert.equal(result.kind, 'WAITING_CAPABILITY');
  assert.equal(live.job.runtime.runState, 'WAITING_CAPABILITY');
  assert.equal(live.job.runtime.capabilityPermission, 'downloads');
  assert.deepEqual(live.job.runtime.knownDownloadIds, []);

  downloadsAllowed = true;
  await manager.resume('job-1', { runInitial: false });
  result = await manager.cycleOne('job-1');
  live = await manager.get('job-1');
  assert.equal(result.kind, 'ACTION');
  assert.deepEqual(live.job.runtime.knownDownloadIds, [42]);
  assert.equal(live.job.runtime.capabilityPermission, '');

  const snapshot = await manager.collectSnapshot(live.job.runtime.tabId, live.job);
  assert.deepEqual(snapshot.downloads, [{ ref: 'd1', filename: 'plan.pdf', state: 'in_progress', bytesReceived: 12, totalBytes: 100, error: '' }]);
  assert.equal(JSON.stringify(snapshot).includes('/home/user/Downloads'), false, 'full local file paths must not be exposed to the model');
  const historyText = JSON.stringify(live.job.runtime.history);
  assert.equal(historyText.includes('\"downloadId\"'), false, 'raw Chrome download ids must not enter model-visible durable history');
  assert.equal(historyText.includes('/home/user/Downloads'), false, 'local download paths must not enter durable history');
});

test('download wait is durable and does not spend model calls while bytes are still in progress', async () => {
  const chrome = makeChrome();
  let downloadState = 'in_progress';
  chrome.permissions.contains = async () => true;
  chrome.downloads = {
    async download() { return 42; },
    async search(query) {
      if (query?.id !== undefined && query.id !== 42) return [];
      return [{ id: 42, filename: '/home/user/Downloads/plan.pdf', state: downloadState, bytesReceived: downloadState === 'complete' ? 100 : 30, totalBytes: 100, error: '' }];
    },
  };
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: {
        snapshotId,
        url: 'https://ais.example.edu/app',
        title: 'AIS',
        text: 'Download study plan',
        elements: [{ ref: 'r1', tag: 'a', role: '', type: '', name: 'Study plan PDF', href: 'https://ais.example.edu/files/plan.pdf' }],
      } }];
    }
    return original(details);
  };
  let calls = 0;
  const replies = [
    { text: JSON.stringify({ type: 'download', frameId: 0, ref: 'r1' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'done', summary: 'Download complete' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } },
  ];
  let now = 200_000;
  let manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => { calls += 1; return replies.shift(); }, now: () => ++now });
  await manager.create({ id: 'job-1', goal: 'Download the plan and finish' });
  await manager.start('job-1', { runInitial: false });
  assert.equal((await manager.cycleOne('job-1')).kind, 'ACTION');
  let live = await manager.get('job-1');
  assert.equal(live.job.runtime.pendingDownloadId, 42);
  assert.equal(calls, 1);

  manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => { calls += 1; return replies.shift(); }, now: () => ++now });
  const waiting = await manager.cycleOne('job-1');
  live = await manager.get('job-1');
  assert.equal(waiting.kind, 'WAITING_DOWNLOAD');
  assert.equal(live.job.runtime.pendingDownloadId, 42, 'download wait must survive manager restart');
  assert.equal(calls, 1, 'in-progress download must not spend another model call');

  downloadState = 'complete';
  const completed = await manager.cycleOne('job-1');
  live = await manager.get('job-1');
  assert.equal(completed.kind, 'COMPLETED');
  assert.equal(live.job.runtime.pendingDownloadId, null);
  assert.equal(calls, 2);
  assert.ok(live.job.runtime.history.some(item => item.type === 'download-complete'));
});

test('notify is a bounded Agent tool and waits for explicit Chrome notifications capability', async () => {
  const parsed = parseBrowserAgentAction(JSON.stringify({ type: 'notify', title: 'Квитки знайдено', message: 'Є потрібний рейс.' }), { frames: [], tabs: [], downloads: [] });
  assert.deepEqual(parsed, { type: 'notify', title: 'Квитки знайдено', message: 'Є потрібний рейс.' });
  assert.throws(() => parseBrowserAgentAction(JSON.stringify({ type: 'notify', title: 'x', message: '' }), { frames: [] }), /requires message/);

  const chrome = makeChrome();
  let notificationsAllowed = false;
  chrome.permissions.contains = async request => request?.permissions?.includes('notifications') ? notificationsAllowed : true;
  const notifications = [];
  chrome.notifications = {
    async create(options) { notifications.push(structuredClone(options)); return 'notification-1'; },
  };
  let calls = 0;
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => {
      calls += 1;
      return { text: JSON.stringify({ type: 'notify', title: 'Квитки знайдено', message: 'Є потрібний рейс.' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } };
    },
    now: (() => { let n = 210_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Notify me when a ticket appears' });
  await manager.start('job-1', { runInitial: false });
  let result = await manager.cycleOne('job-1');
  let live = await manager.get('job-1');
  assert.equal(result.kind, 'WAITING_CAPABILITY');
  assert.equal(live.job.runtime.capabilityPermission, 'notifications');
  assert.equal(notifications.length, 0);

  notificationsAllowed = true;
  await manager.resume('job-1', { runInitial: false });
  result = await manager.cycleOne('job-1');
  live = await manager.get('job-1');
  assert.equal(result.kind, 'ACTION');
  assert.equal(calls, 2);
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0], {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Квитки знайдено',
    message: 'Є потрібний рейс.',
  });
  assert.equal(live.job.runtime.capabilityPermission, '');
});

test('model-visible tab/download snapshot exposes ephemeral handles but hides raw Chrome ids and local paths', async () => {
  const chrome = makeChrome();
  chrome.permissions.contains = async () => true;
  chrome.downloads = {
    async search() { return [{ id: 77, filename: 'C:\\Users\\Owner\\Downloads\\private-name.pdf', state: 'complete', bytesReceived: 100, totalBytes: 100, error: '' }]; },
  };
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: '{}' }) });
  await manager.create({ id: 'job-1', goal: 'Inspect handles' });
  await manager.start('job-1', { runInitial: false });
  await manager.ensureTab((await manager.get('job-1')).job);
  await manager.update(store => { store.byId['job-1'].runtime.knownDownloadIds = [77]; return store; });
  const live = await manager.get('job-1');
  const snapshot = await manager.collectSnapshot(1, live.job);
  assert.equal(snapshot.tabs[0].tabId, 1, 'runtime parser still resolves hidden tab id');
  assert.equal(snapshot.downloads[0].downloadId, 77, 'runtime parser still resolves hidden download id');
  const visible = JSON.stringify(snapshot);
  assert.equal(visible.includes('"tabId"'), false);
  assert.equal(visible.includes('"downloadId"'), false);
  assert.equal(visible.includes('C:\\\\Users'), false);
  assert.match(visible, /private-name\.pdf/);
  assert.match(visible, /"ref":"t1"/);
  assert.match(visible, /"ref":"d1"/);
});

test('upload_download accepts only completed tracked download handle and always requires approval by default', () => {
  const complete = { ref: 'd1', filename: 'plan.pdf', state: 'complete' };
  Object.defineProperty(complete, 'downloadId', { value: 42, enumerable: false });
  const snapshot = {
    frames: [{ frameId: 0, elements: [{ ref: 'r1', tag: 'input', role: '', type: 'file', name: 'Attach plan', sensitive: true }] }],
    downloads: [complete],
  };
  const action = parseBrowserAgentAction(JSON.stringify({ type: 'upload_download', frameId: 0, ref: 'r1', downloadRef: 'd1' }), snapshot);
  assert.equal(action.downloadId, 42);
  assert.equal(action.downloadRef, 'd1');
  const risk = classifyBrowserAgentActionRisk(snapshot, action);
  assert.equal(risk.requiresApproval, true);
  assert.match(risk.targetName, /plan\.pdf/);

  const pending = { ref: 'd2', filename: 'wait.pdf', state: 'in_progress' };
  Object.defineProperty(pending, 'downloadId', { value: 43, enumerable: false });
  assert.throws(() => parseBrowserAgentAction(JSON.stringify({ type: 'upload_download', frameId: 0, ref: 'r1', downloadRef: 'd2' }), { ...snapshot, downloads: [pending] }), /only a completed Agent download/);
});

test('approved upload_download uses internal tracked path through CDP and verifies file input without exposing path to model', async () => {
  const chrome = makeChrome();
  chrome.permissions.contains = async () => true;
  const fullPath = '/home/owner/Downloads/plan.pdf';
  chrome.downloads = {
    async search(query) { return query?.id === 42 || !query?.id ? [{ id: 42, filename: fullPath, state: 'complete', bytesReceived: 100, totalBytes: 100, error: '' }] : []; },
  };
  const cdp = [];
  chrome.debugger = {
    async attach(target, version) { cdp.push(['attach', target.tabId, version]); },
    async sendCommand(target, method, params) {
      cdp.push([method, params]);
      if (method === 'Runtime.evaluate') return { result: { objectId: 'file-object' } };
      if (method === 'DOM.requestNode') return { nodeId: 7 };
      if (method === 'DOM.setFileInputFiles') return {};
      return {};
    },
    async detach(target) { cdp.push(['detach', target.tabId]); },
  };
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'snapshotBrowserPage') {
      const snapshotId = details.args[0];
      return [{ frameId: 0, result: {
        snapshotId, url: 'https://ais.example.edu/app', title: 'AIS', text: 'Upload',
        elements: [{ ref: 'r1', tag: 'input', role: '', type: 'file', name: 'Attach study plan', sensitive: true }],
      } }];
    }
    if (details.func?.name === 'verifyBrowserFileInput') return [{ frameId: 0, result: { ok: true, files: [{ name: 'plan.pdf', size: 100, type: 'application/pdf' }] } }];
    return original(details);
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'upload_download', frameId: 0, ref: 'r1', downloadRef: 'd1' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }),
    now: (() => { let n = 110_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Attach the downloaded plan' });
  await manager.start('job-1', { runInitial: false });
  await manager.ensureTab((await manager.get('job-1')).job);
  await manager.update(store => { store.byId['job-1'].runtime.knownDownloadIds = [42]; return store; });
  const pending = await manager.cycleOne('job-1');
  assert.equal(pending.kind, 'WAITING_APPROVAL');
  assert.equal(cdp.length, 0, 'file path must not be touched before explicit approval');

  await manager.approvePendingAction('job-1', { runInitial: false });
  const live = await manager.get('job-1');
  assert.equal(live.job.runtime.runState, 'RUNNING');
  assert.equal(live.job.runtime.stepCount, 1);
  const setFiles = cdp.find(entry => entry[0] === 'DOM.setFileInputFiles');
  assert.ok(setFiles);
  assert.deepEqual(setFiles[1].files, [fullPath]);
  assert.equal(JSON.stringify(live.job.runtime.history).includes(fullPath), false, 'full local path must never enter durable Agent history');
});

test('vision is on-demand: screenshot is ephemeral and attached only to the next reasoning call', async () => {
  const chrome = makeChrome();
  const calls = [];
  const cdp = [];
  chrome.debugger = {
    async attach(target, version) { cdp.push(['attach', target.tabId, version]); },
    async sendCommand(_target, method) {
      cdp.push([method]);
      if (method === 'Page.captureScreenshot') return { data: 'QUJDRA==' };
      return {};
    },
    async detach(target) { cdp.push(['detach', target.tabId]); },
  };
  const replies = [
    { text: JSON.stringify({ type: 'vision' }), usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'done', summary: 'Visual state inspected' }), usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14, modelCalls: 1 } },
  ];
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async payload => { calls.push(structuredClone(payload)); return replies.shift(); },
    now: (() => { let n = 120_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Inspect visual state', stepDelayMs: 0 });
  await manager.start('job-1', { runInitial: false });
  assert.equal((await manager.cycleOne('job-1')).kind, 'ACTION');
  let live = await manager.get('job-1');
  assert.equal(live.job.runtime.visionPending, true);
  assert.equal(calls[0].imageDataUrl, undefined);

  const final = await manager.cycleOne('job-1');
  assert.equal(final.kind, 'COMPLETED');
  live = await manager.get('job-1');
  assert.equal(calls[1].imageDataUrl, 'data:image/jpeg;base64,QUJDRA==');
  assert.match(calls[1].systemPrompt, /visual screenshot/i);
  assert.equal(live.job.runtime.visionPending, false);
  assert.equal(JSON.stringify(live.job.runtime).includes('QUJDRA=='), false, 'screenshot bytes must never become durable Browser Agent state');
  assert.ok(cdp.some(item => item[0] === 'Page.captureScreenshot'));
});

test('vision can drive a bounded native coordinate click without a DOM ref under ALLOW_ALL policy', async () => {
  const chrome = makeChrome();
  const cdp = [];
  const originalScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'probeBrowserCoordinateTarget') {
      return [{ frameId: 0, result: {
        x: details.args[0], y: details.args[1], url: 'https://ais.example.edu/app', viewportWidth: 1280, viewportHeight: 720,
        target: { tag: 'button', role: '', type: 'button', name: 'Open timetable', href: '', disabled: false, submitLike: false, formAssociated: false, formAction: '', formMethod: '', visualOnly: false },
      } }];
    }
    if (details.func?.name === 'verifyBrowserCoordinateTarget') return [{ frameId: 0, result: { ok: true } }];
    return originalScript(details);
  };
  chrome.debugger = {
    async attach(target, version) { cdp.push(['attach', target.tabId, version]); },
    async sendCommand(_target, method, params) {
      cdp.push([method, params]);
      if (method === 'Page.captureScreenshot') return { data: 'QUJDRA==' };
      return {};
    },
    async detach(target) { cdp.push(['detach', target.tabId]); },
  };
  const replies = [
    { text: JSON.stringify({ type: 'vision' }), usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'click_at', x: 640, y: 360 }), usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'done', summary: 'Timetable opened' }), usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5, modelCalls: 1 } },
  ];
  const prompts = [];
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async payload => { prompts.push(structuredClone(payload)); return replies.shift(); },
    now: (() => { let n = 121_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Open the visual timetable control', approvalMode: 'ALLOW_ALL', stepDelayMs: 0 });
  await manager.start('job-1', { runInitial: false });
  assert.equal((await manager.cycleOne('job-1')).kind, 'ACTION');
  assert.equal((await manager.cycleOne('job-1')).kind, 'ACTION');
  assert.match(prompts[1].prompt, /click_at/);
  assert.equal(prompts[1].imageDataUrl, 'data:image/jpeg;base64,QUJDRA==');
  const mouse = cdp.filter(([method]) => method === 'Input.dispatchMouseEvent');
  assert.equal(mouse.length, 2);
  assert.equal(mouse[0][1].x, 640);
  assert.equal(mouse[0][1].y, 360);
  assert.equal((await manager.cycleOne('job-1')).kind, 'COMPLETED');
});

test('coordinate click revalidates the exact target after debugger attach before native mouse input', async () => {
  const chrome = makeChrome();
  const cdp = [];
  let attached = false;
  const originalScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'probeBrowserCoordinateTarget') return [{ frameId: 0, result: {
      x: details.args[0], y: details.args[1], url: 'https://ais.example.edu/app', viewportWidth: 1280, viewportHeight: 720,
      target: { tag: 'button', role: '', type: 'button', name: 'Open timetable', href: '', disabled: false, submitLike: false, formAssociated: false, formAction: '', formMethod: '', editable: false, sensitive: false, visualOnly: false },
    } }];
    if (details.func?.name === 'verifyBrowserCoordinateTarget') return [{ frameId: 0, result: { ok: !attached } }];
    return originalScript(details);
  };
  chrome.debugger = {
    async attach() { attached = true; },
    async sendCommand(_target, method) { cdp.push(method); if (method === 'Page.captureScreenshot') return { data: 'QUJDRA==' }; return {}; },
    async detach() { attached = false; },
  };
  const replies = [
    { text: JSON.stringify({ type: 'vision' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'click_at', x: 500, y: 300 }), usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, modelCalls: 1 } },
  ];
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => replies.shift(), now: (() => { let n = 126_500; return () => ++n; })() });
  await manager.create({ id: 'job-1', goal: 'Open timetable safely', approvalMode: 'ALLOW_ALL', stepDelayMs: 0 });
  await manager.start('job-1', { runInitial: false });
  await manager.cycleOne('job-1');
  const result = await manager.cycleOne('job-1');
  assert.equal(result.kind, 'ACTION_RETRY');
  assert.equal(cdp.includes('Input.dispatchMouseEvent'), false, 'stale post-attach coordinate must never dispatch native mouse input');
});

test('visual-only coordinate click waits for approval and stale coordinate approval never dispatches mouse input', async () => {
  const chrome = makeChrome();
  const cdp = [];
  let verifyOk = true;
  const originalScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'probeBrowserCoordinateTarget') {
      return [{ frameId: 0, result: {
        x: details.args[0], y: details.args[1], url: 'https://ais.example.edu/app', viewportWidth: 1280, viewportHeight: 720,
        target: { tag: 'canvas', role: '', type: '', name: '', href: '', disabled: false, submitLike: false, formAssociated: false, formAction: '', formMethod: '', visualOnly: true },
      } }];
    }
    if (details.func?.name === 'verifyBrowserCoordinateTarget') return [{ frameId: 0, result: { ok: verifyOk } }];
    return originalScript(details);
  };
  chrome.debugger = {
    async attach() {},
    async sendCommand(_target, method) { cdp.push(method); if (method === 'Page.captureScreenshot') return { data: 'QUJDRA==' }; return {}; },
    async detach() {},
  };
  const replies = [
    { text: JSON.stringify({ type: 'vision' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'click_at', x: 600, y: 300 }), usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5, modelCalls: 1 } },
  ];
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => replies.shift(), now: (() => { let n = 122_000; return () => ++n; })() });
  await manager.create({ id: 'job-1', goal: 'Use the canvas control only with normal approval policy', stepDelayMs: 0 });
  await manager.start('job-1', { runInitial: false });
  await manager.cycleOne('job-1');
  const pending = await manager.cycleOne('job-1');
  assert.equal(pending.kind, 'WAITING_APPROVAL');
  assert.equal(cdp.filter(method => method === 'Input.dispatchMouseEvent').length, 0);
  verifyOk = false;
  await manager.approvePendingAction('job-1', { runInitial: false });
  const live = await manager.get('job-1');
  assert.equal(live.job.runtime.runState, 'PAUSED');
  assert.match(live.job.runtime.lastError, /visual action became stale/i);
  assert.equal(cdp.filter(method => method === 'Input.dispatchMouseEvent').length, 0);
});

test('vision can drive a bounded native coordinate drag under explicit ALLOW_ALL policy', async () => {
  const chrome = makeChrome();
  const cdp = [];
  const originalScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'probeBrowserCoordinateTarget') {
      const [x, y] = details.args;
      const isSource = x < 400;
      return [{ frameId: 0, result: {
        x, y, url: 'https://ais.example.edu/app', viewportWidth: 1280, viewportHeight: 720,
        target: {
          tag: 'div', role: '', type: '', name: isSource ? 'Course A' : 'Monday slot', href: '', disabled: false,
          submitLike: false, formAssociated: false, formAction: '', formMethod: '', visualOnly: true,
        },
      } }];
    }
    if (details.func?.name === 'verifyBrowserCoordinateTarget') return [{ frameId: 0, result: { ok: true } }];
    return originalScript(details);
  };
  chrome.debugger = {
    async attach(target, version) { cdp.push(['attach', target.tabId, version]); },
    async sendCommand(_target, method, params) {
      cdp.push([method, params]);
      if (method === 'Page.captureScreenshot') return { data: 'QUJDRA==' };
      return {};
    },
    async detach(target) { cdp.push(['detach', target.tabId]); },
  };
  const replies = [
    { text: JSON.stringify({ type: 'vision' }), usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'drag_at', startX: 220, startY: 300, endX: 700, endY: 300, durationMs: 450 }), usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'done', summary: 'Course moved' }), usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5, modelCalls: 1 } },
  ];
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => replies.shift(),
    now: (() => { let n = 123_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Move Course A to Monday slot', approvalMode: 'ALLOW_ALL', stepDelayMs: 0 });
  await manager.start('job-1', { runInitial: false });
  assert.equal((await manager.cycleOne('job-1')).kind, 'ACTION');
  assert.equal((await manager.cycleOne('job-1')).kind, 'ACTION');
  const mouse = cdp.filter(([method]) => method === 'Input.dispatchMouseEvent');
  assert.ok(mouse.length >= 6, 'native drag must include movement, press, intermediate movement and release');
  const pressed = mouse.find(([, params]) => params.type === 'mousePressed');
  const released = [...mouse].reverse().find(([, params]) => params.type === 'mouseReleased');
  const heldMoves = mouse.filter(([, params]) => params.type === 'mouseMoved' && params.buttons === 1);
  assert.ok(heldMoves.length >= 3, 'drag must contain intermediate held-button movement');
  assert.ok(heldMoves.every(([, params]) => params.button === 'none'), 'CDP mouseMoved must keep button=none while buttons=1 carries the held left-button state');
  assert.equal(pressed[1].x, 220);
  assert.equal(pressed[1].y, 300);
  assert.equal(released[1].x, 700);
  assert.equal(released[1].y, 300);
  assert.equal((await manager.cycleOne('job-1')).kind, 'COMPLETED');
});

test('coordinate drag revalidates both endpoints after debugger attach before any held-button movement', async () => {
  const chrome = makeChrome();
  const cdp = [];
  let attached = false;
  const originalScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'probeBrowserCoordinateTarget') {
      const [x, y] = details.args;
      return [{ frameId: 0, result: { x, y, url: 'https://ais.example.edu/app', viewportWidth: 1280, viewportHeight: 720, target: {
        tag: 'div', role: '', type: '', name: x < 400 ? 'Course A' : 'Monday slot', href: '', disabled: false, submitLike: false, formAssociated: false, formAction: '', formMethod: '', editable: false, sensitive: false, visualOnly: true,
      } } }];
    }
    if (details.func?.name === 'verifyBrowserCoordinateTarget') return [{ frameId: 0, result: { ok: !attached } }];
    return originalScript(details);
  };
  chrome.debugger = {
    async attach() { attached = true; },
    async sendCommand(_target, method) { cdp.push(method); if (method === 'Page.captureScreenshot') return { data: 'QUJDRA==' }; return {}; },
    async detach() { attached = false; },
  };
  const replies = [
    { text: JSON.stringify({ type: 'vision' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'drag_at', startX: 220, startY: 300, endX: 700, endY: 300 }), usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5, modelCalls: 1 } },
  ];
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => replies.shift(), now: (() => { let n = 126_600; return () => ++n; })() });
  await manager.create({ id: 'job-1', goal: 'Move course safely', approvalMode: 'ALLOW_ALL', stepDelayMs: 0 });
  await manager.start('job-1', { runInitial: false });
  await manager.cycleOne('job-1');
  const result = await manager.cycleOne('job-1');
  assert.equal(result.kind, 'ACTION_RETRY');
  assert.equal(cdp.includes('Input.dispatchMouseEvent'), false, 'stale post-attach drag endpoint must stop before native mouse events');
});

test('coordinate drag approval is TOCTOU-safe and stale source/destination dispatches no mouse input', async () => {
  const chrome = makeChrome();
  const cdp = [];
  let verifyCalls = 0;
  const originalScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'probeBrowserCoordinateTarget') {
      const [x, y] = details.args;
      return [{ frameId: 0, result: {
        x, y, url: 'https://ais.example.edu/app', viewportWidth: 1280, viewportHeight: 720,
        target: { tag: 'div', role: '', type: '', name: x < 400 ? 'Course A' : 'Monday slot', href: '', disabled: false, submitLike: false, formAssociated: false, formAction: '', formMethod: '', visualOnly: true },
      } }];
    }
    if (details.func?.name === 'verifyBrowserCoordinateTarget') {
      verifyCalls += 1;
      return [{ frameId: 0, result: { ok: verifyCalls === 1 } }];
    }
    return originalScript(details);
  };
  chrome.debugger = {
    async attach() {},
    async sendCommand(_target, method) { cdp.push(method); if (method === 'Page.captureScreenshot') return { data: 'QUJDRA==' }; return {}; },
    async detach() {},
  };
  const replies = [
    { text: JSON.stringify({ type: 'vision' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'drag_at', startX: 220, startY: 300, endX: 700, endY: 300 }), usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5, modelCalls: 1 } },
  ];
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => replies.shift(), now: (() => { let n = 124_000; return () => ++n; })() });
  await manager.create({ id: 'job-1', goal: 'Move Course A using normal approval policy', stepDelayMs: 0 });
  await manager.start('job-1', { runInitial: false });
  await manager.cycleOne('job-1');
  const pending = await manager.cycleOne('job-1');
  assert.equal(pending.kind, 'WAITING_APPROVAL');
  assert.equal(cdp.filter(method => method === 'Input.dispatchMouseEvent').length, 0);
  await manager.approvePendingAction('job-1', { runInitial: false });
  const live = await manager.get('job-1');
  assert.equal(live.job.runtime.runState, 'PAUSED');
  assert.match(live.job.runtime.lastError, /drag became stale/i);
  assert.equal(cdp.filter(method => method === 'Input.dispatchMouseEvent').length, 0);
});

test('vision can focus a coordinate text target and insert text through native CDP input', async () => {
  const chrome = makeChrome();
  const cdp = [];
  const originalScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'probeBrowserCoordinateTarget') {
      return [{ frameId: 0, result: {
        x: details.args[0], y: details.args[1], url: 'https://ais.example.edu/app', viewportWidth: 1280, viewportHeight: 720,
        target: { tag: 'textarea', role: '', type: '', name: 'Schedule note', href: '', disabled: false, submitLike: false, formAssociated: true, formAction: '', formMethod: 'post', editable: true, sensitive: false, visualOnly: false },
      } }];
    }
    if (details.func?.name === 'verifyBrowserCoordinateTarget') return [{ frameId: 0, result: { ok: true } }];
    return originalScript(details);
  };
  chrome.debugger = {
    async attach() {},
    async sendCommand(_target, method, params) {
      cdp.push([method, params]);
      if (method === 'Page.captureScreenshot') return { data: 'QUJDRA==' };
      return {};
    },
    async detach() {},
  };
  const replies = [
    { text: JSON.stringify({ type: 'vision' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'type_at', x: 500, y: 350, text: 'No Friday conflict' }), usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'done', summary: 'Note entered' }), usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, modelCalls: 1 } },
  ];
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => replies.shift(), now: (() => { let n = 125_000; return () => ++n; })() });
  await manager.create({ id: 'job-1', goal: 'Enter schedule note visually', stepDelayMs: 0 });
  await manager.start('job-1', { runInitial: false });
  assert.equal((await manager.cycleOne('job-1')).kind, 'ACTION');
  assert.equal((await manager.cycleOne('job-1')).kind, 'ACTION');
  assert.ok(cdp.some(([method, params]) => method === 'Input.insertText' && params.text === 'No Friday conflict'));
  assert.equal((await manager.cycleOne('job-1')).kind, 'COMPLETED');
});

test('coordinate typing revalidates edit target after debugger attach before Input.insertText', async () => {
  const chrome = makeChrome();
  const cdp = [];
  let attached = false;
  const originalScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'probeBrowserCoordinateTarget') return [{ frameId: 0, result: {
      x: details.args[0], y: details.args[1], url: 'https://ais.example.edu/app', viewportWidth: 1280, viewportHeight: 720,
      target: { tag: 'textarea', role: '', type: '', name: 'Schedule note', href: '', disabled: false, submitLike: false, formAssociated: true, formAction: '', formMethod: 'post', editable: true, sensitive: false, visualOnly: false },
    } }];
    if (details.func?.name === 'verifyBrowserCoordinateTarget') return [{ frameId: 0, result: { ok: !attached } }];
    return originalScript(details);
  };
  chrome.debugger = {
    async attach() { attached = true; },
    async sendCommand(_target, method) { cdp.push(method); if (method === 'Page.captureScreenshot') return { data: 'QUJDRA==' }; return {}; },
    async detach() { attached = false; },
  };
  const replies = [
    { text: JSON.stringify({ type: 'vision' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'type_at', x: 500, y: 350, text: 'No Friday' }), usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5, modelCalls: 1 } },
  ];
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => replies.shift(), now: (() => { let n = 126_700; return () => ++n; })() });
  await manager.create({ id: 'job-1', goal: 'Type note safely', approvalMode: 'ALLOW_ALL', stepDelayMs: 0 });
  await manager.start('job-1', { runInitial: false });
  await manager.cycleOne('job-1');
  const result = await manager.cycleOne('job-1');
  assert.equal(result.kind, 'ACTION_RETRY');
  assert.equal(cdp.includes('Input.insertText'), false, 'stale post-attach text target must block native text insertion');
});

test('coordinate typing refuses password/file targets before any native text insertion', async () => {
  const chrome = makeChrome();
  const cdp = [];
  const originalScript = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async details => {
    if (details.func?.name === 'probeBrowserCoordinateTarget') {
      return [{ frameId: 0, result: {
        x: details.args[0], y: details.args[1], url: 'https://ais.example.edu/app', viewportWidth: 1280, viewportHeight: 720,
        target: { tag: 'input', role: '', type: 'password', name: 'Password', href: '', disabled: false, submitLike: false, formAssociated: true, formAction: '', formMethod: 'post', editable: false, sensitive: true, visualOnly: false },
      } }];
    }
    return originalScript(details);
  };
  chrome.debugger = {
    async attach() {},
    async sendCommand(_target, method, params) { cdp.push([method, params]); if (method === 'Page.captureScreenshot') return { data: 'QUJDRA==' }; return {}; },
    async detach() {},
  };
  const replies = [
    { text: JSON.stringify({ type: 'vision' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } },
    { text: JSON.stringify({ type: 'type_at', x: 500, y: 350, text: 'do-not-type-this' }), usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, modelCalls: 1 } },
  ];
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => replies.shift(), now: (() => { let n = 126_000; return () => ++n; })() });
  await manager.create({ id: 'job-1', goal: 'Never type into secrets', approvalMode: 'ALLOW_ALL', stepDelayMs: 0 });
  await manager.start('job-1', { runInitial: false });
  await manager.cycleOne('job-1');
  const result = await manager.cycleOne('job-1');
  assert.equal(result.kind, 'ACTION_RETRY');
  const live = await manager.get('job-1');
  assert.match(live.job.runtime.lastError, /SENSITIVE_FIELD_BLOCKED/);
  assert.equal(cdp.some(([method]) => method === 'Input.insertText'), false);
});

test('owner can disable on-demand vision capability without breaking the Agent loop', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text: JSON.stringify({ type: 'vision' }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 } }) });
  await manager.create({ id: 'job-1', goal: 'DOM only', visionOnDemand: false });
  await manager.start('job-1', { runInitial: false });
  const result = await manager.cycleOne('job-1');
  const live = await manager.get('job-1');
  assert.equal(result.kind, 'ACTION_RETRY');
  assert.match(live.job.runtime.lastError, /vision is disabled/i);
});

test('failed provider attempt consumes model-call budget and prevents retry from exceeding the ceiling', async () => {
  const chrome = makeChrome();
  let calls = 0;
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => {
      calls += 1;
      const error = new Error('primary provider failed');
      error.modelCallsUsed = 1;
      throw error;
    },
    now: (() => { let n = 130_000; return () => ++n; })(),
  });
  await manager.create({ id: 'job-1', goal: 'Respect exact model-call ceiling', maxModelCalls: 1 });
  await manager.start('job-1', { runInitial: false });
  const first = await manager.cycleOne('job-1');
  assert.equal(first.kind, 'MODEL_RETRY');
  let live = await manager.get('job-1');
  assert.equal(live.job.runtime.modelCalls, 1, 'failed provider call is still a consumed model call');
  assert.equal(calls, 1);

  const second = await manager.cycleOne('job-1');
  live = await manager.get('job-1');
  assert.equal(second.kind, 'BUDGET_PAUSED');
  assert.equal(live.job.runtime.runState, 'PAUSED');
  assert.equal(calls, 1, 'no second provider call may occur after the exact ceiling is exhausted');
});

test('Trusted Script is opt-in, parser blocks secret/network primitives, and every script is consequential', () => {
  const disabled = config();
  assert.equal(disabled.trustedScriptEnabled, false);
  const enabled = config({ trustedScriptEnabled: true });
  assert.equal(enabled.trustedScriptEnabled, true);
  const snapshot = { url: 'https://ais.example.edu/app', frames: [{ frameId: 0, elements: [] }] };
  const action = parseBrowserAgentAction(JSON.stringify({
    type: 'trusted_script',
    purpose: 'Activate legacy timetable control',
    code: 'document.querySelector("#legacy")?.click();',
  }), snapshot);
  assert.equal(action.type, 'trusted_script');
  assert.equal(action.origin, 'https://ais.example.edu');
  assert.match(action.code, /querySelector/);
  assert.equal(classifyBrowserAgentActionRisk(snapshot, action).requiresApproval, true);
  assert.throws(() => parseBrowserAgentAction(JSON.stringify({ type: 'trusted_script', code: 'fetch("https://evil.example/")' }), snapshot), /network APIs/);
  assert.throws(() => parseBrowserAgentAction(JSON.stringify({ type: 'trusted_script', code: 'document.cookie' }), snapshot), /cookies/);
  assert.throws(() => parseBrowserAgentAction(JSON.stringify({ type: 'trusted_script', code: 'localStorage.getItem("x")' }), snapshot), /browser storage/);
  assert.throws(() => parseBrowserAgentAction(JSON.stringify({ type: 'trusted_script', code: 'location.href="https://example.com"' }), snapshot), /script navigation/);
  assert.throws(() => parseBrowserAgentAction(JSON.stringify({ type: 'trusted_script', code: 'globalThis["fetch"]("https://evil.example")' }), snapshot), /(?:computed access|network APIs)/);
  assert.throws(() => parseBrowserAgentAction(JSON.stringify({ type: 'trusted_script', code: 'setTimeout(() => document.body.remove(), 1)' }), snapshot), /asynchronous callbacks/);
});

test('Trusted Script planner tool is visible only when owner policy explicitly enables it', () => {
  const snapshot = { url: 'https://ais.example.edu/app', frames: [{ frameId: 0, elements: [] }] };
  const runtime = { stepCount: 0, modelCalls: 0, totalTokens: 0, history: [], ownerInstructions: [] };
  const off = buildBrowserAgentPlannerPrompt(config({ trustedScriptEnabled: false }), runtime, snapshot);
  assert.match(off, /Trusted Script fallback is disabled by owner policy/);
  const on = buildBrowserAgentPlannerPrompt(config({ trustedScriptEnabled: true }), runtime, snapshot);
  assert.match(on, /trusted_script/);
  assert.match(on, /Owner policy requires confirmation/i);
});

test('Trusted Script runs autonomously under ALLOW_ALL while preserving CDP sandboxing', async () => {
  const chrome = makeChrome();
  const debuggerCalls = [];
  chrome.debugger.sendCommand = async (_target, method, params = {}) => {
    debuggerCalls.push({ method, params: structuredClone(params) });
    if (method === 'Runtime.evaluate') return { result: { type: 'undefined' } };
    return {};
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({
      text: JSON.stringify({
        type: 'trusted_script',
        purpose: 'Activate inaccessible legacy timetable control',
        code: 'document.querySelector("#legacy")?.click();',
      }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1 },
    }),
  });
  await manager.create({ id: 'job-1', goal: 'Use legacy timetable safely', trustedScriptEnabled: true, approvalMode: 'ALLOW_ALL' });
  await manager.start('job-1', { runInitial: false });
  const cycle = await manager.cycleOne('job-1');
  assert.equal(cycle.kind, 'ACTION');
  const runtimeCalls = debuggerCalls.filter(call => call.method === 'Runtime.evaluate');
  assert.equal(runtimeCalls.length, 1);
  assert.match(runtimeCalls[0].params.expression, /querySelector/);
  const blockIndex = debuggerCalls.findIndex(call => call.method === 'Network.setBlockedURLs' && call.params.urls?.[0] === '*');
  const evalIndex = debuggerCalls.findIndex(call => call.method === 'Runtime.evaluate');
  const unblockIndex = debuggerCalls.findIndex((call, index) => index > evalIndex && call.method === 'Network.setBlockedURLs' && Array.isArray(call.params.urls) && call.params.urls.length === 0);
  assert.ok(blockIndex >= 0 && blockIndex < evalIndex, 'network guard must be armed before Trusted Script execution');
  assert.ok(unblockIndex > evalIndex, 'network guard must be removed after Trusted Script execution');
  const live = await manager.get('job-1');
  assert.equal(live.job.runtime.stepCount, 1);
  const serializedHistory = JSON.stringify(live.job.runtime.history);
  assert.ok(!serializedHistory.includes('querySelector'), 'durable history must redact Trusted Script source after execution');
  assert.ok(serializedHistory.includes('trusted-script-executed'));
});

test('Trusted Script consequential approval is invalidated if the approved browser URL changes before execution', async () => {
  const chrome = makeChrome();
  let evaluateCalls = 0;
  chrome.debugger.sendCommand = async (_target, method) => {
    if (method === 'Runtime.evaluate') evaluateCalls += 1;
    return {};
  };
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: JSON.stringify({ type: 'trusted_script', purpose: 'legacy click', code: 'document.body.dataset.test="1";' }) }),
  });
  await manager.create({ id: 'job-1', goal: 'legacy UI', trustedScriptEnabled: true, approvalMode: 'CONSEQUENTIAL' });
  await manager.start('job-1', { runInitial: false });
  assert.equal((await manager.cycleOne('job-1')).kind, 'WAITING_APPROVAL');
  chrome._tabs.get(1).url = 'https://other.example.org/changed';
  const after = await manager.approvePendingAction('job-1', { runInitial: false });
  assert.equal(after.job.runtime.runState, 'PAUSED');
  assert.equal(evaluateCalls, 0);
  assert.match(after.job.runtime.lastError, /no longer available|stale|changed/i);
});


test('Browser Agent specialist wrappers snapshot caller payloads before authority reads', async () => {
  const chrome = makeChrome();
  const at = '2026-09-23T12:00:00.000Z';
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => Date.parse(at),
  });
  await manager.create({ id: 'job-wrapper-boundary', goal: 'Exercise specialist request boundary' });
  await manager.update(store => {
    store.byId['job-wrapper-boundary'].runtime.plan = {
      schemaVersion: 1,
      planId: 'plan-wrapper-boundary',
      jobId: 'job-wrapper-boundary',
      objective: 'Complete safely',
      successCriteria: ['Verified'],
      createdAt: at,
      updatedAt: at,
      revision: 1,
      nodes: [
        {
          nodeId: 'inspect',
          title: 'Inspect',
          objective: 'Inspect page',
          dependsOn: [],
          conflictKeys: ['web:wrapper'],
          ownerId: 'parent',
          executionPlane: 'BROWSER',
          acceptanceCriteria: [],
          budget: {},
          state: 'VERIFIED',
          evidence: 'Observed',
          updatedAt: at,
        },
        {
          nodeId: 'archive',
          title: 'Archive',
          objective: 'Create archive',
          dependsOn: ['inspect'],
          conflictKeys: ['files:wrapper'],
          ownerId: 'parent',
          executionPlane: 'LOCAL',
          acceptanceCriteria: ['Archive exists'],
          budget: {},
          state: 'PENDING',
          evidence: '',
          updatedAt: at,
        },
      ],
    };
    return store;
  });

  let reads = 0;
  const payload = new Proxy({
    nodeId: 'archive',
    specialistId: 'native-companion',
    requestedCapabilityIds: ['filesystem.archive'],
    parentCapabilityIds: ['filesystem.archive'],
    policyEnvelopeId: 'policy:wrapper',
    deadlineAt: '2026-09-23T13:00:00.000Z',
    at,
  }, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  const prepared = await manager.prepareSpecialistHandoff('job-wrapper-boundary', payload);
  assert.equal(prepared.assignment.state, 'READY');
  assert.equal(reads, 0, 'Browser Agent wrapper must not ordinary-read a caller Proxy payload');

  let getterCalls = 0;
  const hostileAcrossJobs = { at };
  Object.defineProperty(hostileAcrossJobs, 'maxConcurrentHandoffs', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  await assert.rejects(
    () => manager.claimSpecialistHandoffsAcrossJobs(hostileAcrossJobs),
    /maxConcurrentHandoffs must be an enumerable data property/,
  );
  assert.equal(getterCalls, 0, 'cross-job capacity getter must never execute');

  let coercions = 0;
  await assert.rejects(
    () => manager.claimSpecialistHandoffsAcrossJobs({
      maxConcurrentHandoffs: {
        valueOf() {
          coercions += 1;
          return 1;
        },
      },
      at,
    }),
    /maxConcurrentHandoffs must be an integer/,
  );
  assert.equal(coercions, 0, 'cross-job capacity must never be coerced');
});


test('Browser Agent input-token admission includes an existing durable reservation without throwing', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text:'{}' }),
    now: () => 49_000,
  });
  await manager.create({
    id:'job-input-reservation-headroom',
    goal:'Respect reserved input-token headroom',
    maxInputTokens:12,
  });
  await manager.update(store => {
    const job = store.byId['job-input-reservation-headroom'];
    job.runtime.inputTokens = 3;
    job.runtime.totalTokens = 3;
    job.runtime.modelBudgetReservation = {
      reservationId:'job-input-reservation-headroom:model-budget:1',
      controlEpoch:0,
      modelCalls:1,
      inputTokens:4,
      outputTokens:2,
      totalTokens:6,
      estimatedCostUsd:0,
      createdAt:48_000,
      routeId:'primary',
      provider:'ollama',
      model:'qwen:8b',
      callNumber:1,
    };
    return store;
  });

  const current = await manager.get('job-input-reservation-headroom');
  assert.doesNotThrow(() => manager.budgetReason(current.job, { pendingInputTokens:5 }));
  assert.equal(manager.budgetReason(current.job, { pendingInputTokens:5 }), '');
  assert.equal(
    manager.budgetReason(current.job, { pendingInputTokens:6 }),
    'maximum input-token budget reached',
  );
});

test('Browser Agent persists provider-call budget before I/O and restart cannot regain the reservation', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }), now: () => 50_000 });
  await manager.create({
    id:'job-budget-restart',
    goal:'Use a bounded model budget safely',
    maxModelCalls:1,
    maxOutputTokensPerCall:128,
    inputPricePerMillionUsd:1,
    outputPricePerMillionUsd:2,
  });
  await manager.update(store => {
    store.byId['job-budget-restart'].runtime.runState = 'RUNNING';
    return store;
  });

  const reservation = await manager.reserveProviderModelBudget({
    jobId:'job-budget-restart',
    controlEpoch:0,
    prompt:'bounded prompt',
    systemPrompt:'bounded system',
    maxOutputTokens:128,
    route:{ routeId:'primary', provider:'ollama', model:'qwen:8b' },
    callNumber:1,
  });
  const beforeRestart = await manager.get('job-budget-restart');
  assert.equal(beforeRestart.job.runtime.modelCalls, 0);
  assert.equal(beforeRestart.job.runtime.modelBudgetReservation.reservationId, reservation.reservationId);
  assert.equal(beforeRestart.job.runtime.modelBudgetReservation.modelCalls, 1);
  assert.equal(beforeRestart.job.runtime.modelBudgetReservation.outputTokens, 128);

  await assert.rejects(
    () => manager.reserveProviderModelBudget({
      jobId:'job-budget-restart',
      controlEpoch:0,
      prompt:'must not double reserve',
      systemPrompt:'system',
      maxOutputTokens:128,
    }),
    error => {
      assert.equal(error.code, 'AI_MODEL_BUDGET_RESERVATION_PENDING');
      return true;
    },
  );

  const restarted = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }), now: () => 51_000 });
  assert.equal(await restarted.reconcileProviderModelBudgetReservation('job-budget-restart'), true);
  const recovered = await restarted.get('job-budget-restart');
  assert.equal(recovered.job.runtime.modelBudgetReservation, null);
  assert.equal(recovered.job.runtime.modelCalls, 1);
  assert.ok(recovered.job.runtime.inputTokens > 0);
  assert.equal(recovered.job.runtime.outputTokens, 128);
  assert.equal(recovered.job.runtime.history.at(-1).type, 'model-budget-recovered-after-restart');

  await assert.rejects(
    () => restarted.reserveProviderModelBudget({
      jobId:'job-budget-restart',
      controlEpoch:0,
      prompt:'must remain exhausted after restart',
      systemPrompt:'system',
      maxOutputTokens:128,
    }),
    error => {
      assert.equal(error.code, 'AI_MODEL_BUDGET_EXHAUSTED');
      assert.match(error.safeBudgetReason, /model-call budget/);
      return true;
    },
  );
});

test('Browser Agent successful provider settlement uses exact usage once and clears its reservation', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }), now: () => 60_000 });
  await manager.create({
    id:'job-budget-success',
    goal:'Settle actual model usage',
    maxModelCalls:3,
    maxOutputTokensPerCall:256,
    inputPricePerMillionUsd:2,
    outputPricePerMillionUsd:4,
  });
  await manager.update(store => {
    store.byId['job-budget-success'].runtime.runState = 'RUNNING';
    return store;
  });
  const reservation = await manager.reserveProviderModelBudget({
    jobId:'job-budget-success',
    controlEpoch:0,
    prompt:'prompt',
    systemPrompt:'system',
    maxOutputTokens:256,
  });
  assert.deepEqual(
    await manager.settleProviderModelBudget({
      jobId:'job-budget-success',
      reservationId:reservation.reservationId,
      ok:true,
      result:{ text:'done', usage:{ inputTokens:11, outputTokens:7, totalTokens:18 } },
    }),
    { settled:true },
  );
  const current = await manager.get('job-budget-success');
  assert.equal(current.job.runtime.modelBudgetReservation, null);
  assert.equal(current.job.runtime.modelCalls, 1);
  assert.equal(current.job.runtime.inputTokens, 11);
  assert.equal(current.job.runtime.outputTokens, 7);
  assert.equal(current.job.runtime.totalTokens, 18);
  assert.equal(current.job.runtime.estimatedCostUsd, (11 / 1_000_000) * 2 + (7 / 1_000_000) * 4);
  assert.equal(current.job.runtime.history.at(-1).type, 'model-budget-settled');
  assert.deepEqual(
    await manager.settleProviderModelBudget({
      jobId:'job-budget-success',
      reservationId:reservation.reservationId,
      ok:true,
      result:{ text:'duplicate', usage:{ inputTokens:999, outputTokens:999, totalTokens:1998 } },
    }),
    { settled:false },
  );
  assert.equal((await manager.get('job-budget-success')).job.runtime.modelCalls, 1);
});

test('Browser Agent conservatively consumes the bounded reservation after an admitted provider failure', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }), now: () => 70_000 });
  await manager.create({
    id:'job-budget-failure',
    goal:'Fail closed on uncertain provider spend',
    maxModelCalls:2,
    maxOutputTokensPerCall:192,
    inputPricePerMillionUsd:1,
    outputPricePerMillionUsd:3,
  });
  await manager.update(store => {
    store.byId['job-budget-failure'].runtime.runState = 'RUNNING';
    return store;
  });
  const reservation = await manager.reserveProviderModelBudget({
    jobId:'job-budget-failure',
    controlEpoch:0,
    prompt:'prompt with bounded input',
    systemPrompt:'system',
    maxOutputTokens:192,
  });
  await manager.settleProviderModelBudget({
    jobId:'job-budget-failure',
    reservationId:reservation.reservationId,
    ok:false,
  });
  const current = await manager.get('job-budget-failure');
  assert.equal(current.job.runtime.modelBudgetReservation, null);
  assert.equal(current.job.runtime.modelCalls, 1);
  assert.equal(current.job.runtime.inputTokens, reservation.inputTokens);
  assert.equal(current.job.runtime.outputTokens, 192);
  assert.equal(current.job.runtime.totalTokens, reservation.totalTokens);
  assert.equal(current.job.runtime.estimatedCostUsd, reservation.estimatedCostUsd);
  assert.equal(current.job.runtime.history.at(-1).type, 'model-budget-conservative-settlement');
});

test('Browser Agent reservation fails closed when owner authority changes before dispatch', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({ chromeApi: chrome, routePrompt: async () => ({ text:'{}' }) });
  await manager.create({ id:'job-budget-owner', goal:'Respect owner cancellation', maxModelCalls:2, maxOutputTokensPerCall:128 });
  await manager.update(store => {
    store.byId['job-budget-owner'].runtime.runState = 'RUNNING';
    store.byId['job-budget-owner'].runtime.controlEpoch = 4;
    return store;
  });
  await assert.rejects(
    () => manager.reserveProviderModelBudget({
      jobId:'job-budget-owner',
      controlEpoch:3,
      prompt:'stale owner context',
      systemPrompt:'system',
      maxOutputTokens:128,
    }),
    error => {
      assert.equal(error.code, 'BROWSER_AGENT_OWNER_AUTHORITY_CHANGED');
      return true;
    },
  );
  const current = await manager.get('job-budget-owner');
  assert.equal(current.job.runtime.modelBudgetReservation, null);
  assert.equal(current.job.runtime.modelCalls, 0);
});


test('owner approval fence rejects a replacement pending action that races with asynchronous tab verification', async () => {
  const chrome = makeChrome();
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: (() => { let n = 200_000; return () => ++n; })(),
  });
  await manager.create({ id: 'approval-race-job', goal: 'Never execute a stale approval' });
  await manager.update(store => {
    const job = store.byId['approval-race-job'];
    job.runtime.runState = 'WAITING_APPROVAL';
    job.runtime.controlEpoch = 10;
    job.runtime.updatedAt = 200_010;
    job.runtime.pendingApproval = {
      action: { type: 'click', frameId: 0, ref: 'r1' },
      snapshotId: 'snapshot-old',
      snapshotSignature: 'signature-old',
      url: 'https://ais.example.edu/app',
      tabId: 1,
      targetName: 'Old action',
      targetFingerprint: null,
      dragStartFingerprint: null,
      dragEndFingerprint: null,
      reason: 'Old approval',
      requestedAt: 200_009,
    };
    return store;
  });
  const before = await manager.get('approval-race-job');
  const oldFence = {
    controlEpoch: before.job.runtime.controlEpoch,
    updatedAt: before.job.runtime.updatedAt,
    snapshotId: before.job.runtime.pendingApproval.snapshotId,
    snapshotSignature: before.job.runtime.pendingApproval.snapshotSignature,
    requestedAt: before.job.runtime.pendingApproval.requestedAt,
  };

  const originalGet = chrome.tabs.get.bind(chrome.tabs);
  let swapped = false;
  chrome.tabs.get = async id => {
    if (!swapped) {
      swapped = true;
      await manager.update(store => {
        const job = store.byId['approval-race-job'];
        job.runtime.controlEpoch = 11;
        job.runtime.updatedAt = 200_012;
        job.runtime.pendingApproval = {
          ...job.runtime.pendingApproval,
          action: { type: 'click', frameId: 0, ref: 'r2' },
          snapshotId: 'snapshot-new',
          snapshotSignature: 'signature-new',
          targetName: 'New action',
          reason: 'New approval',
          requestedAt: 200_011,
        };
        return store;
      });
    }
    return originalGet(id);
  };

  await assert.rejects(
    () => manager.approvePendingAction('approval-race-job', {
      runInitial: false,
      expectedApproval: oldFence,
    }),
    error => error?.code === 'BROWSER_AGENT_APPROVAL_STALE',
  );
  chrome.tabs.get = originalGet;
  let live = await manager.get('approval-race-job');
  assert.equal(chrome._actionCalls.length, 0, 'raced stale approval must execute nothing');
  assert.equal(live.job.runtime.runState, 'WAITING_APPROVAL');
  assert.equal(live.job.runtime.pendingApproval.snapshotId, 'snapshot-new');
  assert.equal(live.job.runtime.pendingApproval.action.ref, 'r2');

  await assert.rejects(
    () => manager.rejectPendingAction('approval-race-job', { expectedApproval: oldFence }),
    error => error?.code === 'BROWSER_AGENT_APPROVAL_STALE',
  );
  live = await manager.get('approval-race-job');
  assert.equal(live.job.runtime.runState, 'WAITING_APPROVAL');
  assert.equal(live.job.runtime.pendingApproval.snapshotId, 'snapshot-new', 'stale reject must not clear the replacement approval');
});
