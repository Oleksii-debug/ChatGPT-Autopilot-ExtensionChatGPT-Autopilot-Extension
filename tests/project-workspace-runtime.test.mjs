import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECT_WORKSPACE_STORAGE_KEY,
  ProjectWorkspaceRepository,
  addProjectSnapshot,
  createProjectWorkspace,
  putProjectArtifactProvenance,
  putProjectContextCapsule,
  replaceProjectSnapshot,
} from '../src/core/project-workspace.js';
import {
  ProjectWorkspaceRuntimeReader,
  projectProjectWorkspaceSummaryV1,
} from '../src/core/project-workspace-runtime.js';

const hash = char => char.repeat(64);

function source(projectId, revisionId = 'source-r1') {
  return {
    schemaVersion: 1,
    sourceId: `source-${projectId}`,
    projectId,
    kind: 'GITHUB',
    uri: `https://private.example/${projectId}/secret-source`,
    revisionId,
    contentSha256: hash('a'),
    observedAt: '2026-09-25T10:00:00.000Z',
    authority: 'CANONICAL',
    metadata: { privateMarker: 'do-not-project' },
  };
}

function artifact(projectId, { sensitive = false } = {}) {
  return {
    schemaVersion: 1,
    artifactId: `artifact-${projectId}`,
    kind: 'REPORT',
    uri: `drive://private/${projectId}/secret-artifact`,
    mediaType: 'text/plain',
    sha256: hash('b'),
    sizeBytes: 17,
    createdAt: '2026-09-25T10:00:00.000Z',
    producerInvocationId: null,
    sensitive,
  };
}

function snapshot(projectId, revisionId = 'project-r1', sourceRevision = 'source-r1', options = {}) {
  return {
    schemaVersion: 1,
    projectId,
    revisionId,
    title: `Secret title ${projectId}`,
    sourceRefs: [source(projectId, sourceRevision)],
    artifactRefs: [artifact(projectId, options)],
    createdAt: '2026-09-25T10:00:00.000Z',
  };
}

function capsule(projectId, projectRevisionId = 'project-r1', sourceRevision = 'source-r1') {
  return {
    schemaVersion: 1,
    capsuleId: `capsule-${projectId}`,
    projectId,
    projectRevisionId,
    summary: `Secret capsule body ${projectId}`,
    sourceBindings: [{
      sourceId: `source-${projectId}`,
      revisionId: sourceRevision,
      contentSha256: hash('a'),
    }],
    artifactRefs: [artifact(projectId, { sensitive: projectId === 'project-b' })],
    createdAt: '2026-09-25T10:00:00.000Z',
  };
}

function provenance(projectId, options = {}) {
  return {
    schemaVersion: 1,
    projectId,
    artifactRef: artifact(projectId, options),
    sourceBindings: [{
      sourceId: `source-${projectId}`,
      revisionId: 'source-r1',
      contentSha256: hash('a'),
    }],
    inputArtifactIds: [],
    createdAt: '2026-09-25T10:00:00.000Z',
  };
}

function fakeChrome(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    storage: {
      local: {
        async get(key) { return { [key]: data[key] }; },
        async set(value) { Object.assign(data, structuredClone(value)); },
      },
    },
  };
}

test('empty Project Workspace projection is deterministic, frozen and grants no authority', () => {
  const out = projectProjectWorkspaceSummaryV1(createProjectWorkspace(1));
  assert.equal(out.workspaceRevision, 0);
  assert.equal(out.projectCount, 0);
  assert.deepEqual(out.projects, []);
  assert.deepEqual(out.summary, {
    sourceCount: 0,
    artifactCount: 0,
    sensitiveArtifactCount: 0,
    capsuleCount: 0,
    currentRevisionCapsuleCount: 0,
    staleRevisionCapsuleCount: 0,
    provenanceCount: 0,
    unprovenancedArtifactCount: 0,
  });
  assert.equal(out.readOnly, true);
  assert.equal(out.workspaceAdmissionAuthorized, false);
  assert.equal(out.mutationAuthorized, false);
  assert.equal(out.sourceContentExposed, false);
  assert.equal(out.sourceLocationsExposed, false);
  assert.equal(out.artifactLocationsExposed, false);
  assert.equal(out.credentialsExposed, false);
  assert.ok(Object.isFrozen(out));
  assert.ok(Object.isFrozen(out.projects));
  assert.ok(Object.isFrozen(out.summary));
});

test('projection sorts exact Project identities and exposes only bounded counts/revision status', () => {
  const workspace = createProjectWorkspace(1);

  addProjectSnapshot(workspace, snapshot('project-b', 'project-r1', 'source-r1', { sensitive: true }), { nowMs: 2 });
  putProjectContextCapsule(workspace, capsule('project-b'), { nowMs: 3 });
  putProjectArtifactProvenance(workspace, provenance('project-b', { sensitive: true }), { nowMs: 4 });
  replaceProjectSnapshot(
    workspace,
    snapshot('project-b', 'project-r2', 'source-r2', { sensitive: true }),
    { nowMs: 5 },
  );

  addProjectSnapshot(workspace, snapshot('project-a'), { nowMs: 6 });
  putProjectContextCapsule(workspace, capsule('project-a'), { nowMs: 7 });

  const out = projectProjectWorkspaceSummaryV1(workspace);
  assert.deepEqual(out.projects.map(project => project.projectId), ['project-a', 'project-b']);
  assert.equal(out.projects[0].capsuleRevisionStatus, 'CURRENT');
  assert.equal(out.projects[1].projectRevisionId, 'project-r2');
  assert.equal(out.projects[1].staleRevisionCapsuleCount, 1);
  assert.equal(out.projects[1].capsuleRevisionStatus, 'HAS_STALE');
  assert.equal(out.projects[1].sensitiveArtifactCount, 1);
  assert.equal(out.summary.provenanceCount, 1);

  const serialized = JSON.stringify(out);
  assert.doesNotMatch(serialized, /private\.example|drive:\/\/private|Secret title|Secret capsule|privateMarker/u);
  assert.doesNotMatch(serialized, /source-project-|artifact-project-/u);
});

test('runtime reader uses the canonical durable repository and survives repository recreation', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot('project-a'), { nowMs: 2 });
    return workspace;
  }, { nowMs: 2 });

  const first = await new ProjectWorkspaceRuntimeReader(repository).readSummary();
  const restored = await new ProjectWorkspaceRuntimeReader(new ProjectWorkspaceRepository(chrome)).readSummary();

  assert.equal(first.workspaceRevision, 1);
  assert.equal(restored.workspaceRevision, 1);
  assert.deepEqual(restored, first);
  assert.ok(chrome.data[PROJECT_WORKSPACE_STORAGE_KEY]);
});

test('corrupt durable Project Workspace fails closed instead of returning partial UI data', async () => {
  const chrome = fakeChrome({
    [PROJECT_WORKSPACE_STORAGE_KEY]: {
      schemaVersion: 999,
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      projectsById: {},
    },
  });
  const reader = new ProjectWorkspaceRuntimeReader(new ProjectWorkspaceRepository(chrome));
  await assert.rejects(() => reader.readSummary(), /Unsupported project workspace schema/u);
});
