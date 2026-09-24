import {
  normalizeContextCapsuleV1,
  normalizeProjectSnapshotV1,
  sourceBindingFromRefV1,
} from './project-context-artifact.js';

export const CONTEXT_CAPSULE_DISCLOSURE_SCHEMA_VERSION = 1;
export const CONTEXT_CAPSULE_CONTENT_SCHEMA_VERSION = 1;
export const CONTEXT_CAPSULE_MAX_DISCLOSED_SOURCES = 128;
export const CONTEXT_CAPSULE_MAX_DISCLOSED_ARTIFACTS = 128;
export const CONTEXT_CAPSULE_MAX_SUMMARY_CHARS = 50_000;
export const CONTEXT_CAPSULE_MAX_SERIALIZED_BYTES = 512 * 1024;
export const CONTEXT_CAPSULE_MAX_CONTENT_ITEMS = 64;
export const CONTEXT_CAPSULE_MAX_CONTENT_ITEM_CHARS = 2_000;
export const CONTEXT_CAPSULE_STRUCTURED_SUMMARY_PREFIX = 'ContextCapsuleContentV1:';

const BUILD_KEYS = new Set([
  'capsuleId',
  'snapshot',
  'summary',
  'content',
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

const CONTENT_KEYS = new Set([
  'schemaVersion',
  'goal',
  'currentState',
  'constraints',
  'decisions',
  'unfinishedWork',
  'ownershipClaims',
  'recentEvidence',
  'nextActions',
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
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
  }
}

function requiredOwn(value, key, label) {
  if (!Object.hasOwn(value, key)) throw new Error(`${label} must be provided as an own field`);
  return value[key];
}

function strictId(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`${label} must be an exact non-empty string id`);
  }
  return value;
}

function strictText(value, label, maxChars) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty`);
  if (text.length > maxChars) throw new Error(`${label} exceeds its character bound`);
  return text;
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

function boundedTextList(value, label) {
  if (!Array.isArray(value) || value.length > CONTEXT_CAPSULE_MAX_CONTENT_ITEMS) {
    throw new Error(`${label} must be a bounded array`);
  }
  const normalized = value.map((item, index) => strictText(
    item,
    `${label}[${index}]`,
    CONTEXT_CAPSULE_MAX_CONTENT_ITEM_CHARS,
  ));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate entries`);
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

  if (requiredOwn(raw, 'schemaVersion', 'schemaVersion') !== CONTEXT_CAPSULE_DISCLOSURE_SCHEMA_VERSION) {
    throw new Error('Unsupported ContextCapsuleDisclosureV1 schemaVersion');
  }

  const allowedSourceIds = boundedIdList(
    requiredOwn(raw, 'allowedSourceIds', 'allowedSourceIds'),
    'allowedSourceIds',
    CONTEXT_CAPSULE_MAX_DISCLOSED_SOURCES,
  );
  const allowedArtifactIds = boundedIdList(
    requiredOwn(raw, 'allowedArtifactIds', 'allowedArtifactIds'),
    'allowedArtifactIds',
    CONTEXT_CAPSULE_MAX_DISCLOSED_ARTIFACTS,
  );
  const allowedSensitiveArtifactIds = boundedIdList(
    requiredOwn(raw, 'allowedSensitiveArtifactIds', 'allowedSensitiveArtifactIds'),
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
      requiredOwn(raw, 'maxSources', 'maxSources'),
      'maxSources',
      0,
      CONTEXT_CAPSULE_MAX_DISCLOSED_SOURCES,
    ),
    maxArtifacts: boundedInteger(
      requiredOwn(raw, 'maxArtifacts', 'maxArtifacts'),
      'maxArtifacts',
      0,
      CONTEXT_CAPSULE_MAX_DISCLOSED_ARTIFACTS,
    ),
    maxSummaryChars: boundedInteger(
      requiredOwn(raw, 'maxSummaryChars', 'maxSummaryChars'),
      'maxSummaryChars',
      1,
      CONTEXT_CAPSULE_MAX_SUMMARY_CHARS,
    ),
    maxSerializedBytes: boundedInteger(
      requiredOwn(raw, 'maxSerializedBytes', 'maxSerializedBytes'),
      'maxSerializedBytes',
      1,
      CONTEXT_CAPSULE_MAX_SERIALIZED_BYTES,
    ),
  });
}

export function normalizeContextCapsuleContentV1(input) {
  const raw = plainRecord(input, 'ContextCapsuleContentV1');
  exactKeys(raw, CONTENT_KEYS, 'ContextCapsuleContentV1');
  if (requiredOwn(raw, 'schemaVersion', 'schemaVersion') !== CONTEXT_CAPSULE_CONTENT_SCHEMA_VERSION) {
    throw new Error('Unsupported ContextCapsuleContentV1 schemaVersion');
  }

  return frozen({
    schemaVersion: CONTEXT_CAPSULE_CONTENT_SCHEMA_VERSION,
    goal: strictText(requiredOwn(raw, 'goal', 'goal'), 'goal', 4_000),
    currentState: strictText(requiredOwn(raw, 'currentState', 'currentState'), 'currentState', 8_000),
    constraints: boundedTextList(requiredOwn(raw, 'constraints', 'constraints'), 'constraints'),
    decisions: boundedTextList(requiredOwn(raw, 'decisions', 'decisions'), 'decisions'),
    unfinishedWork: boundedTextList(requiredOwn(raw, 'unfinishedWork', 'unfinishedWork'), 'unfinishedWork'),
    ownershipClaims: boundedTextList(requiredOwn(raw, 'ownershipClaims', 'ownershipClaims'), 'ownershipClaims'),
    recentEvidence: boundedTextList(requiredOwn(raw, 'recentEvidence', 'recentEvidence'), 'recentEvidence'),
    nextActions: boundedTextList(requiredOwn(raw, 'nextActions', 'nextActions'), 'nextActions'),
  });
}

export function renderContextCapsuleContentV1(input) {
  const content = normalizeContextCapsuleContentV1(input);
  return `${CONTEXT_CAPSULE_STRUCTURED_SUMMARY_PREFIX}${JSON.stringify(content)}`;
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
    .sort((a, b) => compareExactId(a.sourceId, b.sourceId));
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

  return selected.sort((a, b) => compareExactId(a.artifactId, b.artifactId));
}

function compareExactId(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function serializedByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function capsuleSummary(raw, disclosure) {
  const hasSummary = Object.hasOwn(raw, 'summary');
  const hasContent = Object.hasOwn(raw, 'content');
  if (hasSummary === hasContent) {
    throw new Error('Portable context capsule requires exactly one of summary or content');
  }
  const rendered = hasContent
    ? renderContextCapsuleContentV1(raw.content)
    : requiredOwn(raw, 'summary', 'summary');
  return strictSummary(rendered, disclosure.maxSummaryChars);
}

export function createPortableContextCapsuleV1(input) {
  const raw = plainRecord(input, 'PortableContextCapsuleBuildV1');
  exactKeys(raw, BUILD_KEYS, 'PortableContextCapsuleBuildV1');

  const capsuleId = strictId(requiredOwn(raw, 'capsuleId', 'capsuleId'), 'capsuleId');
  const snapshot = normalizeProjectSnapshotV1(requiredOwn(raw, 'snapshot', 'snapshot'));
  const disclosure = normalizeContextCapsuleDisclosureV1(requiredOwn(raw, 'disclosure', 'disclosure'));
  const summary = capsuleSummary(raw, disclosure);
  const createdAt = strictTimestamp(requiredOwn(raw, 'createdAt', 'createdAt'), 'createdAt');

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
