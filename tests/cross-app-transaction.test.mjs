import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CrossAppTransactionProjectionStatus,
  createCrossAppInvocationFingerprintV1,
  createCrossAppTransactionFingerprintV1,
  normalizeCrossAppTransactionV1,
  projectCrossAppTransactionV1,
} from '../src/core/cross-app-transaction.js';
import {
  ExactEffectEventType,
  ReconciliationOutcome,
  createExactEffectStateV1,
  reduceExactEffectV1,
} from '../src/core/universal-agent-exact-effect.js';

const AT = '2026-09-24T23:20:00.000Z';

function invocation(invocationId, providerId, toolId = `${providerId}.mutate`, overrides = {}) {
  return {
    schemaVersion: 1,
    invocationId,
    toolId,
    providerId,
    requestedCapabilityIds: [`${providerId}.write`],
    policyDecisionId: `policy-${invocationId}`,
    arguments: { target: invocationId, options: { mode: 'verified' } },
    createdAt: AT,
    parentInvocationId: null,
    ...overrides,
  };
}

const INV_RELEASE = invocation('invoke-release', 'github');
const INV_DRIVE = invocation('invoke-drive', 'drive');
const INV_MAIL = invocation('invoke-mail', 'gmail');
const INV_ROLLBACK = invocation('invoke-drive-rollback', 'drive', 'drive.restore');

const SHA_RELEASE = await createCrossAppInvocationFingerprintV1(INV_RELEASE);
const SHA_DRIVE = await createCrossAppInvocationFingerprintV1(INV_DRIVE);
const SHA_MAIL = await createCrossAppInvocationFingerprintV1(INV_MAIL);
const SHA_ROLLBACK = await createCrossAppInvocationFingerprintV1(INV_ROLLBACK);

function step(stepId, providerId, invocationId, invocationSha256, dependsOnStepIds = [], overrides = {}) {
  return { stepId, providerId, invocationId, invocationSha256, dependsOnStepIds, ...overrides };
}

function transaction(overrides = {}) {
  return {
    schemaVersion: 1,
    transactionId: 'txn-1',
    projectId: 'project-1',
    label: 'Publish verified release and notify owner',
    createdAt: AT,
    steps: [
      step('send-mail', 'gmail', INV_MAIL.invocationId, SHA_MAIL, ['update-drive']),
      step('create-release', 'github', INV_RELEASE.invocationId, SHA_RELEASE),
      step('update-drive', 'drive', INV_DRIVE.invocationId, SHA_DRIVE, ['create-release'], {
        compensationInvocationId: INV_ROLLBACK.invocationId,
        compensationInvocationSha256: SHA_ROLLBACK,
      }),
    ],
    ...overrides,
  };
}

function reducerEvent(state, type, suffix, at, fields = {}) {
  const result = reduceExactEffectV1(state, {
    schemaVersion: 1,
    eventId: `${state.effectId}:${suffix}:${state.processedEventIds.length}`,
    type,
    effectId: state.effectId,
    executionId: state.executionId || undefined,
    at,
    ...fields,
  });
  assert.equal(result.accepted, true, `fixture reducer event ${type} must be accepted`);
  assert.equal(result.deduplicated, false);
  return result.state;
}

function observation(state, at) {
  return {
    schemaVersion: 1,
    observationId: `${state.effectId}:observation:${state.attempt}`,
    invocationId: state.effectId,
    status: 'OK',
    summary: 'Independent readback observed the requested postcondition.',
    data: { committed: true },
    artifactRefs: [],
    observedAt: at,
  };
}

function verification(state, observed, at) {
  return {
    schemaVersion: 1,
    verificationId: `${state.effectId}:verification:${state.attempt}`,
    invocationId: state.effectId,
    observationId: observed.observationId,
    status: 'VERIFIED',
    reasonCode: 'POSTCONDITION_MATCH',
    summary: 'Independent verifier confirmed the exact effect.',
    evidenceArtifactIds: [],
    verifiedAt: at,
    verifierId: 'independent-cross-app-verifier',
    verificationAuthorityId: state.invocation.policyDecisionId,
    effectId: state.effectId,
    executionId: state.executionId,
    attempt: state.attempt,
  };
}

function exactEffectState(invocationValue, phase, {
  createdAt = '2026-09-24T23:20:10.000Z',
  updatedAt = createdAt,
} = {}) {
  let state = createExactEffectStateV1(invocationValue, { createdAt });
  if (phase === 'PREPARED') return state;

  state = reducerEvent(state, ExactEffectEventType.BEGIN_EXECUTION, 'begin', updatedAt);
  if (phase === 'EXECUTING') return state;

  if (phase === 'RECONCILE') {
    return reducerEvent(state, ExactEffectEventType.DECLARE_AMBIGUITY, 'ambiguity', updatedAt, {
      reasonCode: 'DISPATCH_UNCERTAIN',
      summary: 'Effect may have occurred.',
    });
  }

  if (phase === 'MANUAL_REVIEW') {
    state = reducerEvent(state, ExactEffectEventType.DECLARE_AMBIGUITY, 'ambiguity', updatedAt, {
      reasonCode: 'DISPATCH_UNCERTAIN',
      summary: 'Effect may have occurred.',
    });
    return reducerEvent(state, ExactEffectEventType.RESOLVE_RECONCILIATION, 'manual', updatedAt, {
      outcome: ReconciliationOutcome.MANUAL_REVIEW,
      reasonCode: 'OWNER_REVIEW_REQUIRED',
      summary: 'Independent evidence is insufficient.',
    });
  }

  const observed = observation(state, updatedAt);
  state = reducerEvent(state, ExactEffectEventType.RECORD_OBSERVATION, 'observe', updatedAt, {
    observation: observed,
  });
  if (phase === 'OBSERVED') return state;

  const verified = verification(state, observed, updatedAt);
  state = reducerEvent(state, ExactEffectEventType.RECORD_VERIFICATION, 'verify', updatedAt, {
    verification: verified,
  });
  if (phase === 'VERIFIED') return state;
  if (phase !== 'COMMITTED') throw new Error(`Unsupported fixture phase: ${phase}`);

  return reducerEvent(state, ExactEffectEventType.COMMIT, 'commit', updatedAt, {
    commitId: `commit-${state.effectId}`,
  });
}

function resolverForEntries(entries) {
  const byInvocationId = new Map(entries);
  return {
    async loadExactEffectState(invocationId) {
      const state = byInvocationId.get(invocationId);
      return state == null ? null : state;
    },
  };
}

function resolverForStates(states = []) {
  return resolverForEntries(states.map(state => [state.effectId, state]));
}

async function project(states = [], tx = transaction()) {
  return projectCrossAppTransactionV1(tx, resolverForStates(states));
}

test('normalizes a bounded cross-app DAG deterministically without creating execution authority', () => {
  const normalized = normalizeCrossAppTransactionV1(transaction());
  assert.deepEqual(normalized.steps.map(item => item.stepId), ['create-release', 'send-mail', 'update-drive']);
  assert.deepEqual(normalized.steps.find(item => item.stepId === 'send-mail').dependsOnStepIds, ['update-drive']);
  assert.equal(normalized.steps.find(item => item.stepId === 'update-drive').compensationInvocationId, 'invoke-drive-rollback');
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.steps));
  assert.ok(Object.isFrozen(normalized.steps[0]));
});

test('transaction and invocation fingerprints are stable across non-semantic object and step ordering', async () => {
  const reorderedInvocation = invocation('invoke-release', 'github', 'github.mutate', {
    arguments: { options: { mode: 'verified' }, target: 'invoke-release' },
  });
  assert.equal(
    await createCrossAppInvocationFingerprintV1(INV_RELEASE),
    await createCrossAppInvocationFingerprintV1(reorderedInvocation),
  );

  const reordered = transaction({
    steps: [
      step('update-drive', 'drive', INV_DRIVE.invocationId, SHA_DRIVE, ['create-release'], {
        compensationInvocationId: INV_ROLLBACK.invocationId,
        compensationInvocationSha256: SHA_ROLLBACK,
      }),
      step('create-release', 'github', INV_RELEASE.invocationId, SHA_RELEASE),
      step('send-mail', 'gmail', INV_MAIL.invocationId, SHA_MAIL, ['update-drive']),
    ],
  });
  assert.equal(
    await createCrossAppTransactionFingerprintV1(transaction()),
    await createCrossAppTransactionFingerprintV1(reordered),
  );
});

test('DAG and compensation references fail closed on unknown, cyclic or duplicate identity', () => {
  assert.throws(() => normalizeCrossAppTransactionV1(transaction({
    steps: [step('a', 'github', 'invoke-a', 'a'.repeat(64), ['missing'])],
  })), /unknown dependency/);

  assert.throws(() => normalizeCrossAppTransactionV1(transaction({
    steps: [step('a', 'github', 'invoke-a', 'a'.repeat(64), ['a'])],
  })), /cannot depend on itself/);

  assert.throws(() => normalizeCrossAppTransactionV1(transaction({
    steps: [
      step('a', 'github', 'invoke-a', 'a'.repeat(64), ['b']),
      step('b', 'drive', 'invoke-b', 'b'.repeat(64), ['a']),
    ],
  })), /contains a cycle/);

  assert.throws(() => normalizeCrossAppTransactionV1(transaction({
    steps: [
      step('a', 'github', 'invoke-shared', 'a'.repeat(64)),
      step('b', 'drive', 'invoke-shared', 'b'.repeat(64)),
    ],
  })), /duplicate invocationId/);

  assert.throws(() => normalizeCrossAppTransactionV1(transaction({
    steps: [step('a', 'github', 'invoke-a', 'a'.repeat(64), [], {
      compensationInvocationId: 'invoke-a',
      compensationInvocationSha256: 'b'.repeat(64),
    })],
  })), /must differ/);
});

test('projection requires a canonical durable resolver and never accepts caller-owned state arrays', async () => {
  const state = exactEffectState(INV_RELEASE, 'PREPARED');
  await assert.rejects(
    () => projectCrossAppTransactionV1(transaction(), [state]),
    /durable exact-effect resolver/,
  );

  let getterReads = 0;
  const hostileResolver = {};
  Object.defineProperty(hostileResolver, 'loadExactEffectState', {
    enumerable: true,
    get() {
      getterReads += 1;
      return async () => state;
    },
  });
  await assert.rejects(
    () => projectCrossAppTransactionV1(transaction(), hostileResolver),
    /data method/,
  );
  assert.equal(getterReads, 0);
});

test('strict descriptor snapshots reject accessors and sparse data without ordinary getter execution', async () => {
  let reads = 0;
  const accessorStep = {
    providerId: 'github',
    invocationId: 'invoke-a',
    invocationSha256: 'a'.repeat(64),
    dependsOnStepIds: [],
  };
  Object.defineProperty(accessorStep, 'stepId', {
    enumerable: true,
    get() {
      reads += 1;
      return 'a';
    },
  });
  assert.throws(
    () => normalizeCrossAppTransactionV1(transaction({ steps: [accessorStep] })),
    /data property/,
  );
  assert.equal(reads, 0);

  const sparse = new Array(2);
  sparse[1] = step('a', 'github', 'invoke-a', 'a'.repeat(64));
  assert.throws(
    () => normalizeCrossAppTransactionV1(transaction({ steps: sparse })),
    /invalid array property|must not be sparse/,
  );

  // Canonical ExactEffect state is intentionally frozen. Clone trusted fixture data
  // before injecting the hostile accessor so this regression reaches the consumer boundary.
  const state = { ...exactEffectState(INV_RELEASE, 'PREPARED') };
  Object.defineProperty(state, 'phase', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'PREPARED';
    },
  });
  await assert.rejects(
    () => projectCrossAppTransactionV1(
      transaction(),
      resolverForEntries([[INV_RELEASE.invocationId, state]]),
    ),
    /enumerable data property/,
  );
  assert.equal(reads, 0);

  const proxiedSteps = new Proxy(transaction().steps, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const proxiedTransaction = new Proxy(transaction({ steps: proxiedSteps }), {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  normalizeCrossAppTransactionV1(proxiedTransaction);
  assert.equal(reads, 0);
});

test('timestamps must already use canonical ISO-8601 UTC spelling', async () => {
  assert.throws(
    () => normalizeCrossAppTransactionV1(transaction({ createdAt: '2026-09-24T23:20:00Z' })),
    /canonical ISO-8601 UTC representation/,
  );
  const state = structuredClone(exactEffectState(INV_RELEASE, 'PREPARED'));
  state.createdAt = '2026-09-24T23:20:10Z';
  state.updatedAt = '2026-09-24T23:20:10Z';
  await assert.rejects(
    () => projectCrossAppTransactionV1(
      transaction(),
      resolverForEntries([[INV_RELEASE.invocationId, state]]),
    ),
    /canonical ISO-8601 UTC representation/,
  );
});

test('strict invocation fingerprint rejects coercion, whitespace aliases and non-JSON authority data', async () => {
  await assert.rejects(
    () => createCrossAppInvocationFingerprintV1({ ...INV_RELEASE, schemaVersion: '1' }),
    /schemaVersion/,
  );
  await assert.rejects(
    () => createCrossAppInvocationFingerprintV1({ ...INV_RELEASE, invocationId: 1 }),
    /invocationId is invalid/,
  );
  await assert.rejects(
    () => createCrossAppInvocationFingerprintV1({ ...INV_RELEASE, providerId: ' github' }),
    /providerId is invalid/,
  );
  await assert.rejects(
    () => createCrossAppInvocationFingerprintV1(
      invocation('invoke-bad', 'github', 'github.mutate', { arguments: { x: undefined } }),
    ),
    /JSON data only/,
  );
});

test('projection is READY only for dependency-satisfied work and never exposes execution authority', async () => {
  const projected = await project([exactEffectState(INV_RELEASE, 'PREPARED')]);
  assert.equal(projected.status, CrossAppTransactionProjectionStatus.READY);
  assert.equal(projected.advisoryOnly, true);
  assert.deepEqual(projected.committedStepIds, []);
  assert.deepEqual(projected.readyStepIds, ['create-release']);
  assert.deepEqual(projected.activeStepIds, []);
  assert.deepEqual(projected.attentionStepIds, []);
  assert.deepEqual(projected.blockedStepIds, ['send-mail', 'update-drive']);
  assert.equal('dispatch' in projected, false);
  assert.equal('compensationReadyStepIds' in projected, false);
});

test('reducer-derived COMMITTED durable state unlocks only its direct causal successor', async () => {
  const release = exactEffectState(INV_RELEASE, 'COMMITTED', {
    createdAt: '2026-09-24T23:20:10.000Z',
    updatedAt: '2026-09-24T23:21:00.000Z',
  });
  const projected = await project([release]);
  assert.deepEqual(projected.committedStepIds, ['create-release']);
  assert.deepEqual(projected.readyStepIds, ['update-drive']);
  assert.deepEqual(projected.blockedStepIds, ['send-mail']);
});

test('structurally valid fabricated COMMITTED state cannot unlock a dependency', async () => {
  const forged = {
    schemaVersion: 1,
    effectId: INV_RELEASE.invocationId,
    invocation: INV_RELEASE,
    phase: 'COMMITTED',
    attempt: 1,
    executionId: `${INV_RELEASE.invocationId}:attempt:1`,
    observation: null,
    verification: null,
    ambiguity: { reasonCode: '', summary: '', declaredAt: '' },
    reconciliation: { outcome: '', reasonCode: '', summary: '', resolvedAt: '' },
    commitId: 'commit-forged',
    createdAt: '2026-09-24T23:20:10.000Z',
    updatedAt: '2026-09-24T23:21:00.000Z',
    processedEventIds: ['event-1', 'event-2', 'event-3', 'event-4'],
  };

  await assert.rejects(
    () => projectCrossAppTransactionV1(
      transaction(),
      resolverForEntries([[INV_RELEASE.invocationId, forged]]),
    ),
    /lacks reducer-reachable commit evidence/,
  );
});

test('COMMITTED state requires exact verification provenance and causal chronology', async () => {
  const valid = exactEffectState(INV_RELEASE, 'COMMITTED', {
    createdAt: '2026-09-24T23:20:10.000Z',
    updatedAt: '2026-09-24T23:21:00.000Z',
  });

  for (const [label, mutate, expected] of [
    ['missing verifier', state => { state.verification.verifierId = null; }, /exact verification provenance/],
    ['wrong authority', state => { state.verification.verificationAuthorityId = 'policy-other'; }, /exact verification provenance/],
    ['wrong execution', state => { state.verification.executionId = 'invoke-release:attempt:2'; }, /executionId does not match|exact verification provenance/],
    ['short event history', state => { state.processedEventIds = ['only-one']; }, /reducer-reachable commit evidence/],
    ['observation before state', state => { state.observation.observedAt = '2026-09-24T23:20:09.999Z'; }, /invalid commit chronology/],
    ['verification before observation', state => { state.verification.verifiedAt = '2026-09-24T23:20:59.999Z'; state.observation.observedAt = '2026-09-24T23:21:00.000Z'; }, /invalid commit chronology/],
  ]) {
    const state = structuredClone(valid);
    mutate(state);
    await assert.rejects(
      () => projectCrossAppTransactionV1(
        transaction(),
        resolverForEntries([[INV_RELEASE.invocationId, state]]),
      ),
      expected,
      label,
    );
  }
});

test('resolved exact-effect identity, provider, invocation digest and transaction chronology are exact', async () => {
  const unknown = exactEffectState(invocation('invoke-other', 'github'), 'PREPARED');
  await assert.rejects(
    () => projectCrossAppTransactionV1(
      transaction(),
      resolverForEntries([[INV_RELEASE.invocationId, unknown]]),
    ),
    /identity does not match step/,
  );

  const wrongProvider = exactEffectState({ ...INV_RELEASE, providerId: 'drive' }, 'PREPARED');
  await assert.rejects(
    () => projectCrossAppTransactionV1(
      transaction(),
      resolverForEntries([[INV_RELEASE.invocationId, wrongProvider]]),
    ),
    /provider binding/,
  );

  const substituted = exactEffectState({
    ...INV_RELEASE,
    arguments: { target: 'changed', options: { mode: 'verified' } },
  }, 'PREPARED');
  await assert.rejects(
    () => projectCrossAppTransactionV1(
      transaction(),
      resolverForEntries([[INV_RELEASE.invocationId, substituted]]),
    ),
    /invocation binding/,
  );

  const stale = exactEffectState(INV_RELEASE, 'PREPARED', {
    createdAt: '2026-09-24T23:19:59.000Z',
    updatedAt: '2026-09-24T23:19:59.000Z',
  });
  await assert.rejects(
    () => projectCrossAppTransactionV1(
      transaction(),
      resolverForEntries([[INV_RELEASE.invocationId, stale]]),
    ),
    /predates transaction/,
  );
});

test('dependent effect cannot advance before its dependency is durably COMMITTED', async () => {
  const release = exactEffectState(INV_RELEASE, 'PREPARED');
  const drive = exactEffectState(INV_DRIVE, 'EXECUTING', {
    createdAt: '2026-09-24T23:20:20.000Z',
    updatedAt: '2026-09-24T23:20:30.000Z',
  });
  await assert.rejects(
    () => project([release, drive]),
    /lacks committed dependency/,
  );
});

test('active and reconciliation phases project truthfully without granting retry authority', async () => {
  const release = exactEffectState(INV_RELEASE, 'COMMITTED', {
    updatedAt: '2026-09-24T23:21:00.000Z',
  });
  const driveExecuting = exactEffectState(INV_DRIVE, 'EXECUTING', {
    createdAt: '2026-09-24T23:21:00.000Z',
    updatedAt: '2026-09-24T23:21:10.000Z',
  });
  const active = await project([release, driveExecuting]);
  assert.equal(active.status, CrossAppTransactionProjectionStatus.ACTIVE);
  assert.deepEqual(active.activeStepIds, ['update-drive']);

  const driveReconcile = exactEffectState(INV_DRIVE, 'RECONCILE', {
    createdAt: '2026-09-24T23:21:00.000Z',
    updatedAt: '2026-09-24T23:21:10.000Z',
  });
  const attention = await project([release, driveReconcile]);
  assert.equal(attention.status, CrossAppTransactionProjectionStatus.ATTENTION);
  assert.deepEqual(attention.attentionStepIds, ['update-drive']);
  assert.equal('safeRetry' in attention, false);
});

test('duplicate durable commit identity across separate steps is rejected', async () => {
  const release = exactEffectState(INV_RELEASE, 'COMMITTED', {
    updatedAt: '2026-09-24T23:21:00.000Z',
  });
  const drive = structuredClone(exactEffectState(INV_DRIVE, 'COMMITTED', {
    createdAt: '2026-09-24T23:21:00.000Z',
    updatedAt: '2026-09-24T23:22:00.000Z',
  }));
  drive.commitId = release.commitId;

  await assert.rejects(
    () => project([release, drive]),
    /duplicate commitId/,
  );
});

test('complete reducer-derived effect chain projects COMPLETE while compensation remains inert', async () => {
  const states = [
    exactEffectState(INV_RELEASE, 'COMMITTED', {
      createdAt: '2026-09-24T23:20:10.000Z',
      updatedAt: '2026-09-24T23:21:00.000Z',
    }),
    exactEffectState(INV_DRIVE, 'COMMITTED', {
      createdAt: '2026-09-24T23:21:00.000Z',
      updatedAt: '2026-09-24T23:22:00.000Z',
    }),
    exactEffectState(INV_MAIL, 'COMMITTED', {
      createdAt: '2026-09-24T23:22:00.000Z',
      updatedAt: '2026-09-24T23:23:00.000Z',
    }),
  ];
  const projected = await project(states);
  assert.equal(projected.status, CrossAppTransactionProjectionStatus.COMPLETE);
  assert.deepEqual(projected.committedStepIds, ['create-release', 'send-mail', 'update-drive']);
  assert.deepEqual(projected.readyStepIds, []);
  assert.deepEqual(projected.activeStepIds, []);
  assert.deepEqual(projected.attentionStepIds, []);
  assert.deepEqual(projected.blockedStepIds, []);
  assert.equal(projected.advisoryOnly, true);
});

test('canonical processed-event capacity is preserved and over-capacity input fails closed', async () => {
  const within = structuredClone(exactEffectState(INV_RELEASE, 'PREPARED'));
  within.processedEventIds = Array.from(
    { length: 129 },
    (_, index) => `event-${String(index).padStart(3, '0')}`,
  );
  const projected = await projectCrossAppTransactionV1(
    transaction(),
    resolverForEntries([[INV_RELEASE.invocationId, within]]),
  );
  assert.deepEqual(projected.readyStepIds, ['create-release']);

  const above = structuredClone(within);
  above.processedEventIds = Array.from(
    { length: 1025 },
    (_, index) => `event-${String(index).padStart(4, '0')}`,
  );
  await assert.rejects(
    () => projectCrossAppTransactionV1(
      transaction(),
      resolverForEntries([[INV_RELEASE.invocationId, above]]),
    ),
    /bounded plain array/,
  );
});

test('exact-effect state timestamps preserve causal order before projection', async () => {
  const regressed = structuredClone(exactEffectState(INV_RELEASE, 'PREPARED', {
    createdAt: '2026-09-24T23:20:10.000Z',
  }));
  regressed.updatedAt = '2026-09-24T23:20:09.999Z';

  await assert.rejects(
    () => projectCrossAppTransactionV1(
      transaction(),
      resolverForEntries([[INV_RELEASE.invocationId, regressed]]),
    ),
    /updatedAt cannot predate createdAt/,
  );
});


test('rejects negative-zero aliases in transaction invocation fingerprints and exact-effect attempts', async () => {
  const positiveZero = invocation('invoke-positive-zero', 'github', 'github.mutate', {
    arguments: { amount: 0, nested: [0] },
  });
  await assert.doesNotReject(
    () => createCrossAppInvocationFingerprintV1(positiveZero),
  );

  const negativeZero = invocation('invoke-negative-zero', 'github', 'github.mutate', {
    arguments: { amount: 0, nested: [-0] },
  });
  await assert.rejects(
    () => createCrossAppInvocationFingerprintV1(negativeZero),
    /negative zero/u,
  );

  const negativeAttemptState = {
    ...exactEffectState(INV_RELEASE, 'PREPARED'),
    attempt: -0,
  };
  const resolver = {
    async loadExactEffectState(invocationId) {
      return invocationId === INV_RELEASE.invocationId ? negativeAttemptState : null;
    },
  };

  await assert.rejects(
    () => projectCrossAppTransactionV1(transaction(), resolver),
    /attempt is invalid/u,
  );
});
