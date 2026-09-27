import {
  SubagentAuthorityDecision,
  deriveSubagentAuthorityEnvelopeV1,
} from './subagent-authority-envelope.js';
import {
  SubagentTopologyMutationDecision,
  mutateOrchestrationSubagentTopologyV1,
} from './subagent-topology-mutation.js';

export const SUBAGENT_SPAWN_AUTHORITY_BINDING_VERSION = 1;

export const SubagentSpawnAuthorityBindingDecision = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
});

const REQUEST_KEYS = new Set([
  'topologyRequest',
  'projectId',
  'parentProviderIds',
  'ownerAllowedProviderIds',
  'providerCapabilities',
  'parentCapabilityIds',
  'ownerAllowedCapabilityIds',
  'parentSourceIds',
  'ownerAllowedSourceIds',
  'parentArtifactIds',
  'ownerAllowedArtifactIds',
  'parentToolIds',
  'ownerAllowedToolIds',
  'parentToolDescriptors',
  'childTasks',
]);

const TASK_KEYS = new Set([
  'taskId',
  'providerId',
  'taskRequestedCapabilityIds',
  'taskSourceIds',
  'taskArtifactIds',
  'requestedToolIds',
]);

const PROVIDER_CAPABILITY_KEYS = new Set([
  'providerId',
  'capabilityIds',
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_CHILD_TASKS = 200;
const MAX_LIST = 256;

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function own(value, key) {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function dataArray(value, label, max = MAX_LIST) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a plain array`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new Error(`${label} is invalid`);
  }

  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be a dense data-only array`);
    }
    out.push(descriptor.value);
  }

  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length) {
      throw new Error(`${label} contains a non-index field`);
    }
  }
  return out;
}

function idList(value, label) {
  const ids = dataArray(value, label).map(
    (item, index) => requiredId(item, `${label}[${index}]`),
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return ids;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function denied(reasonCode, details = {}) {
  return freezeDeep({
    schemaVersion: SUBAGENT_SPAWN_AUTHORITY_BINDING_VERSION,
    decision: SubagentSpawnAuthorityBindingDecision.DENY,
    reasonCode,
    createdNodeIds: [],
    authorityBindings: [],
    activationRequests: [],
    activationAuthority: false,
    executionAuthority: false,
    credentialAuthority: false,
    policyAuthority: false,
    persistenceAuthority: false,
    schedulingAuthority: false,
    ...details,
  });
}

function normalizeChildTasks(value) {
  const tasks = dataArray(value, 'childTasks', MAX_CHILD_TASKS).map((item, index) => {
    const task = strictRecord(item, TASK_KEYS, `childTasks[${index}]`);
    return {
      task,
      taskId: requiredId(own(task, 'taskId'), `childTasks[${index}].taskId`),
      providerId: requiredId(own(task, 'providerId'), `childTasks[${index}].providerId`),
    };
  });

  const taskIds = tasks.map(item => item.taskId);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error('childTasks contains duplicate taskId');
  }
  return tasks;
}

function normalizeProviderCapabilities(value) {
  const entries = dataArray(value, 'providerCapabilities').map((item, index) => {
    const entry = strictRecord(
      item,
      PROVIDER_CAPABILITY_KEYS,
      `providerCapabilities[${index}]`,
    );
    return {
      providerId: requiredId(
        own(entry, 'providerId'),
        `providerCapabilities[${index}].providerId`,
      ),
      capabilityIds: idList(
        own(entry, 'capabilityIds'),
        `providerCapabilities[${index}].capabilityIds`,
      ),
    };
  });

  const byProviderId = new Map();
  for (const entry of entries) {
    if (byProviderId.has(entry.providerId)) {
      throw new Error('providerCapabilities contains duplicate providerId');
    }
    byProviderId.set(entry.providerId, entry);
  }
  return byProviderId;
}

/**
 * Atomically compose deterministic child topology with least-authority child
 * envelopes.
 *
 * Parent/child Agent identities are never accepted from child task input. They
 * are derived only from the canonical topology transform result. Provider
 * capability truth is also separate from child task/model scope: the child may
 * select a provider ID, but its capability set comes from the canonical
 * provider snapshot supplied by the existing owner/runtime authority.
 *
 * This function is pure and non-authorizing. Callers must persist and activate
 * through the existing canonical Orchestration V2 authority.
 */
export function bindSubagentSpawnAuthorityV1(input = {}) {
  const request = strictRecord(
    input,
    REQUEST_KEYS,
    'SubagentSpawnAuthorityBindingRequestV1',
  );
  const projectId = requiredId(own(request, 'projectId'), 'projectId');
  const childTasks = normalizeChildTasks(own(request, 'childTasks'));
  const providerCapabilities = normalizeProviderCapabilities(
    own(request, 'providerCapabilities'),
  );

  const topology = mutateOrchestrationSubagentTopologyV1(
    own(request, 'topologyRequest'),
  );
  if (topology.decision !== SubagentTopologyMutationDecision.ALLOW) {
    return denied('TOPOLOGY_DENIED', {
      projectId,
      topologyReasonCode: topology.reasonCode,
    });
  }

  if (childTasks.length !== topology.createdNodeIds.length) {
    return denied('CHILD_TASK_COUNT_MISMATCH', {
      projectId,
      parentNodeId: topology.parentNodeId,
      spawnId: topology.spawnId,
      expectedChildTaskCount: topology.createdNodeIds.length,
      actualChildTaskCount: childTasks.length,
    });
  }

  const bindings = [];
  for (let index = 0; index < childTasks.length; index += 1) {
    const { task, taskId, providerId } = childTasks[index];
    const childNodeId = topology.createdNodeIds[index];
    const providerCapability = providerCapabilities.get(providerId);

    if (!providerCapability) {
      return denied('PROVIDER_CAPABILITY_SNAPSHOT_MISSING', {
        projectId,
        parentNodeId: topology.parentNodeId,
        spawnId: topology.spawnId,
        deniedChildNodeId: childNodeId,
        deniedTaskId: taskId,
        deniedProviderId: providerId,
      });
    }

    const authorityEnvelope = deriveSubagentAuthorityEnvelopeV1({
      projectId,
      parentAgentId: topology.parentNodeId,
      childAgentId: childNodeId,
      taskId,
      providerId,
      parentProviderIds: own(request, 'parentProviderIds'),
      ownerAllowedProviderIds: own(request, 'ownerAllowedProviderIds'),
      parentCapabilityIds: own(request, 'parentCapabilityIds'),
      ownerAllowedCapabilityIds: own(request, 'ownerAllowedCapabilityIds'),
      providerCapabilityIds: providerCapability.capabilityIds,
      taskRequestedCapabilityIds: own(task, 'taskRequestedCapabilityIds'),
      parentSourceIds: own(request, 'parentSourceIds'),
      ownerAllowedSourceIds: own(request, 'ownerAllowedSourceIds'),
      taskSourceIds: own(task, 'taskSourceIds'),
      parentArtifactIds: own(request, 'parentArtifactIds'),
      ownerAllowedArtifactIds: own(request, 'ownerAllowedArtifactIds'),
      taskArtifactIds: own(task, 'taskArtifactIds'),
      parentToolIds: own(request, 'parentToolIds'),
      ownerAllowedToolIds: own(request, 'ownerAllowedToolIds'),
      requestedToolIds: own(task, 'requestedToolIds'),
      parentToolDescriptors: own(request, 'parentToolDescriptors'),
    });

    if (authorityEnvelope.decision !== SubagentAuthorityDecision.ALLOW) {
      return denied('CHILD_AUTHORITY_DENIED', {
        projectId,
        parentNodeId: topology.parentNodeId,
        spawnId: topology.spawnId,
        deniedChildNodeId: childNodeId,
        deniedTaskId: taskId,
        childReasonCode: authorityEnvelope.reasonCode,
      });
    }

    bindings.push({
      childNodeId,
      taskId,
      providerId,
      authorityEnvelope,
    });
  }

  return freezeDeep({
    schemaVersion: SUBAGENT_SPAWN_AUTHORITY_BINDING_VERSION,
    decision: SubagentSpawnAuthorityBindingDecision.ALLOW,
    reasonCode: 'SUBAGENT_SPAWN_AUTHORITY_BOUND',
    projectId,
    parentNodeId: topology.parentNodeId,
    spawnId: topology.spawnId,
    reused: topology.reused,
    createdNodeIds: [...topology.createdNodeIds],
    authorityBindings: bindings,
    graph: topology.graph,
    runtime: topology.runtime,
    activationRequests: [...topology.activationRequests],
    activationAuthority: false,
    executionAuthority: false,
    credentialAuthority: false,
    policyAuthority: false,
    persistenceAuthority: false,
    schedulingAuthority: false,
  });
}
