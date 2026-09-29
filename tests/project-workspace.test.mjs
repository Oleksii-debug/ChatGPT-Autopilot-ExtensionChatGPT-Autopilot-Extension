import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROJECT_WORKSPACE_STORAGE_KEY,
  ProjectWorkspaceRepository,
  addProjectSnapshot,
  createProjectRecord,
  createProjectWorkspace,
  getProjectArtifactProvenance,
  projectCurrentState,
  resolveProjectWorkspaceContextV1,
  putProjectArtifactProvenance,
  putProjectContextCapsule,
  replaceProjectSnapshot,
  validateProjectWorkspace,
} from '../src/core/project-workspace.js';
import { projectSubagentContextV1 } from '../src/core/subagent-context-projection.js';

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


test('snapshot revision identity cannot be reused for semantically different content', () => {
  const workspace = createProjectWorkspace(1);
  const project = addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });

  const replay = replaceProjectSnapshot(workspace, snapshot(), { nowMs: 50 });
  assert.equal(replay, project);
  assert.equal(project.updatedAt, 2);

  assert.throws(
    () => replaceProjectSnapshot(workspace, { ...snapshot(), title: 'Substituted title' }, { nowMs: 51 }),
    /revisionId cannot be reused for different content/,
  );
  assert.equal(project.snapshot.title, 'Project A');
  assert.equal(project.snapshot.revisionId, 'project-r1');

  const substitutedSource = snapshot();
  substitutedSource.sourceRefs = [{
    ...source(),
    uri: 'https://github.com/acme/substituted',
  }];
  assert.throws(
    () => replaceProjectSnapshot(workspace, substitutedSource, { nowMs: 52 }),
    /revisionId cannot be reused for different content/,
  );
  assert.equal(project.snapshot.sourceRefs[0].uri, 'https://github.com/acme/repo');
});

test('trusted context resolver returns only the exact current durable snapshot and current capsule', () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
  putProjectContextCapsule(workspace, capsule(), { nowMs: 3 });

  const resolved = resolveProjectWorkspaceContextV1(workspace, {
    projectId: 'project-a',
    expectedProjectRevisionId: 'project-r1',
    capsuleId: 'capsule-1',
  });

  assert.equal(resolved.workspaceRevision, 0);
  assert.equal(resolved.projectId, 'project-a');
  assert.equal(resolved.projectRevisionId, 'project-r1');
  assert.equal(resolved.snapshot.revisionId, 'project-r1');
  assert.equal(resolved.capsule.capsuleId, 'capsule-1');
  assert.equal(resolved.ownerStateSource, 'DURABLE_PROJECT_WORKSPACE');
  assert.equal(resolved.sourceAuthorityAuthenticated, false);
  assert.equal(resolved.retrievalAuthorized, false);
  assert.equal(resolved.executionAuthorized, false);
  assert.equal(resolved.mutationAuthorized, false);
  assert.equal(resolved.policyAuthority, false);
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.snapshot), true);
  assert.equal(Object.isFrozen(resolved.capsule), true);
});

test('trusted context resolver fails closed on stale revision, stale capsule and shaped lookup aliases', () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
  putProjectContextCapsule(workspace, capsule(), { nowMs: 3 });

  assert.throws(
    () => resolveProjectWorkspaceContextV1(workspace, {
      projectId: 'project-a',
      expectedProjectRevisionId: 'project-r2',
      capsuleId: 'capsule-1',
    }),
    /snapshot revision binding mismatch/,
  );
  assert.throws(
    () => resolveProjectWorkspaceContextV1(workspace, {
      projectId: ' project-a',
      expectedProjectRevisionId: 'project-r1',
    }),
    /Invalid projectId/,
  );
  assert.throws(
    () => resolveProjectWorkspaceContextV1(workspace, {
      projectId: 'project-a',
      expectedProjectRevisionId: 'project-r1',
      unexpectedAuthority: true,
    }),
    /unknown field/,
  );
  assert.throws(
    () => resolveProjectWorkspaceContextV1(workspace, {
      projectId: 'project-a',
      expectedProjectRevisionId: 'project-r1',
      capsuleId: '',
    }),
    /Invalid capsuleId/,
  );
  assert.throws(
    () => resolveProjectWorkspaceContextV1(workspace, {
      projectId: 'project-a',
      expectedProjectRevisionId: 'project-r1',
      capsuleId: null,
    }),
    /Invalid capsuleId/,
  );

  replaceProjectSnapshot(workspace, snapshot('project-r2', 'r2'), { nowMs: 4 });
  assert.throws(
    () => resolveProjectWorkspaceContextV1(workspace, {
      projectId: 'project-a',
      expectedProjectRevisionId: 'project-r2',
      capsuleId: 'capsule-1',
    }),
    /does not bind current project snapshot/,
  );
});

test('repository context resolver snapshots caller identity before storage await and survives restart', async () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
  putProjectContextCapsule(workspace, capsule(), { nowMs: 3 });

  const data = { [PROJECT_WORKSPACE_STORAGE_KEY]: structuredClone(workspace) };
  let releaseGet;
  const gate = new Promise(resolve => { releaseGet = resolve; });
  const chrome = {
    data,
    storage: {
      local: {
        async get(key) {
          await gate;
          return { [key]: structuredClone(data[key]) };
        },
        async set(value) {
          Object.assign(data, structuredClone(value));
        },
      },
    },
  };
  const repo = new ProjectWorkspaceRepository(chrome);
  const request = {
    projectId: 'project-a',
    expectedProjectRevisionId: 'project-r1',
    capsuleId: 'capsule-1',
  };

  const pending = repo.resolveContext(request);
  request.projectId = 'project-other';
  request.expectedProjectRevisionId = 'project-r999';
  request.capsuleId = 'capsule-other';
  releaseGet();

  const resolved = await pending;
  assert.equal(resolved.projectId, 'project-a');
  assert.equal(resolved.projectRevisionId, 'project-r1');
  assert.equal(resolved.capsule.capsuleId, 'capsule-1');

  const restarted = new ProjectWorkspaceRepository(fakeChrome({
    [PROJECT_WORKSPACE_STORAGE_KEY]: data[PROJECT_WORKSPACE_STORAGE_KEY],
  }));
  const afterRestart = await restarted.resolveContext({
    projectId: 'project-a',
    expectedProjectRevisionId: 'project-r1',
    capsuleId: 'capsule-1',
  });
  assert.equal(afterRestart.snapshot.sourceRefs[0].sourceId, 'github-main');
  assert.equal(afterRestart.ownerStateSource, 'DURABLE_PROJECT_WORKSPACE');
});

test('repository context resolver rejects accessor-backed requests before storage read', async () => {
  let getterCalls = 0;
  let storageReads = 0;
  const chrome = {
    storage: {
      local: {
        async get() {
          storageReads += 1;
          return {};
        },
        async set() {},
      },
    },
  };
  const repo = new ProjectWorkspaceRepository(chrome);
  const request = {
    expectedProjectRevisionId: 'project-r1',
  };
  Object.defineProperty(request, 'projectId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'project-a';
    },
  });

  await assert.rejects(
    repo.resolveContext(request),
    /enumerable own data properties/,
  );
  assert.equal(getterCalls, 0);
  assert.equal(storageReads, 0);
});


test('durable workspace resolution composes with least-authority child projection without upgrading source trust', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    putProjectContextCapsule(workspace, capsule(), { nowMs: 3 });
    return workspace;
  }, { nowMs: 3 });

  const durable = await repository.resolveContext({
    projectId: 'project-a',
    expectedProjectRevisionId: 'project-r1',
    capsuleId: 'capsule-1',
  });
  assert.equal(durable.workspaceRevision, 1);
  assert.equal(durable.ownerStateSource, 'DURABLE_PROJECT_WORKSPACE');
  assert.equal(durable.sourceAuthorityAuthenticated, false);

  const projected = projectSubagentContextV1({
    schemaVersion: 1,
    authorityEnvelope: {
      schemaVersion: 1,
      decision: 'ALLOW',
      reasonCode: 'LEAST_AUTHORITY_DERIVED',
      projectId: 'project-a',
      parentAgentId: 'agent.parent',
      childAgentId: 'agent.child',
      taskId: 'task.child',
      providerId: 'provider.main',
      capabilityIds: ['cap.read'],
      sourceIds: ['github-main'],
      artifactIds: ['build'],
      toolIds: ['tool.read'],
      toolDescriptors: [],
      executionAuthority: false,
      credentialAuthority: false,
      policyAuthority: false,
    },
    expectedParentAgentId: 'agent.parent',
    expectedChildAgentId: 'agent.child',
    expectedTaskId: 'task.child',
    expectedProjectRevisionId: durable.projectRevisionId,
    parentProjectSnapshot: durable.snapshot,
    priorParentCapsule: durable.capsule,
  });

  assert.deepEqual(projected.projectedSnapshot.sourceRefs.map(item => item.sourceId), ['github-main']);
  assert.deepEqual(projected.projectedSnapshot.artifactRefs.map(item => item.artifactId), ['build']);
  assert.equal(projected.retrievalAuthorized, false);
  assert.equal(projected.executionAuthorized, false);
  assert.equal(projected.policyAuthority, false);
  assert.equal(projected.sourceTrust, 'CALLER_BOUND_NOT_AUTHENTICATED');
  assert.equal(
    JSON.stringify(projected).includes(durable.snapshot.title),
    false,
    'parent project title must not cross the child context boundary',
  );
});


test('canonical repository update rejects same-revision snapshot substitution without durable advance', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    return workspace;
  }, { nowMs: 2 });

  await assert.rejects(
    repository.update(workspace => {
      workspace.projectsById['project-a'].snapshot = {
        ...workspace.projectsById['project-a'].snapshot,
        title: 'Substituted through generic update',
      };
      return workspace;
    }, { nowMs: 3 }),
    /revisionId cannot be reused for different content/,
  );

  const restored = await repository.load();
  assert.equal(restored.revision, 1);
  assert.equal(restored.updatedAt, 2);
  assert.equal(restored.projectsById['project-a'].snapshot.title, 'Project A');
  assert.equal(restored.projectsById['project-a'].snapshot.revisionId, 'project-r1');
});


test('canonical repository update cannot remove an existing durable project record', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    return workspace;
  }, { nowMs: 2 });

  await assert.rejects(
    repository.update(workspace => {
      delete workspace.projectsById['project-a'];
      return workspace;
    }, { nowMs: 3 }),
    /cannot remove an existing project/,
  );

  const restored = await repository.load();
  assert.equal(restored.revision, 1);
  assert.equal(restored.updatedAt, 2);
  assert.equal(restored.projectsById['project-a'].snapshot.revisionId, 'project-r1');
});


test('repository context resolver supports an exact snapshot-only request with capsuleId physically absent', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    return workspace;
  }, { nowMs: 2 });

  const resolved = await repository.resolveContext({
    projectId: 'project-a',
    expectedProjectRevisionId: 'project-r1',
  });

  assert.equal(resolved.projectId, 'project-a');
  assert.equal(resolved.projectRevisionId, 'project-r1');
  assert.equal(resolved.capsule, null);
  assert.equal(resolved.workspaceRevision, 1);
});


test('context capsule identity is idempotent-only and cannot be substituted under the same durable id', () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
  const first = putProjectContextCapsule(workspace, capsule(), { nowMs: 3 });
  const replay = putProjectContextCapsule(workspace, capsule(), { nowMs: 50 });
  assert.deepEqual(replay, first);
  assert.equal(workspace.projectsById['project-a'].updatedAt, 3);

  assert.throws(
    () => putProjectContextCapsule(workspace, {
      ...capsule(),
      summary: 'Substituted durable child context.',
    }, { nowMs: 51 }),
    /capsuleId cannot be reused for different content/,
  );
  assert.equal(
    workspace.projectsById['project-a'].capsulesById['capsule-1'].summary,
    'Current state.',
  );
});

test('canonical repository update cannot delete or substitute an existing durable context capsule', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    putProjectContextCapsule(workspace, capsule(), { nowMs: 3 });
    return workspace;
  }, { nowMs: 3 });

  await assert.rejects(
    repository.update(workspace => {
      delete workspace.projectsById['project-a'].capsulesById['capsule-1'];
      return workspace;
    }, { nowMs: 4 }),
    /cannot remove an existing context capsule/,
  );

  await assert.rejects(
    repository.update(workspace => {
      workspace.projectsById['project-a'].capsulesById['capsule-1'] = {
        ...workspace.projectsById['project-a'].capsulesById['capsule-1'],
        summary: 'Substituted through generic update.',
      };
      return workspace;
    }, { nowMs: 5 }),
    /capsuleId cannot be reused for different content/,
  );

  const restored = await repository.load();
  assert.equal(restored.revision, 1);
  assert.equal(restored.projectsById['project-a'].capsulesById['capsule-1'].summary, 'Current state.');
});


test('artifact provenance identity is immutable under its durable artifact key', () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
  const first = putProjectArtifactProvenance(workspace, provenance(), { nowMs: 3 });
  const replay = putProjectArtifactProvenance(workspace, provenance(), { nowMs: 50 });
  assert.deepEqual(replay, first);
  assert.equal(workspace.projectsById['project-a'].updatedAt, 3);

  assert.throws(
    () => putProjectArtifactProvenance(workspace, {
      ...provenance(),
      sourceBindings: [],
    }, { nowMs: 51 }),
    /provenance identity cannot be reused for different content/,
  );
  assert.equal(
    workspace.projectsById['project-a'].provenanceByArtifactId.build.sourceBindings.length,
    1,
  );
});

test('canonical repository update cannot delete or substitute existing artifact provenance', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    putProjectArtifactProvenance(workspace, provenance(), { nowMs: 3 });
    return workspace;
  }, { nowMs: 3 });

  await assert.rejects(
    repository.update(workspace => {
      delete workspace.projectsById['project-a'].provenanceByArtifactId.build;
      return workspace;
    }, { nowMs: 4 }),
    /cannot remove existing artifact provenance/,
  );

  await assert.rejects(
    repository.update(workspace => {
      workspace.projectsById['project-a'].provenanceByArtifactId.build = {
        ...workspace.projectsById['project-a'].provenanceByArtifactId.build,
        sourceBindings: [],
      };
      return workspace;
    }, { nowMs: 5 }),
    /provenance identity cannot be reused for different content/,
  );

  const restored = await repository.load();
  assert.equal(restored.revision, 1);
  assert.equal(restored.projectsById['project-a'].provenanceByArtifactId.build.sourceBindings.length, 1);
});


test('workspace validation rejects persisted chronology inversion', () => {
  const workspace = createProjectWorkspace(10);
  workspace.updatedAt = 9;
  assert.throws(
    () => validateProjectWorkspace(workspace),
    /updatedAt cannot precede createdAt/,
  );

  const valid = createProjectWorkspace(1);
  addProjectSnapshot(valid, snapshot(), { nowMs: 2 });
  valid.projectsById['project-a'].updatedAt = 1;
  assert.throws(
    () => validateProjectWorkspace(valid),
    /project updatedAt cannot precede createdAt/,
  );
});

test('repository update rejects durable-time rollback before invoking caller mutator', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    return workspace;
  }, { nowMs: 2 });

  let mutatorCalls = 0;
  await assert.rejects(
    repository.update(workspace => {
      mutatorCalls += 1;
      workspace.projectsById['project-a'].snapshot = snapshot('project-r2', 'r2');
      return workspace;
    }, { nowMs: 1 }),
    /nowMs cannot precede durable updatedAt/,
  );

  assert.equal(mutatorCalls, 0);
  const restored = await repository.load();
  assert.equal(restored.revision, 1);
  assert.equal(restored.updatedAt, 2);
  assert.equal(restored.projectsById['project-a'].snapshot.revisionId, 'project-r1');
});

test('generic repository mutation cannot rewrite durable creation time or move project time backward', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    putProjectContextCapsule(workspace, capsule(), { nowMs: 3 });
    return workspace;
  }, { nowMs: 3 });

  await assert.rejects(
    repository.update(workspace => {
      workspace.createdAt = 2;
      return workspace;
    }, { nowMs: 4 }),
    /workspace createdAt is immutable/,
  );

  await assert.rejects(
    repository.update(workspace => {
      workspace.projectsById['project-a'].createdAt = 1;
      return workspace;
    }, { nowMs: 4 }),
    /project createdAt is immutable/,
  );

  await assert.rejects(
    repository.update(workspace => {
      workspace.projectsById['project-a'].updatedAt = 2;
      return workspace;
    }, { nowMs: 4 }),
    /project updatedAt cannot move backward/,
  );

  const restored = await repository.load();
  assert.equal(restored.revision, 1);
  assert.equal(restored.createdAt, 3);
  assert.equal(restored.updatedAt, 3);
  assert.equal(restored.projectsById['project-a'].createdAt, 2);
  assert.equal(restored.projectsById['project-a'].updatedAt, 3);
});

test('monotonic repository update remains valid after chronology hardening', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    return workspace;
  }, { nowMs: 2 });
  await repository.update(workspace => {
    replaceProjectSnapshot(workspace, snapshot('project-r2', 'r2'), { nowMs: 5 });
    return workspace;
  }, { nowMs: 5 });

  const restored = await repository.load();
  assert.equal(restored.revision, 2);
  assert.equal(restored.updatedAt, 5);
  assert.equal(restored.projectsById['project-a'].updatedAt, 5);
  assert.equal(restored.projectsById['project-a'].snapshot.revisionId, 'project-r2');
});


test('repository save rejects direct durable revision rollback and stale-writer expectations', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);

  const initial = createProjectWorkspace(1);
  await repository.save(initial);

  const revisionOne = structuredClone(initial);
  revisionOne.revision = 1;
  revisionOne.updatedAt = 2;
  addProjectSnapshot(revisionOne, snapshot(), { nowMs: 2 });
  await repository.save(revisionOne);

  await assert.rejects(
    repository.save(initial),
    /revision must advance exactly once/,
  );

  const staleWriter = structuredClone(revisionOne);
  staleWriter.revision = 2;
  staleWriter.updatedAt = 3;
  replaceProjectSnapshot(staleWriter, snapshot('project-r2', 'r2'), { nowMs: 3 });
  await assert.rejects(
    repository.save(staleWriter, { expectedPreviousRevision: 0 }),
    /durable revision changed before save/,
  );

  const restored = await repository.load();
  assert.equal(restored.revision, 1);
  assert.equal(restored.projectsById['project-a'].snapshot.revisionId, 'project-r1');
});

test('repository save cannot bootstrap arbitrary nonzero revision into empty durable storage', async () => {
  const repository = new ProjectWorkspaceRepository(fakeChrome());
  const forged = createProjectWorkspace(1);
  forged.revision = 7;
  forged.updatedAt = 8;

  await assert.rejects(
    repository.save(forged),
    /Initial project workspace save must use revision 0/,
  );
});

test('repository save revalidates immutable owner identity against durable state', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  const initial = createProjectWorkspace(1);
  await repository.save(initial);

  const next = structuredClone(initial);
  next.revision = 1;
  next.updatedAt = 2;
  next.createdAt = 0;

  await assert.rejects(
    repository.save(next),
    /workspace createdAt is immutable/,
  );

  const restored = await repository.load();
  assert.equal(restored.revision, 0);
  assert.equal(restored.createdAt, 1);
});


test('project snapshot revision ids are append-only and cannot be resurrected after supersession', () => {
  const workspace = createProjectWorkspace(1);
  const project = addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
  replaceProjectSnapshot(workspace, snapshot('project-r2', 'r2'), { nowMs: 3 });

  assert.deepEqual(project.snapshotRevisionIds, ['project-r1', 'project-r2']);
  assert.throws(
    () => replaceProjectSnapshot(workspace, snapshot('project-r1', 'r1'), { nowMs: 4 }),
    /cannot be reused after it was superseded/,
  );
  assert.equal(project.snapshot.revisionId, 'project-r2');
  assert.deepEqual(project.snapshotRevisionIds, ['project-r1', 'project-r2']);
});

test('snapshot revision history survives repository restart and still blocks resurrection', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    return workspace;
  }, { nowMs: 2 });
  await repository.update(workspace => {
    replaceProjectSnapshot(workspace, snapshot('project-r2', 'r2'), { nowMs: 3 });
    return workspace;
  }, { nowMs: 3 });

  const restarted = new ProjectWorkspaceRepository(chrome);
  const durable = await restarted.load();
  assert.deepEqual(
    durable.projectsById['project-a'].snapshotRevisionIds,
    ['project-r1', 'project-r2'],
  );

  await assert.rejects(
    restarted.update(workspace => {
      replaceProjectSnapshot(workspace, snapshot('project-r1', 'r1'), { nowMs: 4 });
      return workspace;
    }, { nowMs: 4 }),
    /cannot be reused after it was superseded/,
  );

  const after = await restarted.load();
  assert.equal(after.revision, 2);
  assert.equal(after.projectsById['project-a'].snapshot.revisionId, 'project-r2');
});

test('generic repository mutation cannot bypass append-only snapshot revision history', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    return workspace;
  }, { nowMs: 2 });

  await assert.rejects(
    repository.update(workspace => {
      workspace.projectsById['project-a'].snapshot = snapshot('project-r2', 'r2');
      workspace.projectsById['project-a'].updatedAt = 3;
      return workspace;
    }, { nowMs: 3 }),
    /revision history does not end at current snapshot/,
  );

  const restored = await repository.load();
  assert.equal(restored.revision, 1);
  assert.deepEqual(restored.projectsById['project-a'].snapshotRevisionIds, ['project-r1']);
});

test('workspace validation rejects duplicate or non-current snapshot revision history', () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });

  const duplicate = structuredClone(workspace);
  duplicate.projectsById['project-a'].snapshotRevisionIds = ['project-r1', 'project-r1'];
  assert.throws(
    () => validateProjectWorkspace(duplicate),
    /duplicate revisionId/,
  );

  const mismatched = structuredClone(workspace);
  mismatched.projectsById['project-a'].snapshotRevisionIds = ['project-r0'];
  assert.throws(
    () => validateProjectWorkspace(mismatched),
    /does not end at current snapshot/,
  );
});


test('snapshot revision history rejects accessor-backed and decorated array shapes without getter execution', () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });

  const accessorBacked = structuredClone(workspace);
  let getterCalls = 0;
  Object.defineProperty(accessorBacked.projectsById['project-a'], 'snapshotRevisionIds', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return ['project-r1'];
    },
  });
  assert.throws(
    () => validateProjectWorkspace(accessorBacked),
    /enumerable own data property/,
  );
  assert.equal(getterCalls, 0);

  const decorated = structuredClone(workspace);
  decorated.projectsById['project-a'].snapshotRevisionIds.extra = 'authority';
  assert.throws(
    () => validateProjectWorkspace(decorated),
    /contains non-index field/,
  );

  const sparse = structuredClone(workspace);
  sparse.projectsById['project-a'].snapshotRevisionIds = new Array(2);
  sparse.projectsById['project-a'].snapshotRevisionIds[1] = 'project-r1';
  assert.throws(
    () => validateProjectWorkspace(sparse),
    /must be dense/,
  );
});


test('separate repository instances cannot lose an update after reading the same durable revision', async () => {
  const chrome = fakeChrome();
  const seed = new ProjectWorkspaceRepository(chrome);
  await seed.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    return workspace;
  }, { nowMs: 2 });

  const left = new ProjectWorkspaceRepository(chrome);
  const right = new ProjectWorkspaceRepository(chrome);
  let entered = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const waitForBoth = async () => {
    entered += 1;
    if (entered === 2) release();
    await barrier;
  };

  const leftUpdate = left.update(async workspace => {
    replaceProjectSnapshot(workspace, snapshot('project-r2-left', 'r2-left'), { nowMs: 3 });
    await waitForBoth();
    return workspace;
  }, { nowMs: 3 });
  const rightUpdate = right.update(async workspace => {
    replaceProjectSnapshot(workspace, snapshot('project-r2-right', 'r2-right'), { nowMs: 3 });
    await waitForBoth();
    return workspace;
  }, { nowMs: 3 });

  const settled = await Promise.allSettled([leftUpdate, rightUpdate]);
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(result => result.status === 'rejected').length, 1);
  assert.match(
    settled.find(result => result.status === 'rejected').reason.message,
    /durable revision changed before save/,
  );

  const durable = await seed.load();
  assert.equal(durable.revision, 2);
  assert.equal(
    ['project-r2-left', 'project-r2-right'].includes(durable.projectsById['project-a'].snapshot.revisionId),
    true,
  );
});

test('empty-storage expectedPreviousRevision bootstrap cannot jump durable revisions', async () => {
  const repository = new ProjectWorkspaceRepository(fakeChrome());
  const forged = createProjectWorkspace(1);
  forged.revision = 7;
  forged.updatedAt = 8;

  await assert.rejects(
    repository.save(forged, { expectedPreviousRevision: 0 }),
    /update must advance revision exactly once/,
  );
});

test('repository save snapshots caller workspace before asynchronous durable read', async () => {
  const data = {};
  let releaseGet;
  const gate = new Promise(resolve => { releaseGet = resolve; });
  const chrome = {
    storage: {
      local: {
        async get(key) {
          await gate;
          return { [key]: data[key] };
        },
        async set(value) {
          Object.assign(data, structuredClone(value));
        },
      },
    },
  };
  const repository = new ProjectWorkspaceRepository(chrome);
  const candidate = createProjectWorkspace(1);
  const pending = repository.save(candidate);
  candidate.revision = 99;
  candidate.updatedAt = 99;
  releaseGet();

  const saved = await pending;
  assert.equal(saved.revision, 0);
  assert.equal(saved.updatedAt, 1);
  assert.equal(data[PROJECT_WORKSPACE_STORAGE_KEY].revision, 0);
  assert.equal(data[PROJECT_WORKSPACE_STORAGE_KEY].updatedAt, 1);
});


test('exact durable save replay succeeds after lost acknowledgement while same-revision substitution fails', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    return workspace;
  }, { nowMs: 2 });

  const current = await repository.load();
  const next = structuredClone(current);
  replaceProjectSnapshot(next, snapshot('project-r2', 'r2'), { nowMs: 3 });
  next.revision = 2;
  next.updatedAt = 3;

  const committed = await repository.save(next, { expectedPreviousRevision: 1 });
  assert.equal(committed.revision, 2);

  const replayed = await repository.save(next, { expectedPreviousRevision: 1 });
  assert.deepEqual(replayed, committed);

  const substituted = structuredClone(next);
  substituted.projectsById['project-a'].snapshot.title = 'Same revision, different content';
  await assert.rejects(
    repository.save(substituted, { expectedPreviousRevision: 1 }),
    /durable revision changed before save|revision must advance exactly once|revisionId cannot be reused/,
  );

  const durable = await repository.load();
  assert.deepEqual(durable, committed);
});

test('a rejected save does not poison the shared repository save queue', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    return workspace;
  }, { nowMs: 2 });

  const invalid = await repository.load();
  invalid.revision = 9;
  invalid.updatedAt = 9;
  await assert.rejects(
    repository.save(invalid),
    /revision must advance exactly once/,
  );

  const recovered = await repository.update(workspace => {
    replaceProjectSnapshot(workspace, snapshot('project-r2', 'r2'), { nowMs: 3 });
    return workspace;
  }, { nowMs: 3 });

  assert.equal(recovered.revision, 2);
  assert.equal(recovered.projectsById['project-a'].snapshot.revisionId, 'project-r2');
});


test('capsule and provenance artifact bindings reject same-hash metadata or location substitution', () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });

  const movedCapsule = capsule();
  movedCapsule.artifactRefs = [{
    ...artifact(),
    uri: 'drive://different-location',
  }];
  assert.throws(
    () => putProjectContextCapsule(workspace, movedCapsule, { nowMs: 3 }),
    /artifact binding is not current: build/,
  );

  const reclassifiedProvenance = provenance();
  reclassifiedProvenance.artifactRef = {
    ...artifact(),
    sensitive: true,
  };
  assert.throws(
    () => putProjectArtifactProvenance(workspace, reclassifiedProvenance, { nowMs: 3 }),
    /provenance artifact is not current: build/,
  );
});

test('project revisions cannot rebind one immutable artifactId to another ArtifactRef identity', () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });

  const movedSnapshot = snapshot('project-r2', 'r1');
  movedSnapshot.artifactRefs = [{
    ...artifact(),
    uri: 'drive://moved-build',
  }];
  assert.throws(
    () => replaceProjectSnapshot(workspace, movedSnapshot, { nowMs: 4 }),
    /artifactId cannot be reused for different immutable content: build/,
  );

  const unchangedArtifact = snapshot('project-r2', 'r1');
  assert.doesNotThrow(
    () => replaceProjectSnapshot(workspace, unchangedArtifact, { nowMs: 4 }),
  );
  assert.equal(workspace.projectsById['project-a'].snapshot.revisionId, 'project-r2');
});

test('durable provenance prevents later resurrection of a removed artifactId with different identity', () => {
  const workspace = createProjectWorkspace(1);
  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
  putProjectArtifactProvenance(workspace, provenance(), { nowMs: 3 });

  const withoutBuild = snapshot('project-r2', 'r1');
  withoutBuild.artifactRefs = [];
  replaceProjectSnapshot(workspace, withoutBuild, { nowMs: 4 });

  const resurrected = snapshot('project-r3', 'r1');
  resurrected.artifactRefs = [{
    ...artifact(),
    uri: 'drive://different-build',
  }];
  assert.throws(
    () => replaceProjectSnapshot(workspace, resurrected, { nowMs: 5 }),
    /artifactId cannot be rebound after durable provenance: build/,
  );
});


test('workspace and project records reject hidden authority fields and signed-zero revisions', () => {
  const workspace = createProjectWorkspace(1);
  workspace.ownerOverride = true;
  assert.throws(
    () => validateProjectWorkspace(workspace),
    /project workspace contains unknown field: ownerOverride/,
  );
  delete workspace.ownerOverride;

  addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
  workspace.projectsById['project-a'].policyAuthority = true;
  assert.throws(
    () => validateProjectWorkspace(workspace),
    /project workspace project contains unknown field: policyAuthority/,
  );
  delete workspace.projectsById['project-a'].policyAuthority;

  workspace.revision = -0;
  assert.throws(
    () => validateProjectWorkspace(workspace),
    /Invalid project workspace revision/,
  );
});

test('dynamic workspace maps reject accessors without executing them', () => {
  let reads = 0;
  const workspace = createProjectWorkspace(1);
  Object.defineProperty(workspace.projectsById, 'project-a', {
    enumerable: true,
    get() {
      reads += 1;
      return createProjectRecord(snapshot(), { nowMs: 2 });
    },
  });

  assert.throws(
    () => validateProjectWorkspace(workspace),
    /projectsById entries must be enumerable own data properties/,
  );
  assert.equal(reads, 0);
});

test('repository save rejects signed-zero expected revisions', async () => {
  const repository = new ProjectWorkspaceRepository(fakeChrome());
  await assert.rejects(
    repository.save(createProjectWorkspace(1), { expectedPreviousRevision: -0 }),
    /Invalid expected project workspace revision/,
  );
});


test('generic repository mutation cannot bypass immutable artifactId continuity', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    return workspace;
  }, { nowMs: 2 });

  await assert.rejects(
    repository.update(workspace => {
      const next = snapshot('project-r2', 'r1');
      next.artifactRefs = [{
        ...artifact(),
        uri: 'drive://generic-bypass',
      }];
      workspace.projectsById['project-a'].snapshot = next;
      workspace.projectsById['project-a'].snapshotRevisionIds.push('project-r2');
      workspace.projectsById['project-a'].updatedAt = 3;
      return workspace;
    }, { nowMs: 3 }),
    /artifactId cannot be reused for different immutable content: build/,
  );

  const durable = await repository.load();
  assert.equal(durable.revision, 1);
  assert.equal(durable.projectsById['project-a'].snapshot.revisionId, 'project-r1');
  assert.equal(durable.projectsById['project-a'].snapshot.artifactRefs[0].uri, 'drive://build');
});


test('repository update rejects accessor-backed mutator results before owner field writes', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  let setterCalls = 0;

  await assert.rejects(
    repository.update(() => {
      const hostile = createProjectWorkspace(1);
      Object.defineProperty(hostile, 'revision', {
        enumerable: true,
        configurable: true,
        get() {
          return 0;
        },
        set() {
          setterCalls += 1;
        },
      });
      return hostile;
    }, { nowMs: 2 }),
    /fields must be enumerable own data properties/,
  );

  assert.equal(setterCalls, 0);
  const durable = await repository.load({ emptyNowMs: 2 });
  assert.equal(durable.revision, 0);
});


test('repository load returns a detached durable snapshot when storage returns the same object reference', async () => {
  const stored = createProjectWorkspace(1);
  addProjectSnapshot(stored, snapshot(), { nowMs: 2 });
  stored.revision = 1;
  stored.updatedAt = 2;
  const data = { [PROJECT_WORKSPACE_STORAGE_KEY]: stored };
  const chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: data[key] }; },
        async set(value) { Object.assign(data, value); },
      },
    },
  };
  const repository = new ProjectWorkspaceRepository(chrome);
  const loaded = await repository.load();
  loaded.projectsById['project-a'].snapshot.title = 'caller mutation';
  loaded.revision = 99;

  const again = await repository.load();
  assert.equal(again.revision, 1);
  assert.equal(again.projectsById['project-a'].snapshot.title, 'Project A');
  assert.equal(data[PROJECT_WORKSPACE_STORAGE_KEY].revision, 1);
});

test('workspace revision and expected revision reject unsafe integers', async () => {
  const unsafe = createProjectWorkspace(1);
  unsafe.revision = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => validateProjectWorkspace(unsafe),
    /Invalid project workspace revision/,
  );

  const repository = new ProjectWorkspaceRepository(fakeChrome());
  await assert.rejects(
    repository.save(createProjectWorkspace(1), {
      expectedPreviousRevision: Number.MAX_SAFE_INTEGER + 1,
    }),
    /Invalid expected project workspace revision/,
  );
});

test('exact save replay accepts only the immediately preceding expected revision', async () => {
  const chrome = fakeChrome();
  const repository = new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace => {
    addProjectSnapshot(workspace, snapshot(), { nowMs: 2 });
    return workspace;
  }, { nowMs: 2 });

  const current = await repository.load();
  const next = structuredClone(current);
  replaceProjectSnapshot(next, snapshot('project-r2', 'r2'), { nowMs: 3 });
  next.revision = 2;
  next.updatedAt = 3;
  await repository.save(next, { expectedPreviousRevision: 1 });

  await assert.doesNotReject(
    repository.save(next, { expectedPreviousRevision: 1 }),
  );
  await assert.rejects(
    repository.save(next, { expectedPreviousRevision: 0 }),
    /exact replay expected revision mismatch/,
  );
  await assert.rejects(
    repository.save(next, { expectedPreviousRevision: 2 }),
    /exact replay expected revision mismatch/,
  );
});


test('save return values cannot alias durable storage objects', async () => {
  const data = {};
  const chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: data[key] }; },
        async set(value) { Object.assign(data, value); },
      },
    },
  };
  const repository = new ProjectWorkspaceRepository(chrome);

  const initial = createProjectWorkspace(1);
  const first = await repository.save(initial);
  first.updatedAt = 99;
  first.revision = 99;
  assert.equal(data[PROJECT_WORKSPACE_STORAGE_KEY].updatedAt, 1);
  assert.equal(data[PROJECT_WORKSPACE_STORAGE_KEY].revision, 0);

  const replay = await repository.save(createProjectWorkspace(1));
  replay.updatedAt = 77;
  replay.revision = 77;
  assert.equal(data[PROJECT_WORKSPACE_STORAGE_KEY].updatedAt, 1);
  assert.equal(data[PROJECT_WORKSPACE_STORAGE_KEY].revision, 0);
});
