import { validateProjectWorkspace } from './project-workspace.js';

export const PROJECT_WORKSPACE_RUNTIME_SCHEMA_VERSION = 1;

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function ownCount(value) {
  return Object.keys(value).length;
}

function summarizeProject(project) {
  const snapshot = project.snapshot;
  const capsules = Object.values(project.capsulesById);
  const provenanceByArtifactId = project.provenanceByArtifactId;
  const staleRevisionCapsuleCount = capsules.filter(
    capsule => capsule.projectRevisionId !== snapshot.revisionId,
  ).length;
  const artifactCount = snapshot.artifactRefs.length;
  const provenanceCount = ownCount(provenanceByArtifactId);

  return deepFreeze({
    projectId: snapshot.projectId,
    projectRevisionId: snapshot.revisionId,
    sourceCount: snapshot.sourceRefs.length,
    artifactCount,
    sensitiveArtifactCount: snapshot.artifactRefs.filter(artifact => artifact.sensitive).length,
    capsuleCount: capsules.length,
    currentRevisionCapsuleCount: capsules.length - staleRevisionCapsuleCount,
    staleRevisionCapsuleCount,
    provenanceCount,
    unprovenancedArtifactCount: snapshot.artifactRefs.filter(
      artifact => !Object.prototype.hasOwnProperty.call(provenanceByArtifactId, artifact.artifactId),
    ).length,
    capsuleRevisionStatus: capsules.length === 0
      ? 'NONE'
      : staleRevisionCapsuleCount > 0
        ? 'HAS_STALE'
        : 'CURRENT',
  });
}

export function projectProjectWorkspaceSummaryV1(workspace) {
  const validated = validateProjectWorkspace(workspace);
  const projects = Object.values(validated.projectsById)
    .map(summarizeProject)
    .sort((left, right) => asciiCompare(left.projectId, right.projectId));

  const total = field => projects.reduce((sum, project) => sum + project[field], 0);

  return deepFreeze({
    schemaVersion: PROJECT_WORKSPACE_RUNTIME_SCHEMA_VERSION,
    workspaceRevision: validated.revision,
    projectCount: projects.length,
    projects,
    summary: {
      sourceCount: total('sourceCount'),
      artifactCount: total('artifactCount'),
      sensitiveArtifactCount: total('sensitiveArtifactCount'),
      capsuleCount: total('capsuleCount'),
      currentRevisionCapsuleCount: total('currentRevisionCapsuleCount'),
      staleRevisionCapsuleCount: total('staleRevisionCapsuleCount'),
      provenanceCount: total('provenanceCount'),
      unprovenancedArtifactCount: total('unprovenancedArtifactCount'),
    },
    readOnly: true,
    workspaceAdmissionAuthorized: false,
    mutationAuthorized: false,
    sourceContentExposed: false,
    sourceLocationsExposed: false,
    artifactLocationsExposed: false,
    credentialsExposed: false,
  });
}

export class ProjectWorkspaceRuntimeReader {
  constructor(repository) {
    if (!repository || typeof repository.load !== 'function') {
      throw new Error('ProjectWorkspaceRuntimeReader requires the canonical ProjectWorkspace repository');
    }
    this.repository = repository;
    Object.freeze(this);
  }

  async readSummary() {
    return projectProjectWorkspaceSummaryV1(await this.repository.load());
  }
}
