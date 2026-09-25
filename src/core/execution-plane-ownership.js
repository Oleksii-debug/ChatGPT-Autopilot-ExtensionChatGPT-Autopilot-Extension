import { AgentExecutionPlane } from './agent-plan.js';

export const EXECUTION_OWNERSHIP_VERSION = 1;
export const ExecutionOwnershipState = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  OWNED: 'OWNED',
  HANDOFF_PENDING: 'HANDOFF_PENDING',
  RECONCILE: 'RECONCILE',
  VERIFIED: 'VERIFIED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
});

const PLANES = new Set([AgentExecutionPlane.LOCAL, AgentExecutionPlane.CLOUD, AgentExecutionPlane.REMOTE]);
const STATES = new Set(Object.values(ExecutionOwnershipState));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

function obj(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}
function exact(raw, allowed, label) { for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`); }
function id(value, label) { if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) throw new Error(`${label} is invalid`); return value; }
function ts(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  return new Date(ms).toISOString();
}
function plane(value) { if (typeof value !== 'string') throw new Error('execution plane is invalid'); const out = value.trim().toUpperCase(); if (!PLANES.has(out)) throw new Error('execution plane is invalid'); return out; }
function optionalId(value, label) { return value == null || value === '' ? '' : id(value, label); }
function optionalTs(value, label) { return value == null || value === '' ? '' : ts(value, label); }
function boundedText(value, label, max = 1000) { if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) throw new Error(`${label} is invalid`); return value; }
function freeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freeze(child); return Object.freeze(value); }

export function createExecutionOwnershipV1({ taskId, planId, nodeId, effectId, policyEnvelopeId, at = new Date().toISOString() } = {}) {
  return normalizeExecutionOwnershipV1({
    schemaVersion: EXECUTION_OWNERSHIP_VERSION,
    taskId, planId, nodeId, effectId, policyEnvelopeId,
    state: ExecutionOwnershipState.AVAILABLE,
    ownerPlane: '', ownerId: '', leaseId: '', leaseUntil: '',
    handoffToPlane: '', handoffId: '', ambiguityReason: '',
    updatedAt: at, revision: 1,
  });
}

export function normalizeExecutionOwnershipV1(raw) {
  raw = obj(raw, 'ExecutionOwnershipV1');
  exact(raw, new Set(['schemaVersion','taskId','planId','nodeId','effectId','policyEnvelopeId','state','ownerPlane','ownerId','leaseId','leaseUntil','handoffToPlane','handoffId','ambiguityReason','updatedAt','revision']), 'ExecutionOwnershipV1');
  if (raw.schemaVersion !== EXECUTION_OWNERSHIP_VERSION) throw new Error('Unsupported ExecutionOwnershipV1 schemaVersion');
  if (typeof raw.state !== 'string') throw new Error('ExecutionOwnershipV1 state is invalid');
  const state = raw.state.trim().toUpperCase();
  if (!STATES.has(state)) throw new Error('ExecutionOwnershipV1 state is invalid');
  const ownerPlane = raw.ownerPlane ? plane(raw.ownerPlane) : '';
  const ownerId = optionalId(raw.ownerId, 'ownerId');
  const leaseId = optionalId(raw.leaseId, 'leaseId');
  const leaseUntil = optionalTs(raw.leaseUntil, 'leaseUntil');
  const handoffToPlane = raw.handoffToPlane ? plane(raw.handoffToPlane) : '';
  const handoffId = optionalId(raw.handoffId, 'handoffId');
  const ambiguityReason = raw.ambiguityReason ? boundedText(raw.ambiguityReason, 'ambiguityReason') : '';
  const owned = state === ExecutionOwnershipState.OWNED || state === ExecutionOwnershipState.HANDOFF_PENDING || state === ExecutionOwnershipState.RECONCILE;
  if (owned && (!ownerPlane || !ownerId || !leaseId || !leaseUntil)) throw new Error('owned execution state requires complete owner lease identity');
  if (!owned && (ownerPlane || ownerId || leaseId || leaseUntil)) throw new Error('unowned execution state cannot retain owner lease identity');
  if (state === ExecutionOwnershipState.HANDOFF_PENDING && (!handoffToPlane || !handoffId || handoffToPlane === ownerPlane)) throw new Error('handoff requires a distinct target plane and handoff identity');
  if (state !== ExecutionOwnershipState.HANDOFF_PENDING && (handoffToPlane || handoffId)) throw new Error('handoff metadata is only valid while HANDOFF_PENDING');
  if ((state === ExecutionOwnershipState.RECONCILE || state === ExecutionOwnershipState.MANUAL_REVIEW) !== Boolean(ambiguityReason)) throw new Error('ambiguity reason must exist exactly for reconciliation/manual review');
  const revision = raw.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) throw new Error('ExecutionOwnershipV1 revision is invalid');
  return freeze({ schemaVersion: EXECUTION_OWNERSHIP_VERSION, taskId: id(raw.taskId,'taskId'), planId: id(raw.planId,'planId'), nodeId: id(raw.nodeId,'nodeId'), effectId: id(raw.effectId,'effectId'), policyEnvelopeId: id(raw.policyEnvelopeId,'policyEnvelopeId'), state, ownerPlane, ownerId, leaseId, leaseUntil, handoffToPlane, handoffId, ambiguityReason, updatedAt: ts(raw.updatedAt,'updatedAt'), revision });
}

function next(raw, patch, at) {
  const current = normalizeExecutionOwnershipV1(raw);
  return normalizeExecutionOwnershipV1({ ...current, ...patch, updatedAt: ts(at,'at'), revision: current.revision + 1 });
}

function assertLeaseDuration(at, leaseUntil) {
  const start = Date.parse(ts(at,'at')); const end = Date.parse(ts(leaseUntil,'leaseUntil'));
  if (end <= start || end - start > MAX_LEASE_MS) throw new Error('execution ownership lease duration is invalid');
}

function assertLeaseLive(current, at) {
  if (Date.parse(ts(at,'at')) > Date.parse(current.leaseUntil)) {
    throw new Error('execution ownership lease has expired and requires reconciliation');
  }
}

export function claimExecutionOwnershipV1(raw, { plane: requestedPlane, ownerId, leaseId, leaseUntil, at = new Date().toISOString() } = {}) {
  const current = normalizeExecutionOwnershipV1(raw);
  if (current.state !== ExecutionOwnershipState.AVAILABLE) throw new Error('execution effect is not available to claim');
  assertLeaseDuration(at, leaseUntil);
  return next(current, { state: ExecutionOwnershipState.OWNED, ownerPlane: plane(requestedPlane), ownerId: id(ownerId,'ownerId'), leaseId: id(leaseId,'leaseId'), leaseUntil: ts(leaseUntil,'leaseUntil') }, at);
}

export function requestExecutionHandoffV1(raw, { leaseId, toPlane, handoffId, at = new Date().toISOString() } = {}) {
  const current = normalizeExecutionOwnershipV1(raw);
  if (current.state !== ExecutionOwnershipState.OWNED || current.leaseId !== id(leaseId,'leaseId')) throw new Error('only the current execution owner may request handoff');
  assertLeaseLive(current, at);
  return next(current, { state: ExecutionOwnershipState.HANDOFF_PENDING, handoffToPlane: plane(toPlane), handoffId: id(handoffId,'handoffId') }, at);
}

export function acceptExecutionHandoffV1(raw, { handoffId, ownerId, leaseId, leaseUntil, at = new Date().toISOString() } = {}) {
  const current = normalizeExecutionOwnershipV1(raw);
  if (current.state !== ExecutionOwnershipState.HANDOFF_PENDING || current.handoffId !== id(handoffId,'handoffId')) throw new Error('execution handoff identity mismatch');
  assertLeaseLive(current, at);
  assertLeaseDuration(at, leaseUntil);
  return next(current, { state: ExecutionOwnershipState.OWNED, ownerPlane: current.handoffToPlane, ownerId: id(ownerId,'ownerId'), leaseId: id(leaseId,'leaseId'), leaseUntil: ts(leaseUntil,'leaseUntil'), handoffToPlane: '', handoffId: '' }, at);
}

export function recoverExpiredExecutionOwnershipV1(raw, { at = new Date().toISOString(), reason = 'owner lease expired before verified completion' } = {}) {
  const current = normalizeExecutionOwnershipV1(raw);
  if (![ExecutionOwnershipState.OWNED, ExecutionOwnershipState.HANDOFF_PENDING].includes(current.state)) throw new Error('execution ownership is not recoverable');
  if (Date.parse(ts(at,'at')) <= Date.parse(current.leaseUntil)) throw new Error('execution ownership lease has not expired');
  // Expiry alone can never prove that an external effect did not happen.
  // Every ambiguous expired attempt first enters RECONCILE and preserves the
  // original lease identity until a fresh canonical VerificationV1 resolves it.
  return next(current, { state: ExecutionOwnershipState.RECONCILE, handoffToPlane: '', handoffId: '', ambiguityReason: boundedText(reason,'reason') }, at);
}

export function resolveExecutionReconciliationV1(raw, options = {}) {
  const request = obj(options, 'Execution reconciliation request');
  exact(request, new Set(['leaseId', 'outcome', 'verification', 'at']), 'Execution reconciliation request');
  const current = normalizeExecutionOwnershipV1(raw);
  const leaseId = request.leaseId;
  const outcome = request.outcome;
  const at = request.at === undefined ? new Date().toISOString() : request.at;
  if (current.state !== ExecutionOwnershipState.RECONCILE || current.leaseId !== id(leaseId,'leaseId')) {
    throw new Error('reconciliation requires the preserved owner lease identity');
  }
  if (typeof outcome !== 'string') throw new Error('reconciliation outcome must be text');
  const normalized = outcome.trim().toUpperCase();
  if (normalized === 'MANUAL_REVIEW') {
    return next(current, {
      state: ExecutionOwnershipState.MANUAL_REVIEW,
      ownerPlane: '',
      ownerId: '',
      leaseId: '',
      leaseUntil: '',
      ambiguityReason: current.ambiguityReason,
    }, at);
  }
  if (normalized === 'VERIFIED' || normalized === 'SAFE_RETRY') {
    // VerificationV1 normalization proves shape, not provenance. Until an
    // independently resolved canonical verifier record is available, caller-
    // supplied verification data cannot release or complete an ambiguous effect.
    throw new Error('trusted verifier provenance is required before automated reconciliation');
  }
  throw new Error('reconciliation outcome must be VERIFIED, SAFE_RETRY, or MANUAL_REVIEW');
}

export function verifyOwnedExecutionV1(raw, { leaseId, at = new Date().toISOString() } = {}) {
  const current = normalizeExecutionOwnershipV1(raw);
  if (current.state !== ExecutionOwnershipState.OWNED || current.leaseId !== id(leaseId,'leaseId')) throw new Error('only the current execution owner may verify completion');
  assertLeaseLive(current, at);
  return next(current, { state: ExecutionOwnershipState.VERIFIED, ownerPlane: '', ownerId: '', leaseId: '', leaseUntil: '' }, at);
}

/**
 * Closes an owned effect only when a verifier is distinct from the effect
 * owner and explicitly binds its authority to the immutable policy envelope
 * that admitted that effect.  It is a contract boundary: callers must obtain
 * the envelope reference from the canonical owner-policy path, never from a
 * provider or specialist response.
 */
export function verifyExecutionByAuthorityV1(raw, { leaseId, verifierId, verificationAuthorityId, evidence, at = new Date().toISOString() } = {}) {
  const current = normalizeExecutionOwnershipV1(raw);
  if (current.state !== ExecutionOwnershipState.OWNED || current.leaseId !== id(leaseId,'leaseId')) throw new Error('only the current execution lease may be independently verified');
  assertLeaseLive(current, at);
  const verifier = id(verifierId, 'verifierId');
  if (verifier === current.ownerId) throw new Error('execution verifier must be independent from the effect owner');
  if (id(verificationAuthorityId, 'verificationAuthorityId') !== current.policyEnvelopeId) throw new Error('verification authority must bind the execution policy envelope');
  boundedText(evidence, 'verification evidence', 8000);
  return next(current, { state: ExecutionOwnershipState.VERIFIED, ownerPlane: '', ownerId: '', leaseId: '', leaseUntil: '' }, at);
}
