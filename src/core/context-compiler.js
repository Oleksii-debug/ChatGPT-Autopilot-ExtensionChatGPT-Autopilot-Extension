import {
  normalizeContextCapsuleV1,
  normalizeProjectSnapshotV1,
} from './project-context-artifact.js';
import { createSha256FingerprintV1 } from './fingerprint.js';

export const ContextCompilerContractVersion = 1;

export const ContextFragmentFreshness = Object.freeze({
  FRESH: 'FRESH',
  STALE_SOURCE: 'STALE_SOURCE',
  STALE_DEPENDENCY: 'STALE_DEPENDENCY',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SUMMARY_SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MAX_FRAGMENTS = 256;
const MAX_BINDINGS = 128;
const MAX_DEPENDENCIES = 64;
const MAX_SUMMARY = 50_000;

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    Object.defineProperty(out, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(out);
}

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field`);
    }
  }
}

function dataArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const length = lengthDescriptor.value;
  const out = new Array(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) {
      throw new Error(`${label} contains a non-index field`);
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || String(index) !== key
        || !descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} entries must be enumerable own data properties`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must be a dense data-only array`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

function exactSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function exactSummarySha256(value, label) {
  if (typeof value !== 'string' || !SUMMARY_SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function text(value, label, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const BINDING_KEYS = new Set(['sourceId', 'revisionId', 'contentSha256', 'authority']);

function normalizeFragmentBinding(input, index) {
  const label = `fragments[].sourceBindings[${index}]`;
  const raw = plain(input, label);
  exactKeys(raw, BINDING_KEYS, label);
  const authority = exactId(raw.authority, `${label}.authority`);
  if (!new Set(['CANONICAL', 'DERIVED', 'ADVISORY']).has(authority)) {
    throw new Error(`${label}.authority is invalid`);
  }
  return deepFreeze({
    sourceId: exactId(raw.sourceId, `${label}.sourceId`),
    revisionId: exactId(raw.revisionId, `${label}.revisionId`),
    contentSha256: exactSha256(raw.contentSha256, `${label}.contentSha256`),
    authority,
  });
}

const FRAGMENT_KEYS = new Set([
  'fragmentId',
  'sourceBindings',
  'dependencyFragmentIds',
  'summary',
  'summarySha256',
  'createdAt',
]);

function normalizeFragment(input, index) {
  const label = `fragments[${index}]`;
  const raw = plain(input, label);
  exactKeys(raw, FRAGMENT_KEYS, label);
  const sourceBindings = dataArray(raw.sourceBindings, `${label}.sourceBindings`, MAX_BINDINGS)
    .map((item, bindingIndex) => normalizeFragmentBinding(item, bindingIndex))
    .sort((a, b) => asciiCompare(a.sourceId, b.sourceId));
  const sourceIds = sourceBindings.map(item => item.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error(`${label}.sourceBindings contains duplicate sourceId`);
  }
  const dependencyFragmentIds = dataArray(
    raw.dependencyFragmentIds,
    `${label}.dependencyFragmentIds`,
    MAX_DEPENDENCIES,
  ).map((item, dependencyIndex) =>
    exactId(item, `${label}.dependencyFragmentIds[${dependencyIndex}]`))
    .sort(asciiCompare);
  if (new Set(dependencyFragmentIds).size !== dependencyFragmentIds.length) {
    throw new Error(`${label}.dependencyFragmentIds contains duplicates`);
  }
  return deepFreeze({
    fragmentId: exactId(raw.fragmentId, `${label}.fragmentId`),
    sourceBindings,
    dependencyFragmentIds,
    summary: text(raw.summary, `${label}.summary`, MAX_SUMMARY),
    summarySha256: exactSummarySha256(raw.summarySha256, `${label}.summarySha256`),
    createdAt: exactTimestamp(raw.createdAt, `${label}.createdAt`),
  });
}

function artifactIdentity(ref) {
  return JSON.stringify([
    ref.schemaVersion,
    ref.artifactId,
    ref.kind,
    ref.uri,
    ref.mediaType,
    ref.sha256,
    ref.sizeBytes,
    ref.createdAt,
    ref.producerInvocationId,
    ref.sensitive,
  ]);
}

function diffById(previous, current, identity) {
  const previousById = new Map(previous.map(item => [identity.id(item), item]));
  const currentById = new Map(current.map(item => [identity.id(item), item]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, item] of currentById) {
    const prior = previousById.get(id);
    if (!prior) added.push(id);
    else if (identity.value(prior) !== identity.value(item)) changed.push(id);
  }
  for (const id of previousById.keys()) {
    if (!currentById.has(id)) removed.push(id);
  }
  added.sort(asciiCompare);
  removed.sort(asciiCompare);
  changed.sort(asciiCompare);
  return { added, removed, changed };
}

function fragmentPlanOrder(fragments) {
  const byId = new Map(fragments.map(fragment => [fragment.fragmentId, fragment]));
  const indegree = new Map(fragments.map(fragment => [fragment.fragmentId, 0]));
  const dependents = new Map(fragments.map(fragment => [fragment.fragmentId, []]));
  for (const fragment of fragments) {
    for (const dependencyId of fragment.dependencyFragmentIds) {
      if (dependencyId === fragment.fragmentId) {
        throw new Error(`fragment ${fragment.fragmentId} cannot depend on itself`);
      }
      if (!byId.has(dependencyId)) {
        throw new Error(`fragment ${fragment.fragmentId} has dangling dependency: ${dependencyId}`);
      }
      indegree.set(fragment.fragmentId, indegree.get(fragment.fragmentId) + 1);
      dependents.get(dependencyId).push(fragment.fragmentId);
    }
  }
  for (const ids of dependents.values()) ids.sort(asciiCompare);
  const ready = [...fragments]
    .filter(fragment => indegree.get(fragment.fragmentId) === 0)
    .map(fragment => fragment.fragmentId)
    .sort(asciiCompare);
  const order = [];
  while (ready.length) {
    const next = ready.shift();
    order.push(next);
    for (const dependentId of dependents.get(next)) {
      const nextDegree = indegree.get(dependentId) - 1;
      indegree.set(dependentId, nextDegree);
      if (nextDegree === 0) {
        ready.push(dependentId);
        ready.sort(asciiCompare);
      }
    }
  }
  if (order.length !== fragments.length) throw new Error('fragment dependency graph contains a cycle');
  return { order, byId };
}

function bindingMatchesSource(binding, source) {
  return source
    && binding.sourceId === source.sourceId
    && binding.revisionId === source.revisionId
    && binding.contentSha256 === source.contentSha256
    && binding.authority === source.authority;
}

function canonicalFragmentFingerprintInput(fragment) {
  return JSON.stringify([
    'chatgpt-autopilot-context-fragment-v1',
    fragment.fragmentId,
    fragment.sourceBindings.map(binding => [
      binding.sourceId,
      binding.revisionId,
      binding.contentSha256,
      binding.authority,
    ]),
    fragment.dependencyFragmentIds,
    fragment.summarySha256,
    fragment.createdAt,
  ]);
}

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'compilerId',
  'projectSnapshot',
  'priorCapsule',
  'fragments',
  'compiledAt',
]);

export async function compileDeltaContextPlanV1(input) {
  const raw = plain(input, 'ContextCompilerRequestV1');
  exactKeys(raw, REQUEST_KEYS, 'ContextCompilerRequestV1');
  if (raw.schemaVersion !== ContextCompilerContractVersion) {
    throw new Error('Unsupported ContextCompilerRequestV1 schemaVersion');
  }
  const compilerId = exactId(raw.compilerId, 'compilerId');
  const projectSnapshot = normalizeProjectSnapshotV1(raw.projectSnapshot);
  const priorCapsule = raw.priorCapsule == null ? null : normalizeContextCapsuleV1(raw.priorCapsule);
  const fragments = dataArray(raw.fragments, 'fragments', MAX_FRAGMENTS)
    .map((fragment, index) => normalizeFragment(fragment, index))
    .sort((a, b) => asciiCompare(a.fragmentId, b.fragmentId));
  const fragmentIds = fragments.map(fragment => fragment.fragmentId);
  if (new Set(fragmentIds).size !== fragmentIds.length) throw new Error('fragments contains duplicate fragmentId');
  const compiledAt = exactTimestamp(raw.compiledAt, 'compiledAt');
  const compiledMs = Date.parse(compiledAt);
  if (Date.parse(projectSnapshot.createdAt) > compiledMs) {
    throw new Error('projectSnapshot is from the future of compilation');
  }
  if (priorCapsule) {
    if (priorCapsule.projectId !== projectSnapshot.projectId) {
      throw new Error('priorCapsule projectId mismatch');
    }
    if (Date.parse(priorCapsule.createdAt) > compiledMs) {
      throw new Error('priorCapsule is from the future of compilation');
    }
  }
  for (const fragment of fragments) {
    if (Date.parse(fragment.createdAt) > compiledMs) {
      throw new Error(`fragment ${fragment.fragmentId} is from the future of compilation`);
    }
    const actualSummarySha = await createSha256FingerprintV1(fragment.summary);
    if (actualSummarySha !== fragment.summarySha256) {
      throw new Error(`fragment ${fragment.fragmentId} summary hash mismatch`);
    }
  }

  const sourceById = new Map(projectSnapshot.sourceRefs.map(source => [source.sourceId, source]));
  const { order, byId } = fragmentPlanOrder(fragments);
  const statusById = new Map();
  const resultById = new Map();

  for (const fragmentId of order) {
    const fragment = byId.get(fragmentId);
    const staleSourceIds = [];
    for (const binding of fragment.sourceBindings) {
      const source = sourceById.get(binding.sourceId);
      if (!bindingMatchesSource(binding, source)) {
        staleSourceIds.push(binding.sourceId);
        continue;
      }
      if (Date.parse(fragment.createdAt) < Date.parse(source.observedAt)) {
        staleSourceIds.push(binding.sourceId);
      }
    }
    staleSourceIds.sort(asciiCompare);
    const staleDependencyFragmentIds = fragment.dependencyFragmentIds
      .filter(dependencyId => statusById.get(dependencyId) !== ContextFragmentFreshness.FRESH)
      .sort(asciiCompare);
    const freshness = staleSourceIds.length
      ? ContextFragmentFreshness.STALE_SOURCE
      : staleDependencyFragmentIds.length
        ? ContextFragmentFreshness.STALE_DEPENDENCY
        : ContextFragmentFreshness.FRESH;
    statusById.set(fragmentId, freshness);
    if (freshness === ContextFragmentFreshness.FRESH) {
      const fragmentFingerprint = await createSha256FingerprintV1(
        canonicalFragmentFingerprintInput(fragment),
      );
      resultById.set(fragmentId, deepFreeze({
        fragmentId,
        freshness,
        sourceBindings: fragment.sourceBindings.map(binding => ({ ...binding })),
        dependencyFragmentIds: [...fragment.dependencyFragmentIds],
        summary: fragment.summary,
        summarySha256: fragment.summarySha256,
        fragmentFingerprint,
        createdAt: fragment.createdAt,
        retrievalPointers: fragment.sourceBindings.map(binding => deepFreeze({
          sourceId: binding.sourceId,
          revisionId: binding.revisionId,
          requiresCanonicalResolution: true,
        })),
        contextReuseEligible: true,
      }));
    } else {
      resultById.set(fragmentId, deepFreeze({
        fragmentId,
        freshness,
        staleSourceIds,
        staleDependencyFragmentIds,
        contextReuseEligible: false,
      }));
    }
  }

  const priorSources = priorCapsule?.sourceBindings ?? [];
  const sourceDelta = diffById(priorSources, projectSnapshot.sourceRefs, {
    id: item => item.sourceId,
    value: item => JSON.stringify([item.revisionId, item.contentSha256]),
  });
  const priorArtifacts = priorCapsule?.artifactRefs ?? [];
  const artifactDelta = diffById(priorArtifacts, projectSnapshot.artifactRefs, {
    id: item => item.artifactId,
    value: artifactIdentity,
  });
  const reusableFragments = fragments
    .filter(fragment => statusById.get(fragment.fragmentId) === ContextFragmentFreshness.FRESH)
    .map(fragment => resultById.get(fragment.fragmentId));
  const staleFragments = fragments
    .filter(fragment => statusById.get(fragment.fragmentId) !== ContextFragmentFreshness.FRESH)
    .map(fragment => resultById.get(fragment.fragmentId));
  const refreshSourceIds = [...new Set([
    ...sourceDelta.added,
    ...sourceDelta.changed,
    ...staleFragments.flatMap(fragment => fragment.staleSourceIds),
  ])].filter(sourceId => sourceById.has(sourceId)).sort(asciiCompare);

  return deepFreeze({
    schemaVersion: ContextCompilerContractVersion,
    compilerId,
    projectId: projectSnapshot.projectId,
    baseCapsuleId: priorCapsule?.capsuleId ?? '',
    baseProjectRevisionId: priorCapsule?.projectRevisionId ?? '',
    targetProjectRevisionId: projectSnapshot.revisionId,
    compiledAt,
    delta: {
      addedSourceIds: sourceDelta.added,
      changedSourceIds: sourceDelta.changed,
      removedSourceIds: sourceDelta.removed,
      addedArtifactIds: artifactDelta.added,
      changedArtifactIds: artifactDelta.changed,
      removedArtifactIds: artifactDelta.removed,
      refreshSourceIds,
    },
    reusableFragments,
    staleFragments,
    metrics: {
      fragmentCount: fragments.length,
      reusableFragmentCount: reusableFragments.length,
      staleFragmentCount: staleFragments.length,
      reusedSummaryCharacters: reusableFragments.reduce((total, fragment) => total + fragment.summary.length, 0),
    },
    advisoryOnly: true,
    sourceTrust: 'CALLER_BOUND_NOT_AUTHENTICATED',
    requiresCanonicalSourceResolution: true,
    executionAuthorized: false,
    mutationAuthorized: false,
  });
}
