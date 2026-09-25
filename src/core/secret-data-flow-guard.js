import { normalizeArtifactRegistryV1 } from './artifact-registry.js';

export const SECRET_DATA_FLOW_GUARD_VERSION = 1;

export const SecretDataFlowStatus = Object.freeze({
  READY_FOR_POLICY: 'READY_FOR_POLICY',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  BLOCKED: 'BLOCKED',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INDEX = /^(0|[1-9][0-9]*)$/u;

const MAX_BINDINGS = 128;
const MAX_EGRESSES = 128;

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'flowId',
  'agentId',
  'jobId',
  'projectId',
  'registryRevision',
  'artifactBindings',
  'egresses',
  'assessedAt',
]);

const OPTIONS_KEYS = new Set(['artifactRegistry']);
const BINDING_KEYS = new Set(['artifactId', 'versionId', 'sha256']);
const EGRESS_KEYS = new Set([
  'egressId',
  'artifactId',
  'destinationOrigin',
  'requestedAt',
]);

function strictRecord(value, label, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }

  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new Error(`${label} must be a plain object`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }

  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(`${label} must expose stable data descriptors`);
  }

  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable own data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function strictArray(value, label, { max } = {}) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a bounded plain array`);
  }

  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new Error(`${label} must be a bounded plain array`);
  }
  if (prototype !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }

  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(`${label} must expose stable data descriptors`);
  }

  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || (Number.isSafeInteger(max) && lengthDescriptor.value > max)) {
    throw new Error(`${label} must be a bounded plain array`);
  }

  const length = lengthDescriptor.value;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !INDEX.test(key)) {
      throw new Error(`${label} contains an invalid array property`);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
      throw new Error(`${label} contains an invalid array index`);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
  }

  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must not be sparse`);
    }
    output.push(descriptor.value);
  }
  return output;
}

function exactVersion(value, label) {
  if (value !== SECRET_DATA_FLOW_GUARD_VERSION) {
    throw new Error(`Unsupported ${label} schemaVersion`);
  }
  return value;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function exactInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) {
    throw new Error(`${label} must be a safe integer`);
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  const canonical = new Date(millis).toISOString();
  if (value !== canonical) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return canonical;
}

function canonicalOrigin(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical HTTP(S) origin`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a canonical HTTP(S) origin`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || value !== parsed.origin) {
    throw new Error(`${label} must be a canonical HTTP(S) origin`);
  }
  return parsed.origin;
}

function compareAscii(left, right) {
  return left < right ? -1 : (left > right ? 1 : 0);
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function normalizeBinding(value, index) {
  const label = `SecretDataFlowV1.artifactBindings[${index}]`;
  const raw = strictRecord(value, label, BINDING_KEYS);
  return freezeDeep({
    artifactId: exactId(raw.artifactId, `${label}.artifactId`),
    versionId: exactId(raw.versionId, `${label}.versionId`),
    sha256: exactSha256(raw.sha256, `${label}.sha256`),
  });
}

function normalizeEgress(value, index) {
  const label = `SecretDataFlowV1.egresses[${index}]`;
  const raw = strictRecord(value, label, EGRESS_KEYS);
  return freezeDeep({
    egressId: exactId(raw.egressId, `${label}.egressId`),
    artifactId: exactId(raw.artifactId, `${label}.artifactId`),
    destinationOrigin: canonicalOrigin(raw.destinationOrigin, `${label}.destinationOrigin`),
    requestedAt: exactTimestamp(raw.requestedAt, `${label}.requestedAt`),
  });
}

function normalizeRequest(value) {
  const raw = strictRecord(value, 'SecretDataFlowV1', REQUEST_KEYS);
  exactVersion(raw.schemaVersion, 'SecretDataFlowV1');

  const artifactBindings = strictArray(
    raw.artifactBindings,
    'SecretDataFlowV1.artifactBindings',
    { max: MAX_BINDINGS },
  ).map(normalizeBinding);
  if (artifactBindings.length === 0) {
    throw new Error('SecretDataFlowV1.artifactBindings must not be empty');
  }

  const artifactIds = artifactBindings.map(item => item.artifactId);
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new Error('SecretDataFlowV1.artifactBindings contains duplicate artifactId');
  }

  const versionIds = artifactBindings.map(item => item.versionId);
  if (new Set(versionIds).size !== versionIds.length) {
    throw new Error('SecretDataFlowV1.artifactBindings contains duplicate versionId');
  }

  const egresses = strictArray(
    raw.egresses,
    'SecretDataFlowV1.egresses',
    { max: MAX_EGRESSES },
  ).map(normalizeEgress);
  const egressIds = egresses.map(item => item.egressId);
  if (new Set(egressIds).size !== egressIds.length) {
    throw new Error('SecretDataFlowV1.egresses contains duplicate egressId');
  }

  return freezeDeep({
    schemaVersion: SECRET_DATA_FLOW_GUARD_VERSION,
    flowId: exactId(raw.flowId, 'SecretDataFlowV1.flowId'),
    agentId: exactId(raw.agentId, 'SecretDataFlowV1.agentId'),
    jobId: exactId(raw.jobId, 'SecretDataFlowV1.jobId'),
    projectId: exactId(raw.projectId, 'SecretDataFlowV1.projectId'),
    registryRevision: exactInteger(raw.registryRevision, 'SecretDataFlowV1.registryRevision'),
    artifactBindings,
    egresses,
    assessedAt: exactTimestamp(raw.assessedAt, 'SecretDataFlowV1.assessedAt'),
  });
}

function indexRegistry(registry) {
  const entries = new Map();
  const versions = new Map();

  for (const entry of registry.artifacts) {
    entries.set(entry.artifactId, entry);
    for (const version of entry.versions) {
      versions.set(version.versionId, version);
    }
  }

  return { entries, versions };
}

function versionTime(version) {
  return Date.parse(version.registeredAt);
}

function provenanceTime(version) {
  return Date.parse(version.provenance.createdAt);
}

function violation(code, artifactId, versionId) {
  return freezeDeep({ code, artifactId, versionId });
}

function createLineageEvaluator(registryIndex, assessedAt) {
  const assessedAtMs = Date.parse(assessedAt);
  const lineageMemo = new Map();
  const familyMemo = new Map();
  const activeVersions = new Set();
  const violations = new Map();

  function addViolation(code, version) {
    const key = `${code}:${version.artifactRef.artifactId}:${version.versionId}`;
    if (!violations.has(key)) {
      violations.set(
        key,
        violation(code, version.artifactRef.artifactId, version.versionId),
      );
    }
  }

  function candidateVersions(artifactId, cutoffMs) {
    const entry = registryIndex.entries.get(artifactId);
    if (!entry) {
      throw new Error(`Canonical artifact lineage references unknown artifact: ${artifactId}`);
    }

    const candidates = entry.versions.filter(version => versionTime(version) <= cutoffMs);
    if (candidates.length === 0) {
      throw new Error(
        `Canonical artifact lineage has no admitted version before dependency use: ${artifactId}`,
      );
    }
    return candidates;
  }

  function familySensitivityAt(artifactId, cutoffMs) {
    const key = `${artifactId}@${cutoffMs}`;
    if (familyMemo.has(key)) return familyMemo.get(key);

    const candidates = candidateVersions(artifactId, cutoffMs);
    let priorTainted = false;
    let effectiveSensitive = false;

    for (const version of candidates) {
      const lineage = evaluateVersionLineage(version);
      if (priorTainted && version.artifactRef.sensitive !== true) {
        addViolation('SENSITIVE_VERSION_DOWNGRADE', version);
      }
      if (lineage.effectiveSensitive) {
        priorTainted = true;
        effectiveSensitive = true;
      }
    }

    familyMemo.set(key, effectiveSensitive);
    return effectiveSensitive;
  }

  function evaluateVersionLineage(version) {
    if (lineageMemo.has(version.versionId)) return lineageMemo.get(version.versionId);
    if (activeVersions.has(version.versionId)) {
      throw new Error(
        `Canonical artifact provenance contains a cycle at version: ${version.versionId}`,
      );
    }
    if (versionTime(version) > assessedAtMs) {
      throw new Error(
        `Canonical artifact version postdates assessment: ${version.versionId}`,
      );
    }

    activeVersions.add(version.versionId);
    let inheritedSensitive = false;

    for (const inputArtifactId of version.provenance.inputArtifactIds) {
      const inputSensitive = familySensitivityAt(
        inputArtifactId,
        provenanceTime(version),
      );
      inheritedSensitive = inheritedSensitive || inputSensitive;
    }

    const effectiveSensitive = version.artifactRef.sensitive === true || inheritedSensitive;
    if (inheritedSensitive && version.artifactRef.sensitive !== true) {
      addViolation('SENSITIVE_DERIVATION_LAUNDERING', version);
    }

    activeVersions.delete(version.versionId);
    const result = freezeDeep({
      effectiveSensitive,
      inheritedSensitive,
    });
    lineageMemo.set(version.versionId, result);
    return result;
  }

  function effectiveBindingSensitivity(version) {
    return familySensitivityAt(
      version.artifactRef.artifactId,
      versionTime(version),
    );
  }

  return {
    evaluateVersionLineage,
    effectiveBindingSensitivity,
    violations: () => [...violations.values()].sort((left, right) =>
      compareAscii(left.artifactId, right.artifactId)
        || compareAscii(left.versionId, right.versionId)
        || compareAscii(left.code, right.code)),
  };
}

function resolveBindings(request, registry, registryIndex, evaluator) {
  if (registry.projectId !== request.projectId) {
    throw new Error('SecretDataFlowV1 projectId does not match canonical ArtifactRegistryV1');
  }
  if (registry.revision !== request.registryRevision) {
    throw new Error('SecretDataFlowV1 registryRevision is stale or mismatched');
  }

  const resolved = new Map();
  for (const binding of request.artifactBindings) {
    const version = registryIndex.versions.get(binding.versionId);
    if (!version) {
      throw new Error(`Canonical artifact version is unavailable: ${binding.versionId}`);
    }
    if (version.projectId !== request.projectId
        || version.artifactRef.artifactId !== binding.artifactId) {
      throw new Error(`Canonical artifact version identity mismatch: ${binding.versionId}`);
    }
    if (version.artifactRef.sha256 !== binding.sha256) {
      throw new Error(`Canonical artifact version digest mismatch: ${binding.versionId}`);
    }
    if (Date.parse(version.registeredAt) > Date.parse(request.assessedAt)) {
      throw new Error(`Canonical artifact version postdates assessment: ${binding.versionId}`);
    }

    evaluator.evaluateVersionLineage(version);
    resolved.set(binding.artifactId, version);
  }
  return resolved;
}

function validateEgresses(request, resolvedBindings) {
  for (const egress of request.egresses) {
    const version = resolvedBindings.get(egress.artifactId);
    if (!version) {
      throw new Error(`Egress ${egress.egressId} references an unbound artifact`);
    }
    if (Date.parse(egress.requestedAt) < Date.parse(version.registeredAt)) {
      throw new Error(`Egress ${egress.egressId} predates canonical artifact admission`);
    }
    if (egress.requestedAt > request.assessedAt) {
      throw new Error(`Egress ${egress.egressId} postdates assessment`);
    }
  }
}

/**
 * Pure, non-authorizing secret data-flow assessment over the canonical
 * ArtifactRegistryV1 snapshot supplied by trusted integration code.
 *
 * Artifact provenance, rather than caller-declared transform edges, determines
 * ancestry. ArtifactProvenanceV1 currently binds input artifact identities but
 * not exact input version IDs. To avoid under-tainting, every canonically
 * admitted input version that could have existed before the dependent
 * provenance timestamp is treated as plausible. Any sensitive/tainted plausible
 * version taints the dependency. Once an artifact family is tainted, a later
 * version cannot clear sensitivity without a separate declassification
 * authority; this guard has no such authority.
 */
export function assessSecretDataFlowV1(value, optionsInput = {}) {
  const request = normalizeRequest(value);
  const options = strictRecord(
    optionsInput,
    'Secret data-flow trusted options',
    OPTIONS_KEYS,
  );
  if (!options.artifactRegistry) {
    throw new Error('Secret data-flow assessment requires canonical artifactRegistry');
  }

  const registry = normalizeArtifactRegistryV1(options.artifactRegistry);
  const registryIndex = indexRegistry(registry);
  const evaluator = createLineageEvaluator(
    registryIndex,
    request.assessedAt,
  );
  const resolvedBindings = resolveBindings(
    request,
    registry,
    registryIndex,
    evaluator,
  );
  validateEgresses(request, resolvedBindings);

  const artifactStates = request.artifactBindings
    .map(binding => {
      const version = resolvedBindings.get(binding.artifactId);
      const lineage = evaluator.evaluateVersionLineage(version);
      const effectiveSensitive = evaluator.effectiveBindingSensitivity(version);
      return freezeDeep({
        artifactId: binding.artifactId,
        versionId: binding.versionId,
        sha256: binding.sha256,
        declaredSensitive: version.artifactRef.sensitive,
        inheritedSensitive: lineage.inheritedSensitive,
        effectiveSensitive,
        derived: version.provenance.inputArtifactIds.length > 0,
        registeredAt: version.registeredAt,
      });
    })
    .sort((left, right) =>
      compareAscii(left.artifactId, right.artifactId)
        || compareAscii(left.versionId, right.versionId));

  const sensitivityByArtifact = new Map(
    artifactStates.map(item => [item.artifactId, item.effectiveSensitive]),
  );

  const egresses = request.egresses
    .map(egress => {
      const effectiveSensitive = sensitivityByArtifact.get(egress.artifactId) === true;
      return freezeDeep({
        egressId: egress.egressId,
        artifactId: egress.artifactId,
        versionId: resolvedBindings.get(egress.artifactId).versionId,
        destinationOrigin: egress.destinationOrigin,
        requestedAt: egress.requestedAt,
        effectiveSensitive,
        policyDecisionRequired: true,
        independentSecretReviewRequired: effectiveSensitive,
        executionAuthorized: false,
        credentialUseAuthorized: false,
      });
    })
    .sort((left, right) => compareAscii(left.egressId, right.egressId));

  const violations = evaluator.violations();
  const sensitiveEgress = egresses.some(item => item.effectiveSensitive);
  const status = violations.length
    ? SecretDataFlowStatus.BLOCKED
    : (sensitiveEgress
      ? SecretDataFlowStatus.REVIEW_REQUIRED
      : SecretDataFlowStatus.READY_FOR_POLICY);

  return freezeDeep({
    schemaVersion: SECRET_DATA_FLOW_GUARD_VERSION,
    flowId: request.flowId,
    agentId: request.agentId,
    jobId: request.jobId,
    projectId: request.projectId,
    registryRevision: request.registryRevision,
    status,
    artifactStates,
    egresses,
    violations,
    lineageProvenance: 'CANONICAL_ARTIFACT_REGISTRY',
    lineageCompletenessVerified: false,
    requiresCanonicalLineageResolution: true,
    exactInputVersionBindingVerified: false,
    inputVersionResolution: 'CONSERVATIVE_ALL_PLAUSIBLE_VERSIONS',
    requiresExactInputVersionBindingUpgrade: true,
    requiresCanonicalPolicyDecision: request.egresses.length > 0,
    requiresIndependentSecretScan: request.egresses.length > 0,
    declassificationAuthorized: false,
    credentialUseAuthorized: false,
    executionAuthorized: false,
    assessedAt: request.assessedAt,
  });
}
