import {
  AgentExecutionPlane,
  AgentPlanNodeState,
  normalizeAgentPlanV1,
} from './agent-plan.js';

export const SWARM_REFILL_PLANNER_SCHEMA_VERSION = 1;

export const SwarmRefillTriggerKind = Object.freeze({
  TERMINAL_EVENT: 'TERMINAL_EVENT',
  CAPACITY_CHANGED: 'CAPACITY_CHANGED',
  WATCHDOG: 'WATCHDOG',
});

export const SwarmWorkerStatus = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  BACKPRESSURED: 'BACKPRESSURED',
  OFFLINE: 'OFFLINE',
});

export const SwarmDispatchProposalKind = Object.freeze({
  ASSIGN: 'ASSIGN',
  STEAL: 'STEAL',
});

const MAX_WORKERS = 256;
const MAX_CONCURRENCY = 1024;
const MAX_RATE_REMAINING = 1_000_000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

const TRIGGER_KINDS = new Set(Object.values(SwarmRefillTriggerKind));
const WORKER_STATUSES = new Set(Object.values(SwarmWorkerStatus));
const PLANES = new Set(Object.values(AgentExecutionPlane));
const TERMINAL_STATES = new Set([
  AgentPlanNodeState.VERIFIED,
  AgentPlanNodeState.FAILED,
  AgentPlanNodeState.CANCELLED,
]);

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'evaluatedAt',
  'stealAfterMs',
  'workerFreshnessMs',
  'trigger',
  'plan',
  'workers',
]);
const TRIGGER_KEYS = new Set(['kind', 'eventId', 'nodeId', 'observedAt']);
const WORKER_KEYS = new Set([
  'workerId',
  'status',
  'executionPlanes',
  'maxConcurrent',
  'activeCount',
  'rateRemaining',
  'observedAt',
  'validUntil',
]);

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTimestamp(left, right) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return leftMs < rightMs ? -1 : leftMs > rightMs ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function strictRecord(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain or null-prototype object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' fields must be enumerable own data properties');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function requireKeys(raw, required, label) {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error(label + '.' + key + ' is required');
    }
  }
}

function strictArray(input, label, { min = 0, max = 128 } = {}) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(label + ' must be a canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < min || length > max) {
    throw new Error(label + ' must contain ' + min + '..' + max + ' items');
  }
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' contains non-canonical array fields');
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '[' + index + '] must be an enumerable own data property');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function canonicalId(value, label, { optional = false } = {}) {
  if (optional && (value === '' || value === null || value === undefined)) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must be a canonical string identity');
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  return value;
}

function exactInteger(value, label, min, max) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min
      || value > max) {
    throw new Error(label + ' must be an exact integer in ' + min + '..' + max);
  }
  return value;
}

function exactEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function normalizeTrigger(input, plan, evaluatedAt) {
  const raw = strictRecord(input, TRIGGER_KEYS, 'trigger');
  requireKeys(raw, TRIGGER_KEYS, 'trigger');
  const kind = exactEnum(raw.kind, TRIGGER_KINDS, 'trigger.kind');
  const eventId = canonicalId(raw.eventId, 'trigger.eventId');
  const nodeId = canonicalId(raw.nodeId, 'trigger.nodeId', { optional: true });
  const observedAt = canonicalTimestamp(raw.observedAt, 'trigger.observedAt');
  if (Date.parse(observedAt) > Date.parse(evaluatedAt)) {
    throw new Error('trigger.observedAt cannot be after evaluatedAt');
  }

  if (kind === SwarmRefillTriggerKind.TERMINAL_EVENT) {
    if (!nodeId) throw new Error('terminal-event trigger requires nodeId');
    const node = plan.nodes.find(item => item.nodeId === nodeId);
    if (!node) throw new Error('terminal-event trigger references unknown node');
    if (!TERMINAL_STATES.has(node.state)) {
      throw new Error('terminal-event trigger node is not terminal');
    }
    if (Date.parse(node.updatedAt) > Date.parse(observedAt)) {
      throw new Error('terminal-event trigger predates terminal node state');
    }
  } else if (nodeId) {
    throw new Error('non-terminal refill trigger cannot carry nodeId');
  }

  return deepFreeze({ kind, eventId, nodeId, observedAt });
}

function normalizeWorker(input, index, evaluatedAt, workerFreshnessMs) {
  const label = 'workers[' + index + ']';
  const raw = strictRecord(input, WORKER_KEYS, label);
  requireKeys(raw, WORKER_KEYS, label);

  const workerId = canonicalId(raw.workerId, label + '.workerId');
  const status = exactEnum(raw.status, WORKER_STATUSES, label + '.status');
  const executionPlanes = strictArray(raw.executionPlanes, label + '.executionPlanes', { min: 1, max: 4 })
    .map((value, planeIndex) => exactEnum(value, PLANES, label + '.executionPlanes[' + planeIndex + ']'));
  if (new Set(executionPlanes).size !== executionPlanes.length) {
    throw new Error(label + '.executionPlanes contains duplicates');
  }
  executionPlanes.sort(asciiCompare);

  const maxConcurrent = exactInteger(raw.maxConcurrent, label + '.maxConcurrent', 1, MAX_CONCURRENCY);
  const activeCount = exactInteger(raw.activeCount, label + '.activeCount', 0, maxConcurrent);
  const rateRemaining = exactInteger(raw.rateRemaining, label + '.rateRemaining', 0, MAX_RATE_REMAINING);
  const observedAt = canonicalTimestamp(raw.observedAt, label + '.observedAt');
  const validUntil = canonicalTimestamp(raw.validUntil, label + '.validUntil');

  const observedMs = Date.parse(observedAt);
  const evaluatedMs = Date.parse(evaluatedAt);
  const validUntilMs = Date.parse(validUntil);
  if (observedMs > evaluatedMs) throw new Error(label + '.observedAt cannot be after evaluatedAt');
  if (validUntilMs < observedMs) throw new Error(label + '.validUntil cannot predate observedAt');
  if (validUntilMs - observedMs > MAX_WINDOW_MS) {
    throw new Error(label + '.validUntil exceeds the bounded observation window');
  }

  const fresh = evaluatedMs <= validUntilMs && evaluatedMs - observedMs <= workerFreshnessMs;
  const nominalFreeSlots = Math.max(0, maxConcurrent - activeCount);
  const freeSlots = status === SwarmWorkerStatus.AVAILABLE && fresh
    ? Math.min(nominalFreeSlots, rateRemaining)
    : 0;

  return deepFreeze({
    workerId,
    status,
    executionPlanes,
    maxConcurrent,
    activeCount,
    rateRemaining,
    observedAt,
    validUntil,
    fresh,
    freeSlots,
  });
}

function assertPlanTime(plan, evaluatedAt) {
  const evaluatedMs = Date.parse(evaluatedAt);
  const createdMs = Date.parse(plan.createdAt);
  const updatedMs = Date.parse(plan.updatedAt);
  if (createdMs > updatedMs || updatedMs > evaluatedMs) {
    throw new Error('AgentPlan timestamps are not causally current for evaluatedAt');
  }
  for (const node of plan.nodes) {
    const nodeMs = Date.parse(node.updatedAt);
    if (nodeMs < createdMs || nodeMs > updatedMs) {
      throw new Error('AgentPlan node timestamp is outside plan chronology: ' + node.nodeId);
    }
  }
}

function assertStoredReadyStateIsDependencyCoherent(plan) {
  const byId = new Map(plan.nodes.map(node => [node.nodeId, node]));
  for (const node of plan.nodes) {
    if (node.state !== AgentPlanNodeState.READY) continue;
    const dependencies = node.dependsOn.map(dependencyId => byId.get(dependencyId));
    const failedDependency = dependencies.find(dependency => (
      dependency.state === AgentPlanNodeState.FAILED
      || dependency.state === AgentPlanNodeState.CANCELLED
      || dependency.state === AgentPlanNodeState.BLOCKED
    ));
    if (failedDependency) {
      throw new Error(
        'AgentPlan READY node has terminal or blocked dependency: '
        + node.nodeId + ' <- ' + failedDependency.nodeId,
      );
    }
    const unverifiedDependency = dependencies.find(
      dependency => dependency.state !== AgentPlanNodeState.VERIFIED,
    );
    if (unverifiedDependency) {
      throw new Error(
        'AgentPlan READY node has unverified dependency: '
        + node.nodeId + ' <- ' + unverifiedDependency.nodeId,
      );
    }
  }
}

function buildDownstreamDepth(plan) {
  const dependents = new Map(plan.nodes.map(node => [node.nodeId, []]));
  for (const node of plan.nodes) {
    for (const dependency of node.dependsOn) dependents.get(dependency).push(node.nodeId);
  }
  for (const children of dependents.values()) children.sort(asciiCompare);

  const memo = new Map();
  const visit = nodeId => {
    if (memo.has(nodeId)) return memo.get(nodeId);
    const children = dependents.get(nodeId);
    const depth = children.length === 0
      ? 1
      : 1 + Math.max(...children.map(visit));
    memo.set(nodeId, depth);
    return depth;
  };
  for (const node of plan.nodes) visit(node.nodeId);
  return memo;
}

function mutableWorkerState(worker) {
  return {
    worker,
    freeSlots: worker.freeSlots,
    rateRemaining: worker.rateRemaining,
  };
}

function canRun(state, node) {
  return state.freeSlots > 0
    && state.rateRemaining > 0
    && state.worker.status === SwarmWorkerStatus.AVAILABLE
    && state.worker.fresh
    && state.worker.executionPlanes.includes(node.executionPlane);
}

function compareWorkerState(left, right) {
  return right.freeSlots - left.freeSlots
    || left.worker.activeCount - right.worker.activeCount
    || right.rateRemaining - left.rateRemaining
    || asciiCompare(left.worker.workerId, right.worker.workerId);
}

function chooseWorker(states, node, excludedWorkerId = '') {
  return [...states.values()]
    .filter(state => state.worker.workerId !== excludedWorkerId && canRun(state, node))
    .sort(compareWorkerState)[0] || null;
}

function ownerGate(node, ownerState, evaluatedAt, stealAfterMs) {
  if (!node.ownerId) {
    return { stealAllowed: true, reasonCode: 'UNOWNED_READY_NODE' };
  }
  if (!ownerState) {
    return { stealAllowed: true, reasonCode: 'OWNER_NOT_PRESENT' };
  }
  if (!ownerState.worker.fresh) {
    return { stealAllowed: true, reasonCode: 'OWNER_EVIDENCE_STALE' };
  }
  if (ownerState.worker.status === SwarmWorkerStatus.OFFLINE) {
    return { stealAllowed: true, reasonCode: 'OWNER_OFFLINE' };
  }
  if (ownerState.worker.status === SwarmWorkerStatus.BACKPRESSURED) {
    return { stealAllowed: true, reasonCode: 'OWNER_BACKPRESSURED' };
  }
  if (!ownerState.worker.executionPlanes.includes(node.executionPlane)) {
    return { stealAllowed: true, reasonCode: 'OWNER_PLANE_INELIGIBLE' };
  }

  const readyWaitMs = Date.parse(evaluatedAt) - Date.parse(node.updatedAt);
  if (ownerState.rateRemaining <= 0) {
    return readyWaitMs >= stealAfterMs
      ? { stealAllowed: true, reasonCode: 'OWNER_RATE_DEPLETED_WAIT_EXCEEDED' }
      : { stealAllowed: false, reasonCode: 'OWNER_RATE_DEPLETED_RESERVED' };
  }
  if (ownerState.freeSlots <= 0) {
    return readyWaitMs >= stealAfterMs
      ? { stealAllowed: true, reasonCode: 'OWNER_AT_CAPACITY_WAIT_EXCEEDED' }
      : { stealAllowed: false, reasonCode: 'OWNER_AT_CAPACITY_RESERVED' };
  }

  return { stealAllowed: false, reasonCode: 'OWNER_CAPACITY_AVAILABLE' };
}

function consume(state) {
  state.freeSlots -= 1;
  state.rateRemaining -= 1;
}

function conflictWith(keys, occupied) {
  return keys.some(key => occupied.has(key));
}

export function buildSwarmRefillPlanV1(input) {
  const raw = strictRecord(input, REQUEST_KEYS, 'SwarmRefillPlannerRequestV1');
  requireKeys(raw, REQUEST_KEYS, 'SwarmRefillPlannerRequestV1');
  if (raw.schemaVersion !== SWARM_REFILL_PLANNER_SCHEMA_VERSION) {
    throw new Error('SwarmRefillPlannerRequestV1 schemaVersion must be numeric 1');
  }

  const evaluatedAt = canonicalTimestamp(raw.evaluatedAt, 'evaluatedAt');
  const stealAfterMs = exactInteger(raw.stealAfterMs, 'stealAfterMs', 0, MAX_WINDOW_MS);
  const workerFreshnessMs = exactInteger(
    raw.workerFreshnessMs,
    'workerFreshnessMs',
    1,
    MAX_WINDOW_MS,
  );
  const plan = normalizeAgentPlanV1(raw.plan);
  assertPlanTime(plan, evaluatedAt);
  assertStoredReadyStateIsDependencyCoherent(plan);
  const trigger = normalizeTrigger(raw.trigger, plan, evaluatedAt);

  const workers = strictArray(raw.workers, 'workers', { min: 1, max: MAX_WORKERS })
    .map((worker, index) => normalizeWorker(worker, index, evaluatedAt, workerFreshnessMs));
  const workerIds = new Set();
  for (const worker of workers) {
    if (workerIds.has(worker.workerId)) {
      throw new Error('workers contain duplicate workerId: ' + worker.workerId);
    }
    workerIds.add(worker.workerId);
  }

  const workerStates = new Map(
    workers.map(worker => [worker.workerId, mutableWorkerState(worker)]),
  );
  const initialFreeSlots = workers.reduce((sum, worker) => sum + worker.freeSlots, 0);
  const downstreamDepth = buildDownstreamDepth(plan);
  const runningConflictKeys = new Set(
    plan.nodes
      .filter(node => node.state === AgentPlanNodeState.RUNNING)
      .flatMap(node => node.conflictKeys),
  );
  const proposedConflictKeys = new Set();

  const readyNodes = plan.nodes
    .filter(node => node.state === AgentPlanNodeState.READY)
    .sort((left, right) => (
      downstreamDepth.get(right.nodeId) - downstreamDepth.get(left.nodeId)
      || compareTimestamp(left.updatedAt, right.updatedAt)
      || asciiCompare(left.nodeId, right.nodeId)
    ));

  const proposals = [];
  const unassigned = [];

  for (const node of readyNodes) {
    if (conflictWith(node.conflictKeys, runningConflictKeys)) {
      unassigned.push(deepFreeze({
        nodeId: node.nodeId,
        ownerId: node.ownerId,
        reasonCode: 'RUNNING_CONFLICT_KEY',
      }));
      continue;
    }
    if (conflictWith(node.conflictKeys, proposedConflictKeys)) {
      unassigned.push(deepFreeze({
        nodeId: node.nodeId,
        ownerId: node.ownerId,
        reasonCode: 'PROPOSED_CONFLICT_KEY_RESERVED',
      }));
      continue;
    }

    const ownerState = node.ownerId ? workerStates.get(node.ownerId) || null : null;
    let selected = null;
    let kind = SwarmDispatchProposalKind.ASSIGN;
    let reasonCode = 'UNOWNED_READY_NODE';

    if (ownerState && canRun(ownerState, node)) {
      selected = ownerState;
      reasonCode = 'CURRENT_OWNER_CAPACITY_AVAILABLE';
    } else {
      const gate = ownerGate(node, ownerState, evaluatedAt, stealAfterMs);
      if (!gate.stealAllowed) {
        unassigned.push(deepFreeze({
          nodeId: node.nodeId,
          ownerId: node.ownerId,
          reasonCode: gate.reasonCode,
        }));
        continue;
      }
      selected = chooseWorker(workerStates, node, node.ownerId);
      if (!selected) {
        unassigned.push(deepFreeze({
          nodeId: node.nodeId,
          ownerId: node.ownerId,
          reasonCode: 'NO_ELIGIBLE_WORKER_CAPACITY',
        }));
        continue;
      }
      reasonCode = gate.reasonCode;
      if (node.ownerId && selected.worker.workerId !== node.ownerId) {
        kind = SwarmDispatchProposalKind.STEAL;
      }
    }

    consume(selected);
    for (const key of node.conflictKeys) proposedConflictKeys.add(key);

    proposals.push(deepFreeze({
      proposalKind: kind,
      nodeId: node.nodeId,
      executionPlane: node.executionPlane,
      workerId: selected.worker.workerId,
      sourceOwnerId: node.ownerId,
      reasonCode,
      structuralDownstreamDepth: downstreamDepth.get(node.nodeId),
      readySince: node.updatedAt,
      conflictKeys: [...node.conflictKeys].sort(asciiCompare),
      advisoryOnly: true,
      dispatchAuthorized: false,
      leaseAuthorized: false,
      executionAuthorized: false,
      taskMutationAuthorized: false,
      requiresCanonicalReservation: true,
    }));
  }

  const workerEvidence = workers
    .map(worker => {
      const state = workerStates.get(worker.workerId);
      return deepFreeze({
        workerId: worker.workerId,
        status: worker.status,
        executionPlanes: [...worker.executionPlanes],
        fresh: worker.fresh,
        freeSlotsBefore: worker.freeSlots,
        freeSlotsAfter: state.freeSlots,
        rateRemainingBefore: worker.rateRemaining,
        rateRemainingAfter: state.rateRemaining,
        observedAt: worker.observedAt,
        validUntil: worker.validUntil,
      });
    })
    .sort((left, right) => asciiCompare(left.workerId, right.workerId));

  proposals.sort((left, right) => (
    right.structuralDownstreamDepth - left.structuralDownstreamDepth
    || compareTimestamp(left.readySince, right.readySince)
    || asciiCompare(left.nodeId, right.nodeId)
  ));
  unassigned.sort((left, right) => asciiCompare(left.nodeId, right.nodeId));

  const finalFreeSlots = [...workerStates.values()].reduce(
    (sum, state) => sum + state.freeSlots,
    0,
  );

  return deepFreeze({
    schemaVersion: SWARM_REFILL_PLANNER_SCHEMA_VERSION,
    evaluatedAt,
    sourcePlan: {
      planId: plan.planId,
      jobId: plan.jobId,
      revision: plan.revision,
      updatedAt: plan.updatedAt,
    },
    trigger,
    stealAfterMs,
    workerFreshnessMs,
    proposals,
    unassigned,
    workerEvidence,
    summary: {
      readyNodeCount: readyNodes.length,
      proposedCount: proposals.length,
      stealCount: proposals.filter(item => item.proposalKind === SwarmDispatchProposalKind.STEAL).length,
      ownerFillCount: proposals.filter(item => item.sourceOwnerId && item.workerId === item.sourceOwnerId).length,
      unownedFillCount: proposals.filter(item => !item.sourceOwnerId).length,
      unassignedCount: unassigned.length,
      staleWorkerCount: workers.filter(worker => !worker.fresh).length,
      backpressuredWorkerCount: workers.filter(
        worker => worker.status === SwarmWorkerStatus.BACKPRESSURED,
      ).length,
      idleSlotsBefore: initialFreeSlots,
      idleSlotsAfter: finalFreeSlots,
    },
    sourceTrust: 'UNVERIFIED_WORKER_OBSERVATIONS',
    readOnly: true,
    advisoryOnly: true,
    completionDrivenRefill: trigger.kind === SwarmRefillTriggerKind.TERMINAL_EVENT,
    watchdogFallback: trigger.kind === SwarmRefillTriggerKind.WATCHDOG,
    dispatchAuthorized: false,
    leaseAuthorized: false,
    executionAuthorized: false,
    taskMutationAuthorized: false,
    policyDecisionGranted: false,
    requiresCanonicalPlanRevisionRecheck: true,
    requiresCanonicalWorkerCapacityRecheck: true,
    requiresCanonicalConflictLeaseRecheck: true,
    requiresCanonicalPolicyDecision: true,
    requiresCanonicalReservation: true,
  });
}
