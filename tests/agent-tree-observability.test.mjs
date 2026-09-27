import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OrchestrationNodeLifecycle,
  createOrchestrationHierarchyRuntime,
} from '../src/core/orchestration-hierarchy.js';
import {
  buildAgentTreeProjectionV1,
  normalizeAgentTreeTelemetryV1,
} from '../src/core/agent-tree-observability.js';

const NOW_MS = Date.parse('2026-09-27T01:30:00.000Z');
const OBSERVED_AT = '2026-09-27T01:29:30.000Z';

function node(id, parentId = null, childIds = [], promptProfileId = 'worker') {
  return {
    id,
    parentId,
    childIds,
    promptProfileId,
  };
}

function graph() {
  return {
    schemaVersion: 1,
    graphId: 'agent-tree-observability-test',
    controlEpoch: 7,
    loopPolicy: { mode: 'ONE_SHOT', maxRounds: 0 },
    promptProfiles: [
      { id: 'coordinator', role: 'coordinator', version: 1, prompt: 'PRIVATE_COORDINATOR_PROMPT' },
      { id: 'worker', role: 'worker', version: 1, prompt: 'PRIVATE_WORKER_PROMPT' },
    ],
    nodes: [
      node('root', null, ['worker-b', 'worker-a'], 'coordinator'),
      node('worker-a', 'root'),
      node('worker-b', 'root'),
    ],
  };
}

function runtimeFor(canonicalGraph = graph()) {
  const runtime = createOrchestrationHierarchyRuntime(canonicalGraph, NOW_MS);
  runtime.updatedAt = NOW_MS;
  runtime.nodesById.root.lifecycle = OrchestrationNodeLifecycle.ACTIVE;
  runtime.nodesById['worker-a'].lifecycle = OrchestrationNodeLifecycle.TERMINAL;
  runtime.nodesById['worker-a'].lastTerminalStatus = 'COMPLETED';
  runtime.nodesById['worker-b'].lifecycle = OrchestrationNodeLifecycle.MANUAL_REVIEW;
  runtime.nodesById['worker-b'].lastTerminalStatus = 'MANUAL_REVIEW';
  return runtime;
}

function telemetry(nodeId, overrides = {}) {
  return {
    schemaVersion: 1,
    nodeId,
    observedAt: OBSERVED_AT,
    modelCalls: 2,
    modelInputTokens: 100,
    modelOutputTokens: 25,
    toolActions: 3,
    runtimeSeconds: 12,
    costUsdMicros: 400,
    ...overrides,
  };
}

function request(overrides = {}) {
  const canonicalGraph = graph();
  return {
    schemaVersion: 1,
    graph: canonicalGraph,
    runtime: runtimeFor(canonicalGraph),
    telemetry: [
      telemetry('root'),
      telemetry('worker-b', {
        modelCalls: 1,
        modelInputTokens: 20,
        modelOutputTokens: 5,
        toolActions: 1,
        runtimeSeconds: 4,
        costUsdMicros: 50,
      }),
    ],
    ...overrides,
  };
}

test('projects canonical hierarchy in deterministic accessible depth-first order', () => {
  const result = buildAgentTreeProjectionV1(request());

  assert.deepEqual(result.rows.map(row => row.nodeId), ['root', 'worker-a', 'worker-b']);
  assert.deepEqual(result.rows.map(row => row.depth), [0, 1, 1]);
  assert.equal(result.rows[0].role, 'coordinator');
  assert.equal(result.rows[0].lifecycle, 'ACTIVE');
  assert.equal(result.rows[0].activeChildCount, 0);
  assert.equal(result.rows[1].stateLabel, 'TERMINAL:COMPLETED');
  assert.equal(result.rows[2].needsOwnerAttention, true);
  assert.equal(result.rows[2].attentionReason, 'MANUAL_REVIEW');
  assert.equal(result.rows[2].telemetryLagMs, 30_000);

  assert.match(result.textLines[0], /coordinator \[root\] — ACTIVE/);
  assert.match(result.textLines[1], /^  worker \[worker-a\] — TERMINAL:COMPLETED/);
  assert.match(result.textLines[2], /attention MANUAL_REVIEW/);
});

test('summarizes lifecycle, attention and bounded telemetry without granting authority', () => {
  const result = buildAgentTreeProjectionV1(request());

  assert.equal(result.summary.totalNodes, 3);
  assert.equal(result.summary.rootCount, 1);
  assert.deepEqual(result.summary.attentionNodeIds, ['worker-b']);
  assert.equal(result.summary.lifecycleCounts.ACTIVE, 1);
  assert.equal(result.summary.lifecycleCounts.TERMINAL, 1);
  assert.equal(result.summary.lifecycleCounts.MANUAL_REVIEW, 1);
  assert.equal(result.summary.terminalStatusCounts.COMPLETED, 1);
  assert.equal(result.summary.terminalStatusCounts.MANUAL_REVIEW, 1);
  assert.equal(result.summary.telemetryNodeCount, 2);
  assert.deepEqual(result.summary.telemetryTotals, {
    modelCalls: 3,
    modelInputTokens: 120,
    modelOutputTokens: 30,
    toolActions: 4,
    runtimeSeconds: 16,
    costUsdMicros: 450,
  });

  assert.equal(result.readOnly, true);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.hiddenReasoningIncluded, false);
  assert.equal(result.rawTranscriptIncluded, false);
  assert.equal(result.rawPromptIncluded, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.policyAuthorized, false);
  assert.equal(result.schedulingAuthorized, false);
  assert.equal(result.recoveryAuthorized, false);
  assert.equal(result.evidenceAuthorityMinted, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.rows), true);
  assert.equal(Object.isFrozen(result.rows[0]), true);
});

test('never exposes prompt bodies or hidden reasoning through text projection', () => {
  const result = buildAgentTreeProjectionV1(request());
  const serialized = JSON.stringify({
    rows: result.rows,
    textLines: result.textLines,
  });

  assert.doesNotMatch(serialized, /PRIVATE_COORDINATOR_PROMPT/);
  assert.doesNotMatch(serialized, /PRIVATE_WORKER_PROMPT/);
  assert.doesNotMatch(serialized, /chain.?of.?thought/i);
});

test('ambiguous current activation is surfaced as owner attention without replay authority', () => {
  const input = request();
  const nodeRuntime = input.runtime.nodesById.root;
  nodeRuntime.currentActivationId = 'root-activation';
  nodeRuntime.activationLedger['root-activation'] = {
    phase: 'AMBIGUOUS',
  };

  const result = buildAgentTreeProjectionV1(input);
  assert.equal(result.rows[0].needsOwnerAttention, true);
  assert.equal(result.rows[0].attentionReason, 'AMBIGUOUS_EFFECT');
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.recoveryAuthorized, false);
});

test('telemetry identity, chronology and uniqueness fail closed', () => {
  assert.throws(
    () => buildAgentTreeProjectionV1(request({
      telemetry: [telemetry('missing')],
    })),
    /unknown nodeId/,
  );

  assert.throws(
    () => buildAgentTreeProjectionV1(request({
      telemetry: [telemetry('root'), telemetry('root')],
    })),
    /duplicate nodeId/,
  );

  assert.throws(
    () => buildAgentTreeProjectionV1(request({
      telemetry: [telemetry('root', { observedAt: '2026-09-27T01:30:00.001Z' })],
    })),
    /occurs after hierarchy runtime/,
  );
});

test('telemetry rejects signed zero, aliases, non-canonical timestamps and unknown fields', () => {
  assert.throws(
    () => normalizeAgentTreeTelemetryV1(telemetry('root', { modelCalls: -0 })),
    /canonical non-negative integer/,
  );
  assert.throws(
    () => normalizeAgentTreeTelemetryV1(telemetry(' root ')),
    /exact canonical identity/,
  );
  assert.throws(
    () => normalizeAgentTreeTelemetryV1(telemetry('root', { observedAt: '2026-09-27T01:29:30Z' })),
    /canonical ISO timestamp/,
  );
  assert.throws(
    () => normalizeAgentTreeTelemetryV1({ ...telemetry('root'), surprise: true }),
    /unknown field/,
  );
});

test('graph and runtime accessors are rejected before getter execution', () => {
  let reads = 0;
  const graphInput = graph();
  Object.defineProperty(graphInput.nodes[0], 'childIds', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return ['worker-a', 'worker-b'];
    },
  });
  assert.throws(
    () => buildAgentTreeProjectionV1({
      schemaVersion: 1,
      graph: graphInput,
      runtime: runtimeFor(graph()),
      telemetry: [],
    }),
    /childIds.*enumerable own data property/,
  );
  assert.equal(reads, 0);

  const canonicalGraph = graph();
  const runtimeInput = runtimeFor(canonicalGraph);
  Object.defineProperty(runtimeInput.nodesById.root, 'lifecycle', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return OrchestrationNodeLifecycle.ACTIVE;
    },
  });
  assert.throws(
    () => buildAgentTreeProjectionV1({
      schemaVersion: 1,
      graph: canonicalGraph,
      runtime: runtimeInput,
      telemetry: [],
    }),
    /lifecycle.*enumerable own data property/,
  );
  assert.equal(reads, 0);
});

test('request and telemetry arrays reject hidden, sparse, symbolic and accessor authority fields', () => {
  let reads = 0;
  const accessorRequest = request();
  Object.defineProperty(accessorRequest, 'runtime', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return runtimeFor(graph());
    },
  });
  assert.throws(
    () => buildAgentTreeProjectionV1(accessorRequest),
    /runtime.*enumerable own data property/,
  );
  assert.equal(reads, 0);

  const sparse = new Array(1);
  assert.throws(
    () => buildAgentTreeProjectionV1(request({ telemetry: sparse })),
    /telemetry\[0\].*enumerable own data property/,
  );

  const symbolic = request();
  symbolic[Symbol('authority')] = true;
  assert.throws(() => buildAgentTreeProjectionV1(symbolic), /symbol field/);

  const hiddenTelemetry = telemetry('root');
  Object.defineProperty(hiddenTelemetry, 'modelCalls', {
    enumerable: false,
    value: 2,
  });
  assert.throws(
    () => normalizeAgentTreeTelemetryV1(hiddenTelemetry),
    /modelCalls.*enumerable own data property/,
  );
});

test('null-prototype request and telemetry records remain portable data inputs', () => {
  const canonicalGraph = graph();
  const portableTelemetry = Object.assign(Object.create(null), telemetry('root'));
  const portableRequest = Object.assign(Object.create(null), {
    schemaVersion: 1,
    graph: canonicalGraph,
    runtime: runtimeFor(canonicalGraph),
    telemetry: [portableTelemetry],
  });

  const result = buildAgentTreeProjectionV1(portableRequest);
  assert.equal(result.rows[0].nodeId, 'root');
  assert.equal(result.rows[0].telemetry.modelCalls, 2);
});

test('canonical hierarchy mismatch remains authoritative over the projection', () => {
  const input = request();
  input.runtime.graphId = 'other-graph';
  assert.throws(
    () => buildAgentTreeProjectionV1(input),
    /Runtime graph mismatch/,
  );

  const second = request();
  second.runtime.controlEpoch += 1;
  assert.throws(
    () => buildAgentTreeProjectionV1(second),
    /Runtime control epoch mismatch/,
  );
});

test('telemetry totals fail closed instead of overflowing safe integer arithmetic', () => {
  const huge = Number.MAX_SAFE_INTEGER;
  assert.throws(
    () => buildAgentTreeProjectionV1(request({
      telemetry: [
        telemetry('root', { modelInputTokens: huge }),
        telemetry('worker-a', { modelInputTokens: 1 }),
      ],
    })),
    /telemetry total modelInputTokens exceeds safe integer range/,
  );
});
