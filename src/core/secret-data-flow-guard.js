import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const SECRET_DATA_FLOW_GUARD_VERSION = 1;

export const SecretDataFlowStatus = Object.freeze({
  READY_FOR_POLICY: 'READY_FOR_POLICY',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  BLOCKED: 'BLOCKED',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INDEX = /^(0|[1-9][0-9]*)$/u;

const MAX_ARTIFACTS = 128;
const MAX_TRANSFORMS = 256;
const MAX_EGRESSES = 128;
const MAX_INPUTS = 128;

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'flowId',
  'agentId',
  'jobId',
  'artifactBindings',
  'transforms',
  'egresses',
  'assessedAt',
]);

const ARTIFACT_BINDING_KEYS = new Set(['artifactId', 'sha256']);
const TRANSFORM_KEYS = new Set([
  'transformId',
  'inputArtifactIds',
  'outputArtifactId',
  'completedAt',
]);
const EGRESS_KEYS = new Set([
  'egressId',
  'artifactId',
  'destinationOrigin',
  'requestedAt',
]);

const ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactId',
  'kind',
  'uri',
  'mediaType',
  'sha256',
  'sizeBytes',
  'createdAt',
  'producerInvocationId',
  'sensitive',
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

function exactText(value, label, { optional = false, max = 4096 } = {}) {
  if (optional && (value === '' || value == null)) {
    if (value == null) {
      throw new Error(`${label} must use canonical empty-string representation`);
    }
    return '';
  }
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactOptionalId(value, label) {
  if (value === null) return null;
  return exactId(value, label);
}

function exactBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function exactInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) {
    throw new Error(`${label} must be a safe integer`);
  }
  return value;
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

function compareAscii(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function normalizeBinding(value, index) {
  const raw = strictRecord(
    value,
    `SecretDataFlowV1.artifactBindings[${index}]`,
    ARTIFACT_BINDING_KEYS,
  );
  return freezeDeep({
    artifactId: exactId(
      raw.artifactId,
      `SecretDataFlowV1.artifactBindings[${index}].artifactId`,
    ),
    sha256: exactSha256(
      raw.sha256,
      `SecretDataFlowV1.artifactBindings[${index}].sha256`,
    ),
  });
}

function exactIdArray(value, label, { max = MAX_INPUTS, requireNonEmpty = false } = {}) {
  const raw = strictArray(value, label, { max });
  if (requireNonEmpty && raw.length === 0) throw new Error(`${label} must not be empty`);
  const output = raw.map((item, index) => exactId(item, `${label}[${index}]`));
  if (new Set(output).size !== output.length) throw new Error(`${label} contains duplicates`);
  return output;
}

function normalizeTransform(value, index) {
  const label = `SecretDataFlowV1.transforms[${index}]`;
  const raw = strictRecord(value, label, TRANSFORM_KEYS);
  return freezeDeep({
    transformId: exactId(raw.transformId, `${label}.transformId`),
    inputArtifactIds: exactIdArray(
      raw.inputArtifactIds,
      `${label}.inputArtifactIds`,
      { requireNonEmpty: true },
    ),
    outputArtifactId: exactId(raw.outputArtifactId, `${label}.outputArtifactId`),
    completedAt: exactTimestamp(raw.completedAt, `${label}.completedAt`),
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

function normalizeResolvedArtifact(value, label) {
  const raw = strictRecord(value, label, ARTIFACT_KEYS);
  exactVersion(raw.schemaVersion, label);

  const exact = {
    schemaVersion: SECRET_DATA_FLOW_GUARD_VERSION,
    artifactId: exactId(raw.artifactId, `${label}.artifactId`),
    kind: exactId(raw.kind, `${label}.kind`),
    uri: exactText(raw.uri, `${label}.uri`),
    mediaType: exactText(raw.mediaType, `${label}.mediaType`, { optional: true, max: 300 }),
    sha256: exactSha256(raw.sha256, `${label}.sha256`),
    sizeBytes: exactInteger(raw.sizeBytes, `${label}.sizeBytes`),
    createdAt: exactTimestamp(raw.createdAt, `${label}.createdAt`),
    producerInvocationId: exactOptionalId(
      raw.producerInvocationId,
      `${label}.producerInvocationId`,
    ),
    sensitive: exactBoolean(raw.sensitive, `${label}.sensitive`),
  };

  const normalized = normalizeArtifactRefV1(exact);
  if (normalized.sha256 !== exact.sha256
      || normalized.createdAt !== exact.createdAt
      || normalized.artifactId !== exact.artifactId
      || normalized.kind !== exact.kind
      || normalized.uri !== exact.uri
      || normalized.mediaType !== exact.mediaType
      || normalized.sizeBytes !== exact.sizeBytes
      || normalized.producerInvocationId !== exact.producerInvocationId
      || normalized.sensitive !== exact.sensitive) {
    throw new Error(`${label} is not in exact canonical ArtifactRefV1 representation`);
  }
  return normalized;
}

function resolveArtifacts(bindings, resolveArtifactRef, assessedAt) {
  if (typeof resolveArtifactRef !== 'function') {
    throw new Error('Secret data-flow assessment requires trusted resolveArtifactRef');
  }

  const resolved = new Map();
  for (const binding of bindings) {
    let candidate;
    try {
      candidate = resolveArtifactRef(binding.artifactId);
    } catch (error) {
      throw new Error(`Artifact resolver failed for ${binding.artifactId}: ${error?.message || String(error)}`);
    }
    if (candidate && typeof candidate.then === 'function') {
      throw new Error('Secret data-flow assessment requires a synchronous trusted artifact resolver');
    }
    if (candidate == null) {
      throw new Error(`Canonical artifact is unavailable: ${binding.artifactId}`);
    }

    const artifact = normalizeResolvedArtifact(
      candidate,
      `Canonical ArtifactRefV1 ${binding.artifactId}`,
    );
    if (artifact.artifactId !== binding.artifactId) {
      throw new Error(`Canonical artifact identity mismatch for ${binding.artifactId}`);
    }
    if (artifact.sha256 !== binding.sha256) {
      throw new Error(`Canonical artifact digest mismatch for ${binding.artifactId}`);
    }
    if (artifact.createdAt > assessedAt) {
      throw new Error(`Canonical artifact ${binding.artifactId} postdates assessment`);
    }
    resolved.set(binding.artifactId, artifact);
  }
  return resolved;
}

function normalizeRequest(value) {
  const raw = strictRecord(value, 'SecretDataFlowV1', REQUEST_KEYS);
  exactVersion(raw.schemaVersion, 'SecretDataFlowV1');

  const artifactBindings = strictArray(
    raw.artifactBindings,
    'SecretDataFlowV1.artifactBindings',
    { max: MAX_ARTIFACTS },
  ).map(normalizeBinding);
  if (artifactBindings.length === 0) {
    throw new Error('SecretDataFlowV1.artifactBindings must not be empty');
  }

  const artifactIds = artifactBindings.map(item => item.artifactId);
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new Error('SecretDataFlowV1.artifactBindings contains duplicate artifactId');
  }

  const transforms = strictArray(
    raw.transforms,
    'SecretDataFlowV1.transforms',
    { max: MAX_TRANSFORMS },
  ).map(normalizeTransform);
  const transformIds = transforms.map(item => item.transformId);
  if (new Set(transformIds).size !== transformIds.length) {
    throw new Error('SecretDataFlowV1.transforms contains duplicate transformId');
  }

  const outputIds = transforms.map(item => item.outputArtifactId);
  if (new Set(outputIds).size !== outputIds.length) {
    throw new Error('SecretDataFlowV1.transforms contains duplicate outputArtifactId');
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
    artifactBindings,
    transforms,
    egresses,
    assessedAt: exactTimestamp(raw.assessedAt, 'SecretDataFlowV1.assessedAt'),
  });
}

function validateGraph(request, artifacts) {
  const artifactIds = new Set(request.artifactBindings.map(item => item.artifactId));
  const indegree = new Map([...artifactIds].map(id => [id, 0]));
  const children = new Map([...artifactIds].map(id => [id, []]));

  for (const transform of request.transforms) {
    if (!artifactIds.has(transform.outputArtifactId)) {
      throw new Error(`Transform ${transform.transformId} references unknown output artifact`);
    }
    if (transform.inputArtifactIds.includes(transform.outputArtifactId)) {
      throw new Error(`Transform ${transform.transformId} cannot consume its own output`);
    }

    const output = artifacts.get(transform.outputArtifactId);
    for (const inputId of transform.inputArtifactIds) {
      if (!artifactIds.has(inputId)) {
        throw new Error(`Transform ${transform.transformId} references unknown input artifact`);
      }
      const input = artifacts.get(inputId);
      if (output.createdAt < input.createdAt) {
        throw new Error(`Transform ${transform.transformId} output predates an input artifact`);
      }
      children.get(inputId).push(transform.outputArtifactId);
      indegree.set(transform.outputArtifactId, indegree.get(transform.outputArtifactId) + 1);
    }

    if (transform.completedAt < output.createdAt) {
      throw new Error(`Transform ${transform.transformId} completes before output materialization`);
    }
    if (transform.completedAt > request.assessedAt) {
      throw new Error(`Transform ${transform.transformId} postdates assessment`);
    }
  }

  for (const list of children.values()) list.sort(compareAscii);

  const ready = [...artifactIds]
    .filter(id => indegree.get(id) === 0)
    .sort(compareAscii);
  const order = [];

  while (ready.length) {
    const current = ready.shift();
    order.push(current);
    for (const child of children.get(current)) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) {
        ready.push(child);
        ready.sort(compareAscii);
      }
    }
  }

  if (order.length !== artifactIds.size) {
    throw new Error('SecretDataFlowV1 transforms must form an acyclic artifact graph');
  }

  return { children, order };
}

function propagateSensitivity(order, children, artifacts) {
  const effective = new Map();
  for (const artifactId of order) {
    const artifact = artifacts.get(artifactId);
    const current = effective.get(artifactId) === true || artifact.sensitive === true;
    effective.set(artifactId, current);
    if (!current) continue;
    for (const child of children.get(artifactId)) effective.set(child, true);
  }
  return effective;
}

function validateEgresses(request, artifacts) {
  for (const egress of request.egresses) {
    const artifact = artifacts.get(egress.artifactId);
    if (!artifact) {
      throw new Error(`Egress ${egress.egressId} references unknown artifact`);
    }
    if (egress.requestedAt < artifact.createdAt) {
      throw new Error(`Egress ${egress.egressId} predates artifact materialization`);
    }
    if (egress.requestedAt > request.assessedAt) {
      throw new Error(`Egress ${egress.egressId} postdates assessment`);
    }
  }
}

function violation(code, artifactId) {
  return freezeDeep({ code, artifactId });
}

/**
 * Pure artifact-level secret data-flow assessment.
 *
 * The graph and egress plan are caller input, so this function never claims
 * lineage completeness, policy approval, declassification, credential use or
 * execution authority. Canonical ArtifactRefs are obtained only through the
 * trusted resolver supplied by integration code.
 *
 * Sensitivity is monotonic: once a canonical input artifact is sensitive,
 * every derived descendant is effectively sensitive. A descendant persisted
 * with sensitive=false is therefore a fail-closed laundering violation until a
 * separate canonical declassification authority exists.
 */
export function assessSecretDataFlowV1(value, {
  resolveArtifactRef,
} = {}) {
  const request = normalizeRequest(value);
  const artifacts = resolveArtifacts(
    request.artifactBindings,
    resolveArtifactRef,
    request.assessedAt,
  );

  const { children, order } = validateGraph(request, artifacts);
  validateEgresses(request, artifacts);
  const effectiveSensitive = propagateSensitivity(order, children, artifacts);

  const producedArtifacts = new Set(request.transforms.map(item => item.outputArtifactId));
  const violations = [];
  for (const artifactId of [...producedArtifacts].sort(compareAscii)) {
    const artifact = artifacts.get(artifactId);
    if (effectiveSensitive.get(artifactId) === true && artifact.sensitive !== true) {
      violations.push(violation('SENSITIVE_DERIVATION_LAUNDERING', artifactId));
    }
  }

  const artifactStates = order
    .map(artifactId => {
      const artifact = artifacts.get(artifactId);
      return freezeDeep({
        artifactId,
        sha256: artifact.sha256,
        declaredSensitive: artifact.sensitive,
        effectiveSensitive: effectiveSensitive.get(artifactId) === true,
        derived: producedArtifacts.has(artifactId),
      });
    })
    .sort((a, b) => compareAscii(a.artifactId, b.artifactId));

  const egresses = request.egresses
    .map(egress => {
      const sensitive = effectiveSensitive.get(egress.artifactId) === true;
      return freezeDeep({
        egressId: egress.egressId,
        artifactId: egress.artifactId,
        destinationOrigin: egress.destinationOrigin,
        requestedAt: egress.requestedAt,
        effectiveSensitive: sensitive,
        policyDecisionRequired: true,
        independentSecretReviewRequired: sensitive,
        executionAuthorized: false,
        credentialUseAuthorized: false,
      });
    })
    .sort((a, b) => compareAscii(a.egressId, b.egressId));

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
    status,
    artifactStates,
    egresses,
    violations,
    lineageProvenance: 'UNVERIFIED_INPUT',
    lineageCompletenessVerified: false,
    requiresCanonicalLineageResolution: true,
    requiresCanonicalArtifactResolution: true,
    requiresCanonicalPolicyDecision: request.egresses.length > 0,
    requiresIndependentSecretScan: request.egresses.length > 0,
    declassificationAuthorized: false,
    credentialUseAuthorized: false,
    executionAuthorized: false,
    assessedAt: request.assessedAt,
  });
}
