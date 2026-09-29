import {
  CODING_SPECIALIST_PROVIDER_VERSION,
  OPENHANDS_AGENT_SERVER_VERSION,
  OPENHANDS_CODING_PROVIDER_ID,
  normalizeOpenHandsCodingSpecialistConfigV1,
} from '../core/coding-specialist-provider.js';

export const OPENHANDS_SPECIALIST_PROVIDER_KIND = 'OPENHANDS_AGENT_SERVER';

const FORM_KEYS = new Set([
  'serverUrl',
  'agentProfileId',
  'agentProfileRevision',
  'workspacePath',
  'qualifiedCapabilityIdsText',
  'requestTimeoutSeconds',
  'maxExecutionSeconds',
  'pollIntervalMs',
  'maxIterations',
  'maxResponseBytes',
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function snapshotForm(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('OpenHands provider form must be a data object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('OpenHands provider form must be a data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !FORM_KEYS.has(key)) {
      throw new Error('OpenHands provider form contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('OpenHands provider form.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  for (const key of FORM_KEYS) {
    if (!Object.hasOwn(out, key)) {
      throw new Error('OpenHands provider form requires ' + key);
    }
  }
  return out;
}

function revision(value) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 0) {
    throw new Error('OpenHands provider expected revision is invalid');
  }
  return value;
}

function integerText(value, label, min, max) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(label + ' must be a canonical positive integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(label + ' is outside the supported range');
  }
  return parsed;
}

function capabilityLines(value) {
  if (typeof value !== 'string') {
    throw new Error('Qualified capability IDs must be text');
  }
  const values = [];
  const seen = new Set();
  for (const raw of value.replace(/\r\n?/gu, '\n').split('\n')) {
    if (raw === '') continue;
    if (raw !== raw.trim() || !ID.test(raw)) {
      throw new Error('Qualified capability ID is not canonical: ' + raw);
    }
    if (seen.has(raw)) {
      throw new Error('Qualified capability IDs contain duplicate identity: ' + raw);
    }
    seen.add(raw);
    values.push(raw);
    if (values.length > 64) {
      throw new Error('Qualified capability IDs exceed the 64-item limit');
    }
  }
  if (!values.length) {
    throw new Error('At least one qualified capability ID is required');
  }
  return values.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function buildOpenHandsSpecialistProviderConfigRequestV1(
  input = {},
  { expectedRevision = 0 } = {},
) {
  const form = snapshotForm(input);
  const config = normalizeOpenHandsCodingSpecialistConfigV1({
    schemaVersion: CODING_SPECIALIST_PROVIDER_VERSION,
    serverUrl: form.serverUrl,
    agentServerVersion: OPENHANDS_AGENT_SERVER_VERSION,
    agentProfileId: form.agentProfileId,
    agentProfileRevision: integerText(
      form.agentProfileRevision,
      'Agent profile revision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    workspacePath: form.workspacePath,
    qualifiedCapabilityIds: capabilityLines(form.qualifiedCapabilityIdsText),
    requestTimeoutSeconds: integerText(form.requestTimeoutSeconds, 'Request timeout', 1, 120),
    maxExecutionSeconds: integerText(form.maxExecutionSeconds, 'Max execution seconds', 1, 21_600),
    pollIntervalMs: integerText(form.pollIntervalMs, 'Poll interval', 100, 30_000),
    maxIterations: integerText(form.maxIterations, 'Max iterations', 1, 500),
    maxResponseBytes: integerText(form.maxResponseBytes, 'Max response bytes', 1_024, 2_000_000),
    authMode: 'LOCAL_UNAUTHENTICATED',
  });
  return Object.freeze({
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    expectedRevision: revision(expectedRevision),
    kind: OPENHANDS_SPECIALIST_PROVIDER_KIND,
    config,
  });
}
