import {
  normalizeContextCapsuleV1,
  normalizeProjectSnapshotV1,
} from './project-context-artifact.js';
import { normalizeSubagentTaskEnvelopeV1 } from './subagent-task-envelope.js';

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

export function normalizeAllowedSubagentAuthorityEnvelopeV1(input) {
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
    // Durable child-context provenance never carries executable descriptors.
    // Keep the field canonical so the normalized envelope can be revalidated
    // after persistence without minting tool execution authority.
    toolDescriptors: [],
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

  const envelope = normalizeAllowedSubagentAuthorityEnvelopeV1(own(request, 'authorityEnvelope'));
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
    if (capsule.projectRevisionId !== parentSnapshot.revisionId) {
      throw new Error('priorParentCapsule projectRevisionId mismatch');
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
      title: `Scoped context for ${parentSnapshot.projectId}`,
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


const TASK_CONTEXT_REQUEST_KEYS = new Set([
  'schemaVersion',
  'authorityEnvelope',
  'taskEnvelope',
  'expectedParentAgentId',
  'expectedChildAgentId',
  'expectedTaskId',
  'expectedProjectRevisionId',
  'parentProjectSnapshot',
  'priorParentCapsule',
]);

function sameTaskArtifactIdentity(left, right) {
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

/**
 * Bind child-visible Project context to the exact immutable inputs of one
 * canonical SubagentTaskEnvelopeV1 before applying the ordinary least-authority
 * projection.
 *
 * This is still pure and non-authorizing. The task envelope itself explicitly
 * carries UNVERIFIED_INPUT provenance and requires trusted runtime resolution.
 * This adapter only prevents an already-authorized child from seeing sources or
 * artifacts that are outside the exact task input set.
 */
export function projectSubagentTaskContextV1(input = {}) {
  const request = strictRecord(
    input,
    TASK_CONTEXT_REQUEST_KEYS,
    'SubagentTaskContextProjectionRequestV1',
  );
  if (own(request, 'schemaVersion') !== SUBAGENT_CONTEXT_PROJECTION_VERSION) {
    throw new Error('Unsupported SubagentTaskContextProjectionRequestV1 schemaVersion');
  }

  const envelope = normalizeAllowedSubagentAuthorityEnvelopeV1(own(request, 'authorityEnvelope'));
  const task = normalizeSubagentTaskEnvelopeV1(own(request, 'taskEnvelope'));
  const expectedParentAgentId = exactId(
    own(request, 'expectedParentAgentId'),
    'expectedParentAgentId',
  );
  const expectedChildAgentId = exactId(
    own(request, 'expectedChildAgentId'),
    'expectedChildAgentId',
  );
  const expectedTaskId = exactId(own(request, 'expectedTaskId'), 'expectedTaskId');

  if (task.projectId !== envelope.projectId) {
    throw new Error('Subagent task projectId does not match authority envelope');
  }
  if (task.parentAgentId !== envelope.parentAgentId
      || task.parentAgentId !== expectedParentAgentId) {
    throw new Error('Subagent task parentAgentId binding mismatch');
  }
  if (task.childAgentId !== envelope.childAgentId
      || task.childAgentId !== expectedChildAgentId) {
    throw new Error('Subagent task childAgentId binding mismatch');
  }
  if (task.taskId !== envelope.taskId || task.taskId !== expectedTaskId) {
    throw new Error('Subagent task taskId binding mismatch');
  }

  const allowedSourceIds = new Set(envelope.sourceIds);
  const allowedArtifactIds = new Set(envelope.artifactIds);
  const taskSourceIds = task.inputSourceRefs.map(ref => ref.sourceId);
  const taskArtifactIds = task.inputArtifactRefs.map(ref => ref.artifactId);

  for (const sourceId of taskSourceIds) {
    if (!allowedSourceIds.has(sourceId)) {
      throw new Error(`Subagent task source is outside child authority: ${sourceId}`);
    }
  }
  for (const artifactId of taskArtifactIds) {
    if (!allowedArtifactIds.has(artifactId)) {
      throw new Error(`Subagent task artifact is outside child authority: ${artifactId}`);
    }
  }

  const parentSnapshot = normalizeProjectSnapshotV1(
    own(request, 'parentProjectSnapshot'),
  );
  const sourceById = new Map(parentSnapshot.sourceRefs.map(source => [source.sourceId, source]));
  const artifactById = new Map(parentSnapshot.artifactRefs.map(artifact => [artifact.artifactId, artifact]));

  for (const taskSource of task.inputSourceRefs) {
    const current = sourceById.get(taskSource.sourceId);
    if (!current
        || current.revisionId !== taskSource.revisionId
        || current.uri !== taskSource.location
        || current.contentSha256 !== taskSource.contentSha256) {
      throw new Error(`Subagent task source identity is stale or mismatched: ${taskSource.sourceId}`);
    }
  }
  for (const taskArtifact of task.inputArtifactRefs) {
    const current = artifactById.get(taskArtifact.artifactId);
    if (!current || !sameTaskArtifactIdentity(current, taskArtifact)) {
      throw new Error(`Subagent task artifact identity is stale or mismatched: ${taskArtifact.artifactId}`);
    }
  }

  const narrowedEnvelope = {
    ...envelope,
    sourceIds: taskSourceIds,
    artifactIds: taskArtifactIds,
    toolDescriptors: [],
  };

  return projectSubagentContextV1({
    schemaVersion: SUBAGENT_CONTEXT_PROJECTION_VERSION,
    authorityEnvelope: narrowedEnvelope,
    expectedParentAgentId,
    expectedChildAgentId,
    expectedTaskId,
    expectedProjectRevisionId: own(request, 'expectedProjectRevisionId'),
    parentProjectSnapshot: parentSnapshot,
    priorParentCapsule: own(request, 'priorParentCapsule'),
  });
}


const DURABLE_TASK_CONTEXT_REQUEST_KEYS = new Set([
  'schemaVersion',
  'authorityEnvelope',
  'taskEnvelope',
  'expectedParentAgentId',
  'expectedChildAgentId',
  'expectedTaskId',
  'expectedProjectRevisionId',
  'capsuleId',
]);
const DURABLE_CONTEXT_RESOLUTION_KEYS = new Set([
  'schemaVersion',
  'workspaceRevision',
  'projectId',
  'projectRevisionId',
  'snapshot',
  'capsule',
  'ownerStateSource',
  'sourceAuthorityAuthenticated',
  'retrievalAuthorized',
  'executionAuthorized',
  'mutationAuthorized',
  'policyAuthority',
]);

function nonNegativeRevision(value, label) {
  if (!Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeDurableProjectContextResolutionV1(value, expected) {
  const raw = strictRecord(
    value,
    DURABLE_CONTEXT_RESOLUTION_KEYS,
    'ProjectWorkspaceContextResolutionV1',
  );
  if (own(raw, 'schemaVersion') !== 1) {
    throw new Error('Unsupported ProjectWorkspaceContextResolutionV1 schemaVersion');
  }

  const workspaceRevision = nonNegativeRevision(
    own(raw, 'workspaceRevision'),
    'ProjectWorkspaceContextResolutionV1.workspaceRevision',
  );
  const projectId = exactId(
    own(raw, 'projectId'),
    'ProjectWorkspaceContextResolutionV1.projectId',
  );
  const projectRevisionId = exactId(
    own(raw, 'projectRevisionId'),
    'ProjectWorkspaceContextResolutionV1.projectRevisionId',
  );
  if (projectId !== expected.projectId) {
    throw new Error('Durable Project context projectId binding mismatch');
  }
  if (projectRevisionId !== expected.expectedProjectRevisionId) {
    throw new Error('Durable Project context revision binding mismatch');
  }

  const snapshot = normalizeProjectSnapshotV1(own(raw, 'snapshot'));
  if (snapshot.projectId !== projectId || snapshot.revisionId !== projectRevisionId) {
    throw new Error('Durable Project context snapshot binding mismatch');
  }

  let capsule = null;
  const rawCapsule = own(raw, 'capsule');
  if (rawCapsule != null) {
    capsule = normalizeContextCapsuleV1(rawCapsule);
    if (capsule.projectId !== projectId
        || capsule.projectRevisionId !== projectRevisionId) {
      throw new Error('Durable Project context capsule binding mismatch');
    }
  }
  if (expected.capsuleId) {
    if (!capsule || capsule.capsuleId !== expected.capsuleId) {
      throw new Error('Durable Project context capsuleId binding mismatch');
    }
  } else if (capsule !== null) {
    throw new Error('Durable Project context returned an unrequested capsule');
  }

  if (own(raw, 'ownerStateSource') !== 'DURABLE_PROJECT_WORKSPACE') {
    throw new Error('Durable Project context ownerStateSource is not canonical');
  }
  exactFalse(
    own(raw, 'sourceAuthorityAuthenticated'),
    'ProjectWorkspaceContextResolutionV1.sourceAuthorityAuthenticated',
  );
  exactFalse(
    own(raw, 'retrievalAuthorized'),
    'ProjectWorkspaceContextResolutionV1.retrievalAuthorized',
  );
  exactFalse(
    own(raw, 'executionAuthorized'),
    'ProjectWorkspaceContextResolutionV1.executionAuthorized',
  );
  exactFalse(
    own(raw, 'mutationAuthorized'),
    'ProjectWorkspaceContextResolutionV1.mutationAuthorized',
  );
  exactFalse(
    own(raw, 'policyAuthority'),
    'ProjectWorkspaceContextResolutionV1.policyAuthority',
  );

  return deepFreeze({
    schemaVersion: 1,
    workspaceRevision,
    projectId,
    projectRevisionId,
    snapshot,
    capsule,
    ownerStateSource: 'DURABLE_PROJECT_WORKSPACE',
    sourceAuthorityAuthenticated: false,
    retrievalAuthorized: false,
    executionAuthorized: false,
    mutationAuthorized: false,
    policyAuthority: false,
  });
}

/**
 * Resolve the exact parent Project context from the owner-injected canonical
 * ProjectWorkspace resolver before projecting task-bound child-visible data.
 *
 * The resolver is a dependency, not a new persistence authority. Production
 * wiring must supply ProjectWorkspaceRepository.resolveContext (or an
 * equivalent canonical owner boundary). Resolver output is revalidated and may
 * not grant retrieval, execution, mutation, policy, or source-authentication
 * authority.
 *
 * Caller-controlled envelopes/tasks are normalized before the first await so an
 * in-flight caller cannot swap identity, task inputs, or the requested Project
 * revision while durable owner state is being resolved.
 */
export async function projectDurableSubagentTaskContextV1(
  input = {},
  resolveProjectContext,
) {
  if (typeof resolveProjectContext !== 'function') {
    throw new Error('A canonical ProjectWorkspace context resolver is required');
  }

  const request = strictRecord(
    input,
    DURABLE_TASK_CONTEXT_REQUEST_KEYS,
    'DurableSubagentTaskContextRequestV1',
  );
  if (own(request, 'schemaVersion') !== SUBAGENT_CONTEXT_PROJECTION_VERSION) {
    throw new Error('Unsupported DurableSubagentTaskContextRequestV1 schemaVersion');
  }

  const normalizedEnvelope = normalizeAllowedSubagentAuthorityEnvelopeV1(own(request, 'authorityEnvelope'));
  const authorityEnvelope = deepFreeze({
    ...normalizedEnvelope,
    toolDescriptors: [],
  });
  const taskEnvelope = deepFreeze(
    normalizeSubagentTaskEnvelopeV1(own(request, 'taskEnvelope')),
  );
  const expectedParentAgentId = exactId(
    own(request, 'expectedParentAgentId'),
    'expectedParentAgentId',
  );
  const expectedChildAgentId = exactId(
    own(request, 'expectedChildAgentId'),
    'expectedChildAgentId',
  );
  const expectedTaskId = exactId(
    own(request, 'expectedTaskId'),
    'expectedTaskId',
  );
  const expectedProjectRevisionId = exactId(
    own(request, 'expectedProjectRevisionId'),
    'expectedProjectRevisionId',
  );

  if (taskEnvelope.projectId !== authorityEnvelope.projectId) {
    throw new Error('Subagent task projectId does not match authority envelope');
  }
  if (taskEnvelope.parentAgentId !== authorityEnvelope.parentAgentId
      || taskEnvelope.parentAgentId !== expectedParentAgentId) {
    throw new Error('Subagent task parentAgentId binding mismatch');
  }
  if (taskEnvelope.childAgentId !== authorityEnvelope.childAgentId
      || taskEnvelope.childAgentId !== expectedChildAgentId) {
    throw new Error('Subagent task childAgentId binding mismatch');
  }
  if (taskEnvelope.taskId !== authorityEnvelope.taskId
      || taskEnvelope.taskId !== expectedTaskId) {
    throw new Error('Subagent task taskId binding mismatch');
  }

  const allowedSourceIds = new Set(authorityEnvelope.sourceIds);
  const allowedArtifactIds = new Set(authorityEnvelope.artifactIds);
  for (const sourceRef of taskEnvelope.inputSourceRefs) {
    if (!allowedSourceIds.has(sourceRef.sourceId)) {
      throw new Error(`Subagent task source is outside child authority: ${sourceRef.sourceId}`);
    }
  }
  for (const artifactRef of taskEnvelope.inputArtifactRefs) {
    if (!allowedArtifactIds.has(artifactRef.artifactId)) {
      throw new Error(`Subagent task artifact is outside child authority: ${artifactRef.artifactId}`);
    }
  }

  const resolverRequest = {
    projectId: authorityEnvelope.projectId,
    expectedProjectRevisionId,
  };
  if (Object.hasOwn(request, 'capsuleId')) {
    resolverRequest.capsuleId = exactId(own(request, 'capsuleId'), 'capsuleId');
  }
  deepFreeze(resolverRequest);

  const resolvedRaw = await resolveProjectContext(resolverRequest);
  const resolved = normalizeDurableProjectContextResolutionV1(
    resolvedRaw,
    resolverRequest,
  );

  const projected = projectSubagentTaskContextV1({
    schemaVersion: SUBAGENT_CONTEXT_PROJECTION_VERSION,
    authorityEnvelope,
    taskEnvelope,
    expectedParentAgentId,
    expectedChildAgentId,
    expectedTaskId,
    expectedProjectRevisionId,
    parentProjectSnapshot: resolved.snapshot,
    priorParentCapsule: resolved.capsule,
  });

  return deepFreeze({
    ...projected,
    workspaceRevision: resolved.workspaceRevision,
    ownerStateSource: resolved.ownerStateSource,
    sourceAuthorityAuthenticated: false,
    sourceTrust: 'DURABLE_OWNER_STATE_SOURCE_AUTHORITY_NOT_AUTHENTICATED',
  });
}
