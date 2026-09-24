import {
  PolicyDecisionKind,
  UniversalAgentContractVersion,
  normalizePolicyDecisionV1,
  normalizeToolInvocationV1,
} from './universal-agent-contracts.js';

export const ApprovalTicketStatus = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  DENIED: 'DENIED',
});

export const ApprovalResolutionDecision = Object.freeze({
  APPROVE: 'APPROVE',
  DENY: 'DENY',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const TICKET_KEYS = new Set([
  'schemaVersion', 'revision', 'approvalId', 'invocationId', 'policyDecisionId',
  'bindingFingerprint', 'requestedAt', 'expiresAt', 'status',
  'resolutionId', 'resolutionDecision', 'resolvedBy', 'resolvedAt',
]);
const RESOLUTION_KEYS = new Set([
  'schemaVersion', 'approvalId', 'expectedRevision', 'resolutionId',
  'decision', 'resolvedBy', 'resolvedAt',
]);

function fail(message) {
  throw new Error(message);
}

function ownDataRecord(value, label, allowedKeys = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`${label} must be a plain object`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string')) fail(`${label} must not contain symbol fields`);
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      fail(`${label} must contain enumerable data fields only`);
    }
    if (allowedKeys && !allowedKeys.has(key)) fail(`${label} contains unknown field: ${key}`);
  }
  return value;
}

function requireString(value, label, { optional = false, max = 4096 } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const out = value.trim();
  if (!out || out.length > max) fail(`${label} is invalid`);
  return out;
}

function requireId(value, label, { optional = false } = {}) {
  const out = requireString(value, label, { optional, max: 180 });
  if (!out && optional) return '';
  if (!ID.test(out)) fail(`${label} is invalid`);
  return out;
}

function requireVersion(value, label) {
  if (typeof value !== 'number' || value !== UniversalAgentContractVersion) {
    fail(`Unsupported ${label} schemaVersion`);
  }
  return value;
}

function requireInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} is invalid`);
  return value;
}

function requireTimestamp(value, label, { optional = false } = {}) {
  const raw = requireString(value, label, { optional, max: 80 });
  if (!raw && optional) return '';
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) fail(`${label} must be a timestamp`);
  return new Date(ms).toISOString();
}

function requireFingerprint(value, label = 'bindingFingerprint') {
  const out = requireString(value, label, { max: 80 }).toLowerCase();
  if (!FINGERPRINT.test(out)) fail(`${label} is invalid`);
  return out;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function strictUniversalRecord(value, label) {
  return ownDataRecord(value, label);
}

function strictPolicyInput(value) {
  const raw = strictUniversalRecord(value, 'PolicyDecisionV1');
  requireVersion(raw.schemaVersion, 'PolicyDecisionV1');
  for (const field of ['decisionId', 'invocationId', 'decision', 'reasonCode', 'decidedAt']) {
    if (typeof raw[field] !== 'string') fail(`PolicyDecisionV1.${field} must be a string`);
  }
  if (raw.approvalId != null && typeof raw.approvalId !== 'string') {
    fail('PolicyDecisionV1.approvalId must be a string');
  }
  return normalizePolicyDecisionV1(raw);
}

function assertStrictJsonData(value, label, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return;
  }
  if (!value || typeof value !== 'object') fail(`${label} contains a non-JSON value`);
  if (seen.has(value)) fail(`${label} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      assertArrayShape(value, label);
      for (let index = 0; index < value.length; index += 1) {
        assertStrictJsonData(value[index], `${label}[${index}]`, seen);
      }
      return;
    }
    ownDataRecord(value, label);
    for (const key of Object.keys(value)) {
      assertStrictJsonData(value[key], `${label}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function strictInvocationInput(value) {
  const raw = strictUniversalRecord(value, 'ToolInvocationV1');
  requireVersion(raw.schemaVersion, 'ToolInvocationV1');
  for (const field of ['invocationId', 'toolId', 'providerId', 'policyDecisionId', 'createdAt']) {
    if (typeof raw[field] !== 'string') fail(`ToolInvocationV1.${field} must be a string`);
  }
  if (raw.parentInvocationId != null && typeof raw.parentInvocationId !== 'string') {
    fail('ToolInvocationV1.parentInvocationId must be a string');
  }
  if (!Array.isArray(raw.requestedCapabilityIds)
      || raw.requestedCapabilityIds.some(value => typeof value !== 'string')) {
    fail('ToolInvocationV1.requestedCapabilityIds must contain strings');
  }
  assertStrictJsonData(raw.arguments, 'ToolInvocationV1.arguments');
  return normalizeToolInvocationV1(raw);
}

function assertArrayShape(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const allowed = new Set(['length']);
  for (let index = 0; index < value.length; index += 1) allowed.add(String(index));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) fail(`${label} contains non-JSON array fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (key === 'length') {
      if (!descriptor || !('value' in descriptor)) fail(`${label}.length is invalid`);
      continue;
    }
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      fail(`${label} must contain enumerable data items only`);
    }
  }
}

function canonicalJson(value, label = 'value') {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    assertArrayShape(value, label);
    return `[${value.map((item, index) => canonicalJson(item, `${label}[${index}]`)).join(',')}]`;
  }
  if (!value || typeof value !== 'object') fail(`${label} contains a non-JSON value`);
  ownDataRecord(value, label);
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], `${label}.${key}`)}`).join(',')}}`;
}

function bindingPayload(policyDecision, invocation) {
  return {
    tag: 'chatgpt-autopilot-approval-binding-v1',
    policyDecision: {
      schemaVersion: policyDecision.schemaVersion,
      decisionId: policyDecision.decisionId,
      invocationId: policyDecision.invocationId,
      decision: policyDecision.decision,
      reasonCode: policyDecision.reasonCode,
      reason: policyDecision.reason,
      approvalId: policyDecision.approvalId,
      decidedAt: policyDecision.decidedAt,
    },
    invocation: {
      schemaVersion: invocation.schemaVersion,
      invocationId: invocation.invocationId,
      toolId: invocation.toolId,
      providerId: invocation.providerId,
      requestedCapabilityIds: [...invocation.requestedCapabilityIds].sort(),
      policyDecisionId: invocation.policyDecisionId,
      arguments: invocation.arguments,
      createdAt: invocation.createdAt,
      parentInvocationId: invocation.parentInvocationId,
    },
  };
}

function assertApprovalBinding(policyDecision, invocation) {
  if (policyDecision.decision !== PolicyDecisionKind.REQUIRE_APPROVAL) {
    fail('Approval ticket requires REQUIRE_APPROVAL policy decision');
  }
  if (!policyDecision.approvalId) fail('Approval ticket requires approvalId');
  if (policyDecision.invocationId !== invocation.invocationId) {
    fail('Policy decision invocationId does not match ToolInvocationV1');
  }
  if (invocation.policyDecisionId !== policyDecision.decisionId) {
    fail('ToolInvocationV1 policyDecisionId does not match PolicyDecisionV1');
  }
}

function toHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createApprovalBindingFingerprintV1({
  policyDecision,
  invocation,
  cryptoApi = globalThis.crypto,
} = {}) {
  const policy = strictPolicyInput(policyDecision);
  const toolInvocation = strictInvocationInput(invocation);
  assertApprovalBinding(policy, toolInvocation);
  if (!cryptoApi?.subtle?.digest) fail('Web Crypto SHA-256 is unavailable');
  const canonical = canonicalJson(bindingPayload(policy, toolInvocation), 'approvalBinding');
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return `sha256:${toHex(new Uint8Array(digest))}`;
}

export function normalizeApprovalTicketV1(input) {
  const raw = ownDataRecord(input, 'ApprovalTicketV1', TICKET_KEYS);
  const schemaVersion = requireVersion(raw.schemaVersion, 'ApprovalTicketV1');
  const revision = requireInteger(raw.revision, 'ApprovalTicketV1.revision', { min: 1, max: 2 });
  const approvalId = requireId(raw.approvalId, 'approvalId');
  const invocationId = requireId(raw.invocationId, 'invocationId');
  const policyDecisionId = requireId(raw.policyDecisionId, 'policyDecisionId');
  const bindingFingerprint = requireFingerprint(raw.bindingFingerprint);
  const requestedAt = requireTimestamp(raw.requestedAt, 'requestedAt');
  const expiresAt = requireTimestamp(raw.expiresAt, 'expiresAt', { optional: true });
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(requestedAt)) {
    fail('expiresAt must be after requestedAt');
  }
  const status = requireString(raw.status, 'status', { max: 32 }).toUpperCase();
  if (!Object.values(ApprovalTicketStatus).includes(status)) fail('ApprovalTicketV1 status is invalid');

  const resolutionId = requireId(raw.resolutionId, 'resolutionId', { optional: true });
  const resolutionDecision = requireString(raw.resolutionDecision, 'resolutionDecision', { optional: true, max: 32 }).toUpperCase();
  const resolvedBy = requireId(raw.resolvedBy, 'resolvedBy', { optional: true });
  const resolvedAt = requireTimestamp(raw.resolvedAt, 'resolvedAt', { optional: true });
  const resolutionFields = [resolutionId, resolutionDecision, resolvedBy, resolvedAt];

  if (status === ApprovalTicketStatus.PENDING) {
    if (revision !== 1 || resolutionFields.some(Boolean)) {
      fail('PENDING ApprovalTicketV1 must be revision 1 without resolution fields');
    }
  } else {
    if (revision !== 2 || resolutionFields.some(value => !value)) {
      fail('Resolved ApprovalTicketV1 must be revision 2 with complete resolution fields');
    }
    const expected = status === ApprovalTicketStatus.APPROVED
      ? ApprovalResolutionDecision.APPROVE
      : ApprovalResolutionDecision.DENY;
    if (resolutionDecision !== expected) fail('ApprovalTicketV1 resolutionDecision does not match status');
    if (Date.parse(resolvedAt) < Date.parse(requestedAt)) fail('resolvedAt precedes requestedAt');
  }

  return deepFreeze({
    schemaVersion,
    revision,
    approvalId,
    invocationId,
    policyDecisionId,
    bindingFingerprint,
    requestedAt,
    expiresAt,
    status,
    resolutionId,
    resolutionDecision,
    resolvedBy,
    resolvedAt,
  });
}

export async function createApprovalTicketV1({
  policyDecision,
  invocation,
  expiresAt = '',
  cryptoApi = globalThis.crypto,
} = {}) {
  const policy = strictPolicyInput(policyDecision);
  const toolInvocation = strictInvocationInput(invocation);
  assertApprovalBinding(policy, toolInvocation);
  const normalizedExpiresAt = requireTimestamp(expiresAt, 'expiresAt', { optional: true });
  if (normalizedExpiresAt && Date.parse(normalizedExpiresAt) <= Date.parse(policy.decidedAt)) {
    fail('expiresAt must be after requestedAt');
  }
  const bindingFingerprint = await createApprovalBindingFingerprintV1({
    policyDecision: policy,
    invocation: toolInvocation,
    cryptoApi,
  });
  return normalizeApprovalTicketV1({
    schemaVersion: UniversalAgentContractVersion,
    revision: 1,
    approvalId: policy.approvalId,
    invocationId: toolInvocation.invocationId,
    policyDecisionId: policy.decisionId,
    bindingFingerprint,
    requestedAt: policy.decidedAt,
    expiresAt: normalizedExpiresAt,
    status: ApprovalTicketStatus.PENDING,
    resolutionId: '',
    resolutionDecision: '',
    resolvedBy: '',
    resolvedAt: '',
  });
}

function normalizeResolution(input) {
  const raw = ownDataRecord(input, 'ApprovalResolutionV1', RESOLUTION_KEYS);
  requireVersion(raw.schemaVersion, 'ApprovalResolutionV1');
  const decision = requireString(raw.decision, 'decision', { max: 32 }).toUpperCase();
  if (!Object.values(ApprovalResolutionDecision).includes(decision)) {
    fail('ApprovalResolutionV1 decision is invalid');
  }
  return deepFreeze({
    schemaVersion: UniversalAgentContractVersion,
    approvalId: requireId(raw.approvalId, 'approvalId'),
    expectedRevision: requireInteger(raw.expectedRevision, 'expectedRevision', { min: 1, max: 2 }),
    resolutionId: requireId(raw.resolutionId, 'resolutionId'),
    decision,
    resolvedBy: requireId(raw.resolvedBy, 'resolvedBy'),
    resolvedAt: requireTimestamp(raw.resolvedAt, 'resolvedAt'),
  });
}

async function assertTicketBinding(ticket, policyDecision, invocation, cryptoApi) {
  const policy = strictPolicyInput(policyDecision);
  const toolInvocation = strictInvocationInput(invocation);
  assertApprovalBinding(policy, toolInvocation);
  if (ticket.approvalId !== policy.approvalId
      || ticket.invocationId !== toolInvocation.invocationId
      || ticket.policyDecisionId !== policy.decisionId) {
    fail('Approval ticket identity does not match current invocation/policy');
  }
  const fingerprint = await createApprovalBindingFingerprintV1({
    policyDecision: policy,
    invocation: toolInvocation,
    cryptoApi,
  });
  if (fingerprint !== ticket.bindingFingerprint) {
    fail('Approval ticket binding fingerprint does not match current invocation/policy');
  }
  return { policy, toolInvocation };
}

export async function resolveApprovalTicketV1({
  ticket,
  resolution,
  policyDecision,
  invocation,
  cryptoApi = globalThis.crypto,
} = {}) {
  const current = normalizeApprovalTicketV1(ticket);
  if (current.status !== ApprovalTicketStatus.PENDING) fail('Only a PENDING approval ticket may be resolved');
  const ownerResolution = normalizeResolution(resolution);
  if (ownerResolution.approvalId !== current.approvalId) fail('Approval resolution approvalId mismatch');
  if (ownerResolution.expectedRevision !== current.revision) fail('Approval resolution revision mismatch');
  if (Date.parse(ownerResolution.resolvedAt) < Date.parse(current.requestedAt)) {
    fail('Approval resolution precedes approval request');
  }
  if (current.expiresAt && Date.parse(ownerResolution.resolvedAt) > Date.parse(current.expiresAt)) {
    fail('Approval ticket expired before resolution');
  }
  await assertTicketBinding(current, policyDecision, invocation, cryptoApi);
  const status = ownerResolution.decision === ApprovalResolutionDecision.APPROVE
    ? ApprovalTicketStatus.APPROVED
    : ApprovalTicketStatus.DENIED;
  return normalizeApprovalTicketV1({
    ...current,
    revision: 2,
    status,
    resolutionId: ownerResolution.resolutionId,
    resolutionDecision: ownerResolution.decision,
    resolvedBy: ownerResolution.resolvedBy,
    resolvedAt: ownerResolution.resolvedAt,
  });
}

export function approvalTicketStateAtV1(ticket, at) {
  const current = normalizeApprovalTicketV1(ticket);
  const when = requireTimestamp(at, 'at');
  if (current.status === ApprovalTicketStatus.PENDING
      && current.expiresAt
      && Date.parse(when) > Date.parse(current.expiresAt)) {
    return 'EXPIRED';
  }
  return current.status;
}

export async function assertApprovedForInvocationV1({
  ticket,
  policyDecision,
  invocation,
  at,
  cryptoApi = globalThis.crypto,
} = {}) {
  const current = normalizeApprovalTicketV1(ticket);
  if (current.status !== ApprovalTicketStatus.APPROVED) fail('Approval ticket is not approved');
  const checkedAt = requireTimestamp(at, 'at');
  if (Date.parse(checkedAt) < Date.parse(current.resolvedAt)) fail('Approval resume check precedes resolution');
  await assertTicketBinding(current, policyDecision, invocation, cryptoApi);
  // expiresAt bounds only the PENDING owner-response window. Once the owner has
  // approved the exact immutable binding before expiry, that resolution remains
  // durable across restart/offline time. The executor still owns freshness/
  // provider-state revalidation before any external effect.
  return current;
}
