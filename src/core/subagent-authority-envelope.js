import { normalizeToolDescriptorV1 } from './universal-agent-contracts.js';
import { compactOrchestrationEventId } from './orchestration-hierarchy.js';

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
  'parentProviderIds',
  'ownerAllowedProviderIds',
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
const ALLOW_ENVELOPE_KEYS = new Set([
  'schemaVersion', 'decision', 'reasonCode', 'projectId', 'parentAgentId',
  'childAgentId', 'taskId', 'providerId', 'capabilityIds', 'sourceIds',
  'artifactIds', 'toolIds', 'toolDescriptors', 'executionAuthority',
  'credentialAuthority', 'policyAuthority',
]);

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

function compareCodeUnit(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactFalse(value, label) {
  if (value !== false) throw new Error(`${label} must be false`);
  return false;
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
 * Normalize an already-derived ALLOW envelope into deterministic semantic
 * order. This checks shape and internal consistency only; it does not
 * authenticate parent/owner/provider facts and grants no authority.
 */
export function normalizeAllowedSubagentAuthorityEnvelopeV1(input) {
  const raw = strictRecord(input, ALLOW_ENVELOPE_KEYS, 'SubagentAuthorityEnvelopeV1');
  if (own(raw, 'schemaVersion') !== SUBAGENT_AUTHORITY_ENVELOPE_VERSION) {
    throw new Error('Unsupported SubagentAuthorityEnvelopeV1 schemaVersion');
  }
  if (own(raw, 'decision') !== SubagentAuthorityDecision.ALLOW
      || own(raw, 'reasonCode') !== 'LEAST_AUTHORITY_DERIVED') {
    throw new Error('Subagent authority envelope is not an exact ALLOW envelope');
  }

  const providerId = requiredId(own(raw, 'providerId'), 'authorityEnvelope.providerId');
  const capabilityIds = idList(own(raw, 'capabilityIds'), 'authorityEnvelope.capabilityIds').sort(compareCodeUnit);
  const sourceIds = idList(own(raw, 'sourceIds'), 'authorityEnvelope.sourceIds').sort(compareCodeUnit);
  const artifactIds = idList(own(raw, 'artifactIds'), 'authorityEnvelope.artifactIds').sort(compareCodeUnit);
  const toolIds = idList(own(raw, 'toolIds'), 'authorityEnvelope.toolIds').sort(compareCodeUnit);
  const toolDescriptors = dataArray(
    own(raw, 'toolDescriptors'),
    'authorityEnvelope.toolDescriptors',
  ).map((descriptor, index) => {
    try {
      return normalizeToolDescriptorV1(descriptor);
    } catch (error) {
      throw new Error(`authorityEnvelope.toolDescriptors[${index}]: ${error.message}`);
    }
  }).sort((left, right) => compareCodeUnit(left.toolId, right.toolId));

  if (new Set(toolDescriptors.map(item => item.toolId)).size !== toolDescriptors.length) {
    throw new Error('authorityEnvelope.toolDescriptors contains duplicate toolId');
  }
  if (toolDescriptors.length !== toolIds.length
      || toolDescriptors.some((descriptor, index) => descriptor.toolId !== toolIds[index])) {
    throw new Error('authorityEnvelope toolIds and toolDescriptors must match exactly');
  }
  const capabilitySet = new Set(capabilityIds);
  for (const descriptor of toolDescriptors) {
    if (descriptor.providerId !== providerId) {
      throw new Error('authorityEnvelope tool descriptor provider mismatch: ' + descriptor.toolId);
    }
    if (descriptor.capabilityIds.some(capabilityId => !capabilitySet.has(capabilityId))) {
      throw new Error('authorityEnvelope tool descriptor capability exceeds child scope: ' + descriptor.toolId);
    }
  }

  return freezeDeep({
    schemaVersion: SUBAGENT_AUTHORITY_ENVELOPE_VERSION,
    decision: SubagentAuthorityDecision.ALLOW,
    reasonCode: 'LEAST_AUTHORITY_DERIVED',
    projectId: requiredId(own(raw, 'projectId'), 'authorityEnvelope.projectId'),
    parentAgentId: requiredId(own(raw, 'parentAgentId'), 'authorityEnvelope.parentAgentId'),
    childAgentId: requiredId(own(raw, 'childAgentId'), 'authorityEnvelope.childAgentId'),
    taskId: requiredId(own(raw, 'taskId'), 'authorityEnvelope.taskId'),
    providerId,
    capabilityIds,
    sourceIds,
    artifactIds,
    toolIds,
    toolDescriptors,
    executionAuthority: exactFalse(own(raw, 'executionAuthority'), 'authorityEnvelope.executionAuthority'),
    credentialAuthority: exactFalse(own(raw, 'credentialAuthority'), 'authorityEnvelope.credentialAuthority'),
    policyAuthority: exactFalse(own(raw, 'policyAuthority'), 'authorityEnvelope.policyAuthority'),
  });
}

export function deriveSubagentAuthorityEnvelopeIdentityV1(input) {
  const canonical = JSON.stringify(normalizeAllowedSubagentAuthorityEnvelopeV1(input));
  const prefix = 'subagent-authority';
  const lanes = [];
  for (let lane = 0; lane < 4; lane += 1) {
    const compact = compactOrchestrationEventId(
      prefix,
      'SubagentAuthorityEnvelopeV1',
      String(SUBAGENT_AUTHORITY_ENVELOPE_VERSION),
      String(lane),
      canonical,
    );
    lanes.push(compact.slice(prefix.length + 1));
  }
  return prefix + ':' + lanes.join('');
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

  const parentProviderIds = idList(own(request, 'parentProviderIds'), 'parentProviderIds');
  const ownerAllowedProviderIds = idList(own(request, 'ownerAllowedProviderIds'), 'ownerAllowedProviderIds');
  const providerAuthorityIntersection = intersect(parentProviderIds, ownerAllowedProviderIds);
  if (!providerAuthorityIntersection.includes(identities.providerId)) {
    return denied('PROVIDER_SCOPE_ESCALATION', identities, {
      deniedProviderIds: [identities.providerId],
    });
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
