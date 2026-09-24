export const ORCHESTRATION_GRAPH_SCHEMA_VERSION = 1;
export const ORCHESTRATION_HIERARCHY_RUNTIME_VERSION = 1;

export const OrchestrationChatMode = Object.freeze({
  PERSISTENT_CHAT: 'PERSISTENT_CHAT',
  NEW_CHAT_PER_ACTIVATION: 'NEW_CHAT_PER_ACTIVATION',
});

export const OrchestrationNodeLifecycle = Object.freeze({
  IDLE: 'IDLE',
  PREPARING_EFFECT: 'PREPARING_EFFECT',
  ACTIVE: 'ACTIVE',
  TERMINAL: 'TERMINAL',
  PAUSED: 'PAUSED',
  STOPPED: 'STOPPED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
});

export const OrchestrationBarrierMode = Object.freeze({
  NONE: 'NONE',
  ALL_DIRECT_CHILDREN: 'ALL_DIRECT_CHILDREN',
  REQUIRED_DIRECT_CHILDREN: 'REQUIRED_DIRECT_CHILDREN',
});

export const OrchestrationLoopMode = Object.freeze({
  ONE_SHOT: 'ONE_SHOT',
  CONTINUOUS: 'CONTINUOUS',
});

export const OrchestrationTerminalStatus = Object.freeze({
  COMPLETED: 'COMPLETED',
  NO_ACTION: 'NO_ACTION',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  CANCELLED: 'CANCELLED',
});

export const OrchestrationActivationPurpose = Object.freeze({
  DELEGATE: 'DELEGATE',
  WORK: 'WORK',
  RECONCILE: 'RECONCILE',
  RECOVERY: 'RECOVERY',
});

export const OrchestrationActivationPhase = Object.freeze({
  PREPARED: 'PREPARED',
  EFFECT_CONFIRMED: 'EFFECT_CONFIRMED',
  AMBIGUOUS: 'AMBIGUOUS',
  TERMINAL: 'TERMINAL',
  SUPERSEDED: 'SUPERSEDED',
});

export const OrchestrationHierarchyEventType = Object.freeze({
  NODE_ACTIVATION_REQUESTED: 'NODE_ACTIVATION_REQUESTED',
  NODE_EFFECT_CONFIRMED: 'NODE_EFFECT_CONFIRMED',
  NODE_EFFECT_AMBIGUOUS: 'NODE_EFFECT_AMBIGUOUS',
  NODE_TERMINAL: 'NODE_TERMINAL',
  BARRIER_REEVALUATE: 'BARRIER_REEVALUATE',
  PAUSE_SCOPE: 'PAUSE_SCOPE',
  RESUME_SCOPE: 'RESUME_SCOPE',
  STOP_SCOPE: 'STOP_SCOPE',
  GENERATION_SUPERSEDED: 'GENERATION_SUPERSEDED',
  GENERATION_RECOVERY_REQUESTED: 'GENERATION_RECOVERY_REQUESTED',
  RUNTIME_RECONCILE: 'RUNTIME_RECONCILE',
  PROVIDER_SLOT_COUNT_REQUESTED: 'PROVIDER_SLOT_COUNT_REQUESTED',
  PROVIDER_FOLDER_DISPATCH_REQUESTED: 'PROVIDER_FOLDER_DISPATCH_REQUESTED',
});

export const OrchestrationHierarchyActionType = Object.freeze({
  ACTIVATE_NODE: 'ACTIVATE_NODE',
  SEND_RECONCILIATION_PROMPT: 'SEND_RECONCILIATION_PROMPT',
  RECONCILE_PREPARED_EFFECT: 'RECONCILE_PREPARED_EFFECT',
  VERIFY_AMBIGUOUS_EFFECT: 'VERIFY_AMBIGUOUS_EFFECT',
  WAIT: 'WAIT',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
});

const CHAT_MODES = new Set(Object.values(OrchestrationChatMode));
const BARRIER_MODES = new Set(Object.values(OrchestrationBarrierMode));
const LOOP_MODES = new Set(Object.values(OrchestrationLoopMode));
const TERMINAL_STATUSES = new Set(Object.values(OrchestrationTerminalStatus));
const PURPOSES = new Set(Object.values(OrchestrationActivationPurpose));
const EVENT_TYPES = new Set(Object.values(OrchestrationHierarchyEventType));

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requireId(value, label) {
  const normalized = text(value);
  if (!normalized || normalized.length > 180 || !/^[A-Za-z0-9._:@/+-]+$/u.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function requireInteger(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || !Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed;
}

function stableHash64(value) {
  const input = String(value ?? '');
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
}

export function compactOrchestrationEventId(prefix, ...parts) {
  const safePrefix = requireId(prefix, 'event prefix');
  return `${safePrefix}:${stableHash64(parts.map(part => String(part ?? '')).join('\u001f'))}`;
}

function normalizeLoopPolicy(raw) {
  const source = isObject(raw) ? raw : {};
  const mode = text(source.mode || OrchestrationLoopMode.ONE_SHOT).toUpperCase();
  if (!LOOP_MODES.has(mode)) throw new Error('Invalid loopPolicy.mode');
  const maxRounds = requireInteger(source.maxRounds ?? source.max_rounds ?? 0, 'loopPolicy.maxRounds', 0, 1000000);
  return { mode, maxRounds };
}

function clone(value) {
  return structuredClone(value);
}

function uniqueSortedIds(value, label, max = 500) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${label}`);
  const ids = value.map((item, index) => requireId(item, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label}`);
  return ids.sort((a, b) => a.localeCompare(b));
}

function normalizePromptProfiles(raw) {
  const source = Array.isArray(raw)
    ? raw
    : isObject(raw)
      ? Object.entries(raw).map(([id, profile]) => ({ id, ...(isObject(profile) ? profile : {}) }))
      : [];
  if (!source.length) throw new Error('At least one prompt profile is required');
  const profiles = source.map((profile, index) => {
    if (!isObject(profile)) throw new Error(`Invalid promptProfiles[${index}]`);
    return {
      id: requireId(profile.id, `promptProfiles[${index}].id`),
      role: text(profile.role),
      version: requireInteger(profile.version ?? 1, `promptProfiles[${index}].version`, 1, 1000000),
      prompt: typeof profile.prompt === 'string' ? profile.prompt.trim() : '',
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) {
    throw new Error('Duplicate prompt profile id');
  }
  return profiles;
}

function normalizeBarrier(raw, childIds, nodeId) {
  const source = isObject(raw) ? raw : {};
  const mode = text(source.mode || (childIds.length ? OrchestrationBarrierMode.ALL_DIRECT_CHILDREN : OrchestrationBarrierMode.NONE)).toUpperCase();
  if (!BARRIER_MODES.has(mode)) throw new Error(`Invalid barrier mode for ${nodeId}`);
  const requiredChildIds = mode === OrchestrationBarrierMode.REQUIRED_DIRECT_CHILDREN
    ? uniqueSortedIds(source.childIds, `barrier.childIds for ${nodeId}`)
    : mode === OrchestrationBarrierMode.ALL_DIRECT_CHILDREN
      ? [...childIds]
      : [];
  if (requiredChildIds.some(childId => !childIds.includes(childId))) {
    throw new Error(`Barrier for ${nodeId} references non-child node`);
  }
  if (mode === OrchestrationBarrierMode.REQUIRED_DIRECT_CHILDREN && !requiredChildIds.length) {
    throw new Error(`Barrier for ${nodeId} requires at least one child`);
  }
  return { mode, childIds: requiredChildIds };
}

function normalizeProviderBinding(raw, nodeId, childIds) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) throw new Error(`Invalid provider binding for ${nodeId}`);
  const providerId = requireId(raw.providerId, `providerBinding.providerId for ${nodeId}`);
  const groupNodeId = requireId(raw.groupNodeId ?? nodeId, `providerBinding.groupNodeId for ${nodeId}`);
  if (groupNodeId !== nodeId) throw new Error(`Provider binding cannot widen authority for ${nodeId}`);
  const maxSlots = requireInteger(raw.maxSlots ?? childIds.length, `providerBinding.maxSlots for ${nodeId}`, 0, childIds.length);
  const sourceId = raw.sourceId == null || raw.sourceId === ''
    ? ''
    : requireId(raw.sourceId, `providerBinding.sourceId for ${nodeId}`);
  const pollIntervalMs = requireInteger(
    raw.pollIntervalMs ?? 180000,
    `providerBinding.pollIntervalMs for ${nodeId}`,
    60000,
    86400000,
  );
  return { providerId, groupNodeId, maxSlots, sourceId, pollIntervalMs };
}

function normalizeNode(raw, index) {
  if (!isObject(raw)) throw new Error(`Invalid nodes[${index}]`);
  const id = requireId(raw.id, `nodes[${index}].id`);
  const parentId = raw.parentId === undefined || raw.parentId === null || raw.parentId === ''
    ? null
    : requireId(raw.parentId, `nodes[${index}].parentId`);
  const childIds = uniqueSortedIds(raw.childIds, `nodes[${index}].childIds`);
  const chatMode = text(raw.chatMode || OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION).toUpperCase();
  if (!CHAT_MODES.has(chatMode)) throw new Error(`Invalid chatMode for ${id}`);
  const promptProfileId = requireId(raw.promptProfileId, `nodes[${index}].promptProfileId`);
  const recoveryPromptProfileId = requireId(
    raw.recoveryPromptProfileId ?? raw.recovery_prompt_profile_id ?? promptProfileId,
    `nodes[${index}].recoveryPromptProfileId`,
  );
  const maxActiveChildren = requireInteger(
    raw.maxActiveChildren ?? childIds.length,
    `nodes[${index}].maxActiveChildren`,
    0,
    childIds.length,
  );
  const barrier = normalizeBarrier(raw.barrier, childIds, id);
  const providerBinding = normalizeProviderBinding(raw.providerBinding, id, childIds);
  return {
    id,
    parentId,
    childIds,
    chatMode,
    promptProfileId,
    recoveryPromptProfileId,
    maxActiveChildren,
    barrier,
    providerBinding,
  };
}

function assertAcyclic(nodesById, nodeOrder) {
  const visiting = new Set();
  const visited = new Set();
  function visit(nodeId) {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) throw new Error(`Orchestration graph cycle at ${nodeId}`);
    visiting.add(nodeId);
    for (const childId of nodesById[nodeId].childIds) visit(childId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  }
  for (const nodeId of nodeOrder) visit(nodeId);
}

export function validateOrchestrationGraphV1(raw) {
  if (!isObject(raw)) throw new Error('Invalid orchestration graph');
  if (Number(raw.schemaVersion ?? raw.schema_version ?? ORCHESTRATION_GRAPH_SCHEMA_VERSION) !== ORCHESTRATION_GRAPH_SCHEMA_VERSION) {
    throw new Error('Unsupported orchestration graph schemaVersion');
  }
  const graphId = requireId(raw.graphId ?? raw.graph_id, 'graphId');
  const controlEpoch = requireInteger(raw.controlEpoch ?? raw.control_epoch ?? 1, 'controlEpoch', 1, Number.MAX_SAFE_INTEGER);
  const promptProfiles = normalizePromptProfiles(raw.promptProfiles ?? raw.prompt_profiles);
  const promptProfileIds = new Set(promptProfiles.map(profile => profile.id));

  // A normalized graph is durable product state and is therefore a valid validator
  // input on restart. Reconstruct the node list only when the normalized identity
  // is internally exact; never accept missing/extra/reordered node identities.
  let nodeSource = raw.nodes;
  if (!Array.isArray(nodeSource) && Array.isArray(raw.nodeOrder) && isObject(raw.nodesById)) {
    const order = raw.nodeOrder.map((nodeId, index) => requireId(nodeId, `nodeOrder[${index}]`));
    const nodeKeys = Object.keys(raw.nodesById).sort((a, b) => a.localeCompare(b));
    const orderedKeys = [...order].sort((a, b) => a.localeCompare(b));
    if (new Set(order).size !== order.length
        || nodeKeys.length !== orderedKeys.length
        || nodeKeys.some((nodeId, index) => nodeId !== orderedKeys[index])) {
      throw new Error('Invalid normalized nodes');
    }
    nodeSource = order.map(nodeId => {
      const node = raw.nodesById[nodeId];
      if (!isObject(node) || node.id !== nodeId) throw new Error('Invalid normalized nodes');
      return node;
    });
  }

  if (!Array.isArray(nodeSource) || !nodeSource.length || nodeSource.length > 1000) throw new Error('Invalid nodes');
  const nodes = nodeSource.map(normalizeNode).sort((a, b) => a.id.localeCompare(b.id));
  const nodeOrder = nodes.map(node => node.id);
  if (new Set(nodeOrder).size !== nodeOrder.length) throw new Error('Duplicate node id');
  const nodesById = Object.fromEntries(nodes.map(node => [node.id, node]));

  for (const node of nodes) {
    if (!promptProfileIds.has(node.promptProfileId)) throw new Error(`Unknown prompt profile for ${node.id}`);
    if (!promptProfileIds.has(node.recoveryPromptProfileId)) throw new Error(`Unknown recovery prompt profile for ${node.id}`);
    if (node.parentId && !nodesById[node.parentId]) throw new Error(`Orphan node ${node.id}`);
    for (const childId of node.childIds) {
      const child = nodesById[childId];
      if (!child) throw new Error(`Unknown child ${childId} for ${node.id}`);
      if (child.parentId !== node.id) throw new Error(`Mismatched parent/child link ${node.id} -> ${childId}`);
    }
    if (node.parentId && !nodesById[node.parentId].childIds.includes(node.id)) {
      throw new Error(`Mismatched child/parent link ${node.parentId} -> ${node.id}`);
    }
  }

  assertAcyclic(nodesById, nodeOrder);
  const rootIds = nodeOrder.filter(nodeId => nodesById[nodeId].parentId === null);
  if (!rootIds.length) throw new Error('Orchestration graph requires at least one root');
  const loopPolicy = normalizeLoopPolicy(raw.loopPolicy ?? raw.loop_policy);

  return {
    schemaVersion: ORCHESTRATION_GRAPH_SCHEMA_VERSION,
    graphId,
    controlEpoch,
    loopPolicy,
    promptProfiles,
    rootIds,
    nodeOrder,
    nodesById,
  };
}

function newNodeRuntime(nodeId) {
  return {
    nodeId,
    generation: 1,
    lifecycle: OrchestrationNodeLifecycle.IDLE,
    round: 1,
    scopeState: 'RUNNING',
    currentActivationId: '',
    lastTerminalStatus: '',
    activationLedger: {},
    completedBarrierKeys: {},
    providerState: {
      lastAcceptedRevision: '',
      lastRequestedSlotCount: 0,
      activeRevision: '',
      activeChildIds: [],
      lastAcceptedAt: 0,
      lastCheckedAt: 0,
      nextCheckAt: 0,
      lastErrorCode: '',
      lastAcceptedDispatchFingerprint: '',
    },
  };
}

export function createOrchestrationHierarchyRuntime(graphRaw, nowMs = Date.now()) {
  const graph = validateOrchestrationGraphV1(graphRaw);
  return {
    schemaVersion: ORCHESTRATION_HIERARCHY_RUNTIME_VERSION,
    graphId: graph.graphId,
    controlEpoch: graph.controlEpoch,
    createdAt: nowMs,
    updatedAt: nowMs,
    processedEventIds: {},
    nodeOrder: [...graph.nodeOrder],
    nodesById: Object.fromEntries(graph.nodeOrder.map(nodeId => [nodeId, newNodeRuntime(nodeId)])),
  };
}

function assertRuntime(graph, runtime) {
  if (!isObject(runtime) || Number(runtime.schemaVersion) !== ORCHESTRATION_HIERARCHY_RUNTIME_VERSION) {
    throw new Error('Invalid orchestration hierarchy runtime');
  }
  if (runtime.graphId !== graph.graphId) throw new Error('Runtime graph mismatch');
  if (Number(runtime.controlEpoch) !== graph.controlEpoch) throw new Error('Runtime control epoch mismatch');
  if (!isObject(runtime.nodesById) || !isObject(runtime.processedEventIds) || !Array.isArray(runtime.nodeOrder)) {
    throw new Error('Invalid orchestration runtime state');
  }
  if (runtime.nodeOrder.length !== graph.nodeOrder.length
      || runtime.nodeOrder.some((nodeId, index) => nodeId !== graph.nodeOrder[index])) {
    throw new Error('Runtime node order mismatch');
  }
  for (const nodeId of graph.nodeOrder) {
    const nodeRuntime = runtime.nodesById[nodeId];
    if (!isObject(nodeRuntime)) throw new Error(`Missing runtime node ${nodeId}`);
    if (nodeRuntime.nodeId !== nodeId) throw new Error(`Runtime node identity mismatch for ${nodeId}`);
    if (!Number.isInteger(nodeRuntime.generation) || nodeRuntime.generation < 1) throw new Error(`Invalid runtime generation for ${nodeId}`);
    if (!isObject(nodeRuntime.activationLedger) || !isObject(nodeRuntime.completedBarrierKeys)) {
      throw new Error(`Invalid runtime ledger for ${nodeId}`);
    }
    if (nodeRuntime.providerState !== undefined) {
      if (!isObject(nodeRuntime.providerState)) throw new Error(`Invalid provider runtime state for ${nodeId}`);
      const providerState = nodeRuntime.providerState;
      for (const revision of [providerState.lastAcceptedRevision || '', providerState.activeRevision || '']) {
        const revisionText = String(revision);
        if (revision && (!/^[0-9]+$/u.test(revisionText) || revisionText.length > 128)) {
          throw new Error(`Invalid provider revision state for ${nodeId}`);
        }
      }
      const requested = Number(providerState.lastRequestedSlotCount || 0);
      if (!Number.isInteger(requested) || requested < 0 || requested > (graph.nodesById[nodeId].providerBinding?.maxSlots ?? graph.nodesById[nodeId].childIds.length)) {
        throw new Error(`Invalid provider slot state for ${nodeId}`);
      }
      if (!Array.isArray(providerState.activeChildIds)
          || providerState.activeChildIds.some(childId => !graph.nodesById[nodeId].childIds.includes(childId))
          || new Set(providerState.activeChildIds).size !== providerState.activeChildIds.length) {
        throw new Error(`Invalid provider child authority state for ${nodeId}`);
      }
      const dispatchFingerprint = String(providerState.lastAcceptedDispatchFingerprint || '');
      if (dispatchFingerprint && !/^[a-f0-9]{64}$/u.test(dispatchFingerprint)) {
        throw new Error(`Invalid provider dispatch fingerprint state for ${nodeId}`);
      }
      for (const key of ['lastAcceptedAt', 'lastCheckedAt', 'nextCheckAt']) {
        const value = Number(providerState[key] || 0);
        if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid provider timestamp state for ${nodeId}`);
      }
    }
  }
}

export function validateOrchestrationHierarchyRuntimeV1(graphRaw, runtimeRaw) {
  const graph = validateOrchestrationGraphV1(graphRaw);
  assertRuntime(graph, runtimeRaw);
  return clone(runtimeRaw);
}

function descendantsInclusive(graph, nodeId) {
  const out = [];
  const stack = [nodeId];
  while (stack.length) {
    const current = stack.pop();
    out.push(current);
    for (const childId of [...graph.nodesById[current].childIds].reverse()) stack.push(childId);
  }
  return out;
}

function ancestorScopeState(graph, runtime, nodeId) {
  let current = nodeId;
  while (current) {
    const state = runtime.nodesById[current].scopeState;
    if (state === 'STOPPED') return 'STOPPED';
    if (state === 'PAUSED') return 'PAUSED';
    current = graph.nodesById[current].parentId;
  }
  return 'RUNNING';
}

function activationIdForChild(parentActivationId, childId, generation, round) {
  return `${parentActivationId}:child:${childId}:g${generation}:r${round}`;
}

function activationRound(activationId) {
  const match = String(activationId || '').match(/:r(\d+)$/u);
  if (!match) return 0;
  const round = Number(match[1]);
  return Number.isSafeInteger(round) && round > 0 ? round : 0;
}

function reconciliationId(parentNodeId, generation, round) {
  return `reconcile:${parentNodeId}:g${generation}:r${round}`;
}

function normalizeProviderRevision(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/u.test(raw) || raw.length > 128) throw new Error('Invalid providerRevision');
  return raw.replace(/^0+(?=\d)/u, '') || '0';
}

function compareProviderRevision(left, right) {
  const a = normalizeProviderRevision(left);
  const b = normalizeProviderRevision(right);
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function providerStateFor(nodeRuntime) {
  if (!isObject(nodeRuntime.providerState)) {
    nodeRuntime.providerState = {
      lastAcceptedRevision: '',
      lastRequestedSlotCount: 0,
      activeRevision: '',
      activeChildIds: [],
      lastAcceptedAt: 0,
      lastCheckedAt: 0,
      nextCheckAt: 0,
      lastErrorCode: '',
    };
  }
  if (!Array.isArray(nodeRuntime.providerState.activeChildIds)) {
    nodeRuntime.providerState.activeChildIds = [];
  }
  return nodeRuntime.providerState;
}

function currentActivation(nodeRuntime) {
  return nodeRuntime.currentActivationId
    ? nodeRuntime.activationLedger[nodeRuntime.currentActivationId]
    : null;
}

function canPrepareProviderChild(graph, runtime, childId) {
  const childRuntime = runtime.nodesById[childId];
  if (!childRuntime) return { ok: false, reason: 'UNKNOWN_CHILD' };
  if (ancestorScopeState(graph, runtime, childId) !== 'RUNNING') {
    return { ok: false, reason: 'CHILD_SCOPE_BLOCKED' };
  }
  const current = currentActivation(childRuntime);
  if (current && ![OrchestrationActivationPhase.TERMINAL, OrchestrationActivationPhase.SUPERSEDED].includes(current.phase)) {
    return { ok: false, reason: 'CHILD_ACTIVATION_IN_FLIGHT' };
  }
  return { ok: true };
}

function prepareActivation(graph, runtime, {
  nodeId,
  activationId,
  generation,
  purpose,
  nowMs,
  promptPayload = '',
  promptProfileId = '',
  providerDispatchIdentity = '',
}) {
  const node = graph.nodesById[nodeId];
  const nodeRuntime = runtime.nodesById[nodeId];
  if (!node || !nodeRuntime) throw new Error(`Unknown node ${nodeId}`);
  if (generation !== nodeRuntime.generation) return { action: null, reason: 'STALE_GENERATION' };
  if (nodeRuntime.activationLedger[activationId]) return { action: null, reason: 'DUPLICATE_ACTIVATION' };
  const current = nodeRuntime.currentActivationId
    ? nodeRuntime.activationLedger[nodeRuntime.currentActivationId]
    : null;
  if (current && ![OrchestrationActivationPhase.TERMINAL, OrchestrationActivationPhase.SUPERSEDED].includes(current.phase)) {
    return { action: null, reason: 'NODE_ACTIVATION_IN_FLIGHT' };
  }
  const scopeState = ancestorScopeState(graph, runtime, nodeId);
  if (scopeState !== 'RUNNING') return { action: null, reason: `SCOPE_${scopeState}` };
  const normalizedPurpose = text(purpose || (node.childIds.length ? OrchestrationActivationPurpose.DELEGATE : OrchestrationActivationPurpose.WORK)).toUpperCase();
  if (!PURPOSES.has(normalizedPurpose)) throw new Error('Invalid activation purpose');
  const durablePromptPayload = typeof promptPayload === 'string' ? promptPayload.trim() : '';
  if (durablePromptPayload.length > 200000) throw new Error('Invalid activation promptPayload');
  const durablePromptProfileId = promptProfileId ? requireId(promptProfileId, 'activation.promptProfileId') : '';
  const durableProviderDispatchIdentity = providerDispatchIdentity
    ? requireId(providerDispatchIdentity, 'activation.providerDispatchIdentity')
    : '';
  nodeRuntime.activationLedger[activationId] = {
    activationId,
    nodeId,
    generation,
    round: nodeRuntime.round,
    purpose: normalizedPurpose,
    phase: OrchestrationActivationPhase.PREPARED,
    preparedAt: nowMs,
    effectConfirmedAt: 0,
    terminalAt: 0,
    effectRef: '',
    terminalStatus: '',
    promptPayload: durablePromptPayload,
    promptProfileId: durablePromptProfileId,
    providerDispatchIdentity: durableProviderDispatchIdentity,
  };
  nodeRuntime.currentActivationId = activationId;
  nodeRuntime.lifecycle = OrchestrationNodeLifecycle.PREPARING_EFFECT;
  const actionType = normalizedPurpose === OrchestrationActivationPurpose.RECONCILE
    ? OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT
    : OrchestrationHierarchyActionType.ACTIVATE_NODE;
  const resolvedPromptProfileId = durablePromptProfileId || (
    normalizedPurpose === OrchestrationActivationPurpose.RECOVERY
      ? node.recoveryPromptProfileId
      : node.promptProfileId
  );
  return {
    action: {
      type: actionType,
      nodeId,
      activationId,
      generation,
      round: nodeRuntime.round,
      purpose: normalizedPurpose,
      chatMode: node.chatMode,
      promptProfileId: resolvedPromptProfileId,
      promptPayload: durablePromptPayload,
      providerDispatchIdentity: durableProviderDispatchIdentity,
      authority: 'EXISTING_CORE_SESSION_TASK_PATH',
    },
    reason: 'PREPARED',
  };
}

function terminalForCurrentRound(runtimeNode, childId) {
  const childRuntime = runtimeNode.__children?.[childId];
  return childRuntime === true;
}

function childSubtreeTerminalForBarrier(graph, runtime, childId) {
  const child = graph.nodesById[childId];
  const childRuntime = runtime.nodesById[childId];
  const current = currentActivation(childRuntime);
  if (!current || current.phase !== OrchestrationActivationPhase.TERMINAL) return false;
  if (child.childIds.length) {
    return current.purpose === OrchestrationActivationPurpose.RECONCILE;
  }
  return true;
}

function barrierSatisfied(graph, runtime, parentId) {
  const parent = graph.nodesById[parentId];
  const parentRuntime = runtime.nodesById[parentId];
  if (parent.providerBinding) {
    const providerState = providerStateFor(parentRuntime);
    if (!providerState.activeRevision) return false;
    return providerState.activeChildIds.every(childId => childSubtreeTerminalForBarrier(graph, runtime, childId));
  }
  const barrier = parent.barrier;
  if (barrier.mode === OrchestrationBarrierMode.NONE) return false;
  const required = barrier.childIds;
  return required.every(childId => childSubtreeTerminalForBarrier(graph, runtime, childId));
}

function maybePrepareParentReconciliation(graph, runtime, parentId, nowMs) {
  if (!parentId || !barrierSatisfied(graph, runtime, parentId)) return null;
  const parent = graph.nodesById[parentId];
  const parentRuntime = runtime.nodesById[parentId];
  const providerState = parent.providerBinding ? providerStateFor(parentRuntime) : null;
  const key = providerState?.activeRevision
    ? `provider:${parent.providerBinding.providerId}:revision:${providerState.activeRevision}`
    : `g${parentRuntime.generation}:r${parentRuntime.round}`;
  if (parentRuntime.completedBarrierKeys[key]) return null;
  parentRuntime.completedBarrierKeys[key] = true;
  const activationId = providerState?.activeRevision
    ? `reconcile:${parentId}:provider:${parent.providerBinding.providerId}:revision:${providerState.activeRevision}:g${parentRuntime.generation}:r${parentRuntime.round}`
    : reconciliationId(parentId, parentRuntime.generation, parentRuntime.round);
  const prepared = prepareActivation(graph, runtime, {
    nodeId: parentId,
    activationId,
    generation: parentRuntime.generation,
    purpose: OrchestrationActivationPurpose.RECONCILE,
    nowMs,
  });
  return prepared.action;
}

function pruneContinuousRuntimeHistory(runtime, {
  maxProcessedEvents = 5000,
  maxActivationsPerNode = 62,
  maxBarrierKeysPerNode = 64,
} = {}) {
  const eventEntries = Object.entries(runtime.processedEventIds || {});
  if (eventEntries.length > maxProcessedEvents) {
    eventEntries.sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0));
    runtime.processedEventIds = Object.fromEntries(eventEntries.slice(0, maxProcessedEvents));
  }
  for (const nodeId of runtime.nodeOrder) {
    const nodeRuntime = runtime.nodesById[nodeId];
    const activations = Object.values(nodeRuntime.activationLedger || {});
    if (activations.length > maxActivationsPerNode) {
      const keep = new Set(
        activations.slice().sort((left, right) => Number(right.preparedAt || 0) - Number(left.preparedAt || 0))
          .slice(0, maxActivationsPerNode).map(entry => entry.activationId),
      );
      for (const activationId of Object.keys(nodeRuntime.activationLedger)) {
        if (activationId === nodeRuntime.currentActivationId) continue;
        if (!keep.has(activationId)) delete nodeRuntime.activationLedger[activationId];
      }
    }
    const barrierKeys = Object.keys(nodeRuntime.completedBarrierKeys || {});
    if (barrierKeys.length > maxBarrierKeysPerNode) {
      const keepKeys = new Set(barrierKeys.slice(-maxBarrierKeysPerNode));
      for (const key of barrierKeys) {
        if (!keepKeys.has(key)) delete nodeRuntime.completedBarrierKeys[key];
      }
    }
  }
}

function prepareNextContinuousRound(graph, runtime, rootNodeId, nowMs) {
  if (graph.loopPolicy.mode !== OrchestrationLoopMode.CONTINUOUS) return null;
  const rootRuntime = runtime.nodesById[rootNodeId];
  const completedRound = rootRuntime.round;
  if (graph.loopPolicy.maxRounds > 0 && completedRound >= graph.loopPolicy.maxRounds) return null;

  const nextRound = completedRound + 1;
  for (const nodeId of runtime.nodeOrder) {
    const nodeRuntime = runtime.nodesById[nodeId];
    nodeRuntime.round = nextRound;
    nodeRuntime.currentActivationId = '';
    nodeRuntime.lastTerminalStatus = '';
    if (nodeRuntime.scopeState === 'RUNNING') nodeRuntime.lifecycle = OrchestrationNodeLifecycle.IDLE;
  }
  pruneContinuousRuntimeHistory(runtime);

  const root = graph.nodesById[rootNodeId];
  const activationId = `loop:${rootNodeId}:g${rootRuntime.generation}:r${nextRound}`;
  const prepared = prepareActivation(graph, runtime, {
    nodeId: rootNodeId,
    activationId,
    generation: rootRuntime.generation,
    purpose: root.childIds.length ? OrchestrationActivationPurpose.DELEGATE : OrchestrationActivationPurpose.WORK,
    nowMs,
  });
  return prepared.action;
}

function normalizeEvent(raw) {
  if (!isObject(raw)) throw new Error('Invalid orchestration hierarchy event');
  const type = text(raw.type).toUpperCase();
  if (!EVENT_TYPES.has(type)) throw new Error('Invalid orchestration hierarchy event type');
  return {
    ...raw,
    type,
    eventId: requireId(raw.eventId ?? raw.event_id, 'eventId'),
    controlEpoch: requireInteger(raw.controlEpoch ?? raw.control_epoch ?? 1, 'event.controlEpoch', 1, Number.MAX_SAFE_INTEGER),
  };
}

function nodeEventIdentity(event) {
  const nodeId = requireId(event.nodeId ?? event.node_id, 'event.nodeId');
  const generation = requireInteger(event.generation, 'event.generation', 1, Number.MAX_SAFE_INTEGER);
  return { nodeId, generation };
}

function activationEventIdentity(event) {
  const base = nodeEventIdentity(event);
  return {
    ...base,
    activationId: requireId(event.activationId ?? event.activation_id, 'event.activationId'),
  };
}

export function reduceOrchestrationHierarchyEvent(graphRaw, runtimeRaw, eventRaw, nowMs = Date.now()) {
  const graph = validateOrchestrationGraphV1(graphRaw);
  assertRuntime(graph, runtimeRaw);
  const runtime = clone(runtimeRaw);
  const event = normalizeEvent(eventRaw);
  if (runtime.processedEventIds[event.eventId]) {
    return { runtime, actions: [], deduplicated: true, reason: 'DUPLICATE_EVENT' };
  }
  // A compacted event id can disappear from the bounded event ledger. The
  // durable round is still authoritative, so reject an old activation before
  // recording its id or moving updatedAt.
  if (event.controlEpoch === runtime.controlEpoch
      && event.type === OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED) {
    const { nodeId, generation, activationId } = activationEventIdentity(event);
    const current = runtime.nodesById[nodeId];
    if (current && generation === current.generation) {
      const requestedRound = activationRound(activationId);
      if (requestedRound && requestedRound !== current.round) {
        return { runtime, actions: [], deduplicated: false, reason: 'STALE_ROUND' };
      }
    }
  }
  runtime.processedEventIds[event.eventId] = nowMs;
  runtime.updatedAt = nowMs;

  if (event.controlEpoch !== runtime.controlEpoch) {
    return {
      runtime,
      actions: [{ type: OrchestrationHierarchyActionType.WAIT, reason: 'STALE_CONTROL_EPOCH' }],
      deduplicated: false,
      reason: 'STALE_CONTROL_EPOCH',
    };
  }

  const actions = [];

  if ([OrchestrationHierarchyEventType.PAUSE_SCOPE, OrchestrationHierarchyEventType.RESUME_SCOPE, OrchestrationHierarchyEventType.STOP_SCOPE].includes(event.type)) {
    const nodeId = requireId(event.nodeId ?? event.node_id, 'event.nodeId');
    if (!graph.nodesById[nodeId]) throw new Error(`Unknown node ${nodeId}`);
    const nextScope = event.type === OrchestrationHierarchyEventType.PAUSE_SCOPE
      ? 'PAUSED'
      : event.type === OrchestrationHierarchyEventType.STOP_SCOPE
        ? 'STOPPED'
        : 'RUNNING';
    for (const scopedId of descendantsInclusive(graph, nodeId)) {
      const nodeRuntime = runtime.nodesById[scopedId];
      if (nodeRuntime.scopeState === 'STOPPED' && nextScope !== 'STOPPED') continue;
      nodeRuntime.scopeState = nextScope;
      if (nextScope === 'PAUSED') nodeRuntime.lifecycle = OrchestrationNodeLifecycle.PAUSED;
      if (nextScope === 'STOPPED') nodeRuntime.lifecycle = OrchestrationNodeLifecycle.STOPPED;
      if (nextScope === 'RUNNING' && [OrchestrationNodeLifecycle.PAUSED, OrchestrationNodeLifecycle.IDLE].includes(nodeRuntime.lifecycle)) {
        nodeRuntime.lifecycle = OrchestrationNodeLifecycle.IDLE;
      }
    }
    return { runtime, actions, deduplicated: false, reason: nextScope };
  }

  if (event.type === OrchestrationHierarchyEventType.PROVIDER_FOLDER_DISPATCH_REQUESTED) {
    const nodeId = requireId(event.nodeId ?? event.node_id, 'event.nodeId');
    const node = graph.nodesById[nodeId];
    const nodeRuntime = runtime.nodesById[nodeId];
    if (!node || !nodeRuntime) throw new Error(`Unknown node ${nodeId}`);
    const binding = node.providerBinding;
    if (!binding) {
      return { runtime, actions, deduplicated: false, reason: 'PROVIDER_NOT_CONFIGURED' };
    }

    const providerId = requireId(event.providerId ?? event.provider_id, 'event.providerId');
    if (providerId !== binding.providerId || binding.groupNodeId !== nodeId) {
      return { runtime, actions, deduplicated: false, reason: 'PROVIDER_AUTHORITY_MISMATCH' };
    }
    const sourceId = event.sourceId == null || event.sourceId === ''
      ? ''
      : requireId(event.sourceId, 'event.sourceId');
    if (binding.sourceId && sourceId !== binding.sourceId) {
      return { runtime, actions, deduplicated: false, reason: 'PROVIDER_SOURCE_MISMATCH' };
    }

    const providerRevision = normalizeProviderRevision(event.providerRevision ?? event.provider_revision);
    const dispatchFingerprint = String(event.dispatchFingerprint ?? event.dispatch_fingerprint ?? '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(dispatchFingerprint)) throw new Error('Invalid event.dispatchFingerprint');
    if (!Array.isArray(event.dispatches) || event.dispatches.length > binding.maxSlots) {
      throw new Error('Invalid event.dispatches');
    }

    const dispatches = event.dispatches.map((raw, index) => {
      if (!isObject(raw)) throw new Error(`Invalid event.dispatches[${index}]`);
      const fileId = requireId(raw.fileId ?? raw.file_id, `event.dispatches[${index}].fileId`);
      const fileVersion = normalizeProviderRevision(raw.fileVersion ?? raw.file_version);
      const dispatchIdentity = String(raw.dispatchIdentity ?? raw.dispatch_identity ?? '').trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/u.test(dispatchIdentity)) {
        throw new Error(`Invalid event.dispatches[${index}].dispatchIdentity`);
      }
      const targetChildId = requireId(
        raw.targetChildId ?? raw.target_child_id,
        `event.dispatches[${index}].targetChildId`,
      );
      if (!node.childIds.includes(targetChildId)) {
        throw new Error(`Provider dispatch references non-child ${targetChildId}`);
      }
      const promptPayload = typeof raw.promptPayload === 'string'
        ? raw.promptPayload.trim()
        : typeof raw.prompt === 'string'
          ? raw.prompt.trim()
          : '';
      if (promptPayload.length > 200000) throw new Error(`Invalid event.dispatches[${index}].promptPayload`);
      const promptProfileId = raw.promptProfileId ?? raw.prompt_profile_id ?? '';
      const normalizedProfileId = promptProfileId
        ? requireId(promptProfileId, `event.dispatches[${index}].promptProfileId`)
        : '';
      if (Boolean(promptPayload) === Boolean(normalizedProfileId)) {
        throw new Error(`Invalid event.dispatches[${index}] prompt authority`);
      }
      if (normalizedProfileId && normalizedProfileId !== graph.nodesById[targetChildId].promptProfileId) {
        throw new Error(`Provider dispatch prompt profile not locally allowed for ${targetChildId}`);
      }
      return {
        fileId,
        fileVersion,
        dispatchIdentity,
        targetChildId,
        promptPayload,
        promptProfileId: normalizedProfileId,
      };
    });
    if (new Set(dispatches.map(item => item.targetChildId)).size !== dispatches.length) {
      throw new Error('Duplicate provider dispatch child target');
    }
    if (new Set(dispatches.map(item => item.dispatchIdentity)).size !== dispatches.length) {
      throw new Error('Duplicate provider dispatch identity');
    }

    const providerState = providerStateFor(nodeRuntime);
    if (providerState.lastAcceptedRevision) {
      const revisionOrder = compareProviderRevision(providerRevision, providerState.lastAcceptedRevision);
      if (revisionOrder < 0) {
        return { runtime, actions, deduplicated: false, reason: 'STALE_PROVIDER_REVISION' };
      }
      if (revisionOrder === 0) {
        if (providerState.lastAcceptedDispatchFingerprint !== dispatchFingerprint) {
          actions.push({
            type: OrchestrationHierarchyActionType.MANUAL_REVIEW,
            nodeId,
            reason: 'PROVIDER_REVISION_CONFLICT',
          });
          return { runtime, actions, deduplicated: false, reason: 'PROVIDER_REVISION_CONFLICT' };
        }
        return { runtime, actions, deduplicated: false, reason: 'DUPLICATE_PROVIDER_REVISION' };
      }
    }

    if (ancestorScopeState(graph, runtime, nodeId) !== 'RUNNING') {
      delete runtime.processedEventIds[event.eventId];
      return {
        runtime,
        actions,
        deduplicated: false,
        reason: nodeRuntime.scopeState === 'STOPPED' ? 'SCOPE_STOPPED' : 'SCOPE_PAUSED',
      };
    }
    const parentActivation = currentActivation(nodeRuntime);
    if (!parentActivation || parentActivation.phase !== OrchestrationActivationPhase.TERMINAL) {
      delete runtime.processedEventIds[event.eventId];
      actions.push({ type: OrchestrationHierarchyActionType.WAIT, nodeId, reason: 'PROVIDER_PARENT_NOT_TERMINAL' });
      return { runtime, actions, deduplicated: false, reason: 'PROVIDER_PARENT_NOT_TERMINAL' };
    }

    for (const childId of node.childIds) {
      const preflight = canPrepareProviderChild(graph, runtime, childId);
      if (!preflight.ok) {
        delete runtime.processedEventIds[event.eventId];
        actions.push({ type: OrchestrationHierarchyActionType.WAIT, nodeId, reason: 'PROVIDER_SLOTS_BUSY' });
        return { runtime, actions, deduplicated: false, reason: 'PROVIDER_SLOTS_BUSY' };
      }
    }

    for (const item of dispatches) {
      const childRuntime = runtime.nodesById[item.targetChildId];
      const activationId = `provider:${providerId}:dispatch:${item.dispatchIdentity}:g${childRuntime.generation}`;
      const prepared = prepareActivation(graph, runtime, {
        nodeId: item.targetChildId,
        activationId,
        generation: childRuntime.generation,
        purpose: graph.nodesById[item.targetChildId].childIds.length
          ? OrchestrationActivationPurpose.DELEGATE
          : OrchestrationActivationPurpose.WORK,
        nowMs,
        promptPayload: item.promptPayload,
        promptProfileId: item.promptProfileId,
        providerDispatchIdentity: item.dispatchIdentity,
      });
      if (!prepared.action) throw new Error(`Provider dispatch preflight diverged for ${item.targetChildId}: ${prepared.reason}`);
      actions.push(prepared.action);
    }

    providerState.lastAcceptedRevision = providerRevision;
    providerState.lastRequestedSlotCount = dispatches.length;
    providerState.activeRevision = providerRevision;
    providerState.activeChildIds = dispatches.map(item => item.targetChildId);
    providerState.lastAcceptedAt = nowMs;
    providerState.lastCheckedAt = nowMs;
    providerState.lastErrorCode = '';
    providerState.lastAcceptedDispatchFingerprint = dispatchFingerprint;

    if (dispatches.length === 0) {
      const key = `provider:${binding.providerId}:revision:${providerRevision}`;
      if (!nodeRuntime.completedBarrierKeys[key]) {
        nodeRuntime.completedBarrierKeys[key] = true;
        const activationId = `reconcile:${nodeId}:provider:${binding.providerId}:revision:${providerRevision}:g${nodeRuntime.generation}:r${nodeRuntime.round}`;
        const prepared = prepareActivation(graph, runtime, {
          nodeId,
          activationId,
          generation: nodeRuntime.generation,
          purpose: OrchestrationActivationPurpose.RECONCILE,
          nowMs,
        });
        if (prepared.action) actions.push(prepared.action);
      }
    }

    return { runtime, actions, deduplicated: false, reason: 'PROVIDER_REVISION_ACCEPTED' };
  }

  if (event.type === OrchestrationHierarchyEventType.PROVIDER_SLOT_COUNT_REQUESTED) {
    const nodeId = requireId(event.nodeId ?? event.node_id, 'event.nodeId');
    const node = graph.nodesById[nodeId];
    const nodeRuntime = runtime.nodesById[nodeId];
    if (!node || !nodeRuntime) throw new Error(`Unknown node ${nodeId}`);
    const binding = node.providerBinding;
    if (!binding) {
      return { runtime, actions, deduplicated: false, reason: 'PROVIDER_NOT_CONFIGURED' };
    }
    const providerId = requireId(event.providerId ?? event.provider_id, 'event.providerId');
    if (providerId !== binding.providerId || binding.groupNodeId !== nodeId) {
      return { runtime, actions, deduplicated: false, reason: 'PROVIDER_AUTHORITY_MISMATCH' };
    }
    const sourceId = event.sourceId == null || event.sourceId === ''
      ? ''
      : requireId(event.sourceId, 'event.sourceId');
    if (binding.sourceId && sourceId !== binding.sourceId) {
      return { runtime, actions, deduplicated: false, reason: 'PROVIDER_SOURCE_MISMATCH' };
    }
    const providerRevision = normalizeProviderRevision(event.providerRevision ?? event.provider_revision);
    const requestedSlotCount = requireInteger(
      event.requestedSlotCount ?? event.requested_slot_count,
      'event.requestedSlotCount',
      0,
      binding.maxSlots,
    );
    const providerState = providerStateFor(nodeRuntime);
    if (providerState.lastAcceptedRevision) {
      const revisionOrder = compareProviderRevision(providerRevision, providerState.lastAcceptedRevision);
      if (revisionOrder < 0) {
        return { runtime, actions, deduplicated: false, reason: 'STALE_PROVIDER_REVISION' };
      }
      if (revisionOrder === 0) {
        if (requestedSlotCount !== providerState.lastRequestedSlotCount) {
          actions.push({
            type: OrchestrationHierarchyActionType.MANUAL_REVIEW,
            nodeId,
            reason: 'PROVIDER_REVISION_CONFLICT',
          });
          return { runtime, actions, deduplicated: false, reason: 'PROVIDER_REVISION_CONFLICT' };
        }
        return { runtime, actions, deduplicated: false, reason: 'DUPLICATE_PROVIDER_REVISION' };
      }
    }
    if (ancestorScopeState(graph, runtime, nodeId) !== 'RUNNING') {
      delete runtime.processedEventIds[event.eventId];
      return {
        runtime,
        actions,
        deduplicated: false,
        reason: nodeRuntime.scopeState === 'STOPPED' ? 'SCOPE_STOPPED' : 'SCOPE_PAUSED',
      };
    }
    const parentActivation = currentActivation(nodeRuntime);
    if (!parentActivation || parentActivation.phase !== OrchestrationActivationPhase.TERMINAL) {
      delete runtime.processedEventIds[event.eventId];
      actions.push({ type: OrchestrationHierarchyActionType.WAIT, nodeId, reason: 'PROVIDER_PARENT_NOT_TERMINAL' });
      return { runtime, actions, deduplicated: false, reason: 'PROVIDER_PARENT_NOT_TERMINAL' };
    }

    const targetChildIds = node.childIds.slice(0, requestedSlotCount);
    for (const childId of node.childIds) {
      const preflight = canPrepareProviderChild(graph, runtime, childId);
      if (!preflight.ok) {
        delete runtime.processedEventIds[event.eventId];
        actions.push({ type: OrchestrationHierarchyActionType.WAIT, nodeId, reason: 'PROVIDER_SLOTS_BUSY' });
        return { runtime, actions, deduplicated: false, reason: 'PROVIDER_SLOTS_BUSY' };
      }
    }

    for (const childId of targetChildIds) {
      const childRuntime = runtime.nodesById[childId];
      const activationId = `provider:${providerId}:revision:${providerRevision}:child:${childId}:g${childRuntime.generation}`;
      const prepared = prepareActivation(graph, runtime, {
        nodeId: childId,
        activationId,
        generation: childRuntime.generation,
        purpose: graph.nodesById[childId].childIds.length
          ? OrchestrationActivationPurpose.DELEGATE
          : OrchestrationActivationPurpose.WORK,
        nowMs,
      });
      if (!prepared.action) throw new Error(`Provider preflight diverged for ${childId}: ${prepared.reason}`);
      actions.push(prepared.action);
    }

    providerState.lastAcceptedRevision = providerRevision;
    providerState.lastRequestedSlotCount = requestedSlotCount;
    providerState.activeRevision = providerRevision;
    providerState.activeChildIds = [...targetChildIds];
    providerState.lastAcceptedAt = nowMs;
    providerState.lastCheckedAt = nowMs;
    providerState.lastErrorCode = '';

    if (requestedSlotCount === 0) {
      const key = `provider:${binding.providerId}:revision:${providerRevision}`;
      if (!nodeRuntime.completedBarrierKeys[key]) {
        nodeRuntime.completedBarrierKeys[key] = true;
        const activationId = `reconcile:${nodeId}:provider:${binding.providerId}:revision:${providerRevision}:g${nodeRuntime.generation}:r${nodeRuntime.round}`;
        const prepared = prepareActivation(graph, runtime, {
          nodeId,
          activationId,
          generation: nodeRuntime.generation,
          purpose: OrchestrationActivationPurpose.RECONCILE,
          nowMs,
        });
        if (prepared.action) actions.push(prepared.action);
      }
    }

    return { runtime, actions, deduplicated: false, reason: 'PROVIDER_REVISION_ACCEPTED' };
  }

  if (event.type === OrchestrationHierarchyEventType.GENERATION_RECOVERY_REQUESTED) {
    const { nodeId, generation } = nodeEventIdentity(event);
    const nodeRuntime = runtime.nodesById[nodeId];
    if (!graph.nodesById[nodeId] || !nodeRuntime) throw new Error(`Unknown node ${nodeId}`);
    if (generation !== nodeRuntime.generation) {
      return { runtime, actions, deduplicated: false, reason: 'STALE_GENERATION' };
    }
    if (nodeRuntime.scopeState !== 'RUNNING') {
      if (nodeRuntime.scopeState === 'PAUSED') {
        delete runtime.processedEventIds[event.eventId];
      }
      return {
        runtime,
        actions,
        deduplicated: false,
        reason: nodeRuntime.scopeState === 'STOPPED' ? 'SCOPE_STOPPED' : 'SCOPE_PAUSED',
      };
    }
    const newGeneration = requireInteger(
      event.newGeneration ?? event.new_generation ?? generation + 1,
      'event.newGeneration',
      generation + 1,
      Number.MAX_SAFE_INTEGER,
    );
    const activationId = requireId(
      event.activationId ?? event.activation_id ?? `recovery:${nodeId}:g${newGeneration}:r${nodeRuntime.round + 1}`,
      'event.activationId',
    );

    for (const entry of Object.values(nodeRuntime.activationLedger)) {
      if (entry.generation < newGeneration && entry.phase !== OrchestrationActivationPhase.TERMINAL) {
        entry.phase = OrchestrationActivationPhase.SUPERSEDED;
      }
    }
    nodeRuntime.generation = newGeneration;
    nodeRuntime.lifecycle = OrchestrationNodeLifecycle.IDLE;
    nodeRuntime.currentActivationId = '';
    nodeRuntime.lastTerminalStatus = '';
    nodeRuntime.round += 1;

    const prepared = prepareActivation(graph, runtime, {
      nodeId,
      activationId,
      generation: newGeneration,
      purpose: OrchestrationActivationPurpose.RECOVERY,
      nowMs,
    });
    if (prepared.action) actions.push(prepared.action);
    return {
      runtime,
      actions,
      deduplicated: false,
      reason: prepared.action ? 'GENERATION_RECOVERY_PREPARED' : prepared.reason,
    };
  }

  if (event.type === OrchestrationHierarchyEventType.GENERATION_SUPERSEDED) {
    const { nodeId, generation } = nodeEventIdentity(event);
    if (!graph.nodesById[nodeId]) throw new Error(`Unknown node ${nodeId}`);
    const nodeRuntime = runtime.nodesById[nodeId];
    if (generation < nodeRuntime.generation) return { runtime, actions, deduplicated: false, reason: 'STALE_GENERATION' };
    const newGeneration = requireInteger(event.newGeneration ?? event.new_generation, 'event.newGeneration', generation + 1, Number.MAX_SAFE_INTEGER);
    for (const entry of Object.values(nodeRuntime.activationLedger)) {
      if (entry.generation < newGeneration && entry.phase !== OrchestrationActivationPhase.TERMINAL) {
        entry.phase = OrchestrationActivationPhase.SUPERSEDED;
      }
    }
    nodeRuntime.generation = newGeneration;
    nodeRuntime.lifecycle = OrchestrationNodeLifecycle.IDLE;
    nodeRuntime.currentActivationId = '';
    nodeRuntime.lastTerminalStatus = '';
    nodeRuntime.round += 1;
    return { runtime, actions, deduplicated: false, reason: 'GENERATION_SUPERSEDED' };
  }

  if (event.type === OrchestrationHierarchyEventType.RUNTIME_RECONCILE) {
    for (const nodeId of graph.nodeOrder) {
      const nodeRuntime = runtime.nodesById[nodeId];
      for (const entry of Object.values(nodeRuntime.activationLedger)) {
        if (entry.generation !== nodeRuntime.generation) continue;
        if (entry.phase === OrchestrationActivationPhase.PREPARED) {
          actions.push({
            type: OrchestrationHierarchyActionType.RECONCILE_PREPARED_EFFECT,
            nodeId,
            activationId: entry.activationId,
            generation: entry.generation,
            authority: 'EXISTING_EFFECT_VERIFIER',
          });
        } else if (entry.phase === OrchestrationActivationPhase.AMBIGUOUS) {
          actions.push({
            type: OrchestrationHierarchyActionType.VERIFY_AMBIGUOUS_EFFECT,
            nodeId,
            activationId: entry.activationId,
            generation: entry.generation,
            authority: 'EXISTING_EFFECT_VERIFIER',
          });
        }
      }
    }
    return { runtime, actions, deduplicated: false, reason: 'RECONCILE' };
  }

  if (event.type === OrchestrationHierarchyEventType.BARRIER_REEVALUATE) {
    const { nodeId, generation } = nodeEventIdentity(event);
    const nodeRuntime = runtime.nodesById[nodeId];
    if (!nodeRuntime || generation !== nodeRuntime.generation) return { runtime, actions, deduplicated: false, reason: 'STALE_GENERATION' };
    const action = maybePrepareParentReconciliation(graph, runtime, nodeId, nowMs);
    if (action) actions.push(action);
    return { runtime, actions, deduplicated: false, reason: action ? 'BARRIER_SATISFIED' : 'BARRIER_WAIT' };
  }

  const { nodeId, generation, activationId } = activationEventIdentity(event);
  const node = graph.nodesById[nodeId];
  const nodeRuntime = runtime.nodesById[nodeId];
  if (!node || !nodeRuntime) throw new Error(`Unknown node ${nodeId}`);
  if (generation !== nodeRuntime.generation) {
    return { runtime, actions, deduplicated: false, reason: 'STALE_GENERATION' };
  }

  if (event.type === OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED) {
    const prepared = prepareActivation(graph, runtime, {
      nodeId,
      activationId,
      generation,
      purpose: event.purpose,
      nowMs,
    });
    if (prepared.action) actions.push(prepared.action);
    return { runtime, actions, deduplicated: false, reason: prepared.reason };
  }

  const ledger = nodeRuntime.activationLedger[activationId];
  if (!ledger) {
    actions.push({
      type: OrchestrationHierarchyActionType.MANUAL_REVIEW,
      nodeId,
      activationId,
      reason: 'UNKNOWN_ACTIVATION',
    });
    nodeRuntime.lifecycle = OrchestrationNodeLifecycle.MANUAL_REVIEW;
    return { runtime, actions, deduplicated: false, reason: 'UNKNOWN_ACTIVATION' };
  }

  if (event.type === OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED) {
    if (ledger.phase === OrchestrationActivationPhase.TERMINAL) return { runtime, actions, deduplicated: false, reason: 'ALREADY_TERMINAL' };
    ledger.phase = OrchestrationActivationPhase.EFFECT_CONFIRMED;
    ledger.effectConfirmedAt = nowMs;
    ledger.effectRef = text(event.effectRef ?? event.effect_ref);
    nodeRuntime.lifecycle = OrchestrationNodeLifecycle.ACTIVE;
    return { runtime, actions, deduplicated: false, reason: 'EFFECT_CONFIRMED' };
  }

  if (event.type === OrchestrationHierarchyEventType.NODE_EFFECT_AMBIGUOUS) {
    if (ledger.phase === OrchestrationActivationPhase.TERMINAL) return { runtime, actions, deduplicated: false, reason: 'ALREADY_TERMINAL' };
    ledger.phase = OrchestrationActivationPhase.AMBIGUOUS;
    nodeRuntime.lifecycle = OrchestrationNodeLifecycle.MANUAL_REVIEW;
    actions.push({
      type: OrchestrationHierarchyActionType.VERIFY_AMBIGUOUS_EFFECT,
      nodeId,
      activationId,
      generation,
      authority: 'EXISTING_EFFECT_VERIFIER',
    });
    return { runtime, actions, deduplicated: false, reason: 'AMBIGUOUS_EFFECT' };
  }

  if (event.type === OrchestrationHierarchyEventType.NODE_TERMINAL) {
    const status = text(event.status).toUpperCase();
    if (!TERMINAL_STATUSES.has(status)) throw new Error('Invalid terminal status');
    if (ledger.phase === OrchestrationActivationPhase.TERMINAL) {
      return { runtime, actions, deduplicated: false, reason: 'ALREADY_TERMINAL' };
    }
    ledger.phase = OrchestrationActivationPhase.TERMINAL;
    ledger.terminalAt = nowMs;
    ledger.terminalStatus = status;
    nodeRuntime.lifecycle = OrchestrationNodeLifecycle.TERMINAL;
    nodeRuntime.lastTerminalStatus = status;

    if ([OrchestrationActivationPurpose.DELEGATE, OrchestrationActivationPurpose.RECOVERY].includes(ledger.purpose)
        && node.childIds.length
        && !node.providerBinding) {
      for (const childId of node.childIds.slice(0, node.maxActiveChildren || node.childIds.length)) {
        const childRuntime = runtime.nodesById[childId];
        const childActivationId = activationIdForChild(activationId, childId, childRuntime.generation, nodeRuntime.round);
        const prepared = prepareActivation(graph, runtime, {
          nodeId: childId,
          activationId: childActivationId,
          generation: childRuntime.generation,
          purpose: graph.nodesById[childId].childIds.length
            ? OrchestrationActivationPurpose.DELEGATE
            : OrchestrationActivationPurpose.WORK,
          nowMs,
        });
        if (prepared.action) actions.push(prepared.action);
      }
    }

    if (!node.childIds.length || ledger.purpose === OrchestrationActivationPurpose.RECONCILE) {
      const parentAction = maybePrepareParentReconciliation(graph, runtime, node.parentId, nowMs);
      if (parentAction) actions.push(parentAction);
    }
    if (!node.parentId && ledger.purpose === OrchestrationActivationPurpose.RECONCILE) {
      const nextRoundAction = prepareNextContinuousRound(graph, runtime, nodeId, nowMs);
      if (nextRoundAction) {
        actions.push(nextRoundAction);
        return { runtime, actions, deduplicated: false, reason: 'CONTINUOUS_ROUND_PREPARED' };
      }
    }
    return { runtime, actions, deduplicated: false, reason: 'TERMINAL' };
  }

  throw new Error('Unhandled orchestration hierarchy event');
}
