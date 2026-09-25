import {
  buildHumanHandbackResumePacketV1,
  normalizeHumanTakeoverV1,
} from './human-takeover-handback.js';
import {
  assertWorldStatePreconditionFreshV1,
  normalizeWorldStateObservationV1,
} from './world-state-contract.js';
import {
  ExactEffectPhase,
  normalizeExactEffectStateV1,
} from './universal-agent-exact-effect.js';

export const HUMAN_HANDBACK_RESUME_GATE_VERSION = 1;

const REQUEST_KEYS = new Set([
  'handback',
  'worldStatePrecondition',
  'worldStateSnapshot',
  'currentWorldStateObservations',
  'currentJobId',
  'currentPlanId',
  'currentNodeId',
  'at',
]);
const MAX_CURRENT_OBSERVATIONS = 256;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function strictRecord(value, label) {
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
    if (typeof key !== 'string') throw new Error(label + ' contains a symbol field');
    if (!REQUEST_KEYS.has(key)) throw new Error(label + ' contains unknown field: ' + key);
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + ' field ' + key + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function ownRequired(raw, key, label) {
  if (!Object.hasOwn(raw, key)) throw new Error(label + ' requires ' + key);
  return raw[key];
}

function snapshotDenseArray(value, label, max = MAX_CURRENT_OBSERVATIONS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a bounded plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(label + ' must be a bounded plain array');
  }
  const length = lengthDescriptor.value;
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' contains a non-index field');
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '[' + index + '] must be an enumerable own data property');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must be an exact id');
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  }
  return value;
}

function assertAtOrAfter(later, earlier, label) {
  if (Date.parse(later) < Date.parse(earlier)) {
    throw new Error(label + ' violates causal timestamp ordering');
  }
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function normalizeCurrentObservations(value) {
  const snapshot = snapshotDenseArray(value, 'currentWorldStateObservations');
  const normalized = snapshot.map((item, index) => {
    try {
      return normalizeWorldStateObservationV1(item);
    } catch (error) {
      throw new Error('currentWorldStateObservations[' + index + ']: ' + error.message);
    }
  });
  const resourceIds = normalized.map(item => item.resourceId);
  if (new Set(resourceIds).size !== resourceIds.length) {
    throw new Error('currentWorldStateObservations contains duplicate resourceId');
  }
  return normalized;
}

function assertEffectResolution(packet, assessedAt, resolveTrustedExactEffectState) {
  if (!packet.effectId) {
    return {
      effectId: '',
      executionId: '',
      attempt: 0,
      commitId: '',
    };
  }

  if (typeof resolveTrustedExactEffectState !== 'function') {
    throw new Error('effectful handback requires the canonical trusted exact-effect resolver');
  }
  const lookup = freezeDeep({
    schemaVersion: HUMAN_HANDBACK_RESUME_GATE_VERSION,
    takeoverId: packet.takeoverId,
    jobId: packet.jobId,
    planId: packet.planId,
    nodeId: packet.nodeId,
    effectId: packet.effectId,
    executionId: packet.executionId,
    attempt: packet.attempt,
    handbackVerificationId: packet.handbackVerification.verificationId,
  });
  const rawEffectState = resolveTrustedExactEffectState(lookup);
  if (rawEffectState && typeof rawEffectState.then === 'function') {
    throw new Error('canonical trusted exact-effect resolver must synchronously return a durable snapshot');
  }
  if (rawEffectState === undefined || rawEffectState === null) {
    throw new Error('canonical trusted exact-effect resolver did not resolve the interrupted effect');
  }
  const effect = normalizeExactEffectStateV1(rawEffectState);
  if (effect.effectId !== packet.effectId) throw new Error('exact-effect effectId mismatch');
  if (effect.executionId !== packet.executionId) throw new Error('exact-effect executionId mismatch');
  if (effect.attempt !== packet.attempt) throw new Error('exact-effect attempt mismatch');
  if (effect.phase !== ExactEffectPhase.COMMITTED || !effect.commitId) {
    throw new Error('interrupted exact effect must be COMMITTED before handback resume');
  }
  if (Date.parse(effect.updatedAt) < Date.parse(packet.handbackVerification.verifiedAt)) {
    throw new Error('exact-effect resolution must not predate handback verification');
  }
  if (Date.parse(effect.updatedAt) > Date.parse(assessedAt)) {
    throw new Error('exact-effect state cannot postdate resume assessment');
  }
  return {
    effectId: effect.effectId,
    executionId: effect.executionId,
    attempt: effect.attempt,
    commitId: effect.commitId,
  };
}

/**
 * Deterministic admission bridge for the already-canonical human takeover,
 * WorldState and exact-effect authorities. It performs no mutation and grants
 * no new provider/policy/effect capability. resumeAuthorized means only that
 * the existing durable job may be handed back to the canonical runtime.
 */
export function authorizeHumanHandbackResumeV1(input = {}, {
  resolveTrustedExactEffectState,
} = {}) {
  const raw = strictRecord(input, 'HumanHandbackResumeGateRequestV1');
  const handback = normalizeHumanTakeoverV1(
    ownRequired(raw, 'handback', 'HumanHandbackResumeGateRequestV1'),
  );
  const packet = buildHumanHandbackResumePacketV1(handback);
  const currentJobId = exactId(
    ownRequired(raw, 'currentJobId', 'HumanHandbackResumeGateRequestV1'),
    'currentJobId',
  );
  const currentPlanId = exactId(
    ownRequired(raw, 'currentPlanId', 'HumanHandbackResumeGateRequestV1'),
    'currentPlanId',
  );
  const currentNodeId = exactId(
    ownRequired(raw, 'currentNodeId', 'HumanHandbackResumeGateRequestV1'),
    'currentNodeId',
  );
  if (currentJobId !== packet.jobId) throw new Error('handback jobId does not match current durable job');
  if (currentPlanId !== packet.planId) throw new Error('handback planId does not match current durable plan');
  if (currentNodeId !== packet.nodeId) throw new Error('handback nodeId does not match current durable node');
  const assessedAt = exactTimestamp(
    ownRequired(raw, 'at', 'HumanHandbackResumeGateRequestV1'),
    'at',
  );
  assertAtOrAfter(assessedAt, packet.handbackVerification.verifiedAt, 'resume assessment');

  const currentObservations = normalizeCurrentObservations(
    ownRequired(raw, 'currentWorldStateObservations', 'HumanHandbackResumeGateRequestV1'),
  );
  const freshness = assertWorldStatePreconditionFreshV1({
    precondition: ownRequired(raw, 'worldStatePrecondition', 'HumanHandbackResumeGateRequestV1'),
    snapshot: ownRequired(raw, 'worldStateSnapshot', 'HumanHandbackResumeGateRequestV1'),
    currentObservations,
    invocationId: packet.reobservationInvocationId,
    at: assessedAt,
  });

  const resourceBinding = freshness.precondition.requiredBindings.find(
    item => item.resourceId === packet.resourceId,
  );
  if (!resourceBinding) {
    throw new Error('world-state precondition does not bind takeover resource');
  }
  if (Date.parse(freshness.precondition.createdAt)
      < Date.parse(packet.handbackVerification.verifiedAt)) {
    throw new Error('world-state precondition must be created after handback verification');
  }

  const currentResource = currentObservations.find(
    item => item.resourceId === packet.resourceId,
  );
  if (!currentResource) {
    throw new Error('current world state does not contain takeover resource');
  }
  if (Date.parse(currentResource.observedAt)
      < Date.parse(packet.handbackVerification.verifiedAt)) {
    throw new Error('takeover resource must be freshly observed after handback verification');
  }

  const effect = assertEffectResolution(packet, assessedAt, resolveTrustedExactEffectState);

  return freezeDeep({
    schemaVersion: HUMAN_HANDBACK_RESUME_GATE_VERSION,
    takeoverId: packet.takeoverId,
    takeoverRevision: handback.revision,
    jobId: packet.jobId,
    planId: packet.planId,
    nodeId: packet.nodeId,
    resourceId: packet.resourceId,
    handbackVerificationId: packet.handbackVerification.verificationId,
    worldStateGuardId: freshness.precondition.guardId,
    worldStateSnapshotId: freshness.snapshot.snapshotId,
    worldStateSnapshotRevision: freshness.snapshot.revision,
    worldStateObservedAt: currentResource.observedAt,
    exactEffectId: effect.effectId,
    exactEffectExecutionId: effect.executionId,
    exactEffectAttempt: effect.attempt,
    exactEffectCommitId: effect.commitId,
    assessedAt,
    resumeAuthorized: true,
    executionAuthorized: false,
    newEffectAuthorized: false,
    policyDecisionGranted: false,
    reconciliationAuthorized: false,
    requiresFreshPolicyEvaluation: true,
    requiresCanonicalRuntimeResume: true,
  });
}
