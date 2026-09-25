/**
 * AgentPlanV1 is a durable planning contract, not a second scheduler.  It is
 * deliberately provider-agnostic so Browser Agent, Companion, MCP and remote
 * specialists can all project their work onto the existing control plane.
 */
export const AGENT_PLAN_VERSION = 1;

export const AgentPlanNodeState = Object.freeze({
  PENDING: 'PENDING',
  READY: 'READY',
  RUNNING: 'RUNNING',
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
});

export const AgentExecutionPlane = Object.freeze({
  BROWSER: 'BROWSER',
  LOCAL: 'LOCAL',
  CLOUD: 'CLOUD',
  REMOTE: 'REMOTE',
});

const NODE_STATES = new Set(Object.values(AgentPlanNodeState));
const PLANES = new Set(Object.values(AgentExecutionPlane));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const TERMINAL = new Set([AgentPlanNodeState.VERIFIED, AgentPlanNodeState.FAILED, AgentPlanNodeState.CANCELLED]);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain data object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} cannot contain symbol fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be own data properties`);
    }
    if (!descriptor.enumerable) throw new Error(`${label} cannot contain non-enumerable fields`);
  }
  return value;
}
function exact(raw, allowed, label) {
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error(`${label} contains unknown field: ${String(key)}`);
  }
}
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function text(value, label, { max = 4000, optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  const out = typeof value === 'string' ? value.trim() : '';
  if (!out || out.length > max) throw new Error(`${label} is invalid`);
  return out;
}
function timestamp(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a timestamp string`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return new Date(ms).toISOString();
}
function strictInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function dataArray(value, label, { min = 0, max = 128 } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a canonical array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < min || length > max) {
    throw new Error(`${label} must contain ${min}-${max} items`);
  }
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`${label} contains non-canonical array fields`);
    }
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function uniqueIds(value, label, max = 128) {
  const out = dataArray(value, label, { max }).map((item, index) => id(item, `${label}[${index}]`));
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
}
function uniqueText(value, label, max = 32) {
  const out = dataArray(value, label, { max }).map((item, index) => text(item, `${label}[${index}]`, { max: 1000 }));
  // String#toLowerCase is locale-independent; avoid toLocaleLowerCase host-locale drift.
  if (new Set(out.map(item => item.toLowerCase())).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
}
function frozen(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) frozen(child); return Object.freeze(value); }

function normalizeBudget(raw = {}) {
  object(raw, 'AgentPlan budget');
  exact(raw, new Set(['maxModelCalls', 'maxRuntimeSeconds', 'maxCostUsdMicros']), 'AgentPlan budget');
  return {
    maxModelCalls: strictInteger(raw.maxModelCalls === undefined ? 0 : raw.maxModelCalls, 'AgentPlan budget maxModelCalls', { max: 1_000_000 }),
    maxRuntimeSeconds: strictInteger(raw.maxRuntimeSeconds === undefined ? 0 : raw.maxRuntimeSeconds, 'AgentPlan budget maxRuntimeSeconds', { max: 31_536_000 }),
    maxCostUsdMicros: strictInteger(raw.maxCostUsdMicros === undefined ? 0 : raw.maxCostUsdMicros, 'AgentPlan budget maxCostUsdMicros'),
  };
}

function assertAggregateBudgetWithinEnvelope(nodes, rawEnvelope) {
  object(rawEnvelope, 'AgentPlan extension resourceEnvelope');
  const prototype = Object.getPrototypeOf(rawEnvelope);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('AgentPlan extension resourceEnvelope must be a plain data object');
  const envelope = normalizeBudget(rawEnvelope);
  const fields = ['maxModelCalls', 'maxRuntimeSeconds', 'maxCostUsdMicros'];
  for (const field of fields) {
    const total = nodes.reduce((sum, node) => sum + BigInt(node.budget[field]), 0n);
    if (total > BigInt(envelope[field])) throw new Error(`AgentPlan extension exceeds resourceEnvelope ${field}`);
  }
  return envelope;
}

function normalizeNode(raw) {
  object(raw, 'AgentPlan node');
  exact(raw, new Set(['nodeId', 'title', 'objective', 'dependsOn', 'conflictKeys', 'ownerId', 'executionPlane', 'acceptanceCriteria', 'budget', 'state', 'evidence', 'updatedAt']), 'AgentPlan node');
  const state = raw.state === undefined ? AgentPlanNodeState.PENDING : raw.state;
  if (typeof state !== 'string' || !NODE_STATES.has(state)) throw new Error('AgentPlan node state is invalid');
  return {
    nodeId: id(raw.nodeId, 'AgentPlan nodeId'),
    title: text(raw.title, 'AgentPlan node title', { max: 240 }),
    objective: text(raw.objective, 'AgentPlan node objective', { max: 4000 }),
    dependsOn: uniqueIds(raw.dependsOn === undefined ? [] : raw.dependsOn, 'AgentPlan node dependsOn'),
    conflictKeys: uniqueIds(raw.conflictKeys === undefined ? [] : raw.conflictKeys, 'AgentPlan node conflictKeys'),
    ownerId: raw.ownerId == null || raw.ownerId === '' ? '' : id(raw.ownerId, 'AgentPlan node ownerId'),
    executionPlane: typeof raw.executionPlane === 'string' && PLANES.has(raw.executionPlane) ? raw.executionPlane : (() => { throw new Error('AgentPlan node executionPlane is invalid'); })(),
    acceptanceCriteria: uniqueText(raw.acceptanceCriteria === undefined ? [] : raw.acceptanceCriteria, 'AgentPlan node acceptanceCriteria'),
    budget: normalizeBudget(raw.budget === undefined ? {} : raw.budget),
    state,
    evidence: raw.evidence == null || raw.evidence === '' ? '' : text(raw.evidence, 'AgentPlan node evidence', { max: 8000 }),
    updatedAt: timestamp(raw.updatedAt, 'AgentPlan node updatedAt'),
  };
}

function assertAcyclic(nodes) {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  for (const node of nodes) for (const dependency of node.dependsOn) if (!byId.has(dependency)) throw new Error(`AgentPlan node ${node.nodeId} depends on unknown node ${dependency}`);
  const visiting = new Set(); const visited = new Set();
  const walk = (nodeId) => {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) throw new Error('AgentPlan contains dependency cycle');
    visiting.add(nodeId);
    for (const dependency of byId.get(nodeId).dependsOn) walk(dependency);
    visiting.delete(nodeId); visited.add(nodeId);
  };
  for (const node of nodes) walk(node.nodeId);
}

export function normalizeAgentPlanV1(raw) {
  object(raw, 'AgentPlanV1');
  exact(raw, new Set(['schemaVersion', 'planId', 'jobId', 'objective', 'successCriteria', 'nodes', 'createdAt', 'updatedAt', 'revision']), 'AgentPlanV1');
  if (raw.schemaVersion !== AGENT_PLAN_VERSION) throw new Error('Unsupported AgentPlanV1 schemaVersion');
  const nodes = dataArray(raw.nodes, 'AgentPlan nodes', { min: 1, max: 128 }).map(normalizeNode);
  if (new Set(nodes.map(node => node.nodeId)).size !== nodes.length) throw new Error('AgentPlan contains duplicate nodeId');
  assertAcyclic(nodes);
  const revision = strictInteger(raw.revision, 'AgentPlan revision', { min: 1 });
  return frozen({
    schemaVersion: AGENT_PLAN_VERSION,
    planId: id(raw.planId, 'AgentPlan planId'),
    jobId: id(raw.jobId, 'AgentPlan jobId'),
    objective: text(raw.objective, 'AgentPlan objective', { max: 8000 }),
    successCriteria: uniqueText(raw.successCriteria === undefined ? [] : raw.successCriteria, 'AgentPlan successCriteria'),
    nodes,
    createdAt: timestamp(raw.createdAt, 'AgentPlan createdAt'),
    updatedAt: timestamp(raw.updatedAt, 'AgentPlan updatedAt'),
    revision,
  });
}

/** Derives ready/blocked state from durable node terminals and conflict keys. */
export function reconcileAgentPlanV1(raw, options = {}) {
  object(options, 'AgentPlan reconcile options');
  exact(options, new Set(['at']), 'AgentPlan reconcile options');
  const at = options.at === undefined ? new Date().toISOString() : options.at;
  const plan = structuredClone(normalizeAgentPlanV1(raw));
  const byId = new Map(plan.nodes.map(node => [node.nodeId, node]));
  const runningKeys = new Set(plan.nodes.filter(node => node.state === AgentPlanNodeState.RUNNING).flatMap(node => node.conflictKeys));
  for (const node of plan.nodes) {
    if (TERMINAL.has(node.state) || node.state === AgentPlanNodeState.RUNNING) continue;
    const dependencies = node.dependsOn.map(dependency => byId.get(dependency));
    const dependencyFailed = dependencies.some(dependency => dependency.state === AgentPlanNodeState.FAILED || dependency.state === AgentPlanNodeState.CANCELLED || dependency.state === AgentPlanNodeState.BLOCKED);
    const dependenciesReady = dependencies.every(dependency => dependency.state === AgentPlanNodeState.VERIFIED);
    const conflict = node.conflictKeys.some(key => runningKeys.has(key));
    const nextState = dependencyFailed || conflict ? AgentPlanNodeState.BLOCKED : dependenciesReady ? AgentPlanNodeState.READY : AgentPlanNodeState.PENDING;
    if (node.state !== nextState) { node.state = nextState; node.updatedAt = timestamp(at, 'at'); }
  }
  plan.updatedAt = timestamp(at, 'at'); plan.revision += 1;
  return normalizeAgentPlanV1(plan);
}

/**
 * Appends newly discovered work to an already-live plan without rewriting the
 * existing graph. expectedRevision rejects a stale snapshot presented to this
 * pure transformer; atomic compare-and-save remains the responsibility of the
 * canonical durable plan/store authority and is not implemented here.
 * resourceEnvelope is trusted caller authority (never model-provided):
 * aggregate existing + added node budgets
 * must remain inside that same durable owner/job envelope on every extension.
 */
export function extendAgentPlanV1(raw, options = {}) {
  object(options, 'AgentPlan extension options');
  exact(options, new Set(['expectedRevision', 'nodes', 'resourceEnvelope', 'at']), 'AgentPlan extension options');
  const expectedRevision = options.expectedRevision;
  const nodes = options.nodes;
  const resourceEnvelope = options.resourceEnvelope;
  const at = options.at === undefined ? new Date().toISOString() : options.at;
  const plan = structuredClone(normalizeAgentPlanV1(raw));
  const expected = expectedRevision;
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1) {
    throw new Error('AgentPlan expectedRevision is invalid');
  }
  if (plan.revision !== expected) throw new Error('AgentPlan revision conflict');
  const extensionNodes = dataArray(nodes, 'AgentPlan extension nodes', { min: 1, max: 32 });

  const updatedAt = timestamp(at, 'at');
  const existingIds = new Set(plan.nodes.map(node => node.nodeId));
  const addedIds = new Set();
  const additions = extensionNodes.map((rawNode, index) => {
    object(rawNode, `AgentPlan extension node[${index}]`);
    if (Object.hasOwn(rawNode, 'state') && rawNode.state !== AgentPlanNodeState.PENDING) {
      throw new Error('AgentPlan extension node state must be PENDING');
    }
    if (Object.hasOwn(rawNode, 'evidence') && rawNode.evidence !== undefined && rawNode.evidence !== '') {
      if (typeof rawNode.evidence !== 'string' || rawNode.evidence.trim() !== '') {
        throw new Error('AgentPlan extension node cannot inject evidence');
      }
    }
    // Validate nested budget authority before cloning: structuredClone() can
    // erase an exotic prototype and silently turn malformed budget input into
    // an apparently safe plain object.
    const normalizedBudget = normalizeBudget(rawNode.budget === undefined ? {} : rawNode.budget);
    // rawNode itself is descriptor-checked by object(); preserve the original
    // nested array objects until normalizeNode() validates their canonical
    // dense data descriptors. Cloning here would materialize accessors first.
    const candidate = normalizeNode({
      ...rawNode,
      budget: normalizedBudget,
      state: AgentPlanNodeState.PENDING,
      evidence: '',
      updatedAt,
    });
    if (existingIds.has(candidate.nodeId) || addedIds.has(candidate.nodeId)) throw new Error('AgentPlan extension contains duplicate nodeId');
    addedIds.add(candidate.nodeId);
    return candidate;
  });

  const nextNodes = [...plan.nodes, ...additions];
  assertAggregateBudgetWithinEnvelope(nextNodes, resourceEnvelope);
  plan.nodes = nextNodes;
  plan.updatedAt = updatedAt;
  return reconcileAgentPlanV1(plan, { at: updatedAt });
}

/**
 * Converts a model-proposed full replacement into strict append-only growth.
 * Existing top-level identity and every durable node must be echoed exactly;
 * only a suffix of new PENDING nodes may be introduced.
 */
export function evolveAgentPlanV1(raw, rawCandidate, options = {}) {
  object(options, 'AgentPlan evolution options');
  exact(options, new Set(['resourceEnvelope', 'at']), 'AgentPlan evolution options');
  const resourceEnvelope = options.resourceEnvelope;
  const at = options.at === undefined ? new Date().toISOString() : options.at;
  const current = normalizeAgentPlanV1(raw);
  const candidate = normalizeAgentPlanV1(rawCandidate);
  if (candidate.revision !== current.revision) throw new Error('AgentPlan revision conflict');
  if (candidate.planId !== current.planId || candidate.jobId !== current.jobId || candidate.objective !== current.objective || candidate.createdAt !== current.createdAt) {
    throw new Error('AgentPlan live evolution cannot replace plan identity');
  }
  if (JSON.stringify(candidate.successCriteria) !== JSON.stringify(current.successCriteria)) throw new Error('AgentPlan live evolution cannot replace success criteria');
  if (candidate.nodes.length <= current.nodes.length) throw new Error('AgentPlan live evolution requires appended nodes');
  for (let index = 0; index < current.nodes.length; index += 1) {
    if (JSON.stringify(candidate.nodes[index]) !== JSON.stringify(current.nodes[index])) throw new Error('AgentPlan live evolution cannot replace existing nodes');
  }
  return extendAgentPlanV1(current, {
    expectedRevision: current.revision,
    nodes: candidate.nodes.slice(current.nodes.length),
    resourceEnvelope,
    at,
  });
}

export function transitionAgentPlanNodeV1(raw, options = {}) {
  object(options, 'AgentPlan transition options');
  exact(options, new Set(['nodeId', 'state', 'evidence', 'at']), 'AgentPlan transition options');
  const nodeId = options.nodeId;
  const state = options.state;
  const evidence = options.evidence === undefined ? '' : options.evidence;
  const at = options.at === undefined ? new Date().toISOString() : options.at;
  const plan = structuredClone(normalizeAgentPlanV1(raw));
  const node = plan.nodes.find(item => item.nodeId === nodeId);
  if (!node) throw new Error('AgentPlan node not found');
  const next = state;
  if (typeof next !== 'string' || !NODE_STATES.has(next)) throw new Error('AgentPlan node state is invalid');
  if (TERMINAL.has(node.state)) throw new Error('AgentPlan terminal node cannot be changed');
  if (next === AgentPlanNodeState.RUNNING && node.state !== AgentPlanNodeState.READY) throw new Error('AgentPlan node must be READY before RUNNING');
  if (next === AgentPlanNodeState.VERIFIED && (!text(evidence, 'AgentPlan verified node evidence', { max: 8000 }) || node.state !== AgentPlanNodeState.RUNNING)) throw new Error('AgentPlan VERIFIED requires RUNNING node and evidence');
  node.state = next; node.evidence = next === AgentPlanNodeState.VERIFIED ? text(evidence, 'AgentPlan verified node evidence', { max: 8000 }) : ''; node.updatedAt = timestamp(at, 'at');
  plan.updatedAt = node.updatedAt; plan.revision += 1;
  return reconcileAgentPlanV1(plan, { at: node.updatedAt });
}
