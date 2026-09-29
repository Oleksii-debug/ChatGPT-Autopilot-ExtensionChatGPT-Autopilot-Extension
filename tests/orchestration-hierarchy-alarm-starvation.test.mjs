import test from 'node:test';
import assert from 'node:assert/strict';

import { OrchestrationV2Controller } from '../src/core/orchestration-v2-controller.js';
import {
  createOrchestrationRuntime,
  orchestrationSnapshot,
  validateOrchestrationConfig,
} from '../src/core/orchestration-v2.js';
import { buildThreeLevelHierarchyTemplate } from '../src/core/orchestration-role-prompts.js';
import { createOrchestrationHierarchyRuntime } from '../src/core/orchestration-hierarchy.js';

function fixture(now = 1_000_000) {
  const config = validateOrchestrationConfig({
    enabled: true,
    projectId: 'hierarchy-probe-starvation',
    targetRepository: 'Oleksii-debug/Accessible-Chess',
    controlRepository: 'Oleksii-debug/Accessible-Chess',
    controlIssueNumber: 774,
    masterCoordinatorPrompt: 'fallback',
    defaultDesiredWorkers: 25,
    absoluteMaxWorkers: 25,
    workerProbeIntervalSeconds: 30,
    watchdogIntervalSeconds: 300,
  });
  const graph = buildThreeLevelHierarchyTemplate({
    graphId: 'hierarchy-probe-starvation',
    projectId: config.projectId,
    targetRepository: config.targetRepository,
    controlIssueNumber: 774,
    domains: [
      { id: 'formats', scope: 'formats' },
      { id: 'integration-release', scope: 'integration' },
      { id: 'library-data', scope: 'library' },
      { id: 'user-workflows-books', scope: 'books' },
      { id: 'windows-accessibility', scope: 'windows' },
    ],
    workersPerManager: 5,
  });
  const runtime = createOrchestrationRuntime(config, now);
  runtime.hierarchy = {
    schemaVersion: 1,
    graph,
    state: createOrchestrationHierarchyRuntime(graph, now),
  };
  return { config, graph, runtime };
}

test('hierarchy probe alarm is not postponed by frequent unrelated reconciliations', async () => {
  const now = 1_000_000;
  const { config, runtime } = fixture(now);
  let existingAlarm = {
    name: 'hierarchy-wake',
    scheduledTime: now + 10_000,
  };
  let created = null;
  const chromeApi = {
    alarms: {
      async get() { return existingAlarm; },
      async create(name, options) {
        created = { name, ...options };
        existingAlarm = { name, scheduledTime: options.when };
      },
      async clear() { existingAlarm = null; return true; },
    },
  };
  const controller = new OrchestrationV2Controller({
    coreRepository: {
      async load() { return { sessionsById: {}, sessionOrder: [] }; },
      async update(mutator) { return mutator({ sessionsById: {}, sessionOrder: [] }); },
    },
    chromeApi,
    now: () => now,
    configRepository: { async load() { return config; } },
    runtimeRepository: {
      async load() { return structuredClone(runtime); },
      async update(mutator) { return mutator(structuredClone(runtime)); },
    },
    alarmName: 'hierarchy-wake',
  });

  const wakeAt = await controller.reconcileAlarm({ nowMs: now });

  assert.equal(wakeAt, now + 10_000);
  assert.equal(created.when, now + 10_000);
});

test('hierarchy snapshot exposes 1 Director, 5 Managers and 25 Workers', () => {
  const { config, runtime } = fixture();
  const snapshot = orchestrationSnapshot(runtime, config);

  assert.equal(snapshot.hierarchy.nodeCount, 31);
  assert.equal(snapshot.hierarchy.rootCount, 1);
  assert.equal(snapshot.hierarchy.managerCount, 5);
  assert.equal(snapshot.hierarchy.workerCount, 25);
  assert.equal(snapshot.hierarchy.activeActivationCount, 0);
  assert.equal(snapshot.hierarchy.lifecycleCounts.IDLE, 31);
});
