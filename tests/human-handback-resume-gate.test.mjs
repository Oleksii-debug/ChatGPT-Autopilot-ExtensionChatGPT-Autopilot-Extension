import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeHumanHandbackResumeV1,
} from '../src/core/human-handback-resume-gate.js';
import {
  createHumanTakeoverV1,
  recordHumanHandbackObservationV1,
  recordHumanHandbackVerificationV1,
  recordHumanTakeoverStartedV1,
  requestHumanHandbackV1,
} from '../src/core/human-takeover-handback.js';
import {
  worldStateSnapshotFingerprintV1,
} from '../src/core/world-state-contract.js';
import {
  ExactEffectEventType,
  ExactEffectPhase,
  ReconciliationOutcome,
  createExactEffectStateV1,
  reduceExactEffectV1,
} from '../src/core/universal-agent-exact-effect.js';

const PRE0 = '2026-09-24T23:58:00.000Z';
const PRE1 = '2026-09-24T23:59:00.000Z';
const PRE2 = '2026-09-24T23:59:30.000Z';
const T0 = '2026-09-25T00:00:00.000Z';
const T1 = '2026-09-25T00:01:00.000Z';
const T2 = '2026-09-25T00:02:00.000Z';
const T3 = '2026-09-25T00:03:00.000Z';
const T4 = '2026-09-25T00:04:00.000Z';
const T4A = '2026-09-25T00:04:10.000Z';
const T4B = '2026-09-25T00:04:20.000Z';
const T5 = '2026-09-25T00:05:00.000Z';
const T5A = '2026-09-25T00:05:10.000Z';
const T6 = '2026-09-25T00:06:00.000Z';
const T6A = '2026-09-25T00:06:30.000Z';
const T7 = '2026-09-25T00:07:00.000Z';
const VALID = '2026-09-25T01:00:00.000Z';
const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);

function runtimeIdentity(overrides = {}) {
  return {
    currentJobId: 'job-1',
    currentPlanId: 'plan-1',
    currentNodeId: 'node-1',
    ...overrides,
  };
}

function humanObservation(overrides = {}) {
  return {
    schemaVersion: 1,
    observationId: 'obs-handback',
    invocationId: 'observe-after',
    status: 'OK',
    summary: 'Fresh state after owner intervention.',
    data: { resourceId: 'resource-1' },
    artifactRefs: [{
      schemaVersion: 1,
      artifactId: 'artifact-handback',
      kind: 'snapshot',
      uri: 'artifact://handback',
      mediaType: 'application/json',
      sha256: HASH,
      sizeBytes: 10,
      createdAt: T3,
      producerInvocationId: 'observe-after',
      sensitive: false,
    }],
    observedAt: T3,
    ...overrides,
  };
}

function humanVerification({
  effectId = 'effect-1',
  executionId = 'effect-1:attempt:1',
  attempt = 1,
  ...overrides
} = {}) {
  return {
    schemaVersion: 1,
    verificationId: 'verify-handback',
    invocationId: 'observe-after',
    observationId: 'obs-handback',
    status: 'VERIFIED',
    reasonCode: 'POST_TAKEOVER_STATE_RECONCILED',
    summary: 'Independent verifier accepted the post-takeover state.',
    evidenceArtifactIds: ['artifact-handback'],
    verifiedAt: T4,
    verifierId: 'verifier-independent',
    verificationAuthorityId: 'verify-authority-1',
    effectId,
    executionId,
    attempt,
    ...overrides,
  };
}

function effectfulHandback({
  effectId = 'effect-1',
  executionId = 'effect-1:attempt:1',
  attempt = 1,
} = {}) {
  let state = createHumanTakeoverV1({
    takeoverId: 'takeover-1',
    jobId: 'job-1',
    planId: 'plan-1',
    nodeId: 'node-1',
    resourceId: 'resource-1',
    effectId,
    executionId,
    attempt,
    agentId: 'agent-1',
    humanPrincipalId: 'owner-1',
    verificationAuthorityId: 'verify-authority-1',
    reason: 'Owner completed an interactive correction.',
    at: T0,
  });
  state = recordHumanTakeoverStartedV1(state, {
    quiescenceEvidenceId: 'quiescence-1',
    at: T1,
  });
  state = requestHumanHandbackV1(state, {
    reobservationInvocationId: 'observe-after',
    at: T2,
  });
  state = recordHumanHandbackObservationV1(state, {
    observation: humanObservation(),
  });
  return recordHumanHandbackVerificationV1(state, {
    verification: humanVerification({ effectId, executionId, attempt }),
  });
}

function effectFreeHandback() {
  let state = createHumanTakeoverV1({
    takeoverId: 'takeover-no-effect',
    jobId: 'job-1',
    planId: 'plan-1',
    nodeId: 'node-1',
    resourceId: 'resource-1',
    agentId: 'agent-1',
    humanPrincipalId: 'owner-1',
    verificationAuthorityId: 'verify-authority-1',
    reason: 'Owner corrected non-effectful state.',
    at: T0,
  });
  state = recordHumanTakeoverStartedV1(state, {
    quiescenceEvidenceId: 'quiescence-no-effect',
    at: T1,
  });
  state = requestHumanHandbackV1(state, {
    reobservationInvocationId: 'observe-after',
    at: T2,
  });
  state = recordHumanHandbackObservationV1(state, {
    observation: humanObservation(),
  });
  return recordHumanHandbackVerificationV1(state, {
    verification: humanVerification({
      effectId: '',
      executionId: '',
      attempt: 0,
    }),
  });
}

function worldObservation({
  resourceId = 'resource-1',
  observationId = 'world-observation-1',
  revisionId = 'revision-1',
  contentSha256 = HASH,
  observedAt = T5,
} = {}) {
  return {
    schemaVersion: 1,
    observationId,
    scopeId: 'job-1',
    providerId: 'provider-1',
    resourceId,
    revisionId,
    contentSha256,
    observedAt,
    validUntil: VALID,
    evidenceArtifactIds: ['world-evidence-' + resourceId],
  };
}

function worldMaterial({
  bindTakeoverResource = true,
  snapshotObservedAt = T5,
  currentObservedAt = T6A,
  currentRevisionId = 'revision-1',
  preconditionCreatedAt = T6,
} = {}) {
  const primary = worldObservation({ observedAt: snapshotObservedAt });
  const secondary = worldObservation({
    resourceId: 'resource-2',
    observationId: 'world-observation-2',
    revisionId: 'revision-2',
    contentSha256: HASH2,
    observedAt: snapshotObservedAt,
  });
  const snapshot = {
    schemaVersion: 1,
    snapshotId: 'world-snapshot-1',
    scopeId: 'job-1',
    revision: 5,
    observations: [primary, secondary],
    capturedAt: new Date(Date.parse(snapshotObservedAt) + 10_000).toISOString(),
  };
  const bindingSource = bindTakeoverResource ? primary : secondary;
  const precondition = {
    schemaVersion: 1,
    guardId: 'resume-world-guard-1',
    invocationId: 'observe-after',
    snapshotId: snapshot.snapshotId,
    scopeId: snapshot.scopeId,
    snapshotRevision: snapshot.revision,
    snapshotFingerprint: worldStateSnapshotFingerprintV1(snapshot),
    requiredBindings: [{
      providerId: bindingSource.providerId,
      resourceId: bindingSource.resourceId,
      revisionId: bindingSource.revisionId,
      contentSha256: bindingSource.contentSha256,
      observedAt: bindingSource.observedAt,
      validUntil: bindingSource.validUntil,
    }],
    createdAt: preconditionCreatedAt,
    expiresAt: '2026-09-25T00:30:00.000Z',
  };
  const currentPrimary = worldObservation({
    observationId: 'world-current-1',
    revisionId: currentRevisionId,
    observedAt: currentObservedAt,
  });
  const currentSecondary = worldObservation({
    resourceId: 'resource-2',
    observationId: 'world-current-2',
    revisionId: 'revision-2',
    contentSha256: HASH2,
    observedAt: currentObservedAt,
  });
  return {
    worldStateSnapshot: snapshot,
    worldStatePrecondition: precondition,
    currentWorldStateObservations: [currentPrimary, currentSecondary],
  };
}

function effectInvocation(effectId = 'effect-1') {
  return {
    schemaVersion: 1,
    invocationId: effectId,
    toolId: 'browser.effect',
    providerId: 'browser-provider',
    requestedCapabilityIds: ['browser.effect'],
    policyDecisionId: 'decision-1',
    arguments: { target: 'resource-1' },
    createdAt: PRE0,
  };
}

function effectObservation(effectId, observationId, status = 'OK') {
  return {
    schemaVersion: 1,
    observationId,
    invocationId: effectId,
    status,
    summary: status === 'OK' ? 'Effect is present.' : 'Effect is absent.',
    data: { resourceId: 'resource-1' },
    artifactRefs: [],
    observedAt: T4A,
  };
}

function effectVerification(effectId, observationId, status = 'VERIFIED', attempt = 1) {
  return {
    schemaVersion: 1,
    verificationId: 'effect-verification-' + attempt,
    invocationId: effectId,
    observationId,
    status,
    reasonCode: status === 'VERIFIED' ? 'EFFECT_RECONCILED' : 'EFFECT_ABSENT',
    summary: status === 'VERIFIED' ? 'Original effect reconciled.' : 'No committed effect found.',
    evidenceArtifactIds: [],
    verifiedAt: T4A,
    effectId,
    executionId: effectId + ':attempt:' + attempt,
    attempt,
  };
}

function effectEvent(effectId, type, eventId, at, fields = {}, attempt = 1) {
  return {
    schemaVersion: 1,
    eventId,
    type,
    effectId,
    at,
    executionId: effectId + ':attempt:' + attempt,
    ...fields,
  };
}

function exactEffectState(phase = ExactEffectPhase.COMMITTED, effectId = 'effect-1') {
  let state = createExactEffectStateV1(effectInvocation(effectId), { createdAt: PRE0 });
  state = reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.BEGIN_EXECUTION,
    'effect-begin-1',
    PRE1,
  )).state;
  state = reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.DECLARE_AMBIGUITY,
    'effect-ambiguous-1',
    PRE2,
    { reasonCode: 'OWNER_TAKEOVER', summary: 'Owner intervention requires reconciliation.' },
  )).state;
  if (phase === ExactEffectPhase.RECONCILE) return state;

  if (phase === ExactEffectPhase.MANUAL_REVIEW) {
    return reduceExactEffectV1(state, effectEvent(
      effectId,
      ExactEffectEventType.RESOLVE_RECONCILIATION,
      'effect-manual-review-1',
      T4A,
      {
        outcome: ReconciliationOutcome.MANUAL_REVIEW,
        reasonCode: 'UNRESOLVED_AFTER_TAKEOVER',
      },
    )).state;
  }

  if (phase === ExactEffectPhase.SAFE_RETRY) {
    const observationId = 'effect-absent-1';
    return reduceExactEffectV1(state, effectEvent(
      effectId,
      ExactEffectEventType.RESOLVE_RECONCILIATION,
      'effect-safe-retry-1',
      T4A,
      {
        outcome: ReconciliationOutcome.SAFE_RETRY,
        reasonCode: 'NO_EFFECT_PROVEN',
        observation: effectObservation(effectId, observationId, 'ERROR'),
        verification: effectVerification(effectId, observationId, 'FAILED'),
      },
    )).state;
  }

  const observationId = 'effect-observed-1';
  state = reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.RESOLVE_RECONCILIATION,
    'effect-reconciled-1',
    T4A,
    {
      outcome: ReconciliationOutcome.VERIFIED,
      reasonCode: 'POSTCONDITION_MATCH',
      observation: effectObservation(effectId, observationId),
      verification: effectVerification(effectId, observationId),
    },
  )).state;
  if (phase === ExactEffectPhase.VERIFIED) return state;
  return reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.COMMIT,
    'effect-commit-1',
    T4B,
    { commitId: 'effect-commit-proof-1' },
  )).state;
}

function committedEffectBeforeHandbackVerification(effectId = 'effect-1') {
  let state = createExactEffectStateV1(effectInvocation(effectId), { createdAt: PRE0 });
  state = reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.BEGIN_EXECUTION,
    'stale-effect-begin',
    PRE1,
  )).state;
  state = reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.DECLARE_AMBIGUITY,
    'stale-effect-ambiguous',
    PRE2,
    { reasonCode: 'OWNER_TAKEOVER', summary: 'Owner intervention requires reconciliation.' },
  )).state;
  const observationId = 'stale-effect-observed';
  const observedAt = '2026-09-25T00:03:10.000Z';
  const verifiedAt = '2026-09-25T00:03:20.000Z';
  state = reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.RESOLVE_RECONCILIATION,
    'stale-effect-reconciled',
    '2026-09-25T00:03:30.000Z',
    {
      outcome: ReconciliationOutcome.VERIFIED,
      reasonCode: 'POSTCONDITION_MATCH',
      observation: {
        ...effectObservation(effectId, observationId),
        observedAt,
      },
      verification: {
        ...effectVerification(effectId, observationId),
        verifiedAt,
      },
    },
  )).state;
  return reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.COMMIT,
    'stale-effect-commit',
    '2026-09-25T00:03:40.000Z',
    { commitId: 'stale-effect-commit-proof' },
  )).state;
}

function secondAttemptCommittedEffect(effectId = 'effect-1') {
  let state = createExactEffectStateV1(effectInvocation(effectId), { createdAt: PRE0 });
  state = reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.BEGIN_EXECUTION,
    'attempt1-begin',
    PRE1,
  )).state;
  state = reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.DECLARE_AMBIGUITY,
    'attempt1-ambiguous',
    PRE2,
    { reasonCode: 'UNKNOWN_EFFECT' },
  )).state;
  const absentId = 'attempt1-absent';
  state = reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.RESOLVE_RECONCILIATION,
    'attempt1-safe-retry',
    T0,
    {
      outcome: ReconciliationOutcome.SAFE_RETRY,
      reasonCode: 'NO_EFFECT_PROVEN',
      observation: {
        ...effectObservation(effectId, absentId, 'ERROR'),
        observedAt: T0,
      },
      verification: {
        ...effectVerification(effectId, absentId, 'FAILED', 1),
        verifiedAt: T0,
      },
    },
  )).state;
  state = reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.BEGIN_EXECUTION,
    'attempt2-begin',
    T1,
    {},
    2,
  )).state;
  const obsId = 'attempt2-observed';
  state = reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.RECORD_OBSERVATION,
    'attempt2-observe',
    T3,
    {
      observation: {
        ...effectObservation(effectId, obsId),
        observedAt: T3,
      },
    },
    2,
  )).state;
  state = reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.RECORD_VERIFICATION,
    'attempt2-verify',
    T4A,
    {
      verification: effectVerification(effectId, obsId, 'VERIFIED', 2),
    },
    2,
  )).state;
  return reduceExactEffectV1(state, effectEvent(
    effectId,
    ExactEffectEventType.COMMIT,
    'attempt2-commit',
    T4B,
    { commitId: 'attempt2-commit-proof' },
    2,
  )).state;
}

function gateInput(overrides = {}) {
  return {
    handback: effectfulHandback(),
    ...runtimeIdentity(),
    ...worldMaterial(),
    exactEffectState: exactEffectState(),
    at: T7,
    ...overrides,
  };
}

test('effectful handback resumes only after fresh world state and committed exact effect', () => {
  const result = authorizeHumanHandbackResumeV1(gateInput());
  assert.equal(result.resumeAuthorized, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.newEffectAuthorized, false);
  assert.equal(result.policyDecisionGranted, false);
  assert.equal(result.reconciliationAuthorized, false);
  assert.equal(result.requiresFreshPolicyEvaluation, true);
  assert.equal(result.requiresCanonicalRuntimeResume, true);
  assert.equal(result.takeoverId, 'takeover-1');
  assert.equal(result.resourceId, 'resource-1');
  assert.equal(result.exactEffectId, 'effect-1');
  assert.equal(result.exactEffectExecutionId, 'effect-1:attempt:1');
  assert.equal(result.exactEffectAttempt, 1);
  assert.equal(result.exactEffectCommitId, 'effect-commit-proof-1');
  assert.equal(result.worldStateGuardId, 'resume-world-guard-1');
  assert.equal(Object.isFrozen(result), true);
});

test('effect-free handback can resume without fabricating an exact-effect ledger', () => {
  const result = authorizeHumanHandbackResumeV1({
    handback: effectFreeHandback(),
    ...runtimeIdentity(),
    ...worldMaterial(),
    at: T7,
  });
  assert.equal(result.resumeAuthorized, true);
  assert.equal(result.exactEffectId, '');
  assert.equal(result.exactEffectExecutionId, '');
  assert.equal(result.exactEffectAttempt, 0);
  assert.equal(result.exactEffectCommitId, '');

  assert.throws(() => authorizeHumanHandbackResumeV1({
    handback: effectFreeHandback(),
    ...runtimeIdentity(),
    ...worldMaterial(),
    exactEffectState: exactEffectState(),
    at: T7,
  }), /effect-free handback cannot supply exactEffectState/);
});

test('handback identity must match the current durable job, plan and node', () => {
  for (const [field, value, pattern] of [
    ['currentJobId', 'job-other', /jobId does not match/],
    ['currentPlanId', 'plan-other', /planId does not match/],
    ['currentNodeId', 'node-other', /nodeId does not match/],
  ]) {
    assert.throws(() => authorizeHumanHandbackResumeV1(gateInput({
      ...runtimeIdentity({ [field]: value }),
    })), pattern);
  }
});

test('stale or substituted world state fails closed before resume', () => {
  const stale = worldMaterial({ currentRevisionId: 'revision-substituted' });
  assert.throws(() => authorizeHumanHandbackResumeV1({
    handback: effectfulHandback(),
    ...runtimeIdentity(),
    ...stale,
    exactEffectState: exactEffectState(),
    at: T7,
  }), /world-state snapshot is stale/);
});

test('world-state guard must bind the exact takeover resource', () => {
  const material = worldMaterial({ bindTakeoverResource: false });
  assert.throws(() => authorizeHumanHandbackResumeV1({
    handback: effectfulHandback(),
    ...runtimeIdentity(),
    ...material,
    exactEffectState: exactEffectState(),
    at: T7,
  }), /does not bind takeover resource/);
});

test('world-state guard and resource observation must be causally newer than handback verification', () => {
  const oldGuard = worldMaterial({
    snapshotObservedAt: '2026-09-25T00:03:30.000Z',
    currentObservedAt: T6A,
    preconditionCreatedAt: '2026-09-25T00:03:55.000Z',
  });
  assert.throws(() => authorizeHumanHandbackResumeV1({
    handback: effectfulHandback(),
    ...runtimeIdentity(),
    ...oldGuard,
    exactEffectState: exactEffectState(),
    at: T7,
  }), /precondition must be created after handback verification/);

  const oldObservation = worldMaterial({
    snapshotObservedAt: '2026-09-25T00:03:30.000Z',
    currentObservedAt: '2026-09-25T00:03:50.000Z',
    preconditionCreatedAt: T6,
  });
  assert.throws(() => authorizeHumanHandbackResumeV1({
    handback: effectfulHandback(),
    ...runtimeIdentity(),
    ...oldObservation,
    exactEffectState: exactEffectState(),
    at: T7,
  }), /freshly observed after handback verification/);
});

test('unresolved exact-effect phases never authorize handback resume', () => {
  for (const phase of [
    ExactEffectPhase.RECONCILE,
    ExactEffectPhase.VERIFIED,
    ExactEffectPhase.SAFE_RETRY,
    ExactEffectPhase.MANUAL_REVIEW,
  ]) {
    assert.throws(() => authorizeHumanHandbackResumeV1(gateInput({
      exactEffectState: exactEffectState(phase),
    })), /must be COMMITTED before handback resume/);
  }
});

test('exact-effect identity, execution and attempt drift fail closed', () => {
  assert.throws(() => authorizeHumanHandbackResumeV1(gateInput({
    exactEffectState: exactEffectState(ExactEffectPhase.COMMITTED, 'effect-2'),
  })), /effectId mismatch/);

  const attempt2 = secondAttemptCommittedEffect();
  assert.throws(() => authorizeHumanHandbackResumeV1(gateInput({
    handback: effectfulHandback({
      effectId: 'effect-1',
      executionId: 'effect-1:attempt:2',
      attempt: 1,
    }),
    exactEffectState: attempt2,
  })), /attempt mismatch/);
});

test('matching committed exact-effect state from before handback verification cannot authorize resume', () => {
  const staleCommitted = committedEffectBeforeHandbackVerification();
  assert.equal(staleCommitted.phase, ExactEffectPhase.COMMITTED);
  assert.equal(staleCommitted.effectId, 'effect-1');
  assert.equal(staleCommitted.executionId, 'effect-1:attempt:1');
  assert.equal(staleCommitted.attempt, 1);
  assert.ok(Date.parse(staleCommitted.updatedAt) < Date.parse(T4));

  assert.throws(() => authorizeHumanHandbackResumeV1(gateInput({
    exactEffectState: staleCommitted,
  })), /exact-effect resolution must not predate handback verification/);
});

test('resume assessment cannot use future exact-effect state or predate handback verification', () => {
  assert.throws(() => authorizeHumanHandbackResumeV1(gateInput({
    at: '2026-09-25T00:03:59.000Z',
  })), /causal timestamp ordering/);

  assert.throws(() => authorizeHumanHandbackResumeV1(gateInput({
    ...worldMaterial({
      snapshotObservedAt: '2026-09-25T00:04:01.000Z',
      currentObservedAt: '2026-09-25T00:04:10.000Z',
      preconditionCreatedAt: '2026-09-25T00:04:02.000Z',
    }),
    at: '2026-09-25T00:04:15.000Z',
  })), /exact-effect state cannot postdate resume assessment/);
});

test('top-level accessors and unknown authority fields fail without getter execution', () => {
  let reads = 0;
  const input = gateInput();
  Object.defineProperty(input, 'handback', {
    enumerable: true,
    get() {
      reads += 1;
      return effectfulHandback();
    },
  });
  assert.throws(() => authorizeHumanHandbackResumeV1(input), /enumerable own data property/);
  assert.equal(reads, 0);

  assert.throws(() => authorizeHumanHandbackResumeV1({
    ...gateInput(),
    forceResume: true,
  }), /unknown field: forceResume/);
});

test('current world-state arrays are consumed from descriptors without ordinary Proxy gets', () => {
  let reads = 0;
  const material = worldMaterial();
  const proxied = new Proxy(material.currentWorldStateObservations, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const result = authorizeHumanHandbackResumeV1({
    handback: effectfulHandback(),
    ...runtimeIdentity(),
    ...material,
    currentWorldStateObservations: proxied,
    exactEffectState: exactEffectState(),
    at: T7,
  });
  assert.equal(result.resumeAuthorized, true);
  assert.equal(reads, 0);
});

test('null-prototype request records remain supported and timestamp aliases fail closed', () => {
  const input = Object.assign(Object.create(null), gateInput());
  assert.equal(authorizeHumanHandbackResumeV1(input).resumeAuthorized, true);

  assert.throws(() => authorizeHumanHandbackResumeV1(gateInput({
    at: '2026-09-25T00:07:00Z',
  })), /canonical ISO-8601 UTC/);
});
