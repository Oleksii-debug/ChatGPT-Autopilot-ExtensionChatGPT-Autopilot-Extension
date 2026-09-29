import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createOrchestrationRuntime,
  orchestrationSnapshot,
  validateOrchestrationConfig,
} from '../../src/core/orchestration-v2.js';

test('L2-A runtime snapshot exposes Drive provider health but redacts source file identity', () => {
  const now = Date.parse('2026-09-19T00:00:00Z');
  const config = validateOrchestrationConfig({
    enabled: true,
    projectId: 'snapshot',
    targetRepository: 'owner/repo',
    controlRepository: 'owner/repo',
    controlIssueNumber: 1,
    masterCoordinatorPrompt: 'prompt',
    absoluteMaxWorkers: 5,
    defaultDesiredWorkers: 0,
  });
  const runtime = createOrchestrationRuntime(config, now);
  runtime.hierarchy = {
    graph: {
      graphId: 'snapshot-graph',
      nodeOrder: ['manager:data'],
      nodesById: {
        'manager:data': {
          providerBinding: {
            providerId: 'drive-scalar-v1',
            groupNodeId: 'manager:data',
            maxSlots: 5,
            sourceId: 'private-drive-file-id',
            pollIntervalMs: 180000,
          },
        },
      },
    },
    state: {
      nodesById: {
        'manager:data': {
          providerState: {
            lastAcceptedRevision: '42',
            lastRequestedSlotCount: 3,
            lastCheckedAt: now,
            nextCheckAt: now + 180000,
            lastErrorCode: '',
          },
        },
      },
    },
  };

  const snapshot = orchestrationSnapshot(runtime, config);
  assert.deepEqual(snapshot.hierarchy.providers, [{
    nodeId: 'manager:data',
    providerId: 'drive-scalar-v1',
    maxSlots: 5,
    pollIntervalMs: 180000,
    sourceConfigured: true,
    lastAcceptedRevision: '42',
    lastRequestedSlotCount: 3,
    lastCheckedAt: now,
    nextCheckAt: now + 180000,
    lastErrorCode: '',
  }]);
  assert.equal(JSON.stringify(snapshot).includes('private-drive-file-id'), false);
});
