import test from 'node:test';
import assert from 'node:assert/strict';

import { projectSubagentContextV1 } from '../src/core/subagent-context-projection.js';
import { compileDeltaContextPlanV1 } from '../src/core/context-compiler.js';
import { createSha256FingerprintV1 } from '../src/core/fingerprint.js';

const T1 = '2026-09-28T00:00:01.000Z';
const T2 = '2026-09-28T00:00:02.000Z';

function source(sourceId, {
  revisionId = 'r1',
  sha = 'a'.repeat(64),
} = {}) {
  return {
    schemaVersion: 1,
    sourceId,
    projectId: 'project.alpha',
    kind: 'document',
    uri: `private://parent/${sourceId}`,
    revisionId,
    contentSha256: sha,
    observedAt: T1,
    authority: 'CANONICAL',
    metadata: { label: sourceId },
  };
}

function artifact(artifactId, {
  sha = 'b'.repeat(64),
  producerInvocationId = '',
} = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'document',
    uri: `private://artifact/${artifactId}`,
    mediaType: 'text/plain',
    sha256: sha,
    sizeBytes: 12,
    createdAt: T1,
    producerInvocationId,
    sensitive: false,
  };
}

function snapshot() {
  return {
    schemaVersion: 1,
    projectId: 'project.alpha',
    revisionId: 'project-r2',
    title: 'Parent project',
    sourceRefs: [
      source('source.allowed'),
      source('source.secret', { sha: 'c'.repeat(64) }),
    ],
    artifactRefs: [
      artifact('artifact.allowed'),
      artifact('artifact.secret', { sha: 'd'.repeat(64) }),
    ],
    createdAt: T2,
  };
}

function envelope(overrides = {}) {
  return {
    schemaVersion: 1,
    decision: 'ALLOW',
    reasonCode: 'LEAST_AUTHORITY_DERIVED',
    projectId: 'project.alpha',
    parentAgentId: 'agent.parent',
    childAgentId: 'agent.child',
    taskId: 'task.child',
    providerId: 'provider.main',
    capabilityIds: ['cap.read'],
    sourceIds: ['source.allowed'],
    artifactIds: ['artifact.allowed'],
    toolIds: ['tool.read'],
    toolDescriptors: [],
    executionAuthority: false,
    credentialAuthority: false,
    policyAuthority: false,
    ...overrides,
  };
}

function capsule(overrides = {}) {
  return {
    schemaVersion: 1,
    capsuleId: 'capsule.parent',
    projectId: 'project.alpha',
    projectRevisionId: 'project-r2',
    summary: 'Parent summary contains allowed and secret facts and must never be copied.',
    sourceBindings: [
      {
        sourceId: 'source.allowed',
        revisionId: 'r1',
        contentSha256: 'a'.repeat(64),
      },
      {
        sourceId: 'source.secret',
        revisionId: 'r1',
        contentSha256: 'c'.repeat(64),
      },
    ],
    artifactRefs: [
      artifact('artifact.allowed'),
      artifact('artifact.secret', { sha: 'd'.repeat(64) }),
    ],
    createdAt: T2,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    authorityEnvelope: envelope(),
    expectedParentAgentId: 'agent.parent',
    expectedChildAgentId: 'agent.child',
    expectedTaskId: 'task.child',
    parentProjectSnapshot: snapshot(),
    priorParentCapsule: capsule(),
    ...overrides,
  };
}

test('projects exactly the child-admitted source and artifact scope', () => {
  const result = projectSubagentContextV1(request());

  assert.equal(result.projectId, 'project.alpha');
  assert.equal(result.parentAgentId, 'agent.parent');
  assert.equal(result.childAgentId, 'agent.child');
  assert.equal(result.taskId, 'task.child');
  assert.deepEqual(
    result.projectedSnapshot.sourceRefs.map(item => item.sourceId),
    ['source.allowed'],
  );
  assert.deepEqual(
    result.projectedSnapshot.artifactRefs.map(item => item.artifactId),
    ['artifact.allowed'],
  );
  assert.deepEqual(
    result.priorBindings.sourceBindings.map(item => item.sourceId),
    ['source.allowed'],
  );
  assert.deepEqual(
    result.priorBindings.artifactRefs.map(item => item.artifactId),
    ['artifact.allowed'],
  );
  assert.equal(result.priorBindings.summaryReusable, false);
  assert.equal(
    result.priorBindings.summaryOmittedReason,
    'PARENT_SUMMARY_MAY_CROSS_CHILD_AUTHORITY_BOUNDARY',
  );
  assert.equal(JSON.stringify(result).includes('Parent summary contains'), false);
  assert.equal(JSON.stringify(result).includes('source.secret'), false);
  assert.equal(JSON.stringify(result).includes('artifact.secret'), false);
  assert.equal(result.retrievalAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.credentialAuthority, false);
  assert.equal(result.policyAuthority, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.projectedSnapshot.sourceRefs), true);
});

test('missing admitted source or artifact fails closed instead of silently widening or dropping scope', () => {
  assert.throws(
    () => projectSubagentContextV1(request({
      authorityEnvelope: envelope({ sourceIds: ['source.missing'] }),
    })),
    /Authorized child sourceIds missing from parent snapshot: source\.missing/,
  );

  assert.throws(
    () => projectSubagentContextV1(request({
      authorityEnvelope: envelope({ artifactIds: ['artifact.missing'] }),
    })),
    /Authorized child artifactIds missing from parent snapshot: artifact\.missing/,
  );
});

test('only canonical ALLOW least-authority envelope is accepted and authority aliases are rejected', () => {
  assert.throws(
    () => projectSubagentContextV1(request({
      authorityEnvelope: envelope({ decision: 'DENY' }),
    })),
    /requires an ALLOW least-authority envelope/,
  );
  assert.throws(
    () => projectSubagentContextV1(request({
      authorityEnvelope: envelope({ reasonCode: 'OWNER_OVERRIDE' }),
    })),
    /requires an ALLOW least-authority envelope/,
  );
  assert.throws(
    () => projectSubagentContextV1(request({
      authorityEnvelope: { ...envelope(), retrievalAuthority: true },
    })),
    /unknown field: retrievalAuthority/,
  );
  assert.throws(
    () => projectSubagentContextV1(request({
      authorityEnvelope: envelope({ executionAuthority: true }),
    })),
    /executionAuthority must remain false/,
  );
});

test('caller binds exact parent child and task identities before projection', () => {
  assert.throws(
    () => projectSubagentContextV1(request({ expectedParentAgentId: 'agent.other' })),
    /parentAgentId binding mismatch/,
  );
  assert.throws(
    () => projectSubagentContextV1(request({ expectedChildAgentId: 'agent.other' })),
    /childAgentId binding mismatch/,
  );
  assert.throws(
    () => projectSubagentContextV1(request({ expectedTaskId: 'task.other' })),
    /taskId binding mismatch/,
  );
  assert.throws(
    () => projectSubagentContextV1(request({
      authorityEnvelope: envelope({ childAgentId: 'agent.parent' }),
    })),
    /child identity is not isolated/,
  );
});

test('project identity mismatch and stale authorized prior bindings fail closed', () => {
  const otherProject = snapshot();
  otherProject.projectId = 'project.other';
  otherProject.sourceRefs = otherProject.sourceRefs.map(item => ({
    ...item,
    projectId: 'project.other',
  }));
  assert.throws(
    () => projectSubagentContextV1(request({ parentProjectSnapshot: otherProject })),
    /projectId does not match parent project snapshot/,
  );

  const staleSource = capsule();
  staleSource.sourceBindings = staleSource.sourceBindings.map(item =>
    item.sourceId === 'source.allowed'
      ? { ...item, revisionId: 'old' }
      : item);
  assert.throws(
    () => projectSubagentContextV1(request({ priorParentCapsule: staleSource })),
    /stale authorized source binding: source\.allowed/,
  );

  const staleArtifact = capsule();
  staleArtifact.artifactRefs = staleArtifact.artifactRefs.map(item =>
    item.artifactId === 'artifact.allowed'
      ? { ...item, sha256: 'e'.repeat(64) }
      : item);
  assert.throws(
    () => projectSubagentContextV1(request({ priorParentCapsule: staleArtifact })),
    /stale authorized artifact ref: artifact\.allowed/,
  );
});

test('unauthorized stale parent capsule entries are omitted rather than creating child visibility', () => {
  const staleSecret = capsule();
  staleSecret.sourceBindings = staleSecret.sourceBindings.map(item =>
    item.sourceId === 'source.secret'
      ? { ...item, revisionId: 'stale-secret' }
      : item);
  staleSecret.artifactRefs = staleSecret.artifactRefs.map(item =>
    item.artifactId === 'artifact.secret'
      ? { ...item, sha256: 'f'.repeat(64) }
      : item);

  const result = projectSubagentContextV1(request({ priorParentCapsule: staleSecret }));
  assert.deepEqual(result.priorBindings.sourceBindings.map(item => item.sourceId), ['source.allowed']);
  assert.deepEqual(result.priorBindings.artifactRefs.map(item => item.artifactId), ['artifact.allowed']);
});

test('request and envelope boundaries reject accessors symbols duplicates and sparse arrays without getter reads', () => {
  let reads = 0;
  const hostile = request();
  Object.defineProperty(hostile, 'expectedChildAgentId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'agent.child';
    },
  });
  assert.throws(
    () => projectSubagentContextV1(hostile),
    /expectedChildAgentId must be an enumerable own data property/,
  );
  assert.equal(reads, 0);

  const withSymbol = request();
  withSymbol[Symbol('policyAuthority')] = true;
  assert.throws(() => projectSubagentContextV1(withSymbol), /symbol field/);

  assert.throws(
    () => projectSubagentContextV1(request({
      authorityEnvelope: envelope({ sourceIds: ['source.allowed', 'source.allowed'] }),
    })),
    /sourceIds contains duplicates/,
  );

  const sparse = new Array(2);
  sparse[0] = 'source.allowed';
  assert.throws(
    () => projectSubagentContextV1(request({
      authorityEnvelope: envelope({ sourceIds: sparse }),
    })),
    /sourceIds must be dense/,
  );
});

test('empty child context scope is valid and does not inherit parent visibility', () => {
  const result = projectSubagentContextV1(request({
    authorityEnvelope: envelope({
      sourceIds: [],
      artifactIds: [],
    }),
  }));
  assert.deepEqual(result.projectedSnapshot.sourceRefs, []);
  assert.deepEqual(result.projectedSnapshot.artifactRefs, []);
  assert.deepEqual(result.priorBindings.sourceBindings, []);
  assert.deepEqual(result.priorBindings.artifactRefs, []);
});


test('projected child snapshot prevents compiler reuse of cached fragments bound to parent-only sources', async () => {
  const projected = projectSubagentContextV1(request({ priorParentCapsule: null }));
  const allowedSummary = 'allowed child fact';
  const secretSummary = 'SECRET PARENT FACT MUST NOT ENTER CHILD CONTEXT';

  const plan = await compileDeltaContextPlanV1({
    schemaVersion: 1,
    compilerId: 'child-context-compiler',
    projectSnapshot: projected.projectedSnapshot,
    priorCapsule: null,
    fragments: [
      {
        fragmentId: 'allowed-fragment',
        sourceBindings: [{
          sourceId: 'source.allowed',
          revisionId: 'r1',
          contentSha256: 'a'.repeat(64),
          authority: 'CANONICAL',
        }],
        dependencyFragmentIds: [],
        summary: allowedSummary,
        summarySha256: await createSha256FingerprintV1(allowedSummary),
        createdAt: T2,
      },
      {
        fragmentId: 'parent-secret-fragment',
        sourceBindings: [{
          sourceId: 'source.secret',
          revisionId: 'r1',
          contentSha256: 'c'.repeat(64),
          authority: 'CANONICAL',
        }],
        dependencyFragmentIds: [],
        summary: secretSummary,
        summarySha256: await createSha256FingerprintV1(secretSummary),
        createdAt: T2,
      },
    ],
    compiledAt: '2026-09-28T00:00:03.000Z',
  });

  assert.deepEqual(plan.reusableFragments.map(item => item.fragmentId), ['allowed-fragment']);
  assert.deepEqual(plan.staleFragments.map(item => item.fragmentId), ['parent-secret-fragment']);
  assert.deepEqual(plan.staleFragments[0].staleSourceIds, ['source.secret']);
  assert.equal(JSON.stringify(plan).includes(secretSummary), false);
});
