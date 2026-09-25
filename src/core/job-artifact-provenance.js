import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';
import { normalizeExactEffectStateV1 } from './universal-agent-exact-effect.js';
import { getProjectArtifactProvenance } from './project-workspace.js';

export const JOB_ARTIFACT_PROVENANCE_SCHEMA_VERSION = 1;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const RESOLVE_KEYS = new Set(['jobId', 'artifactId']);
const BINDING_KEYS = new Set(['schemaVersion', 'jobId', 'projectId', 'planId']);

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
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function time(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return ms;
}

function normalizeJobBindingV1(value) {
  const raw = dataRecord(value, BINDING_KEYS, 'Browser Agent job/Project binding');
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

function canonical(value) {
  return JSON.stringify(value);
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function composeJobArtifactProvenanceV1({ binding, workspace, effectState, artifactId }) {
  const provenance = getProjectArtifactProvenance(workspace, binding.projectId, artifactId);
  const effect = normalizeExactEffectStateV1(effectState);
  const observation = effect.observation;
  if (!observation) throw new Error('Artifact provenance requires an ExactEffect observation');

  const artifact = provenance.artifactRef;
  if (artifact.artifactId !== artifactId) throw new Error('Project provenance artifactId mismatch');
  if (!artifact.producerInvocationId) throw new Error('Artifact provenance lacks producerInvocationId');
  if (artifact.producerInvocationId !== effect.invocation.invocationId) {
    throw new Error('Artifact producerInvocationId does not match ExactEffect invocation');
  }

  const observedMatches = observation.artifactRefs.filter(item => item.artifactId === artifactId);
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

/**
 * Authority-bound read-only resolver.
 *
 * The caller supplies only lookup identity (jobId + artifactId). Durable
 * job/project/plan identity, current Project provenance, and ExactEffect state
 * are loaded from injected canonical authorities. No caller-owned binding,
 * workspace snapshot, or effect state can be substituted through resolve().
 *
 * loadExactEffect must be a side-effect-free adapter over the canonical durable
 * exact-effect authority for the producer invocation. The resolver performs a
 * before/after read fence across all three authorities and fails closed if
 * identity, provenance, or exact-effect state changes during resolution.
 *
 * This resolver proves provenance only. It never grants execution,
 * verification, disclosure, distribution, or retry authority.
 */
export class JobArtifactProvenanceResolverV1 {
  constructor({ browserAgentManager, projectWorkspaceRepository, loadExactEffect } = {}) {
    if (typeof browserAgentManager?.resolveJobProjectBinding !== 'function') {
      throw new Error('Canonical Browser Agent job/Project resolver is required');
    }
    if (typeof projectWorkspaceRepository?.load !== 'function') {
      throw new Error('Canonical Project workspace repository is required');
    }
    if (typeof loadExactEffect !== 'function') {
      throw new Error('Canonical exact-effect loader is required');
    }
    this.browserAgentManager = browserAgentManager;
    this.projectWorkspaceRepository = projectWorkspaceRepository;
    this.loadExactEffect = loadExactEffect;
  }

  async resolve(input = {}) {
    const request = dataRecord(input, RESOLVE_KEYS, 'JobArtifactProvenance resolve request');
    const jobId = id(request.jobId, 'jobId');
    const artifactId = id(request.artifactId, 'artifactId');

    const bindingBefore = normalizeJobBindingV1(
      await this.browserAgentManager.resolveJobProjectBinding(jobId),
    );
    if (bindingBefore.jobId !== jobId) {
      throw new Error('Canonical Browser Agent binding jobId mismatch');
    }

    const workspaceBefore = await this.projectWorkspaceRepository.load();
    const provenanceBefore = getProjectArtifactProvenance(
      workspaceBefore,
      bindingBefore.projectId,
      artifactId,
    );
    const producerInvocationId = provenanceBefore.artifactRef.producerInvocationId;
    if (!producerInvocationId) throw new Error('Artifact provenance lacks producerInvocationId');

    const effectBeforeRaw = await this.loadExactEffect(producerInvocationId);
    if (!effectBeforeRaw) throw new Error('Canonical exact-effect state was not found');
    const effectBefore = normalizeExactEffectStateV1(effectBeforeRaw);

    const bindingAfter = normalizeJobBindingV1(
      await this.browserAgentManager.resolveJobProjectBinding(jobId),
    );
    const workspaceAfter = await this.projectWorkspaceRepository.load();
    const provenanceAfter = getProjectArtifactProvenance(
      workspaceAfter,
      bindingAfter.projectId,
      artifactId,
    );
    const effectAfterRaw = await this.loadExactEffect(producerInvocationId);
    if (!effectAfterRaw) throw new Error('Canonical exact-effect state was not found');
    const effectAfter = normalizeExactEffectStateV1(effectAfterRaw);

    if (canonical(bindingBefore) !== canonical(bindingAfter)) {
      throw new Error('Browser Agent job/Project binding changed during provenance resolution');
    }
    if (canonical(provenanceBefore) !== canonical(provenanceAfter)) {
      throw new Error('Project artifact provenance changed during provenance resolution');
    }
    if (canonical(effectBefore) !== canonical(effectAfter)) {
      throw new Error('Exact-effect state changed during provenance resolution');
    }

    return composeJobArtifactProvenanceV1({
      binding: bindingAfter,
      workspace: workspaceAfter,
      effectState: effectAfter,
      artifactId,
    });
  }
}
