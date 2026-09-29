import assert from 'node:assert/strict';
import test from 'node:test';

import { JobArtifactProvenanceResolverV1 } from '../src/core/job-artifact-provenance.js';
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

function snapshot(artifactRef = artifact(), overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: 'project-a',
    revisionId: 'project-r1',
    title: 'Project A',
    sourceRefs: [source()],
    artifactRefs: [artifactRef],
    createdAt: PROVENANCE_AT,
    ...overrides,
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

function sequence(values) {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return structuredClone(value);
  };
}

function resolverFor({
  bindings = [binding()],
  workspaces = [workspaceWithProvenance()],
  effects = [effectWithObservation()],
} = {}) {
  const nextBinding = sequence(bindings);
  const nextWorkspace = sequence(workspaces);
  const nextEffect = sequence(effects);
  const effectLoads = [];
  const resolver = new JobArtifactProvenanceResolverV1({
    browserAgentManager: {
      async resolveJobProjectBinding(jobId) {
        assert.equal(jobId, 'job-1');
        return nextBinding();
      },
    },
    projectWorkspaceRepository: {
      async load() {
        return nextWorkspace();
      },
    },
    async loadExactEffect(invocationId) {
      effectLoads.push(invocationId);
      return nextEffect();
    },
  });
  return { resolver, effectLoads };
}

async function resolve(overrides = {}, dependencies = {}) {
  const { resolver, effectLoads } = resolverFor(dependencies);
  const result = await resolver.resolve({ jobId:'job-1', artifactId:'artifact-out', ...overrides });
  return { result, effectLoads };
}

test('resolver loads canonical authorities and composes exact job/project/plan provenance', async () => {
  const { result, effectLoads } = await resolve();
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.jobId, 'job-1');
  assert.equal(result.projectId, 'project-a');
  assert.equal(result.planId, 'plan-1');
  assert.equal(result.artifactRef.artifactId, 'artifact-out');
  assert.equal(result.producer.invocationId, 'invoke-1');
  assert.equal(result.producer.observationId, 'obs-1');
  assert.equal(result.producer.observationStatus, 'OK');
  assert.deepEqual(effectLoads, ['invoke-1', 'invoke-1']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.producer), true);
});

test('public resolve boundary accepts only jobId and artifactId, not caller-owned authority snapshots', async () => {
  const { resolver } = resolverFor();
  await assert.rejects(
    () => resolver.resolve({
      jobId:'job-1',
      artifactId:'artifact-out',
      jobBinding:binding(),
    }),
    /unknown field: jobBinding/,
  );
  await assert.rejects(
    () => resolver.resolve({
      jobId:'job-1',
      artifactId:'artifact-out',
      workspace:workspaceWithProvenance(),
    }),
    /unknown field: workspace/,
  );
  await assert.rejects(
    () => resolver.resolve({
      jobId:'job-1',
      artifactId:'artifact-out',
      exactEffectState:effectWithObservation(),
    }),
    /unknown field: exactEffectState/,
  );
});

test('resolver rejects canonical job binding pointed at another Project or without plan identity', async () => {
  await assert.rejects(
    () => resolve({}, { bindings:[binding({ projectId:'project-other' })] }),
    /Project not found/,
  );
  await assert.rejects(
    () => resolve({}, { bindings:[binding({ planId:'' })] }),
    /planId is invalid/,
  );
});

test('resolver rejects Project provenance made stale by a newer current snapshot', async () => {
  const current = workspaceWithProvenance();
  const stale = structuredClone(current);
  replaceProjectSnapshot(stale, snapshot(artifact({ sha256:hash('c') }), { revisionId:'project-r2' }), { nowMs:4 });
  await assert.rejects(
    () => resolve({}, { workspaces:[current, stale] }),
    /not current/,
  );
});

test('resolver rejects artifact substitution, duplicate observation aliases, and producer mismatch', async () => {
  const substituted = effectWithObservation(observation([artifact({ sha256:hash('c') })]));
  await assert.rejects(
    () => resolve({}, { effects:[substituted] }),
    /does not match Project provenance/,
  );

  const duplicated = effectWithObservation(observation([artifact(), artifact()]));
  await assert.rejects(
    () => resolve({}, { effects:[duplicated] }),
    /exactly one matching artifact/,
  );

  const otherProducerArtifact = artifact({ producerInvocationId:'invoke-other' });
  const otherWorkspace = workspaceWithProvenance(otherProducerArtifact);
  await assert.rejects(
    () => resolve({}, { workspaces:[otherWorkspace] }),
    /producerInvocationId does not match/,
  );
});

test('resolver requires a canonical ExactEffect observation instead of treating invocation metadata as evidence', async () => {
  const state = createExactEffectStateV1(invocation(), { createdAt: INVOCATION_AT });
  await assert.rejects(
    () => resolve({}, { effects:[state] }),
    /requires an ExactEffect observation/,
  );
});

test('resolver rejects invocation, artifact, observation and provenance causal inversions', async () => {
  const earlyArtifact = artifact({ createdAt:'2026-09-25T02:59:58.000Z' });
  await assert.rejects(
    () => resolve({}, {
      workspaces:[workspaceWithProvenance(earlyArtifact)],
      effects:[effectWithObservation(observation([earlyArtifact]))],
    }),
    /predates its producer invocation/,
  );

  const lateArtifact = artifact({ createdAt:'2026-09-25T03:00:04.000Z' });
  await assert.rejects(
    () => resolve({}, {
      workspaces:[workspaceWithProvenance(lateArtifact, { createdAt:'2026-09-25T03:00:05.000Z' })],
      effects:[effectWithObservation(observation([lateArtifact]))],
    }),
    /Observation predates/,
  );

  const provenanceTooEarly = artifact({ createdAt:'2026-09-25T03:00:03.500Z' });
  await assert.rejects(
    () => resolve({}, {
      workspaces:[workspaceWithProvenance(provenanceTooEarly, { createdAt:'2026-09-25T03:00:03.000Z' })],
      effects:[effectWithObservation(observation(
        [provenanceTooEarly],
        { observedAt:'2026-09-25T03:00:04.000Z' },
      ))],
    }),
    /provenance predates/,
  );
});

test('resolver fails closed if job binding, Project provenance, or exact-effect state changes during read fence', async () => {
  await assert.rejects(
    () => resolve({}, {
      bindings:[binding(), binding({ planId:'plan-2' })],
    }),
    /binding changed during provenance resolution/,
  );

  const artifactV2 = artifact({ sha256:hash('c') });
  await assert.rejects(
    () => resolve({}, {
      workspaces:[workspaceWithProvenance(), workspaceWithProvenance(artifactV2)],
      effects:[effectWithObservation(), effectWithObservation(observation([artifactV2]))],
    }),
    /Project artifact provenance changed during provenance resolution/,
  );

  const effectV2 = effectWithObservation(observation([artifact()], { observationId:'obs-2' }));
  await assert.rejects(
    () => resolve({}, {
      effects:[effectWithObservation(), effectV2],
    }),
    /Exact-effect state changed during provenance resolution/,
  );
});

test('resolver request identity is descriptor-safe and executes no accessor', async () => {
  const { resolver } = resolverFor();
  let reads = 0;
  const request = { jobId:'job-1' };
  Object.defineProperty(request, 'artifactId', {
    enumerable:true,
    get() {
      reads += 1;
      return 'artifact-out';
    },
  });
  await assert.rejects(
    () => resolver.resolve(request),
    /enumerable own data properties/,
  );
  assert.equal(reads, 0);
});

test('resolver requires all canonical authority adapters', () => {
  assert.throws(
    () => new JobArtifactProvenanceResolverV1({}),
    /Canonical Browser Agent/,
  );
  assert.throws(
    () => new JobArtifactProvenanceResolverV1({
      browserAgentManager:{ resolveJobProjectBinding() {} },
    }),
    /Project workspace repository/,
  );
  assert.throws(
    () => new JobArtifactProvenanceResolverV1({
      browserAgentManager:{ resolveJobProjectBinding() {} },
      projectWorkspaceRepository:{ load() {} },
    }),
    /exact-effect loader/,
  );
});
