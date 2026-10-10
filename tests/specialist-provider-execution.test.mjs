import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENHANDS_AGENT_SERVER_VERSION,
  OPENHANDS_CODING_PROVIDER_ID,
} from '../src/core/coding-specialist-provider.js';
import {
  SpecialistProviderConfigKind,
  createSpecialistProviderConfigV1,
} from '../src/core/specialist-provider-config.js';
import {
  SpecialistProviderExecutionStatus,
  createSpecialistProviderExecutionV1,
  normalizeSpecialistProviderExecutionV1,
  recordSpecialistProviderExecutionOutcomeV1,
} from '../src/core/specialist-provider-execution.js';

const T0 = '2026-09-27T14:40:00.000Z';
const T1 = '2026-09-27T14:41:00.000Z';
const T2 = '2026-09-27T14:55:00.000Z';

function providerConfig() {
  return createSpecialistProviderConfigV1({
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    kind: SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER,
    revision: 3,
    updatedAt: T0,
    config: {
      schemaVersion: 1,
      serverUrl: 'http://127.0.0.1:3000',
      agentServerVersion: OPENHANDS_AGENT_SERVER_VERSION,
      agentProfileId: '11111111-1111-4111-8111-111111111111',
      agentProfileRevision: 4,
      workspacePath: 'C:\\Autopilot\\workspace',
      qualifiedCapabilityIds: ['code.write'],
      requestTimeoutSeconds: 10,
      maxExecutionSeconds: 600,
      pollIntervalMs: 500,
      maxIterations: 30,
      maxResponseBytes: 65536,
      authMode: 'LOCAL_UNAUTHENTICATED',
    },
  });
}

function prepared() {
  return createSpecialistProviderExecutionV1({
    planId: 'plan:1',
    nodeId: 'node:code',
    agentId: 'specialist:1',
    handoffId: 'handoff:1',
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    leaseId: 'lease:1',
    leaseUntil: T2,
    conversationId: '22222222-2222-4222-8222-222222222222',
    providerConfig: providerConfig(),
    at: T0,
  });
}

test('provider execution freezes exact lease, conversation and provider-config provenance before effect', () => {
  const value = prepared();
  assert.equal(value.status, SpecialistProviderExecutionStatus.PREPARED);
  assert.equal(value.leaseId, 'lease:1');
  assert.equal(value.conversationId, '22222222-2222-4222-8222-222222222222');
  assert.equal(value.providerConfig.revision, 3);
  assert.equal(value.providerConfig.config.agentProfileRevision, 4);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.providerConfig));
});

test('successful terminal provider evidence is not promoted to product completion', () => {
  const value = recordSpecialistProviderExecutionOutcomeV1(prepared(), {
    providerStatus: 'finished',
    providerSucceeded: true,
    manualReviewRequired: false,
    reconciliationRequired: false,
    safeToRetry: false,
    effectEvidence: 'OPENHANDS_CONVERSATION_TERMINAL_OBSERVED_TWICE',
    errorCode: '',
    at: T1,
  });
  assert.equal(value.status, SpecialistProviderExecutionStatus.PROVIDER_SUCCEEDED);
  assert.equal(value.providerSucceeded, true);
  assert.equal(value.reconciliationRequired, false);
});


test('fresh provider chronology is durable while legacy records without it remain valid', () => {
  const current = prepared();
  const {
    providerUpdatedAt: _legacyProviderUpdatedAt,
    providerObservedAt: _legacyProviderObservedAt,
    ...legacyRecord
  } = current;
  const legacy = normalizeSpecialistProviderExecutionV1(legacyRecord);
  assert.equal(legacy.providerUpdatedAt, '');
  assert.equal(legacy.providerObservedAt, '');

  const value = recordSpecialistProviderExecutionOutcomeV1(current, {
    providerStatus: 'finished',
    providerSucceeded: true,
    manualReviewRequired: false,
    reconciliationRequired: false,
    safeToRetry: false,
    effectEvidence: 'OPENHANDS_CONVERSATION_TERMINAL_OBSERVED_TWICE',
    errorCode: '',
    providerUpdatedAt: '2026-09-25T08:00:00.000Z',
    providerObservedAt: T1,
    at: T1,
  });
  assert.equal(value.providerUpdatedAt, '2026-09-25T08:00:00.000Z');
  assert.equal(value.providerObservedAt, T1);

  assert.throws(
    () => recordSpecialistProviderExecutionOutcomeV1(current, {
      providerStatus: 'finished',
      providerSucceeded: true,
      manualReviewRequired: false,
      reconciliationRequired: false,
      safeToRetry: false,
      effectEvidence: 'OPENHANDS_CONVERSATION_TERMINAL_OBSERVED_TWICE',
      errorCode: '',
      providerUpdatedAt: '2026-09-25T08:00:00.000Z',
      at: T1,
    }),
    /requires both providerUpdatedAt and providerObservedAt/,
  );
});
test('negative terminal OpenHands evidence remains provider failure plus manual review', () => {
  const failed = recordSpecialistProviderExecutionOutcomeV1(prepared(), {
    providerStatus: 'error',
    providerSucceeded: false,
    manualReviewRequired: true,
    reconciliationRequired: false,
    safeToRetry: false,
    effectEvidence: 'OPENHANDS_CONVERSATION_TERMINAL_OBSERVED_TWICE',
    errorCode: '',
    at: T1,
  });
  assert.equal(failed.status, SpecialistProviderExecutionStatus.PROVIDER_FAILED);
  assert.equal(failed.providerSucceeded, false);
  assert.equal(failed.manualReviewRequired, true);
});

test('manual and ambiguous outcomes remain explicit and fail closed', () => {
  const manual = recordSpecialistProviderExecutionOutcomeV1(prepared(), {
    providerStatus: 'waiting_for_confirmation',
    providerSucceeded: false,
    manualReviewRequired: true,
    reconciliationRequired: false,
    safeToRetry: false,
    effectEvidence: 'OPENHANDS_CONVERSATION_REQUIRES_HUMAN_INTERVENTION',
    errorCode: '',
    at: T1,
  });
  assert.equal(manual.status, SpecialistProviderExecutionStatus.MANUAL_REVIEW);

  const reconcile = recordSpecialistProviderExecutionOutcomeV1(prepared(), {
    providerStatus: '',
    providerSucceeded: false,
    manualReviewRequired: false,
    reconciliationRequired: true,
    safeToRetry: false,
    effectEvidence: '',
    errorCode: 'OPENHANDS_REQUEST_TIMEOUT',
    at: T1,
  });
  assert.equal(reconcile.status, SpecialistProviderExecutionStatus.RECONCILE);
});

test('pre-effect transport failure may be retried only as the same exact lease/conversation', () => {
  const retryable = recordSpecialistProviderExecutionOutcomeV1(prepared(), {
    providerStatus: '',
    providerSucceeded: false,
    manualReviewRequired: false,
    reconciliationRequired: false,
    safeToRetry: true,
    effectEvidence: '',
    errorCode: 'OPENHANDS_TRANSPORT_FAILURE',
    at: T1,
  });
  assert.equal(retryable.status, SpecialistProviderExecutionStatus.RETRYABLE_FAILURE);
  assert.equal(retryable.leaseId, 'lease:1');
  assert.equal(retryable.conversationId, '22222222-2222-4222-8222-222222222222');
});

test('execution record rejects identity drift, malformed outcome and accessor fields', () => {
  assert.throws(
    () => normalizeSpecialistProviderExecutionV1({
      ...prepared(),
      providerId: 'another-provider',
    }),
    /config provider identity drifted/,
  );
  assert.throws(
    () => recordSpecialistProviderExecutionOutcomeV1(prepared(), {
      providerStatus: 'finished',
      providerSucceeded: false,
      manualReviewRequired: false,
      reconciliationRequired: false,
      safeToRetry: false,
      effectEvidence: 'terminal',
      errorCode: '',
      at: T1,
    }),
    /does not match/,
  );

  let reads = 0;
  const hostile = {
    providerStatus: '',
    providerSucceeded: false,
    manualReviewRequired: false,
    reconciliationRequired: false,
    safeToRetry: true,
    effectEvidence: '',
    errorCode: 'OPENHANDS_TRANSPORT_FAILURE',
    at: T1,
  };
  Object.defineProperty(hostile, 'safeToRetry', {
    enumerable: true,
    get() {
      reads += 1;
      return true;
    },
  });
  assert.throws(
    () => recordSpecialistProviderExecutionOutcomeV1(prepared(), hostile),
    /data property/,
  );
  assert.equal(reads, 0);
});

test('Section 1: hostile provider execution records never leak Proxy errors or caller field names, while JSON restart survives', () => {
  const secret = 'PRIVATE_PROVIDER_TOKEN_CANARY_7e2a';
  const legitimate = JSON.parse(JSON.stringify(prepared()));
  for (const trapName of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
    const input = new Proxy({ ...legitimate }, {
      [trapName]() { throw new Error(secret); },
    });
    assert.throws(
      () => normalizeSpecialistProviderExecutionV1(input),
      error => error instanceof Error
        && /cannot be inspected safely/u.test(error.message)
        && !error.message.includes(secret)
        && !('cause' in error),
      trapName + ' must be redacted',
    );
  }

  assert.throws(
    () => normalizeSpecialistProviderExecutionV1({ ...legitimate, [secret]: 'ignored' }),
    error => error instanceof Error
      && /contains unknown field/u.test(error.message)
      && !error.message.includes(secret),
  );
  let accessorCalls = 0;
  const accessorRecord = { ...legitimate };
  Object.defineProperty(accessorRecord, 'status', {
    enumerable: true,
    get() { accessorCalls += 1; throw new Error(secret); },
  });
  assert.throws(
    () => normalizeSpecialistProviderExecutionV1(accessorRecord),
    error => error instanceof Error
      && /data property/u.test(error.message)
      && !error.message.includes(secret),
  );
  assert.equal(accessorCalls, 0);

  // The rejected input must not corrupt the durable good execution snapshot.
  const restarted = normalizeSpecialistProviderExecutionV1(
    JSON.parse(JSON.stringify(legitimate)),
  );
  assert.equal(restarted.leaseId, legitimate.leaseId);
  assert.equal(restarted.providerId, legitimate.providerId);
  assert.equal(restarted.status, SpecialistProviderExecutionStatus.PREPARED);
  assert.deepEqual(JSON.parse(JSON.stringify(restarted)), legitimate);
});

test('Section 1: preparation request is descriptor-safe before any execution/lease binding', () => {
  const canonical = prepared();
  const request = {
    planId: canonical.planId,
    nodeId: canonical.nodeId,
    agentId: canonical.agentId,
    handoffId: canonical.handoffId,
    providerId: canonical.providerId,
    leaseId: canonical.leaseId,
    leaseUntil: canonical.leaseUntil,
    conversationId: canonical.conversationId,
    providerConfig: canonical.providerConfig,
    at: canonical.preparedAt,
  };
  const secret = 'PRIVATE_PREPARATION_CREDENTIAL_CANARY_8121';
  for (const trapName of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
    const proxy = new Proxy({ ...request }, {
      [trapName]() { throw new Error(secret); },
    });
    assert.throws(
      () => createSpecialistProviderExecutionV1(proxy),
      error => error instanceof Error
        && /cannot be inspected safely/u.test(error.message)
        && !error.message.includes(secret)
        && !('cause' in error),
    );
  }
  let reads = 0;
  const getterRequest = { ...request };
  Object.defineProperty(getterRequest, 'leaseId', {
    enumerable: true,
    get() { reads += 1; throw new Error(secret); },
  });
  assert.throws(
    () => createSpecialistProviderExecutionV1(getterRequest),
    error => error instanceof Error
      && /data property/u.test(error.message)
      && !error.message.includes(secret),
  );
  assert.equal(reads, 0);
  assert.throws(
    () => createSpecialistProviderExecutionV1({ ...request, [secret]: 'x' }),
    error => error instanceof Error
      && /unknown field/u.test(error.message)
      && !error.message.includes(secret),
  );

  const restarted = normalizeSpecialistProviderExecutionV1(
    JSON.parse(JSON.stringify(createSpecialistProviderExecutionV1(request))),
  );
  assert.equal(restarted.leaseId, canonical.leaseId);
  assert.equal(restarted.conversationId, canonical.conversationId);
  assert.equal(restarted.status, SpecialistProviderExecutionStatus.PREPARED);
});


test('terminal Specialist provider success is immutable across durable replay and contradictory late outcome', () => {
  const terminal = recordSpecialistProviderExecutionOutcomeV1(prepared(), {
    providerStatus: 'finished',
    providerSucceeded: true,
    manualReviewRequired: false,
    reconciliationRequired: false,
    safeToRetry: false,
    effectEvidence: 'VERIFIED_TERMINAL_EFFECT_RECEIPT',
    errorCode: '',
    at: T1,
  });
  const cold = normalizeSpecialistProviderExecutionV1(JSON.parse(JSON.stringify(terminal)));
  const lateContradiction = {
    providerStatus: '',
    providerSucceeded: false,
    manualReviewRequired: false,
    reconciliationRequired: false,
    safeToRetry: true,
    effectEvidence: '',
    errorCode: 'LATE_TRANSPORT_RETRY',
    at: T2,
  };
  assert.deepEqual(recordSpecialistProviderExecutionOutcomeV1(cold, lateContradiction), cold);
  assert.equal(cold.status, SpecialistProviderExecutionStatus.PROVIDER_SUCCEEDED);
  assert.equal(cold.effectEvidence, 'VERIFIED_TERMINAL_EFFECT_RECEIPT');
  assert.equal(cold.safeToRetry, false);
  assert.equal(cold.updatedAt, T1, 'late retries must not replace terminal provenance');
});

test('terminal provider failure cannot be rewritten as success or execute hostile replay getters', () => {
  const failed = recordSpecialistProviderExecutionOutcomeV1(prepared(), {
    providerStatus: 'error',
    providerSucceeded: false,
    manualReviewRequired: true,
    reconciliationRequired: false,
    safeToRetry: false,
    effectEvidence: 'VERIFIED_FAILURE_RECEIPT',
    errorCode: '',
    at: T1,
  });
  const restored = normalizeSpecialistProviderExecutionV1(JSON.parse(JSON.stringify(failed)));
  let getterCalls = 0;
  const replay = { at: T2 };
  Object.defineProperty(replay, 'providerStatus', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw Error('SECRET_MUST_NOT_BE_READ');
    },
  });
  assert.deepEqual(recordSpecialistProviderExecutionOutcomeV1(restored, replay), restored);
  assert.equal(getterCalls, 0);
  assert.equal(restored.status, SpecialistProviderExecutionStatus.PROVIDER_FAILED);
  assert.equal(restored.effectEvidence, 'VERIFIED_FAILURE_RECEIPT');
  assert.equal(restored.safeToRetry, false);
});

test('Section 1: provider update must not occur after its observation, including cold JSON restart', () => {
  const preEffect = prepared();
  const terminal = {
    providerStatus: 'finished',
    providerSucceeded: true,
    manualReviewRequired: false,
    reconciliationRequired: false,
    safeToRetry: false,
    effectEvidence: 'EXACT_PROVIDER_TERMINAL_RECEIPT',
    errorCode: '',
    providerUpdatedAt: T2,
    providerObservedAt: T1,
    at: T1,
  };
  assert.throws(
    () => recordSpecialistProviderExecutionOutcomeV1(preEffect, terminal),
    /update cannot postdate its observation/,
  );
  // Invalid lower-trust observation cannot mutate a previously valid record.
  assert.equal(preEffect.status, SpecialistProviderExecutionStatus.PREPARED);
  assert.equal(preEffect.updatedAt, T0);
  const valid = recordSpecialistProviderExecutionOutcomeV1(preEffect, {
    ...terminal,
    providerUpdatedAt: T0,
  });
  assert.equal(valid.status, SpecialistProviderExecutionStatus.PROVIDER_SUCCEEDED);
  const restarted = normalizeSpecialistProviderExecutionV1(JSON.parse(JSON.stringify(valid)));
  assert.deepEqual(restarted, valid);
  assert.throws(
    () => normalizeSpecialistProviderExecutionV1(JSON.parse(JSON.stringify({
      ...restarted,
      providerUpdatedAt: T2,
    }))),
    /update cannot postdate its observation/,
  );
});
