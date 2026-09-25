import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';
import { normalizeExactEffectStateV1 } from './universal-agent-exact-effect.js';
import { getProjectArtifactProvenance } from './project-workspace.js';

export const JOB_ARTIFACT_PROVENANCE_SCHEMA_VERSION = 1;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function dataRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(snapshot);
}

function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function time(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return ms;
}

function normalizeJobBindingV1(value) {
  const raw = dataRecord(
    value,
    new Set(['schemaVersion', 'jobId', 'projectId', 'planId']),
    'Browser Agent job/Project binding',
  );
  if (raw.schemaVersion !== 1) throw new Error('Unsupported Browser Agent job/Project binding schemaVersion');
  return Object.freeze({
    schemaVersion: 1,
    jobId: id(raw.jobId, 'jobId'),
    projectId: id(raw.projectId, 'projectId'),
    planId: id(raw.planId, 'planId'),
  });
}

function artifactIdentity(value) {
  return JSON.stringify(normalizeArtifactRefV1(value));
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

/**
 * Read-only evidence composition. jobBinding must come from the canonical
 * BrowserAgentManager.resolveJobProjectBinding() runtime authority; this
 * function never accepts a separate caller-owned jobId/projectId/planId.
 *
 * It does not authorize execution or verification. It only proves that the
 * current Project provenance record and one canonical ExactEffect observation
 * name the exact same produced artifact and producer invocation.
 */
export function resolveJobArtifactProvenanceV1(input) {
  const raw = dataRecord(
    input,
    new Set(['jobBinding', 'workspace', 'exactEffectState', 'artifactId']),
    'JobArtifactProvenance request',
  );
  const binding = normalizeJobBindingV1(raw.jobBinding);
  const artifactId = id(raw.artifactId, 'artifactId');

  const provenance = getProjectArtifactProvenance(raw.workspace, binding.projectId, artifactId);
  const effect = normalizeExactEffectStateV1(raw.exactEffectState);
  const observation = effect.observation;
  if (!observation) throw new Error('Artifact provenance requires an ExactEffect observation');

  const artifact = provenance.artifactRef;
  if (artifact.artifactId !== artifactId) throw new Error('Project provenance artifactId mismatch');
  if (!artifact.producerInvocationId) throw new Error('Artifact provenance lacks producerInvocationId');
  if (artifact.producerInvocationId !== effect.invocation.invocationId) {
    throw new Error('Artifact producerInvocationId does not match ExactEffect invocation');
  }

  const observedMatches = observation.artifactRefs
    .filter(item => item.artifactId === artifactId);
  if (observedMatches.length !== 1) {
    throw new Error('ExactEffect observation must contain exactly one matching artifact');
  }
  if (artifactIdentity(observedMatches[0]) !== artifactIdentity(artifact)) {
    throw new Error('ExactEffect observation artifact does not match Project provenance');
  }

  const invocationAt = time(effect.invocation.createdAt, 'invocation createdAt');
  const artifactAt = time(artifact.createdAt, 'artifact createdAt');
  const observedAt = time(observation.observedAt, 'observation observedAt');
  const provenanceAt = time(provenance.createdAt, 'provenance createdAt');
  if (artifactAt < invocationAt) throw new Error('Artifact predates its producer invocation');
  if (observedAt < artifactAt) throw new Error('Observation predates the produced artifact');
  if (provenanceAt < artifactAt) throw new Error('Project provenance predates the produced artifact');

  return frozen({
    schemaVersion: JOB_ARTIFACT_PROVENANCE_SCHEMA_VERSION,
    jobId: binding.jobId,
    planId: binding.planId,
    projectId: binding.projectId,
    artifactRef: artifact,
    sourceBindings: provenance.sourceBindings,
    inputArtifactIds: provenance.inputArtifactIds,
    provenanceCreatedAt: provenance.createdAt,
    producer: {
      effectId: effect.effectId,
      invocationId: effect.invocation.invocationId,
      executionId: effect.executionId,
      attempt: effect.attempt,
      phase: effect.phase,
      observationId: observation.observationId,
      observationStatus: observation.status,
      observedAt: observation.observedAt,
    },
  });
}
