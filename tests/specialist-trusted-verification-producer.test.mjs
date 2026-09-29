import test from 'node:test';
import assert from 'node:assert/strict';

import {
  produceTrustedSpecialistExecutionVerificationRecordV1,
} from '../src/core/specialist-trusted-verification-producer.js';
import {
  authorizeExecutionSafeRetryWithTrustedRecordV1,
  verifyExecutionWithTrustedRecordV1,
} from '../src/core/execution-plane-ownership.js';
import {
  appendTrustedExecutionVerificationRecordV1,
  createTrustedExecutionVerificationLedgerV1,
  resolveTrustedExecutionVerificationRecordV1,
} from '../src/core/trusted-execution-verification-ledger.js';

const T0 = '2026-09-29T04:00:00.000Z';
const T1 = '2026-09-29T04:01:00.000Z';
const T1A = '2026-09-29T04:01:10.000Z';
const T2 = '2026-09-29T04:02:00.000Z';
const T3 = '2026-09-29T04:03:00.000Z';
const T4 = '2026-09-29T04:04:00.000Z';
const T4A = '2026-09-29T04:04:10.000Z';
const T5 = '2026-09-29T04:05:00.000Z';
const T6 = '2026-09-29T05:00:00.000Z';

const AGENT_ID = 'browser-agent-specialist:plan-1:local';
const LEASE_ID = 'lease:plan-1:local:1';
const EFFECT_ID = 'specialist-effect:plan-1:local';
const POLICY_ID = 'policy:archive';
const PROVIDER_ID = 'openhands-agent-server';
const SPECIALIST_ID = 'openhands-coding';
const HANDOFF_ID = 'handoff:plan-1:local';
const VERIFICATION_ID = 'verification:specialist:1';
const RESULT_ID = 'artifact:specialist-result';

function providerConfig() {
  return {
    schemaVersion: 1,
    providerId: PROVIDER_ID,
    kind: 'OPENHANDS_AGENT_SERVER',
    revision: 1,
    config: {
      schemaVersion: 1,
      serverUrl: 'http://127.0.0.1:3000',
      agentServerVersion: '1.49.5',
      agentProfileId: '11111111-1111-4111-8111-111111111111',
      agentProfileRevision: 1,
      workspacePath: 'C:\\workspace\\autopilot',
      qualifiedCapabilityIds: ['filesystem.write'],
      requestTimeoutSeconds: 10,
      maxExecutionSeconds: 300,
      pollIntervalMs: 100,
      maxIterations: 20,
      maxResponseBytes: 4096,
      authMode: 'LOCAL_UNAUTHENTICATED',
    },
    updatedAt: T0,
  };
}

function providerExecution(overrides = {}) {
  return {
    schemaVersion: 1,
    planId: 'plan-1',
    nodeId: 'local',
    agentId: AGENT_ID,
    handoffId: HANDOFF_ID,
    providerId: PROVIDER_ID,
    leaseId: LEASE_ID,
    leaseUntil: T6,
    conversationId: '22222222-2222-4222-8222-222222222222',
    providerConfig: providerConfig(),
    status: 'PROVIDER_SUCCEEDED',
    providerStatus: 'finished',
    providerSucceeded: true,
    manualReviewRequired: false,
    reconciliationRequired: false,
    safeToRetry: false,
    effectEvidence: 'OPENHANDS_CONVERSATION_TERMINAL_OBSERVED_TWICE',
    errorCode: '',
    providerUpdatedAt: T1,
    providerObservedAt: T1A,
    preparedAt: T0,
    updatedAt: T2,
    ...overrides,
  };
}

function ownership(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: 'browser-agent-task:plan-1',
    planId: 'plan-1',
    nodeId: 'local',
    effectId: EFFECT_ID,
    policyEnvelopeId: POLICY_ID,
    state: 'OWNED',
    ownerPlane: 'LOCAL',
    ownerId: AGENT_ID,
    leaseId: LEASE_ID,
    leaseUntil: T6,
    handoffToPlane: '',
    handoffId: '',
    ambiguityReason: '',
    updatedAt: T0,
    revision: 2,
    ...overrides,
  };
}

function selection(overrides = {}) {
  return {
    schemaVersion: 1,
    registryId: 'specialist-registry:default',
    registryRevision: 1,
    registryBindingKey: 'registry-binding:v1',
    specialistId: SPECIALIST_ID,
    providerId: PROVIDER_ID,
    definitionRevision: 1,
    executionPlane: 'LOCAL',
    requestedCapabilityIds: ['filesystem.write'],
    grantedToolIds: [],
    resultContractId: 'result-contract:workspace-change',
    ...overrides,
  };
}

function handoff(overrides = {}) {
  return {
    schemaVersion: 1,
    handoffId: HANDOFF_ID,
    specialistId: SPECIALIST_ID,
    goal: 'Produce the owner-requested workspace change.',
    requestedCapabilityIds: ['filesystem.write'],
    artifactRefs: [],
    credentialRefs: [],
    maxModelCalls: 8,
    maxRuntimeSeconds: 300,
    maxCostUsdMicros: 0,
    createdAt: T0,
    parentInvocationId: 'invoke:parent',
    ...overrides,
  };
}

function evidenceArtifact({
  artifactId = RESULT_ID,
  createdAt = T3,
  sha256 = 'a'.repeat(64),
} = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'specialist-result',
    uri: 'file://workspace/' + artifactId.replaceAll(':', '-') + '.bin',
    mediaType: 'application/octet-stream',
    sha256,
    sizeBytes: 64,
    createdAt,
    producerInvocationId: 'invoke:independent-verifier',
    sensitive: false,
  };
}

function proof({
  outcome = 'EFFECT_VERIFIED',
  verificationId = VERIFICATION_ID,
  artifacts = [evidenceArtifact()],
  verifierId = 'independent-specialist-verifier',
  verificationAuthorityId = POLICY_ID,
  effectId = EFFECT_ID,
  executionId = LEASE_ID,
  verifiedAt = T4,
  recordedAt = T4A,
  validThrough = T6,
  recordId = 'trusted-record:specialist:1',
} = {}) {
  return {
    recordId,
    outcome,
    verification: {
      schemaVersion: 1,
      verificationId,
      invocationId: 'invoke:independent-verifier',
      observationId: 'observation:independent-verifier',
      status: 'VERIFIED',
      reasonCode: outcome === 'NO_EFFECT_VERIFIED'
        ? 'NO_EFFECT_OBSERVED'
        : 'RESULT_POSTCONDITION_MATCH',
      summary: 'Independent verifier resolved the exact Specialist execution.',
      evidenceArtifactIds: artifacts.map(item => item.artifactId),
      verifiedAt,
      verifierId,
      verificationAuthorityId,
      effectId,
      executionId,
      attempt: 1,
    },
    evidenceArtifacts: artifacts,
    recordedAt,
    validThrough,
  };
}

function request(overrides = {}) {
  return {
    providerExecution: providerExecution(),
    executionOwnership: ownership(),
    selection: selection(),
    handoff: handoff(),
    resultArtifactIds: [RESULT_ID],
    verificationId: VERIFICATION_ID,
    expectedOutcome: 'EFFECT_VERIFIED',
    at: T5,
    ...overrides,
  };
}

async function sha256BindingKey(value) {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return 'sha256:' + Array.from(
    new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('');
}

test('independent resolver produces exact trusted Specialist record consumable by execution ownership', async () => {
  let lookup;
  const produced = await produceTrustedSpecialistExecutionVerificationRecordV1(
    request(),
    {
      resolveTrustedSpecialistExecutionVerification: async value => {
        lookup = value;
        return proof();
      },
    },
  );

  assert.equal(Object.isFrozen(lookup), true);
  assert.equal(Object.isFrozen(lookup.resultArtifactIds), true);
  for (const key of [
    'providerExecutionBindingKey',
    'executionOwnershipBindingKey',
    'selectionBindingKey',
    'handoffBindingKey',
  ]) {
    assert.match(lookup[key], /^sha256:[0-9a-f]{64}$/u);
  }
  const serializedLookup = JSON.stringify(lookup);
  assert.equal(serializedLookup.includes(providerExecution().effectEvidence), false);
  assert.equal(serializedLookup.includes(handoff().goal), false);
  assert.equal(Object.hasOwn(lookup, 'providerEffectEvidence'), false);
  assert.deepEqual(
    {
      taskId: lookup.taskId,
      planId: lookup.planId,
      nodeId: lookup.nodeId,
      effectId: lookup.effectId,
      policyEnvelopeId: lookup.policyEnvelopeId,
      executionId: lookup.executionId,
      executionOwnershipRevision: lookup.executionOwnershipRevision,
      executionOwnershipBindingKey: lookup.executionOwnershipBindingKey,
      registryId: lookup.registryId,
      registryRevision: lookup.registryRevision,
      registryBindingKey: lookup.registryBindingKey,
      providerId: lookup.providerId,
      providerConfigRevision: lookup.providerConfigRevision,
      providerExecutionBindingKey: lookup.providerExecutionBindingKey,
      definitionRevision: lookup.definitionRevision,
      requestedCapabilityIds: lookup.requestedCapabilityIds,
      grantedToolIds: lookup.grantedToolIds,
      selectionBindingKey: lookup.selectionBindingKey,
      handoffBindingKey: lookup.handoffBindingKey,
      resultContractId: lookup.resultContractId,
      verificationId: lookup.verificationId,
      expectedOutcome: lookup.expectedOutcome,
    },
    {
      taskId: 'browser-agent-task:plan-1',
      planId: 'plan-1',
      nodeId: 'local',
      effectId: EFFECT_ID,
      policyEnvelopeId: POLICY_ID,
      executionId: LEASE_ID,
      executionOwnershipRevision: 2,
      executionOwnershipBindingKey: await sha256BindingKey(ownership()),
      registryId: 'specialist-registry:default',
      registryRevision: 1,
      registryBindingKey: await sha256BindingKey(selection().registryBindingKey),
      providerId: PROVIDER_ID,
      providerConfigRevision: 1,
      providerExecutionBindingKey: await sha256BindingKey(providerExecution()),
      definitionRevision: 1,
      requestedCapabilityIds: ['filesystem.write'],
      grantedToolIds: [],
      selectionBindingKey: await sha256BindingKey(selection()),
      handoffBindingKey: await sha256BindingKey(handoff()),
      resultContractId: 'result-contract:workspace-change',
      verificationId: VERIFICATION_ID,
      expectedOutcome: 'EFFECT_VERIFIED',
    },
  );
  assert.equal(produced.trustedRecord.executionId, LEASE_ID);
  assert.equal(produced.trustedRecord.effectId, EFFECT_ID);
  assert.equal(produced.trustedRecord.policyEnvelopeId, POLICY_ID);
  assert.deepEqual(produced.resultArtifactIds, [RESULT_ID]);
  assert.equal(produced.completionAuthorized, false);
  assert.equal(produced.executionAuthorized, false);
  assert.equal(produced.retryDispatched, false);

  const consumed = await verifyExecutionWithTrustedRecordV1(
    ownership(),
    { leaseId: LEASE_ID, verificationId: VERIFICATION_ID, at: T5 },
    {
      resolveTrustedExecutionVerificationRecord: async exactLookup => {
        assert.equal(exactLookup.effectId, EFFECT_ID);
        assert.equal(exactLookup.executionId, LEASE_ID);
        assert.equal(exactLookup.policyEnvelopeId, POLICY_ID);
        return produced.trustedRecord;
      },
    },
  );
  assert.equal(consumed.ownership.state, 'VERIFIED');
  assert.equal(consumed.trustedRecord.recordId, 'trusted-record:specialist:1');
});

test('producer record round-trips through canonical trusted ledger before existing consumer', async () => {
  const produced = await produceTrustedSpecialistExecutionVerificationRecordV1(
    request(),
    { resolveTrustedSpecialistExecutionVerification: async () => proof() },
  );
  const ledger = appendTrustedExecutionVerificationRecordV1(
    createTrustedExecutionVerificationLedgerV1(),
    produced.trustedRecord,
  );
  assert.equal(ledger.revision, 1);
  assert.equal(ledger.records.length, 1);

  const exactLookup = {
    taskId: 'browser-agent-task:plan-1',
    planId: 'plan-1',
    nodeId: 'local',
    effectId: EFFECT_ID,
    policyEnvelopeId: POLICY_ID,
    executionId: LEASE_ID,
    verificationId: VERIFICATION_ID,
    expectedOutcome: 'EFFECT_VERIFIED',
  };
  const resolved = resolveTrustedExecutionVerificationRecordV1(ledger, exactLookup);
  assert.equal(resolved.recordId, produced.trustedRecord.recordId);

  const consumed = await verifyExecutionWithTrustedRecordV1(
    ownership(),
    { leaseId: LEASE_ID, verificationId: VERIFICATION_ID, at: T5 },
    {
      resolveTrustedExecutionVerificationRecord: async lookup => (
        resolveTrustedExecutionVerificationRecordV1(ledger, lookup)
      ),
    },
  );
  assert.equal(consumed.ownership.state, 'VERIFIED');
  assert.equal(consumed.trustedRecord.recordId, produced.trustedRecord.recordId);
});

test('provider success alone cannot mint verification without independent resolver', async () => {
  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(request(), {}),
    /independent Specialist verification resolver is required/,
  );
});

test('EFFECT_VERIFIED requires durable provider success and OWNED execution', async () => {
  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(
      request({
        providerExecution: providerExecution({
          status: 'BLOCKED_FAILURE',
          providerStatus: '',
          providerSucceeded: false,
          effectEvidence: '',
          errorCode: 'PROVIDER_UNAVAILABLE',
          providerUpdatedAt: '',
          providerObservedAt: '',
        }),
      }),
      { resolveTrustedSpecialistExecutionVerification: async () => proof() },
    ),
    /requires durable provider success/,
  );

  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(
      request({
        executionOwnership: ownership({
          state: 'RECONCILE',
          ambiguityReason: 'provider outcome ambiguous',
          revision: 3,
        }),
      }),
      { resolveTrustedSpecialistExecutionVerification: async () => proof() },
    ),
    /requires current OWNED execution/,
  );
});

test('EFFECT_VERIFIED cannot be produced after the exact execution lease expires', async () => {
  let resolverCalls = 0;
  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(
      request({ at: '2026-09-29T05:00:00.001Z' }),
      {
        resolveTrustedSpecialistExecutionVerification: async () => {
          resolverCalls += 1;
          return proof();
        },
      },
    ),
    /cannot outlive the current execution lease/,
  );
  assert.equal(resolverCalls, 0);
});

test('trusted proof must hash-cover every requested result artifact identity', async () => {
  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(
      request(),
      {
        resolveTrustedSpecialistExecutionVerification: async () => proof({
          artifacts: [evidenceArtifact({ artifactId: 'artifact:other' })],
        }),
      },
    ),
    /does not hash-cover result artifacts: artifact:specialist-result/,
  );

  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(
      request(),
      {
        resolveTrustedSpecialistExecutionVerification: async () => proof({
          artifacts: [evidenceArtifact({ sha256: '' })],
        }),
      },
    ),
    /requires sha256/,
  );
});

test('independent resolver cannot rebind verification effect, lease, policy, id, or outcome', async () => {
  for (const [label, changed, pattern] of [
    ['effect', { effectId: 'specialist-effect:other' }, /effect\/lease binding mismatch/],
    ['lease', { executionId: 'lease:other' }, /effect\/lease binding mismatch/],
    ['policy', { verificationAuthorityId: 'policy:other' }, /policy authority mismatch/],
    ['verificationId', { verificationId: 'verification:other' }, /verificationId mismatch/],
  ]) {
    await assert.rejects(
      produceTrustedSpecialistExecutionVerificationRecordV1(
        request(),
        { resolveTrustedSpecialistExecutionVerification: async () => proof(changed) },
      ),
      pattern,
      label,
    );
  }

  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(
      request(),
      {
        resolveTrustedSpecialistExecutionVerification: async () => proof({
          outcome: 'NO_EFFECT_VERIFIED',
          artifacts: [evidenceArtifact({ artifactId: 'artifact:no-effect' })],
        }),
      },
    ),
    /outcome does not match requested outcome/,
  );
});

test('provider, specialist, and current execution owner cannot self-issue trusted verification', async () => {
  for (const verifierId of [PROVIDER_ID, SPECIALIST_ID, AGENT_ID]) {
    await assert.rejects(
      produceTrustedSpecialistExecutionVerificationRecordV1(
        request(),
        {
          resolveTrustedSpecialistExecutionVerification: async () => proof({ verifierId }),
        },
      ),
      /cannot be self-issued/,
    );
  }
});

test('result artifacts may predate terminal provider persistence but cannot predate preparation', async () => {
  const produced = await produceTrustedSpecialistExecutionVerificationRecordV1(
    request(),
    {
      resolveTrustedSpecialistExecutionVerification: async () => proof({
        artifacts: [evidenceArtifact({ createdAt: T1 })],
      }),
    },
  );
  assert.equal(produced.trustedRecord.evidenceArtifacts[0].artifactId, RESULT_ID);

  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(
      request(),
      {
        resolveTrustedSpecialistExecutionVerification: async () => proof({
          artifacts: [evidenceArtifact({ createdAt: '2026-09-29T03:59:59.000Z' })],
        }),
      },
    ),
    /evidence chronology is invalid: artifact:specialist-result/,
  );
});

test('independent verifier evidence must be fresh relative to durable provider and ownership state', async () => {
  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(
      request(),
      {
        resolveTrustedSpecialistExecutionVerification: async () => proof({
          artifacts: [
            evidenceArtifact({ createdAt: T1 }),
            evidenceArtifact({
              artifactId: 'artifact:independent-proof',
              createdAt: T1,
              sha256: 'b'.repeat(64),
            }),
          ],
        }),
      },
    ),
    /evidence chronology is invalid: artifact:independent-proof/,
  );

  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(
      request(),
      {
        resolveTrustedSpecialistExecutionVerification: async () => proof({
          verifiedAt: T1,
          artifacts: [evidenceArtifact({ createdAt: T1 })],
          recordedAt: T3,
        }),
      },
    ),
    /verification chronology is invalid/,
  );
});

test('NO_EFFECT_VERIFIED is limited to RECONCILE ownership and no result outputs', async () => {
  const reconciledExecution = providerExecution({
    status: 'RECONCILE',
    providerStatus: '',
    providerSucceeded: false,
    manualReviewRequired: false,
    reconciliationRequired: true,
    safeToRetry: false,
    effectEvidence: '',
    errorCode: 'OPENHANDS_AMBIGUOUS_EFFECT',
    providerUpdatedAt: '',
    providerObservedAt: '',
  });
  const reconciledOwnership = ownership({
    state: 'RECONCILE',
    ambiguityReason: 'provider effect is ambiguous',
    updatedAt: T2,
    revision: 3,
  });
  const noEffectRequest = request({
    providerExecution: reconciledExecution,
    executionOwnership: reconciledOwnership,
    resultArtifactIds: [],
    verificationId: 'verification:no-effect:1',
    expectedOutcome: 'NO_EFFECT_VERIFIED',
  });
  const noEffectProof = proof({
    outcome: 'NO_EFFECT_VERIFIED',
    verificationId: 'verification:no-effect:1',
    artifacts: [evidenceArtifact({
      artifactId: 'artifact:no-effect-proof',
      createdAt: T3,
    })],
    recordId: 'trusted-record:no-effect:1',
  });

  const produced = await produceTrustedSpecialistExecutionVerificationRecordV1(
    noEffectRequest,
    { resolveTrustedSpecialistExecutionVerification: async () => noEffectProof },
  );
  assert.equal(produced.trustedRecord.outcome, 'NO_EFFECT_VERIFIED');
  assert.deepEqual(produced.resultArtifactIds, []);

  const retriable = await authorizeExecutionSafeRetryWithTrustedRecordV1(
    reconciledOwnership,
    { leaseId: LEASE_ID, verificationId: 'verification:no-effect:1', at: T5 },
    { resolveTrustedExecutionVerificationRecord: async () => produced.trustedRecord },
  );
  assert.equal(retriable.ownership.state, 'AVAILABLE');

  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(
      request({
        resultArtifactIds: [],
        verificationId: 'verification:no-effect:1',
        expectedOutcome: 'NO_EFFECT_VERIFIED',
      }),
      { resolveTrustedSpecialistExecutionVerification: async () => noEffectProof },
    ),
    /requires current RECONCILE execution/,
  );

  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(
      {
        ...noEffectRequest,
        resultArtifactIds: [RESULT_ID],
      },
      { resolveTrustedSpecialistExecutionVerification: async () => noEffectProof },
    ),
    /cannot carry Specialist result artifact identities/,
  );
});

test('durable selection, handoff, lease, plane, provider, and chronology drift fail closed', async () => {
  const cases = [
    [request({ selection: selection({ providerId: 'other-provider' }) }), /providerId identity mismatch/],
    [request({ handoff: handoff({ specialistId: 'other-specialist' }) }), /specialistId identity mismatch/],
    [request({ providerExecution: providerExecution({ leaseId: 'lease:other' }) }), /leaseId identity mismatch/],
    [request({ selection: selection({ executionPlane: 'REMOTE' }) }), /executionPlane identity mismatch/],
    [request({ handoff: handoff({ createdAt: T3 }) }), /handoff cannot postdate provider execution preparation/],
  ];
  for (const [value, pattern] of cases) {
    await assert.rejects(
      produceTrustedSpecialistExecutionVerificationRecordV1(
        value,
        { resolveTrustedSpecialistExecutionVerification: async () => proof() },
      ),
      pattern,
    );
  }
});

test('handoff capability scope must exactly match admitted selection before verifier lookup', async () => {
  let resolverCalls = 0;
  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(
      request({
        handoff: handoff({ requestedCapabilityIds: ['filesystem.read'] }),
      }),
      {
        resolveTrustedSpecialistExecutionVerification: async () => {
          resolverCalls += 1;
          return proof();
        },
      },
    ),
    /requestedCapabilityIds identity mismatch/,
  );
  assert.equal(resolverCalls, 0);
});

test('same-ID selection and handoff semantic changes produce distinct verifier lookup bindings', async () => {
  const lookups = [];
  const dependencies = {
    resolveTrustedSpecialistExecutionVerification: async lookup => {
      lookups.push(lookup);
      return proof();
    },
  };
  await produceTrustedSpecialistExecutionVerificationRecordV1(request(), dependencies);
  await produceTrustedSpecialistExecutionVerificationRecordV1(
    request({
      selection: selection({ definitionRevision: 2 }),
      handoff: handoff({ goal: 'Produce the same requested workspace change with revised admitted semantics.' }),
    }),
    dependencies,
  );
  assert.equal(lookups.length, 2);
  assert.notEqual(lookups[0].selectionBindingKey, lookups[1].selectionBindingKey);
  assert.notEqual(lookups[0].handoffBindingKey, lookups[1].handoffBindingKey);
  assert.equal(lookups[1].definitionRevision, 2);
  assert.equal(lookups[1].handoffId, HANDOFF_ID);
  assert.equal(lookups[1].specialistId, SPECIALIST_ID);
});

test('same-ID provider execution and ownership semantic changes produce distinct verifier lookup bindings', async () => {
  const lookups = [];
  const dependencies = {
    resolveTrustedSpecialistExecutionVerification: async lookup => {
      lookups.push(lookup);
      return proof();
    },
  };
  await produceTrustedSpecialistExecutionVerificationRecordV1(request(), dependencies);

  const configRevision2 = providerConfig();
  configRevision2.revision = 2;
  configRevision2.updatedAt = T1;
  await produceTrustedSpecialistExecutionVerificationRecordV1(
    request({
      providerExecution: providerExecution({
        providerConfig: configRevision2,
      }),
      executionOwnership: ownership({ revision: 3 }),
    }),
    dependencies,
  );

  assert.equal(lookups.length, 2);
  assert.notEqual(
    lookups[0].providerExecutionBindingKey,
    lookups[1].providerExecutionBindingKey,
  );
  assert.notEqual(
    lookups[0].executionOwnershipBindingKey,
    lookups[1].executionOwnershipBindingKey,
  );
  assert.equal(lookups[1].providerConfigRevision, 2);
  assert.equal(lookups[1].executionOwnershipRevision, 3);
  assert.equal(lookups[1].executionId, LEASE_ID);
  assert.equal(lookups[1].providerId, PROVIDER_ID);
});

test('untrusted provider and handoff narrative is bound by digest but never disclosed to verifier', async () => {
  const baselineLookups = [];
  const changedLookups = [];
  await produceTrustedSpecialistExecutionVerificationRecordV1(
    request(),
    {
      resolveTrustedSpecialistExecutionVerification: async lookup => {
        baselineLookups.push(lookup);
        return proof();
      },
    },
  );

  const providerSentinel = 'UNTRUSTED_PROVIDER_SENTINEL_DO_NOT_EXECUTE';
  const handoffSentinel = 'UNTRUSTED_HANDOFF_SENTINEL_DO_NOT_EXECUTE';
  const registrySentinel = 'UNTRUSTED_REGISTRY_SENTINEL_DO_NOT_EXECUTE';
  await produceTrustedSpecialistExecutionVerificationRecordV1(
    request({
      providerExecution: providerExecution({ effectEvidence: providerSentinel }),
      selection: selection({ registryBindingKey: registrySentinel }),
      handoff: handoff({ goal: handoffSentinel }),
    }),
    {
      resolveTrustedSpecialistExecutionVerification: async lookup => {
        changedLookups.push(lookup);
        return proof();
      },
    },
  );

  assert.equal(baselineLookups.length, 1);
  assert.equal(changedLookups.length, 1);
  assert.notEqual(
    baselineLookups[0].providerExecutionBindingKey,
    changedLookups[0].providerExecutionBindingKey,
  );
  assert.notEqual(
    baselineLookups[0].handoffBindingKey,
    changedLookups[0].handoffBindingKey,
  );
  assert.notEqual(
    baselineLookups[0].registryBindingKey,
    changedLookups[0].registryBindingKey,
  );
  assert.notEqual(
    baselineLookups[0].selectionBindingKey,
    changedLookups[0].selectionBindingKey,
  );
  const exposed = JSON.stringify(changedLookups[0]);
  assert.equal(exposed.includes(providerSentinel), false);
  assert.equal(exposed.includes(handoffSentinel), false);
  assert.equal(exposed.includes(registrySentinel), false);
  assert.equal(Object.hasOwn(changedLookups[0], 'providerEffectEvidence'), false);
});

test('hostile accessors and unknown fields are rejected without executing getters', async () => {
  let hits = 0;
  const hostileProof = {
    recordId: 'trusted-record:hostile',
    outcome: 'EFFECT_VERIFIED',
    evidenceArtifacts: [evidenceArtifact()],
    recordedAt: T4A,
    validThrough: T6,
  };
  Object.defineProperty(hostileProof, 'verification', {
    enumerable: true,
    get() {
      hits += 1;
      return proof().verification;
    },
  });

  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(
      request(),
      { resolveTrustedSpecialistExecutionVerification: async () => hostileProof },
    ),
    /verification must be an enumerable own data property/,
  );
  assert.equal(hits, 0);

  await assert.rejects(
    produceTrustedSpecialistExecutionVerificationRecordV1(
      { ...request(), extraAuthority: true },
      { resolveTrustedSpecialistExecutionVerification: async () => proof() },
    ),
    /unknown field: extraAuthority/,
  );
});
