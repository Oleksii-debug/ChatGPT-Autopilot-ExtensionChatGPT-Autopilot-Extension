import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORCHESTRATION_CONTROL_MARKER,
  ControlActionType,
  CoordinatorEventType,
  CoordinatorStatus,
  OrchestrationMode,
  WorkerState,
  acquireCoordinatorLease,
  applyControlDecision,
  applyCoordinatorCompletionProbe,
  applyWorkerCompletionProbe,
  buildCoordinatorTickPrompt,
  coordinatorNeedsRotation,
  createOrchestrationRuntime,
  effectiveDesiredWorkers,
  enqueueCoordinatorEvent,
  enqueueStaleWorkerCandidates,
  enqueueWatchdogIfDue,
  ensureCoordinatorSession,
  materializeWorkersIntoCore,
  nextWorkerLaunchAt,
  orchestrationSnapshot,
  parseControlComment,
  parseDirectControlResponse,
  projectBackpressureUntil,
  releaseExpiredWorkerBackpressure,
  reservedWorkerSlots,
  rotateCoordinator,
  selectWorkersForLaunch,
  syncCoordinatorDeliveryFromCore,
  syncWorkerDeliveryFromCore,
  validateControlDecision,
  validateOrchestrationConfig,
  workerCompletionProbe,
} from '../src/core/orchestration-v2.js';
import {
  ORCHESTRATION_CONFIG_STORAGE_KEY,
  ORCHESTRATION_RUNTIME_STORAGE_KEY,
  OrchestrationConfigRepository,
  OrchestrationRuntimeRepository,
} from '../src/core/orchestration-v2-storage.js';
import { createEmptyState, RunState } from '../src/core/schema.js';

const NOW = Date.parse('2026-09-11T20:00:00Z');
const CONFIG = {
  enabled: true,
  projectId: 'proj',
  targetRepository: 'owner/target',
  controlRepository: 'owner/control',
  controlIssueNumber: 122,
  controlCommentId: 99,
  masterCoordinatorPrompt: 'MASTER: reread GitHub and control workers.',
  defaultDesiredWorkers: 2,
  absoluteMaxWorkers: 3,
  watchdogIntervalSeconds: 300,
  maxCoordinatorTurns: 2,
};

function control({ revision = 1, generation = 1, actions = [{ type: 'NO_ACTION' }], mode = 'RUN', expiresOffsetMs = 3600000 } = {}) {
  return {
    schema_version: 2,
    project_id: 'proj',
    revision,
    coordinator_generation: generation,
    generated_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + expiresOffsetMs).toISOString(),
    mode,
    actions,
  };
}

function task(id, extra = {}) {
  return {
    task_id: id,
    prompt: `Do ${id}`,
    priority: 10,
    dependencies: [],
    conflict_key: '',
    generation: 1,
    launch_mode: 'FRESH_CHAT',
    not_before: null,
    expires_at: null,
    ...extra,
  };
}

function acquireInitial(runtime) {
  const lease = acquireCoordinatorLease(runtime, { nowMs: NOW, reason: 'INITIALIZE' });
  assert.equal(lease.acquired, true);
  return lease;
}

function chromeFake() {
  const data = {};
  return {
    data,
    storage: { local: {
      async get(key) { return { [key]: structuredClone(data[key]) }; },
      async set(record) { Object.assign(data, structuredClone(record)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    } },
  };
}

test('config is bounded locally and requires identity/prompt only when enabled', () => {
  const disabled = validateOrchestrationConfig({ absoluteMaxWorkers: 2, defaultDesiredWorkers: 99 });
  assert.equal(disabled.defaultDesiredWorkers, 2);
  assert.equal(disabled.enabled, false);
  assert.throws(() => validateOrchestrationConfig({ enabled: true }), /projectId/);
  const enabled = validateOrchestrationConfig(CONFIG);
  assert.equal(enabled.absoluteMaxWorkers, 3);
  assert.equal(enabled.watchdogIntervalSeconds, 300);
  assert.throws(() => validateOrchestrationConfig({ ...CONFIG, coordinatorLaunchUrl: 'https://example.com/' }), /does not accept URL/);
});

test('strict marked control parses NO_ACTION and rejects unmarked prose', () => {
  const raw = control();
  const body = `${ORCHESTRATION_CONTROL_MARKER}\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``;
  const parsed = parseControlComment(body, { projectId: 'proj', coordinatorGeneration: 1, nowMs: NOW });
  assert.equal(parsed.executable, true);
  assert.equal(parsed.control.actions[0].type, ControlActionType.NO_ACTION);
  assert.equal(parseControlComment('human text').executable, false);
});

test('direct Chat control accepts exactly one final strict block and rejects trailing prose', () => {
  const raw = {
    schema_version:2, project_id:'proj', revision:1, coordinator_generation:1,
    generated_at:new Date(NOW).toISOString(), expires_at:new Date(NOW + 60_000).toISOString(),
    mode:'RUN', actions:[{type:'NO_ACTION'}],
  };
  const response = `Короткий людський підсумок перед машинним блоком.\n\n${ORCHESTRATION_CONTROL_MARKER}\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``;
  const parsed = parseDirectControlResponse(response, { projectId:'proj', coordinatorGeneration:1, nowMs:NOW });
  assert.equal(parsed.executable, true);
  assert.equal(parsed.control.revision, 1);
  assert.throws(() => parseDirectControlResponse(`${response}\nще текст`, { projectId:'proj', coordinatorGeneration:1, nowMs:NOW }), /must be final/);
  assert.throws(() => parseDirectControlResponse(`${response}\n${ORCHESTRATION_CONTROL_MARKER}\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``, { projectId:'proj', coordinatorGeneration:1, nowMs:NOW }), /exactly one control marker/);
});

test('coordinator completion preserves a final direct control block after very long prose', () => {
  const runtime = createOrchestrationRuntime({ ...CONFIG, projectId:'proj', targetRepository:'owner/target', controlRepository:'owner/control', controlIssueNumber:1, masterCoordinatorPrompt:'MASTER', enabled:true }, NOW);
  acquireCoordinatorLease(runtime, { nowMs:NOW, reason:'INITIALIZE' });
  runtime.coordinator.chatUrl = 'https://chatgpt.com/c/coord';
  runtime.coordinator.deliveredTurnId = runtime.coordinator.lease.turnId;
  runtime.coordinator.lastAssistantBaselineKnown = true;
  const raw = { schema_version:2, project_id:'proj', revision:1, coordinator_generation:1, generated_at:new Date(NOW).toISOString(), expires_at:new Date(NOW+60000).toISOString(), mode:'RUN', actions:[{type:'NO_ACTION'}] };
  const finalBlock = `${ORCHESTRATION_CONTROL_MARKER}\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``;
  applyCoordinatorCompletionProbe(runtime, { status:'READY', assistantComplete:true, assistantText:`${'x'.repeat(30000)}\n${finalBlock}` }, NOW+1000);
  assert.equal(runtime.coordinator.lastAssistantReport.startsWith(ORCHESTRATION_CONTROL_MARKER), true);
  assert.equal(parseDirectControlResponse(runtime.coordinator.lastAssistantReport, { projectId:'proj', coordinatorGeneration:1, nowMs:NOW+1000 }).control.revision, 1);
});

test('strict control rejects malformed expiry, wrong project/generation and mixed NO_ACTION', () => {
  assert.throws(() => validateControlDecision(control({ expiresOffsetMs: -1 }), { projectId: 'proj', coordinatorGeneration: 1, nowMs: NOW }), /expiry|Expired/);
  assert.throws(() => validateControlDecision({ ...control(), project_id: 'other' }, { projectId: 'proj', coordinatorGeneration: 1, nowMs: NOW }), /Wrong project/);
  assert.throws(() => validateControlDecision(control({ generation: 2 }), { projectId: 'proj', coordinatorGeneration: 1, nowMs: NOW }), /Wrong coordinator/);
  assert.throws(() => validateControlDecision(control({ actions: [{ type: 'NO_ACTION' }, { type: 'PAUSE' }] }), { projectId: 'proj', coordinatorGeneration: 1, nowMs: NOW }), /NO_ACTION/);
});

test('remote coordinator control integers fail closed instead of being clamped', () => {
  const options = { projectId: 'proj', coordinatorGeneration: 1, nowMs: NOW };
  assert.throws(() => validateControlDecision({ ...control(), revision: 0 }, options), /Invalid revision/);
  assert.throws(() => validateControlDecision({ ...control(), revision: 1.5 }, options), /Invalid revision/);
  assert.throws(() => validateControlDecision({ ...control(), coordinator_generation: 0 }, { projectId:'proj', nowMs:NOW }), /Invalid coordinator_generation/);
  assert.throws(() => validateControlDecision(control({ actions:[{ type:'ADD_TASKS', tasks:[task('bad-generation', { generation:0 })] }] }), options), /generation/);
  assert.throws(() => validateControlDecision(control({ actions:[{ type:'ADD_TASKS', tasks:[task('bad-priority', { priority:1.25 })] }] }), options), /priority/);
});

test('watchdog enqueues at most one pending reconciliation and does not create workers', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  assert.equal(runtime.workerOrder.length, 0);
  const before = enqueueWatchdogIfDue(runtime, CONFIG, NOW + 299_999);
  assert.equal(before.due, false);
  const first = enqueueWatchdogIfDue(runtime, CONFIG, NOW + 300_000);
  const second = enqueueWatchdogIfDue(runtime, CONFIG, NOW + 301_000);
  assert.equal(first.due, true);
  assert.equal(second.due, false);
  assert.equal(runtime.pendingCoordinatorEvents.length, 1);
  assert.equal(runtime.workerOrder.length, 0);
});

test('coordinator single-flight aggregates events while BUSY and consumes them only after a control revision', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  enqueueCoordinatorEvent(runtime, { type: CoordinatorEventType.WORKER_TERMINAL, workerId: 'w1', taskId: 't1', workerState: WorkerState.COMPLETED }, NOW);
  const lease = acquireCoordinatorLease(runtime, { nowMs: NOW });
  assert.equal(lease.acquired, true);
  assert.equal(runtime.coordinator.status, CoordinatorStatus.BUSY);
  enqueueCoordinatorEvent(runtime, { type: CoordinatorEventType.WORKER_TERMINAL, workerId: 'w2', taskId: 't2', workerState: WorkerState.COMPLETED }, NOW + 1);
  const secondLease = acquireCoordinatorLease(runtime, { nowMs: NOW + 2 });
  assert.equal(secondLease.acquired, false);
  assert.equal(runtime.pendingCoordinatorEvents.length, 2);
  applyControlDecision(runtime, control(), CONFIG, NOW + 10);
  assert.equal(runtime.pendingCoordinatorEvents.length, 1, 'event that arrived after lease remains pending');
  assert.equal(runtime.coordinator.status, CoordinatorStatus.IDLE);
});

test('ADD_TASKS queues exact-once workers and local hard max clamps desired concurrency', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  const actions = [
    { type: 'SET_DESIRED_CONCURRENCY', value: 99 },
    { type: 'ADD_TASKS', tasks: [task('a'), task('b')] },
  ];
  const applied = applyControlDecision(runtime, control({ actions }), CONFIG, NOW + 1);
  assert.equal(applied.result.queued.length, 2);
  assert.equal(runtime.desiredActiveWorkers, 3);
  assert.equal(effectiveDesiredWorkers(runtime, CONFIG), 3);
  assert.equal(runtime.workerOrder.length, 2);

  enqueueCoordinatorEvent(runtime, { type: CoordinatorEventType.WATCHDOG_RECONCILE }, NOW + 2);
  acquireCoordinatorLease(runtime, { nowMs: NOW + 2 });
  const duplicate = applyControlDecision(runtime, control({ revision: 2, actions: [{ type: 'ADD_TASKS', tasks: [task('a')] }] }), CONFIG, NOW + 3);
  assert.equal(duplicate.result.queued.length, 0);
  assert.equal(runtime.workerOrder.length, 2);
});

test('dependency and exclusive conflict key block launch until safe', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  const actions = [{ type: 'ADD_TASKS', tasks: [
    task('a', { conflict_key: 'repo:core' }),
    task('b', { conflict_key: 'repo:core', priority: 20 }),
    task('c', { dependencies: ['a'], priority: 30 }),
  ] }];
  applyControlDecision(runtime, control({ actions }), CONFIG, NOW + 1);
  let selected = selectWorkersForLaunch(runtime, CONFIG, NOW + 2);
  assert.equal(selected.length, 1, 'only one dependency-free worker with the exclusive conflict key may launch');
  const selectedWorkers = selected.map(id => runtime.workersById[id]);
  assert.equal(selectedWorkers.some(worker => worker.taskId === 'c'), false, 'dependency blocks c');
  assert.equal(selectedWorkers.filter(worker => worker.conflictKey === 'repo:core').length, 1);
});

test('materialization creates fresh one-task canonical Sessions and never a second scheduler', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control({ actions: [{ type: 'ADD_TASKS', tasks: [task('a')] }] }), CONFIG, NOW + 1);
  const state = createEmptyState(NOW);
  const result = materializeWorkersIntoCore(state, runtime, CONFIG, NOW + 2);
  assert.equal(result.launched.length, 1);
  const worker = runtime.workersById[result.launched[0]];
  const session = state.sessionsById[worker.sessionId];
  assert.equal(session.runState, RunState.RUNNING);
  assert.equal(session.taskOrder.length, 1);
  assert.equal(session.tasksById[worker.sessionTaskId].url, 'https://chatgpt.com/');
  assert.equal(session.orchestrationWorker.workerId, worker.workerId);
  assert.equal(worker.state, WorkerState.LAUNCHING);
});

test('delivery COMPLETE in core is not worker completion; verified send only activates worker', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control({ actions: [{ type: 'ADD_TASKS', tasks: [task('a')] }] }), CONFIG, NOW + 1);
  const state = createEmptyState(NOW);
  const [workerId] = materializeWorkersIntoCore(state, runtime, CONFIG, NOW + 2).launched;
  const worker = runtime.workersById[workerId];
  const session = state.sessionsById[worker.sessionId];
  const taskState = session.tasksById[worker.sessionTaskId];
  taskState.lastVerifiedSendAt = NOW + 3;
  taskState.lastVerifiedFingerprint = 'sha256:x';
  taskState.lastConversationUrl = 'https://chatgpt.com/c/abc';
  taskState.lastAssistantBaselineKnown = true;
  taskState.lastAssistantBaselineCount = 4;
  session.runState = RunState.STOPPED;
  session.completedAt = NOW + 4;
  const sync = syncWorkerDeliveryFromCore(runtime, state, NOW + 5);
  assert.deepEqual(sync.activated, [workerId]);
  assert.equal(worker.state, WorkerState.ACTIVE);
  assert.equal(worker.chatUrl, 'https://chatgpt.com/c/abc');
  assert.equal(runtime.pendingCoordinatorEvents.length, 0);
});

test('core delivery manual-review wakes coordinator immediately and deduplicates the durable event', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control({ actions: [{ type: 'ADD_TASKS', tasks: [task('a')] }] }), CONFIG, NOW + 1);
  const state = createEmptyState(NOW);
  const [workerId] = materializeWorkersIntoCore(state, runtime, CONFIG, NOW + 2).launched;
  const worker = runtime.workersById[workerId];
  const session = state.sessionsById[worker.sessionId];
  const taskState = session.tasksById[worker.sessionTaskId];
  taskState.status = 'MANUAL_REVIEW';
  taskState.manualReviewReason = 'AUTH_CONFIRMATION_REQUIRED';

  const first = syncWorkerDeliveryFromCore(runtime, state, NOW + 3);
  assert.deepEqual(first.activated, []);
  assert.equal(worker.state, WorkerState.MANUAL_REVIEW);
  assert.equal(worker.terminalReason, 'AUTH_CONFIRMATION_REQUIRED');
  assert.equal(runtime.pendingCoordinatorEvents.length, 1);
  assert.equal(runtime.pendingCoordinatorEvents[0].type, CoordinatorEventType.WORKER_TERMINAL);
  assert.equal(runtime.pendingCoordinatorEvents[0].workerId, workerId);
  assert.equal(runtime.pendingCoordinatorEvents[0].workerState, WorkerState.MANUAL_REVIEW);

  syncWorkerDeliveryFromCore(runtime, state, NOW + 4);
  assert.equal(runtime.pendingCoordinatorEvents.length, 1, 'repeated Core sync must not duplicate the wake event');
});

test('assistant completion probe creates one terminal event and duplicate probe is deduplicated', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control({ actions: [{ type: 'ADD_TASKS', tasks: [task('a')] }] }), CONFIG, NOW + 1);
  const state = createEmptyState(NOW);
  const [workerId] = materializeWorkersIntoCore(state, runtime, CONFIG, NOW + 2).launched;
  const worker = runtime.workersById[workerId];
  const taskState = state.sessionsById[worker.sessionId].tasksById[worker.sessionTaskId];
  taskState.lastVerifiedSendAt = NOW + 3;
  taskState.lastConversationUrl = 'https://chatgpt.com/c/abc';
  taskState.lastAssistantBaselineKnown = true;
  taskState.lastAssistantBaselineCount = 2;
  syncWorkerDeliveryFromCore(runtime, state, NOW + 4);
  assert.deepEqual(workerCompletionProbe(worker), { workerId, conversationUrl:'https://chatgpt.com/c/abc', taskId:'a', assistantBaselineCount:2, assistantBaselineKnown:true });
  const first = applyWorkerCompletionProbe(runtime, workerId, { status:'READY', assistantComplete:true, assistantText:'Finished; PR created.' }, NOW + 5);
  assert.equal(first.terminal, true);
  assert.equal(worker.state, WorkerState.COMPLETED);
  assert.equal(runtime.pendingCoordinatorEvents.length, 1);
  const second = applyWorkerCompletionProbe(runtime, workerId, { status:'READY', assistantComplete:true, assistantText:'Finished; PR created.' }, NOW + 6);
  assert.equal(second.changed, false);
  assert.equal(runtime.pendingCoordinatorEvents.length, 1);
});

test('completion-driven refill can add one replacement without waiting for other active worker', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control({ actions: [{ type:'ADD_TASKS', tasks:[task('a'), task('b')] }] }), CONFIG, NOW + 1);
  const state = createEmptyState(NOW);
  const launched = materializeWorkersIntoCore(state, runtime, CONFIG, NOW + 2).launched;
  assert.equal(launched.length, 2);
  for (const workerId of launched) runtime.workersById[workerId].state = WorkerState.ACTIVE;
  const [aId, bId] = launched;
  applyWorkerCompletionProbe(runtime, aId, { status:'READY', assistantComplete:true, assistantText:'done' }, NOW + 3);
  assert.equal(runtime.workersById[bId].state, WorkerState.ACTIVE);
  assert.equal(reservedWorkerSlots(runtime), 1);
  const lease = acquireCoordinatorLease(runtime, { nowMs: NOW + 4 });
  assert.equal(lease.acquired, true);
  applyControlDecision(runtime, control({ revision:2, actions:[{ type:'ADD_TASKS', tasks:[task('c')] }] }), CONFIG, NOW + 5);
  const replacement = selectWorkersForLaunch(runtime, CONFIG, NOW + 6);
  assert.equal(replacement.length, 1);
  assert.equal(runtime.workersById[replacement[0]].taskId, 'c');
});

test('zero-task NO_ACTION after worker completion is valid and does not invent work', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control({ actions:[{ type:'ADD_TASKS', tasks:[task('a')] }] }), CONFIG, NOW + 1);
  const workerId = runtime.workerOrder[0];
  runtime.workersById[workerId].state = WorkerState.ACTIVE;
  applyWorkerCompletionProbe(runtime, workerId, { status:'READY', assistantComplete:true, assistantText:'done' }, NOW + 2);
  acquireCoordinatorLease(runtime, { nowMs: NOW + 3 });
  applyControlDecision(runtime, control({ revision:2, actions:[{ type:'NO_ACTION' }] }), CONFIG, NOW + 4);
  assert.equal(runtime.workerOrder.length, 1);
  assert.equal(selectWorkersForLaunch(runtime, CONFIG, NOW + 5).length, 0);
});

test('watchdog event coalesces with completion in a single coordinator lease', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  enqueueWatchdogIfDue(runtime, CONFIG, NOW + 300_000);
  enqueueCoordinatorEvent(runtime, { type:CoordinatorEventType.WORKER_TERMINAL, workerId:'w', taskId:'t', workerState:WorkerState.COMPLETED }, NOW + 1);
  runtime.coordinator.chatUrl = 'https://chatgpt.com/c/existing-coordinator';
  const lease = acquireCoordinatorLease(runtime, { nowMs: NOW + 300_002 });
  assert.equal(lease.acquired, true);
  assert.equal(lease.lease.eventIds.length, 2);
  const prompt = buildCoordinatorTickPrompt(runtime, CONFIG, { nowMs: NOW + 2 });
  assert.match(prompt, /Worker terminal event/);
  assert.doesNotMatch(prompt, /Do not create tasks merely because this tick occurred\.$/);
});


test('coordinator contract treats last_control_revision as durable Autopilot ACK', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  const prompt = buildCoordinatorTickPrompt(runtime, CONFIG, { initial:true, nowMs:NOW });
  assert.match(prompt, /AUTOPILOT ACK RULE/);
  assert.match(prompt, /last_control_revision/);
  assert.match(prompt, /SAME task_id and SAME exact_once_key/);
});

test('coordinator Session uses fresh launch URL initially and stored conversation URL on later turns', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  const state = createEmptyState(NOW);
  const firstPrompt = buildCoordinatorTickPrompt(runtime, CONFIG, { initial:true, nowMs:NOW });
  const created = ensureCoordinatorSession(state, runtime, CONFIG, firstPrompt, NOW);
  let session = state.sessionsById[created.sessionId];
  let taskState = session.tasksById[created.taskId];
  assert.equal(taskState.url, 'https://chatgpt.com/');
  taskState.lastVerifiedSendAt = NOW + 1;
  taskState.lastConversationUrl = 'https://chatgpt.com/c/coordinator';
  taskState.lastAssistantBaselineCount = 3;
  taskState.lastAssistantBaselineKnown = true;
  syncCoordinatorDeliveryFromCore(runtime, state, NOW + 2);
  assert.equal(runtime.coordinator.chatUrl, 'https://chatgpt.com/c/coordinator');

  applyControlDecision(runtime, control(), CONFIG, NOW + 3);
  enqueueCoordinatorEvent(runtime, { type:CoordinatorEventType.WATCHDOG_RECONCILE }, NOW + 4);
  acquireCoordinatorLease(runtime, { nowMs:NOW + 4 });
  session.operation = null;
  const tickPrompt = buildCoordinatorTickPrompt(runtime, CONFIG, { nowMs:NOW + 4 });
  ensureCoordinatorSession(state, runtime, CONFIG, tickPrompt, NOW + 4);
  session = state.sessionsById[created.sessionId];
  taskState = session.tasksById[created.taskId];
  assert.equal(taskState.url, 'https://chatgpt.com/c/coordinator');
  assert.equal(session.onePassCompletedTaskIds.length, 0);
});

test('coordinator new turn clears prior terminal Core operation before rebinding task to durable conversation', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  const state = createEmptyState(NOW);
  const firstPrompt = buildCoordinatorTickPrompt(runtime, CONFIG, { initial:true, nowMs:NOW });
  const created = ensureCoordinatorSession(state, runtime, CONFIG, firstPrompt, NOW);
  const session = state.sessionsById[created.sessionId];
  const taskState = session.tasksById[created.taskId];
  taskState.lastVerifiedSendAt = NOW + 1;
  taskState.lastConversationUrl = 'https://chatgpt.com/c/coordinator-terminal-op';
  taskState.lastAssistantBaselineCount = 0;
  taskState.lastAssistantBaselineKnown = true;
  session.operation = {
    operationId:'op:coord:first', sessionId:session.id, taskId:created.taskId,
    promptFingerprint:'sha256:first', phase:'SENT_VERIFIED', targetUrl:'https://chatgpt.com',
    createdAt:NOW, updatedAt:NOW + 1, preSendDeadline:0, submitStartedAt:NOW, verificationDeadline:0,
  };
  syncCoordinatorDeliveryFromCore(runtime, state, NOW + 2);
  applyControlDecision(runtime, control(), CONFIG, NOW + 3);
  enqueueCoordinatorEvent(runtime, { type:CoordinatorEventType.WATCHDOG_RECONCILE }, NOW + 4);
  acquireCoordinatorLease(runtime, { nowMs:NOW + 4 });

  const tickPrompt = buildCoordinatorTickPrompt(runtime, CONFIG, { nowMs:NOW + 4 });
  ensureCoordinatorSession(state, runtime, CONFIG, tickPrompt, NOW + 4);

  assert.equal(session.operation, null, 'prior terminal operation must not survive coordinator turn rebind');
  assert.equal(session.tasksById[created.taskId].normalizedUrl, 'https://chatgpt.com/c/coordinator-terminal-op');
});

test('coordinator rotation after max turns resets chat but preserves worker state and creates recovery event', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control(), CONFIG, NOW + 1);
  enqueueCoordinatorEvent(runtime, { type:CoordinatorEventType.WATCHDOG_RECONCILE }, NOW + 2);
  acquireCoordinatorLease(runtime, { nowMs:NOW + 2 });
  applyControlDecision(runtime, control({ revision:2 }), CONFIG, NOW + 3);
  assert.equal(coordinatorNeedsRotation(runtime), true);
  assert.equal(runtime.coordinator.status, CoordinatorStatus.ROTATION_REQUIRED);
  const generation = rotateCoordinator(runtime, NOW + 4);
  assert.equal(generation, 2);
  assert.equal(runtime.coordinator.chatUrl, '');
  assert.equal(runtime.coordinator.turnsUsed, 0);
  assert.equal(runtime.pendingCoordinatorEvents.some(e => e.type === CoordinatorEventType.RECOVERY_RECONCILE), true);
});

test('PAUSE/DRAIN modes do not launch queued work', () => {
  for (const mode of [OrchestrationMode.PAUSE, OrchestrationMode.DRAIN, OrchestrationMode.INTEGRATE]) {
    const runtime = createOrchestrationRuntime(CONFIG, NOW);
    acquireInitial(runtime);
    applyControlDecision(runtime, control({ mode, actions:[{ type:'ADD_TASKS', tasks:[task(`a-${mode}`)] }] }), CONFIG, NOW + 1);
    assert.equal(selectWorkersForLaunch(runtime, CONFIG, NOW + 2).length, 0);
  }
});

test('local master pause prevents materialization even with free capacity', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control({ actions:[{ type:'ADD_TASKS', tasks:[task('a')] }] }), CONFIG, NOW + 1);
  const state = createEmptyState(NOW);
  state.profile.masterPaused = true;
  assert.equal(materializeWorkersIntoCore(state, runtime, CONFIG, NOW + 2).launched.length, 0);
  assert.equal(runtime.workersById[runtime.workerOrder[0]].state, WorkerState.QUEUED);
});

test('durable repository survives restart with pending completion event and exact-once index', async () => {
  const chrome = chromeFake();
  const configRepo = new OrchestrationConfigRepository(chrome);
  await configRepo.save(CONFIG);
  const repo1 = new OrchestrationRuntimeRepository(chrome, configRepo, { now:()=>NOW });
  await repo1.update(runtime => {
    acquireCoordinatorLease(runtime, { nowMs:NOW, reason:'INITIALIZE' });
    applyControlDecision(runtime, control({ actions:[{ type:'ADD_TASKS', tasks:[task('a')] }] }), CONFIG, NOW + 1);
    const workerId = runtime.workerOrder[0];
    runtime.workersById[workerId].state = WorkerState.ACTIVE;
    applyWorkerCompletionProbe(runtime, workerId, { status:'READY', assistantComplete:true, assistantText:'done' }, NOW + 2);
    return runtime;
  });

  const repo2 = new OrchestrationRuntimeRepository(chrome, configRepo, { now:()=>NOW + 3 });
  const restarted = await repo2.load();
  assert.equal(restarted.workerOrder.length, 1);
  assert.equal(restarted.workersById[restarted.workerOrder[0]].state, WorkerState.COMPLETED);
  assert.equal(restarted.pendingCoordinatorEvents.length, 1);
  assert.equal(Object.keys(restarted.exactOnceIndex).length, 1);
  assert.ok(chrome.data[ORCHESTRATION_CONFIG_STORAGE_KEY]);
  assert.ok(chrome.data[ORCHESTRATION_RUNTIME_STORAGE_KEY]);
});

test('completion probe budget ignores terminal worker history and still reaches active workers', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  for (let i = 1; i <= 20; i += 1) {
    const workerId = `done-${i}`;
    runtime.workerOrder.push(workerId);
    runtime.workersById[workerId] = {
      workerId,
      taskId:`done-task-${i}`,
      state:WorkerState.COMPLETED,
      chatUrl:`https://chatgpt.com/c/done-${i}`,
      assistantBaselineKnown:true,
      assistantBaselineCount:1,
      retryAfterAt:0,
    };
  }
  runtime.workerOrder.push('active-last');
  runtime.workersById['active-last'] = {
    workerId:'active-last', taskId:'active-task', state:WorkerState.ACTIVE,
    chatUrl:'https://chatgpt.com/c/active-last', assistantBaselineKnown:true,
    assistantBaselineCount:2, retryAfterAt:0,
  };
  assert.equal(workerCompletionProbe(runtime.workersById['done-1'], NOW), null);
  assert.equal(workerCompletionProbe(runtime.workersById['active-last'], NOW)?.workerId, 'active-last');
});

test('snapshot exposes observability without transcripts', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  const snapshot = orchestrationSnapshot(runtime, CONFIG);
  assert.equal(snapshot.projectId, 'proj');
  assert.equal(snapshot.effectiveDesiredWorkers, 2);
  assert.equal(snapshot.hardMaxWorkers, 3);
  assert.equal(snapshot.pendingCoordinatorEvents, 0);
  assert.equal('masterCoordinatorPrompt' in snapshot, false);
  assert.equal('lastAssistantReport' in snapshot.coordinator, false);
  assert.equal(snapshot.coordinator.lastAssistantReportAvailable, false);
});


test('project-level worker rate limit blocks queued launches until retry deadline', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control({ actions:[{ type:'ADD_TASKS', tasks:[task('a'), task('b')] }] }), CONFIG, NOW + 1);
  const [aId, bId] = runtime.workerOrder;
  runtime.workersById[aId].state = WorkerState.RATE_LIMITED;
  runtime.workersById[aId].retryAfterAt = NOW + 300_000;
  runtime.workersById[bId].state = WorkerState.QUEUED;
  assert.equal(projectBackpressureUntil(runtime, NOW + 2), NOW + 300_000);
  assert.deepEqual(selectWorkersForLaunch(runtime, CONFIG, NOW + 2), [], 'free capacity must not fan out while the project/account is rate-limited');

  const released = releaseExpiredWorkerBackpressure(runtime, NOW + 300_001);
  assert.deepEqual(released.releasedWorkers, [aId]);
  assert.equal(runtime.workersById[aId].state, WorkerState.ACTIVE);
  assert.equal(projectBackpressureUntil(runtime, NOW + 300_001), 0);
  assert.deepEqual(selectWorkersForLaunch(runtime, CONFIG, NOW + 300_001), [bId]);
});

test('long healthy BUSY worker never becomes stale merely because time elapsed', () => {
  const config = { ...CONFIG, staleWorkerAfterSeconds:300 };
  const runtime = createOrchestrationRuntime(config, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control({ actions:[{ type:'ADD_TASKS', tasks:[task('healthy')] }] }), config, NOW + 1);
  const workerId = runtime.workerOrder[0];
  const worker = runtime.workersById[workerId];
  worker.state = WorkerState.ACTIVE;
  worker.chatUrl = 'https://chatgpt.com/c/healthy';
  worker.assistantBaselineKnown = true;
  worker.assistantBaselineCount = 1;
  worker.sentAt = NOW + 2;
  worker.lastSuccessfulProbeAt = NOW + 2;

  applyWorkerCompletionProbe(runtime, workerId, { status:'BUSY', assistantComplete:false }, NOW + 900_000);
  const stale = enqueueStaleWorkerCandidates(runtime, config, NOW + 900_001);
  assert.deepEqual(stale.added, []);
  assert.equal(worker.state, WorkerState.BUSY);
  assert.equal(worker.consecutiveProbeFailures, 0);
  assert.equal(worker.lastSuccessfulProbeAt, NOW + 900_000);
  assert.equal(runtime.pendingCoordinatorEvents.some(event => event.type === CoordinatorEventType.WORKER_STALE_CANDIDATE), false);
});

test('repeated probe failures past stale threshold create one candidate event without freeing slot or spawning replacement', () => {
  const config = { ...CONFIG, staleWorkerAfterSeconds:300, watchdogIntervalSeconds:300 };
  const runtime = createOrchestrationRuntime(config, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control({ actions:[{ type:'ADD_TASKS', tasks:[task('uncertain'), task('queued')] }] }), config, NOW + 1);
  const [uncertainId, queuedId] = runtime.workerOrder;
  const worker = runtime.workersById[uncertainId];
  worker.state = WorkerState.ACTIVE;
  worker.chatUrl = 'https://chatgpt.com/c/uncertain';
  worker.assistantBaselineKnown = true;
  worker.assistantBaselineCount = 1;
  worker.sentAt = NOW + 2;
  worker.lastSuccessfulProbeAt = NOW + 2;
  runtime.workersById[queuedId].state = WorkerState.QUEUED;
  runtime.desiredActiveWorkers = 1;

  applyWorkerCompletionProbe(runtime, uncertainId, { status:'TEMPORARY_ERROR', safeDiagnosticCode:'PROBE_FAILED' }, NOW + 301_000);
  applyWorkerCompletionProbe(runtime, uncertainId, { status:'TEMPORARY_ERROR', safeDiagnosticCode:'PROBE_FAILED' }, NOW + 301_100);
  const first = enqueueStaleWorkerCandidates(runtime, config, NOW + 301_101);
  const second = enqueueStaleWorkerCandidates(runtime, config, NOW + 301_200);
  assert.deepEqual(first.added, [uncertainId]);
  assert.deepEqual(second.added, []);
  assert.equal(worker.state, WorkerState.ACTIVE, 'uncertain worker keeps its slot until coordinator verifies truth');
  assert.equal(reservedWorkerSlots(runtime), 1);
  assert.deepEqual(selectWorkersForLaunch(runtime, config, NOW + 301_201), []);
  assert.equal(runtime.pendingCoordinatorEvents.filter(event => event.type === CoordinatorEventType.WORKER_STALE_CANDIDATE).length, 1);

  runtime.coordinator.chatUrl = 'https://chatgpt.com/c/coordinator';
  const lease = acquireCoordinatorLease(runtime, { nowMs: NOW + 301_300 });
  assert.equal(lease.acquired, true);
  const prompt = buildCoordinatorTickPrompt(runtime, config, { nowMs:NOW + 301_300 });
  assert.match(prompt, /stale-candidate/i);
  assert.match(prompt, /live GitHub/i);
  assert.match(prompt, /Do not assume stale/i);
});

test('coordinator rate limit preserves lease and blocks project launches until retry deadline', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  runtime.coordinator.chatUrl = 'https://chatgpt.com/c/coordinator';
  runtime.coordinator.deliveredTurnId = runtime.coordinator.lease.turnId;
  runtime.coordinator.deliveredAt = NOW;
  runtime.coordinator.lastAssistantBaselineKnown = true;
  runtime.coordinator.lastAssistantBaselineCount = 1;
  const turnId = runtime.coordinator.lease.turnId;

  const applied = applyCoordinatorCompletionProbe(runtime, { status:'RATE_LIMITED', retryAfterAt:NOW + 120_000 }, NOW + 1);
  assert.equal(applied.rateLimited, true);
  assert.equal(runtime.coordinator.lease.turnId, turnId);
  assert.ok(runtime.coordinator.retryAfterAt >= NOW + 30_001, 'technical probe delay is bounded to thirty seconds');
  assert.equal(projectBackpressureUntil(runtime, NOW + 2), runtime.coordinator.retryAfterAt);

  releaseExpiredWorkerBackpressure(runtime, runtime.coordinator.retryAfterAt + 1);
  assert.equal(runtime.coordinator.retryAfterAt, 0);
  assert.equal(runtime.coordinator.lease.turnId, turnId, 'backoff expiry resumes the same turn instead of creating a duplicate');
});


test('strict control rejects duplicate task and exact-once identities across multiple ADD_TASKS actions', () => {
  const options = { projectId:'proj', coordinatorGeneration:1, nowMs:NOW };
  assert.throws(() => validateControlDecision(control({ actions:[
    { type:'ADD_TASKS', tasks:[task('dup')] },
    { type:'ADD_TASKS', tasks:[task('dup')] },
  ] }), options), /Duplicate task_id across/);
  assert.throws(() => validateControlDecision(control({ actions:[
    { type:'ADD_TASKS', tasks:[task('one', { exact_once_key:'same@1' })] },
    { type:'ADD_TASKS', tasks:[task('two', { exact_once_key:'same@1' })] },
  ] }), options), /Duplicate exact_once_key across/);
});

test('worker authorization is repository-bound and never outlives its coordinator control expiry', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  assert.throws(() => applyControlDecision(runtime, control({ actions:[{
    type:'ADD_TASKS', tasks:[task('wrong-repo', { target_repository:'owner/other' })],
  }] }), CONFIG, NOW + 1), /different repository/);

  const runtime2 = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime2);
  const short = control({ expiresOffsetMs:60_000, actions:[{ type:'ADD_TASKS', tasks:[task('bounded', { expires_at:new Date(NOW + 600_000).toISOString() })] }] });
  applyControlDecision(runtime2, short, CONFIG, NOW + 1);
  const worker = runtime2.workersById[runtime2.workerOrder[0]];
  assert.equal(worker.targetRepository, CONFIG.targetRepository);
  assert.equal(worker.expiresAt, NOW + 60_000);
  assert.equal(selectWorkersForLaunch(runtime2, CONFIG, NOW + 60_001).length, 0);
});

test('CONTINUE_EXISTING_WORKER is fail-closed until a known prior worker has a durable terminal chat', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime);
  assert.throws(() => applyControlDecision(runtime, control({ actions:[{
    type:'ADD_TASKS', tasks:[task('follow', { launch_mode:'CONTINUE_EXISTING_WORKER', continue_worker_id:'worker:proj:999' })],
  }] }), CONFIG, NOW + 1), /unknown worker/);

  const runtime2 = createOrchestrationRuntime(CONFIG, NOW);
  acquireInitial(runtime2);
  applyControlDecision(runtime2, control({ actions:[{ type:'ADD_TASKS', tasks:[task('first')] }] }), CONFIG, NOW + 1);
  const firstId = runtime2.workerOrder[0];
  runtime2.workersById[firstId].state = WorkerState.ACTIVE;
  runtime2.workersById[firstId].chatUrl = 'https://chatgpt.com/c/first';
  enqueueCoordinatorEvent(runtime2, { type:CoordinatorEventType.WATCHDOG_RECONCILE }, NOW + 2);
  acquireCoordinatorLease(runtime2, { nowMs:NOW + 2 });
  applyControlDecision(runtime2, control({ revision:2, actions:[{ type:'ADD_TASKS', tasks:[task('follow', { launch_mode:'CONTINUE_EXISTING_WORKER', continue_worker_id:firstId })] }] }), CONFIG, NOW + 3);
  const followId = runtime2.workerOrder.find(id => id !== firstId);
  assert.equal(selectWorkersForLaunch(runtime2, CONFIG, NOW + 4).includes(followId), false);
  runtime2.workersById[firstId].state = WorkerState.COMPLETED;
  assert.equal(selectWorkersForLaunch(runtime2, CONFIG, NOW + 5).includes(followId), true);
});

test('explicit coordinator supersede after stale-candidate evidence safely frees a slot', () => {
  const config = { ...CONFIG, absoluteMaxWorkers:1, defaultDesiredWorkers:1, staleWorkerAfterSeconds:300 };
  const runtime = createOrchestrationRuntime(config, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control({ actions:[{ type:'ADD_TASKS', tasks:[task('stale'), task('replacement')] }] }), config, NOW + 1);
  const [staleId, replacementId] = runtime.workerOrder;
  const stale = runtime.workersById[staleId];
  stale.state = WorkerState.ACTIVE;
  stale.chatUrl = 'https://chatgpt.com/c/stale';
  stale.sentAt = NOW + 2;
  stale.lastSuccessfulProbeAt = NOW + 2;
  stale.consecutiveProbeFailures = 2;
  enqueueStaleWorkerCandidates(runtime, config, NOW + 301_000);
  enqueueCoordinatorEvent(runtime, { type:CoordinatorEventType.WATCHDOG_RECONCILE }, NOW + 301_001);
  acquireCoordinatorLease(runtime, { nowMs:NOW + 301_001 });
  const applied = applyControlDecision(runtime, control({ revision:2, actions:[{ type:'SUPERSEDE_TASKS', task_ids:['stale'] }] }), config, NOW + 301_002);
  assert.deepEqual(applied.result.superseded, [staleId]);
  assert.equal(stale.state, WorkerState.SUPERSEDED);
  assert.equal(reservedWorkerSlots(runtime), 0);
  assert.deepEqual(selectWorkersForLaunch(runtime, config, NOW + 301_003), [replacementId]);
});

test('large backlog remains coordinator-flexible while owner rate window enforces six launches per five minutes', () => {
  const config = { ...CONFIG, defaultDesiredWorkers:100, absoluteMaxWorkers:100, maxLaunchesPerWindow:6, launchWindowSeconds:300, minimumWorkerLaunchIntervalMs:0 };
  const runtime = createOrchestrationRuntime(config, NOW);
  acquireInitial(runtime);
  const tasks = Array.from({ length:100 }, (_, i) => task(`bulk-${i + 1}`, { priority:100 - i }));
  applyControlDecision(runtime, control({ actions:[{ type:'SET_DESIRED_CONCURRENCY', value:100 }, { type:'ADD_TASKS', tasks }] }), config, NOW + 1);
  assert.equal(runtime.workerOrder.length, 100);
  const state = createEmptyState(NOW);
  const first = materializeWorkersIntoCore(state, runtime, config, NOW + 2);
  assert.equal(first.launched.length, 6);
  assert.equal(runtime.launchHistoryAt.length, 6);
  for (const id of first.launched) runtime.workersById[id].state = WorkerState.COMPLETED;
  assert.equal(selectWorkersForLaunch(runtime, config, NOW + 1000).length, 0);
  assert.equal(nextWorkerLaunchAt(runtime, config, NOW + 1000), NOW + 2 + 300_000);
  assert.equal(selectWorkersForLaunch(runtime, config, NOW + 300_003).length, 6);
});

test('minimum worker launch interval serializes starts even when coordinator requests wide concurrency', () => {
  const config = { ...CONFIG, defaultDesiredWorkers:20, absoluteMaxWorkers:20, maxLaunchesPerWindow:0, minimumWorkerLaunchIntervalMs:60_000 };
  const runtime = createOrchestrationRuntime(config, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control({ actions:[{ type:'ADD_TASKS', tasks:Array.from({ length:20 }, (_, i) => task(`gapped-${i}`)) }] }), config, NOW + 1);
  const state = createEmptyState(NOW);
  const first = materializeWorkersIntoCore(state, runtime, config, NOW + 2);
  assert.equal(first.launched.length, 1);
  assert.equal(selectWorkersForLaunch(runtime, config, NOW + 30_000).length, 0);
  assert.equal(nextWorkerLaunchAt(runtime, config, NOW + 30_000), NOW + 60_002);
  runtime.workersById[first.launched[0]].state = WorkerState.COMPLETED;
  assert.equal(selectWorkersForLaunch(runtime, config, NOW + 60_003).length, 1);
});

test('every coordinator tick exposes owner launch limits to the reasoning model', () => {
  const config = { ...CONFIG, absoluteMaxWorkers:20, maxLaunchesPerWindow:6, launchWindowSeconds:300, minimumWorkerLaunchIntervalMs:15_000 };
  const runtime = createOrchestrationRuntime(config, NOW);
  acquireInitial(runtime);
  const initial = buildCoordinatorTickPrompt(runtime, config, { initial:true, nowMs:NOW });
  assert.match(initial, /"max_active_workers": 20/);
  assert.match(initial, /"max_launches_per_window": 6/);
  assert.match(initial, /"launch_window_seconds": 300/);
  assert.match(initial, /"minimum_worker_launch_interval_seconds": 15/);
});

test('launch rate history survives storage restart and still blocks the seventh launch inside the same window', async () => {
  const config = { ...CONFIG, defaultDesiredWorkers:100, absoluteMaxWorkers:100, maxLaunchesPerWindow:6, launchWindowSeconds:300 };
  const chrome = chromeFake();
  const cfgRepo = new OrchestrationConfigRepository(chrome);
  await cfgRepo.save(config);
  const runtimeRepo = new OrchestrationRuntimeRepository(chrome, cfgRepo, { now:()=>NOW + 10_000 });
  const runtime = createOrchestrationRuntime(config, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control({ actions:[{ type:'ADD_TASKS', tasks:Array.from({ length:20 }, (_, i) => task(`restart-rate-${i}`)) }] }), config, NOW + 1);
  const coreState = createEmptyState(NOW);
  const launched = materializeWorkersIntoCore(coreState, runtime, config, NOW + 2);
  assert.equal(launched.launched.length, 6);
  for (const id of launched.launched) runtime.workersById[id].state = WorkerState.COMPLETED;
  await runtimeRepo.save(runtime);

  const restartedRepo = new OrchestrationRuntimeRepository(chrome, cfgRepo, { now:()=>NOW + 10_000 });
  const restored = await restartedRepo.load();
  assert.equal(restored.launchHistoryAt.length, 6);
  assert.equal(selectWorkersForLaunch(restored, config, NOW + 10_000).length, 0);
  assert.equal(nextWorkerLaunchAt(restored, config, NOW + 10_000), NOW + 2 + 300_000);
  assert.equal(selectWorkersForLaunch(restored, config, NOW + 300_003).length, 6);
});

test('simultaneous worker completions are coalesced into one coordinator lease without losing any terminal event', () => {
  const config = { ...CONFIG, defaultDesiredWorkers:5, absoluteMaxWorkers:5 };
  const runtime = createOrchestrationRuntime(config, NOW);
  acquireInitial(runtime);
  applyControlDecision(runtime, control({ actions:[{ type:'ADD_TASKS', tasks:Array.from({ length:5 }, (_, i) => task(`done-${i + 1}`)) }] }), config, NOW + 1);
  for (const workerId of runtime.workerOrder) {
    const worker = runtime.workersById[workerId];
    worker.state = WorkerState.ACTIVE;
    worker.chatUrl = `https://chatgpt.com/c/${worker.taskId}`;
    worker.assistantBaselineKnown = true;
    worker.assistantBaselineCount = 1;
    const result = applyWorkerCompletionProbe(runtime, workerId, { status:'READY', assistantComplete:true, assistantText:`${worker.taskId} complete` }, NOW + 10);
    assert.equal(result.terminal, true);
  }
  const terminalEvents = runtime.pendingCoordinatorEvents.filter(event => event.type === CoordinatorEventType.WORKER_TERMINAL);
  assert.equal(terminalEvents.length, 5);
  const lease = acquireCoordinatorLease(runtime, { nowMs:NOW + 11, reason:'WORKER_TERMINAL' });
  assert.equal(lease.acquired, true);
  assert.equal(lease.lease.eventIds.length, 5);
  assert.equal(acquireCoordinatorLease(runtime, { nowMs:NOW + 12, reason:'WORKER_TERMINAL' }).reason, 'BUSY');
});

test('coordinator rotation preserves pending worker completion events for the fresh master-prompt generation', () => {
  const config = { ...CONFIG, maxCoordinatorTurns:1 };
  const runtime = createOrchestrationRuntime(config, NOW);
  runtime.coordinator.turnsUsed = 1;
  enqueueCoordinatorEvent(runtime, { type:CoordinatorEventType.WORKER_TERMINAL, workerId:'worker-x', taskId:'x', workerState:WorkerState.COMPLETED }, NOW + 1);
  assert.equal(coordinatorNeedsRotation(runtime), true);
  const eventIds = runtime.pendingCoordinatorEvents.map(event => event.id);
  const generation = rotateCoordinator(runtime, NOW + 2);
  assert.equal(generation, 2);
  assert.ok(eventIds.every(id => runtime.pendingCoordinatorEvents.some(event => event.id === id)));
  const lease = acquireCoordinatorLease(runtime, { nowMs:NOW + 3, reason:'ROTATION_RECONCILE' });
  assert.equal(lease.acquired, true);
  const prompt = buildCoordinatorTickPrompt(runtime, config, { initial:true, nowMs:NOW + 3 });
  assert.match(prompt, /MASTER:/);
  assert.match(prompt, /WORKER_TERMINAL/);
});

test('physical control compatibility normalizes ACTIVE, P-level priority, and concurrency aliases without ambiguity', () => {
  const options = { projectId:'proj', coordinatorGeneration:1, nowMs:NOW };
  const parsed = validateControlDecision(control({ actions:[
    { type:'SET_DESIRED_CONCURRENCY', desired_workers:4, concurrency:4 },
    { type:'ADD_TASKS', tasks:[task('compat-p0', { priority:'P0' }), task('compat-p9', { priority:'P9' })] },
  ] , mode:'ACTIVE'}), options);
  assert.equal(parsed.mode, 'RUN');
  assert.equal(parsed.actions[0].value, 4);
  assert.equal(parsed.actions[1].tasks[0].priority, 9);
  assert.equal(parsed.actions[1].tasks[1].priority, 0);
  assert.throws(() => validateControlDecision(control({ actions:[
    { type:'SET_DESIRED_CONCURRENCY', value:3, desired_workers:4 },
  ]}), options), /Conflicting/);
});
