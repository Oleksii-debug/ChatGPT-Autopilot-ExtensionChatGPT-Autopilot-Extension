import {
  MAX_ACTION_CENTER_ITEMS,
  ActionCenterItemStatus,
  ActionCenterOwnerActionKind,
  ActionCenterSeverity,
  ActionCenterSourceKind,
  buildActionCenterProjectionV1,
} from './action-center-contract.js';

const UNRESOLVED_CORE_PHASES = new Set(['AMBIGUOUS', 'MANUAL_REVIEW']);
const IDENTITY_DOMAIN = 'chatgpt-autopilot-action-center-runtime-v1';
const MAX_DATE_MS = 8_640_000_000_000_000;
const SEVERITY_RANK = Object.freeze({
  [ActionCenterSeverity.BLOCKING]: 0,
  [ActionCenterSeverity.HIGH]: 1,
  [ActionCenterSeverity.NORMAL]: 2,
  [ActionCenterSeverity.LOW]: 3,
});

function finiteTimestamp(value, fallback = 0) {
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0 && number <= MAX_DATE_MS) return number;
  const fallbackNumber = Number(fallback);
  return Number.isFinite(fallbackNumber) && fallbackNumber >= 0 && fallbackNumber <= MAX_DATE_MS
    ? fallbackNumber
    : 0;
}

function iso(value) {
  return new Date(finiteTimestamp(value)).toISOString();
}

function displayName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const clean = value
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
  return clean ? clean.slice(0, 100) : fallback;
}

function canonicalRecords(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const PROJECT_RUNTIME_INPUT_KEYS = new Set(['coreState', 'agentJobs', 'cryptoApi']);
const RESOLVE_RUNTIME_INPUT_KEYS = new Set([
  'coreState',
  'agentJobs',
  'itemId',
  'sourceRevisionId',
  'decision',
  'cryptoApi',
]);
const BROWSER_JOB_FIELDS = ['id', 'config', 'createdAt', 'updatedAt', 'runtime'];
const BROWSER_CONFIG_FIELDS = ['name'];
const BROWSER_RUNTIME_FIELDS = [
  'runState',
  'controlEpoch',
  'updatedAt',
  'lastError',
  'pendingApproval',
];
const BROWSER_PENDING_FIELDS = [
  'snapshotId',
  'snapshotSignature',
  'requestedAt',
  'action',
];

function snapshotExactOptions(input, allowed, label) {
  const value = input == null ? {} : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain or null-prototype object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain or null-prototype object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function snapshotSelectedFields(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const out = Object.create(null);
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor) continue;
    if (descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return null;
    }
    out[field] = descriptor.value;
  }
  return Object.freeze(out);
}

function isPlainEnumerableDataRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') return false;
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return false;
    }
  }
  return true;
}

function snapshotDenseArrayValues(input) {
  if (!Array.isArray(input)) return Object.freeze([]);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0) return Object.freeze([]);
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return Object.freeze([]);
    }
    out.push(descriptor.value);
  }
  return Object.freeze(out);
}

function snapshotBrowserAgentJob(input) {
  const job = snapshotSelectedFields(input, BROWSER_JOB_FIELDS);
  if (!job || typeof job.id !== 'string') return null;

  const config = job.config == null
    ? Object.freeze(Object.create(null))
    : snapshotSelectedFields(job.config, BROWSER_CONFIG_FIELDS);
  if (!config) return null;

  const runtime = job.runtime == null
    ? Object.freeze(Object.create(null))
    : snapshotSelectedFields(job.runtime, BROWSER_RUNTIME_FIELDS);
  if (!runtime) return null;

  let pendingApproval = null;
  if (runtime.pendingApproval != null) {
    const pending = snapshotSelectedFields(runtime.pendingApproval, BROWSER_PENDING_FIELDS);
    if (!pending) return null;
    const hasAction = pending.action != null && isPlainEnumerableDataRecord(pending.action);
    pendingApproval = Object.freeze({
      snapshotId: pending.snapshotId,
      snapshotSignature: pending.snapshotSignature,
      requestedAt: pending.requestedAt,
      hasAction,
    });
  }

  return Object.freeze({
    id: job.id,
    config: Object.freeze({ name: config.name }),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    runtime: Object.freeze({
      runState: runtime.runState,
      controlEpoch: runtime.controlEpoch,
      updatedAt: runtime.updatedAt,
      lastError: runtime.lastError,
      pendingApproval,
    }),
  });
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function digestHex(value, cryptoApi) {
  if (!cryptoApi?.subtle?.digest) throw new Error('Action Center runtime requires Web Crypto SHA-256');
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function revision(kind, parts, cryptoApi) {
  return `sha256:${await digestHex(`${IDENTITY_DOMAIN}|revision|${kind}|${parts.join('|')}`, cryptoApi)}`;
}

function addCoreCandidates(coreState, candidates) {
  const sessionsById = canonicalRecords(coreState?.sessionsById);
  const order = Array.isArray(coreState?.sessionOrder) ? coreState.sessionOrder : Object.keys(sessionsById);
  const seen = new Set();
  for (const rawId of order) {
    if (typeof rawId !== 'string' || seen.has(rawId)) continue;
    seen.add(rawId);
    const session = sessionsById[rawId];
    if (!session || typeof session !== 'object') continue;
    const operation = session.operation && typeof session.operation === 'object' ? session.operation : null;
    const phase = typeof operation?.phase === 'string' ? operation.phase : '';
    const name = displayName(session.name, 'Core session');

    if (operation && UNRESOLVED_CORE_PHASES.has(phase)) {
      const updatedAt = finiteTimestamp(operation.updatedAt, session.updatedAt);
      candidates.push({
        identityKind: 'core-effect',
        identityKey: `${rawId}|${String(operation.operationId || '')}`,
        revisionKind: 'core-effect',
        revisionParts: [rawId, String(operation.operationId || ''), phase, String(updatedAt)],
        severity: ActionCenterSeverity.BLOCKING,
        ownerActionKind: phase === 'AMBIGUOUS'
          ? ActionCenterOwnerActionKind.RECONCILE
          : ActionCenterOwnerActionKind.REVIEW,
        title: `${name}: unresolved effect`,
        materialityReason: phase === 'AMBIGUOUS'
          ? 'A durable Core operation has an ambiguous external effect and must be reconciled before retry.'
          : 'A durable Core operation is in manual-review state and cannot continue automatically.',
        sourceKind: ActionCenterSourceKind.EFFECT,
        sourceEffectId: true,
        createdAt: finiteTimestamp(operation.createdAt, updatedAt),
        updatedAt,
      });
      continue;
    }

    if (session.runState === 'ERROR') {
      const updatedAt = finiteTimestamp(session.updatedAt, session.lastActionAt);
      candidates.push({
        identityKind: 'core-session-error',
        identityKey: rawId,
        revisionKind: 'core-session-error',
        revisionParts: [rawId, String(updatedAt), String(session.lastError || '')],
        severity: ActionCenterSeverity.HIGH,
        ownerActionKind: ActionCenterOwnerActionKind.REVIEW,
        title: `${name}: execution error`,
        materialityReason: 'A durable Core session is in ERROR state and needs owner review before normal execution can resume.',
        sourceKind: ActionCenterSourceKind.JOB,
        sourceEffectId: false,
        createdAt: finiteTimestamp(session.createdAt, updatedAt),
        updatedAt,
      });
    }
  }
}

function browserApprovalOwnerReference(job, runtime, pending) {
  if (!job || typeof job.id !== 'string' || !runtime || !pending || typeof pending !== 'object') return null;
  const controlEpoch = runtime.controlEpoch;
  const updatedAt = runtime.updatedAt;
  const requestedAt = pending.requestedAt;
  const snapshotId = pending.snapshotId;
  const snapshotSignature = pending.snapshotSignature;
  if (!Number.isSafeInteger(controlEpoch) || Object.is(controlEpoch, -0) || controlEpoch < 0
      || !Number.isSafeInteger(updatedAt) || Object.is(updatedAt, -0) || updatedAt < 0
      || !Number.isSafeInteger(requestedAt) || Object.is(requestedAt, -0) || requestedAt < 0
      || typeof snapshotId !== 'string' || snapshotId.length < 1 || snapshotId.length > 160
      || typeof snapshotSignature !== 'string'
      || snapshotSignature.length < 1
      || snapshotSignature.length > 256) {
    return null;
  }
  return Object.freeze({
    jobId: job.id,
    expectedApproval: Object.freeze({
      controlEpoch,
      updatedAt,
      snapshotId,
      snapshotSignature,
      requestedAt,
    }),
  });
}

function addBrowserAgentCandidates(agentJobs, candidates) {
  for (const rawJob of snapshotDenseArrayValues(agentJobs)) {
    const job = snapshotBrowserAgentJob(rawJob);
    if (!job) continue;
    const runtime = job.runtime;
    const pending = runtime.pendingApproval;
    const name = displayName(job.config.name, 'Browser Agent');
    const updatedAt = finiteTimestamp(runtime.updatedAt, job.updatedAt);
    const createdAt = finiteTimestamp(job.createdAt, updatedAt);

    if (runtime.runState === 'WAITING_APPROVAL' && pending?.hasAction === true) {
      const snapshot = typeof pending.snapshotSignature === 'string'
        ? pending.snapshotSignature
        : '';
      const ownerReference = browserApprovalOwnerReference(job, runtime, pending);
      if (!ownerReference) continue;
      candidates.push({
        identityKind: 'browser-agent-approval',
        identityKey: `${job.id}|${snapshot}`,
        revisionKind: 'browser-agent-approval',
        revisionParts: [
          job.id,
          snapshot,
          ownerReference.expectedApproval.snapshotId,
          String(ownerReference.expectedApproval.requestedAt),
          String(ownerReference.expectedApproval.controlEpoch),
          String(updatedAt),
        ],
        ownerReference,
        severity: ActionCenterSeverity.BLOCKING,
        ownerActionKind: ActionCenterOwnerActionKind.APPROVE_OR_DENY,
        title: `${name}: approval required`,
        materialityReason: 'A durable Browser Agent job has a pending consequential action. Approve or reject it through the existing Browser Agent control.',
        sourceKind: ActionCenterSourceKind.APPROVAL,
        sourceEffectId: false,
        createdAt: updatedAt || createdAt,
        updatedAt,
      });
      continue;
    }

    if (runtime.runState === 'ERROR') {
      candidates.push({
        identityKind: 'browser-agent-error',
        identityKey: job.id,
        revisionKind: 'browser-agent-error',
        revisionParts: [job.id, String(updatedAt), String(runtime.lastError || '')],
        severity: ActionCenterSeverity.HIGH,
        ownerActionKind: ActionCenterOwnerActionKind.REVIEW,
        title: `${name}: execution error`,
        materialityReason: 'A durable Browser Agent job is in ERROR state and needs owner review before normal execution can resume.',
        sourceKind: ActionCenterSourceKind.JOB,
        sourceEffectId: false,
        createdAt,
        updatedAt,
      });
    }
  }
}

function selectCandidates(candidates) {
  return [...candidates].sort((left, right) => (
    (SEVERITY_RANK[left.severity] ?? 99) - (SEVERITY_RANK[right.severity] ?? 99)
    || left.createdAt - right.createdAt
    || compare(left.identityKind, right.identityKind)
    || compare(left.identityKey, right.identityKey)
  )).slice(0, MAX_ACTION_CENTER_ITEMS);
}

async function materializeCandidate(candidate, cryptoApi) {
  const hex = await digestHex(
    `${IDENTITY_DOMAIN}|${candidate.identityKind}|${candidate.identityKey}`,
    cryptoApi,
  );
  const sourceId = `sha256:${hex}`;
  return {
    schemaVersion: 1,
    itemId: `ac:${candidate.identityKind}:${hex}`,
    status: ActionCenterItemStatus.OPEN,
    severity: candidate.severity,
    ownerActionKind: candidate.ownerActionKind,
    title: candidate.title,
    materialityReason: candidate.materialityReason,
    sourceKind: candidate.sourceKind,
    sourceId,
    sourceRevisionId: await revision(candidate.revisionKind, candidate.revisionParts, cryptoApi),
    sourceEffectId: candidate.sourceEffectId ? sourceId : '',
    evidenceArtifactIds: [],
    createdAt: iso(candidate.createdAt),
    updatedAt: iso(candidate.updatedAt),
    closedAt: '',
    supersededByItemId: '',
  };
}

function runtimeCandidates(coreState, agentJobs) {
  const candidates = [];
  addCoreCandidates(coreState, candidates);
  addBrowserAgentCandidates(agentJobs, candidates);
  return candidates;
}

function exactLookupId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 300) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export async function projectRuntimeActionCenter(input = {}) {
  const raw = snapshotExactOptions(input, PROJECT_RUNTIME_INPUT_KEYS, 'Action Center projection input');
  const coreState = Object.prototype.hasOwnProperty.call(raw, 'coreState') ? raw.coreState : {};
  const agentJobs = Object.prototype.hasOwnProperty.call(raw, 'agentJobs') ? raw.agentJobs : [];
  const cryptoApi = Object.prototype.hasOwnProperty.call(raw, 'cryptoApi') ? raw.cryptoApi : globalThis.crypto;
  const candidates = runtimeCandidates(coreState, agentJobs);
  const selected = selectCandidates(candidates);
  const items = await Promise.all(selected.map(candidate => materializeCandidate(candidate, cryptoApi)));
  const projection = buildActionCenterProjectionV1(items);
  return Object.freeze({
    ...projection,
    runtimeSummary: Object.freeze({
      candidateCount: candidates.length,
      projectedCount: items.length,
      truncated: candidates.length > items.length,
    }),
  });
}

export async function resolveRuntimeActionCenterBrowserApproval(input = {}) {
  const raw = snapshotExactOptions(input, RESOLVE_RUNTIME_INPUT_KEYS, 'Action Center approval input');
  const coreState = Object.prototype.hasOwnProperty.call(raw, 'coreState') ? raw.coreState : {};
  const agentJobs = Object.prototype.hasOwnProperty.call(raw, 'agentJobs') ? raw.agentJobs : [];
  const itemId = raw.itemId;
  const sourceRevisionId = raw.sourceRevisionId;
  const decision = raw.decision;
  const cryptoApi = Object.prototype.hasOwnProperty.call(raw, 'cryptoApi') ? raw.cryptoApi : globalThis.crypto;
  const exactItemId = exactLookupId(itemId, 'Action Center itemId');
  const exactRevisionId = exactLookupId(sourceRevisionId, 'Action Center sourceRevisionId');
  if (decision !== 'APPROVE' && decision !== 'REJECT') throw new Error('Action Center approval decision is invalid');

  const selected = selectCandidates(runtimeCandidates(coreState, agentJobs));
  const items = await Promise.all(selected.map(candidate => materializeCandidate(candidate, cryptoApi)));
  const index = items.findIndex(item => item.itemId === exactItemId);
  if (index < 0) throw new Error('Action Center item is no longer current');
  const item = items[index];
  const candidate = selected[index];
  if (item.sourceRevisionId !== exactRevisionId) throw new Error('Action Center item revision is stale');
  if (item.status !== ActionCenterItemStatus.OPEN
      || item.sourceKind !== ActionCenterSourceKind.APPROVAL
      || item.ownerActionKind !== ActionCenterOwnerActionKind.APPROVE_OR_DENY
      || candidate.identityKind !== 'browser-agent-approval'
      || !candidate.ownerReference) {
    throw new Error('Action Center item is not an actionable Browser Agent approval');
  }
  return Object.freeze({
    decision,
    jobId: candidate.ownerReference.jobId,
    expectedApproval: candidate.ownerReference.expectedApproval,
  });
}
