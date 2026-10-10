import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentExecutionPlane,
  AgentPlanNodeState,
  normalizeAgentPlanV1,
} from '../src/core/agent-plan.js';
import { createOutcomeContractV1 } from '../src/core/outcome-contract.js';
import { createSubagentTaskEnvelopeV1 } from '../src/core/subagent-task-envelope.js';
import {
  ObservationStatus,
  VerificationStatus,
} from '../src/core/universal-agent-contracts.js';
import {
  SUBAGENT_RESULT_ENVELOPE_VERSION,
  createSubagentResultEnvelopeV1,
  normalizeSubagentResultEnvelopeV1,
} from '../src/core/subagent-result-envelope.js';

const T0 = '2026-09-27T10:00:00.000Z';
const T1 = '2026-09-27T10:01:00.000Z';
const T2 = '2026-09-27T10:02:00.000Z';
const T3 = '2026-09-27T10:03:00.000Z';
const T4 = '2026-09-27T10:04:00.000Z';
const T5 = '2026-09-27T10:05:00.000Z';

function artifactRef(artifactId, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind: overrides.kind ?? 'document',
    uri: overrides.uri ?? 'artifact://' + artifactId,
    mediaType: overrides.mediaType ?? 'text/plain',
    sha256: overrides.sha256 ?? 'a'.repeat(64),
    sizeBytes: overrides.sizeBytes ?? 12,
    createdAt: overrides.createdAt ?? T3,
    producerInvocationId: overrides.producerInvocationId ?? 'invocation-child-1',
    sensitive: overrides.sensitive ?? false,
  };
}

function taskEnvelope(overrides = {}) {
  const plan = normalizeAgentPlanV1({
    schemaVersion: 1,
    planId: 'plan-1',
    jobId: 'job-1',
    objective: 'Complete parent goal.',
    successCriteria: ['Child result is independently verified'],
    nodes: [{
      nodeId: 'task-1',
      title: 'Child task',
      objective: 'Produce the verified child artifact.',
      dependsOn: [],
      conflictKeys: ['artifact:result'],
      ownerId: 'child-1',
      executionPlane: AgentExecutionPlane.CLOUD,
      acceptanceCriteria: ['Result artifact is complete'],
      budget: {
        maxModelCalls: 10,
        maxRuntimeSeconds: 300,
        maxCostUsdMicros: 1_000,
      },
      state: AgentPlanNodeState.READY,
      evidence: '',
      updatedAt: T1,
    }],
    createdAt: T0,
    updatedAt: T1,
    revision: 3,
  });
  const outcome = createOutcomeContractV1({
    contractId: 'outcome-1',
    projectId: 'project-1',
    desiredResult: 'A verified child artifact.',
    completionCriteria: [{
      criterionId: 'criterion-1',
      description: 'Result artifact is complete',
      observable: 'The immutable result artifact exists.',
      requiredEvidenceKinds: ['artifact'],
    }],
    constraints: [],
    sourceTruth: [{
      sourceId: 'source-1',
      location: 'project://source-1',
      revisionId: 'rev-1',
      purpose: 'Canonical task source.',
    }],
    allowedAuthority: [],
    budgetBoundaries: {
      maxModelCalls: 5,
      maxRuntimeSeconds: 120,
      maxCostUsdMicros: 500,
      maxConcurrency: 1,
      enforcementAuthority: 'NONE',
    },
    deliverables: [{
      deliverableId: 'deliverable-1',
      kind: 'artifact',
      description: 'Child result.',
      criterionIds: ['criterion-1'],
    }],
    verifierPlan: {
      planId: 'verify-1',
      actorId: 'child-1',
      verifierId: overrides.taskVerifierId ?? 'verifier-1',
      criterionIds: ['criterion-1'],
      requiredEvidenceArtifactCount: overrides.requiredEvidenceArtifactCount ?? 1,
      independent: true,
      verificationAuthority: 'EXTERNAL_REQUIRED',
    },
    triggerRefs: [],
    createdAt: T0,
  });
  return createSubagentTaskEnvelopeV1({
    envelopeId: 'envelope-1',
    projectId: 'project-1',
    parentAgentId: 'parent-1',
    childAgentId: 'child-1',
    plan,
    nodeId: 'task-1',
    inputSourceIds: ['source-1'],
    inputArtifactRefs: [
      artifactRef('input-1', { createdAt: T0, sha256: '1'.repeat(64) }),
    ],
    outcomeContract: outcome,
    createdAt: T2,
  });
}

function observation(overrides = {}) {
  return {
    schemaVersion: 1,
    observationId: overrides.observationId ?? 'observation-1',
    invocationId: overrides.invocationId ?? 'invocation-child-1',
    status: overrides.status ?? ObservationStatus.OK,
    summary: overrides.summary ?? 'Child produced the bounded result artifact.',
    data: overrides.data ?? {
      transcript: 'THIS LARGE CHILD INTERNAL PAYLOAD MUST NOT BE COPIED TO PARENT RESULT',
      internal: { token: 'not-a-result-field' },
    },
    artifactRefs: overrides.artifactRefs ?? [
      artifactRef('result-1', { sha256: '2'.repeat(64) }),
    ],
    observedAt: overrides.observedAt ?? T3,
  };
}

function verification(overrides = {}) {
  return {
    schemaVersion: 1,
    verificationId: overrides.verificationId ?? 'verification-1',
    invocationId: overrides.invocationId ?? 'invocation-child-1',
    observationId: overrides.observationId ?? 'observation-1',
    status: overrides.status ?? VerificationStatus.VERIFIED,
    reasonCode: overrides.reasonCode ?? 'INDEPENDENT_CHECK_PASS',
    summary: overrides.summary ?? 'Independent verifier confirmed the exact observation.',
    evidenceArtifactIds: overrides.evidenceArtifactIds ?? ['evidence-1'],
    verifiedAt: overrides.verifiedAt ?? T4,
    verifierId: overrides.verifierId ?? 'verifier-1',
    verificationAuthorityId: 'authority-verify-1',
    effectId: null,
    executionId: null,
    attempt: 1,
  };
}

function request(overrides = {}) {
  return {
    resultId: 'result-envelope-1',
    taskEnvelope: taskEnvelope(),
    observation: observation(),
    verification: verification(),
    evidenceArtifactRefs: [
      artifactRef('evidence-1', {
        sha256: '3'.repeat(64),
        createdAt: T4,
        producerInvocationId: 'invocation-verifier-1',
      }),
    ],
    completedAt: T5,
    ...overrides,
  };
}

test('returns exact verified child handback through immutable refs without copying observation data', () => {
  const value = createSubagentResultEnvelopeV1(request());

  assert.equal(value.schemaVersion, SUBAGENT_RESULT_ENVELOPE_VERSION);
  assert.equal(value.resultId, 'result-envelope-1');
  assert.equal(value.envelopeId, 'envelope-1');
  assert.equal(value.projectId, 'project-1');
  assert.equal(value.parentAgentId, 'parent-1');
  assert.equal(value.childAgentId, 'child-1');
  assert.equal(value.taskId, 'task-1');
  assert.equal(value.planId, 'plan-1');
  assert.equal(value.planRevision, 3);
  assert.equal(value.outcomeContractId, 'outcome-1');
  assert.equal(value.outcomeContractRevision, 1);
  assert.equal(value.observationId, 'observation-1');
  assert.equal(value.invocationId, 'invocation-child-1');
  assert.equal(value.observationStatus, ObservationStatus.OK);
  assert.equal(value.verificationId, 'verification-1');
  assert.equal(value.verificationStatus, VerificationStatus.VERIFIED);
  assert.equal(value.verifierId, 'verifier-1');
  assert.equal(value.verificationAuthorityId, 'authority-verify-1');
  assert.equal(value.requiredEvidenceArtifactCount, 1);
  assert.equal(value.verificationProvenance, 'UNVERIFIED_INPUT');
  assert.equal(value.trustedVerificationRequired, true);
  assert.deepEqual(
    value.resultArtifactRefs.map(ref => [ref.artifactId, ref.sha256]),
    [['result-1', '2'.repeat(64)]],
  );
  assert.deepEqual(
    value.evidenceArtifactRefs.map(ref => [ref.artifactId, ref.sha256]),
    [['evidence-1', '3'.repeat(64)]],
  );
  assert.equal(Object.hasOwn(value, 'data'), false);
  assert.equal(Object.hasOwn(value, 'transcript'), false);
  assert.equal(JSON.stringify(value).includes('THIS LARGE CHILD INTERNAL PAYLOAD'), false);
  assert.equal(value.executionAuthority, false);
  assert.equal(value.schedulingAuthority, false);
  assert.equal(value.policyAuthority, false);
  assert.equal(value.credentialAuthority, false);
  assert.equal(value.completionAuthority, false);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.resultArtifactRefs[0]), true);
});

test('exact ObservationV1 and VerificationV1 identity/provenance must match', () => {
  assert.throws(
    () => createSubagentResultEnvelopeV1(request({
      verification: verification({ invocationId: 'invocation-other' }),
    })),
    /verification invocation mismatch/,
  );
  assert.throws(
    () => createSubagentResultEnvelopeV1(request({
      verification: verification({ observationId: 'observation-other' }),
    })),
    /verification observation mismatch/,
  );
  assert.throws(
    () => createSubagentResultEnvelopeV1(request({
      verification: verification({ verifierId: 'verifier-other' }),
    })),
    /verifier does not match task outcome verifier/,
  );
});

test('only independently VERIFIED verification with authority provenance can produce a bounded parent handback', () => {
  for (const status of [
    VerificationStatus.FAILED,
    VerificationStatus.AMBIGUOUS,
    VerificationStatus.NOT_APPLICABLE,
  ]) {
    assert.throws(
      () => createSubagentResultEnvelopeV1(request({
        verification: verification({ status }),
      })),
      /requires VERIFIED VerificationV1/,
    );
  }

  const noAuthority = verification();
  noAuthority.verificationAuthorityId = null;
  assert.throws(
    () => createSubagentResultEnvelopeV1(request({ verification: noAuthority })),
    /requires independent verificationAuthorityId provenance/,
  );
});

test('verified negative child observations remain representable without being promoted to completion', () => {
  for (const status of [
    ObservationStatus.PARTIAL,
    ObservationStatus.ERROR,
    ObservationStatus.UNAVAILABLE,
  ]) {
    const value = createSubagentResultEnvelopeV1(request({
      observation: observation({ status }),
    }));
    assert.equal(value.observationStatus, status);
    assert.equal(value.completionAuthority, false);
  }
});

test('verification evidence IDs must be bound exactly to hash-bearing ArtifactRefs', () => {
  assert.throws(
    () => createSubagentResultEnvelopeV1(request({
      evidenceArtifactRefs: [],
    })),
    /must exactly bind VerificationV1 evidenceArtifactIds/,
  );
  assert.throws(
    () => createSubagentResultEnvelopeV1(request({
      evidenceArtifactRefs: [
        artifactRef('evidence-other', { sha256: '4'.repeat(64), createdAt: T4 }),
      ],
    })),
    /must exactly bind VerificationV1 evidenceArtifactIds/,
  );
  assert.throws(
    () => createSubagentResultEnvelopeV1(request({
      evidenceArtifactRefs: [
        artifactRef('evidence-1', { sha256: '', createdAt: T4 }),
      ],
    })),
    /requires sha256 immutable identity/,
  );
});

test('task-required evidence count cannot be bypassed by a verification with too little evidence', () => {
  const task = taskEnvelope({ requiredEvidenceArtifactCount: 2 });
  assert.throws(
    () => createSubagentResultEnvelopeV1(request({
      taskEnvelope: task,
      verification: verification({ evidenceArtifactIds: ['evidence-1'] }),
      evidenceArtifactRefs: [
        artifactRef('evidence-1', { sha256: '3'.repeat(64), createdAt: T4 }),
      ],
    })),
    /lacks task-required independent evidence artifacts/,
  );
});

test('result artifacts must be hash-bound even when canonical ObservationV1 permits unhashed refs', () => {
  assert.throws(
    () => createSubagentResultEnvelopeV1(request({
      observation: observation({
        artifactRefs: [artifactRef('result-unhashed', { sha256: '' })],
      }),
    })),
    /requires sha256 immutable identity/,
  );
});

test('result artifacts are bound to the exact child invocation that produced the observation', () => {
  for (const producerInvocationId of ['invocation-other', '']) {
    assert.throws(
      () => createSubagentResultEnvelopeV1(request({
        observation: observation({
          artifactRefs: [artifactRef('result-wrong-producer', {
            sha256: '6'.repeat(64),
            producerInvocationId,
          })],
        }),
      })),
      /producerInvocationId must match child invocation/,
    );
  }
});

test('result chronology cannot predate task, observation, verification or artifact creation', () => {
  assert.throws(
    () => createSubagentResultEnvelopeV1(request({
      observation: observation({ observedAt: T1 }),
    })),
    /observation predates task envelope/,
  );
  assert.throws(
    () => createSubagentResultEnvelopeV1(request({
      verification: verification({ verifiedAt: T2 }),
    })),
    /verification predates observation/,
  );
  assert.throws(
    () => createSubagentResultEnvelopeV1(request({ completedAt: T3 })),
    /completion predates verification/,
  );
  assert.throws(
    () => createSubagentResultEnvelopeV1(request({
      observation: observation({
        artifactRefs: [artifactRef('result-future', {
          sha256: '5'.repeat(64),
          createdAt: T4,
        })],
      }),
    })),
    /resultArtifactRefs ArtifactRef cannot postdate its observation/,
  );
  assert.throws(
    () => createSubagentResultEnvelopeV1(request({
      evidenceArtifactRefs: [
        artifactRef('evidence-1', {
          sha256: '3'.repeat(64),
          createdAt: T5,
        }),
      ],
    })),
    /evidenceArtifactRefs ArtifactRef cannot postdate its observation/,
  );
});

test('restart normalization is strict and cannot mint execution or completion authority', () => {
  const value = createSubagentResultEnvelopeV1(request());
  assert.deepEqual(normalizeSubagentResultEnvelopeV1(structuredClone(value)), value);

  for (const key of [
    'executionAuthority',
    'schedulingAuthority',
    'policyAuthority',
    'credentialAuthority',
    'completionAuthority',
  ]) {
    const forged = structuredClone(value);
    forged[key] = true;
    assert.throws(
      () => normalizeSubagentResultEnvelopeV1(forged),
      new RegExp('cannot grant ' + key),
    );
  }

  const unknown = structuredClone(value);
  unknown.transcript = 'forbidden bulk handback';
  assert.throws(
    () => normalizeSubagentResultEnvelopeV1(unknown),
    /contains unknown field: transcript/,
  );

  const forgedVerification = structuredClone(value);
  forgedVerification.verificationStatus = VerificationStatus.AMBIGUOUS;
  assert.throws(
    () => normalizeSubagentResultEnvelopeV1(forgedVerification),
    /verificationStatus must remain VERIFIED/,
  );

  const forgedObservation = structuredClone(value);
  forgedObservation.observationStatus = 'MADE_UP';
  assert.throws(
    () => normalizeSubagentResultEnvelopeV1(forgedObservation),
    /observationStatus is invalid/,
  );

  const forgedTrust = structuredClone(value);
  forgedTrust.verificationProvenance = 'TRUSTED';
  assert.throws(
    () => normalizeSubagentResultEnvelopeV1(forgedTrust),
    /cannot claim trusted verification provenance/,
  );

  const bypassTrustedGate = structuredClone(value);
  bypassTrustedGate.trustedVerificationRequired = false;
  assert.throws(
    () => normalizeSubagentResultEnvelopeV1(bypassTrustedGate),
    /must require canonical trusted verification before completion/,
  );

  const forgedProducer = structuredClone(value);
  forgedProducer.resultArtifactRefs[0].producerInvocationId = 'invocation-other';
  assert.throws(
    () => normalizeSubagentResultEnvelopeV1(forgedProducer),
    /producerInvocationId must match child invocation/,
  );
});

test('request boundary rejects accessors and sparse evidence arrays without reading getters', () => {
  let reads = 0;
  const hostile = request();
  Object.defineProperty(hostile, 'verification', {
    enumerable: true,
    get() {
      reads += 1;
      return verification();
    },
  });
  assert.throws(
    () => createSubagentResultEnvelopeV1(hostile),
    /must be an enumerable own data property/,
  );
  assert.equal(reads, 0);

  const sparse = request();
  sparse.evidenceArtifactRefs = new Array(2);
  sparse.evidenceArtifactRefs[0] = artifactRef('evidence-1', {
    sha256: '3'.repeat(64),
    createdAt: T4,
  });
  assert.throws(
    () => createSubagentResultEnvelopeV1(sparse),
    /dense data-only array/,
  );
});

test('caller mutation cannot alter the frozen handback', () => {
  const raw = request();
  const value = createSubagentResultEnvelopeV1(raw);

  raw.observation.artifactRefs[0].sha256 = 'f'.repeat(64);
  raw.evidenceArtifactRefs[0].sha256 = 'e'.repeat(64);
  raw.observation.data.transcript = 'mutated';
  assert.equal(value.resultArtifactRefs[0].sha256, '2'.repeat(64));
  assert.equal(value.evidenceArtifactRefs[0].sha256, '3'.repeat(64));
  assert.equal(JSON.stringify(value).includes('mutated'), false);
});
