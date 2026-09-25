import { ExecutionOwnershipState, normalizeExecutionOwnershipV1 } from './execution-plane-ownership.js';
import { normalizeAgentCheckpointHeadV1, verifyAgentCheckpointV1 } from './agent-checkpoint.js';
import {
  WorldStateFreshnessStatus,
  assessWorldStateSnapshotFreshnessV1,
  normalizeWorldStateObservationV1,
  normalizeWorldStateSnapshotV1,
} from './world-state-contract.js';

export const CROSS_DEVICE_CONTINUATION_VERSION = 1;
export const MAX_CROSS_DEVICE_CONTINUATION_TTL_MS = 60 * 60 * 1000;
export const CrossDeviceContinuationStatus = Object.freeze({
  READY_FOR_CANONICAL_ACCEPT: 'READY_FOR_CANONICAL_ACCEPT',
  BLOCKED: 'BLOCKED',
  RECONCILE_REQUIRED: 'RECONCILE_REQUIRED',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PLANES = new Set(['LOCAL', 'CLOUD', 'REMOTE']);
const STATES = new Set(Object.values(ExecutionOwnershipState));
const REQUEST_KEYS = new Set([
  'schemaVersion','continuationId','projectId','agentId','jobId','taskId','planId','nodeId','effectId',
  'policyEnvelopeId','sourceOwnerId','sourceDeviceId','targetDeviceId','targetPlane','handoffId','checkpointId',
  'requestedAt','expiresAt',
]);
const OPTION_KEYS = new Set([
  'resolveExecutionOwnership','resolveHandoffCheckpointBinding','resolveAgentCheckpoint','resolveAgentHead',
  'resolveTargetWorldState','assessmentAt','cryptoApi',
]);
const OWNERSHIP_KEYS = new Set([
  'schemaVersion','taskId','planId','nodeId','effectId','policyEnvelopeId','state','ownerPlane','ownerId','leaseId',
  'leaseUntil','handoffToPlane','handoffId','ambiguityReason','updatedAt','revision',
]);
const WORLD_KEYS = new Set(['snapshot','currentObservations']);
const HANDOFF_CHECKPOINT_KEYS = new Set([
  'schemaVersion','taskId','planId','nodeId','effectId','handoffId','executionOwnershipRevision',
  'checkpointId','checkpointDigest','boundAt',
]);

function record(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be a plain data object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(label + ' must be a plain data object');
  const desc = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(desc)) {
    if (typeof key !== 'string' || !keys.has(key)) throw new Error(label + ' contains unknown field: ' + String(key));
    const d = desc[key];
    if (!d || d.enumerable !== true || !Object.prototype.hasOwnProperty.call(d, 'value')) {
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    out[key] = d.value;
  }
  return out;
}

function array(value, label, max = 256) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error(label + ' must be a bounded plain array');
  const desc = Object.getOwnPropertyDescriptors(value);
  const ld = desc.length;
  if (!ld || !Object.prototype.hasOwnProperty.call(ld, 'value') || !Number.isSafeInteger(ld.value) || ld.value < 0 || ld.value > max) {
    throw new Error(label + ' must be a bounded plain array');
  }
  const out = new Array(ld.value);
  for (let i = 0; i < ld.value; i += 1) {
    const d = desc[String(i)];
    if (!d || d.enumerable !== true || !Object.prototype.hasOwnProperty.call(d, 'value')) throw new Error(label + ' must be dense data');
    out[i] = d.value;
  }
  for (const key of Reflect.ownKeys(desc)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= ld.value) {
      throw new Error(label + ' contains non-index data');
    }
  }
  return out;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) throw new Error(label + ' must use exact canonical identity representation');
  return value;
}
function timestamp(value, label, optional = false) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value) throw new Error(label + ' must use exact canonical timestamp representation');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error(label + ' must use exact canonical timestamp representation');
  return value;
}
function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(label + ' must use exact lowercase sha256 representation');
  return value;
}
function exactEnum(value, allowed, label, optional = false) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !allowed.has(value)) throw new Error(label + ' must use exact canonical enum representation');
  return value;
}
function method(target, name) {
  const d = Object.getOwnPropertyDescriptor(target, name);
  if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || typeof d.value !== 'function') throw new Error(name + ' must be a data method');
  return d.value;
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeRequest(input) {
  const raw = record(input, 'CrossDeviceContinuationRequestV1', REQUEST_KEYS);
  if (raw.schemaVersion !== 1) throw new Error('CrossDeviceContinuationRequestV1 schemaVersion must be numeric 1');
  const requestedAt = timestamp(raw.requestedAt, 'requestedAt');
  const expiresAt = timestamp(raw.expiresAt, 'expiresAt');
  const ttl = Date.parse(expiresAt) - Date.parse(requestedAt);
  if (ttl <= 0 || ttl > MAX_CROSS_DEVICE_CONTINUATION_TTL_MS) throw new Error('Cross-device continuation expiry is invalid');
  const sourceDeviceId = id(raw.sourceDeviceId, 'sourceDeviceId');
  const targetDeviceId = id(raw.targetDeviceId, 'targetDeviceId');
  if (sourceDeviceId === targetDeviceId) throw new Error('Cross-device continuation requires distinct source and target devices');
  return deepFreeze({
    schemaVersion: 1,
    continuationId: id(raw.continuationId, 'continuationId'), projectId: id(raw.projectId, 'projectId'),
    agentId: id(raw.agentId, 'agentId'), jobId: id(raw.jobId, 'jobId'), taskId: id(raw.taskId, 'taskId'),
    planId: id(raw.planId, 'planId'), nodeId: id(raw.nodeId, 'nodeId'), effectId: id(raw.effectId, 'effectId'),
    policyEnvelopeId: id(raw.policyEnvelopeId, 'policyEnvelopeId'), sourceOwnerId: id(raw.sourceOwnerId, 'sourceOwnerId'),
    sourceDeviceId, targetDeviceId, targetPlane: exactEnum(raw.targetPlane, PLANES, 'targetPlane'),
    handoffId: id(raw.handoffId, 'handoffId'), checkpointId: id(raw.checkpointId, 'checkpointId'), requestedAt, expiresAt,
  });
}

function normalizeOptions(input) {
  const raw = record(input, 'Cross-device continuation options', OPTION_KEYS);
  return Object.freeze({
    resolveExecutionOwnership: method(raw, 'resolveExecutionOwnership'),
    resolveHandoffCheckpointBinding: method(raw, 'resolveHandoffCheckpointBinding'),
    resolveAgentCheckpoint: method(raw, 'resolveAgentCheckpoint'),
    resolveAgentHead: method(raw, 'resolveAgentHead'),
    resolveTargetWorldState: method(raw, 'resolveTargetWorldState'),
    assessmentAt: timestamp(raw.assessmentAt, 'assessmentAt'),
    cryptoApi: raw.cryptoApi,
  });
}

function normalizeExactOwnership(input) {
  const raw = record(input, 'ExecutionOwnershipV1', OWNERSHIP_KEYS);
  if (raw.schemaVersion !== 1) throw new Error('ExecutionOwnershipV1 schemaVersion must be numeric 1');
  exactEnum(raw.state, STATES, 'ExecutionOwnershipV1.state');
  exactEnum(raw.ownerPlane, PLANES, 'ExecutionOwnershipV1.ownerPlane', true);
  exactEnum(raw.handoffToPlane, PLANES, 'ExecutionOwnershipV1.handoffToPlane', true);
  timestamp(raw.leaseUntil, 'ExecutionOwnershipV1.leaseUntil', true);
  timestamp(raw.updatedAt, 'ExecutionOwnershipV1.updatedAt');
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) throw new Error('ExecutionOwnershipV1.revision must be a positive safe integer');
  return normalizeExecutionOwnershipV1(raw);
}

function normalizeHandoffCheckpointBinding(input) {
  const raw = record(input, 'CrossDeviceHandoffCheckpointBindingV1', HANDOFF_CHECKPOINT_KEYS);
  if (raw.schemaVersion !== 1) throw new Error('CrossDeviceHandoffCheckpointBindingV1 schemaVersion must be numeric 1');
  if (!Number.isSafeInteger(raw.executionOwnershipRevision) || raw.executionOwnershipRevision < 1) {
    throw new Error('CrossDeviceHandoffCheckpointBindingV1.executionOwnershipRevision must be a positive safe integer');
  }
  return Object.freeze({
    schemaVersion: 1,
    taskId: id(raw.taskId, 'CrossDeviceHandoffCheckpointBindingV1.taskId'),
    planId: id(raw.planId, 'CrossDeviceHandoffCheckpointBindingV1.planId'),
    nodeId: id(raw.nodeId, 'CrossDeviceHandoffCheckpointBindingV1.nodeId'),
    effectId: id(raw.effectId, 'CrossDeviceHandoffCheckpointBindingV1.effectId'),
    handoffId: id(raw.handoffId, 'CrossDeviceHandoffCheckpointBindingV1.handoffId'),
    executionOwnershipRevision: raw.executionOwnershipRevision,
    checkpointId: id(raw.checkpointId, 'CrossDeviceHandoffCheckpointBindingV1.checkpointId'),
    checkpointDigest: digest(raw.checkpointDigest, 'CrossDeviceHandoffCheckpointBindingV1.checkpointDigest'),
    boundAt: timestamp(raw.boundAt, 'CrossDeviceHandoffCheckpointBindingV1.boundAt'),
  });
}

function outcome(status, reasonCode, request, ownership, checkpoint, head, extra = {}) {
  return deepFreeze({
    schemaVersion: 1, status, reasonCode,
    continuationId: request.continuationId, projectId: request.projectId, agentId: request.agentId, jobId: request.jobId,
    taskId: request.taskId, planId: request.planId, nodeId: request.nodeId, effectId: request.effectId,
    policyEnvelopeId: request.policyEnvelopeId, sourceOwnerId: request.sourceOwnerId,
    sourceDeviceId: request.sourceDeviceId, targetDeviceId: request.targetDeviceId,
    sourcePlane: ownership.ownerPlane, targetPlane: request.targetPlane, handoffId: request.handoffId,
    executionOwnershipRevision: ownership.revision,
    checkpointId: checkpoint ? checkpoint.checkpointId : request.checkpointId,
    checkpointDigest: checkpoint ? checkpoint.checkpointDigest : '',
    checkpointSnapshotArtifactId: checkpoint ? checkpoint.snapshotArtifact.artifactId : '',
    checkpointSnapshotSha256: checkpoint ? checkpoint.snapshotArtifact.sha256 : '',
    currentPlanRevision: head ? head.planRevision : 0,
    currentInternalStateRevision: head ? head.internalStateRevision : 0,
    currentExactEffectLedgerRevision: head ? head.exactEffectLedgerRevision : 0,
    advisoryOnly: true, handoffAuthorized: false, acceptAuthorized: false, executionAuthorized: false,
    resumeAuthorized: false, mutationAuthorized: false, credentialUseAuthorized: false, policyDecisionGranted: false,
    sourceDeviceAuthenticated: false, targetDeviceAuthenticated: false,
    requiresCanonicalDeviceAuthentication: true, requiresCanonicalAcceptExecutionHandoff: true,
    requiresFreshPolicy: true, requiresFreshStateRecheck: true, requiresCheckpointSnapshotVerification: true,
    requiresExactEffectReconciliation: status === CrossDeviceContinuationStatus.RECONCILE_REQUIRED,
    ...extra,
  });
}

export async function assessCrossDeviceContinuationV1(input, options) {
  const request = normalizeRequest(input);
  const trusted = normalizeOptions(options);
  const atMs = Date.parse(trusted.assessmentAt);
  const requestedMs = Date.parse(request.requestedAt);
  const expiresMs = Date.parse(request.expiresAt);
  if (atMs < requestedMs) throw new Error('Cross-device continuation assessment cannot predate request');

  const ownership = normalizeExactOwnership(await trusted.resolveExecutionOwnership(Object.freeze({
    taskId: request.taskId, planId: request.planId, nodeId: request.nodeId, effectId: request.effectId,
  })));
  if (ownership.taskId !== request.taskId || ownership.planId !== request.planId || ownership.nodeId !== request.nodeId
      || ownership.effectId !== request.effectId || ownership.policyEnvelopeId !== request.policyEnvelopeId
      || ownership.ownerId !== request.sourceOwnerId) {
    throw new Error('Cross-device continuation does not match canonical execution ownership');
  }
  if (ownership.state === ExecutionOwnershipState.RECONCILE || ownership.state === ExecutionOwnershipState.MANUAL_REVIEW) {
    return outcome(CrossDeviceContinuationStatus.RECONCILE_REQUIRED, 'EXECUTION_RECONCILIATION_REQUIRED', request, ownership, null, null);
  }
  if (ownership.state !== ExecutionOwnershipState.HANDOFF_PENDING) {
    return outcome(CrossDeviceContinuationStatus.BLOCKED, 'EXECUTION_HANDOFF_NOT_PENDING', request, ownership, null, null);
  }
  if (ownership.handoffId !== request.handoffId || ownership.handoffToPlane !== request.targetPlane) {
    throw new Error('Cross-device continuation handoff identity is stale or mismatched');
  }
  if (requestedMs < Date.parse(ownership.updatedAt)) throw new Error('Cross-device continuation request predates canonical handoff state');
  if (expiresMs > Date.parse(ownership.leaseUntil)) {
    return outcome(CrossDeviceContinuationStatus.BLOCKED, 'REQUEST_OUTLIVES_SOURCE_LEASE', request, ownership, null, null);
  }
  if (atMs > Date.parse(ownership.leaseUntil)) {
    return outcome(CrossDeviceContinuationStatus.RECONCILE_REQUIRED, 'SOURCE_EXECUTION_LEASE_EXPIRED', request, ownership, null, null);
  }
  if (atMs >= expiresMs) {
    return outcome(CrossDeviceContinuationStatus.BLOCKED, 'CONTINUATION_REQUEST_EXPIRED', request, ownership, null, null);
  }

  const checkpoint = await verifyAgentCheckpointV1(
    await trusted.resolveAgentCheckpoint(Object.freeze({checkpointId: request.checkpointId, agentId: request.agentId, jobId: request.jobId, planId: request.planId})),
    trusted.cryptoApi === undefined ? {} : {cryptoApi: trusted.cryptoApi},
  );
  if (checkpoint.checkpointId !== request.checkpointId || checkpoint.agentId !== request.agentId
      || checkpoint.jobId !== request.jobId || checkpoint.planId !== request.planId) {
    throw new Error('Cross-device continuation checkpoint identity is stale or mismatched');
  }
  if (Date.parse(checkpoint.createdAt) > requestedMs) throw new Error('Cross-device continuation checkpoint cannot postdate request');

  const handoffCheckpoint = normalizeHandoffCheckpointBinding(await trusted.resolveHandoffCheckpointBinding(Object.freeze({
    taskId: request.taskId, planId: request.planId, nodeId: request.nodeId, effectId: request.effectId,
    handoffId: ownership.handoffId, executionOwnershipRevision: ownership.revision,
  })));
  if (handoffCheckpoint.taskId !== request.taskId || handoffCheckpoint.planId !== request.planId
      || handoffCheckpoint.nodeId !== request.nodeId || handoffCheckpoint.effectId !== request.effectId
      || handoffCheckpoint.handoffId !== ownership.handoffId
      || handoffCheckpoint.executionOwnershipRevision !== ownership.revision) {
    throw new Error('Cross-device handoff checkpoint binding does not match canonical execution ownership');
  }
  const boundAtMs = Date.parse(handoffCheckpoint.boundAt);
  if (boundAtMs < Date.parse(ownership.updatedAt) || boundAtMs < Date.parse(checkpoint.createdAt) || boundAtMs > requestedMs) {
    throw new Error('Cross-device handoff checkpoint binding chronology is invalid');
  }
  if (handoffCheckpoint.checkpointId !== checkpoint.checkpointId
      || handoffCheckpoint.checkpointDigest !== checkpoint.checkpointDigest) {
    return outcome(CrossDeviceContinuationStatus.BLOCKED, 'HANDOFF_CHECKPOINT_BINDING_MISMATCH', request, ownership, checkpoint, null);
  }

  const head = normalizeAgentCheckpointHeadV1(await trusted.resolveAgentHead(Object.freeze({
    agentId: request.agentId, jobId: request.jobId, planId: request.planId,
  })));
  if (head.agentId !== request.agentId || head.jobId !== request.jobId || head.planId !== request.planId) {
    throw new Error('Cross-device continuation Agent head identity is stale or mismatched');
  }
  if (Date.parse(head.observedAt) < Date.parse(checkpoint.createdAt) || Date.parse(head.observedAt) > atMs) {
    throw new Error('Cross-device continuation Agent head chronology is invalid');
  }
  if (head.unresolvedEffectIds.length) {
    return outcome(CrossDeviceContinuationStatus.RECONCILE_REQUIRED, 'UNRESOLVED_EXTERNAL_EFFECTS', request, ownership, checkpoint, head, {unresolvedEffectCount: head.unresolvedEffectIds.length});
  }
  if (head.planRevision !== checkpoint.planRevision || head.internalStateRevision !== checkpoint.internalStateRevision
      || head.exactEffectLedgerRevision !== checkpoint.exactEffectLedgerRevision || head.policyRevisionId !== checkpoint.policyRevisionId) {
    return outcome(CrossDeviceContinuationStatus.RECONCILE_REQUIRED, 'CHECKPOINT_NOT_CURRENT', request, ownership, checkpoint, head);
  }

  const world = record(await trusted.resolveTargetWorldState(Object.freeze({projectId: request.projectId, targetDeviceId: request.targetDeviceId})), 'CrossDeviceTargetWorldStateV1', WORLD_KEYS);
  const snapshot = normalizeWorldStateSnapshotV1(world.snapshot);
  if (snapshot.scopeId !== request.projectId) throw new Error('Cross-device target world-state scope does not match project');
  if (Date.parse(snapshot.capturedAt) < requestedMs || Date.parse(snapshot.capturedAt) > atMs) {
    return outcome(CrossDeviceContinuationStatus.BLOCKED, 'TARGET_WORLD_STATE_NOT_FRESH_AFTER_REQUEST', request, ownership, checkpoint, head);
  }
  const currentRaw = array(world.currentObservations, 'CrossDeviceTargetWorldStateV1.currentObservations');
  const current = currentRaw.map(normalizeWorldStateObservationV1);
  const target = current.find(item => item.resourceId === request.targetDeviceId);
  if (!target || Date.parse(target.observedAt) < requestedMs) {
    return outcome(CrossDeviceContinuationStatus.BLOCKED, 'TARGET_DEVICE_NOT_OBSERVED_AFTER_REQUEST', request, ownership, checkpoint, head);
  }
  const freshness = assessWorldStateSnapshotFreshnessV1(snapshot, currentRaw, {at: trusted.assessmentAt, requiredResourceIds: [request.targetDeviceId]});
  if (freshness.status !== WorldStateFreshnessStatus.FRESH) {
    return outcome(CrossDeviceContinuationStatus.BLOCKED, 'TARGET_WORLD_STATE_STALE', request, ownership, checkpoint, head, {
      targetWorldStateSnapshotId: snapshot.snapshotId, targetWorldStateSnapshotRevision: snapshot.revision, targetWorldStateDrift: freshness.drift,
    });
  }
  return outcome(CrossDeviceContinuationStatus.READY_FOR_CANONICAL_ACCEPT, 'READY', request, ownership, checkpoint, head, {
    checkpointDigestVerified: true, checkpointSnapshotMaterialVerified: false, targetWorldStateFresh: true,
    targetWorldStateSnapshotId: snapshot.snapshotId, targetWorldStateSnapshotRevision: snapshot.revision,
    targetObservationId: target.observationId, targetObservationRevisionId: target.revisionId,
    targetObservationContentSha256: target.contentSha256, targetObservationObservedAt: target.observedAt,
    targetObservationAuthority: 'UNVERIFIED_OBSERVATION', requiresExactEffectReconciliation: false,
  });
}
