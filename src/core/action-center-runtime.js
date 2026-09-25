import {
  ActionCenterItemStatus,
  ActionCenterOwnerActionKind,
  ActionCenterSeverity,
  ActionCenterSourceKind,
  buildActionCenterProjectionV1,
} from './action-center-contract.js';

const UNRESOLVED_CORE_PHASES = new Set(['AMBIGUOUS', 'MANUAL_REVIEW']);
const IDENTITY_DOMAIN = 'chatgpt-autopilot-action-center-runtime-v1';

function finiteTimestamp(value, fallback = 0) {
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0) return number;
  const fallbackNumber = Number(fallback);
  return Number.isFinite(fallbackNumber) && fallbackNumber >= 0 ? fallbackNumber : 0;
}

function iso(value) {
  return new Date(finiteTimestamp(value)).toISOString();
}

function displayName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().replace(/\s+/gu, ' ');
  return clean ? clean.slice(0, 100) : fallback;
}

function canonicalRecords(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function digestHex(value, cryptoApi) {
  if (!cryptoApi?.subtle?.digest) throw new Error('Action Center runtime requires Web Crypto SHA-256');
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function identity(kind, key, cryptoApi) {
  return digestHex(`${IDENTITY_DOMAIN}|${kind}|${key}`, cryptoApi);
}

async function revision(kind, parts, cryptoApi) {
  return `sha256:${await digestHex(`${IDENTITY_DOMAIN}|revision|${kind}|${parts.join('|')}`, cryptoApi)}`;
}

function itemBase({ itemId, severity, ownerActionKind, title, materialityReason, sourceKind, sourceId, sourceRevisionId, sourceEffectId = '', createdAt, updatedAt }) {
  return {
    schemaVersion: 1,
    itemId,
    status: ActionCenterItemStatus.OPEN,
    severity,
    ownerActionKind,
    title,
    materialityReason,
    sourceKind,
    sourceId,
    sourceRevisionId,
    sourceEffectId,
    evidenceArtifactIds: [],
    createdAt: iso(createdAt),
    updatedAt: iso(updatedAt),
    closedAt: '',
    supersededByItemId: '',
  };
}

async function projectCoreAttention(coreState, items, cryptoApi) {
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
      const key = `${rawId}|${String(operation.operationId || '')}`;
      const hex = await identity('core-effect', key, cryptoApi);
      const sourceId = `sha256:${hex}`;
      const updatedAt = finiteTimestamp(operation.updatedAt, session.updatedAt);
      const createdAt = finiteTimestamp(operation.createdAt, updatedAt);
      items.push(itemBase({
        itemId: `ac:core-effect:${hex}`,
        severity: ActionCenterSeverity.BLOCKING,
        ownerActionKind: phase === 'AMBIGUOUS'
          ? ActionCenterOwnerActionKind.RECONCILE
          : ActionCenterOwnerActionKind.REVIEW,
        title: `${name}: unresolved effect`,
        materialityReason: phase === 'AMBIGUOUS'
          ? 'A durable Core operation has an ambiguous external effect and must be reconciled before retry.'
          : 'A durable Core operation is in manual-review state and cannot continue automatically.',
        sourceKind: ActionCenterSourceKind.EFFECT,
        sourceId,
        sourceEffectId: sourceId,
        sourceRevisionId: await revision('core-effect', [
          rawId, String(operation.operationId || ''), phase, String(updatedAt),
        ], cryptoApi),
        createdAt,
        updatedAt,
      }));
      continue;
    }

    if (session.runState === 'ERROR') {
      const hex = await identity('core-session-error', rawId, cryptoApi);
      const updatedAt = finiteTimestamp(session.updatedAt, session.lastActionAt);
      const createdAt = finiteTimestamp(session.createdAt, updatedAt);
      items.push(itemBase({
        itemId: `ac:core-error:${hex}`,
        severity: ActionCenterSeverity.HIGH,
        ownerActionKind: ActionCenterOwnerActionKind.REVIEW,
        title: `${name}: execution error`,
        materialityReason: 'A durable Core session is in ERROR state and needs owner review before normal execution can resume.',
        sourceKind: ActionCenterSourceKind.JOB,
        sourceId: `sha256:${hex}`,
        sourceRevisionId: await revision('core-session-error', [
          rawId, String(updatedAt), String(session.lastError || ''),
        ], cryptoApi),
        createdAt,
        updatedAt,
      }));
    }
  }
}

async function projectBrowserAgentAttention(agentJobs, items, cryptoApi) {
  if (!Array.isArray(agentJobs)) return;
  for (const job of agentJobs) {
    if (!job || typeof job !== 'object' || typeof job.id !== 'string') continue;
    const runtime = job.runtime && typeof job.runtime === 'object' ? job.runtime : {};
    const name = displayName(job.config?.name, 'Browser Agent');
    const updatedAt = finiteTimestamp(runtime.updatedAt, job.updatedAt);
    const createdAt = finiteTimestamp(job.createdAt, updatedAt);

    if (runtime.pendingApproval && typeof runtime.pendingApproval === 'object') {
      const snapshot = typeof runtime.pendingApproval.snapshotSignature === 'string'
        ? runtime.pendingApproval.snapshotSignature
        : '';
      const hex = await identity('browser-agent-approval', `${job.id}|${snapshot}`, cryptoApi);
      items.push(itemBase({
        itemId: `ac:agent-approval:${hex}`,
        severity: ActionCenterSeverity.BLOCKING,
        ownerActionKind: ActionCenterOwnerActionKind.APPROVE_OR_DENY,
        title: `${name}: approval required`,
        materialityReason: 'A durable Browser Agent job has a pending consequential action. Approve or reject it through the existing Browser Agent control.',
        sourceKind: ActionCenterSourceKind.APPROVAL,
        sourceId: `sha256:${hex}`,
        sourceRevisionId: await revision('browser-agent-approval', [
          job.id, snapshot, String(updatedAt),
        ], cryptoApi),
        createdAt: updatedAt || createdAt,
        updatedAt,
      }));
      continue;
    }

    if (runtime.runState === 'ERROR') {
      const hex = await identity('browser-agent-error', job.id, cryptoApi);
      items.push(itemBase({
        itemId: `ac:agent-error:${hex}`,
        severity: ActionCenterSeverity.HIGH,
        ownerActionKind: ActionCenterOwnerActionKind.REVIEW,
        title: `${name}: execution error`,
        materialityReason: 'A durable Browser Agent job is in ERROR state and needs owner review before normal execution can resume.',
        sourceKind: ActionCenterSourceKind.JOB,
        sourceId: `sha256:${hex}`,
        sourceRevisionId: await revision('browser-agent-error', [
          job.id, String(updatedAt), String(runtime.lastError || ''),
        ], cryptoApi),
        createdAt,
        updatedAt,
      }));
    }
  }
}

export async function projectRuntimeActionCenter({
  coreState = {},
  agentJobs = [],
  cryptoApi = globalThis.crypto,
} = {}) {
  const items = [];
  await projectCoreAttention(coreState, items, cryptoApi);
  await projectBrowserAgentAttention(agentJobs, items, cryptoApi);
  return buildActionCenterProjectionV1(items);
}
