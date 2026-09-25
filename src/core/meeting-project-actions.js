import {
  normalizeProjectSnapshotV1,
  normalizeProjectSourceRefV1,
} from './project-context-artifact.js';
import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const MEETING_PROJECT_ACTIONS_SCHEMA_VERSION = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SOURCES = 64;
const MAX_RECORDINGS = 32;
const MAX_DECISIONS = 128;
const MAX_ACTIONS = 256;
const MAX_EVIDENCE_IDS = 64;
const MAX_SOURCE_IDS = 64;
const MAX_TEXT = 16_000;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_ARRAY = 4096;

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function array(value, label, max, { min = 0 } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a plain dense array`);
  }
  if (value.length < min || value.length > max) {
    throw new Error(`${label} length must be ${min}-${max}`);
  }
  const output = [];
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains non-index fields`);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= value.length) {
      throw new Error(`${label} contains invalid indices`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}[${index}] must be an enumerable own data item`);
    }
    output.push(descriptor.value);
  }
  return output;
}

function jsonData(value, label, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw new Error(`${label} exceeds maximum nesting depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    const items = array(value, label, MAX_JSON_ARRAY);
    for (let index = 0; index < items.length; index += 1) jsonData(items[index], `${label}[${index}]`, depth + 1);
    return value;
  }
  if (value && typeof value === 'object') {
    const raw = record(value, label);
    for (const key of Object.keys(raw)) jsonData(raw[key], `${label}.${key}`, depth + 1);
    return value;
  }
  throw new Error(`${label} must contain JSON data only`);
}

function exact(raw, allowed, label) {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function requireOwn(raw, key, label) {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) throw new Error(`${label}.${key} is required`);
}

function version(value, label) {
  if (value !== MEETING_PROJECT_ACTIONS_SCHEMA_VERSION) throw new Error(`Unsupported ${label} schemaVersion`);
  return MEETING_PROJECT_ACTIONS_SCHEMA_VERSION;
}

function identifier(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function text(value, label, { optional = false, max = MAX_TEXT } = {}) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a safe integer in range`);
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function timestamp(value, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value) throw new Error(`${label} must be a canonical timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return value;
}

function ascii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) throw new Error(`${label} contains duplicate ${key}: ${value}`);
    seen.add(value);
  }
  return items;
}

function idList(value, label, max, { min = 0 } = {}) {
  const ids = array(value, label, max, { min }).map((item, index) => identifier(item, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicates`);
  return ids.sort(ascii);
}

function strictSource(input, label) {
  const raw = record(input, label);
  for (const key of ['schemaVersion','sourceId','projectId','kind','uri','revisionId','contentSha256','observedAt','authority']) {
    requireOwn(raw, key, label);
  }
  version(raw.schemaVersion, label);
  identifier(raw.sourceId, `${label}.sourceId`);
  identifier(raw.projectId, `${label}.projectId`);
  identifier(raw.kind, `${label}.kind`);
  text(raw.uri, `${label}.uri`, { max: 4096 });
  identifier(raw.revisionId, `${label}.revisionId`);
  digest(raw.contentSha256, `${label}.contentSha256`);
  timestamp(raw.observedAt, `${label}.observedAt`);
  if (typeof raw.authority !== 'string' || raw.authority !== raw.authority.trim() || raw.authority !== raw.authority.toUpperCase()) {
    throw new Error(`${label}.authority must be canonical text`);
  }
  if (raw.metadata !== undefined) jsonData(raw.metadata, `${label}.metadata`);
  const normalized = normalizeProjectSourceRefV1(raw);
  if (!normalized.contentSha256) throw new Error(`${label}.contentSha256 must be materialized`);
  return normalized;
}

function strictArtifact(input, label) {
  const raw = record(input, label);
  for (const key of ['schemaVersion','artifactId','kind','uri','sha256','sizeBytes','createdAt','sensitive']) {
    requireOwn(raw, key, label);
  }
  version(raw.schemaVersion, label);
  identifier(raw.artifactId, `${label}.artifactId`);
  identifier(raw.kind, `${label}.kind`);
  text(raw.uri, `${label}.uri`, { max: 4096 });
  if (raw.mediaType !== undefined) text(raw.mediaType, `${label}.mediaType`, { optional: true, max: 300 });
  digest(raw.sha256, `${label}.sha256`);
  integer(raw.sizeBytes, `${label}.sizeBytes`);
  timestamp(raw.createdAt, `${label}.createdAt`);
  if (raw.producerInvocationId !== undefined && raw.producerInvocationId !== null && raw.producerInvocationId !== '') {
    identifier(raw.producerInvocationId, `${label}.producerInvocationId`);
  }
  bool(raw.sensitive, `${label}.sensitive`);
  return normalizeArtifactRefV1(raw);
}

function sourceIdentity(source) {
  return JSON.stringify([
    source.sourceId, source.projectId, source.kind, source.uri, source.revisionId,
    source.contentSha256, source.authority,
  ]);
}

function artifactIdentity(artifact) {
  return JSON.stringify([
    artifact.artifactId, artifact.kind, artifact.uri, artifact.mediaType || '',
    artifact.sha256, artifact.sizeBytes, artifact.createdAt,
    artifact.producerInvocationId || '', artifact.sensitive,
  ]);
}

function sourceBinding(source) {
  return freeze({
    sourceId: source.sourceId,
    revisionId: source.revisionId,
    contentSha256: source.contentSha256,
  });
}

function artifactBinding(artifact) {
  return freeze({
    artifactId: artifact.artifactId,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
  });
}

const BUNDLE_KEYS = new Set([
  'schemaVersion','meetingId','projectId','meetingRevisionId','sourceRefs',
  'transcriptArtifactRef','recordingArtifactRefs','observedAt',
]);

export function normalizeMeetingEvidenceBundleV1(input) {
  const raw = record(input, 'MeetingEvidenceBundleV1');
  exact(raw, BUNDLE_KEYS, 'MeetingEvidenceBundleV1');
  const projectId = identifier(raw.projectId, 'projectId');
  const sourceRefs = unique(
    array(raw.sourceRefs, 'sourceRefs', MAX_SOURCES, { min: 1 }).map((item, index) => {
      const source = strictSource(item, `sourceRefs[${index}]`);
      if (source.projectId !== projectId) throw new Error(`sourceRefs[${index}] projectId mismatch`);
      return source;
    }),
    'sourceId',
    'sourceRefs',
  ).sort((a, b) => ascii(a.sourceId, b.sourceId));

  const transcriptArtifactRef = strictArtifact(raw.transcriptArtifactRef, 'transcriptArtifactRef');
  const recordingArtifactRefs = unique(
    array(raw.recordingArtifactRefs, 'recordingArtifactRefs', MAX_RECORDINGS).map(
      (item, index) => strictArtifact(item, `recordingArtifactRefs[${index}]`),
    ),
    'artifactId',
    'recordingArtifactRefs',
  ).sort((a, b) => ascii(a.artifactId, b.artifactId));
  if (recordingArtifactRefs.some(item => item.artifactId === transcriptArtifactRef.artifactId)) {
    throw new Error('transcriptArtifactRef and recordingArtifactRefs must have distinct artifactId values');
  }

  return freeze({
    schemaVersion: version(raw.schemaVersion, 'MeetingEvidenceBundleV1'),
    meetingId: identifier(raw.meetingId, 'meetingId'),
    projectId,
    meetingRevisionId: identifier(raw.meetingRevisionId, 'meetingRevisionId'),
    sourceRefs,
    transcriptArtifactRef,
    recordingArtifactRefs,
    observedAt: timestamp(raw.observedAt, 'observedAt'),
  });
}

export function meetingEvidenceBindingFromBundleV1(bundle) {
  const normalized = normalizeMeetingEvidenceBundleV1(bundle);
  return freeze({
    meetingId: normalized.meetingId,
    projectId: normalized.projectId,
    meetingRevisionId: normalized.meetingRevisionId,
    sourceBindings: normalized.sourceRefs.map(sourceBinding),
    transcriptArtifactBinding: artifactBinding(normalized.transcriptArtifactRef),
    recordingArtifactBindings: normalized.recordingArtifactRefs.map(artifactBinding),
  });
}

const SOURCE_BINDING_KEYS = new Set(['sourceId','revisionId','contentSha256']);
function normalizeSourceBinding(input, label) {
  const raw = record(input, label);
  exact(raw, SOURCE_BINDING_KEYS, label);
  return freeze({
    sourceId: identifier(raw.sourceId, `${label}.sourceId`),
    revisionId: identifier(raw.revisionId, `${label}.revisionId`),
    contentSha256: digest(raw.contentSha256, `${label}.contentSha256`),
  });
}

const ARTIFACT_BINDING_KEYS = new Set(['artifactId','sha256','sizeBytes']);
function normalizeArtifactBinding(input, label) {
  const raw = record(input, label);
  exact(raw, ARTIFACT_BINDING_KEYS, label);
  return freeze({
    artifactId: identifier(raw.artifactId, `${label}.artifactId`),
    sha256: digest(raw.sha256, `${label}.sha256`),
    sizeBytes: integer(raw.sizeBytes, `${label}.sizeBytes`),
  });
}

const MEETING_BINDING_KEYS = new Set([
  'meetingId','projectId','meetingRevisionId','sourceBindings',
  'transcriptArtifactBinding','recordingArtifactBindings',
]);

export function normalizeMeetingEvidenceBindingV1(input) {
  const raw = record(input, 'MeetingEvidenceBindingV1');
  exact(raw, MEETING_BINDING_KEYS, 'MeetingEvidenceBindingV1');
  const sourceBindings = unique(
    array(raw.sourceBindings, 'sourceBindings', MAX_SOURCES, { min: 1 }).map(
      (item, index) => normalizeSourceBinding(item, `sourceBindings[${index}]`),
    ),
    'sourceId',
    'sourceBindings',
  ).sort((a, b) => ascii(a.sourceId, b.sourceId));
  const transcriptArtifactBinding = normalizeArtifactBinding(raw.transcriptArtifactBinding, 'transcriptArtifactBinding');
  const recordingArtifactBindings = unique(
    array(raw.recordingArtifactBindings, 'recordingArtifactBindings', MAX_RECORDINGS).map(
      (item, index) => normalizeArtifactBinding(item, `recordingArtifactBindings[${index}]`),
    ),
    'artifactId',
    'recordingArtifactBindings',
  ).sort((a, b) => ascii(a.artifactId, b.artifactId));
  if (recordingArtifactBindings.some(item => item.artifactId === transcriptArtifactBinding.artifactId)) {
    throw new Error('transcript and recording bindings must be distinct');
  }
  return freeze({
    meetingId: identifier(raw.meetingId, 'meetingId'),
    projectId: identifier(raw.projectId, 'projectId'),
    meetingRevisionId: identifier(raw.meetingRevisionId, 'meetingRevisionId'),
    sourceBindings,
    transcriptArtifactBinding,
    recordingArtifactBindings,
  });
}

const DECISION_KEYS = new Set([
  'decisionId','statement','evidenceArtifactIds','sourceIds','status',
]);

function normalizeDecision(input, label) {
  const raw = record(input, label);
  exact(raw, DECISION_KEYS, label);
  if (raw.status !== 'PROPOSED') throw new Error(`${label}.status must be PROPOSED`);
  return freeze({
    decisionId: identifier(raw.decisionId, `${label}.decisionId`),
    statement: text(raw.statement, `${label}.statement`, { max: 8000 }),
    evidenceArtifactIds: idList(raw.evidenceArtifactIds, `${label}.evidenceArtifactIds`, MAX_EVIDENCE_IDS, { min: 1 }),
    sourceIds: idList(raw.sourceIds, `${label}.sourceIds`, MAX_SOURCE_IDS, { min: 1 }),
    status: 'PROPOSED',
  });
}

const ACTION_KEYS = new Set([
  'actionItemId','title','details','assigneeRef','dueAt','evidenceArtifactIds','sourceIds','status',
]);

function normalizeAction(input, label) {
  const raw = record(input, label);
  exact(raw, ACTION_KEYS, label);
  if (raw.status !== 'PROPOSED') throw new Error(`${label}.status must be PROPOSED`);
  return freeze({
    actionItemId: identifier(raw.actionItemId, `${label}.actionItemId`),
    title: text(raw.title, `${label}.title`, { max: 1000 }),
    details: text(raw.details, `${label}.details`, { optional: true, max: 8000 }),
    assigneeRef: raw.assigneeRef === undefined || raw.assigneeRef === ''
      ? ''
      : identifier(raw.assigneeRef, `${label}.assigneeRef`),
    dueAt: timestamp(raw.dueAt, `${label}.dueAt`, { optional: true }),
    evidenceArtifactIds: idList(raw.evidenceArtifactIds, `${label}.evidenceArtifactIds`, MAX_EVIDENCE_IDS, { min: 1 }),
    sourceIds: idList(raw.sourceIds, `${label}.sourceIds`, MAX_SOURCE_IDS, { min: 1 }),
    status: 'PROPOSED',
  });
}

const RESULT_KEYS = new Set([
  'schemaVersion','resultId','meetingBinding','decisions','actionItems','generatedAt',
  'advisoryOnly','taskCreationAuthorized','calendarMutationAuthorized',
  'messageSendAuthorized','identityAuthority',
]);

export function normalizeMeetingProjectActionsV1(input) {
  const raw = record(input, 'MeetingProjectActionsV1');
  exact(raw, RESULT_KEYS, 'MeetingProjectActionsV1');
  if (raw.advisoryOnly !== true) throw new Error('MeetingProjectActionsV1 must be advisoryOnly');
  if (raw.taskCreationAuthorized !== false) throw new Error('MeetingProjectActionsV1 cannot authorize Task creation');
  if (raw.calendarMutationAuthorized !== false) throw new Error('MeetingProjectActionsV1 cannot authorize Calendar mutation');
  if (raw.messageSendAuthorized !== false) throw new Error('MeetingProjectActionsV1 cannot authorize message send');
  if (raw.identityAuthority !== 'UNVERIFIED_REFERENCES') throw new Error('identityAuthority must remain UNVERIFIED_REFERENCES');

  const meetingBinding = normalizeMeetingEvidenceBindingV1(raw.meetingBinding);
  const decisions = unique(
    array(raw.decisions, 'decisions', MAX_DECISIONS).map((item, index) => normalizeDecision(item, `decisions[${index}]`)),
    'decisionId',
    'decisions',
  ).sort((a, b) => ascii(a.decisionId, b.decisionId));
  const actionItems = unique(
    array(raw.actionItems, 'actionItems', MAX_ACTIONS).map((item, index) => normalizeAction(item, `actionItems[${index}]`)),
    'actionItemId',
    'actionItems',
  ).sort((a, b) => ascii(a.actionItemId, b.actionItemId));

  const sourceIds = new Set(meetingBinding.sourceBindings.map(item => item.sourceId));
  const artifactIds = new Set([
    meetingBinding.transcriptArtifactBinding.artifactId,
    ...meetingBinding.recordingArtifactBindings.map(item => item.artifactId),
  ]);
  for (const proposal of [...decisions, ...actionItems]) {
    for (const sourceId of proposal.sourceIds) {
      if (!sourceIds.has(sourceId)) throw new Error(`proposal cites unknown meeting source: ${sourceId}`);
    }
    for (const artifactId of proposal.evidenceArtifactIds) {
      if (!artifactIds.has(artifactId)) throw new Error(`proposal cites unknown meeting evidence artifact: ${artifactId}`);
    }
  }

  return freeze({
    schemaVersion: version(raw.schemaVersion, 'MeetingProjectActionsV1'),
    resultId: identifier(raw.resultId, 'resultId'),
    meetingBinding,
    decisions,
    actionItems,
    generatedAt: timestamp(raw.generatedAt, 'generatedAt'),
    advisoryOnly: true,
    taskCreationAuthorized: false,
    calendarMutationAuthorized: false,
    messageSendAuthorized: false,
    identityAuthority: 'UNVERIFIED_REFERENCES',
  });
}

function bindingIdentity(binding) {
  return JSON.stringify([
    binding.meetingId,
    binding.projectId,
    binding.meetingRevisionId,
    binding.sourceBindings.map(item => [item.sourceId, item.revisionId, item.contentSha256]),
    [binding.transcriptArtifactBinding.artifactId, binding.transcriptArtifactBinding.sha256, binding.transcriptArtifactBinding.sizeBytes],
    binding.recordingArtifactBindings.map(item => [item.artifactId, item.sha256, item.sizeBytes]),
  ]);
}

export function assertMeetingProjectActionsMatchesEvidenceV1({ result, evidenceBundle } = {}) {
  const normalizedResult = normalizeMeetingProjectActionsV1(result);
  const expected = normalizeMeetingEvidenceBindingV1(meetingEvidenceBindingFromBundleV1(evidenceBundle));
  if (bindingIdentity(normalizedResult.meetingBinding) !== bindingIdentity(expected)) {
    throw new Error('MeetingProjectActionsV1 does not bind the exact MeetingEvidenceBundleV1');
  }
  return normalizedResult;
}

export function assertMeetingEvidenceMatchesProjectSnapshotV1({ evidenceBundle, projectSnapshot } = {}) {
  const evidence = normalizeMeetingEvidenceBundleV1(evidenceBundle);
  jsonData(projectSnapshot, 'projectSnapshot');
  const project = normalizeProjectSnapshotV1(projectSnapshot);
  if (project.projectId !== evidence.projectId) throw new Error('meeting evidence projectId does not match ProjectSnapshotV1');

  const projectSources = new Map(project.sourceRefs.map(source => [source.sourceId, source]));
  for (const source of evidence.sourceRefs) {
    const admitted = projectSources.get(source.sourceId);
    if (!admitted || sourceIdentity(admitted) !== sourceIdentity(source)) {
      throw new Error(`meeting source is not admitted by ProjectSnapshotV1: ${source.sourceId}`);
    }
  }

  const projectArtifacts = new Map(project.artifactRefs.map(artifact => [artifact.artifactId, artifact]));
  for (const artifact of [evidence.transcriptArtifactRef, ...evidence.recordingArtifactRefs]) {
    const admitted = projectArtifacts.get(artifact.artifactId);
    if (!admitted || artifactIdentity(admitted) !== artifactIdentity(artifact)) {
      throw new Error(`meeting artifact is not admitted by ProjectSnapshotV1: ${artifact.artifactId}`);
    }
  }

  return freeze({
    evidence,
    projectId: project.projectId,
    projectRevisionId: project.revisionId,
    advisoryOnly: true,
    admissionAuthorized: false,
  });
}

export function assessMeetingEvidenceFreshnessV1(evidenceBundle, currentSourceRefs = []) {
  const evidence = normalizeMeetingEvidenceBundleV1(evidenceBundle);
  const current = unique(
    array(currentSourceRefs, 'currentSourceRefs', MAX_SOURCES).map((item, index) => {
      const source = strictSource(item, `currentSourceRefs[${index}]`);
      if (source.projectId !== evidence.projectId) throw new Error(`currentSourceRefs[${index}] projectId mismatch`);
      return source;
    }),
    'sourceId',
    'currentSourceRefs',
  );
  const currentById = new Map(current.map(source => [source.sourceId, source]));
  const sources = evidence.sourceRefs.map(expected => {
    const actual = currentById.get(expected.sourceId) || null;
    const reasons = [];
    if (!actual) {
      reasons.push('CURRENT_SOURCE_MISSING');
    } else {
      if (actual.kind !== expected.kind) reasons.push('KIND_CHANGED');
      if (actual.uri !== expected.uri) reasons.push('URI_CHANGED');
      if (actual.authority !== expected.authority) reasons.push('AUTHORITY_CHANGED');
      if (actual.revisionId !== expected.revisionId) reasons.push('REVISION_CHANGED');
      if (actual.contentSha256 !== expected.contentSha256) reasons.push('CONTENT_CHANGED');
    }
    return freeze({
      sourceId: expected.sourceId,
      status: reasons.length ? 'STALE' : 'FRESH',
      reasons,
      expectedRevisionId: expected.revisionId,
      currentRevisionId: actual?.revisionId || null,
    });
  }).sort((a, b) => ascii(a.sourceId, b.sourceId));
  const staleSourceCount = sources.filter(item => item.status === 'STALE').length;
  return freeze({
    schemaVersion: MEETING_PROJECT_ACTIONS_SCHEMA_VERSION,
    meetingId: evidence.meetingId,
    meetingRevisionId: evidence.meetingRevisionId,
    advisoryOnly: true,
    status: staleSourceCount ? 'STALE' : 'FRESH',
    staleSourceCount,
    sources,
  });
}
