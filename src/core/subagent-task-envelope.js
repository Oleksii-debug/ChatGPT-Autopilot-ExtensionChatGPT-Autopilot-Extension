import {
  AgentPlanNodeState,
  normalizeAgentPlanV1,
} from './agent-plan.js';
import { normalizeOutcomeContractV1 } from './outcome-contract.js';
import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const SUBAGENT_TASK_ENVELOPE_VERSION = 1;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_REFS = 256;
const INPUT_KEYS = new Set([
  'envelopeId',
  'projectId',
  'parentAgentId',
  'childAgentId',
  'plan',
  'nodeId',
  'inputSourceIds',
  'inputArtifactRefs',
  'outcomeContract',
  'createdAt',
]);
const ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'envelopeId',
  'projectId',
  'parentAgentId',
  'childAgentId',
  'taskId',
  'planId',
  'planRevision',
  'objective',
  'conflictKeys',
  'budget',
  'inputSourceRefs',
  'inputArtifactRefs',
  'outcome',
  'createdAt',
  'executionAuthority',
  'schedulingAuthority',
  'policyAuthority',
  'credentialAuthority',
  'completionAuthority',
]);
const BUDGET_KEYS = new Set(['maxModelCalls', 'maxRuntimeSeconds', 'maxCostUsdMicros']);
const SOURCE_REF_KEYS = new Set(['sourceId', 'location', 'revisionId']);
const OUTCOME_KEYS = new Set([
  'contractId',
  'contractRevision',
  'desiredResult',
  'criterionIds',
  'deliverableIds',
  'verifierId',
  'requiredEvidenceArtifactCount',
]);
const FALSE_AUTHORITY_KEYS = [
  'executionAuthority',
  'schedulingAuthority',
  'policyAuthority',
  'credentialAuthority',
  'completionAuthority',
];

function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(label + ' contains symbol field');
    if (!allowed.has(key)) throw new Error(label + ' contains unknown field: ' + key);
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function own(value, key, label) {
  if (!Object.hasOwn(value, key)) throw new Error(label + ' requires ' + key);
  return value[key];
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(label + ' must be a timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(label + ' must be a timestamp');
  const canonical = new Date(ms).toISOString();
  if (canonical !== value) throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  return canonical;
}

function integer(value, label, min = 0) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function dataArray(value, label, max = MAX_REFS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new Error(label + ' is invalid');
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + ' must be a dense data-only array');
    }
    out.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length) {
      throw new Error(label + ' contains a non-index field');
    }
  }
  return out;
}

function idList(value, label, max = MAX_REFS) {
  const out = dataArray(value, label, max).map((item, index) => id(item, label + '[' + index + ']'));
  if (new Set(out).size !== out.length) throw new Error(label + ' contains duplicates');
  return out;
}

function text(value, label, max = 50_000) {
  if (typeof value !== 'string') throw new Error(label + ' must be text');
  const out = value.trim();
  if (!out || out.length > max) throw new Error(label + ' is invalid');
  return out;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function compareCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeSourceRef(value) {
  const raw = record(value, SOURCE_REF_KEYS, 'SubagentTaskSourceRefV1');
  return {
    sourceId: id(own(raw, 'sourceId', 'SubagentTaskSourceRefV1'), 'inputSourceRef.sourceId'),
    location: text(own(raw, 'location', 'SubagentTaskSourceRefV1'), 'inputSourceRef.location', 8_000),
    revisionId: id(own(raw, 'revisionId', 'SubagentTaskSourceRefV1'), 'inputSourceRef.revisionId'),
  };
}

function sourceRefList(value) {
  const refs = dataArray(value, 'inputSourceRefs').map((item, index) => {
    try {
      return normalizeSourceRef(item);
    } catch (error) {
      throw new Error('inputSourceRefs[' + index + ']: ' + error.message);
    }
  });
  if (new Set(refs.map(item => item.sourceId)).size !== refs.length) {
    throw new Error('inputSourceRefs contains duplicate sourceId');
  }
  return refs.sort((left, right) => compareCodeUnit(left.sourceId, right.sourceId));
}

function artifactRefList(value) {
  const refs = dataArray(value, 'inputArtifactRefs').map((item, index) => {
    try {
      return normalizeArtifactRefV1(item);
    } catch (error) {
      throw new Error('inputArtifactRefs[' + index + ']: ' + error.message);
    }
  });
  if (new Set(refs.map(item => item.artifactId)).size !== refs.length) {
    throw new Error('inputArtifactRefs contains duplicate artifactId');
  }
  for (const ref of refs) {
    if (!ref.sha256) {
      throw new Error('Subagent task input ArtifactRef must carry sha256 immutable identity: ' + ref.artifactId);
    }
  }
  return refs.sort((left, right) => compareCodeUnit(left.artifactId, right.artifactId));
}

function normalizeBudget(value) {
  const raw = record(value, BUDGET_KEYS, 'SubagentTaskBudgetV1');
  return {
    maxModelCalls: integer(own(raw, 'maxModelCalls', 'SubagentTaskBudgetV1'), 'budget.maxModelCalls'),
    maxRuntimeSeconds: integer(own(raw, 'maxRuntimeSeconds', 'SubagentTaskBudgetV1'), 'budget.maxRuntimeSeconds'),
    maxCostUsdMicros: integer(own(raw, 'maxCostUsdMicros', 'SubagentTaskBudgetV1'), 'budget.maxCostUsdMicros'),
  };
}

function normalizeOutcomeBinding(value) {
  const raw = record(value, OUTCOME_KEYS, 'SubagentTaskOutcomeBindingV1');
  const criterionIds = idList(
    own(raw, 'criterionIds', 'SubagentTaskOutcomeBindingV1'),
    'outcome.criterionIds',
    128,
  ).sort(compareCodeUnit);
  const deliverableIds = idList(
    own(raw, 'deliverableIds', 'SubagentTaskOutcomeBindingV1'),
    'outcome.deliverableIds',
    128,
  ).sort(compareCodeUnit);
  if (!criterionIds.length) throw new Error('Subagent task outcome requires completion criteria');
  if (!deliverableIds.length) throw new Error('Subagent task outcome requires deliverables');
  return {
    contractId: id(own(raw, 'contractId', 'SubagentTaskOutcomeBindingV1'), 'outcome.contractId'),
    contractRevision: integer(
      own(raw, 'contractRevision', 'SubagentTaskOutcomeBindingV1'),
      'outcome.contractRevision',
      1,
    ),
    desiredResult: text(
      own(raw, 'desiredResult', 'SubagentTaskOutcomeBindingV1'),
      'outcome.desiredResult',
    ),
    criterionIds,
    deliverableIds,
    verifierId: id(own(raw, 'verifierId', 'SubagentTaskOutcomeBindingV1'), 'outcome.verifierId'),
    requiredEvidenceArtifactCount: integer(
      own(raw, 'requiredEvidenceArtifactCount', 'SubagentTaskOutcomeBindingV1'),
      'outcome.requiredEvidenceArtifactCount',
      1,
    ),
  };
}

function assertOutcomeWithinTaskBudget(nodeBudget, outcomeBudget) {
  for (const key of ['maxModelCalls', 'maxRuntimeSeconds', 'maxCostUsdMicros']) {
    if (outcomeBudget[key] > nodeBudget[key]) {
      throw new Error('OutcomeContract budget exceeds child task budget: ' + key);
    }
  }
}

function assertAcceptanceCoverage(nodeCriteria, outcomeCriteria) {
  if (!nodeCriteria.length) return;
  const descriptions = new Set(outcomeCriteria.map(item => item.description));
  for (const criterion of nodeCriteria) {
    if (!descriptions.has(criterion)) {
      throw new Error('OutcomeContract does not cover AgentPlan acceptance criterion: ' + criterion);
    }
  }
}

function sourceRefsForIds(inputSourceIds, outcome) {
  const byId = new Map(outcome.sourceTruth.map(item => [item.sourceId, item]));
  return inputSourceIds.map(sourceId => {
    const source = byId.get(sourceId);
    if (!source) {
      throw new Error('Subagent task input source is not bound to OutcomeContract sourceTruth: ' + sourceId);
    }
    return {
      sourceId: source.sourceId,
      location: source.location,
      revisionId: source.revisionId,
    };
  });
}

export function normalizeSubagentTaskEnvelopeV1(input) {
  const raw = record(input, ENVELOPE_KEYS, 'SubagentTaskEnvelopeV1');
  if (own(raw, 'schemaVersion', 'SubagentTaskEnvelopeV1') !== SUBAGENT_TASK_ENVELOPE_VERSION) {
    throw new Error('Unsupported SubagentTaskEnvelopeV1 schemaVersion');
  }
  const parentAgentId = id(own(raw, 'parentAgentId', 'SubagentTaskEnvelopeV1'), 'parentAgentId');
  const childAgentId = id(own(raw, 'childAgentId', 'SubagentTaskEnvelopeV1'), 'childAgentId');
  if (parentAgentId === childAgentId) throw new Error('Subagent task child identity must differ from parent');

  for (const key of FALSE_AUTHORITY_KEYS) {
    if (own(raw, key, 'SubagentTaskEnvelopeV1') !== false) {
      throw new Error('SubagentTaskEnvelopeV1 cannot grant ' + key);
    }
  }

  return freezeDeep({
    schemaVersion: SUBAGENT_TASK_ENVELOPE_VERSION,
    envelopeId: id(own(raw, 'envelopeId', 'SubagentTaskEnvelopeV1'), 'envelopeId'),
    projectId: id(own(raw, 'projectId', 'SubagentTaskEnvelopeV1'), 'projectId'),
    parentAgentId,
    childAgentId,
    taskId: id(own(raw, 'taskId', 'SubagentTaskEnvelopeV1'), 'taskId'),
    planId: id(own(raw, 'planId', 'SubagentTaskEnvelopeV1'), 'planId'),
    planRevision: integer(own(raw, 'planRevision', 'SubagentTaskEnvelopeV1'), 'planRevision', 1),
    objective: text(own(raw, 'objective', 'SubagentTaskEnvelopeV1'), 'objective', 8_000),
    conflictKeys: idList(
      own(raw, 'conflictKeys', 'SubagentTaskEnvelopeV1'),
      'conflictKeys',
      128,
    ),
    budget: normalizeBudget(own(raw, 'budget', 'SubagentTaskEnvelopeV1')),
    inputSourceRefs: sourceRefList(
      own(raw, 'inputSourceRefs', 'SubagentTaskEnvelopeV1'),
    ),
    inputArtifactRefs: artifactRefList(
      own(raw, 'inputArtifactRefs', 'SubagentTaskEnvelopeV1'),
    ),
    outcome: normalizeOutcomeBinding(own(raw, 'outcome', 'SubagentTaskEnvelopeV1')),
    createdAt: timestamp(own(raw, 'createdAt', 'SubagentTaskEnvelopeV1'), 'createdAt'),
    executionAuthority: false,
    schedulingAuthority: false,
    policyAuthority: false,
    credentialAuthority: false,
    completionAuthority: false,
  });
}

/**
 * Bind one canonical AgentPlan node to one child Agent task.
 *
 * This is a pure, non-authorizing contract. It does not assign the child,
 * schedule work, reserve capacity, execute tools, authenticate owner policy,
 * or verify completion. Those remain responsibilities of the existing
 * canonical control plane.
 */
export function createSubagentTaskEnvelopeV1(input = {}) {
  const raw = record(input, INPUT_KEYS, 'SubagentTaskEnvelopeBuildV1');
  const plan = normalizeAgentPlanV1(own(raw, 'plan', 'SubagentTaskEnvelopeBuildV1'));
  const projectId = id(own(raw, 'projectId', 'SubagentTaskEnvelopeBuildV1'), 'projectId');
  const parentAgentId = id(own(raw, 'parentAgentId', 'SubagentTaskEnvelopeBuildV1'), 'parentAgentId');
  const childAgentId = id(own(raw, 'childAgentId', 'SubagentTaskEnvelopeBuildV1'), 'childAgentId');
  if (parentAgentId === childAgentId) throw new Error('Subagent task child identity must differ from parent');

  const nodeId = id(own(raw, 'nodeId', 'SubagentTaskEnvelopeBuildV1'), 'nodeId');
  const node = plan.nodes.find(item => item.nodeId === nodeId);
  if (!node) throw new Error('Subagent task AgentPlan node not found');
  if (![AgentPlanNodeState.READY, AgentPlanNodeState.RUNNING].includes(node.state)) {
    throw new Error('Subagent task AgentPlan node must be READY or RUNNING');
  }
  if (node.ownerId !== childAgentId) {
    throw new Error('Subagent task requires exact AgentPlan node owner binding');
  }

  const outcome = normalizeOutcomeContractV1(
    own(raw, 'outcomeContract', 'SubagentTaskEnvelopeBuildV1'),
  );
  if (outcome.projectId !== projectId) {
    throw new Error('Subagent task OutcomeContract project mismatch');
  }
  if (outcome.verifierPlan.actorId !== childAgentId) {
    throw new Error('Subagent task OutcomeContract actor must be the exact child Agent');
  }

  assertOutcomeWithinTaskBudget(node.budget, outcome.budgetBoundaries);
  assertAcceptanceCoverage(node.acceptanceCriteria, outcome.completionCriteria);

  const inputSourceIds = idList(
    own(raw, 'inputSourceIds', 'SubagentTaskEnvelopeBuildV1'),
    'inputSourceIds',
  ).sort(compareCodeUnit);
  const inputSourceRefs = sourceRefsForIds(inputSourceIds, outcome);
  const inputArtifactRefs = artifactRefList(
    own(raw, 'inputArtifactRefs', 'SubagentTaskEnvelopeBuildV1'),
  );

  const createdAt = timestamp(
    own(raw, 'createdAt', 'SubagentTaskEnvelopeBuildV1'),
    'createdAt',
  );
  if (Date.parse(createdAt) < Date.parse(plan.updatedAt)) {
    throw new Error('Subagent task envelope cannot predate AgentPlan revision');
  }
  if (Date.parse(createdAt) < Date.parse(node.updatedAt)) {
    throw new Error('Subagent task envelope cannot predate AgentPlan node state');
  }
  if (Date.parse(createdAt) < Date.parse(outcome.createdAt)) {
    throw new Error('Subagent task envelope cannot predate OutcomeContract');
  }
  for (const artifactRef of inputArtifactRefs) {
    if (Date.parse(artifactRef.createdAt) > Date.parse(createdAt)) {
      throw new Error('Subagent task input ArtifactRef cannot postdate envelope: ' + artifactRef.artifactId);
    }
  }

  return normalizeSubagentTaskEnvelopeV1({
    schemaVersion: SUBAGENT_TASK_ENVELOPE_VERSION,
    envelopeId: id(own(raw, 'envelopeId', 'SubagentTaskEnvelopeBuildV1'), 'envelopeId'),
    projectId,
    parentAgentId,
    childAgentId,
    taskId: node.nodeId,
    planId: plan.planId,
    planRevision: plan.revision,
    objective: node.objective,
    conflictKeys: [...node.conflictKeys],
    budget: { ...node.budget },
    inputSourceRefs,
    inputArtifactRefs,
    outcome: {
      contractId: outcome.contractId,
      contractRevision: outcome.revision,
      desiredResult: outcome.desiredResult,
      criterionIds: outcome.completionCriteria.map(item => item.criterionId),
      deliverableIds: outcome.deliverables.map(item => item.deliverableId),
      verifierId: outcome.verifierPlan.verifierId,
      requiredEvidenceArtifactCount: outcome.verifierPlan.requiredEvidenceArtifactCount,
    },
    createdAt,
    executionAuthority: false,
    schedulingAuthority: false,
    policyAuthority: false,
    credentialAuthority: false,
    completionAuthority: false,
  });
}
