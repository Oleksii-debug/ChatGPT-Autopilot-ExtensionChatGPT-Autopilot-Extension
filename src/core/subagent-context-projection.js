import {
  normalizeContextCapsuleV1,
  normalizeProjectSnapshotV1,
} from './project-context-artifact.js';

export const SUBAGENT_CONTEXT_PROJECTION_VERSION = 1;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'decision',
  'reasonCode',
  'projectId',
  'parentAgentId',
  'childAgentId',
  'taskId',
  'providerId',
  'capabilityIds',
  'sourceIds',
  'artifactIds',
  'toolIds',
  'toolDescriptors',
  'executionAuthority',
  'credentialAuthority',
  'policyAuthority',
]);
const REQUEST_KEYS = new Set([
  'schemaVersion',
  'authorityEnvelope',
  'expectedParentAgentId',
  'expectedChildAgentId',
  'expectedTaskId',
  'expectedProjectRevisionId',
  'parentProjectSnapshot',
  'priorParentCapsule',
]);
const MAX_IDS = 256;

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
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function own(value, key) {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function dataArray(value, label, max = MAX_IDS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a canonical array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length)
      || Object.is(length, -0)
      || length < 0
      || length > max) {
    throw new Error(`${label} has invalid length`);
  }
  const out = new Array(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) {
      throw new Error(`${label} contains non-index field`);
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || String(index) !== key
        || !descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must contain dense enumerable data entries`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be dense`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function idList(value, label) {
  const ids = dataArray(value, label).map((item, index) => exactId(item, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicates`);
  return ids;
}

function exactFalse(value, label) {
  if (value !== false) throw new Error(`${label} must remain false`);
  return false;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sameArtifactIdentity(left, right) {
  return left.schemaVersion === right.schemaVersion
    && left.artifactId === right.artifactId
    && left.kind === right.kind
    && left.uri === right.uri
    && left.mediaType === right.mediaType
    && left.sha256 === right.sha256
    && left.sizeBytes === right.sizeBytes
    && left.createdAt === right.createdAt
    && left.producerInvocationId === right.producerInvocationId
    && left.sensitive === right.sensitive;
}

function normalizeAllowedEnvelope(input) {
  const raw = strictRecord(input, ENVELOPE_KEYS, 'SubagentAuthorityEnvelopeV1');
  if (raw.schemaVersion !== 1) throw new Error('Unsupported SubagentAuthorityEnvelopeV1 schemaVersion');
  if (raw.decision !== 'ALLOW' || raw.reasonCode !== 'LEAST_AUTHORITY_DERIVED') {
    throw new Error('Subagent context projection requires an ALLOW least-authority envelope');
  }
  dataArray(raw.toolDescriptors, 'authorityEnvelope.toolDescriptors');
  const normalized = {
    schemaVersion: 1,
    decision: 'ALLOW',
    reasonCode: 'LEAST_AUTHORITY_DERIVED',
    projectId: exactId(raw.projectId, 'authorityEnvelope.projectId'),
    parentAgentId: exactId(raw.parentAgentId, 'authorityEnvelope.parentAgentId'),
    childAgentId: exactId(raw.childAgentId, 'authorityEnvelope.childAgentId'),
    taskId: exactId(raw.taskId, 'authorityEnvelope.taskId'),
    providerId: exactId(raw.providerId, 'authorityEnvelope.providerId'),
    capabilityIds: idList(raw.capabilityIds, 'authorityEnvelope.capabilityIds'),
    sourceIds: idList(raw.sourceIds, 'authorityEnvelope.sourceIds'),
    artifactIds: idList(raw.artifactIds, 'authorityEnvelope.artifactIds'),
    toolIds: idList(raw.toolIds, 'authorityEnvelope.toolIds'),
    executionAuthority: exactFalse(raw.executionAuthority, 'authorityEnvelope.executionAuthority'),
    credentialAuthority: exactFalse(raw.credentialAuthority, 'authorityEnvelope.credentialAuthority'),
    policyAuthority: exactFalse(raw.policyAuthority, 'authorityEnvelope.policyAuthority'),
  };
  if (normalized.parentAgentId === normalized.childAgentId) {
    throw new Error('authorityEnvelope child identity is not isolated');
  }
  return deepFreeze(normalized);
}

/**
 * Project one trusted parent ProjectSnapshotV1 into exactly the source/artifact
 * scope already admitted by SubagentAuthorityEnvelopeV1.
 *
 * This is a pure least-data projection. It does not authenticate the envelope,
 * grant execution, resolve credentials, persist memory, or authorize retrieval.
 * Callers must bind the envelope to canonical orchestration state before use.
 *
 * A parent ContextCapsuleV1 may be supplied only to recover exact current
 * source/artifact bindings. Its aggregate summary is deliberately never reused:
 * a parent summary can contain information from sources the child is not allowed
 * to observe, and the capsule schema has no per-summary provenance boundary.
 */
export function projectSubagentContextV1(input = {}) {
  const request = strictRecord(input, REQUEST_KEYS, 'SubagentContextProjectionRequestV1');
  if (own(request, 'schemaVersion') !== SUBAGENT_CONTEXT_PROJECTION_VERSION) {
    throw new Error('Unsupported SubagentContextProjectionRequestV1 schemaVersion');
  }

  const envelope = normalizeAllowedEnvelope(own(request, 'authorityEnvelope'));
  const expectedParentAgentId = exactId(
    own(request, 'expectedParentAgentId'),
    'expectedParentAgentId',
  );
  const expectedChildAgentId = exactId(
    own(request, 'expectedChildAgentId'),
    'expectedChildAgentId',
  );
  const expectedTaskId = exactId(own(request, 'expectedTaskId'), 'expectedTaskId');
  const expectedProjectRevisionId = exactId(
    own(request, 'expectedProjectRevisionId'),
    'expectedProjectRevisionId',
  );

  if (envelope.parentAgentId !== expectedParentAgentId) {
    throw new Error('Subagent authority parentAgentId binding mismatch');
  }
  if (envelope.childAgentId !== expectedChildAgentId) {
    throw new Error('Subagent authority childAgentId binding mismatch');
  }
  if (envelope.taskId !== expectedTaskId) {
    throw new Error('Subagent authority taskId binding mismatch');
  }

  const parentSnapshot = normalizeProjectSnapshotV1(own(request, 'parentProjectSnapshot'));
  if (parentSnapshot.projectId !== envelope.projectId) {
    throw new Error('Subagent authority projectId does not match parent project snapshot');
  }
  if (parentSnapshot.revisionId !== expectedProjectRevisionId) {
    throw new Error('Parent project snapshot revision binding mismatch');
  }

  const sourceById = new Map(parentSnapshot.sourceRefs.map(source => [source.sourceId, source]));
  const artifactById = new Map(parentSnapshot.artifactRefs.map(artifact => [artifact.artifactId, artifact]));

  const missingSourceIds = envelope.sourceIds.filter(sourceId => !sourceById.has(sourceId));
  if (missingSourceIds.length) {
    throw new Error(`Authorized child sourceIds missing from parent snapshot: ${missingSourceIds.join(', ')}`);
  }
  const missingArtifactIds = envelope.artifactIds.filter(artifactId => !artifactById.has(artifactId));
  if (missingArtifactIds.length) {
    throw new Error(`Authorized child artifactIds missing from parent snapshot: ${missingArtifactIds.join(', ')}`);
  }

  const projectedSourceRefs = envelope.sourceIds.map(sourceId => sourceById.get(sourceId));
  const projectedArtifactRefs = envelope.artifactIds.map(artifactId => artifactById.get(artifactId));

  let priorBindings = null;
  const priorParentCapsule = own(request, 'priorParentCapsule');
  if (priorParentCapsule != null) {
    const capsule = normalizeContextCapsuleV1(priorParentCapsule);
    if (capsule.projectId !== parentSnapshot.projectId) {
      throw new Error('priorParentCapsule projectId mismatch');
    }

    const allowedSources = new Set(envelope.sourceIds);
    const allowedArtifacts = new Set(envelope.artifactIds);
    const selectedSourceBindings = capsule.sourceBindings.filter(binding =>
      allowedSources.has(binding.sourceId));
    const selectedArtifactRefs = capsule.artifactRefs.filter(artifact =>
      allowedArtifacts.has(artifact.artifactId));

    for (const binding of selectedSourceBindings) {
      const source = sourceById.get(binding.sourceId);
      if (!source
          || binding.revisionId !== source.revisionId
          || binding.contentSha256 !== source.contentSha256) {
        throw new Error(`priorParentCapsule contains stale authorized source binding: ${binding.sourceId}`);
      }
    }
    for (const artifact of selectedArtifactRefs) {
      const current = artifactById.get(artifact.artifactId);
      if (!current || !sameArtifactIdentity(artifact, current)) {
        throw new Error(`priorParentCapsule contains stale authorized artifact ref: ${artifact.artifactId}`);
      }
    }

    priorBindings = deepFreeze({
      sourceBindings: selectedSourceBindings,
      artifactRefs: selectedArtifactRefs,
      summaryReusable: false,
      summaryOmittedReason: 'PARENT_SUMMARY_MAY_CROSS_CHILD_AUTHORITY_BOUNDARY',
    });
  }

  return deepFreeze({
    schemaVersion: SUBAGENT_CONTEXT_PROJECTION_VERSION,
    projectId: parentSnapshot.projectId,
    parentAgentId: envelope.parentAgentId,
    childAgentId: envelope.childAgentId,
    taskId: envelope.taskId,
    providerId: envelope.providerId,
    parentProjectRevisionId: parentSnapshot.revisionId,
    projectedSnapshot: {
      schemaVersion: parentSnapshot.schemaVersion,
      projectId: parentSnapshot.projectId,
      revisionId: parentSnapshot.revisionId,
      title: parentSnapshot.title,
      sourceRefs: projectedSourceRefs,
      artifactRefs: projectedArtifactRefs,
      createdAt: parentSnapshot.createdAt,
    },
    priorBindings,
    retrievalAuthorized: false,
    executionAuthorized: false,
    mutationAuthorized: false,
    credentialAuthority: false,
    policyAuthority: false,
    sourceTrust: 'CALLER_BOUND_NOT_AUTHENTICATED',
  });
}
