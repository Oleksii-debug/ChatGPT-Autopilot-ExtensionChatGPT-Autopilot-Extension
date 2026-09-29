import {
  ExecutionOwnershipState,
  TrustedExecutionVerificationOutcome,
  normalizeExecutionOwnershipV1,
  normalizeTrustedExecutionVerificationRecordV1,
} from './execution-plane-ownership.js';
import {
  SpecialistProviderExecutionStatus,
  normalizeSpecialistProviderExecutionV1,
} from './specialist-provider-execution.js';
import { normalizeSpecialistSelectionV1 } from './specialist-registry.js';
import { normalizeSpecialistHandoffV1 } from './universal-agent-contracts.js';

export const SPECIALIST_TRUSTED_VERIFICATION_PRODUCER_VERSION = 1;

const INPUT_KEYS = new Set([
  'providerExecution',
  'executionOwnership',
  'selection',
  'handoff',
  'resultArtifactIds',
  'verificationId',
  'expectedOutcome',
  'at',
]);

const PROOF_KEYS = new Set([
  'recordId',
  'outcome',
  'verification',
  'evidenceArtifacts',
  'recordedAt',
  'validThrough',
]);

const DEPENDENCY_KEYS = new Set(['resolveTrustedSpecialistExecutionVerification']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_RESULT_ARTIFACTS = 128;

function snapshot(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function denseArray(value, label, max = MAX_RESULT_ARTIFACTS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a bounded plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new Error(label + ' must be a bounded plain array');
  }
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' contains non-canonical array fields');
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '[' + index + '] must be an enumerable own data property');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must use exact canonical identity representation');
  }
  return value;
}

function ids(value, label) {
  const out = denseArray(value, label).map((item, index) => id(item, label + '[' + index + ']'));
  if (new Set(out).size !== out.length) throw new Error(label + ' contains duplicate identity');
  return Object.freeze([...out].sort(compareId));
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must use canonical UTC');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must use canonical UTC');
  }
  return value;
}

function compareId(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function assertSame(left, right, label) {
  if (left !== right) throw new Error(label + ' identity mismatch');
}

function assertSameIds(left, right, label) {
  const actual = [...left].sort(compareId);
  const expected = [...right].sort(compareId);
  if (actual.length !== expected.length
      || actual.some((value, index) => value !== expected[index])) {
    throw new Error(label + ' identity mismatch');
  }
}

function canonicalBindingKey(value, label) {
  const key = JSON.stringify(value);
  if (!key || key.length > 200_000) {
    throw new Error(label + ' exceeds canonical binding bound');
  }
  return key;
}

function assertChronology(
  record,
  providerExecution,
  ownership,
  at,
  resultArtifactIds,
) {
  const durableVerificationLowerBound = Math.max(
    Date.parse(providerExecution.updatedAt),
    Date.parse(ownership.updatedAt),
  );
  const resultLowerBound = Date.parse(providerExecution.preparedAt);
  const resultIds = new Set(resultArtifactIds);
  const atMs = Date.parse(at);
  if (ownership.state === ExecutionOwnershipState.OWNED
      && atMs > Date.parse(ownership.leaseUntil)) {
    throw new Error('Trusted Specialist verification cannot outlive the current execution lease');
  }
  if (Date.parse(providerExecution.updatedAt) > atMs || Date.parse(ownership.updatedAt) > atMs) {
    throw new Error('Trusted Specialist verification request predates durable execution state');
  }
  const verifiedAt = Date.parse(record.verification.verifiedAt);
  if (verifiedAt < durableVerificationLowerBound || verifiedAt > atMs) {
    throw new Error('Trusted Specialist verification chronology is invalid');
  }
  const recordedAt = Date.parse(record.recordedAt);
  if (recordedAt < verifiedAt || recordedAt > atMs) {
    throw new Error('Trusted Specialist verification record chronology is invalid');
  }
  if (Date.parse(record.validThrough) < recordedAt || Date.parse(record.validThrough) < atMs) {
    throw new Error('Trusted Specialist verification record is stale');
  }
  for (const artifact of record.evidenceArtifacts) {
    const createdAt = Date.parse(artifact.createdAt);
    const lowerBound = resultIds.has(artifact.artifactId)
      ? resultLowerBound
      : durableVerificationLowerBound;
    if (createdAt < lowerBound || createdAt > verifiedAt) {
      throw new Error('Trusted Specialist evidence chronology is invalid: ' + artifact.artifactId);
    }
  }
}

function assertIndependentVerifier(record, providerExecution, ownership, selection) {
  const verifierId = record.verification.verifierId;
  if (!verifierId) throw new Error('Trusted Specialist verification requires an independent verifier');
  const forbidden = new Set([
    ownership.ownerId,
    providerExecution.agentId,
    providerExecution.providerId,
    selection.specialistId,
  ]);
  if (forbidden.has(verifierId)) {
    throw new Error('Trusted Specialist verification cannot be self-issued by execution/provider identity');
  }
}

function assertResultCoverage(resultArtifactIds, record, expectedOutcome) {
  const evidenceIds = new Set(record.evidenceArtifacts.map(item => item.artifactId));
  if (expectedOutcome === TrustedExecutionVerificationOutcome.EFFECT_VERIFIED) {
    if (!resultArtifactIds.length) {
      throw new Error('EFFECT_VERIFIED requires Specialist result artifact identities');
    }
    const missing = resultArtifactIds.filter(artifactId => !evidenceIds.has(artifactId));
    if (missing.length) {
      throw new Error('Trusted Specialist verification does not hash-cover result artifacts: ' + missing.join(', '));
    }
    return;
  }
  if (resultArtifactIds.length) {
    throw new Error('NO_EFFECT_VERIFIED cannot carry Specialist result artifact identities');
  }
}

function assertOutcomeAdmission(expectedOutcome, providerExecution, ownership, resultArtifactIds) {
  if (expectedOutcome === TrustedExecutionVerificationOutcome.EFFECT_VERIFIED) {
    if (ownership.state !== ExecutionOwnershipState.OWNED) {
      throw new Error('EFFECT_VERIFIED requires current OWNED execution');
    }
    if (providerExecution.status !== SpecialistProviderExecutionStatus.PROVIDER_SUCCEEDED
        || providerExecution.providerSucceeded !== true
        || providerExecution.reconciliationRequired
        || !providerExecution.effectEvidence) {
      throw new Error('EFFECT_VERIFIED requires durable provider success before independent verification');
    }
    if (!resultArtifactIds.length) {
      throw new Error('EFFECT_VERIFIED requires Specialist result artifact identities');
    }
    return;
  }
  if (expectedOutcome === TrustedExecutionVerificationOutcome.NO_EFFECT_VERIFIED) {
    if (ownership.state !== ExecutionOwnershipState.RECONCILE) {
      throw new Error('NO_EFFECT_VERIFIED requires current RECONCILE execution');
    }
    if (providerExecution.status === SpecialistProviderExecutionStatus.PROVIDER_SUCCEEDED
        || providerExecution.providerSucceeded) {
      throw new Error('NO_EFFECT_VERIFIED cannot be produced from durable provider success');
    }
    if (resultArtifactIds.length) {
      throw new Error('NO_EFFECT_VERIFIED cannot carry Specialist result artifact identities');
    }
    return;
  }
  throw new Error('Trusted Specialist verification outcome is invalid');
}

/**
 * Produces the existing TrustedExecutionVerificationRecordV1 only after an
 * injected independent verifier resolves the exact durable Specialist
 * execution identity. Provider success is merely an EFFECT_VERIFIED
 * prerequisite; it never supplies verification authority.
 *
 * This module owns no verifier, ledger, artifact store, scheduler, provider,
 * policy, recovery, execution, or completion authority.
 */
export async function produceTrustedSpecialistExecutionVerificationRecordV1(
  input = {},
  dependencies = {},
) {
  const raw = snapshot(input, INPUT_KEYS, 'Trusted Specialist verification production request');
  for (const key of INPUT_KEYS) {
    if (!Object.hasOwn(raw, key)) {
      throw new Error('Trusted Specialist verification production request requires ' + key);
    }
  }

  const dependencySnapshot = snapshot(
    dependencies,
    DEPENDENCY_KEYS,
    'Trusted Specialist verification dependencies',
  );
  const resolver = dependencySnapshot.resolveTrustedSpecialistExecutionVerification;
  if (typeof resolver !== 'function') {
    throw new Error('canonical independent Specialist verification resolver is required');
  }

  const providerExecution = normalizeSpecialistProviderExecutionV1(raw.providerExecution);
  const ownership = normalizeExecutionOwnershipV1(raw.executionOwnership);
  const selection = normalizeSpecialistSelectionV1(raw.selection);
  const handoff = normalizeSpecialistHandoffV1(raw.handoff);
  const resultArtifactIds = ids(raw.resultArtifactIds, 'resultArtifactIds');
  const verificationId = id(raw.verificationId, 'verificationId');
  const at = timestamp(raw.at, 'at');
  const expectedOutcome = raw.expectedOutcome;

  assertOutcomeAdmission(expectedOutcome, providerExecution, ownership, resultArtifactIds);
  if (expectedOutcome === TrustedExecutionVerificationOutcome.EFFECT_VERIFIED
      && Date.parse(at) > Date.parse(ownership.leaseUntil)) {
    throw new Error('Trusted Specialist verification cannot outlive the current execution lease');
  }

  assertSame(providerExecution.planId, ownership.planId, 'planId');
  assertSame(providerExecution.nodeId, ownership.nodeId, 'nodeId');
  assertSame(providerExecution.leaseId, ownership.leaseId, 'leaseId');
  assertSame(providerExecution.leaseUntil, ownership.leaseUntil, 'leaseUntil');
  assertSame(providerExecution.agentId, ownership.ownerId, 'ownerId');
  assertSame(selection.executionPlane, ownership.ownerPlane, 'executionPlane');
  assertSame(selection.providerId, providerExecution.providerId, 'providerId');
  assertSame(selection.specialistId, handoff.specialistId, 'specialistId');
  assertSame(handoff.handoffId, providerExecution.handoffId, 'handoffId');
  assertSameIds(
    handoff.requestedCapabilityIds,
    selection.requestedCapabilityIds,
    'requestedCapabilityIds',
  );
  if (Date.parse(handoff.createdAt) > Date.parse(providerExecution.preparedAt)) {
    throw new Error('Specialist handoff cannot postdate provider execution preparation');
  }

  const providerExecutionBindingKey = canonicalBindingKey(
    providerExecution,
    'providerExecutionBindingKey',
  );
  const executionOwnershipBindingKey = canonicalBindingKey(
    ownership,
    'executionOwnershipBindingKey',
  );
  const selectionBindingKey = canonicalBindingKey(selection, 'selectionBindingKey');
  const handoffBindingKey = canonicalBindingKey(handoff, 'handoffBindingKey');

  const lookup = freeze({
    schemaVersion: SPECIALIST_TRUSTED_VERIFICATION_PRODUCER_VERSION,
    taskId: ownership.taskId,
    planId: ownership.planId,
    nodeId: ownership.nodeId,
    effectId: ownership.effectId,
    policyEnvelopeId: ownership.policyEnvelopeId,
    executionId: ownership.leaseId,
    executionOwnershipRevision: ownership.revision,
    executionOwnershipBindingKey,
    ownerId: ownership.ownerId,
    ownerPlane: ownership.ownerPlane,
    registryId: selection.registryId,
    registryRevision: selection.registryRevision,
    registryBindingKey: selection.registryBindingKey,
    specialistId: selection.specialistId,
    providerId: providerExecution.providerId,
    providerConfigRevision: providerExecution.providerConfig.revision,
    providerExecutionBindingKey,
    definitionRevision: selection.definitionRevision,
    requestedCapabilityIds: selection.requestedCapabilityIds,
    grantedToolIds: selection.grantedToolIds,
    selectionBindingKey,
    handoffId: providerExecution.handoffId,
    handoffBindingKey,
    handoffCreatedAt: handoff.createdAt,
    parentInvocationId: handoff.parentInvocationId,
    conversationId: providerExecution.conversationId,
    resultContractId: selection.resultContractId,
    resultArtifactIds,
    verificationId,
    expectedOutcome,
    providerStatus: providerExecution.providerStatus,
    providerSucceeded: providerExecution.providerSucceeded,
    providerEffectEvidence: providerExecution.effectEvidence,
    providerUpdatedAt: providerExecution.providerUpdatedAt,
    providerObservedAt: providerExecution.providerObservedAt,
    providerExecutionUpdatedAt: providerExecution.updatedAt,
    requestedAt: at,
  });

  const rawProof = await resolver(lookup);
  const proof = snapshot(rawProof, PROOF_KEYS, 'Trusted Specialist verifier proof');
  for (const key of PROOF_KEYS) {
    if (!Object.hasOwn(proof, key)) {
      throw new Error('Trusted Specialist verifier proof requires ' + key);
    }
  }
  if (proof.outcome !== expectedOutcome) {
    throw new Error('Independent Specialist verifier outcome does not match requested outcome');
  }

  const trustedRecord = normalizeTrustedExecutionVerificationRecordV1({
    schemaVersion: 1,
    recordId: proof.recordId,
    taskId: ownership.taskId,
    planId: ownership.planId,
    nodeId: ownership.nodeId,
    effectId: ownership.effectId,
    policyEnvelopeId: ownership.policyEnvelopeId,
    executionId: ownership.leaseId,
    outcome: proof.outcome,
    verification: proof.verification,
    evidenceArtifacts: proof.evidenceArtifacts,
    recordedAt: proof.recordedAt,
    validThrough: proof.validThrough,
  });

  if (trustedRecord.verification.verificationId !== verificationId) {
    throw new Error('Independent Specialist verifier verificationId mismatch');
  }
  if (trustedRecord.verification.effectId !== ownership.effectId
      || trustedRecord.verification.executionId !== ownership.leaseId) {
    throw new Error('Independent Specialist verifier effect/lease binding mismatch');
  }
  if (trustedRecord.verification.verificationAuthorityId !== ownership.policyEnvelopeId) {
    throw new Error('Independent Specialist verifier policy authority mismatch');
  }

  assertIndependentVerifier(trustedRecord, providerExecution, ownership, selection);
  assertResultCoverage(resultArtifactIds, trustedRecord, expectedOutcome);
  assertChronology(trustedRecord, providerExecution, ownership, at, resultArtifactIds);

  return freeze({
    schemaVersion: SPECIALIST_TRUSTED_VERIFICATION_PRODUCER_VERSION,
    trustedRecord,
    lookup,
    resultArtifactIds,
    completionAuthorized: false,
    executionAuthorized: false,
    retryDispatched: false,
  });
}
