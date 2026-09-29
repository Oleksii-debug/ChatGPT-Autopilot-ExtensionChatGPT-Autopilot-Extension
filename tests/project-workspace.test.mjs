import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROJECT_WORKSPACE_STORAGE_KEY,
  ProjectWorkspaceRepository,
  addProjectSnapshot,
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
  assert.equal(restored.createdAt, 0);
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
