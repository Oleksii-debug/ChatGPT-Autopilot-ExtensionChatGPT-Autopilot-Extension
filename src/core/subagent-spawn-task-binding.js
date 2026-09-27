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

const REQUEST_KEYS = new Set(['spawnAuthorityRequest', 'taskEnvelopeSpecs']);
const SPEC_KEYS = new Set([
  'taskId',
  'envelopeId',
  'plan',
  'nodeId',
  'inputSourceIds',
  'inputArtifactRefs',
  'outcomeContract',
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

function exactId(value, label) {
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
  if (!Number.isSafeInteger(length) || Object.is(length, -0) || length < 0 || length > max) {
    throw new Error(label + ' has invalid length');
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

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function exactSetEqual(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return rightSet.size === right.length && left.every(item => rightSet.has(item));
}

function denied(reasonCode, details = {}) {
  return freezeDeep({
    schemaVersion: SUBAGENT_SPAWN_TASK_BINDING_VERSION,
    decision: SubagentSpawnTaskBindingDecision.DENY,
    reasonCode,
    createdNodeIds: [],
    authorityBindings: [],
    taskBindings: [],
    taskEnvelopes: [],
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

function normalizeSpecs(value) {
  const specs = dataArray(value, 'taskEnvelopeSpecs').map((item, index) => {
    const raw = strictRecord(item, SPEC_KEYS, 'taskEnvelopeSpecs[' + index + ']');
    const taskId = exactId(
      own(raw, 'taskId', 'taskEnvelopeSpecs[' + index + ']'),
      'taskEnvelopeSpecs[' + index + '].taskId',
    );
    const nodeId = exactId(
      own(raw, 'nodeId', 'taskEnvelopeSpecs[' + index + ']'),
      'taskEnvelopeSpecs[' + index + '].nodeId',
    );
    if (nodeId !== taskId) {
      throw new Error('taskEnvelopeSpecs[' + index + '] nodeId must equal taskId');
    }
    return { raw, taskId };
  });
  const taskIds = specs.map(item => item.taskId);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error('taskEnvelopeSpecs contains duplicate taskId');
  }
  return specs;
}

/**
 * Compose canonical spawn/least-authority output with immutable child task
 * envelopes without accepting parent/child identity aliases from task specs.
 *
 * This function is pure. It does not persist topology, activate children,
 * execute tools, authenticate policy, schedule work, verify results, or commit
 * completion. The existing Orchestration owner remains the sole runtime owner.
 */
export function bindSubagentSpawnTaskAuthorityV1(input = {}) {
  const request = strictRecord(input, REQUEST_KEYS, 'SubagentSpawnTaskBindingRequestV1');
  const specs = normalizeSpecs(
    own(request, 'taskEnvelopeSpecs', 'SubagentSpawnTaskBindingRequestV1'),
  );
  const spawn = bindSubagentSpawnAuthorityV1(
    own(request, 'spawnAuthorityRequest', 'SubagentSpawnTaskBindingRequestV1'),
  );

  if (spawn.decision !== SubagentSpawnAuthorityBindingDecision.ALLOW) {
    return denied('SPAWN_AUTHORITY_DENIED', {
      spawnReasonCode: spawn.reasonCode,
    });
  }
  if (specs.length !== spawn.taskBindings.length) {
    return denied('TASK_ENVELOPE_SPEC_COUNT_MISMATCH', {
      projectId: spawn.projectId,
      parentNodeId: spawn.parentNodeId,
      spawnId: spawn.spawnId,
      expectedTaskEnvelopeSpecCount: spawn.taskBindings.length,
      actualTaskEnvelopeSpecCount: specs.length,
    });
  }

  const specsByTaskId = new Map(specs.map(item => [item.taskId, item.raw]));
  const authorityByTaskId = new Map(
    spawn.authorityBindings.map(item => [item.taskId, item]),
  );
  const envelopes = [];

  for (const taskBinding of spawn.taskBindings) {
    const spec = specsByTaskId.get(taskBinding.taskId);
    const authorityBinding = authorityByTaskId.get(taskBinding.taskId);
    if (!spec || !authorityBinding || authorityBinding.childNodeId !== taskBinding.childNodeId) {
      return denied('TASK_AUTHORITY_BINDING_MISSING', {
        projectId: spawn.projectId,
        parentNodeId: spawn.parentNodeId,
        spawnId: spawn.spawnId,
        deniedTaskId: taskBinding.taskId,
        deniedChildNodeId: taskBinding.childNodeId,
      });
    }

    const envelope = createSubagentTaskEnvelopeV1({
      envelopeId: own(spec, 'envelopeId', 'taskEnvelopeSpec'),
      projectId: spawn.projectId,
      parentAgentId: spawn.parentNodeId,
      childAgentId: taskBinding.childNodeId,
      plan: own(spec, 'plan', 'taskEnvelopeSpec'),
      nodeId: taskBinding.taskId,
      inputSourceIds: own(spec, 'inputSourceIds', 'taskEnvelopeSpec'),
      inputArtifactRefs: own(spec, 'inputArtifactRefs', 'taskEnvelopeSpec'),
      outcomeContract: own(spec, 'outcomeContract', 'taskEnvelopeSpec'),
      createdAt: own(spec, 'createdAt', 'taskEnvelopeSpec'),
    });

    const envelopeSourceIds = envelope.inputSourceRefs.map(ref => ref.sourceId);
    const envelopeArtifactIds = envelope.inputArtifactRefs.map(ref => ref.artifactId);
    if (!exactSetEqual(envelopeSourceIds, taskBinding.taskSourceIds)
        || !exactSetEqual(envelopeSourceIds, authorityBinding.authorityEnvelope.sourceIds)) {
      return denied('TASK_SOURCE_AUTHORITY_MISMATCH', {
        projectId: spawn.projectId,
        parentNodeId: spawn.parentNodeId,
        spawnId: spawn.spawnId,
        deniedTaskId: taskBinding.taskId,
        deniedChildNodeId: taskBinding.childNodeId,
      });
    }
    if (!exactSetEqual(envelopeArtifactIds, taskBinding.taskArtifactIds)
        || !exactSetEqual(envelopeArtifactIds, authorityBinding.authorityEnvelope.artifactIds)) {
      return denied('TASK_ARTIFACT_AUTHORITY_MISMATCH', {
        projectId: spawn.projectId,
        parentNodeId: spawn.parentNodeId,
        spawnId: spawn.spawnId,
        deniedTaskId: taskBinding.taskId,
        deniedChildNodeId: taskBinding.childNodeId,
      });
    }

    envelopes.push(envelope);
  }

  return freezeDeep({
    schemaVersion: SUBAGENT_SPAWN_TASK_BINDING_VERSION,
    decision: SubagentSpawnTaskBindingDecision.ALLOW,
    reasonCode: 'SUBAGENT_SPAWN_TASK_AUTHORITY_BOUND',
    projectId: spawn.projectId,
    parentNodeId: spawn.parentNodeId,
    spawnId: spawn.spawnId,
    reused: spawn.reused,
    createdNodeIds: [...spawn.createdNodeIds],
    authorityBindings: spawn.authorityBindings,
    taskBindings: spawn.taskBindings,
    taskEnvelopes: envelopes,
    graph: spawn.graph,
    runtime: spawn.runtime,
    activationRequests: [...spawn.activationRequests],
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
