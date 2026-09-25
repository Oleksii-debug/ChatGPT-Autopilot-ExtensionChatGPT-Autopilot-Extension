import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROJECT_WORKSPACE_STORAGE_KEY,
  ProjectWorkspaceRepository,
  addProjectSnapshot,
  createProjectWorkspace,
  getProjectArtifactProvenance,
  projectCurrentState,
  putProjectArtifactProvenance,
  putProjectContextCapsule,
  replaceProjectSnapshot,
  validateProjectWorkspace,
} from '../src/core/project-workspace.js';

const hash = char => char.repeat(64);
const source = (revisionId = 'r1') => ({
  schemaVersion: 1, sourceId: 'github-main', projectId: 'project-a', kind: 'GITHUB', uri: 'https://github.com/acme/repo',
  revisionId, contentSha256: hash('a'), observedAt: '2026-09-23T00:00:00.000Z', authority: 'CANONICAL', metadata: {},
});
const artifact = () => ({ schemaVersion: 1, artifactId: 'build', kind: 'ZIP', uri: 'drive://build', mediaType: 'application/zip', sha256: hash('b'), sizeBytes: 10, createdAt: '2026-09-23T00:00:00.000Z', producerInvocationId: null, sensitive: false });
const snapshot = (revisionId = 'project-r1', sourceRevision = 'r1') => ({ schemaVersion: 1, projectId: 'project-a', revisionId, title: 'Project A', sourceRefs: [source(sourceRevision)], artifactRefs: [artifact()], createdAt: '2026-09-23T00:00:00.000Z' });
const capsule = (projectRevisionId = 'project-r1', sourceRevision = 'r1') => ({ schemaVersion: 1, capsuleId: 'capsule-1', projectId: 'project-a', projectRevisionId, summary: 'Current state.', sourceBindings: [{ sourceId: 'github-main', revisionId: sourceRevision, contentSha256: hash('a') }], artifactRefs: [artifact()], createdAt: '2026-09-23T00:00:00.000Z' });
const provenance = () => ({ schemaVersion: 1, projectId: 'project-a', artifactRef: artifact(), sourceBindings: [{ sourceId: 'github-main', revisionId: 'r1', contentSha256: hash('a') }], inputArtifactIds: [], createdAt: '2026-09-23T00:00:00.000Z' });

function fakeChrome(initial = {}) {
  const data = structuredClone(initial);
  return { data, storage: { local: { async get(key) { return { [key]: data[key] }; }, async set(value) { Object.assign(data, structuredClone(value)); } } } };
}

test('project workspace persists a bounded project snapshot, capsule and artifact provenance', () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
  putProjectContextCapsule(workspace, capsule(), { nowMs: 3 });
  putProjectArtifactProvenance(workspace, provenance(), { nowMs: 4 });
  assert.equal(workspace.projectsById['project-a'].capsulesById['capsule-1'].capsuleId, 'capsule-1');
  assert.equal(workspace.projectsById['project-a'].provenanceByArtifactId.build.artifactRef.artifactId, 'build');
  assert.equal(projectCurrentState(workspace, 'project-a', 'capsule-1', [source()]).status, 'FRESH');
});

test('workspace refuses capsule and provenance that are not bound to the current snapshot', () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
  assert.throws(() => putProjectContextCapsule(workspace, capsule('project-r2'), { nowMs: 3 }), /current project snapshot/);
  assert.throws(() => putProjectArtifactProvenance(workspace, { ...provenance(), sourceBindings: [{ sourceId: 'github-main', revisionId: 'r2', contentSha256: hash('a') }] }, { nowMs: 3 }), /not current/);
});

test('snapshot replacement keeps prior evidence but reports it stale instead of silently re-authorizing it', () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
  putProjectContextCapsule(workspace, capsule(), { nowMs: 3 });
  replaceProjectSnapshot(workspace, snapshot('project-r2', 'r2'), { nowMs: 4 });
  const state = projectCurrentState(workspace, 'project-a', 'capsule-1', [source('r2')]);
  assert.equal(state.status, 'STALE');
  assert.equal(state.sources[0].reasons.includes('CAPSULE_REVISION_DIFFERS_FROM_SNAPSHOT'), true);
});

test('repository serializes concurrent updates and survives recreation', async () => {
  const chrome = fakeChrome();
  const repo = new ProjectWorkspaceRepository(chrome);
  await repo.update(workspace => { addProjectSnapshot(workspace, snapshot(), { nowMs: 2 }); return workspace; }, { nowMs: 2 });
  await Promise.all([
    repo.update(workspace => { putProjectContextCapsule(workspace, capsule(), { nowMs: 3 }); return workspace; }, { nowMs: 3 }),
    repo.update(workspace => { putProjectArtifactProvenance(workspace, provenance(), { nowMs: 4 }); return workspace; }, { nowMs: 4 }),
  ]);
  const restored = new ProjectWorkspaceRepository(chrome);
  const workspace = await restored.load();
  assert.equal(workspace.revision, 3);
  assert.ok(chrome.data[PROJECT_WORKSPACE_STORAGE_KEY]);
  assert.equal(workspace.projectsById['project-a'].capsulesById['capsule-1'].summary, 'Current state.');
});


test('workspace stores reserved prototype-like durable ids as own entries without prototype mutation', () => {
  const workspace = createProjectWorkspace(1);
  const specialSource = { ...source(), projectId: 'constructor' };
  const specialArtifact = { ...artifact(), artifactId: 'constructor' };
  const specialSnapshot = {
    ...snapshot(),
    projectId: 'constructor',
    sourceRefs: [specialSource],
    artifactRefs: [specialArtifact],
  };
  addProjectSnapshot(workspace, specialSnapshot, { nowMs: 2 });

  assert.equal(Object.hasOwn(workspace.projectsById, 'constructor'), true);
  assert.equal(Object.getPrototypeOf(workspace.projectsById), Object.prototype);

  const specialCapsule = {
    ...capsule(),
    capsuleId: 'constructor',
    projectId: 'constructor',
    sourceBindings: [{
      sourceId: 'github-main',
      revisionId: 'r1',
      contentSha256: hash('a'),
    }],
    artifactRefs: [specialArtifact],
  };
  putProjectContextCapsule(workspace, specialCapsule, { nowMs: 3 });
  const project = workspace.projectsById['constructor'];
  assert.equal(Object.hasOwn(project.capsulesById, 'constructor'), true);
  assert.equal(Object.getPrototypeOf(project.capsulesById), Object.prototype);

  const specialProvenance = {
    ...provenance(),
    projectId: 'constructor',
    artifactRef: specialArtifact,
    sourceBindings: [{
      sourceId: 'github-main',
      revisionId: 'r1',
      contentSha256: hash('a'),
    }],
  };
  putProjectArtifactProvenance(workspace, specialProvenance, { nowMs: 4 });
  assert.equal(Object.hasOwn(project.provenanceByArtifactId, 'constructor'), true);
  assert.equal(Object.getPrototypeOf(project.provenanceByArtifactId), Object.prototype);
  assert.equal(validateProjectWorkspace(workspace), workspace);
  assert.equal(projectCurrentState(workspace, 'constructor', 'constructor', [specialSource]).status, 'FRESH');
});

test('workspace lookup identities reject leading and trailing whitespace aliases', () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
  putProjectContextCapsule(workspace, capsule(), { nowMs: 3 });
  putProjectArtifactProvenance(workspace, provenance(), { nowMs: 4 });

  assert.throws(
    () => projectCurrentState(workspace, ' project-a', 'capsule-1', [source()]),
    /Invalid projectId/,
  );
  assert.throws(
    () => projectCurrentState(workspace, 'project-a ', 'capsule-1', [source()]),
    /Invalid projectId/,
  );
  assert.throws(
    () => projectCurrentState(workspace, 'project-a', ' capsule-1', [source()]),
    /Invalid capsuleId/,
  );
  assert.throws(
    () => projectCurrentState(workspace, 'project-a', 'capsule-1 ', [source()]),
    /Invalid capsuleId/,
  );
  assert.throws(
    () => getProjectArtifactProvenance(workspace, 'project-a', ' build'),
    /Invalid artifactId/,
  );
  assert.throws(
    () => getProjectArtifactProvenance(workspace, 'project-a', 'build '),
    /Invalid artifactId/,
  );

  assert.equal(projectCurrentState(workspace, 'project-a', 'capsule-1', [source()]).status, 'FRESH');
  assert.equal(getProjectArtifactProvenance(workspace, 'project-a', 'build').artifactRef.artifactId, 'build');
});

test('workspace lookup identities are string-only and persisted record prototypes fail closed', () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
  putProjectContextCapsule(workspace, capsule(), { nowMs: 3 });

  assert.throws(() => projectCurrentState(workspace, 1, 'capsule-1', [source()]), /Invalid projectId/);
  assert.throws(() => projectCurrentState(workspace, 'project-a', true, [source()]), /Invalid capsuleId/);

  const poisoned = structuredClone(workspace);
  Object.setPrototypeOf(poisoned.projectsById, { hidden: true });
  assert.throws(() => validateProjectWorkspace(poisoned), /projectsById prototype/);
});
