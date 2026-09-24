import {
  normalizeContextCapsuleV1,
  normalizeProjectSnapshotV1,
  sourceBindingFromRefV1,
} from './project-context-artifact.js';

export const CONTEXT_CAPSULE_DISCLOSURE_SCHEMA_VERSION = 1;
export const CONTEXT_CAPSULE_MAX_DISCLOSED_SOURCES = 128;
export const CONTEXT_CAPSULE_MAX_DISCLOSED_ARTIFACTS = 128;
export const CONTEXT_CAPSULE_MAX_SUMMARY_CHARS = 50_000;
export const CONTEXT_CAPSULE_MAX_SERIALIZED_BYTES = 512 * 1024;

const BUILD_KEYS = new Set([
  'capsuleId',
  'snapshot',
  'summary',
  'disclosure',
  'createdAt',
]);

const DISCLOSURE_KEYS = new Set([
  'schemaVersion',
  'allowedSourceIds',
  'allowedArtifactIds',
  'allowedSensitiveArtifactIds',
  'maxSources',
  'maxArtifacts',
  'maxSummaryChars',
  'maxSerializedBytes',
]);

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function strictId(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`${label} must be an exact non-empty string id`);
  }
  return value;
}

function boundedIdList(value, label, max) {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`${label} must be a bounded array`);
  }
  const normalized = value.map((item, index) => strictId(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate ids`);
  }
  return normalized;
}

function boundedInteger(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer in ${min}..${max}`);
  }
  return value;
}

function strictTimestamp(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return new Date(ms).toISOString();
}

function strictSummary(value, maxChars) {
  if (typeof value !== 'string') throw new Error('summary must be text');
  const summary = value.trim();
  if (!summary) throw new Error('summary must not be empty');
  if (summary.length > maxChars) throw new Error('summary exceeds disclosure maxSummaryChars');
  return summary;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

export function normalizeContextCapsuleDisclosureV1(input) {
  const raw = plainRecord(input, 'ContextCapsuleDisclosureV1');
  exactKeys(raw, DISCLOSURE_KEYS, 'ContextCapsuleDisclosureV1');

  if (raw.schemaVersion !== CONTEXT_CAPSULE_DISCLOSURE_SCHEMA_VERSION) {
    throw new Error('Unsupported ContextCapsuleDisclosureV1 schemaVersion');
  }

  const allowedSourceIds = boundedIdList(
    raw.allowedSourceIds,
    'allowedSourceIds',
    CONTEXT_CAPSULE_MAX_DISCLOSED_SOURCES,
  );
  const allowedArtifactIds = boundedIdList(
    raw.allowedArtifactIds,
    'allowedArtifactIds',
    CONTEXT_CAPSULE_MAX_DISCLOSED_ARTIFACTS,
  );
  const allowedSensitiveArtifactIds = boundedIdList(
    raw.allowedSensitiveArtifactIds,
    'allowedSensitiveArtifactIds',
    CONTEXT_CAPSULE_MAX_DISCLOSED_ARTIFACTS,
  );

  const allowedArtifactSet = new Set(allowedArtifactIds);
  for (const artifactId of allowedSensitiveArtifactIds) {
    if (!allowedArtifactSet.has(artifactId)) {
      throw new Error(`Sensitive artifact allowlist is not a subset of allowedArtifactIds: ${artifactId}`);
    }
  }

  return frozen({
    schemaVersion: CONTEXT_CAPSULE_DISCLOSURE_SCHEMA_VERSION,
    allowedSourceIds: [...allowedSourceIds],
    allowedArtifactIds: [...allowedArtifactIds],
    allowedSensitiveArtifactIds: [...allowedSensitiveArtifactIds],
    maxSources: boundedInteger(
      raw.maxSources,
      'maxSources',
      0,
      CONTEXT_CAPSULE_MAX_DISCLOSED_SOURCES,
    ),
    maxArtifacts: boundedInteger(
      raw.maxArtifacts,
      'maxArtifacts',
      0,
      CONTEXT_CAPSULE_MAX_DISCLOSED_ARTIFACTS,
    ),
    maxSummaryChars: boundedInteger(
      raw.maxSummaryChars,
      'maxSummaryChars',
      1,
      CONTEXT_CAPSULE_MAX_SUMMARY_CHARS,
    ),
    maxSerializedBytes: boundedInteger(
      raw.maxSerializedBytes,
      'maxSerializedBytes',
      1,
      CONTEXT_CAPSULE_MAX_SERIALIZED_BYTES,
    ),
  });
}

function selectSources(snapshot, disclosure) {
  const sourceById = new Map(snapshot.sourceRefs.map(source => [source.sourceId, source]));
  for (const sourceId of disclosure.allowedSourceIds) {
    if (!sourceById.has(sourceId)) throw new Error(`Disclosure references unknown sourceId: ${sourceId}`);
  }
  if (disclosure.allowedSourceIds.length > disclosure.maxSources) {
    throw new Error('Disclosed source count exceeds maxSources');
  }
  return disclosure.allowedSourceIds
    .map(sourceId => sourceById.get(sourceId))
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

function selectArtifacts(snapshot, disclosure) {
  const artifactById = new Map(snapshot.artifactRefs.map(artifact => [artifact.artifactId, artifact]));
  const allowedSensitive = new Set(disclosure.allowedSensitiveArtifactIds);

  for (const artifactId of disclosure.allowedArtifactIds) {
    if (!artifactById.has(artifactId)) throw new Error(`Disclosure references unknown artifactId: ${artifactId}`);
  }
  for (const artifactId of disclosure.allowedSensitiveArtifactIds) {
    const artifact = artifactById.get(artifactId);
    if (!artifact) throw new Error(`Disclosure references unknown sensitive artifactId: ${artifactId}`);
    if (!artifact.sensitive) {
      throw new Error(`Sensitive artifact allowlist contains a non-sensitive artifact: ${artifactId}`);
    }
  }
  if (disclosure.allowedArtifactIds.length > disclosure.maxArtifacts) {
    throw new Error('Disclosed artifact count exceeds maxArtifacts');
  }

  const selected = disclosure.allowedArtifactIds.map(artifactId => artifactById.get(artifactId));
  for (const artifact of selected) {
    if (artifact.sensitive && !allowedSensitive.has(artifact.artifactId)) {
      throw new Error(`Sensitive artifact requires explicit sensitive allowlist admission: ${artifact.artifactId}`);
    }
  }

  return selected.sort((a, b) => a.artifactId.localeCompare(b.artifactId));
}

function serializedByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function createPortableContextCapsuleV1(input) {
  const raw = plainRecord(input, 'PortableContextCapsuleBuildV1');
  exactKeys(raw, BUILD_KEYS, 'PortableContextCapsuleBuildV1');

  const capsuleId = strictId(raw.capsuleId, 'capsuleId');
  const snapshot = normalizeProjectSnapshotV1(raw.snapshot);
  const disclosure = normalizeContextCapsuleDisclosureV1(raw.disclosure);
  const summary = strictSummary(raw.summary, disclosure.maxSummaryChars);
  const createdAt = strictTimestamp(raw.createdAt, 'createdAt');

  const sources = selectSources(snapshot, disclosure);
  const artifacts = selectArtifacts(snapshot, disclosure);
  if (sources.length + artifacts.length === 0) {
    throw new Error('Portable context capsule must disclose at least one provenance-bound source or artifact');
  }

  const capsule = normalizeContextCapsuleV1({
    schemaVersion: 1,
    capsuleId,
    projectId: snapshot.projectId,
    projectRevisionId: snapshot.revisionId,
    summary,
    sourceBindings: sources.map(sourceBindingFromRefV1),
    artifactRefs: artifacts,
    createdAt,
  });

  const bytes = serializedByteLength(capsule);
  if (bytes > disclosure.maxSerializedBytes) {
    throw new Error(`Portable context capsule exceeds maxSerializedBytes: ${bytes}`);
  }

  return capsule;
}
