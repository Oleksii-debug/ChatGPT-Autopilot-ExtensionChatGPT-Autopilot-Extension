import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ORCHESTRATION_CONFIG,
  createOrchestrationRuntime,
  validateOrchestrationConfig,
  workerLaunchPolicy,
  enqueueWatchdogIfDue,
  coordinatorNeedsRotation,
  enqueueStaleWorkerCandidates,
  WorkerState,
} from '../src/core/orchestration-v2.js';

test('owner-visible orchestration defaults keep the documented cycles and intervals', () => {
  const c = validateOrchestrationConfig(DEFAULT_ORCHESTRATION_CONFIG);
  assert.equal(c.defaultDesiredWorkers, 5);
  assert.equal(c.absoluteMaxWorkers, 8);
  assert.equal(c.maxLaunchesPerWindow, 6);
  assert.equal(c.launchWindowSeconds, 300);
  assert.equal(c.minimumWorkerLaunchIntervalMs, 0);
  assert.equal(c.workerProbeIntervalSeconds, 30);
  assert.equal(c.watchdogIntervalSeconds, 300);
  assert.equal(c.maxCoordinatorTurns, 10);
  assert.equal(c.workerPreSendDelayMs, 8000);
  assert.equal(c.workerBusyCheckDelayMs, 2000);
  assert.equal(c.workerRetryBackoffMs, 60000);
  assert.equal(c.coordinatorPreSendDelayMs, 8000);
  assert.equal(c.coordinatorRetryBackoffMs, 60000);
  assert.equal(c.staleWorkerAfterSeconds, 3600);
});

test('watchdog is reconciliation every configured interval, not a blind worker spawn timer', () => {
  const now = 1_700_000_000_000;
  const config = { ...DEFAULT_ORCHESTRATION_CONFIG, watchdogIntervalSeconds: 300 };
  const runtime = createOrchestrationRuntime(config, now);
  runtime.lastWatchdogAt = now;
  const early = enqueueWatchdogIfDue(runtime, config, now + 299_000);
  assert.equal(early.due, false);
  assert.equal(early.wakeAt, now + 300_000);
  assert.equal(runtime.pendingCoordinatorEvents.length, 0);
  const due = enqueueWatchdogIfDue(runtime, config, now + 300_000);
  assert.equal(due.due, true);
  assert.equal(runtime.pendingCoordinatorEvents.length, 1);
  assert.equal(runtime.pendingCoordinatorEvents[0].type, 'WATCHDOG_RECONCILE');
});

test('coordinator rotation occurs at the configured turn bound', () => {
  const runtime = createOrchestrationRuntime({ ...DEFAULT_ORCHESTRATION_CONFIG, maxCoordinatorTurns: 10 }, 1_000);
  runtime.coordinator.turnsUsed = 9;
  assert.equal(coordinatorNeedsRotation(runtime), false);
  runtime.coordinator.turnsUsed = 10;
  assert.equal(coordinatorNeedsRotation(runtime), true);
});

test('stale worker requires at least two failed probes and the stale threshold', () => {
  const now = 10_000_000;
  const config = { ...DEFAULT_ORCHESTRATION_CONFIG, staleWorkerAfterSeconds: 3600, watchdogIntervalSeconds: 300 };
  const runtime = createOrchestrationRuntime(config, now - 4_000_000);
  runtime.workersById.w1 = {
    workerId: 'w1', taskId: 't1', state: WorkerState.ACTIVE,
    lastSuccessfulProbeAt: now - 3_600_000,
    consecutiveProbeFailures: 1,
    lastStaleCandidateAt: 0,
  };
  runtime.workerOrder = ['w1'];
  assert.deepEqual(enqueueStaleWorkerCandidates(runtime, config, now).added, []);
  runtime.workersById.w1.consecutiveProbeFailures = 2;
  assert.deepEqual(enqueueStaleWorkerCandidates(runtime, config, now).added, ['w1']);
});

test('launch window remains fail-closed after backward wall-clock correction', () => {
  const now = 1_000_000;
  const config = { ...DEFAULT_ORCHESTRATION_CONFIG, maxLaunchesPerWindow: 2, launchWindowSeconds: 300 };
  const runtime = createOrchestrationRuntime(config, now);
  runtime.launchHistoryAt = [now + 10_000, now + 20_000];
  const policy = workerLaunchPolicy(runtime, config, now);
  assert.equal(policy.launchesInWindow, 2);
  assert.equal(policy.remainingNow, 0);
  assert.equal(policy.nextAllowedLaunchAt, now + 10_000 + 300_000);
});

test('owner UI exposes explicit immediate start actions instead of relying on watchdog', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  assert.match(html, /id="start-orchestration-v2-orchestra-button"[^>]*>Запустити оркестр</);
  assert.match(html, /id="save-start-orchestration-v2-button"[^>]*>Зберегти й запустити зараз</);
  assert.doesNotMatch(html, /Watchdog не використовується як затримка першого старту/);
  assert.match(js, /START_ORCHESTRATION_V2_ORCHESTRA/);
  assert.match(js, /SAVE_AND_START_ORCHESTRATION_V2/);
});
