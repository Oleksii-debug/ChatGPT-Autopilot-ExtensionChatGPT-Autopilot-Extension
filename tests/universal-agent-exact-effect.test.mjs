import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ExactEffectEventType,
  ExactEffectPhase,
  ReconciliationOutcome,
  createExactEffectStateV1,
  exactEffectCanExecuteV1,
  exactEffectNeedsReconciliationV1,
  normalizeExactEffectStateV1,
  reduceExactEffectV1,
} from '../src/core/universal-agent-exact-effect.js';

const AT = '2026-09-19T12:00:00Z';

function invocation(overrides = {}) {
  return {
    schemaVersion: 1,
    invocationId: 'invoke-1',
    toolId: 'filesystem.write',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.write'],
    policyDecisionId: 'decision-1',
    arguments: { pathRef: 'workspace:out.txt', contentRef: 'artifact-1' },
    createdAt: AT,
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    schemaVersion: 1,
    observationId: 'obs-1',
    invocationId: 'invoke-1',
    status: 'OK',
    summary: 'Effect observed.',
    data: { exists: true },
    artifactRefs: [],
    observedAt: '2026-09-19T12:00:03Z',
    ...overrides,
  };
}

function verification(overrides = {}) {
  return {
    schemaVersion: 1,
    verificationId: 'verify-1',
    invocationId: 'invoke-1',
    observationId: 'obs-1',
    status: 'VERIFIED',
    reasonCode: 'POSTCONDITION_MATCH',
    summary: 'Expected postcondition observed.',
    evidenceArtifactIds: [],
    verifiedAt: '2026-09-19T12:00:04Z',
    ...overrides,
  };
}

function event(type, eventId, at, fields = {}) {
  return {
    schemaVersion: 1,
    eventId,
    type,
    effectId: 'invoke-1',
    at,
    ...fields,
  };
}

test('exact-effect happy path is PREPARED -> EXECUTING -> OBSERVED -> VERIFIED -> COMMITTED', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  assert.equal(state.phase, ExactEffectPhase.PREPARED);
  assert.equal(exactEffectCanExecuteV1(state), true);

  let result = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'event-start',
    '2026-09-19T12:00:01Z',
  ));
  state = result.state;
  assert.equal(result.action, 'EXECUTE');
  assert.equal(state.phase, ExactEffectPhase.EXECUTING);
  assert.equal(state.attempt, 1);
  assert.equal(state.executionId, 'invoke-1:attempt:1');

  result = reduceExactEffectV1(state, event(
    ExactEffectEventType.RECORD_OBSERVATION,
    'event-observe',
    '2026-09-19T12:00:03Z',
    { observation: observation() },
  ));
  state = result.state;
  assert.equal(result.action, 'VERIFY');
  assert.equal(state.phase, ExactEffectPhase.OBSERVED);

  result = reduceExactEffectV1(state, event(
    ExactEffectEventType.RECORD_VERIFICATION,
    'event-verify',
    '2026-09-19T12:00:04Z',
    { verification: verification() },
  ));
  state = result.state;
  assert.equal(result.action, 'COMMIT');
  assert.equal(state.phase, ExactEffectPhase.VERIFIED);

  result = reduceExactEffectV1(state, event(
    ExactEffectEventType.COMMIT,
    'event-commit',
    '2026-09-19T12:00:05Z',
    { commitId: 'commit-1' },
  ));
  state = result.state;
  assert.equal(state.phase, ExactEffectPhase.COMMITTED);
  assert.equal(state.commitId, 'commit-1');
  assert.equal(exactEffectCanExecuteV1(state), false);
});

test('ambiguous physical outcome cannot be blind-replayed before reconciliation', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'start-1',
    '2026-09-19T12:00:01Z',
  )).state;

  let result = reduceExactEffectV1(state, event(
    ExactEffectEventType.DECLARE_AMBIGUITY,
    'ambiguous-1',
    '2026-09-19T12:00:02Z',
    { reasonCode: 'POST_SUBMIT_TRANSPORT_LOST', summary: 'Effect may have happened.' },
  ));
  state = result.state;
  assert.equal(state.phase, ExactEffectPhase.RECONCILE);
  assert.equal(exactEffectNeedsReconciliationV1(state), true);
  assert.equal(result.action, 'RECONCILE');

  result = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'blind-retry',
    '2026-09-19T12:00:03Z',
  ));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'BLIND_REPLAY_BLOCKED');
  assert.equal(result.action, 'RECONCILE');
  assert.equal(result.state.attempt, 1);
  assert.equal(result.state.phase, ExactEffectPhase.RECONCILE);
});

test('SAFE_RETRY is the only ambiguous path that authorizes another physical execution attempt', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'start-1',
    '2026-09-19T12:00:01Z',
  )).state;
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.DECLARE_AMBIGUITY,
    'ambiguous-1',
    '2026-09-19T12:00:02Z',
    { reasonCode: 'UNKNOWN_EFFECT', summary: 'Need verifier.' },
  )).state;

  let result = reduceExactEffectV1(state, event(
    ExactEffectEventType.RESOLVE_RECONCILIATION,
    'reconcile-safe-retry',
    '2026-09-19T12:00:04Z',
    {
      outcome: ReconciliationOutcome.SAFE_RETRY,
      reasonCode: 'POSTCONDITION_PROVES_NO_EFFECT',
      summary: 'Verifier proved effect did not occur.',
    },
  ));
  state = result.state;
  assert.equal(state.phase, ExactEffectPhase.SAFE_RETRY);
  assert.equal(result.action, 'SAFE_RETRY');
  assert.equal(exactEffectCanExecuteV1(state), true);

  result = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'start-2',
    '2026-09-19T12:00:05Z',
  ));
  state = result.state;
  assert.equal(state.phase, ExactEffectPhase.EXECUTING);
  assert.equal(state.attempt, 2);
  assert.equal(state.executionId, 'invoke-1:attempt:2');
});

test('verified reconciliation commits the original ambiguous effect without replaying it', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'start-1',
    '2026-09-19T12:00:01Z',
  )).state;
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.RECORD_OBSERVATION,
    'obs-event',
    '2026-09-19T12:00:03Z',
    { observation: observation() },
  )).state;
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.DECLARE_AMBIGUITY,
    'ambiguous-after-observe',
    '2026-09-19T12:00:03Z',
    { reasonCode: 'ACK_LOST', summary: 'Need postcondition reconciliation.' },
  )).state;

  let result = reduceExactEffectV1(state, event(
    ExactEffectEventType.RESOLVE_RECONCILIATION,
    'reconcile-verified',
    '2026-09-19T12:00:04Z',
    {
      outcome: ReconciliationOutcome.VERIFIED,
      reasonCode: 'POSTCONDITION_MATCH',
      summary: 'Effect exists exactly once.',
      verification: verification(),
    },
  ));
  state = result.state;
  assert.equal(state.phase, ExactEffectPhase.VERIFIED);
  assert.equal(state.attempt, 1);
  assert.equal(result.action, 'COMMIT');

  result = reduceExactEffectV1(state, event(
    ExactEffectEventType.COMMIT,
    'commit-original',
    '2026-09-19T12:00:05Z',
    { commitId: 'commit-original' },
  ));
  assert.equal(result.state.phase, ExactEffectPhase.COMMITTED);
  assert.equal(result.state.attempt, 1);
});

test('MANUAL_REVIEW reconciliation is terminal for automatic execution', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'start-1',
    '2026-09-19T12:00:01Z',
  )).state;
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.DECLARE_AMBIGUITY,
    'ambiguous-1',
    '2026-09-19T12:00:02Z',
    { reasonCode: 'CONFLICTING_EVIDENCE' },
  )).state;

  let result = reduceExactEffectV1(state, event(
    ExactEffectEventType.RESOLVE_RECONCILIATION,
    'manual-review',
    '2026-09-19T12:00:04Z',
    {
      outcome: ReconciliationOutcome.MANUAL_REVIEW,
      reasonCode: 'CONFLICT_UNRESOLVED',
      summary: 'Cannot prove presence or absence of effect.',
    },
  ));
  state = result.state;
  assert.equal(state.phase, ExactEffectPhase.MANUAL_REVIEW);
  assert.equal(result.action, 'MANUAL_REVIEW');
  assert.equal(exactEffectCanExecuteV1(state), false);

  result = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'manual-blind-retry',
    '2026-09-19T12:00:05Z',
  ));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'BLIND_REPLAY_BLOCKED');
  assert.equal(result.state.attempt, 1);
});

test('verification ambiguity routes to reconciliation; failed verification does not silently retry', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'start',
    '2026-09-19T12:00:01Z',
  )).state;
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.RECORD_OBSERVATION,
    'observe',
    '2026-09-19T12:00:03Z',
    { observation: observation() },
  )).state;

  let result = reduceExactEffectV1(state, event(
    ExactEffectEventType.RECORD_VERIFICATION,
    'verify-ambiguous',
    '2026-09-19T12:00:04Z',
    {
      verification: verification({
        status: 'AMBIGUOUS',
        reasonCode: 'POSTCONDITION_UNCLEAR',
      }),
    },
  ));
  assert.equal(result.state.phase, ExactEffectPhase.RECONCILE);
  assert.equal(result.action, 'RECONCILE');

  state = createExactEffectStateV1(invocation(), { createdAt: AT });
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'start-failed',
    '2026-09-19T12:00:01Z',
  )).state;
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.RECORD_OBSERVATION,
    'observe-failed',
    '2026-09-19T12:00:03Z',
    { observation: observation() },
  )).state;
  result = reduceExactEffectV1(state, event(
    ExactEffectEventType.RECORD_VERIFICATION,
    'verify-failed',
    '2026-09-19T12:00:04Z',
    {
      verification: verification({
        status: 'FAILED',
        reasonCode: 'POSTCONDITION_FAILED',
      }),
    },
  ));
  assert.equal(result.state.phase, ExactEffectPhase.MANUAL_REVIEW);
  assert.equal(result.action, 'MANUAL_REVIEW');
});

test('effect event replay is idempotent across durable restart', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  const start = event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'start-once',
    '2026-09-19T12:00:01Z',
  );
  let result = reduceExactEffectV1(state, start);
  state = JSON.parse(JSON.stringify(result.state));

  result = reduceExactEffectV1(state, start);
  assert.equal(result.deduplicated, true);
  assert.equal(result.reason, 'DUPLICATE_EVENT');
  assert.equal(result.state.attempt, 1);
  assert.equal(result.state.executionId, 'invoke-1:attempt:1');
});

test('state normalization rejects corrupted durable bindings and mismatched evidence', () => {
  const state = createExactEffectStateV1(invocation(), { createdAt: AT });
  assert.throws(
    () => normalizeExactEffectStateV1({ ...state, effectId: 'invoke-other' }),
    /effectId must equal invocationId/,
  );

  let executing = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'start',
    '2026-09-19T12:00:01Z',
  )).state;

  assert.throws(
    () => reduceExactEffectV1(executing, event(
      ExactEffectEventType.RECORD_OBSERVATION,
      'bad-observation',
      '2026-09-19T12:00:03Z',
      { observation: observation({ invocationId: 'invoke-other' }) },
    )),
    /does not match effect invocation/,
  );

  executing = reduceExactEffectV1(executing, event(
    ExactEffectEventType.RECORD_OBSERVATION,
    'good-observation',
    '2026-09-19T12:00:03Z',
    { observation: observation() },
  )).state;

  assert.throws(
    () => reduceExactEffectV1(executing, event(
      ExactEffectEventType.RECORD_VERIFICATION,
      'bad-verification',
      '2026-09-19T12:00:04Z',
      { verification: verification({ observationId: 'obs-other' }) },
    )),
    /does not match current effect observation/,
  );
});

test('commit is impossible without verified evidence', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'start',
    '2026-09-19T12:00:01Z',
  )).state;

  let result = reduceExactEffectV1(state, event(
    ExactEffectEventType.COMMIT,
    'early-commit',
    '2026-09-19T12:00:02Z',
    { commitId: 'commit-too-early' },
  ));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'COMMIT_REQUIRES_VERIFIED_EFFECT');
  assert.equal(result.state.phase, ExactEffectPhase.EXECUTING);
});
