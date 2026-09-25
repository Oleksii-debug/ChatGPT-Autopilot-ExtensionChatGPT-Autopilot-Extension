import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_ORCHESTRATION_CONFIG,
  WorkerState,
  acquireCoordinatorLease,
  applyControlDecision,
  createOrchestrationRuntime,
  enqueueCoordinatorEvent,
  normalizeOrchestrationRuntime,
  selectWorkersForLaunch,
  workerLaunchPolicy,
} from '../src/core/orchestration-v2.js';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const CONFIG = {
  ...DEFAULT_ORCHESTRATION_CONFIG,
  enabled: true,
  projectId: 'proj',
  targetRepository: 'owner/target',
  controlRepository: 'owner/control',
  controlIssueNumber: 121,
  masterCoordinatorPrompt: 'MASTER',
  defaultDesiredWorkers: 2,
  absoluteMaxWorkers: 8,
};

function control(revision, tasks = []) {
  return {
    schema_version: 2,
    project_id: 'proj',
    revision,
    coordinator_generation: 1,
    generated_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 3_600_000).toISOString(),
    mode: 'RUN',
    actions: tasks.length ? [{ type: 'ADD_TASKS', tasks }] : [{ type: 'NO_ACTION' }],
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
    continue_worker_id: '',
    exact_once_key: `${id}@1`,
    not_before: null,
    expires_at: null,
    target_repository: 'owner/target',
    ...extra,
  };
}

test('new orchestration config and shipped portable template default to 6 launches per 300 seconds', async () => {
  assert.equal(DEFAULT_ORCHESTRATION_CONFIG.maxLaunchesPerWindow, 6);
  assert.equal(DEFAULT_ORCHESTRATION_CONFIG.launchWindowSeconds, 300);
  const profile = JSON.parse(await readFile(new URL('../src/config/orchestration-v2-template.json', import.meta.url), 'utf8'));
  assert.equal(profile.local_limits.max_launches_per_window, 6);
  assert.equal(profile.local_limits.launch_window_seconds, 300);
});

test('runtime normalization deduplicates worker order and advances durable ordinals/event IDs monotonically', () => {
  const raw = createOrchestrationRuntime(CONFIG, NOW);
  raw.workersById['worker:proj:7'] = {
    workerId: 'worker:proj:7', taskId: 'a', state: WorkerState.ACTIVE,
    coordinatorGeneration: 4, sentAt: NOW, retryAfterAt: 0,
  };
  raw.workerOrder = ['worker:proj:7', 'worker:proj:7', 'worker:proj:7'];
  raw.nextWorkerOrdinal = 1;
  raw.pendingCoordinatorEvents = [{ id: 41, type: 'RECOVERY_RECONCILE', at: NOW, workerId: '', taskId: '', workerState: '', key: 'x', detail: '' }];
  raw.consumedCoordinatorEventIds = [73];
  raw.nextEventId = 2;
  raw.coordinator.generation = 1;
  raw.coordinator.lease = { turnId: 'coord:proj:g1:t1', generation: 1, acquiredAt: NOW, reason: 'RECONCILE', eventIds: [41] };

  const normalized = normalizeOrchestrationRuntime(raw, CONFIG, NOW + 1);
  assert.deepEqual(normalized.workerOrder, ['worker:proj:7']);
  assert.equal(normalized.nextWorkerOrdinal, 8);
  assert.equal(normalized.nextEventId, 74);
  assert.equal(normalized.coordinator.generation, 4);
  assert.equal(normalized.coordinator.lease, null, 'stale lower-generation lease must not regain authority');
});

test('event queue is lossless/fail-closed at 10,000 and deduplication does not spend a new event ID', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  runtime.pendingCoordinatorEvents = Array.from({ length: 10_000 }, (_, index) => ({
    id: index + 1,
    type: 'PROVIDER_CHANGED',
    at: NOW + index,
    workerId: '', taskId: '', workerState: '', key: `k${index}`, detail: '',
  }));
  runtime.nextEventId = 10_001;

  const unique = enqueueCoordinatorEvent(runtime, { type: 'RECOVERY_RECONCILE', key: 'overflow' }, NOW + 20_000);
  assert.equal(unique.added, false);
  assert.equal(unique.capacityExceeded, true);
  assert.equal(runtime.pendingCoordinatorEvents.length, 10_000);
  assert.equal(runtime.pendingCoordinatorEvents[0].id, 1, 'oldest durable event must not be silently dropped');
  assert.equal(runtime.nextEventId, 10_001, 'failed capacity insert must not consume an event ID');

  const duplicate = enqueueCoordinatorEvent(runtime, { type: 'PROVIDER_CHANGED', key: 'k9999', detail: 'updated' }, NOW + 30_000);
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(runtime.nextEventId, 10_001, 'dedupe must not consume an event ID');
  assert.equal(runtime.pendingCoordinatorEvents.at(-1).detail, 'updated');
});

test('coordinator leases at most 200 durable events per turn so large completion backlogs drain across turns', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  runtime.pendingCoordinatorEvents = Array.from({ length: 600 }, (_, index) => ({
    id: index + 1,
    type: 'WORKER_TERMINAL',
    at: NOW + index,
    workerId: `w${index}`,
    taskId: `t${index}`,
    workerState: WorkerState.COMPLETED,
    key: '', detail: '',
  }));
  runtime.nextEventId = 601;
  const lease = acquireCoordinatorLease(runtime, { nowMs: NOW + 1000, reason: 'RECONCILE' });
  assert.equal(lease.acquired, true);
  assert.equal(lease.lease.eventIds.length, 200);
  assert.equal(lease.lease.eventIds[0], 1);
  assert.equal(lease.lease.eventIds.at(-1), 200);
});

test('launch-policy observability is read-only', () => {
  const runtime = createOrchestrationRuntime(CONFIG, NOW);
  runtime.launchHistoryAt = [NOW - 1_000_000, NOW - 1000, NOW - 500];
  const before = structuredClone(runtime.launchHistoryAt);
  workerLaunchPolicy(runtime, CONFIG, NOW);
  assert.deepEqual(runtime.launchHistoryAt, before);
});

test('completed dependency evidence survives worker-history pruning beyond 10,000 workers', () => {
  const runtime = createOrchestrationRuntime({ ...CONFIG, defaultDesiredWorkers: 8 }, NOW);
  for (let i = 1; i <= 10_000; i += 1) {
    const workerId = `worker:proj:${i}`;
    runtime.workerOrder.push(workerId);
    runtime.workersById[workerId] = {
      workerId,
      taskId: i === 1 ? 'ancient-completed' : `old-${i}`,
      executionKey: `${i === 1 ? 'ancient-completed' : `old-${i}`}@1`,
      exactOnceKey: `old-key-${i}`,
      state: WorkerState.COMPLETED,
      dependencies: [], conflictKey: '', priority: 1,
      authorizedAt: NOW - 10_000 + i,
      completedAt: NOW - 5_000 + i,
      retryAfterAt: 0,
    };
  }
  runtime.nextWorkerOrdinal = 10_001;
  const acquisition = acquireCoordinatorLease(runtime, { nowMs: NOW, reason: 'INITIALIZE' });
  assert.equal(acquisition.acquired, true);
  applyControlDecision(runtime, control(1, [task('dependent', { dependencies: ['ancient-completed'] })]), CONFIG, NOW + 1);

  assert.equal(runtime.workersById['worker:proj:1'], undefined, 'oldest completed worker should be pruned');
  assert.ok(runtime.completedTaskIndex['ancient-completed'], 'minimal durable completion evidence must survive pruning');
  const selected = selectWorkersForLaunch(runtime, { ...CONFIG, defaultDesiredWorkers: 8 }, NOW + 2);
  const dependent = runtime.workerOrder.find(id => runtime.workersById[id]?.taskId === 'dependent');
  assert.ok(selected.includes(dependent), 'dependent work must not deadlock after its completed predecessor is pruned');
});
