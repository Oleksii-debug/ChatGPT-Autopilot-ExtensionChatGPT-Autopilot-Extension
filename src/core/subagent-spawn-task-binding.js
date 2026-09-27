import {
  SubagentSpawnAuthorityBindingDecision,
  bindSubagentSpawnAuthorityV1,
} from './subagent-spawn-authority-binding.js';
import { createSubagentTaskEnvelopeV1 } from './subagent-task-envelope.js';

export const SUBAGENT_SPAWN_TASK_BINDING_VERSION = 1;

export const SubagentSpawnTaskBindingDecision = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
});

const INPUT_KEYS = new Set([
  'authorityRequest',
  'plan',
  'taskEnvelopes',
  'priorTaskEnvelopeBindings',
]);

const TASK_ENVELOPE_SPEC_KEYS = new Set([
  'taskId',
  'envelopeId',
  'inputSourceIds',
  'inputArtifactRefs',
  'outcomeContract',
  'createdAt',
]);

const PRIOR_TASK_ENVELOPE_BINDING_KEYS = new Set([
  'childNodeId',
  'taskId',
  'envelopeId',
  'planId',
  'planRevision',
  'outcomeContractId',
  'outcomeContractRevision',
  'createdAt',
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_TASKS = 200;

function strictRecord(value, allowed, label) {
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
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
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

function requiredId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function dataArray(value, label, max = MAX_TASKS) {
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
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
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

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function denied(reasonCode, details = {}) {
  return freezeDeep({
    schemaVersion: SUBAGENT_SPAWN_TASK_BINDING_VERSION,
    decision: SubagentSpawnTaskBindingDecision.DENY,
    reasonCode,
    createdNodeIds: [],
    authorityBindings: [],
    authorityTaskBindings: [],
    taskBindings: [],
    taskEnvelopeBindings: [],
    activationRequests: [],
    activationAuthority: false,
    executionAuthority: false,
    credentialAuthority: false,
    policyAuthority: false,
    persistenceAuthority: false,
    schedulingAuthority: false,
    completionAuthority: false,
    verificationAuthority: false,
    ...details,
  });
}

function nonNegativeRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || Object.is(value, -0)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function normalizePriorTaskEnvelopeBindings(value) {
  const bindings = dataArray(value, 'priorTaskEnvelopeBindings').map((item, index) => {
    const label = 'priorTaskEnvelopeBindings[' + index + ']';
    const raw = strictRecord(item, PRIOR_TASK_ENVELOPE_BINDING_KEYS, label);
    return {
      childNodeId: requiredId(own(raw, 'childNodeId', label), label + '.childNodeId'),
      taskId: requiredId(own(raw, 'taskId', label), label + '.taskId'),
      envelopeId: requiredId(own(raw, 'envelopeId', label), label + '.envelopeId'),
      planId: requiredId(own(raw, 'planId', label), label + '.planId'),
      planRevision: nonNegativeRevision(
        own(raw, 'planRevision', label),
        label + '.planRevision',
      ),
      outcomeContractId: requiredId(
        own(raw, 'outcomeContractId', label),
        label + '.outcomeContractId',
      ),
      outcomeContractRevision: nonNegativeRevision(
        own(raw, 'outcomeContractRevision', label),
        label + '.outcomeContractRevision',
      ),
      createdAt: canonicalBindingTimestamp(
        own(raw, 'createdAt', label),
        label + '.createdAt',
      ),
    };
  });

  const children = bindings.map(item => item.childNodeId);
  const tasks = bindings.map(item => item.taskId);
  const envelopes = bindings.map(item => item.envelopeId);
  if (new Set(children).size !== children.length) {
    throw new Error('priorTaskEnvelopeBindings contains duplicate childNodeId');
  }
  if (new Set(tasks).size !== tasks.length) {
    throw new Error('priorTaskEnvelopeBindings contains duplicate taskId');
  }
  if (new Set(envelopes).size !== envelopes.length) {
    throw new Error('priorTaskEnvelopeBindings contains duplicate envelopeId');
  }
  return bindings;
}

function canonicalBindingTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error(label + ' is invalid');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function taskEnvelopeBinding(taskEnvelope) {
  return {
    childNodeId: taskEnvelope.childAgentId,
    taskId: taskEnvelope.taskId,
    envelopeId: taskEnvelope.envelopeId,
    planId: taskEnvelope.planId,
    planRevision: taskEnvelope.planRevision,
    outcomeContractId: taskEnvelope.outcome.contractId,
    outcomeContractRevision: taskEnvelope.outcome.contractRevision,
    createdAt: taskEnvelope.createdAt,
  };
}

function exactTaskEnvelopeBindingMatch(current, prior) {
  if (current.length !== prior.length) return false;
  const priorByChild = new Map(prior.map(item => [item.childNodeId, item]));
  return current.every(item => {
    const expected = priorByChild.get(item.childNodeId);
    return expected
      && item.taskId === expected.taskId
      && item.envelopeId === expected.envelopeId
      && item.planId === expected.planId
      && item.planRevision === expected.planRevision
      && item.outcomeContractId === expected.outcomeContractId
      && item.outcomeContractRevision === expected.outcomeContractRevision
      && item.createdAt === expected.createdAt;
  });
}

function normalizeTaskEnvelopeSpecs(value) {
  const specs = dataArray(value, 'taskEnvelopes').map((item, index) => {
    const raw = strictRecord(
      item,
      TASK_ENVELOPE_SPEC_KEYS,
      'taskEnvelopes[' + index + ']',
    );
    return {
      raw,
      taskId: requiredId(
        own(raw, 'taskId', 'taskEnvelopes[' + index + ']'),
        'taskEnvelopes[' + index + '].taskId',
      ),
      envelopeId: requiredId(
        own(raw, 'envelopeId', 'taskEnvelopes[' + index + ']'),
        'taskEnvelopes[' + index + '].envelopeId',
      ),
    };
  });

  const taskIds = specs.map(item => item.taskId);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error('taskEnvelopes contains duplicate taskId');
  }
  const envelopeIds = specs.map(item => item.envelopeId);
  if (new Set(envelopeIds).size !== envelopeIds.length) {
    throw new Error('taskEnvelopes contains duplicate envelopeId');
  }

  return new Map(specs.map(item => [item.taskId, item]));
}

/**
 * Compose canonical subagent topology, least-authority context/tools and the
 * concrete AgentPlan/OutcomeContract task envelope.
 *
 * Parent and child Agent identities are never accepted from task-envelope
 * specs. They are derived from bindSubagentSpawnAuthorityV1, which itself
 * derives them from canonical topology mutation. This layer is pure and grants
 * no persistence, scheduling, activation, execution, completion or verifier
 * authority.
 */
export function bindSubagentSpawnTaskAuthorityV1(input = {}) {
  const request = strictRecord(
    input,
    INPUT_KEYS,
    'SubagentSpawnTaskBindingRequestV1',
  );
  const taskEnvelopeSpecs = normalizeTaskEnvelopeSpecs(
    own(request, 'taskEnvelopes', 'SubagentSpawnTaskBindingRequestV1'),
  );

  const authority = bindSubagentSpawnAuthorityV1(
    own(request, 'authorityRequest', 'SubagentSpawnTaskBindingRequestV1'),
  );
  if (authority.decision !== SubagentSpawnAuthorityBindingDecision.ALLOW) {
    return denied('SPAWN_AUTHORITY_DENIED', {
      projectId: authority.projectId,
      authorityReasonCode: authority.reasonCode,
    });
  }

  if (taskEnvelopeSpecs.size !== authority.authorityBindings.length) {
    return denied('TASK_ENVELOPE_COUNT_MISMATCH', {
      projectId: authority.projectId,
      parentNodeId: authority.parentNodeId,
      spawnId: authority.spawnId,
      expectedTaskEnvelopeCount: authority.authorityBindings.length,
      actualTaskEnvelopeCount: taskEnvelopeSpecs.size,
    });
  }

  const taskBindings = [];
  const taskEnvelopeBindings = [];
  for (const binding of authority.authorityBindings) {
    const spec = taskEnvelopeSpecs.get(binding.taskId);
    if (!spec) {
      return denied('TASK_ENVELOPE_MISSING', {
        projectId: authority.projectId,
        parentNodeId: authority.parentNodeId,
        spawnId: authority.spawnId,
        deniedChildNodeId: binding.childNodeId,
        deniedTaskId: binding.taskId,
      });
    }

    let taskEnvelope;
    try {
      taskEnvelope = createSubagentTaskEnvelopeV1({
        envelopeId: spec.envelopeId,
        projectId: authority.projectId,
        parentAgentId: authority.parentNodeId,
        childAgentId: binding.childNodeId,
        plan: own(request, 'plan', 'SubagentSpawnTaskBindingRequestV1'),
        nodeId: binding.taskId,
        inputSourceIds: own(spec.raw, 'inputSourceIds', 'taskEnvelopeSpec'),
        inputArtifactRefs: own(spec.raw, 'inputArtifactRefs', 'taskEnvelopeSpec'),
        outcomeContract: own(spec.raw, 'outcomeContract', 'taskEnvelopeSpec'),
        createdAt: own(spec.raw, 'createdAt', 'taskEnvelopeSpec'),
      });
    } catch {
      return denied('TASK_ENVELOPE_REJECTED', {
        projectId: authority.projectId,
        parentNodeId: authority.parentNodeId,
        spawnId: authority.spawnId,
        deniedChildNodeId: binding.childNodeId,
        deniedTaskId: binding.taskId,
      });
    }

    const allowedSourceIds = new Set(binding.authorityEnvelope.sourceIds);
    const allowedArtifactIds = new Set(binding.authorityEnvelope.artifactIds);
    const sourceDrift = taskEnvelope.inputSourceRefs.some(
      item => !allowedSourceIds.has(item.sourceId),
    );
    const artifactDrift = taskEnvelope.inputArtifactRefs.some(
      item => !allowedArtifactIds.has(item.artifactId),
    );
    if (sourceDrift || artifactDrift) {
      return denied('TASK_INPUT_AUTHORITY_DRIFT', {
        projectId: authority.projectId,
        parentNodeId: authority.parentNodeId,
        spawnId: authority.spawnId,
        deniedChildNodeId: binding.childNodeId,
        deniedTaskId: binding.taskId,
      });
    }

    taskBindings.push({
      childNodeId: binding.childNodeId,
      taskId: binding.taskId,
      providerId: binding.providerId,
      authorityEnvelope: binding.authorityEnvelope,
      taskEnvelope,
    });
    taskEnvelopeBindings.push(taskEnvelopeBinding(taskEnvelope));
  }

  const hasPriorTaskEnvelopeBindings = Object.hasOwn(
    request,
    'priorTaskEnvelopeBindings',
  );
  if (authority.reused) {
    if (!hasPriorTaskEnvelopeBindings) {
      return denied('REPLAY_TASK_ENVELOPE_BINDING_EVIDENCE_REQUIRED', {
        projectId: authority.projectId,
        parentNodeId: authority.parentNodeId,
        spawnId: authority.spawnId,
      });
    }
    const priorTaskEnvelopeBindings = normalizePriorTaskEnvelopeBindings(
      own(
        request,
        'priorTaskEnvelopeBindings',
        'SubagentSpawnTaskBindingRequestV1',
      ),
    );
    if (!exactTaskEnvelopeBindingMatch(
      taskEnvelopeBindings,
      priorTaskEnvelopeBindings,
    )) {
      return denied('REPLAY_TASK_ENVELOPE_BINDING_MISMATCH', {
        projectId: authority.projectId,
        parentNodeId: authority.parentNodeId,
        spawnId: authority.spawnId,
      });
    }
  } else if (hasPriorTaskEnvelopeBindings) {
    return denied('UNEXPECTED_PRIOR_TASK_ENVELOPE_BINDING_EVIDENCE', {
      projectId: authority.projectId,
      parentNodeId: authority.parentNodeId,
      spawnId: authority.spawnId,
    });
  }

  return freezeDeep({
    schemaVersion: SUBAGENT_SPAWN_TASK_BINDING_VERSION,
    decision: SubagentSpawnTaskBindingDecision.ALLOW,
    reasonCode: 'SUBAGENT_SPAWN_TASK_AUTHORITY_BOUND',
    projectId: authority.projectId,
    parentNodeId: authority.parentNodeId,
    spawnId: authority.spawnId,
    reused: authority.reused,
    createdNodeIds: [...authority.createdNodeIds],
    authorityBindings: [...authority.authorityBindings],
    authorityTaskBindings: authority.taskBindings.map(item => ({ ...item })),
    taskBindings,
    taskEnvelopeBindings,
    graph: authority.graph,
    runtime: authority.runtime,
    activationRequests: [...authority.activationRequests],
    activationAuthority: false,
    executionAuthority: false,
    credentialAuthority: false,
    policyAuthority: false,
    persistenceAuthority: false,
    schedulingAuthority: false,
    completionAuthority: false,
    verificationAuthority: false,
  });
}
