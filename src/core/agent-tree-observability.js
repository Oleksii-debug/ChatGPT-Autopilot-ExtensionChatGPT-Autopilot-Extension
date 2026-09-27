import {
  OrchestrationActivationPhase,
  OrchestrationNodeLifecycle,
  OrchestrationTerminalStatus,
  validateOrchestrationGraphV1,
  validateOrchestrationHierarchyRuntimeV1,
} from './orchestration-hierarchy.js';

export const AGENT_TREE_OBSERVABILITY_VERSION = 1;
export const AGENT_TREE_TELEMETRY_VERSION = 1;

const REQUEST_KEYS = new Set(['schemaVersion', 'graph', 'runtime', 'telemetry']);
const TELEMETRY_KEYS = new Set([
  'schemaVersion',
  'nodeId',
  'observedAt',
  'modelCalls',
  'modelInputTokens',
  'modelOutputTokens',
  'toolActions',
  'runtimeSeconds',
  'costUsdMicros',
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_DEPTH = 64;
const MAX_SNAPSHOT_NODES = 100_000;
const MAX_TELEMETRY_ROWS = 1_000;
const LIFECYCLES = new Set(Object.values(OrchestrationNodeLifecycle));
const TERMINAL_STATUSES = new Set(Object.values(OrchestrationTerminalStatus));
const ACTIVATION_PHASES = new Set(Object.values(OrchestrationActivationPhase));
const SCOPE_STATES = new Set(['RUNNING', 'PAUSED', 'STOPPED']);
const ACTIVE_LIFECYCLES = new Set([
  OrchestrationNodeLifecycle.PREPARING_EFFECT,
  OrchestrationNodeLifecycle.ACTIVE,
]);
const UNSAFE_DISPLAY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function snapshotCanonicalData(
  value,
  label,
  context = { count: 0, stack: new WeakSet() },
  depth = 0,
) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`${label} contains non-canonical number`);
    return value;
  }
  if (!value || typeof value !== 'object') throw new Error(`${label} contains non-data value`);
  if (depth > MAX_DEPTH) throw new Error(`${label} exceeds maximum nesting depth`);
  if (context.stack.has(value)) throw new Error(`${label} contains a cycle`);
  context.count += 1;
  if (context.count > MAX_SNAPSHOT_NODES) throw new Error(`${label} exceeds maximum data nodes`);

  context.stack.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${label} must use canonical arrays`);
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SNAPSHOT_NODES) {
        throw new Error(`${label} has invalid array length`);
      }
      const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string' || !expected.has(key)) throw new Error(`${label} contains non-canonical array field`);
      }
      const out = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
          throw new Error(`${label}[${index}] must be an enumerable own data property`);
        }
        out[index] = snapshotCanonicalData(
          descriptor.value,
          `${label}[${index}]`,
          context,
          depth + 1,
        );
      }
      return out;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} contains exotic object`);
    const out = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        throw new Error(`${label}.${key} must be an enumerable own data property`);
      }
      out[key] = snapshotCanonicalData(
        descriptor.value,
        `${label}.${key}`,
        context,
        depth + 1,
      );
    }
    return out;
  } finally {
    context.stack.delete(value);
  }
}

function denseArray(value, label, max) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a canonical array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) throw new Error(`${label} has invalid length`);
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) throw new Error(`${label} contains non-canonical array field`);
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must use exact canonical identity`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be canonical ISO timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must be canonical ISO timestamp`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 0) {
    throw new Error(`${label} must be canonical non-negative integer`);
  }
  return value;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function compareId(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeDisplayText(value, fallback, max = 300) {
  const source = typeof value === 'string' ? value : '';
  const normalized = source
    .replace(UNSAFE_DISPLAY_CONTROLS, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const bounded = [...normalized].slice(0, max).join('');
  return bounded || fallback;
}

function safeTelemetryLagMs(runtimeUpdatedAt, observedAt, nodeId) {
  const observedMs = Date.parse(observedAt);
  const lagMs = runtimeUpdatedAt - observedMs;
  if (!Number.isSafeInteger(lagMs) || lagMs < 0) {
    throw new Error(`telemetry lag is outside safe integer range for nodeId: ${nodeId}`);
  }
  return lagMs;
}

function validateObservableNodeRuntime(nodeRuntime, nodeId) {
  if (!LIFECYCLES.has(nodeRuntime.lifecycle)) {
    throw new Error(`Observable lifecycle is invalid for nodeId: ${nodeId}`);
  }
  if (!SCOPE_STATES.has(nodeRuntime.scopeState)) {
    throw new Error(`Observable scopeState is invalid for nodeId: ${nodeId}`);
  }
  if (typeof nodeRuntime.round !== 'number'
      || !Number.isSafeInteger(nodeRuntime.round)
      || Object.is(nodeRuntime.round, -0)
      || nodeRuntime.round < 1) {
    throw new Error(`Observable round is invalid for nodeId: ${nodeId}`);
  }
  if (nodeRuntime.lastTerminalStatus
      && !TERMINAL_STATUSES.has(nodeRuntime.lastTerminalStatus)) {
    throw new Error(`Observable terminal status is invalid for nodeId: ${nodeId}`);
  }
  if (nodeRuntime.currentActivationId) {
    id(nodeRuntime.currentActivationId, `currentActivationId for ${nodeId}`);
    const current = nodeRuntime.activationLedger?.[nodeRuntime.currentActivationId];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`Current activation is missing for nodeId: ${nodeId}`);
    }
    if (!ACTIVATION_PHASES.has(current.phase)) {
      throw new Error(`Current activation phase is invalid for nodeId: ${nodeId}`);
    }
  }
}

function safeAdd(left, right, label) {
  const next = left + right;
  if (!Number.isSafeInteger(next)) throw new Error(`${label} exceeds safe integer range`);
  return next;
}

export function normalizeAgentTreeTelemetryV1(input) {
  const raw = strictRecord(input, TELEMETRY_KEYS, 'AgentTreeTelemetryV1');
  if (raw.schemaVersion !== AGENT_TREE_TELEMETRY_VERSION) {
    throw new Error('AgentTreeTelemetryV1.schemaVersion must be numeric 1');
  }
  return freezeDeep({
    schemaVersion: AGENT_TREE_TELEMETRY_VERSION,
    nodeId: id(raw.nodeId, 'AgentTreeTelemetryV1.nodeId'),
    observedAt: canonicalTimestamp(raw.observedAt, 'AgentTreeTelemetryV1.observedAt'),
    modelCalls: nonNegativeInteger(raw.modelCalls, 'AgentTreeTelemetryV1.modelCalls'),
    modelInputTokens: nonNegativeInteger(raw.modelInputTokens, 'AgentTreeTelemetryV1.modelInputTokens'),
    modelOutputTokens: nonNegativeInteger(raw.modelOutputTokens, 'AgentTreeTelemetryV1.modelOutputTokens'),
    toolActions: nonNegativeInteger(raw.toolActions, 'AgentTreeTelemetryV1.toolActions'),
    runtimeSeconds: nonNegativeInteger(raw.runtimeSeconds, 'AgentTreeTelemetryV1.runtimeSeconds'),
    costUsdMicros: nonNegativeInteger(raw.costUsdMicros, 'AgentTreeTelemetryV1.costUsdMicros'),
  });
}

function attentionReason(nodeRuntime) {
  const current = nodeRuntime.currentActivationId
    ? nodeRuntime.activationLedger?.[nodeRuntime.currentActivationId]
    : null;
  if (current?.phase === 'AMBIGUOUS') return 'AMBIGUOUS_EFFECT';
  if (nodeRuntime.lifecycle === OrchestrationNodeLifecycle.MANUAL_REVIEW
      || nodeRuntime.lastTerminalStatus === 'MANUAL_REVIEW') return 'MANUAL_REVIEW';
  if (nodeRuntime.lastTerminalStatus === 'BLOCKED') return 'BLOCKED';
  if (nodeRuntime.lastTerminalStatus === 'FAILED') return 'FAILED';
  return '';
}

function stateLabel(nodeRuntime) {
  if (nodeRuntime.lifecycle === OrchestrationNodeLifecycle.TERMINAL && nodeRuntime.lastTerminalStatus) {
    return `TERMINAL:${nodeRuntime.lastTerminalStatus}`;
  }
  return nodeRuntime.lifecycle;
}

function telemetryText(telemetry) {
  if (!telemetry) return 'telemetry unavailable';
  return `model calls ${telemetry.modelCalls}; input tokens ${telemetry.modelInputTokens}; output tokens ${telemetry.modelOutputTokens}; tool actions ${telemetry.toolActions}; runtime seconds ${telemetry.runtimeSeconds}; cost micros ${telemetry.costUsdMicros}`;
}

export function buildAgentTreeProjectionV1(input = {}) {
  const request = strictRecord(input, REQUEST_KEYS, 'AgentTreeProjectionRequestV1');
  if (request.schemaVersion !== AGENT_TREE_OBSERVABILITY_VERSION) {
    throw new Error('AgentTreeProjectionRequestV1.schemaVersion must be numeric 1');
  }

  const graphSnapshot = snapshotCanonicalData(request.graph, 'graph');
  const runtimeSnapshot = snapshotCanonicalData(request.runtime, 'runtime');
  const graph = validateOrchestrationGraphV1(graphSnapshot);
  const runtime = validateOrchestrationHierarchyRuntimeV1(graph, runtimeSnapshot);
  const runtimeUpdatedAt = nonNegativeInteger(runtime.updatedAt, 'runtime.updatedAt');

  const telemetry = denseArray(request.telemetry, 'telemetry', MAX_TELEMETRY_ROWS)
    .map(normalizeAgentTreeTelemetryV1)
    .sort((left, right) => compareId(left.nodeId, right.nodeId));
  if (new Set(telemetry.map(item => item.nodeId)).size !== telemetry.length) {
    throw new Error('telemetry contains duplicate nodeId');
  }

  const telemetryByNodeId = new Map();
  for (const item of telemetry) {
    if (!graph.nodesById[item.nodeId]) throw new Error(`telemetry references unknown nodeId: ${item.nodeId}`);
    if (Date.parse(item.observedAt) > runtimeUpdatedAt) {
      throw new Error(`telemetry occurs after hierarchy runtime for nodeId: ${item.nodeId}`);
    }
    telemetryByNodeId.set(item.nodeId, item);
  }

  const profilesById = new Map(graph.promptProfiles.map(profile => [profile.id, profile]));
  const rows = [];
  const lifecycleCounts = Object.fromEntries(Object.values(OrchestrationNodeLifecycle).map(value => [value, 0]));
  const terminalStatusCounts = Object.create(null);
  const attentionNodeIds = [];
  const totals = {
    modelCalls: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    toolActions: 0,
    runtimeSeconds: 0,
    costUsdMicros: 0,
  };

  function visit(nodeId, depth) {
    const node = graph.nodesById[nodeId];
    const nodeRuntime = runtime.nodesById[nodeId];
    validateObservableNodeRuntime(nodeRuntime, nodeId);
    const profile = profilesById.get(node.promptProfileId);
    const nodeTelemetry = telemetryByNodeId.get(nodeId) || null;
    const reason = attentionReason(nodeRuntime);
    const activeChildCount = node.childIds
      .filter(childId => ACTIVE_LIFECYCLES.has(runtime.nodesById[childId].lifecycle))
      .length;
    lifecycleCounts[nodeRuntime.lifecycle] = (lifecycleCounts[nodeRuntime.lifecycle] || 0) + 1;
    if (nodeRuntime.lastTerminalStatus) {
      terminalStatusCounts[nodeRuntime.lastTerminalStatus] = (terminalStatusCounts[nodeRuntime.lastTerminalStatus] || 0) + 1;
    }
    if (reason) attentionNodeIds.push(nodeId);
    if (nodeTelemetry) {
      for (const key of Object.keys(totals)) {
        totals[key] = safeAdd(totals[key], nodeTelemetry[key], `telemetry total ${key}`);
      }
    }

    const label = safeDisplayText(profile?.role, nodeId);
    const state = stateLabel(nodeRuntime);
    const indent = '  '.repeat(Math.min(depth, 20));
    const attention = reason ? `; attention ${reason}` : '';
    const text = `${indent}${label} [${nodeId}] — ${state}; scope ${nodeRuntime.scopeState}; generation ${nodeRuntime.generation}; round ${nodeRuntime.round}; children ${node.childIds.length}, active ${activeChildCount}; ${telemetryText(nodeTelemetry)}${attention}`;

    rows.push(freezeDeep({
      nodeId,
      parentId: node.parentId,
      childIds: [...node.childIds].sort(compareId),
      depth,
      role: safeDisplayText(profile?.role, ''),
      promptProfileId: node.promptProfileId,
      lifecycle: nodeRuntime.lifecycle,
      scopeState: nodeRuntime.scopeState,
      generation: nodeRuntime.generation,
      round: nodeRuntime.round,
      currentActivationId: nodeRuntime.currentActivationId || '',
      lastTerminalStatus: nodeRuntime.lastTerminalStatus || '',
      stateLabel: state,
      activeChildCount,
      needsOwnerAttention: Boolean(reason),
      attentionReason: reason,
      telemetry: nodeTelemetry,
      telemetryLagMs: nodeTelemetry
        ? safeTelemetryLagMs(runtimeUpdatedAt, nodeTelemetry.observedAt, nodeId)
        : null,
      text,
    }));

    for (const childId of [...node.childIds].sort(compareId)) visit(childId, depth + 1);
  }

  const stableRootIds = [...graph.rootIds].sort(compareId);
  for (const rootId of stableRootIds) visit(rootId, 0);
  if (rows.length !== graph.nodeOrder.length || new Set(rows.map(row => row.nodeId)).size !== graph.nodeOrder.length) {
    throw new Error('Agent tree projection did not cover canonical hierarchy exactly once');
  }

  return freezeDeep({
    schemaVersion: AGENT_TREE_OBSERVABILITY_VERSION,
    graphId: graph.graphId,
    controlEpoch: graph.controlEpoch,
    runtimeUpdatedAt,
    rootIds: stableRootIds,
    rows,
    textLines: rows.map(row => row.text),
    summary: {
      totalNodes: rows.length,
      rootCount: graph.rootIds.length,
      attentionNodeIds,
      lifecycleCounts,
      terminalStatusCounts,
      telemetryNodeCount: telemetry.length,
      telemetryTotals: totals,
    },
    readOnly: true,
    advisoryOnly: true,
    hiddenReasoningIncluded: false,
    rawTranscriptIncluded: false,
    rawPromptIncluded: false,
    executionAuthorized: false,
    policyAuthorized: false,
    schedulingAuthorized: false,
    recoveryAuthorized: false,
    evidenceAuthorityMinted: false,
  });
}
