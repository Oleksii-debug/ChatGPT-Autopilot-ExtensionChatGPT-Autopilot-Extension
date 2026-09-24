/**
 * Pure structural admission for owner-controlled subagent creation.
 * Global child/concurrency budgets remain with the canonical resource budget
 * governor; scheduling, persistence and worker spawning remain elsewhere.
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

export function remainingSubagentStructureCapacityV1({
  policy,
  initiator: initiatorInput,
  parentDepth,
  currentDirectChildren,
} = {}) {
  const normalizedPolicy = normalizeSubagentStructurePolicyV1(policy);
  const normalizedInitiator = initiator(initiatorInput);
  const depth = integer(parentDepth, 'parentDepth', { max: MAX_DEPTH });
  const children = integer(currentDirectChildren, 'currentDirectChildren', { max: MAX_CHILDREN_PER_AGENT });
  const childDepth = depth + 1;
  const agentCreationBlocked = normalizedInitiator === SubagentSpawnInitiator.AGENT
    && !normalizedPolicy.allowAgentCreatedChildren;
  const depthBlocked = childDepth > normalizedPolicy.maxDepth;
  const availableDirectChildren = Math.max(0, normalizedPolicy.maxChildrenPerAgent - children);
  return frozen({
    childDepth,
    agentCreationBlocked,
    depthBlocked,
    availableDirectChildren: agentCreationBlocked || depthBlocked ? 0 : availableDirectChildren,
  });
}

export function evaluateSubagentStructureAdmissionV1({
  policy,
  initiator: initiatorInput,
  parentDepth,
  currentDirectChildren,
  requestedChildren,
} = {}) {
  const normalizedPolicy = normalizeSubagentStructurePolicyV1(policy);
  const normalizedInitiator = initiator(initiatorInput);
  const requested = integer(requestedChildren, 'requestedChildren', { min: 1, max: MAX_CHILDREN_PER_AGENT });
  const capacity = remainingSubagentStructureCapacityV1({
    policy: normalizedPolicy,
    initiator: normalizedInitiator,
    parentDepth,
    currentDirectChildren,
  });

  let reasonCode = 'WITHIN_STRUCTURE_POLICY';
  if (capacity.agentCreationBlocked) reasonCode = 'AGENT_CHILD_CREATION_DISABLED';
  else if (capacity.depthBlocked) reasonCode = 'MAX_DEPTH_EXCEEDED';
  else if (requested > capacity.availableDirectChildren) reasonCode = 'MAX_FANOUT_EXCEEDED';

  return frozen({
    decision: reasonCode === 'WITHIN_STRUCTURE_POLICY'
      ? SubagentStructureDecision.ALLOW
      : SubagentStructureDecision.DENY,
    reasonCode,
    initiator: normalizedInitiator,
    requestedChildren: requested,
    childDepth: capacity.childDepth,
    availableDirectChildren: capacity.availableDirectChildren,
    policy: normalizedPolicy,
  });
}
