import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveJobArtifactProvenanceV1 } from '../src/core/job-artifact-provenance.js';
import {
  addProjectSnapshot,
  createProjectWorkspace,
  putProjectArtifactProvenance,
  replaceProjectSnapshot,
} from '../src/core/project-workspace.js';
import {
  ExactEffectEventType,
  createExactEffectStateV1,
  reduceExactEffectV1,
} from '../src/core/universal-agent-exact-effect.js';

const hash = char => char.repeat(64);
const INVOCATION_AT = '2026-09-25T03:00:00.000Z';
const ARTIFACT_AT = '2026-09-25T03:00:02.000Z';
const OBSERVED_AT = '2026-09-25T03:00:03.000Z';
const PROVENANCE_AT = '2026-09-25T03:00:04.000Z';

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'artifact-out',
    kind: 'JSON',
    uri: 'workspace://artifact-out.json',
    mediaType: 'application/json',
    sha256: hash('b'),
    sizeBytes: 42,
    createdAt: ARTIFACT_AT,
    producerInvocationId: 'invoke-1',
    sensitive: false,
    ...overrides,
  };
}

function source(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceId: 'source-main',
    projectId: 'project-a',
    kind: 'GITHUB',
    uri: 'https://github.com/acme/repo',
    revisionId: 'rev-1',
    contentSha256: hash('a'),
    observedAt: '2026-09-25T02:59:59.000Z',
    authority: 'CANONICAL',
    metadata: {},
    ...overrides,
  };
}

function snapshot(artifactRef = artifact()) {
  return {
    schemaVersion: 1,
    projectId: 'project-a',
    revisionId: 'project-r1',
    title: 'Project A',
    sourceRefs: [source()],
    artifactRefs: [artifactRef],
    createdAt: PROVENANCE_AT,
  };
}

function provenance(artifactRef = artifact(), overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: 'project-a',
    artifactRef,
    sourceBindings: [{
      sourceId: 'source-main',
      revisionId: 'rev-1',
      contentSha256: hash('a'),
    }],
    inputArtifactIds: [],
    createdAt: PROVENANCE_AT,
    ...overrides,
  };
}

function invocation(overrides = {}) {
  return {
    schemaVersion: 1,
    invocationId: 'invoke-1',
    toolId: 'filesystem.write',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.write'],
    policyDecisionId: 'decision-1',
    arguments: { output: 'artifact-out' },
    createdAt: INVOCATION_AT,
    ...overrides,
  };
}

function observation(artifactRefs = [artifact()], overrides = {}) {
  return {
    schemaVersion: 1,
    observationId: 'obs-1',
    invocationId: 'invoke-1',
    status: 'OK',
    summary: 'Produced artifact observed.',
    data: {},
    artifactRefs,
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function effectWithObservation(observationValue = observation(), invocationValue = invocation()) {
  let state = createExactEffectStateV1(invocationValue, { createdAt: INVOCATION_AT });
  state = reduceExactEffectV1(state, {
    schemaVersion: 1,
    eventId: 'event-start',
    type: ExactEffectEventType.BEGIN_EXECUTION,
    effectId: invocationValue.invocationId,
    executionId: '',
    at: '2026-09-25T03:00:01.000Z',
  }).state;
  state = reduceExactEffectV1(state, {
    schemaVersion: 1,
    eventId: 'event-observe',
    type: ExactEffectEventType.RECORD_OBSERVATION,
    effectId: invocationValue.invocationId,
    executionId: state.executionId,
    observation: observationValue,
    at: OBSERVED_AT,
  }).state;
  return state;
}

function workspaceWithProvenance(artifactRef = artifact(), provenanceOverrides = {}) {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(artifactRef), { nowMs: 2 });
  putProjectArtifactProvenance(workspace, provenance(artifactRef, provenanceOverrides), { nowMs: 3 });
  return workspace;
}

function binding(overrides = {}) {
  return {
    schemaVersion: 1,
    jobId: 'job-1',
    projectId: 'project-a',
    planId: 'plan-1',
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    jobBinding: binding(),
    workspace: workspaceWithProvenance(),
    exactEffectState: effectWithObservation(),
    artifactId: 'artifact-out',
    ...overrides,
  };
}

test('resolver composes exact job/project/plan identity with current Project provenance and producer observation', () => {
  const result = resolveJobArtifactProvenanceV1(request());
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.jobId, 'job-1');
  assert.equal(result.projectId, 'project-a');
  assert.equal(result.planId, 'plan-1');
  assert.equal(result.artifactRef.artifactId, 'artifact-out');
  assert.equal(result.producer.invocationId, 'invoke-1');
  assert.equal(result.producer.observationId, 'obs-1');
  assert.equal(result.producer.observationStatus, 'OK');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.producer), true);
});

test('resolver rejects a caller job binding that points at another Project or has no exact plan identity', () => {
  assert.throws(
    () => resolveJobArtifactProvenanceV1(request({ jobBinding: binding({ projectId:'project-other' }) })),
    /Project not found/,
  );
  assert.throws(
    () => resolveJobArtifactProvenanceV1(request({ jobBinding: binding({ planId:'' }) })),
    /planId is invalid/,
  );
});

test('resolver rejects Project provenance made stale by a newer artifact identity', () => {
  const workspace = workspaceWithProvenance();
  replaceProjectSnapshot(workspace, {
    ...snapshot(artifact({ sha256:hash('c') })),
    revisionId:'project-r2',
  }, { nowMs: 4 });
  assert.throws(
    () => resolveJobArtifactProvenanceV1(request({ workspace })),
    /not current/,
  );
});

test('resolver rejects artifact substitution, duplicate observation aliases, and producer mismatch', () => {
  const substituted = effectWithObservation(observation([artifact({ sha256:hash('c') })]));
  assert.throws(
    () => resolveJobArtifactProvenanceV1(request({ exactEffectState:substituted })),
    /does not match Project provenance/,
  );

  const duplicated = effectWithObservation(observation([artifact(), artifact()]));
  assert.throws(
    () => resolveJobArtifactProvenanceV1(request({ exactEffectState:duplicated })),
    /exactly one matching artifact/,
  );

  const otherProducerArtifact = artifact({ producerInvocationId:'invoke-other' });
  const otherWorkspace = workspaceWithProvenance(otherProducerArtifact);
  assert.throws(
    () => resolveJobArtifactProvenanceV1(request({ workspace:otherWorkspace })),
    /producerInvocationId does not match/,
  );
});

test('resolver requires an ExactEffect observation instead of treating invocation metadata as result evidence', () => {
  const state = createExactEffectStateV1(invocation(), { createdAt: INVOCATION_AT });
  assert.throws(
    () => resolveJobArtifactProvenanceV1(request({ exactEffectState:state })),
    /requires an ExactEffect observation/,
  );
});

test('resolver rejects invocation, artifact, observation and provenance causal inversions', () => {
  const earlyArtifact = artifact({ createdAt:'2026-09-25T02:59:58.000Z' });
  assert.throws(
    () => resolveJobArtifactProvenanceV1(request({
      workspace:workspaceWithProvenance(earlyArtifact),
      exactEffectState:effectWithObservation(observation([earlyArtifact])),
    })),
    /predates its producer invocation/,
  );

  const lateArtifact = artifact({ createdAt:'2026-09-25T03:00:04.000Z' });
  assert.throws(
    () => resolveJobArtifactProvenanceV1(request({
      workspace:workspaceWithProvenance(lateArtifact, { createdAt:'2026-09-25T03:00:05.000Z' }),
      exactEffectState:effectWithObservation(observation([lateArtifact])),
    })),
    /Observation predates/,
  );

  const provenanceTooEarly = artifact({ createdAt:'2026-09-25T03:00:03.500Z' });
  assert.throws(
    () => resolveJobArtifactProvenanceV1(request({
      workspace:workspaceWithProvenance(provenanceTooEarly, { createdAt:'2026-09-25T03:00:03.000Z' }),
      exactEffectState:effectWithObservation(observation([provenanceTooEarly], { observedAt:'2026-09-25T03:00:04.000Z' })),
    })),
    /provenance predates/,
  );
});

test('resolver request and binding identity fields are descriptor-safe', () => {
  let reads = 0;
  const hostileRequest = request();
  Object.defineProperty(hostileRequest, 'artifactId', {
    enumerable:true,
    get() {
      reads += 1;
      return 'artifact-out';
    },
  });
  assert.throws(() => resolveJobArtifactProvenanceV1(hostileRequest), /enumerable own data properties/);
  assert.equal(reads, 0);

  const hostileBinding = binding();
  Object.defineProperty(hostileBinding, 'projectId', {
    enumerable:true,
    get() {
      reads += 1;
      return 'project-a';
    },
  });
  assert.throws(
    () => resolveJobArtifactProvenanceV1(request({ jobBinding:hostileBinding })),
    /enumerable own data properties/,
  );
  assert.equal(reads, 0);
});
