export const CAPABILITY_BEST_PATH_VERSION = 1;

export const CapabilityPathKind = Object.freeze({
  API: 'API',
  CLI: 'CLI',
  MCP: 'MCP',
  SEMANTIC_BROWSER: 'SEMANTIC_BROWSER',
  UIA: 'UIA',
  BROWSER: 'BROWSER',
  VISION: 'VISION',
  OCR: 'OCR',
});

const PATH_ORDER = Object.freeze({
  API: 0,
  CLI: 1,
  MCP: 2,
  SEMANTIC_BROWSER: 3,
  UIA: 4,
  BROWSER: 5,
  VISION: 6,
  OCR: 7,
});

const PATHS = new Set(Object.values(CapabilityPathKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const CANDIDATE_KEYS = new Set([
  'schemaVersion',
  'candidateId',
  'providerId',
  'sourceId',
  'pathKind',
  'capabilityIds',
  'enabled',
  'ready',
  'installationRequired',
  'authenticationRequired',
  'configurationRequired',
  'sourceRevision',
  'observedAt',
  'validThrough',
]);
const REQUEST_KEYS = new Set(['schemaVersion', 'asOf', 'requiredCapabilityIds', 'candidates']);
const MAX_CANDIDATES = 128;
const MAX_CAPABILITIES = 64;

function dataRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${String(key)} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a canonical array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new Error(`${label} has invalid length`);
  }
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`${label} contains non-canonical array fields`);
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must use exact canonical identity representation`);
  }
  return value;
}

function ids(value, label) {
  const out = denseArray(value, label, MAX_CAPABILITIES)
    .map((item, index) => id(item, `${label}[${index}]`))
    .sort(compareId);
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicate identity`);
  return Object.freeze(out);
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function revision(value, label) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must use canonical UTC`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must use canonical UTC`);
  }
  return value;
}

function compareId(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function normalizeCapabilityPathCandidateV1(input) {
  const raw = dataRecord(input, CANDIDATE_KEYS, 'CapabilityPathCandidateV1');
  if (raw.schemaVersion !== CAPABILITY_BEST_PATH_VERSION) {
    throw new Error('CapabilityPathCandidateV1.schemaVersion must be numeric 1');
  }
  if (typeof raw.pathKind !== 'string' || !PATHS.has(raw.pathKind)) {
    throw new Error('CapabilityPathCandidateV1.pathKind is invalid');
  }
  const observedAt = timestamp(raw.observedAt, 'observedAt');
  const validThrough = timestamp(raw.validThrough, 'validThrough');
  if (Date.parse(validThrough) < Date.parse(observedAt)) {
    throw new Error('CapabilityPathCandidateV1 validThrough cannot predate observedAt');
  }
  return freeze({
    schemaVersion: CAPABILITY_BEST_PATH_VERSION,
    candidateId: id(raw.candidateId, 'candidateId'),
    providerId: id(raw.providerId, 'providerId'),
    sourceId: id(raw.sourceId, 'sourceId'),
    pathKind: raw.pathKind,
    capabilityIds: ids(raw.capabilityIds, 'capabilityIds'),
    enabled: bool(raw.enabled, 'enabled'),
    ready: bool(raw.ready, 'ready'),
    installationRequired: bool(raw.installationRequired, 'installationRequired'),
    authenticationRequired: bool(raw.authenticationRequired, 'authenticationRequired'),
    configurationRequired: bool(raw.configurationRequired, 'configurationRequired'),
    sourceRevision: revision(raw.sourceRevision, 'sourceRevision'),
    observedAt,
    validThrough,
  });
}

function blockReason(candidate, required, asOf) {
  if (Date.parse(candidate.observedAt) > Date.parse(asOf)) return 'FUTURE_OBSERVATION';
  if (Date.parse(candidate.validThrough) < Date.parse(asOf)) return 'STALE';
  if (!candidate.enabled) return 'DISABLED';
  const available = new Set(candidate.capabilityIds);
  if (!required.every(capabilityId => available.has(capabilityId))) return 'MISSING_CAPABILITY';
  if (candidate.installationRequired) return 'INSTALLATION_REQUIRED';
  if (candidate.authenticationRequired) return 'AUTHENTICATION_REQUIRED';
  if (candidate.configurationRequired) return 'CONFIGURATION_REQUIRED';
  if (!candidate.ready) return 'NOT_READY';
  return '';
}

function rank(candidate, required) {
  return [
    PATH_ORDER[candidate.pathKind],
    candidate.capabilityIds.length - required.length,
    candidate.providerId,
    candidate.candidateId,
  ];
}

function compareRank(left, right, required) {
  const a = rank(left, required);
  const b = rank(right, required);
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  const provider = compareId(a[2], b[2]);
  return provider || compareId(a[3], b[3]);
}

function recommendation(candidate, required) {
  if (!candidate) return null;
  return freeze({
    candidate,
    pathPreferenceRank: PATH_ORDER[candidate.pathKind],
    capabilitySurplus: candidate.capabilityIds.length - required.length,
    authority: {
      advisoryOnly: true,
      executionAuthorized: false,
      permissionGranted: false,
      installationAuthorized: false,
      authenticationAuthorized: false,
      credentialAuthorized: false,
      policyAuthorized: false,
      routingAuthorized: false,
    },
  });
}

export function recommendCapabilityBestPathV1(input = {}) {
  const raw = dataRecord(input, REQUEST_KEYS, 'Capability best-path request');
  if (raw.schemaVersion !== CAPABILITY_BEST_PATH_VERSION) {
    throw new Error('Capability best-path request schemaVersion must be numeric 1');
  }
  const asOf = timestamp(raw.asOf, 'asOf');
  const requiredCapabilityIds = ids(raw.requiredCapabilityIds, 'requiredCapabilityIds');
  if (!requiredCapabilityIds.length) {
    throw new Error('requiredCapabilityIds must not be empty');
  }
  const candidates = denseArray(raw.candidates, 'candidates', MAX_CANDIDATES)
    .map(normalizeCapabilityPathCandidateV1);
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.candidateId)) {
      throw new Error('Capability candidates contain duplicate candidateId');
    }
    seen.add(candidate.candidateId);
  }

  const eligible = [];
  const blocked = [];
  for (const candidate of candidates) {
    const reason = blockReason(candidate, requiredCapabilityIds, asOf);
    if (reason) {
      blocked.push(freeze({ candidate, reason }));
    } else {
      eligible.push(candidate);
    }
  }
  eligible.sort((left, right) => compareRank(left, right, requiredCapabilityIds));
  blocked.sort((left, right) => compareId(left.candidate.candidateId, right.candidate.candidateId));

  return freeze({
    schemaVersion: CAPABILITY_BEST_PATH_VERSION,
    asOf,
    requiredCapabilityIds,
    selected: recommendation(eligible[0] || null, requiredCapabilityIds),
    alternatives: eligible.slice(1).map(candidate => recommendation(candidate, requiredCapabilityIds)),
    blocked,
    authority: {
      advisoryOnly: true,
      executionAuthorized: false,
      permissionGranted: false,
      installationAuthorized: false,
      authenticationAuthorized: false,
      credentialAuthorized: false,
      policyAuthorized: false,
      routingAuthorized: false,
    },
  });
}
