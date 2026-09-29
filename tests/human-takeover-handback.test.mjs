import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HumanTakeoverPhase,
  buildHumanHandbackResumePacketV1,
  createHumanTakeoverV1,
  humanTakeoverResumeCandidateV1,
  normalizeHumanTakeoverV1,
  recordHumanHandbackObservationV1,
  recordHumanHandbackVerificationV1,
  recordHumanTakeoverStartedV1,
  requestHumanHandbackV1,
} from '../src/core/human-takeover-handback.js';

const T0 = '2026-09-25T00:00:00.000Z';
const T1 = '2026-09-25T00:01:00.000Z';
const T2 = '2026-09-25T00:02:00.000Z';
const T3 = '2026-09-25T00:03:00.000Z';
const T4 = '2026-09-25T00:04:00.000Z';

function observation(overrides = {}) {
  return {
    schemaVersion: 1,
    observationId: 'obs-after',
    invocationId: 'observe-after',
    status: 'OK',
    summary: 'Fresh semantic state after human takeover.',
    data: {
      resourceId: 'resource-1',
      stateRevision: 'revision-after',
    },
    artifactRefs: [{
      schemaVersion: 1,
      artifactId: 'artifact-observation',
      kind: 'snapshot',
      uri: 'artifact://observation',
      mediaType: 'application/json',
      sha256: 'a'.repeat(64),
      sizeBytes: 120,
      createdAt: T3,
      producerInvocationId: 'observe-after',
      sensitive: false,
    }],
    observedAt: T3,
    ...overrides,
  };
}

function verification(overrides = {}) {
  return {
    schemaVersion: 1,
    verificationId: 'verify-after',
    invocationId: 'observe-after',
    observationId: 'obs-after',
    status: 'VERIFIED',
    reasonCode: 'POST_TAKEOVER_STATE_RECONCILED',
    summary: 'Independent verifier accepted the fresh post-takeover state.',
    evidenceArtifactIds: ['artifact-observation'],
    verifiedAt: T4,
    verifierId: 'verifier-independent',
    verificationAuthorityId: 'verify-authority-1',
    effectId: 'effect-1',
    executionId: 'execution-1',
    attempt: 1,
    ...overrides,
  };
}

function requested(overrides = {}) {
  return createHumanTakeoverV1({
    takeoverId: 'takeover-1',
    jobId: 'job-1',
    planId: 'plan-1',
    nodeId: 'node-1',
    resourceId: 'resource-1',
    effectId: 'effect-1',
    executionId: 'execution-1',
    attempt: 1,
    agentId: 'agent-1',
    humanPrincipalId: 'owner-1',
    verificationAuthorityId: 'verify-authority-1',
    reason: 'Owner needs to complete an interactive step manually.',
    at: T0,
    ...overrides,
  });
}

function throughHandback() {
  const started = recordHumanTakeoverStartedV1(requested(), {
    quiescenceEvidenceId: 'pause-evidence-1',
    at: T1,
  });
  return requestHumanHandbackV1(started, {
    reobservationInvocationId: 'observe-after',
    at: T2,
  });
}

function reconciled() {
  const reobserved = recordHumanHandbackObservationV1(throughHandback(), {
    observation: observation(),
  });
  return recordHumanHandbackVerificationV1(reobserved, {
    verification: verification(),
  });
}

test('takeover -> fresh observation -> independent verification yields only an advisory resume candidate', () => {
  const state = reconciled();
  assert.equal(state.phase, HumanTakeoverPhase.EVIDENCE_READY);
  assert.equal(humanTakeoverResumeCandidateV1(state), true);
  assert.equal(state.advisoryOnly, true);
  assert.equal(state.resumeAuthorized, false);
  assert.equal(state.requiresCanonicalResumeGate, true);
  assert.equal(state.verificationProvenance, 'UNVERIFIED_INPUT');
  assert.equal(state.reconciliationAuthorized, false);
  assert.equal(state.revision, 5);

  const packet = buildHumanHandbackResumePacketV1(state);
  assert.equal(packet.resumeCandidate, true);
  assert.equal(packet.resumeAuthorized, false);
  assert.equal(packet.requiresCanonicalResumeGate, true);
  assert.equal(packet.verificationProvenance, 'UNVERIFIED_INPUT');
  assert.equal(packet.reconciliationAuthorized, false);
  assert.equal(packet.postTakeoverObservation.observationId, 'obs-after');
  assert.equal(packet.handbackVerification.verificationId, 'verify-after');
  assert.equal(Object.isFrozen(packet), true);
  assert.equal(Object.isFrozen(packet.postTakeoverObservation), true);
});

test('human control cannot be recorded before canonical runtime quiescence evidence is referenced', () => {
  assert.throws(() => recordHumanTakeoverStartedV1(requested(), {
    quiescenceEvidenceId: '',
    at: T1,
  }), /quiescenceEvidenceId/);
});

test('handback requires a fresh observation created after the handback request', () => {
  const pending = throughHandback();

  assert.throws(() => recordHumanHandbackObservationV1(pending, {
    observation: observation({ observedAt: T1 }),
  }), /causal timestamp ordering/);

  assert.throws(() => recordHumanHandbackObservationV1(pending, {
    observation: observation({ invocationId: 'wrong-observer' }),
  }), /reobservation invocation/);
});

test('pre-takeover observation identity cannot be reused as the post-takeover observation', () => {
  const pre = observation({
    observationId: 'obs-before',
    invocationId: 'observe-before',
    observedAt: T0,
    artifactRefs: [],
  });
  const start = requested({ preTakeoverObservation: pre });
  const controlled = recordHumanTakeoverStartedV1(start, {
    quiescenceEvidenceId: 'pause-evidence-1',
    at: T1,
  });
  const pending = requestHumanHandbackV1(controlled, {
    reobservationInvocationId: 'observe-before',
    at: T2,
  });

  assert.throws(() => recordHumanHandbackObservationV1(pending, {
    observation: observation({
      observationId: 'obs-before',
      invocationId: 'observe-before',
    }),
  }), /fresh observation identity/);
});

test('verification must bind the exact fresh observation, invocation and authority', () => {
  const reobserved = recordHumanHandbackObservationV1(throughHandback(), {
    observation: observation(),
  });

  assert.throws(() => recordHumanHandbackVerificationV1(reobserved, {
    verification: verification({ observationId: 'other-observation' }),
  }), /observation does not match/);

  assert.throws(() => recordHumanHandbackVerificationV1(reobserved, {
    verification: verification({ invocationId: 'other-invocation' }),
  }), /invocation does not match/);

  assert.throws(() => recordHumanHandbackVerificationV1(reobserved, {
    verification: verification({ verificationAuthorityId: 'other-authority' }),
  }), /authority mismatch/);

  assert.throws(() => recordHumanHandbackVerificationV1(reobserved, {
    verification: verification({ executionId: 'other-execution' }),
  }), /executionId mismatch/);

  assert.throws(() => recordHumanHandbackVerificationV1(reobserved, {
    verification: verification({ attempt: 2 }),
  }), /attempt mismatch/);
});

test('agent or takeover principal cannot self-verify handback', () => {
  const reobserved = recordHumanHandbackObservationV1(throughHandback(), {
    observation: observation(),
  });

  assert.throws(() => recordHumanHandbackVerificationV1(reobserved, {
    verification: verification({ verifierId: 'agent-1' }),
  }), /independent/);

  assert.throws(() => recordHumanHandbackVerificationV1(reobserved, {
    verification: verification({ verifierId: 'owner-1' }),
  }), /independent/);
});

test('failed, ambiguous, or evidence-free verification cannot become a resume candidate', () => {
  for (const status of ['FAILED', 'AMBIGUOUS']) {
    const reobserved = recordHumanHandbackObservationV1(throughHandback(), {
      observation: observation(),
    });
    const state = recordHumanHandbackVerificationV1(reobserved, {
      verification: verification({ status }),
    });
    assert.equal(state.phase, HumanTakeoverPhase.MANUAL_REVIEW);
    assert.equal(humanTakeoverResumeCandidateV1(state), false);
    assert.throws(() => buildHumanHandbackResumePacketV1(state), /not a resume candidate/);
  }

  const noEvidenceObserved = recordHumanHandbackObservationV1(throughHandback(), {
    observation: observation(),
  });
  const noEvidence = recordHumanHandbackVerificationV1(noEvidenceObserved, {
    verification: verification({ evidenceArtifactIds: [] }),
  });
  assert.equal(noEvidence.phase, HumanTakeoverPhase.MANUAL_REVIEW);
  assert.equal(humanTakeoverResumeCandidateV1(noEvidence), false);
});

test('takeover representation cannot smuggle resume or execution authority', () => {
  const state = reconciled();

  assert.throws(() => normalizeHumanTakeoverV1({
    ...state,
    resumeAuthorized: true,
  }), /cannot authorize resume/);

  assert.throws(() => normalizeHumanTakeoverV1({
    ...state,
    advisoryOnly: false,
  }), /advisoryOnly/);

  assert.throws(() => normalizeHumanTakeoverV1({
    ...state,
    reconciliationAuthorized: true,
  }), /cannot authorize reconciliation/);

  assert.throws(() => normalizeHumanTakeoverV1({
    ...state,
    verificationProvenance: 'TRUSTED',
  }), /provenance must remain unverified/);

  assert.throws(() => normalizeHumanTakeoverV1({
    ...state,
    execute: true,
  }), /unknown field: execute/);
});

test('top-level and nested accessors, hidden fields, symbols and sparse arrays fail without getter execution', () => {
  let getterReads = 0;
  const top = { ...requested() };
  Object.defineProperty(top, 'reason', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'unsafe';
    },
  });
  assert.throws(() => normalizeHumanTakeoverV1(top), /enumerable data property/);
  assert.equal(getterReads, 0);

  const hidden = { ...requested() };
  Object.defineProperty(hidden, 'resumeAuthorized', {
    enumerable: false,
    value: true,
  });
  assert.throws(() => normalizeHumanTakeoverV1(hidden), /enumerable data property/);

  const symbolic = { ...requested(), [Symbol('grant')]: 'ALLOW' };
  assert.throws(() => normalizeHumanTakeoverV1(symbolic), /unknown field/);

  const pending = throughHandback();
  const badObservation = observation();
  const evidence = [];
  evidence.length = 1;
  Object.defineProperty(evidence, '0', {
    enumerable: true,
    get() {
      getterReads += 1;
      return badObservation.artifactRefs[0];
    },
  });
  badObservation.artifactRefs = evidence;
  assert.throws(() => recordHumanHandbackObservationV1(pending, {
    observation: badObservation,
  }), /enumerable data property/);
  assert.equal(getterReads, 0);

  const sparseVerification = verification();
  sparseVerification.evidenceArtifactIds = Array(1);
  const reobserved = recordHumanHandbackObservationV1(pending, {
    observation: observation(),
  });
  assert.throws(() => recordHumanHandbackVerificationV1(reobserved, {
    verification: sparseVerification,
  }), /dense data array/);
});


test('nested authority/evidence arrays use descriptor snapshots with zero ordinary Proxy gets', () => {
  let ordinaryGets = 0;
  const proxied = values => new Proxy(values, {
    get(target, property, receiver) {
      ordinaryGets += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  const pending = throughHandback();
  const fresh = observation({
    data: proxied([{ state: 'fresh' }]),
    artifactRefs: proxied([observation().artifactRefs[0]]),
  });
  const reobserved = recordHumanHandbackObservationV1(pending, {
    observation: fresh,
  });
  assert.equal(ordinaryGets, 0);

  const state = recordHumanHandbackVerificationV1(reobserved, {
    verification: verification({
      evidenceArtifactIds: proxied(['artifact-observation']),
    }),
  });
  assert.equal(state.phase, HumanTakeoverPhase.EVIDENCE_READY);
  assert.equal(ordinaryGets, 0);
});

test('all public takeover request envelopes reject accessors before field reads', () => {
  let reads = 0;
  const accessorField = (base, key, value) => {
    const out = { ...base };
    Object.defineProperty(out, key, {
      enumerable: true,
      get() {
        reads += 1;
        return value;
      },
    });
    return out;
  };

  const createBase = {
    takeoverId: 'takeover-request-boundary',
    jobId: 'job-1',
    planId: 'plan-1',
    nodeId: 'node-1',
    resourceId: 'resource-1',
    effectId: 'effect-1',
    executionId: 'execution-1',
    attempt: 1,
    agentId: 'agent-1',
    humanPrincipalId: 'owner-1',
    verificationAuthorityId: 'verify-authority-1',
    reason: 'manual interaction',
    at: T0,
  };
  assert.throws(
    () => createHumanTakeoverV1(accessorField(createBase, 'reason', 'unsafe')),
    /enumerable data property/,
  );
  assert.equal(reads, 0);

  const initial = requested();
  assert.throws(() => recordHumanTakeoverStartedV1(initial, accessorField({
    at: T1,
  }, 'quiescenceEvidenceId', 'pause-evidence-1')), /enumerable data property/);
  assert.equal(reads, 0);

  const controlled = recordHumanTakeoverStartedV1(initial, {
    quiescenceEvidenceId: 'pause-evidence-1',
    at: T1,
  });
  assert.throws(() => requestHumanHandbackV1(controlled, accessorField({
    at: T2,
  }, 'reobservationInvocationId', 'observe-after')), /enumerable data property/);
  assert.equal(reads, 0);

  const pending = requestHumanHandbackV1(controlled, {
    reobservationInvocationId: 'observe-after',
    at: T2,
  });
  assert.throws(() => recordHumanHandbackObservationV1(
    pending,
    accessorField({}, 'observation', observation()),
  ), /enumerable data property/);
  assert.equal(reads, 0);

  const reobserved = recordHumanHandbackObservationV1(pending, {
    observation: observation(),
  });
  assert.throws(() => recordHumanHandbackVerificationV1(
    reobserved,
    accessorField({}, 'verification', verification()),
  ), /enumerable data property/);
  assert.equal(reads, 0);
});

test('takeover request envelopes reject hidden, symbol and inherited authority while accepting null-prototype data', () => {
  const initial = requested();

  const hidden = {
    quiescenceEvidenceId: 'pause-evidence-1',
    at: T1,
  };
  Object.defineProperty(hidden, 'execute', { enumerable: false, value: true });
  assert.throws(() => recordHumanTakeoverStartedV1(initial, hidden), /unknown field|enumerable data property/);

  const symbolic = {
    quiescenceEvidenceId: 'pause-evidence-1',
    at: T1,
    [Symbol('authority')]: 'ALLOW',
  };
  assert.throws(() => recordHumanTakeoverStartedV1(initial, symbolic), /unknown field/);

  const inherited = Object.create({ execute: true });
  inherited.quiescenceEvidenceId = 'pause-evidence-1';
  inherited.at = T1;
  assert.throws(() => recordHumanTakeoverStartedV1(initial, inherited), /plain object/);

  const nullProto = Object.assign(Object.create(null), {
    quiescenceEvidenceId: 'pause-evidence-1',
    at: T1,
  });
  assert.equal(
    recordHumanTakeoverStartedV1(initial, nullProto).phase,
    HumanTakeoverPhase.OWNER_IN_CONTROL,
  );
});

test('coercive ObservationV1 and VerificationV1 fields fail before inherited normalizers can coerce them', () => {
  const pending = throughHandback();
  assert.throws(() => recordHumanHandbackObservationV1(pending, {
    observation: observation({ schemaVersion: '1' }),
  }), /exact numeric 1/);
  assert.throws(() => recordHumanHandbackObservationV1(pending, {
    observation: observation({ observationId: 7 }),
  }), /observationId must be an exact id/);

  const reobserved = recordHumanHandbackObservationV1(pending, { observation: observation() });
  assert.throws(() => recordHumanHandbackVerificationV1(reobserved, {
    verification: verification({ attempt: '1' }),
  }), /attempt must be an exact integer/);
  assert.throws(() => recordHumanHandbackVerificationV1(reobserved, {
    verification: verification({ verifierId: 7 }),
  }), /verifierId must be an exact id/);
});

test('active and effect-free takeover identities remain structurally distinct', () => {
  assert.throws(() => createHumanTakeoverV1({
    takeoverId: 'takeover-x',
    jobId: 'job-1',
    planId: 'plan-1',
    nodeId: 'node-1',
    resourceId: 'resource-1',
    effectId: 'effect-1',
    agentId: 'agent-1',
    humanPrincipalId: 'owner-1',
    verificationAuthorityId: 'verify-authority-1',
    reason: 'manual interaction',
    at: T0,
  }), /effectId and executionId/);

  const noEffect = createHumanTakeoverV1({
    takeoverId: 'takeover-no-effect',
    jobId: 'job-1',
    planId: 'plan-1',
    nodeId: 'node-1',
    resourceId: 'resource-1',
    agentId: 'agent-1',
    humanPrincipalId: 'owner-1',
    verificationAuthorityId: 'verify-authority-1',
    reason: 'manual inspection',
    at: T0,
  });
  assert.equal(noEffect.effectId, '');
  assert.equal(noEffect.executionId, '');
  assert.equal(noEffect.attempt, 0);
});

test('null-prototype JSON-style takeover records remain supported', () => {
  const state = requested();
  const nullProto = Object.assign(Object.create(null), state);
  const normalized = normalizeHumanTakeoverV1(nullProto);
  assert.equal(normalized.takeoverId, 'takeover-1');
  assert.equal(normalized.phase, HumanTakeoverPhase.REQUESTED);
  assert.equal(normalized.resumeAuthorized, false);
});



test('takeover evidence timestamp aliases fail closed before inherited canonicalizers can rewrite them', () => {
  assert.throws(() => requested({ at: '2026-09-25T00:00:00Z' }), /canonical ISO-8601 UTC/);

  const pending = throughHandback();
  assert.throws(() => recordHumanHandbackObservationV1(pending, {
    observation: observation({ observedAt: '2026-09-25T00:03:00Z' }),
  }), /canonical ISO-8601 UTC/);

  const artifactAlias = observation();
  artifactAlias.artifactRefs[0].createdAt = '2026-09-25T00:03:00Z';
  assert.throws(() => recordHumanHandbackObservationV1(pending, {
    observation: artifactAlias,
  }), /canonical ISO-8601 UTC/);

  const reobserved = recordHumanHandbackObservationV1(pending, {
    observation: observation(),
  });
  assert.throws(() => recordHumanHandbackVerificationV1(reobserved, {
    verification: verification({ verifiedAt: '2026-09-25T00:04:00Z' }),
  }), /canonical ISO-8601 UTC/);
});

test('causal timestamps reject verification that predates fresh observation', () => {
  const reobserved = recordHumanHandbackObservationV1(throughHandback(), {
    observation: observation(),
  });
  assert.throws(() => recordHumanHandbackVerificationV1(reobserved, {
    verification: verification({ verifiedAt: T2 }),
  }), /causal timestamp ordering/);
});
