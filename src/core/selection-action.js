export const SelectionActionContractVersion = 1;

export const SelectionActionSourceKind = Object.freeze({
  SELECTION: 'SELECTION',
  CLIPBOARD: 'CLIPBOARD',
  CURRENT_PAGE: 'CURRENT_PAGE',
});

export const SelectionActionOperation = Object.freeze({
  SUMMARIZE: 'SUMMARIZE',
  REWRITE: 'REWRITE',
  TRANSLATE: 'TRANSLATE',
  SAVE_TO_PROJECT: 'SAVE_TO_PROJECT',
  CREATE_TASK: 'CREATE_TASK',
  COMPARE_WITH_PROJECT: 'COMPARE_WITH_PROJECT',
  EXTRACT_STRUCTURED: 'EXTRACT_STRUCTURED',
  RUN_RECIPE: 'RUN_RECIPE',
  CONTINUE_FROM_PAGE: 'CONTINUE_FROM_PAGE',
});

const SOURCE_KINDS = new Set(Object.values(SelectionActionSourceKind));
const OPERATIONS = new Set(Object.values(SelectionActionOperation));
const EFFECTFUL_OPERATIONS = new Set([
  SelectionActionOperation.SAVE_TO_PROJECT,
  SelectionActionOperation.CREATE_TASK,
  SelectionActionOperation.RUN_RECIPE,
  SelectionActionOperation.CONTINUE_FROM_PAGE,
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SOURCE_TEXT = 100_000;
const MAX_OWNER_INSTRUCTION = 16_000;
const MAX_URI = 4096;

const SOURCE_KEYS = new Set([
  'schemaVersion',
  'sourceId',
  'kind',
  'capturedAt',
  'text',
  'uri',
  'artifactId',
  'contentSha256',
]);
const TARGET_KEYS = new Set(['projectId', 'sessionId', 'agentId', 'recipeId']);
const REQUEST_KEYS = new Set([
  'schemaVersion',
  'requestId',
  'source',
  'operation',
  'ownerInstruction',
  'target',
  'createdAt',
]);

function snapshotRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }

  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function version(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value !== SelectionActionContractVersion) {
    throw new Error(`Unsupported ${label} schemaVersion`);
  }
  return SelectionActionContractVersion;
}

function id(value, label, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  if (value !== value.trim() || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundedText(value, label, max, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  if (!value.trim() || value.length > max) throw new Error(`${label} is invalid`);
  return value;
}

function optionalUri(value) {
  if (value == null || value === '') return '';
  const uri = boundedText(value, 'uri', MAX_URI);
  if (uri !== uri.trim()) throw new Error('uri is invalid');
  return uri;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  const canonical = new Date(ms).toISOString();
  if (value !== canonical) throw new Error(`${label} must be a canonical timestamp`);
  return canonical;
}

function optionalDigest(value, label) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeTargetV1(input = {}) {
  const raw = snapshotRecord(input, TARGET_KEYS, 'SelectionActionTargetV1');
  return deepFreeze({
    projectId: id(raw.projectId, 'projectId', { optional: true }),
    sessionId: id(raw.sessionId, 'sessionId', { optional: true }),
    agentId: id(raw.agentId, 'agentId', { optional: true }),
    recipeId: id(raw.recipeId, 'recipeId', { optional: true }),
  });
}

export function normalizeSelectionActionSourceV1(input) {
  const raw = snapshotRecord(input, SOURCE_KEYS, 'SelectionActionSourceV1');
  if (typeof raw.kind !== 'string') throw new Error('source kind must be text');
  const kind = raw.kind;
  if (!SOURCE_KINDS.has(kind)) throw new Error('source kind is invalid');

  const text = raw.text == null || raw.text === ''
    ? ''
    : boundedText(raw.text, 'source text', MAX_SOURCE_TEXT);
  const uri = optionalUri(raw.uri);
  const artifactId = id(raw.artifactId, 'artifactId', { optional: true });
  const contentSha256 = optionalDigest(raw.contentSha256, 'contentSha256');

  if ((artifactId === null) !== (contentSha256 === '')) {
    throw new Error('artifactId and contentSha256 must be provided together');
  }
  if (!text && !artifactId) {
    throw new Error('SelectionActionSourceV1 requires bounded text or an exact artifact binding');
  }
  if (kind === SelectionActionSourceKind.CURRENT_PAGE && !uri) {
    throw new Error('CURRENT_PAGE source requires uri');
  }

  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'SelectionActionSourceV1'),
    sourceId: id(raw.sourceId, 'sourceId'),
    kind,
    capturedAt: timestamp(raw.capturedAt, 'capturedAt'),
    text,
    uri,
    artifactId,
    contentSha256,
    capturedContentIsUntrusted: true,
    instructionAuthority: false,
    permissionGranted: false,
  });
}

function assertOperationTarget(operation, source, target) {
  if ([
    SelectionActionOperation.SAVE_TO_PROJECT,
    SelectionActionOperation.CREATE_TASK,
    SelectionActionOperation.COMPARE_WITH_PROJECT,
  ].includes(operation) && !target.projectId) {
    throw new Error(`${operation} requires projectId`);
  }
  if (operation === SelectionActionOperation.RUN_RECIPE && !target.recipeId) {
    throw new Error('RUN_RECIPE requires recipeId');
  }
  if (operation === SelectionActionOperation.CONTINUE_FROM_PAGE) {
    if (source.kind !== SelectionActionSourceKind.CURRENT_PAGE) {
      throw new Error('CONTINUE_FROM_PAGE requires CURRENT_PAGE source');
    }
    if (!target.sessionId && !target.agentId) {
      throw new Error('CONTINUE_FROM_PAGE requires sessionId or agentId');
    }
  }
}

export function selectionActionNeedsEffectAdmissionV1(operation) {
  if (typeof operation !== 'string') throw new Error('operation must be text');
  if (!OPERATIONS.has(operation)) throw new Error('operation is invalid');
  return EFFECTFUL_OPERATIONS.has(operation);
}

export function normalizeSelectionActionRequestV1(input) {
  const raw = snapshotRecord(input, REQUEST_KEYS, 'SelectionActionRequestV1');
  if (typeof raw.operation !== 'string') throw new Error('operation must be text');
  const operation = raw.operation;
  if (!OPERATIONS.has(operation)) throw new Error('operation is invalid');

  const source = normalizeSelectionActionSourceV1(raw.source);
  const target = normalizeTargetV1(raw.target == null ? {} : raw.target);
  assertOperationTarget(operation, source, target);
  const effectful = EFFECTFUL_OPERATIONS.has(operation);
  const createdAt = timestamp(raw.createdAt, 'createdAt');
  if (Date.parse(source.capturedAt) > Date.parse(createdAt)) {
    throw new Error('source capturedAt cannot be later than request createdAt');
  }

  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'SelectionActionRequestV1'),
    requestId: id(raw.requestId, 'requestId'),
    source,
    operation,
    ownerInstruction: raw.ownerInstruction == null || raw.ownerInstruction === ''
      ? ''
      : boundedText(raw.ownerInstruction, 'ownerInstruction', MAX_OWNER_INSTRUCTION),
    target,
    createdAt,
    advisoryOnly: true,
    instructionAuthority: false,
    permissionGranted: false,
    executionAuthorized: false,
    requiresTrustedInstructionAdmission: true,
    requiresCanonicalExecutionAdmission: true,
    requiresCanonicalPolicyAdmission: true,
    requiresExactEffectAdmission: effectful,
  });
}
