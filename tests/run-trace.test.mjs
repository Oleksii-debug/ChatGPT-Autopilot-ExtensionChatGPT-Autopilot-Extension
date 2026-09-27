import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_TRACE_SCHEMA_VERSION,
  RunTraceEventKind,
  buildRunTraceProjectionV1,
  normalizeRunTraceEventV1,
} from '../src/core/run-trace.js';

const t0 = '2026-09-25T10:00:00.000Z';
const t1 = '2026-09-25T10:00:01.000Z';
const t2 = '2026-09-25T10:00:02.000Z';
const t3 = '2026-09-25T10:00:03.000Z';

function event(overrides = {}) {
  return {
    schemaVersion: RUN_TRACE_SCHEMA_VERSION,
    eventId: 'event-1',
    runId: 'run-1',
    projectId: 'project-1',
    jobId: 'job-1',
    runRevisionId: 'revision-1',
    kind: RunTraceEventKind.STATUS,
    actorId: 'actor-1',
    parentEventId: '',
    sourceRevisionId: 'source-revision-1',
    artifactRefs: [],
    effectId: '',
    verificationId: '',
    checkpointId: '',
    status: 'STARTED',
    reasonCode: '',
    budgetCostUsdMicros: 0,
    occurredAt: t0,
    ...overrides,
  };
}

function request(events, overrides = {}) {
  return {
    schemaVersion: RUN_TRACE_SCHEMA_VERSION,
    traceId: 'trace-1',
    runId: 'run-1',
    projectId: 'project-1',
    jobId: 'job-1',
    runRevisionId: 'revision-1',
    observedThrough: t3,
    events,
    filterKinds: [],
    afterEventId: '',
    ...overrides,
  };
}

test('normalizes a bounded event without granting any authority', () => {
  const normalized = normalizeRunTraceEventV1(event());
  assert.equal(normalized.eventId, 'event-1');
  assert.equal(normalized.kind, RunTraceEventKind.STATUS);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.artifactRefs));
});

test('projection is deterministic and emits parents before children even from reversed input', () => {
  const parent = event({
    eventId: 'event-parent',
    kind: RunTraceEventKind.PLAN,
    status: 'READY',
    occurredAt: t1,
  });
  const child = event({
    eventId: 'event-child',
    parentEventId: 'event-parent',
    kind: RunTraceEventKind.TASK,
    status: 'RUNNING',
    occurredAt: t1,
  });
  const later = event({
    eventId: 'event-later',
    parentEventId: 'event-child',
    kind: RunTraceEventKind.ARTIFACT,
    artifactRefs: [{ artifactId:'artifact-1', versionId:'version-1', sha256:'a'.repeat(64) }],
    status: 'MATERIALIZED',
    occurredAt: t2,
  });

  const first = buildRunTraceProjectionV1(request([later, child, parent]));
  const second = buildRunTraceProjectionV1(request([parent, later, child]));

  assert.deepEqual(first.events.map(item => item.eventId), [
    'event-parent',
    'event-child',
    'event-later',
  ]);
  assert.deepEqual(second.events, first.events);
  assert.deepEqual(first.summary, second.summary);
  assert.equal(first.cursor.nextAfterEventId, 'event-later');
});

test('projection orders canonical extended-year events by epoch, then eventId', () => {
  const earlier = '9999-12-31T23:59:59.999Z';
  const later = '+010000-01-01T00:00:00.000Z';
  const same = '+010000-01-01T00:00:00.001Z';

  const projection = buildRunTraceProjectionV1(request([
    event({ eventId: 'later-a', occurredAt: later }),
    event({ eventId: 'same-z', occurredAt: same }),
    event({ eventId: 'earlier-z', occurredAt: earlier }),
    event({ eventId: 'same-a', occurredAt: same }),
  ], {
    observedThrough: same,
  }));

  assert.deepEqual(
    projection.events.map(item => item.eventId),
    ['earlier-z', 'later-a', 'same-a', 'same-z'],
  );
  assert.equal(projection.cursor.nextAfterEventId, 'same-z');
});

test('projection rejects run/project/job/revision identity substitution', () => {
  for (const [field, value] of [
    ['runId', 'run-2'],
    ['projectId', 'project-2'],
    ['jobId', 'job-2'],
    ['runRevisionId', 'revision-2'],
  ]) {
    assert.throws(
      () => buildRunTraceProjectionV1(request([event({ [field]: value })])),
      /identity does not match requested run identity/u,
    );
  }
});

test('projection rejects duplicate event identity and unknown parents', () => {
  assert.throws(
    () => buildRunTraceProjectionV1(request([
      event(),
      event({ actorId: 'actor-2', occurredAt: t1 }),
    ])),
    /duplicate eventId/u,
  );

  assert.throws(
    () => buildRunTraceProjectionV1(request([
      event({ eventId: 'event-child', parentEventId: 'missing-event' }),
    ])),
    /unknown parentEventId/u,
  );
});

test('projection rejects future parents, events after observation time, and parent cycles', () => {
  assert.throws(
    () => buildRunTraceProjectionV1(request([
      event({ eventId: 'parent', occurredAt: t2 }),
      event({ eventId: 'child', parentEventId: 'parent', occurredAt: t1 }),
    ])),
    /parent occurs after child/u,
  );

  assert.throws(
    () => buildRunTraceProjectionV1(request([
      event({ occurredAt: '2026-09-25T10:00:04.000Z' }),
    ])),
    /after observedThrough/u,
  );

  assert.throws(
    () => buildRunTraceProjectionV1(request([
      event({ eventId: 'a', parentEventId: 'b', occurredAt: t1 }),
      event({ eventId: 'b', parentEventId: 'a', occurredAt: t1 }),
    ])),
    /cycle/u,
  );
});

test('kind-specific evidence identities fail closed', () => {
  assert.throws(
    () => normalizeRunTraceEventV1(event({ kind: RunTraceEventKind.EFFECT, effectId: '' })),
    /requires effectId/u,
  );
  assert.doesNotThrow(() => normalizeRunTraceEventV1(event({
    kind: RunTraceEventKind.EFFECT,
    effectId: 'effect-1',
  })));

  assert.throws(
    () => normalizeRunTraceEventV1(event({ kind: RunTraceEventKind.VERIFICATION, verificationId: '' })),
    /requires verificationId/u,
  );
  assert.doesNotThrow(() => normalizeRunTraceEventV1(event({
    kind: RunTraceEventKind.VERIFICATION,
    effectId: 'effect-1',
    verificationId: 'verification-1',
  })));

  assert.throws(
    () => normalizeRunTraceEventV1(event({ kind: RunTraceEventKind.ARTIFACT, artifactRefs: [] })),
    /requires at least one artifactId/u,
  );

  assert.throws(
    () => normalizeRunTraceEventV1(event({ kind: RunTraceEventKind.CHECKPOINT, checkpointId: '' })),
    /requires checkpointId/u,
  );

  assert.throws(
    () => normalizeRunTraceEventV1(event({ kind: RunTraceEventKind.STATUS, checkpointId: 'checkpoint-1' })),
    /checkpointId is valid only/u,
  );

  assert.throws(
    () => normalizeRunTraceEventV1(event({ kind: RunTraceEventKind.STATUS, verificationId: 'verification-1' })),
    /verificationId is valid only/u,
  );

  assert.throws(
    () => normalizeRunTraceEventV1(event({ kind: RunTraceEventKind.STATUS, effectId: 'effect-1' })),
    /effectId is valid only/u,
  );

  assert.throws(
    () => normalizeRunTraceEventV1(event({ kind: RunTraceEventKind.STATUS, budgetCostUsdMicros: 1 })),
    /budgetCostUsdMicros is valid only/u,
  );

  assert.doesNotThrow(() => normalizeRunTraceEventV1(event({
    kind: RunTraceEventKind.BUDGET,
    budgetCostUsdMicros: 12345,
    status: 'OBSERVED',
  })));
});

test('unknown transcript and hidden-reasoning fields are rejected without accessor execution', () => {
  for (const forbidden of ['hiddenReasoning', 'chainOfThought', 'transcriptBody', 'rawPrompt']) {
    const input = event();
    input[forbidden] = 'must-not-enter-trace';
    assert.throws(
      () => normalizeRunTraceEventV1(input),
      /unknown field/u,
    );
  }

  let getterCalls = 0;
  const hostile = event();
  Object.defineProperty(hostile, 'hiddenReasoning', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'secret';
    },
  });
  assert.throws(
    () => normalizeRunTraceEventV1(hostile),
    /enumerable own data properties/u,
  );
  assert.equal(getterCalls, 0);
});

test('artifact references require immutable artifact/version/SHA binding', () => {
  const exact = normalizeRunTraceEventV1(event({
    kind: RunTraceEventKind.ARTIFACT,
    artifactRefs: [{
      artifactId:'artifact-1',
      versionId:'version-1',
      sha256:'a'.repeat(64),
    }],
  }));
  assert.deepEqual(exact.artifactRefs, [{
    artifactId:'artifact-1',
    versionId:'version-1',
    sha256:'a'.repeat(64),
  }]);

  assert.throws(
    () => normalizeRunTraceEventV1(event({
      kind: RunTraceEventKind.ARTIFACT,
      artifactRefs: [{ artifactId:'artifact-1' }],
    })),
    /versionId/u,
  );
  assert.throws(
    () => normalizeRunTraceEventV1(event({
      kind: RunTraceEventKind.ARTIFACT,
      artifactRefs: [{
        artifactId:'artifact-1',
        versionId:'version-1',
        sha256:'A'.repeat(64),
      }],
    })),
    /lowercase SHA-256/u,
  );
  assert.throws(
    () => normalizeRunTraceEventV1(event({
      kind: RunTraceEventKind.ARTIFACT,
      artifactRefs: [
        { artifactId:'artifact-1', versionId:'version-1', sha256:'a'.repeat(64) },
        { artifactId:'artifact-2', versionId:'version-1', sha256:'b'.repeat(64) },
      ],
    })),
    /duplicate versionId/u,
  );
});

test('descriptor and dense-array boundaries reject accessors, symbols and sparse aliases', () => {
  let getterCalls = 0;
  const hostile = event();
  Object.defineProperty(hostile, 'status', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'STARTED';
    },
  });
  assert.throws(
    () => normalizeRunTraceEventV1(hostile),
    /enumerable own data properties/u,
  );
  assert.equal(getterCalls, 0);

  const symbolInput = event();
  symbolInput[Symbol('authority')] = 'grant';
  assert.throws(() => normalizeRunTraceEventV1(symbolInput), /symbol fields/u);

  const sparse = [];
  sparse.length = 1;
  assert.throws(
    () => buildRunTraceProjectionV1(request(sparse)),
    /enumerable own data property/u,
  );

  const artifacts = [{ artifactId:'artifact-1', versionId:'version-1', sha256:'a'.repeat(64) }];
  Object.defineProperty(artifacts, '0', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { artifactId:'artifact-1', versionId:'version-1', sha256:'a'.repeat(64) };
    },
  });
  assert.throws(
    () => normalizeRunTraceEventV1(event({
      kind: RunTraceEventKind.ARTIFACT,
      artifactRefs: artifacts,
    })),
    /enumerable own data property/u,
  );
  assert.equal(getterCalls, 0);
});

test('filterKinds and afterEventId create a deterministic read-only replay projection', () => {
  const events = [
    event({ eventId: 'e1', kind: RunTraceEventKind.PLAN, status: 'READY', occurredAt: t0 }),
    event({ eventId: 'e2', kind: RunTraceEventKind.TASK, parentEventId: 'e1', status: 'RUNNING', occurredAt: t1 }),
    event({
      eventId: 'e3',
      kind: RunTraceEventKind.EFFECT,
      effectId: 'effect-1',
      parentEventId: 'e2',
      status: 'OBSERVED',
      occurredAt: t2,
    }),
    event({
      eventId: 'e4',
      kind: RunTraceEventKind.VERIFICATION,
      effectId: 'effect-1',
      verificationId: 'verification-1',
      parentEventId: 'e3',
      status: 'VERIFIED',
      occurredAt: t3,
    }),
  ];

  const projection = buildRunTraceProjectionV1(request(events, {
    observedThrough: t3,
    afterEventId: 'e1',
    filterKinds: [RunTraceEventKind.VERIFICATION, RunTraceEventKind.EFFECT],
  }));

  assert.deepEqual(projection.events.map(item => item.eventId), ['e3', 'e4']);
  assert.equal(projection.summary.totalEventCount, 4);
  assert.equal(projection.summary.replayWindowCount, 3);
  assert.equal(projection.summary.projectedEventCount, 2);
  assert.equal(projection.summary.projectedCountsByKind.EFFECT, 1);
  assert.equal(projection.summary.projectedCountsByKind.VERIFICATION, 1);
  assert.equal(projection.summary.projectedCountsByKind.TASK, 0);
  assert.equal(projection.cursor.afterEventId, 'e1');
  assert.equal(projection.cursor.nextAfterEventId, 'e4');
});

test('replay cursor rejects identities outside this exact trace', () => {
  assert.throws(
    () => buildRunTraceProjectionV1(request([event()], { afterEventId: 'other-event' })),
    /afterEventId is not present/u,
  );
});

test('projection cannot be used as replay, execution, or evidence authority', () => {
  const projection = buildRunTraceProjectionV1(request([event()]));
  assert.equal(projection.readOnly, true);
  assert.equal(projection.advisoryOnly, true);
  assert.equal(projection.sourceTrust, 'UNVERIFIED_INPUT');
  assert.equal(projection.hiddenReasoningIncluded, false);
  assert.equal(projection.rawTranscriptIncluded, false);
  assert.equal(projection.replayAuthorized, false);
  assert.equal(projection.executionAuthorized, false);
  assert.equal(projection.evidenceAuthorityMinted, false);
  assert.equal(projection.requiresCanonicalSourceResolution, true);
  assert.ok(Object.isFrozen(projection));
  assert.ok(Object.isFrozen(projection.events));
  assert.ok(Object.isFrozen(projection.summary));
});

test('budget trace rejects negative-zero money aliases', () => {
  assert.throws(
    () => normalizeRunTraceEventV1(event({
      kind: RunTraceEventKind.BUDGET,
      budgetCostUsdMicros: -0,
      status: 'OBSERVED',
    })),
    /canonical integer/u,
  );
});

test('projection request itself rejects authority and transcript smuggling fields', () => {
  for (const [field, value] of [
    ['replayAuthorized', true],
    ['executionAuthorized', true],
    ['hiddenReasoning', 'secret'],
    ['transcript', 'full transcript'],
  ]) {
    assert.throws(
      () => buildRunTraceProjectionV1({ ...request([event()]), [field]: value }),
      /unknown field/u,
    );
  }
});
