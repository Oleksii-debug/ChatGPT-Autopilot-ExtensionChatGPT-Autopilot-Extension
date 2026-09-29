import {
  normalizeArtifactProvenanceV1,
  normalizeContextCapsuleV1,
  normalizeProjectSnapshotV1,
  normalizeProjectSourceRefV1,
} from './project-context-artifact.js';
import { deriveProjectCurrentStateV1 } from './project-current-state.js';

export const PROJECT_WORKSPACE_STORAGE_KEY = 'autopilotProjectWorkspaceV1';
export const PROJECT_WORKSPACE_SCHEMA_VERSION = 1;
export const MAX_PROJECTS = 64;
export const MAX_CAPSULES_PER_PROJECT = 128;
export const MAX_PROVENANCE_PER_PROJECT = 512;
export const PROJECT_WORKSPACE_CONTEXT_RESOLUTION_VERSION = 1;

const CONTEXT_RESOLUTION_REQUEST_KEYS = new Set(['projectId', 'expectedProjectRevisionId', 'capsuleId']);
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`Invalid ${label} prototype`);
  return value;
}

function strictDataRecord(value, allowedKeys, label) {
  record(value, label);
  const out = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !hasOwn(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function workspaceId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !WORKSPACE_ID.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function setOwn(value, key, entry) {
  Object.defineProperty(value, key, {
    value: entry,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return entry;
}

function timestamp(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`);
  return value;
}

function artifactIdentity(ref) {
  if (!ref) return '';
  return `${ref.artifactId}\u001f${ref.sha256 || ''}\u001f${ref.sizeBytes}`;
}

function sourceIdentity(source) {
  return `${source.sourceId}\u001f${source.revisionId}\u001f${source.contentSha256 || ''}`;
}

function sameCanonicalData(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftArray = Array.isArray(left);
  if (leftArray !== Array.isArray(right)) return false;
  if (leftArray) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameCanonicalData(left[index], right[index])) return false;
    }
    return true;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (key !== rightKeys[index] || !sameCanonicalData(left[key], right[key])) return false;
  }
  return true;
}

function assertSnapshotRevisionContinuity(previousWorkspace, nextWorkspace) {
  for (const [projectId, previousProject] of Object.entries(previousWorkspace.projectsById)) {
    if (!hasOwn(nextWorkspace.projectsById, projectId)) {
      throw new Error('Project workspace update cannot remove an existing project');
    }
    const nextProject = nextWorkspace.projectsById[projectId];
    const previousSnapshot = normalizeProjectSnapshotV1(previousProject.snapshot);
    const nextSnapshot = normalizeProjectSnapshotV1(nextProject.snapshot);
    if (previousSnapshot.revisionId === nextSnapshot.revisionId
        && !sameCanonicalData(previousSnapshot, nextSnapshot)) {
      throw new Error('Project snapshot revisionId cannot be reused for different content');
    }
    for (const [capsuleId, previousCapsuleValue] of Object.entries(previousProject.capsulesById)) {
      if (!hasOwn(nextProject.capsulesById, capsuleId)) {
        throw new Error('Project workspace update cannot remove an existing context capsule');
      }
      const previousCapsule = normalizeContextCapsuleV1(previousCapsuleValue);
      const nextCapsule = normalizeContextCapsuleV1(nextProject.capsulesById[capsuleId]);
      if (!sameCanonicalData(previousCapsule, nextCapsule)) {
        throw new Error('Context capsuleId cannot be reused for different content');
      }
    }
  }
}

function snapshotContextResolutionRequest(input) {
  const raw = strictDataRecord(input, CONTEXT_RESOLUTION_REQUEST_KEYS, 'Project workspace context resolution request');
  if (!hasOwn(raw, 'projectId')) throw new Error('Project workspace context resolution request is missing projectId');
  if (!hasOwn(raw, 'expectedProjectRevisionId')) {
    throw new Error('Project workspace context resolution request is missing expectedProjectRevisionId');
  }
  const request = {
    projectId: workspaceId(raw.projectId, 'projectId'),
    expectedProjectRevisionId: workspaceId(raw.expectedProjectRevisionId, 'expectedProjectRevisionId'),
  };
  if (hasOwn(raw, 'capsuleId')) {
    request.capsuleId = workspaceId(raw.capsuleId, 'capsuleId');
  }
  return Object.freeze(request);
}

function validateProjectRecord(project) {
  record(project, 'project workspace project');
  const snapshot = normalizeProjectSnapshotV1(project.snapshot);
  if (project.projectId !== snapshot.projectId) throw new Error('Project workspace projectId mismatch');
  timestamp(project.createdAt, 'project workspace project createdAt');
  timestamp(project.updatedAt, 'project workspace project updatedAt');
  record(project.capsulesById, 'project workspace capsulesById');
  record(project.provenanceByArtifactId, 'project workspace provenanceByArtifactId');
  const capsules = Object.entries(project.capsulesById);
  if (capsules.length > MAX_CAPSULES_PER_PROJECT) throw new Error('Project workspace capsule limit exceeded');
  for (const [capsuleId, capsule] of capsules) {
    const normalized = normalizeContextCapsuleV1(capsule);
    if (normalized.capsuleId !== capsuleId || normalized.projectId !== snapshot.projectId) throw new Error('Project workspace capsule binding mismatch');
  }
  const provenance = Object.entries(project.provenanceByArtifactId);
  if (provenance.length > MAX_PROVENANCE_PER_PROJECT) throw new Error('Project workspace provenance limit exceeded');
  for (const [artifactId, item] of provenance) {
    const normalized = normalizeArtifactProvenanceV1(item);
    if (normalized.artifactRef.artifactId !== artifactId || normalized.projectId !== snapshot.projectId) throw new Error('Project workspace provenance binding mismatch');
  }
  return project;
}

export function createProjectWorkspace(nowMs = Date.now()) {
  return { schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION, revision: 0, createdAt: nowMs, updatedAt: nowMs, projectsById: {} };
}

export function validateProjectWorkspace(workspace) {
  record(workspace, 'project workspace');
  if (workspace.schemaVersion !== PROJECT_WORKSPACE_SCHEMA_VERSION) throw new Error('Unsupported project workspace schema');
  if (!Number.isInteger(workspace.revision) || workspace.revision < 0) throw new Error('Invalid project workspace revision');
  timestamp(workspace.createdAt, 'project workspace createdAt');
  timestamp(workspace.updatedAt, 'project workspace updatedAt');
  record(workspace.projectsById, 'project workspace projectsById');
  const entries = Object.entries(workspace.projectsById);
  if (entries.length > MAX_PROJECTS) throw new Error('Project workspace project limit exceeded');
  for (const [projectId, project] of entries) {
    validateProjectRecord(project);
    if (project.projectId !== projectId) throw new Error('Project workspace project key mismatch');
  }
  return workspace;
}

export function createProjectRecord(snapshot, { nowMs = Date.now() } = {}) {
  const normalized = normalizeProjectSnapshotV1(snapshot);
  return {
    projectId: normalized.projectId,
    snapshot: normalized,
    createdAt: nowMs,
    updatedAt: nowMs,
    capsulesById: {},
    provenanceByArtifactId: {},
  };
}

function requireProject(workspace, projectId) {
  const key = workspaceId(projectId, 'projectId');
  if (!workspace.projectsById || !hasOwn(workspace.projectsById, key)) throw new Error('Project not found');
  return workspace.projectsById[key];
}

function assertCapsuleMatchesSnapshot(capsule, snapshot) {
  if (capsule.projectId !== snapshot.projectId || capsule.projectRevisionId !== snapshot.revisionId) {
    throw new Error('Context capsule does not bind current project snapshot');
  }
  const sources = new Map(snapshot.sourceRefs.map(source => [source.sourceId, source]));
  const artifacts = new Map(snapshot.artifactRefs.map(ref => [ref.artifactId, ref]));
  for (const binding of capsule.sourceBindings) {
    const source = sources.get(binding.sourceId);
    if (!source || sourceIdentity(source) !== `${binding.sourceId}\u001f${binding.revisionId}\u001f${binding.contentSha256 || ''}`) {
      throw new Error(`Context capsule source binding is not current: ${binding.sourceId}`);
    }
  }
  for (const ref of capsule.artifactRefs) {
    if (artifactIdentity(artifacts.get(ref.artifactId)) !== artifactIdentity(ref)) {
      throw new Error(`Context capsule artifact binding is not current: ${ref.artifactId}`);
    }
  }
}

function assertProvenanceMatchesSnapshot(provenance, snapshot) {
  if (provenance.projectId !== snapshot.projectId) throw new Error('Artifact provenance project mismatch');
  const artifacts = new Map(snapshot.artifactRefs.map(ref => [ref.artifactId, ref]));
  if (artifactIdentity(artifacts.get(provenance.artifactRef.artifactId)) !== artifactIdentity(provenance.artifactRef)) {
    throw new Error(`Artifact provenance artifact is not current: ${provenance.artifactRef.artifactId}`);
  }
  const sources = new Map(snapshot.sourceRefs.map(source => [source.sourceId, source]));
  for (const binding of provenance.sourceBindings) {
    const source = sources.get(binding.sourceId);
    if (!source || sourceIdentity(source) !== `${binding.sourceId}\u001f${binding.revisionId}\u001f${binding.contentSha256 || ''}`) {
      throw new Error(`Artifact provenance source binding is not current: ${binding.sourceId}`);
    }
  }
  for (const artifactId of provenance.inputArtifactIds) if (!artifacts.has(artifactId)) throw new Error(`Artifact provenance input artifact is unknown: ${artifactId}`);
}

export function addProjectSnapshot(workspace, snapshot, { nowMs = Date.now() } = {}) {
  validateProjectWorkspace(workspace);
  const normalized = normalizeProjectSnapshotV1(snapshot);
  if (hasOwn(workspace.projectsById, normalized.projectId)) throw new Error('Project already exists');
  if (Object.keys(workspace.projectsById).length >= MAX_PROJECTS) throw new Error('Project workspace project limit exceeded');
  return setOwn(workspace.projectsById, normalized.projectId, createProjectRecord(normalized, { nowMs }));
}

export function replaceProjectSnapshot(workspace, snapshot, { nowMs = Date.now() } = {}) {
  validateProjectWorkspace(workspace);
  const normalized = normalizeProjectSnapshotV1(snapshot);
  const project = requireProject(workspace, normalized.projectId);
  const current = normalizeProjectSnapshotV1(project.snapshot);
  if (normalized.revisionId === current.revisionId) {
    if (!sameCanonicalData(normalized, current)) {
      throw new Error('Project snapshot revisionId cannot be reused for different content');
    }
    return project;
  }
  project.snapshot = normalized;
  project.updatedAt = nowMs;
  // Existing capsules and provenance remain intentionally visible. Their
  // revision bindings make them stale rather than silently re-authorizing them.
  return project;
}

export function putProjectContextCapsule(workspace, capsule, { nowMs = Date.now() } = {}) {
  validateProjectWorkspace(workspace);
  const normalized = normalizeContextCapsuleV1(capsule);
  const project = requireProject(workspace, normalized.projectId);
  assertCapsuleMatchesSnapshot(normalized, project.snapshot);
  if (hasOwn(project.capsulesById, normalized.capsuleId)) {
    const current = normalizeContextCapsuleV1(project.capsulesById[normalized.capsuleId]);
    if (!sameCanonicalData(current, normalized)) {
      throw new Error('Context capsuleId cannot be reused for different content');
    }
    return current;
  }
  if (Object.keys(project.capsulesById).length >= MAX_CAPSULES_PER_PROJECT) throw new Error('Project workspace capsule limit exceeded');
  setOwn(project.capsulesById, normalized.capsuleId, normalized);
  project.updatedAt = nowMs;
  return normalized;
}

export function putProjectArtifactProvenance(workspace, provenance, { nowMs = Date.now() } = {}) {
  validateProjectWorkspace(workspace);
  const normalized = normalizeArtifactProvenanceV1(provenance);
  const project = requireProject(workspace, normalized.projectId);
  assertProvenanceMatchesSnapshot(normalized, project.snapshot);
  const artifactId = normalized.artifactRef.artifactId;
  if (!hasOwn(project.provenanceByArtifactId, artifactId) && Object.keys(project.provenanceByArtifactId).length >= MAX_PROVENANCE_PER_PROJECT) throw new Error('Project workspace provenance limit exceeded');
  setOwn(project.provenanceByArtifactId, artifactId, normalized);
  project.updatedAt = nowMs;
  return normalized;
}

export function getProjectArtifactProvenance(workspace, projectId, artifactId) {
  validateProjectWorkspace(workspace);
  const project = requireProject(workspace, projectId);
  const artifactKey = workspaceId(artifactId, 'artifactId');
  if (!hasOwn(project.provenanceByArtifactId, artifactKey)) {
    throw new Error('Artifact provenance not found');
  }
  const provenance = normalizeArtifactProvenanceV1(project.provenanceByArtifactId[artifactKey]);
  assertProvenanceMatchesSnapshot(provenance, project.snapshot);
  return provenance;
}

export function resolveProjectWorkspaceContextV1(workspace, input = {}) {
  const request = snapshotContextResolutionRequest(input);
  validateProjectWorkspace(workspace);
  const project = requireProject(workspace, request.projectId);
  const snapshot = normalizeProjectSnapshotV1(project.snapshot);
  if (snapshot.revisionId !== request.expectedProjectRevisionId) {
    throw new Error('Project workspace snapshot revision binding mismatch');
  }

  let capsule = null;
  if (request.capsuleId) {
    if (!hasOwn(project.capsulesById, request.capsuleId)) throw new Error('Context capsule not found');
    capsule = normalizeContextCapsuleV1(project.capsulesById[request.capsuleId]);
    assertCapsuleMatchesSnapshot(capsule, snapshot);
  }

  return Object.freeze({
    schemaVersion: PROJECT_WORKSPACE_CONTEXT_RESOLUTION_VERSION,
    workspaceRevision: workspace.revision,
    projectId: snapshot.projectId,
    projectRevisionId: snapshot.revisionId,
    snapshot,
    capsule,
    ownerStateSource: 'DURABLE_PROJECT_WORKSPACE',
    sourceAuthorityAuthenticated: false,
    retrievalAuthorized: false,
    executionAuthorized: false,
    mutationAuthorized: false,
    policyAuthority: false,
  });
}

export function projectCurrentState(workspace, projectId, capsuleId, currentSourceRefs = []) {
  validateProjectWorkspace(workspace);
  const project = requireProject(workspace, projectId);
  const capsuleKey = workspaceId(capsuleId, 'capsuleId');
  if (!hasOwn(project.capsulesById, capsuleKey)) throw new Error('Context capsule not found');
  const capsule = project.capsulesById[capsuleKey];
  // A newer project snapshot deliberately does not erase prior capsules. The
  // core digest rejects cross-revision pairs, so adapt only the comparison
  // envelope and return an explicit stale marker rather than hiding evidence
  // or pretending the old capsule is fresh.
  if (capsule.projectRevisionId !== project.snapshot.revisionId) {
    const comparisonCapsule = { ...capsule, projectRevisionId: project.snapshot.revisionId };
    const state = deriveProjectCurrentStateV1({ snapshot: project.snapshot, capsule: comparisonCapsule, currentSourceRefs });
    return Object.freeze({
      ...state,
      status: 'STALE',
      staleSourceCount: state.staleSourceCount + 1,
      projectRevisionMismatch: true,
      capsuleProjectRevisionId: capsule.projectRevisionId,
    });
  }
  return deriveProjectCurrentStateV1({ snapshot: project.snapshot, capsule, currentSourceRefs });
}

export class ProjectWorkspaceRepository {
  constructor(chromeApi) { this.chrome = chromeApi; this.updateQueue = Promise.resolve(); }

  async load() {
    const record = await this.chrome.storage.local.get(PROJECT_WORKSPACE_STORAGE_KEY);
    const workspace = record[PROJECT_WORKSPACE_STORAGE_KEY] === undefined
      ? createProjectWorkspace()
      : record[PROJECT_WORKSPACE_STORAGE_KEY];
    return validateProjectWorkspace(workspace);
  }

  async save(workspace) {
    validateProjectWorkspace(workspace);
    await this.chrome.storage.local.set({ [PROJECT_WORKSPACE_STORAGE_KEY]: workspace });
    return workspace;
  }

  async resolveContext(input = {}) {
    // Snapshot the caller request before the first await. The durable workspace
    // remains the source of truth; caller mutation cannot swap the requested
    // project/revision/capsule while storage is being read.
    const request = snapshotContextResolutionRequest(input);
    const workspace = await this.load();
    return resolveProjectWorkspaceContextV1(workspace, request);
  }

  update(mutator, { nowMs = Date.now() } = {}) {
    const task = this.updateQueue.then(async () => {
      const current = await this.load();
      const draft = structuredClone(current);
      const next = await mutator(draft) || draft;
      validateProjectWorkspace(next);
      assertSnapshotRevisionContinuity(current, next);
      next.revision = current.revision + 1;
      next.updatedAt = nowMs;
      return this.save(next);
    });
    this.updateQueue = task.catch(() => undefined);
    return task;
  }
}
