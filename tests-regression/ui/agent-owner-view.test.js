import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createAgentViewFenceV1, createAgentJobsReadGateV1, readAgentJobsWithDeadlineV1,
  describeAgentSpecialistProgressV1 } from '../../src/ui/agent-owner-view.js';

const source = fs.readFileSync(new URL('../../src/ui/options.js', import.meta.url), 'utf8');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function drain() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = source.slice(start + 1);
  const next = tail.search(/\n(?:async )?function /u);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}
function job(id, runState = 'PAUSED', runtime = {}) { return { id, config: { name: id }, runtime: { runState, ...runtime } }; }
function harness(handler) {
  const nodes = new Map(), calls = [], rendered = [];
  const ui = { browserAgentJobs: [job('a'), job('b')], selectedBrowserAgentId: 'a', selectedBrowserAgent: job('a'),
    agentPolicyEditEpoch: 0, agentPolicyDirty: false, agentDraftActive: false, specialistRegistries: [] };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, disabled: false, textContent: '', focus() {} });
    return nodes.get(id);
  };
  const context = { ui, $: node, createAgentViewFenceV1, createAgentJobsReadGateV1, readAgentJobsWithDeadlineV1,
    describeAgentSpecialistProgressV1, Date, Set, Promise,
    core: async (command, payload) => { calls.push({ command, payload }); return handler(command, payload); },
    renderBrowserAgentJob(value) { ui.selectedBrowserAgent = value; rendered.push(value?.id || ''); },
    renderBrowserAgentList() {}, renderSpecialistDelegationControls() {}, announce() {},
    assertBrowserAgentRouteReadyForLaunch() {}, browserAgentPolicyFromForm: () => ({}), browserAgentStateLabel: value => value,
    browserAgentNameFromGoal: value => value, buildAgentDefinitionLaunchRequestV1: () => ({}),
    agentDefinitionLaunchFormValue: () => ({}), browserAgentOwnerBudgetPolicyFromForm: () => ({}),
    chrome: { permissions: { request: async () => true } } };
  vm.createContext(context);
  const helpers = source.slice(source.indexOf('const agentViewFence ='), source.indexOf('const announce ='));
  vm.runInContext(helpers, context);
  for (const name of ['loadBrowserAgentJobs', 'selectBrowserAgentJob', 'browserAgentLifecycle', 'runBrowserAgentPrompt',
    'deleteBrowserAgentJob', 'prepareAutomaticSpecialistDelegation', 'createBrowserAgentFromDefinition',
    'sendBrowserAgentFollowUp', 'requestBrowserAgentPermission', 'requestBrowserAgentCapability',
    'approveBrowserAgentAction', 'rejectBrowserAgentAction']) {
    vm.runInContext(functionSource(name), context);
  }
  context.selectBrowserAgentView('a');
  return { ui, nodes, node, calls, rendered, context };
}

test('late selection of A cannot replace the newer selected B', async () => {
  const a = deferred(), b = deferred();
  const h = harness((command, { id }) => id === 'a' ? a.promise : b.promise);
  h.node('agent-job-list').value = 'a'; const first = h.context.selectBrowserAgentJob();
  h.node('agent-job-list').value = 'b'; const second = h.context.selectBrowserAgentJob();
  b.resolve({ job: job('b') }); await second;
  a.resolve({ job: job('a') }); await first;
  assert.equal(h.ui.selectedBrowserAgentId, 'b'); assert.equal(h.ui.selectedBrowserAgent.id, 'b');
  assert.equal(h.rendered.at(-1), 'b');
});

test('Stop remains available during a slow run and its state survives the late run reply', async () => {
  const run = deferred(); let stopped = false;
  const h = harness(command => {
    if (command === 'RUN_BROWSER_AGENT_BURST') return run.promise;
    if (command === 'STOP_BROWSER_AGENT_JOB') { stopped = true; return {}; }
    return { jobs: [job('a', stopped ? 'STOPPED' : 'RUNNING')], selectedId: 'a' };
  });
  const running = h.context.browserAgentLifecycle('RUN_BROWSER_AGENT_BURST');
  await h.context.browserAgentLifecycle('STOP_BROWSER_AGENT_JOB');
  run.resolve({ job: job('a', 'RUNNING') }); await running;
  assert.equal(h.ui.selectedBrowserAgent.runtime.runState, 'STOPPED');
  assert.match(h.node('agent-command-result').textContent, /Stop/);
  assert.equal(h.calls.filter(c => c.command === 'LIST_BROWSER_AGENT_JOBS').length, 1);
});

test('late lifecycle acknowledgement does not switch the owner back from B to A', async () => {
  const pause = deferred(); const h = harness(() => pause.promise);
  const operation = h.context.browserAgentLifecycle('PAUSE_BROWSER_AGENT_JOB');
  h.context.selectBrowserAgentView('b'); h.ui.selectedBrowserAgent = job('b');
  pause.resolve({ job: job('a') }); await operation;
  assert.equal(h.ui.selectedBrowserAgentId, 'b'); assert.equal(h.ui.selectedBrowserAgent.id, 'b');
  assert.equal(h.calls.length, 1);
});

test('an old list cannot resurrect a deleted Agent', async () => {
  const old = deferred(); let reads = 0;
  const h = harness(command => command === 'LIST_BROWSER_AGENT_JOBS'
    ? (++reads === 1 ? old.promise : { jobs: [job('b')], selectedId: 'b' }) : {});
  const read = h.context.loadBrowserAgentJobs(); await drain();
  const deletion = h.context.deleteBrowserAgentJob(); await drain();
  old.resolve({ jobs: [job('a'), job('b')], selectedId: 'a' });
  await Promise.all([read, deletion]);
  assert.equal(h.ui.selectedBrowserAgentId, 'b');
  assert.deepEqual(h.ui.browserAgentJobs.map(j => j.id), ['b']); assert.equal(reads, 2);
});

test('one hundred refresh ticks share one pending Core request', async () => {
  const pending = deferred(); const h = harness(() => pending.promise);
  const ticks = Array.from({ length: 100 }, () => h.context.refreshBrowserAgentJobs());
  await drain(); assert.equal(h.calls.length, 1);
  pending.resolve({ jobs: [job('a')] }); await Promise.all(ticks);
});

test('bounded status refresh continues during a long run instead of freezing the progress view', async () => {
  const run = deferred(); const h = harness(command => command === 'RUN_BROWSER_AGENT_BURST'
    ? run.promise : { jobs: [job('a', 'RUNNING', { stepCount: 7 })] });
  const executing = h.context.browserAgentLifecycle('RUN_BROWSER_AGENT_BURST');
  await h.context.refreshBrowserAgentJobs();
  assert.equal(h.ui.selectedBrowserAgent.runtime.stepCount, 7);
  run.resolve({}); await executing;
});

test('a UI read timeout does not release the unresolved underlying message or accumulate reads', async () => {
  const pending = deferred(); let calls = 0, fire;
  const gate = createAgentJobsReadGateV1(() => { calls++; return pending.promise; });
  const timed = readAgentJobsWithDeadlineV1(() => gate.read(), { setTimer(callback) { fire = callback; return 1; }, clearTimer() {} });
  await drain(); fire(); await assert.rejects(timed, /не відповів/);
  const reads = Array.from({ length: 100 }, () => gate.read());
  await drain(); assert.equal(calls, 1);
  pending.resolve({ jobs: [] }); await Promise.all(reads);
});

test('confirmed create survives a later Start failure and is not created twice', async () => {
  const h = harness(command => {
    if (command === 'CREATE_BROWSER_AGENT_JOB') return { job: job('created', 'STOPPED') };
    if (command === 'START_BROWSER_AGENT_JOB') throw Error('provider unavailable');
    return {};
  });
  h.node('agent-prompt').value = 'Do the task'; await h.context.runBrowserAgentPrompt();
  assert.equal(h.ui.selectedBrowserAgentId, 'created');
  assert.match(h.node('agent-command-result').textContent, /created.*вже створено/);
  assert.equal(h.calls.filter(c => c.command === 'CREATE_BROWSER_AGENT_JOB').length, 1);
});

test('definition create acknowledgement survives a failed list refresh', async () => {
  const h = harness(command => {
    if (command === 'CREATE_BROWSER_AGENT_JOB_FROM_DEFINITION') return { job: job('new-definition', 'STOPPED') };
    throw Error('list unavailable');
  });
  h.ui.selectedAgentDefinitionRegistry = { registryId: 'r' };
  h.ui.selectedAgentDefinition = { agentDefinitionId: 'd', label: 'Worker', enabled: true };
  await h.context.createBrowserAgentFromDefinition();
  assert.match(h.node('agent-definition-launch-status').textContent, /new-definition.*створено/);
  assert.doesNotMatch(h.node('agent-definition-launch-status').textContent, /не створено/);
  assert.ok(!h.calls.some(c => c.command === 'START_BROWSER_AGENT_JOB'));
});

test('duplicate clicks during Create share the owner operation and create once', async () => {
  const pending = deferred(); const h = harness(command => command === 'CREATE_BROWSER_AGENT_JOB' ? pending.promise : { jobs: [job('new')] });
  h.node('agent-prompt').value = 'Goal'; const first = h.context.runBrowserAgentPrompt();
  await h.context.runBrowserAgentPrompt(); pending.resolve({ job: job('new', 'STOPPED') }); await first;
  assert.equal(h.calls.filter(c => c.command === 'CREATE_BROWSER_AGENT_JOB').length, 1);
});

test('permission grant for A never resumes newly selected B', async () => {
  const pending = deferred(); const h = harness(() => ({}));
  h.ui.selectedBrowserAgent = job('a', 'WAITING_PERMISSION', { currentUrl: 'https://example.com/' });
  h.context.chrome.permissions.request = () => pending.promise;
  const grant = h.context.requestBrowserAgentPermission();
  h.context.selectBrowserAgentView('b'); h.ui.selectedBrowserAgent = job('b', 'WAITING_PERMISSION');
  pending.resolve(true); await grant;
  assert.equal(h.calls.length, 0);
});

test('double approval submits one command with the original exact job and leaves a newer selection alone', async () => {
  const pending = deferred(); const h = harness(() => pending.promise);
  const first = h.context.approveBrowserAgentAction();
  await h.context.approveBrowserAgentAction();
  h.context.selectBrowserAgentView('b'); h.ui.selectedBrowserAgent = job('b');
  pending.resolve({}); await first;
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].command, 'APPROVE_BROWSER_AGENT_ACTION');
  assert.equal(h.calls[0].payload.id, 'a'); assert.equal(h.ui.selectedBrowserAgent.id, 'b');
});

test('an acknowledged instruction cannot erase newly typed follow-up text', async () => {
  const pending = deferred(); const h = harness(command => command === 'ADD_BROWSER_AGENT_INSTRUCTION'
    ? pending.promise : { jobs: [job('a')] });
  h.node('agent-follow-up').value = 'first instruction';
  const first = h.context.sendBrowserAgentFollowUp();
  h.node('agent-follow-up').value = 'second instruction';
  pending.resolve({}); await first;
  assert.equal(h.node('agent-follow-up').value, 'second instruction');
  assert.equal(h.calls[0].payload.text, 'first instruction');
});

test('unchanged list refresh preserves native option identity instead of rebuilding focused controls', () => {
  const h = harness(() => ({})), options = [];
  let rebuilds = 0;
  const list = h.node('agent-job-list');
  list.replaceChildren = () => { rebuilds++; options.length = 0; };
  list.append = option => options.push(option);
  h.context.document = { createElement: () => ({}) };
  vm.runInContext(functionSource('renderBrowserAgentList'), h.context);
  h.context.renderBrowserAgentList(); const first = options[0];
  for (let i = 0; i < 100; i++) h.context.renderBrowserAgentList();
  assert.equal(rebuilds, 1); assert.equal(options[0], first);
  h.context.selectBrowserAgentView('b'); h.context.renderBrowserAgentList();
  assert.equal(list.value, 'b'); assert.equal(rebuilds, 1);
});

test('Specialist acknowledgement alone never becomes independently verified UI success', async () => {
  const handoff = { agentId: 'child', state: 'COMPLETED' };
  const runtime = { plan: { revision: 2, nodes: [{ nodeId: 'n', state: 'RUNNING', evidence: '' }] },
    specialistHandoffs: [handoff], specialistExecutionOwnerships: [{ ownerId: 'child', nodeId: 'n', state: 'OWNED' }],
    specialistDispatchByAgentId: { child: { state: 'PROVIDER_SUCCEEDED' } } };
  const h = harness(command => command === 'PREPARE_BROWSER_AGENT_AUTOMATIC_SPECIALIST_DELEGATION'
    ? { plan: { revision: 2 }, handoff } : command === 'RUN_BROWSER_AGENT_AUTOMATIC_SPECIALIST_HANDOFF'
      ? { success: true } : { jobs: [job('a', 'RUNNING', runtime)] });
  h.ui.selectedBrowserAgent = job('a', 'RUNNING', runtime);
  h.ui.specialistRegistries = [{ registryId: 'r', revision: 1 }];
  h.node('agent-specialist-delegation-registry').value = 'r'; h.node('agent-specialist-delegation-node').value = 'n';
  h.node('agent-specialist-delegation-deadline-minutes').value = '10'; h.node('agent-specialist-delegation-run-now').checked = true;
  await h.context.prepareAutomaticSpecialistDelegation();
  assert.match(h.node('agent-command-result').textContent, /незалежне підтвердження ще не записане/);
});

test('Specialist view requires both durable verification states, reports uncertainty and waits', () => {
  const handoff = { agentId: 'child', state: 'COMPLETED' };
  const runtime = { plan: { nodes: [{ nodeId: 'n', state: 'VERIFIED', evidence: 'canonical verifier evidence' }] },
    specialistExecutionOwnerships: [{ ownerId: 'child', nodeId: 'n', state: 'VERIFIED' }] };
  assert.equal(describeAgentSpecialistProgressV1(runtime, handoff).kind, 'VERIFIED');
  runtime.specialistExecutionOwnerships[0].state = 'RECONCILE';
  assert.equal(describeAgentSpecialistProgressV1(runtime, handoff).kind, 'BLOCKED');
  runtime.specialistExecutionOwnerships = [];
  runtime.specialistAutomationByAgentId = { child: { status: 'RETRY_WAIT', nextAttemptAt: 1000, lastErrorCode: 'PROVIDER_NOT_READY' } };
  assert.equal(describeAgentSpecialistProgressV1(runtime, { ...handoff, state: 'PENDING' }).kind, 'WAITING');
  assert.equal(describeAgentSpecialistProgressV1({ plan: { nodes: {} } }, {}).kind, 'BLOCKED');
  assert.equal(describeAgentSpecialistProgressV1({}, { agentId: 'child', state: 'FAILED' }).kind, 'BLOCKED');
  assert.equal(describeAgentSpecialistProgressV1({}, { agentId: 'child', state: 'CANCELLED' }).kind, 'BLOCKED');
});
