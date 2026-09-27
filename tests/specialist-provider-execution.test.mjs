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
