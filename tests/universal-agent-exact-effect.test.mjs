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
    effectId: 'invoke-1',
    executionId: 'invoke-1:attempt:1',
    attempt: 1,
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
    executionId: 'invoke-1:attempt:1',
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
      observation: observation({ observationId: 'reconcile-obs-1', status: 'ERROR', summary: 'Expected effect is absent.' }),
      verification: verification({
        verificationId: 'reconcile-verify-1',
        observationId: 'reconcile-obs-1',
        status: 'FAILED',
        reasonCode: 'POSTCONDITION_ABSENT',
        summary: 'No committed effect exists; retry is safe.',
      }),
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

test('SAFE_RETRY without fresh reconciliation evidence fails closed', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'start-no-evidence',
    '2026-09-19T12:00:01Z',
  )).state;
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.DECLARE_AMBIGUITY,
    'ambiguous-no-evidence',
    '2026-09-19T12:00:02Z',
    { reasonCode: 'UNKNOWN_EFFECT' },
  )).state;

  assert.throws(
    () => reduceExactEffectV1(state, event(
      ExactEffectEventType.RESOLVE_RECONCILIATION,
      'unsafe-safe-retry',
      '2026-09-19T12:00:03Z',
      {
        outcome: ReconciliationOutcome.SAFE_RETRY,
        reasonCode: 'CALLER_ASSERTED_SAFE',
      },
    )),
    /requires observation and failed verification evidence/,
  );
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

test('late evidence from an older execution attempt cannot satisfy a SAFE_RETRY attempt', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'start-attempt-1',
    '2026-09-19T12:00:01Z',
  )).state;
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.DECLARE_AMBIGUITY,
    'ambiguous-attempt-1',
    '2026-09-19T12:00:02Z',
    { reasonCode: 'UNKNOWN_EFFECT' },
  )).state;
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.RESOLVE_RECONCILIATION,
    'safe-retry-attempt-1',
    '2026-09-19T12:00:03Z',
    {
      outcome: ReconciliationOutcome.SAFE_RETRY,
      reasonCode: 'NO_EFFECT_PROVEN',
      observation: observation({ observationId: 'reconcile-obs-late', status: 'ERROR', summary: 'Effect absent.' }),
      verification: verification({
        verificationId: 'reconcile-verify-late',
        observationId: 'reconcile-obs-late',
        status: 'FAILED',
        reasonCode: 'POSTCONDITION_ABSENT',
      }),
    },
  )).state;
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'start-attempt-2',
    '2026-09-19T12:00:04Z',
  )).state;
  assert.equal(state.executionId, 'invoke-1:attempt:2');

  assert.throws(
    () => reduceExactEffectV1(state, event(
      ExactEffectEventType.RECORD_OBSERVATION,
      'late-observation-attempt-1',
      '2026-09-19T12:00:05Z',
      {
        executionId: 'invoke-1:attempt:1',
        observation: observation({ observationId: 'obs-late-attempt-1' }),
      },
    )),
    /executionId does not match current exact-effect attempt/,
  );

  const current = reduceExactEffectV1(state, event(
    ExactEffectEventType.RECORD_OBSERVATION,
    'observation-attempt-2',
    '2026-09-19T12:00:05Z',
    {
      executionId: 'invoke-1:attempt:2',
      observation: observation({ observationId: 'obs-attempt-2' }),
    },
  ));
  assert.equal(current.state.phase, ExactEffectPhase.OBSERVED);
  assert.equal(current.state.observation.observationId, 'obs-attempt-2');
});

test('rejected events do not mutate durable state and may later apply with the same event identity', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  const premature = event(
    ExactEffectEventType.RECORD_OBSERVATION,
    'premature-observation',
    '2026-09-19T12:00:02Z',
    { observation: observation({ observedAt: '2026-09-19T12:00:02Z' }) },
  );
  const before = JSON.parse(JSON.stringify(state));
  let result = reduceExactEffectV1(state, premature);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.state, before);
  assert.deepEqual(result.state.processedEventIds, []);
  assert.equal(result.state.updatedAt, AT);

  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'start-before-premature',
    '2026-09-19T12:00:01Z',
  )).state;
  result = reduceExactEffectV1(state, premature);
  assert.equal(result.accepted, true);
  assert.equal(result.state.phase, ExactEffectPhase.OBSERVED);
  assert.ok(result.state.processedEventIds.includes('premature-observation'));
});

test('new events cannot regress durable time while old accepted duplicates remain idempotent', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  const start = event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'chronology-start',
    '2026-09-19T12:00:01Z',
  );
  state = reduceExactEffectV1(state, start).state;
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.RECORD_OBSERVATION,
    'chronology-observe',
    '2026-09-19T12:00:03Z',
    { observation: observation({ observedAt: '2026-09-19T12:00:03Z' }) },
  )).state;

  const replay = reduceExactEffectV1(state, start);
  assert.equal(replay.accepted, true);
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.state.updatedAt, '2026-09-19T12:00:03Z');

  assert.throws(
    () => reduceExactEffectV1(state, event(
      ExactEffectEventType.DECLARE_AMBIGUITY,
      'stale-new-event',
      '2026-09-19T12:00:02Z',
      { reasonCode: 'STALE_EVENT' },
    )),
    /cannot predate current durable state/,
  );
  assert.equal(state.updatedAt, '2026-09-19T12:00:03Z');
  assert.equal(state.processedEventIds.includes('stale-new-event'), false);
});

test('verification used by exact effect requires exact effect execution and attempt bindings', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'binding-start',
    '2026-09-19T12:00:01Z',
  )).state;
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.RECORD_OBSERVATION,
    'binding-observe',
    '2026-09-19T12:00:03Z',
    { observation: observation() },
  )).state;

  const cases = [
    [{ effectId: '' }, /effectId does not match exact effect/],
    [{ effectId: 'invoke-other' }, /effectId does not match exact effect/],
    [{ executionId: '' }, /executionId does not match current exact-effect attempt/],
    [{ executionId: 'invoke-1:attempt:2' }, /executionId does not match current exact-effect attempt/],
    [{ attempt: 0 }, /attempt does not match current exact-effect attempt/],
    [{ attempt: 2 }, /attempt does not match current exact-effect attempt/],
  ];
  for (const [overrides, pattern] of cases) {
    assert.throws(
      () => reduceExactEffectV1(state, event(
        ExactEffectEventType.RECORD_VERIFICATION,
        `binding-bad-${Object.keys(overrides)[0]}-${String(Object.values(overrides)[0])}`,
        '2026-09-19T12:00:04Z',
        { verification: verification(overrides) },
      )),
      pattern,
    );
  }

  const valid = reduceExactEffectV1(state, event(
    ExactEffectEventType.RECORD_VERIFICATION,
    'binding-valid',
    '2026-09-19T12:00:04Z',
    { verification: verification() },
  ));
  assert.equal(valid.state.phase, ExactEffectPhase.VERIFIED);
  assert.equal(valid.action, 'COMMIT');
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


test('exact-effect envelope rejects coercive durable state aliases', () => {
  const state = createExactEffectStateV1(invocation(), { createdAt: AT });

  assert.throws(
    () => normalizeExactEffectStateV1({ ...state, schemaVersion: '1' }),
    /schemaVersion/,
  );
  assert.throws(
    () => normalizeExactEffectStateV1({ ...state, effectId: 1 }),
    /effectId is invalid/,
  );
  assert.throws(
    () => normalizeExactEffectStateV1({ ...state, phase: ' prepared ' }),
    /phase is invalid/,
  );

  const executing = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'strict-start',
    '2026-09-19T12:00:01Z',
  )).state;
  assert.throws(
    () => normalizeExactEffectStateV1({ ...executing, attempt: '1' }),
    /attempt is invalid/,
  );
  assert.throws(
    () => normalizeExactEffectStateV1({ ...executing, executionId: 1 }),
    /executionId is invalid/,
  );
  assert.throws(
    () => normalizeExactEffectStateV1({ ...state, commitId: true }),
    /commitId is invalid/,
  );
});

test('state, nested metadata and create options reject accessors before getter execution', () => {
  const state = createExactEffectStateV1(invocation(), { createdAt: AT });
  let reads = 0;

  const hostileState = { ...state };
  Object.defineProperty(hostileState, 'phase', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'PREPARED';
    },
  });
  assert.throws(
    () => normalizeExactEffectStateV1(hostileState),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);

  const hostileAmbiguity = { ...state.ambiguity };
  Object.defineProperty(hostileAmbiguity, 'reasonCode', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'FORGED';
    },
  });
  assert.throws(
    () => normalizeExactEffectStateV1({ ...state, ambiguity: hostileAmbiguity }),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);

  const options = {};
  Object.defineProperty(options, 'createdAt', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return AT;
    },
  });
  assert.throws(
    () => createExactEffectStateV1(invocation(), options),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);
});

test('state envelope rejects hidden, symbol and inherited authority aliases', () => {
  const state = createExactEffectStateV1(invocation(), { createdAt: AT });

  const hidden = { ...state };
  Object.defineProperty(hidden, 'authorityGranted', {
    value: true,
    enumerable: false,
    configurable: true,
  });
  assert.throws(
    () => normalizeExactEffectStateV1(hidden),
    /unknown field: authorityGranted/,
  );

  const symbolic = { ...state };
  symbolic[Symbol('authority')] = true;
  assert.throws(
    () => normalizeExactEffectStateV1(symbolic),
    /symbol fields/,
  );

  const inherited = Object.assign(Object.create({ phase: 'COMMITTED' }), state);
  assert.throws(
    () => normalizeExactEffectStateV1(inherited),
    /plain data object/,
  );
});

test('processed event IDs require a plain dense data array', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'dense-start',
    '2026-09-19T12:00:01Z',
  )).state;

  const custom = [...state.processedEventIds];
  custom.authority = true;
  assert.throws(
    () => normalizeExactEffectStateV1({ ...state, processedEventIds: custom }),
    /non-index fields/,
  );

  const sparse = new Array(1);
  assert.throws(
    () => normalizeExactEffectStateV1({ ...state, processedEventIds: sparse }),
    /enumerable own data item/,
  );

  let reads = 0;
  const accessor = [...state.processedEventIds];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'dense-start';
    },
  });
  assert.throws(
    () => normalizeExactEffectStateV1({ ...state, processedEventIds: accessor }),
    /enumerable own data item/,
  );
  assert.equal(reads, 0);
});

test('event envelope rejects coercion and accessors before transition logic', () => {
  const state = createExactEffectStateV1(invocation(), { createdAt: AT });
  const good = event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'strict-event',
    '2026-09-19T12:00:01Z',
  );

  assert.throws(
    () => reduceExactEffectV1(state, { ...good, schemaVersion: '1' }),
    /schemaVersion/,
  );
  assert.throws(
    () => reduceExactEffectV1(state, { ...good, eventId: 1 }),
    /eventId is invalid/,
  );
  assert.throws(
    () => reduceExactEffectV1(state, { ...good, type: ' begin_execution ' }),
    /event type is invalid/,
  );
  assert.throws(
    () => reduceExactEffectV1(state, { ...good, effectId: true }),
    /event\.effectId is invalid/,
  );
  assert.throws(
    () => reduceExactEffectV1(state, { ...good, executionId: 1 }),
    /event\.executionId is invalid/,
  );

  let reads = 0;
  const accessor = { ...good };
  Object.defineProperty(accessor, 'type', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return ExactEffectEventType.BEGIN_EXECUTION;
    },
  });
  assert.throws(
    () => reduceExactEffectV1(state, accessor),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);
});

test('nested reconciliation outcome uses exact enum representation and strict data fields', () => {
  let state = createExactEffectStateV1(invocation(), { createdAt: AT });
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'reconcile-start',
    '2026-09-19T12:00:01Z',
  )).state;
  state = reduceExactEffectV1(state, event(
    ExactEffectEventType.DECLARE_AMBIGUITY,
    'reconcile-ambiguous',
    '2026-09-19T12:00:02Z',
    { reasonCode: 'UNKNOWN_EFFECT' },
  )).state;

  assert.throws(
    () => reduceExactEffectV1(state, event(
      ExactEffectEventType.RESOLVE_RECONCILIATION,
      'reconcile-alias',
      '2026-09-19T12:00:03Z',
      {
        outcome: 'safe_retry',
        reasonCode: 'NO_EFFECT_PROVEN',
        observation: observation({
          observationId: 'reconcile-alias-observation',
          status: 'ERROR',
          summary: 'Effect absent.',
        }),
        verification: verification({
          verificationId: 'reconcile-alias-verification',
          observationId: 'reconcile-alias-observation',
          status: 'FAILED',
          reasonCode: 'POSTCONDITION_ABSENT',
        }),
      },
    )),
    /Reconciliation outcome is invalid/,
  );

  const persisted = { ...state.reconciliation };
  persisted[Symbol('authority')] = true;
  assert.throws(
    () => normalizeExactEffectStateV1({ ...state, reconciliation: persisted }),
    /symbol fields/,
  );
});

test('null-prototype durable state and event records remain supported', () => {
  const state = createExactEffectStateV1(invocation(), { createdAt: AT });
  const nullState = Object.assign(Object.create(null), JSON.parse(JSON.stringify(state)));
  const normalized = normalizeExactEffectStateV1(nullState);
  assert.equal(normalized.phase, ExactEffectPhase.PREPARED);

  const rawEvent = Object.assign(Object.create(null), event(
    ExactEffectEventType.BEGIN_EXECUTION,
    'null-proto-event',
    '2026-09-19T12:00:01Z',
  ));
  const result = reduceExactEffectV1(normalized, rawEvent);
  assert.equal(result.state.phase, ExactEffectPhase.EXECUTING);
});
