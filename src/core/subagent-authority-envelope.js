import { normalizeToolDescriptorV1 } from './universal-agent-contracts.js';

export const SUBAGENT_AUTHORITY_ENVELOPE_VERSION = 1;

export const SubagentAuthorityDecision = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
});

const REQUEST_KEYS = new Set([
  'projectId',
  'parentAgentId',
  'childAgentId',
  'taskId',
  'providerId',
  'parentCapabilityIds',
  'ownerAllowedCapabilityIds',
  'providerCapabilityIds',
  'taskRequestedCapabilityIds',
  'parentSourceIds',
  'ownerAllowedSourceIds',
  'taskSourceIds',
  'parentArtifactIds',
  'ownerAllowedArtifactIds',
  'taskArtifactIds',
  'parentToolIds',
  'ownerAllowedToolIds',
  'requestedToolIds',
  'parentToolDescriptors',
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
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

function dataArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LIST) {
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
  const ids = dataArray(value, label).map((item, index) => requiredId(item, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicates`);
  return ids;
}

function intersect(...lists) {
  if (!lists.length) return [];
  const rest = lists.slice(1).map(list => new Set(list));
  return lists[0].filter(id => rest.every(set => set.has(id)));
}

function missing(requested, allowed) {
  const allowedSet = new Set(allowed);
  return requested.filter(id => !allowedSet.has(id));
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function denied(reasonCode, identities, details = {}) {
  return freezeDeep({
    schemaVersion: SUBAGENT_AUTHORITY_ENVELOPE_VERSION,
    decision: SubagentAuthorityDecision.DENY,
    reasonCode,
    ...identities,
    capabilityIds: [],
    sourceIds: [],
    artifactIds: [],
    toolIds: [],
    toolDescriptors: [],
    executionAuthority: false,
    credentialAuthority: false,
    policyAuthority: false,
    ...details,
  });
}

/**
 * Derive a non-authorizing least-authority envelope for one child Agent.
 *
 * Inputs must already be canonical owner/runtime facts. This contract does not
 * authenticate those facts and does not execute tools. It only proves that a
 * requested child scope is no broader than the intersection of parent
 * authority, owner policy, provider capability and task-specific scope.
 * Tool descriptors are supplied only from the canonical parent authority
 * snapshot; the task contributes tool IDs, never replacement descriptors.
 */
export function deriveSubagentAuthorityEnvelopeV1(input = {}) {
  const request = strictRecord(input, REQUEST_KEYS, 'SubagentAuthorityEnvelopeRequestV1');
  const identities = freezeDeep({
    projectId: requiredId(own(request, 'projectId'), 'projectId'),
    parentAgentId: requiredId(own(request, 'parentAgentId'), 'parentAgentId'),
    childAgentId: requiredId(own(request, 'childAgentId'), 'childAgentId'),
    taskId: requiredId(own(request, 'taskId'), 'taskId'),
    providerId: requiredId(own(request, 'providerId'), 'providerId'),
  });

  if (identities.parentAgentId === identities.childAgentId) {
    return denied('CHILD_IDENTITY_NOT_ISOLATED', identities);
  }

  const parentCapabilityIds = idList(own(request, 'parentCapabilityIds'), 'parentCapabilityIds');
  const ownerAllowedCapabilityIds = idList(own(request, 'ownerAllowedCapabilityIds'), 'ownerAllowedCapabilityIds');
  const providerCapabilityIds = idList(own(request, 'providerCapabilityIds'), 'providerCapabilityIds');
  const taskRequestedCapabilityIds = idList(own(request, 'taskRequestedCapabilityIds'), 'taskRequestedCapabilityIds');
  const parentSourceIds = idList(own(request, 'parentSourceIds'), 'parentSourceIds');
  const ownerAllowedSourceIds = idList(own(request, 'ownerAllowedSourceIds'), 'ownerAllowedSourceIds');
  const taskSourceIds = idList(own(request, 'taskSourceIds'), 'taskSourceIds');
  const parentArtifactIds = idList(own(request, 'parentArtifactIds'), 'parentArtifactIds');
  const ownerAllowedArtifactIds = idList(own(request, 'ownerAllowedArtifactIds'), 'ownerAllowedArtifactIds');
  const taskArtifactIds = idList(own(request, 'taskArtifactIds'), 'taskArtifactIds');
  const parentToolIds = idList(own(request, 'parentToolIds'), 'parentToolIds');
  const ownerAllowedToolIds = idList(own(request, 'ownerAllowedToolIds'), 'ownerAllowedToolIds');
  const requestedToolIds = idList(own(request, 'requestedToolIds'), 'requestedToolIds');
  const descriptorInputs = dataArray(own(request, 'parentToolDescriptors'), 'parentToolDescriptors');

  const authorityIntersection = intersect(
    parentCapabilityIds,
    ownerAllowedCapabilityIds,
    providerCapabilityIds,
  );
  const capabilityEscalation = missing(taskRequestedCapabilityIds, authorityIntersection);
  if (capabilityEscalation.length) {
    return denied('CAPABILITY_ESCALATION', identities, {
      deniedCapabilityIds: capabilityEscalation,
    });
  }

  const sourceAuthorityIntersection = intersect(parentSourceIds, ownerAllowedSourceIds);
  const sourceEscape = missing(taskSourceIds, sourceAuthorityIntersection);
  if (sourceEscape.length) {
    return denied('CONTEXT_SOURCE_ESCALATION', identities, {
      deniedSourceIds: sourceEscape,
    });
  }

  const artifactAuthorityIntersection = intersect(parentArtifactIds, ownerAllowedArtifactIds);
  const artifactEscape = missing(taskArtifactIds, artifactAuthorityIntersection);
  if (artifactEscape.length) {
    return denied('CONTEXT_ARTIFACT_ESCALATION', identities, {
      deniedArtifactIds: artifactEscape,
    });
  }

  const toolAuthorityIntersection = intersect(parentToolIds, ownerAllowedToolIds);
  const toolScopeEscalation = missing(requestedToolIds, toolAuthorityIntersection);
  if (toolScopeEscalation.length) {
    return denied('TOOL_SCOPE_ESCALATION', identities, {
      deniedToolIds: toolScopeEscalation,
    });
  }

  const descriptors = descriptorInputs.map((descriptor, index) => {
    try {
      return normalizeToolDescriptorV1(descriptor);
    } catch (error) {
      throw new Error(`parentToolDescriptors[${index}]: ${error.message}`);
    }
  });
  const descriptorsById = new Map();
  for (const descriptor of descriptors) {
    if (descriptorsById.has(descriptor.toolId)) throw new Error('parentToolDescriptors contains duplicate toolId');
    if (!parentToolIds.includes(descriptor.toolId)) {
      throw new Error(`parentToolDescriptors exceeds parentToolIds: ${descriptor.toolId}`);
    }
    descriptorsById.set(descriptor.toolId, descriptor);
  }

  const childCapabilitySet = new Set(taskRequestedCapabilityIds);
  const selectedDescriptors = [];
  for (const toolId of requestedToolIds) {
    const descriptor = descriptorsById.get(toolId);
    if (!descriptor) {
      return denied('TOOL_DESCRIPTOR_MISSING', identities, { deniedToolIds: [toolId] });
    }
    if (descriptor.providerId !== identities.providerId) {
      return denied('TOOL_PROVIDER_ESCALATION', identities, { deniedToolIds: [toolId] });
    }
    if (!descriptor.capabilityIds.length) {
      return denied('TOOL_CAPABILITY_UNDECLARED', identities, { deniedToolIds: [toolId] });
    }
    const toolEscalation = descriptor.capabilityIds.filter(id => !childCapabilitySet.has(id));
    if (toolEscalation.length) {
      return denied('TOOL_CAPABILITY_ESCALATION', identities, {
        deniedToolIds: [toolId],
        deniedCapabilityIds: toolEscalation,
      });
    }
    selectedDescriptors.push(descriptor);
  }

  return freezeDeep({
    schemaVersion: SUBAGENT_AUTHORITY_ENVELOPE_VERSION,
    decision: SubagentAuthorityDecision.ALLOW,
    reasonCode: 'LEAST_AUTHORITY_DERIVED',
    ...identities,
    capabilityIds: [...taskRequestedCapabilityIds],
    sourceIds: [...taskSourceIds],
    artifactIds: [...taskArtifactIds],
    toolIds: [...requestedToolIds],
    toolDescriptors: selectedDescriptors,
    executionAuthority: false,
    credentialAuthority: false,
    policyAuthority: false,
  });
}
