import { validateOrchestrationGraphV1 } from './orchestration-hierarchy.js';

/**
 * Structural admission for owner-controlled subagent creation.
 * Canonical parent depth/fanout facts are derived from the validated durable
 * orchestration graph. Global child/concurrency budgets remain with the
 * canonical resource budget governor; scheduling, persistence and spawning
 * remain elsewhere.
 */
export const SUBAGENT_STRUCTURE_POLICY_VERSION = 1;

export const SubagentSpawnInitiator = Object.freeze({
  OWNER: 'OWNER',
  AGENT: 'AGENT',
});

export const SubagentStructureDecision = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
});

const POLICY_KEYS = new Set([
  'schemaVersion',
  'allowAgentCreatedChildren',
  'maxDepth',
  'maxChildrenPerAgent',
]);

const CAPACITY_REQUEST_KEYS = new Set([
  'policy',
  'initiator',
  'graph',
  'parentNodeId',
]);

const ADMISSION_REQUEST_KEYS = new Set([
  ...CAPACITY_REQUEST_KEYS,
  'requestedChildren',
]);

const MAX_DEPTH = 64;
const MAX_CHILDREN_PER_AGENT = 1000;

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
}

function own(value, key, fallback) {
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function requiredId(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 180 || !/^[A-Za-z0-9._:@/+-]+$/u.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function initiator(value) {
  if (value !== SubagentSpawnInitiator.OWNER && value !== SubagentSpawnInitiator.AGENT) {
    throw new Error('Subagent spawn initiator is invalid');
  }
  return value;
}

export function normalizeSubagentStructurePolicyV1(input = {}) {
  const raw = plainObject(input, 'SubagentStructurePolicyV1');
  exactKeys(raw, POLICY_KEYS, 'SubagentStructurePolicyV1');
  const schemaVersion = own(raw, 'schemaVersion', SUBAGENT_STRUCTURE_POLICY_VERSION);
  if (schemaVersion !== SUBAGENT_STRUCTURE_POLICY_VERSION) throw new Error('Unsupported SubagentStructurePolicyV1 schemaVersion');
  return frozen({
    schemaVersion: SUBAGENT_STRUCTURE_POLICY_VERSION,
    allowAgentCreatedChildren: boolean(own(raw, 'allowAgentCreatedChildren', false), 'allowAgentCreatedChildren'),
    maxDepth: integer(own(raw, 'maxDepth', 0), 'maxDepth', { max: MAX_DEPTH }),
    maxChildrenPerAgent: integer(own(raw, 'maxChildrenPerAgent', 0), 'maxChildrenPerAgent', { max: MAX_CHILDREN_PER_AGENT }),
  });
}

/**
 * Pure trusted-snapshot helper. `graph` MUST already come from the canonical
 * durable orchestration authority. This function validates graph consistency;
 * it does not authenticate caller provenance. Executable admission must use
 * OrchestrationV2Manager.evaluateSelectedSubagentStructureAdmission(), which
 * loads the graph itself and rejects caller-supplied topology.
 */
export function deriveSubagentStructureFactsFromGraphV1({ graph, parentNodeId } = {}) {
  const canonicalGraph = validateOrchestrationGraphV1(graph);
  const parentId = requiredId(parentNodeId, 'parentNodeId');
  const parent = canonicalGraph.nodesById[parentId];
  if (!parent) throw new Error('parentNodeId is not present in canonical orchestration graph');

  let depth = 0;
  let cursor = parent;
  while (cursor.parentId !== null) {
    const next = canonicalGraph.nodesById[cursor.parentId];
    if (!next) throw new Error('Canonical orchestration graph parent is missing');
    depth += 1;
    cursor = next;
  }

  return frozen({
    parentNodeId: parentId,
    parentDepth: depth,
    currentDirectChildren: parent.childIds.length,
  });
}

function normalizedCapacityRequest(input, { includeRequestedChildren }) {
  const raw = plainObject(input || {}, 'SubagentStructureAdmissionRequestV1');
  exactKeys(
    raw,
    includeRequestedChildren ? ADMISSION_REQUEST_KEYS : CAPACITY_REQUEST_KEYS,
    'SubagentStructureAdmissionRequestV1',
  );
  const normalizedPolicy = normalizeSubagentStructurePolicyV1(own(raw, 'policy', {}));
  const normalizedInitiator = initiator(own(raw, 'initiator', undefined));
  const facts = deriveSubagentStructureFactsFromGraphV1({
    graph: own(raw, 'graph', undefined),
    parentNodeId: own(raw, 'parentNodeId', undefined),
  });
  const requestedChildren = includeRequestedChildren
    ? integer(own(raw, 'requestedChildren', undefined), 'requestedChildren', { min: 1, max: MAX_CHILDREN_PER_AGENT })
    : null;
  return { normalizedPolicy, normalizedInitiator, facts, requestedChildren };
}

function capacityFromFacts(normalizedPolicy, normalizedInitiator, facts) {
  const childDepth = facts.parentDepth + 1;
  const agentCreationBlocked = normalizedInitiator === SubagentSpawnInitiator.AGENT
    && !normalizedPolicy.allowAgentCreatedChildren;
  const depthBlocked = childDepth > normalizedPolicy.maxDepth;
  const availableDirectChildren = Math.max(
    0,
    normalizedPolicy.maxChildrenPerAgent - facts.currentDirectChildren,
  );
  return frozen({
    parentNodeId: facts.parentNodeId,
    childDepth,
    agentCreationBlocked,
    depthBlocked,
    availableDirectChildren: agentCreationBlocked || depthBlocked ? 0 : availableDirectChildren,
  });
}

export function remainingSubagentStructureCapacityV1(input = {}) {
  const { normalizedPolicy, normalizedInitiator, facts } = normalizedCapacityRequest(
    input,
    { includeRequestedChildren: false },
  );
  return capacityFromFacts(normalizedPolicy, normalizedInitiator, facts);
}

/**
 * Pure policy evaluator for a trusted canonical graph snapshot. Do not expose
 * this function directly as an untrusted spawn boundary; runtime callers must
 * go through the manager-owned durable-graph admission path.
 */
export function evaluateSubagentStructureAdmissionV1(input = {}) {
  const {
    normalizedPolicy,
    normalizedInitiator,
    facts,
    requestedChildren,
  } = normalizedCapacityRequest(input, { includeRequestedChildren: true });
  const capacity = capacityFromFacts(normalizedPolicy, normalizedInitiator, facts);

  let reasonCode = 'WITHIN_STRUCTURE_POLICY';
  if (capacity.agentCreationBlocked) reasonCode = 'AGENT_CHILD_CREATION_DISABLED';
  else if (capacity.depthBlocked) reasonCode = 'MAX_DEPTH_EXCEEDED';
  else if (requestedChildren > capacity.availableDirectChildren) reasonCode = 'MAX_FANOUT_EXCEEDED';

  return frozen({
    decision: reasonCode === 'WITHIN_STRUCTURE_POLICY'
      ? SubagentStructureDecision.ALLOW
      : SubagentStructureDecision.DENY,
    reasonCode,
    initiator: normalizedInitiator,
    parentNodeId: capacity.parentNodeId,
    requestedChildren,
    childDepth: capacity.childDepth,
    availableDirectChildren: capacity.availableDirectChildren,
    policy: normalizedPolicy,
  });
}
