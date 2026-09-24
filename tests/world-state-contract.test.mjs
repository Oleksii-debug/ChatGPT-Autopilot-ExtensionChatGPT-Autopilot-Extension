import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WorldStateDriftReason,
  WorldStateFreshnessStatus,
  assertWorldStatePreconditionFreshV1,
  assertWorldStateSnapshotFreshV1,
  assessWorldStateSnapshotFreshnessV1,
  normalizeWorldStateObservationV1,
  normalizeWorldStatePreconditionV1,
  normalizeWorldStateSnapshotV1,
} from '../src/core/world-state-contract.js';

const OBSERVED = '2026-09-24T22:40:00.000Z';
const CAPTURED = '2026-09-24T22:40:10.000Z';
const CREATED = '2026-09-24T22:40:20.000Z';
const ASSESSED = '2026-09-24T22:40:30.000Z';
const VALID = '2026-09-24T22:50:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function observation(overrides = {}) {
  return {
    schemaVersion: 1,
    observationId: 'obs-repo-main',
    scopeId: 'project-autopilot',
    providerId: 'github',
    resourceId: 'repo-main',
    revisionId: 'commit-5d213cd',
    contentSha256: HASH_A,
    observedAt: OBSERVED,
    validUntil: VALID,
    evidenceArtifactIds: ['artifact-github-response'],
    ...overrides,
  };
}

function secondObservation(overrides = {}) {
  return observation({
    observationId: 'obs-settings',
    providerId: 'local-settings',
    resourceId: 'settings-router',
    revisionId: 'settings-r7',
    contentSha256: HASH_B,
    evidenceArtifactIds: ['artifact-settings-snapshot'],
    ...overrides,
  });
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    snapshotId: 'world-snapshot-1',
    scopeId: 'project-autopilot',
    revision: 7,
    observations: [secondObservation(), observation()],
    capturedAt: CAPTURED,
    ...overrides,
  };
}

function precondition(overrides = {}) {
  return {
    schemaVersion: 1,
    guardId: 'guard-1',
    invocationId: 'invoke-1',
    snapshotId: 'world-snapshot-1',
    scopeId: 'project-autopilot',
    snapshotRevision: 7,
    requiredBindings: [{
      providerId: 'github',
      resourceId: 'repo-main',
      revisionId: 'commit-5d213cd',
      contentSha256: HASH_A,
      observedAt: OBSERVED,
      validUntil: VALID,
    }],
    createdAt: CREATED,
    expiresAt: '2026-09-24T22:45:00.000Z',
    ...overrides,
  };
}

function current(overrides = {}) {
  return observation({
    observationId: 'obs-repo-main-current',
    observedAt: '2026-09-24T22:40:25.000Z',
    ...overrides,
  });
}

test('WorldStateObservationV1 binds exact resource revision, bytes, time and evidence', () => {
  const value = normalizeWorldStateObservationV1(observation());
  assert.equal(value.providerId, 'github');
  assert.equal(value.revisionId, 'commit-5d213cd');
  assert.equal(value.contentSha256, HASH_A);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.evidenceArtifactIds), true);

  assert.throws(() => normalizeWorldStateObservationV1(observation({ schemaVersion: '1' })), /schemaVersion/);
  assert.throws(() => normalizeWorldStateObservationV1(observation({ resourceId: 7 })), /resourceId/);
  assert.throws(() => normalizeWorldStateObservationV1(observation({ contentSha256: 'bad' })), /contentSha256/);
  assert.throws(() => normalizeWorldStateObservationV1(observation({ evidenceArtifactIds: [] })), /1-128 items/);
});

test('observation TTL is causal and snapshot capture cannot predate or contain expired evidence', () => {
  assert.throws(() => normalizeWorldStateObservationV1(observation({ validUntil: OBSERVED })), /later than observedAt/);
  assert.throws(() => normalizeWorldStateSnapshotV1(snapshot({ capturedAt: '2026-09-24T22:39:59.000Z' })), /predates observation/);
  assert.throws(() => normalizeWorldStateSnapshotV1(snapshot({
    observations: [observation({ validUntil: '2026-09-24T22:40:05.000Z' })],
  })), /expired observation/);
});

test('strict boundary rejects accessors, symbols, hidden fields, exotic prototypes, sparse arrays and coercion aliases', () => {
  const getter = observation();
  Object.defineProperty(getter, 'resourceId', {
    enumerable: true,
    get() { throw new Error('getter must not execute'); },
  });
  assert.throws(() => normalizeWorldStateObservationV1(getter), /data property/);

  const symbolic = observation();
  symbolic[Symbol('authority')] = 'ALLOW';
  assert.throws(() => normalizeWorldStateObservationV1(symbolic), /symbol field/);

  const hidden = observation();
  Object.defineProperty(hidden, 'authority', { value: 'ALLOW', enumerable: false });
  assert.throws(() => normalizeWorldStateObservationV1(hidden), /non-enumerable field/);

  const exotic = Object.create({ authority: 'ALLOW' });
  Object.assign(exotic, observation());
  assert.throws(() => normalizeWorldStateObservationV1(exotic), /plain data object/);

  const sparse = new Array(1);
  assert.throws(() => normalizeWorldStateSnapshotV1(snapshot({ observations: sparse })), /must not be sparse/);
});

test('snapshot enforces one exact resource identity per scope and deterministic ordering', () => {
  const value = normalizeWorldStateSnapshotV1(snapshot());
  assert.deepEqual(value.observations.map(item => item.resourceId), ['repo-main', 'settings-router']);
  assert.equal(Object.isFrozen(value), true);

  assert.throws(() => normalizeWorldStateSnapshotV1(snapshot({
    observations: [observation(), observation({ observationId: 'other-observation' })],
  })), /duplicate resourceId/);

  assert.throws(() => normalizeWorldStateSnapshotV1(snapshot({
    observations: [observation({ scopeId: 'other-scope' })],
  })), /scopeId mismatch/);
});

test('same resource revision and bytes may be freshly re-observed without invalidating snapshot', () => {
  const report = assessWorldStateSnapshotFreshnessV1(snapshot(), [
    current(),
    secondObservation({ observationId: 'settings-current', observedAt: '2026-09-24T22:40:26.000Z' }),
  ], { at: ASSESSED });
  assert.equal(report.status, WorldStateFreshnessStatus.FRESH);
  assert.deepEqual(report.drift, []);
  assert.deepEqual(report.checkedResourceIds, ['repo-main', 'settings-router']);
});

test('freshness reports deterministic missing/provider/revision/content drift reasons', () => {
  let report = assessWorldStateSnapshotFreshnessV1(snapshot(), [], {
    at: ASSESSED,
    requiredResourceIds: ['repo-main'],
  });
  assert.deepEqual(report.drift, [{ resourceId: 'repo-main', reason: WorldStateDriftReason.MISSING_RESOURCE }]);

  report = assessWorldStateSnapshotFreshnessV1(snapshot(), [current({ providerId: 'mirror' })], {
    at: ASSESSED,
    requiredResourceIds: ['repo-main'],
  });
  assert.deepEqual(report.drift, [{ resourceId: 'repo-main', reason: WorldStateDriftReason.PROVIDER_CHANGED }]);

  report = assessWorldStateSnapshotFreshnessV1(snapshot(), [current({ revisionId: 'commit-new' })], {
    at: ASSESSED,
    requiredResourceIds: ['repo-main'],
  });
  assert.deepEqual(report.drift, [{ resourceId: 'repo-main', reason: WorldStateDriftReason.REVISION_CHANGED }]);

  report = assessWorldStateSnapshotFreshnessV1(snapshot(), [current({ contentSha256: HASH_B })], {
    at: ASSESSED,
    requiredResourceIds: ['repo-main'],
  });
  assert.deepEqual(report.drift, [{ resourceId: 'repo-main', reason: WorldStateDriftReason.CONTENT_CHANGED }]);
});

test('freshness fails closed on observation time regression, future evidence and TTL expiry', () => {
  let report = assessWorldStateSnapshotFreshnessV1(snapshot(), [current({ observedAt: '2026-09-24T22:39:00.000Z' })], {
    at: ASSESSED,
    requiredResourceIds: ['repo-main'],
  });
  assert.deepEqual(report.drift, [{ resourceId: 'repo-main', reason: WorldStateDriftReason.OBSERVATION_REGRESSED }]);

  report = assessWorldStateSnapshotFreshnessV1(snapshot(), [current({ observedAt: '2026-09-24T22:41:00.000Z' })], {
    at: ASSESSED,
    requiredResourceIds: ['repo-main'],
  });
  assert.deepEqual(report.drift, [{ resourceId: 'repo-main', reason: WorldStateDriftReason.FUTURE_OBSERVATION }]);

  report = assessWorldStateSnapshotFreshnessV1(snapshot(), [current({ validUntil: '2026-09-24T22:40:29.000Z' })], {
    at: ASSESSED,
    requiredResourceIds: ['repo-main'],
  });
  assert.deepEqual(report.drift, [{ resourceId: 'repo-main', reason: WorldStateDriftReason.EXPIRED }]);
});

test('requiredResourceIds are bounded to snapshot and unrelated current resources cannot grant freshness', () => {
  assert.throws(() => assessWorldStateSnapshotFreshnessV1(snapshot(), [current()], {
    at: ASSESSED,
    requiredResourceIds: ['not-in-snapshot'],
  }), /outside snapshot/);

  const report = assessWorldStateSnapshotFreshnessV1(snapshot(), [
    current(),
    observation({
      observationId: 'extra-current',
      resourceId: 'extra-resource',
      revisionId: 'extra-r1',
      contentSha256: HASH_B,
      observedAt: '2026-09-24T22:40:25.000Z',
    }),
  ], {
    at: ASSESSED,
    requiredResourceIds: ['repo-main'],
  });
  assert.equal(report.status, 'FRESH');
  assert.deepEqual(report.checkedResourceIds, ['repo-main']);
});

test('current observation scope mismatch is rejected instead of silently ignored', () => {
  assert.throws(() => assessWorldStateSnapshotFreshnessV1(snapshot(), [
    current({ scopeId: 'other-project' }),
  ], {
    at: ASSESSED,
    requiredResourceIds: ['repo-main'],
  }), /scopeId mismatch/);
});

test('precondition is bound to exact snapshot identity/revision/scope and only resumes on fresh evidence', () => {
  const result = assertWorldStatePreconditionFreshV1({
    precondition: precondition(),
    snapshot: snapshot(),
    currentObservations: [current()],
    invocationId: 'invoke-1',
    at: ASSESSED,
  });
  assert.equal(result.freshness.status, 'FRESH');
  assert.deepEqual(result.freshness.checkedResourceIds, ['repo-main']);
  assert.equal(Object.isFrozen(result), true);

  assert.throws(() => assertWorldStatePreconditionFreshV1({
    precondition: precondition({ snapshotId: 'other-snapshot' }),
    snapshot: snapshot(),
    currentObservations: [current()],
    invocationId: 'invoke-1',
    at: ASSESSED,
  }), /snapshotId mismatch/);

  assert.throws(() => assertWorldStatePreconditionFreshV1({
    precondition: precondition({ snapshotRevision: 6 }),
    snapshot: snapshot(),
    currentObservations: [current()],
    invocationId: 'invoke-1',
    at: ASSESSED,
  }), /snapshotRevision mismatch/);

  assert.throws(() => assertWorldStatePreconditionFreshV1({
    precondition: precondition(),
    snapshot: snapshot(),
    currentObservations: [current()],
    invocationId: 'invoke-other',
    at: ASSESSED,
  }), /invocationId mismatch/);

  const forgedSnapshot = snapshot({
    observations: [
      observation({ revisionId: 'commit-forged', contentSha256: HASH_B }),
      secondObservation(),
    ],
  });
  assert.throws(() => assertWorldStatePreconditionFreshV1({
    precondition: precondition(),
    snapshot: forgedSnapshot,
    currentObservations: [current({ revisionId: 'commit-forged', contentSha256: HASH_B })],
    invocationId: 'invoke-1',
    at: ASSESSED,
  }), /resource binding mismatch/);

  assert.throws(() => assertWorldStatePreconditionFreshV1({
    precondition: precondition(),
    snapshot: snapshot(),
    currentObservations: [current({ revisionId: 'commit-new' })],
    invocationId: 'invoke-1',
    at: ASSESSED,
  }), /REVISION_CHANGED/);
});

test('precondition and freshness clocks cannot be backdated or reused after expiry', () => {
  assert.throws(() => normalizeWorldStatePreconditionV1(precondition({
    expiresAt: CREATED,
  })), /later than createdAt/);

  assert.throws(() => assertWorldStatePreconditionFreshV1({
    precondition: precondition({ createdAt: '2026-09-24T22:40:05.000Z' }),
    snapshot: snapshot(),
    currentObservations: [current()],
    invocationId: 'invoke-1',
    at: ASSESSED,
  }), /createdAt cannot predate snapshot/);

  assert.throws(() => assertWorldStatePreconditionFreshV1({
    precondition: precondition(),
    snapshot: snapshot(),
    currentObservations: [current()],
    invocationId: 'invoke-1',
    at: '2026-09-24T22:46:00.000Z',
  }), /precondition is expired/);

  assert.throws(() => assertWorldStateSnapshotFreshV1(snapshot(), [current()], {
    at: '2026-09-24T22:39:00.000Z',
    requiredResourceIds: ['repo-main'],
  }), /cannot predate snapshot/);
});
