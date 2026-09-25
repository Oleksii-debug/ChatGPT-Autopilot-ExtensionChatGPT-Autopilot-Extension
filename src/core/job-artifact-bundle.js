import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const JOB_ARTIFACT_BUNDLE_SCHEMA_VERSION = 1;
export const MAX_JOB_ARTIFACT_BUNDLE_ENTRIES = 512;

export const JobArtifactCategory = Object.freeze({
  CONTROL: 'CONTROL',
  ARTIFACT: 'ARTIFACT',
  EVIDENCE: 'EVIDENCE',
  DIAGNOSTIC: 'DIAGNOSTIC',
});

const CATEGORIES = new Set(Object.values(JobArtifactCategory));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FORBIDDEN_WINDOWS_CHARS = /[<>:"\\|?*\u0000-\u001f\u007f]/u;
const FORBIDDEN_DISPLAY_CHARS = /[\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const RESERVED_WINDOWS_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;
const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
const CHECKSUM_PATH = 'checksums.txt';

const REQUIRED_CONTROL_PATHS = Object.freeze([
  'SUMMARY.md',
  'REPORT.json',
  'timeline.jsonl',
]);

const CATEGORY_PREFIX = Object.freeze({
  ARTIFACT: 'artifacts/',
  EVIDENCE: 'evidence/',
  DIAGNOSTIC: 'diagnostics/',
});

const CONTROL_MEDIA_ESSENCE = Object.freeze({
  'SUMMARY.md': 'text/markdown',
  'REPORT.json': 'application/json',
  'timeline.jsonl': 'application/x-ndjson',
});

const BUNDLE_KEYS = new Set([
  'schemaVersion',
  'bundleId',
  'jobId',
  'planId',
  'projectId',
  'createdAt',
  'entries',
  'sensitiveDisclosureRequest',
]);

const ENTRY_KEYS = new Set(['path', 'category', 'artifactRef']);
const DISCLOSURE_KEYS = new Set(['requestedSensitiveArtifactIds']);
const ARTIFACT_REF_KEYS = new Set([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);

function ownRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(label + ' must be a plain object');
  }
  if (Object.getOwnPropertySymbols(value).length) {
    throw new Error(label + ' must not contain symbol fields');
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + ' must contain data properties only');
    }
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) throw new Error(label + ' contains unknown field: ' + key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable) {
      throw new Error(label + ' contains non-enumerable field: ' + key);
    }
  }
}

function strictArray(value, label, { min = 0, max }) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a bounded plain array');
  }
  if (value.length < min || value.length > max) {
    throw new Error(label + ' must be a bounded plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(label + ' contains non-index array data');
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
      throw new Error(label + ' contains an invalid array index');
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '[' + index + '] must be an enumerable data property');
    }
  }
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + ' must not be sparse');
    }
    out.push(descriptor.value);
  }
  return out;
}

function requireVersion(value) {
  if (value !== JOB_ARTIFACT_BUNDLE_SCHEMA_VERSION) {
    throw new Error('Unsupported JobArtifactBundleV1 schemaVersion');
  }
  return value;
}

function requireId(value, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function requireIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(label + ' must be an ISO timestamp');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  return value;
}

function normalizePath(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error('bundle path must be non-empty text without surrounding whitespace');
  }
  if (value.length > MAX_PATH_LENGTH) throw new Error('bundle path is too long');
  if (value.normalize('NFC') !== value) throw new Error('bundle path must use NFC Unicode normalization');
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value) || value.startsWith('//')) {
    throw new Error('bundle path must be relative');
  }
  if (value.includes('\\')) throw new Error('bundle path must use forward slashes');
  if (FORBIDDEN_WINDOWS_CHARS.test(value)) throw new Error('bundle path contains a Windows-forbidden character');
  if (FORBIDDEN_DISPLAY_CHARS.test(value)) throw new Error('bundle path contains a display-control character');

  const segments = value.split('/');
  if (!segments.length) throw new Error('bundle path is invalid');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error('bundle path contains an unsafe segment');
    }
    if (segment.length > MAX_SEGMENT_LENGTH) throw new Error('bundle path segment is too long');
    if (segment.startsWith(' ')) throw new Error('bundle path segment may not begin with ASCII space');
    if (/[. ]$/u.test(segment)) throw new Error('bundle path segment may not end in dot or space');
    const base = segment.split('.')[0];
    if (RESERVED_WINDOWS_NAMES.test(base)) throw new Error('bundle path contains a reserved Windows name');
  }
  return value;
}

function pathKey(value) {
  return value.normalize('NFC').toLowerCase();
}

function requireArtifactRef(input) {
  const raw = ownRecord(input, 'ArtifactRefV1');
  exactKeys(raw, ARTIFACT_REF_KEYS, 'ArtifactRefV1');
  if (raw.schemaVersion !== 1) throw new Error('ArtifactRefV1 schemaVersion must be numeric 1');
  requireId(raw.artifactId, 'ArtifactRefV1 artifactId');
  requireId(raw.kind, 'ArtifactRefV1 kind');
  if (typeof raw.uri !== 'string' || !raw.uri || raw.uri !== raw.uri.trim() || raw.uri.length > 4096) {
    throw new Error('ArtifactRefV1 uri must be canonical bounded text');
  }
  if (typeof raw.sha256 !== 'string' || raw.sha256 !== raw.sha256.trim() || !SHA256.test(raw.sha256)) {
    throw new Error('ArtifactRefV1 sha256 is required and must be canonical lowercase SHA-256');
  }
  requireIsoTimestamp(raw.createdAt, 'ArtifactRefV1 createdAt');
  if (!Object.hasOwn(raw, 'sizeBytes') || !Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes < 0) {
    throw new Error('ArtifactRefV1 sizeBytes must be a non-negative safe integer');
  }
  if (!Object.hasOwn(raw, 'sensitive') || typeof raw.sensitive !== 'boolean') {
    throw new Error('ArtifactRefV1 sensitive must be an explicit boolean');
  }
  if (Object.hasOwn(raw, 'mediaType') && raw.mediaType !== '') {
    if (typeof raw.mediaType !== 'string' || raw.mediaType !== raw.mediaType.trim()) {
      throw new Error('ArtifactRefV1 mediaType must be canonical text when present');
    }
  }
  if (Object.hasOwn(raw, 'producerInvocationId')
      && raw.producerInvocationId != null
      && raw.producerInvocationId !== '') {
    requireId(raw.producerInvocationId, 'ArtifactRefV1 producerInvocationId');
  }
  return normalizeArtifactRefV1(raw);
}

function normalizeEntry(input) {
  const raw = ownRecord(input, 'JobArtifactBundleEntryV1');
  exactKeys(raw, ENTRY_KEYS, 'JobArtifactBundleEntryV1');
  const path = normalizePath(raw.path);
  if (pathKey(path) === pathKey(CHECKSUM_PATH)) {
    throw new Error('checksums.txt is derived and must not be supplied as an entry');
  }
  if (typeof raw.category !== 'string' || !CATEGORIES.has(raw.category)) {
    throw new Error('entry category is invalid');
  }
  const artifactRef = requireArtifactRef(raw.artifactRef);
  const requiredControl = REQUIRED_CONTROL_PATHS.includes(path);
  if (raw.category === JobArtifactCategory.CONTROL) {
    if (!requiredControl) throw new Error('CONTROL entries are limited to canonical control files');
    const expectedMedia = CONTROL_MEDIA_ESSENCE[path];
    const actualMedia = artifactRef.mediaType.split(';', 1)[0].trim().toLowerCase();
    if (actualMedia !== expectedMedia) {
      throw new Error(path + ' requires mediaType ' + expectedMedia);
    }
  } else {
    if (requiredControl) throw new Error('canonical control file has the wrong category');
    const prefix = CATEGORY_PREFIX[raw.category];
    if (!prefix || !path.startsWith(prefix) || path.length === prefix.length) {
      throw new Error(raw.category + ' entry must live under ' + prefix);
    }
  }

  return Object.freeze({
    path,
    category: raw.category,
    artifactRef,
  });
}

function normalizeDisclosureRequest(input) {
  const raw = ownRecord(input, 'JobArtifactBundleSensitiveDisclosureRequestV1');
  exactKeys(raw, DISCLOSURE_KEYS, 'JobArtifactBundleSensitiveDisclosureRequestV1');
  const requestedSensitiveArtifactIds = strictArray(
    raw.requestedSensitiveArtifactIds,
    'requestedSensitiveArtifactIds',
    { max: MAX_JOB_ARTIFACT_BUNDLE_ENTRIES },
  );
  const ids = requestedSensitiveArtifactIds.map((value) => requireId(value, 'requestedSensitiveArtifactId'));
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) throw new Error('requestedSensitiveArtifactIds contains duplicate artifactId: ' + id);
    seen.add(id);
  }
  ids.sort();
  return Object.freeze({ requestedSensitiveArtifactIds: Object.freeze(ids) });
}

function checksumLine(entry) {
  return entry.artifactRef.sha256 + '  ' + entry.path;
}

export function buildJobArtifactBundleV1(input) {
  const raw = ownRecord(input, 'JobArtifactBundleV1');
  exactKeys(raw, BUNDLE_KEYS, 'JobArtifactBundleV1');
  requireVersion(raw.schemaVersion);

  const entryInputs = strictArray(raw.entries, 'entries', {
    min: REQUIRED_CONTROL_PATHS.length,
    max: MAX_JOB_ARTIFACT_BUNDLE_ENTRIES,
  });

  const entries = entryInputs.map(normalizeEntry);
  const createdAt = requireIsoTimestamp(raw.createdAt, 'createdAt');
  for (const entry of entries) {
    if (Date.parse(entry.artifactRef.createdAt) > Date.parse(createdAt)) {
      throw new Error('bundle createdAt cannot predate artifact: ' + entry.artifactRef.artifactId);
    }
  }
  const sensitiveDisclosureRequest = normalizeDisclosureRequest(raw.sensitiveDisclosureRequest);
  const seenPaths = new Map();
  const seenArtifactIds = new Set();

  for (const entry of entries) {
    const folded = pathKey(entry.path);
    if (seenPaths.has(folded)) {
      throw new Error('bundle contains case-insensitive path collision: ' + seenPaths.get(folded) + ' / ' + entry.path);
    }
    seenPaths.set(folded, entry.path);
    if (seenArtifactIds.has(entry.artifactRef.artifactId)) {
      throw new Error('bundle contains duplicate artifactId: ' + entry.artifactRef.artifactId);
    }
    seenArtifactIds.add(entry.artifactRef.artifactId);
  }

  for (const requiredPath of REQUIRED_CONTROL_PATHS) {
    if (!seenPaths.has(pathKey(requiredPath))) {
      throw new Error('bundle is missing required control file: ' + requiredPath);
    }
  }

  const sensitiveArtifactIds = entries
    .filter((entry) => entry.artifactRef.sensitive)
    .map((entry) => entry.artifactRef.artifactId)
    .sort();
  const sensitiveIds = new Set(sensitiveArtifactIds);
  const requestedSensitive = new Set(sensitiveDisclosureRequest.requestedSensitiveArtifactIds);
  for (const id of sensitiveIds) {
    if (!requestedSensitive.has(id)) throw new Error('sensitive artifact is missing from disclosure request: ' + id);
  }
  for (const id of requestedSensitive) {
    if (!sensitiveIds.has(id)) throw new Error('sensitive disclosure request does not match a sensitive bundle artifact: ' + id);
  }

  entries.sort((a, b) => {
    const ak = pathKey(a.path);
    const bk = pathKey(b.path);
    if (ak < bk) return -1;
    if (ak > bk) return 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const frozenEntries = Object.freeze(entries);
  const checksumsText = frozenEntries.map(checksumLine).join('\n') + '\n';
  const checksumFile = Object.freeze({
    path: CHECKSUM_PATH,
    mediaType: 'text/plain; charset=utf-8',
    content: checksumsText,
    coversPaths: Object.freeze(frozenEntries.map((entry) => entry.path)),
  });

  return Object.freeze({
    schemaVersion: JOB_ARTIFACT_BUNDLE_SCHEMA_VERSION,
    bundleId: requireId(raw.bundleId, 'bundleId'),
    jobId: requireId(raw.jobId, 'jobId'),
    planId: requireId(raw.planId, 'planId', { optional: true }),
    projectId: requireId(raw.projectId, 'projectId', { optional: true }),
    createdAt,
    sensitiveDisclosureRequest,
    sensitiveArtifactIds: Object.freeze(sensitiveArtifactIds),
    disclosureAuthorized: false,
    distributionAuthorized: false,
    requiresCanonicalDisclosureAuthorization: sensitiveArtifactIds.length > 0,
    entries: frozenEntries,
    checksumFile,
    bundlePaths: Object.freeze([...frozenEntries.map((entry) => entry.path), CHECKSUM_PATH]),
  });
}

export const JOB_ARTIFACT_BUNDLE_REQUIRED_PATHS = Object.freeze([
  ...REQUIRED_CONTROL_PATHS,
  CHECKSUM_PATH,
]);
