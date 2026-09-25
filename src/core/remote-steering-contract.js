import { createSha256FingerprintV1 } from './fingerprint.js';

export const REMOTE_STEERING_SCHEMA_VERSION = 1;
export const MAX_REMOTE_STEERING_TTL_MS = 24 * 60 * 60 * 1000;

export const RemoteSteeringAction = Object.freeze({
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  STOP: 'STOP',
  RECONCILE: 'RECONCILE',
  REDIRECT: 'REDIRECT',
});

export const RemoteSteeringRedirectKind = Object.freeze({
  AGENT: 'AGENT',
  PLAN_NODE: 'PLAN_NODE',
  EXECUTION_PLANE: 'EXECUTION_PLANE',
});

const ACTIONS = new Set(Object.values(RemoteSteeringAction));
const REDIRECT_KINDS = new Set(Object.values(RemoteSteeringRedirectKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

const REQUEST_KEYS = new Set(['command']);
const COMMAND_KEYS = new Set([
  'schemaVersion',
  'commandId',
  'action',
  'jobId',
  'planId',
  'expectedJobRevision',
  'expectedPlanRevision',
  'policyEnvelopeId',
  'sourcePrincipalId',
  'sourceDeviceId',
  'sourceSessionId',
  'issuedAt',
  'expiresAt',
  'redirectTarget',
]);
const SNAPSHOT_KEYS = new Set([
  'schemaVersion',
  'jobId',
  'planId',
  'jobRevision',
  'planRevision',
  'policyEnvelopeId',
  'observedAt',
]);
const REDIRECT_KEYS = new Set(['kind', 'targetId']);
const OPTIONS_KEYS = new Set(['resolveCurrentSnapshot', 'assessmentAt']);

function snapshotRecord(value, label, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(label + ' must be a plain or null-prototype object');
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      throw new Error(label + ' must not contain symbol fields');
    }
    if (!allowedKeys.has(key)) {
      throw new Error(label + ' contains unknown field: ' + key);
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) {
      throw new Error(label + ' contains non-enumerable field: ' + key);
    }
    if (!Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + ' must contain data properties only');
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function requireSchemaVersion(value, label) {
  if (value !== REMOTE_STEERING_SCHEMA_VERSION) {
    throw new Error(label + ' schemaVersion must be numeric 1');
  }
  return value;
}

function requireId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function requireRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(label + ' must be a positive safe integer');
  }
  return value;
}

function requireTimestamp(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  return value;
}

function requireAction(value) {
  if (typeof value !== 'string' || !ACTIONS.has(value)) {
    throw new Error('RemoteSteeringCommandV1 action is invalid');
  }
  return value;
}

function normalizeRedirectTarget(value) {
  const raw = snapshotRecord(value, 'RemoteSteeringRedirectTargetV1', REDIRECT_KEYS);
  if (typeof raw.kind !== 'string' || !REDIRECT_KINDS.has(raw.kind)) {
    throw new Error('RemoteSteeringRedirectTargetV1 kind is invalid');
  }
  return Object.freeze({
    kind: raw.kind,
    targetId: requireId(raw.targetId, 'RemoteSteeringRedirectTargetV1 targetId'),
  });
}

function normalizeCommand(value) {
  const raw = snapshotRecord(value, 'RemoteSteeringCommandV1', COMMAND_KEYS);
  requireSchemaVersion(raw.schemaVersion, 'RemoteSteeringCommandV1');
  const action = requireAction(raw.action);
  const hasRedirectTarget = Object.hasOwn(raw, 'redirectTarget');

  if (action === RemoteSteeringAction.REDIRECT && !hasRedirectTarget) {
    throw new Error('REDIRECT requires redirectTarget');
  }
  if (action !== RemoteSteeringAction.REDIRECT && hasRedirectTarget) {
    throw new Error('redirectTarget is only valid for REDIRECT');
  }

  return Object.freeze({
    schemaVersion: REMOTE_STEERING_SCHEMA_VERSION,
    commandId: requireId(raw.commandId, 'RemoteSteeringCommandV1 commandId'),
    action,
    jobId: requireId(raw.jobId, 'RemoteSteeringCommandV1 jobId'),
    planId: requireId(raw.planId, 'RemoteSteeringCommandV1 planId'),
    expectedJobRevision: requireRevision(
      raw.expectedJobRevision,
      'RemoteSteeringCommandV1 expectedJobRevision',
    ),
    expectedPlanRevision: requireRevision(
      raw.expectedPlanRevision,
      'RemoteSteeringCommandV1 expectedPlanRevision',
    ),
    policyEnvelopeId: requireId(
      raw.policyEnvelopeId,
      'RemoteSteeringCommandV1 policyEnvelopeId',
    ),
    sourcePrincipalId: requireId(
      raw.sourcePrincipalId,
      'RemoteSteeringCommandV1 sourcePrincipalId',
    ),
    sourceDeviceId: requireId(
      raw.sourceDeviceId,
      'RemoteSteeringCommandV1 sourceDeviceId',
    ),
    sourceSessionId: requireId(
      raw.sourceSessionId,
      'RemoteSteeringCommandV1 sourceSessionId',
    ),
    issuedAt: requireTimestamp(raw.issuedAt, 'RemoteSteeringCommandV1 issuedAt'),
    expiresAt: requireTimestamp(raw.expiresAt, 'RemoteSteeringCommandV1 expiresAt'),
    redirectTarget: hasRedirectTarget ? normalizeRedirectTarget(raw.redirectTarget) : null,
  });
}

function normalizeCurrentSnapshot(value) {
  const raw = snapshotRecord(value, 'RemoteSteeringCurrentSnapshotV1', SNAPSHOT_KEYS);
  requireSchemaVersion(raw.schemaVersion, 'RemoteSteeringCurrentSnapshotV1');
  return Object.freeze({
    schemaVersion: REMOTE_STEERING_SCHEMA_VERSION,
    jobId: requireId(raw.jobId, 'RemoteSteeringCurrentSnapshotV1 jobId'),
    planId: requireId(raw.planId, 'RemoteSteeringCurrentSnapshotV1 planId'),
    jobRevision: requireRevision(
      raw.jobRevision,
      'RemoteSteeringCurrentSnapshotV1 jobRevision',
    ),
    planRevision: requireRevision(
      raw.planRevision,
      'RemoteSteeringCurrentSnapshotV1 planRevision',
    ),
    policyEnvelopeId: requireId(
      raw.policyEnvelopeId,
      'RemoteSteeringCurrentSnapshotV1 policyEnvelopeId',
    ),
    observedAt: requireTimestamp(
      raw.observedAt,
      'RemoteSteeringCurrentSnapshotV1 observedAt',
    ),
  });
}

function normalizeOptions(options) {
  if (options === undefined) {
    throw new Error('remote steering requires a trusted current-state resolver');
  }
  const raw = snapshotRecord(options, 'RemoteSteering assessment options', OPTIONS_KEYS);
  if (typeof raw.resolveCurrentSnapshot !== 'function') {
    throw new Error('remote steering requires a trusted current-state resolver');
  }
  return Object.freeze({
    resolveCurrentSnapshot: raw.resolveCurrentSnapshot,
    assessmentAt: requireTimestamp(
      raw.assessmentAt,
      'RemoteSteering assessment options assessmentAt',
    ),
  });
}

function assertExactCurrentBinding(command, snapshot) {
  if (command.jobId !== snapshot.jobId) {
    throw new Error('remote steering job identity is stale or mismatched');
  }
  if (command.planId !== snapshot.planId) {
    throw new Error('remote steering plan identity is stale or mismatched');
  }
  if (command.expectedJobRevision !== snapshot.jobRevision) {
    throw new Error('remote steering job revision is stale');
  }
  if (command.expectedPlanRevision !== snapshot.planRevision) {
    throw new Error('remote steering plan revision is stale');
  }
  if (command.policyEnvelopeId !== snapshot.policyEnvelopeId) {
    throw new Error('remote steering policy envelope is stale or mismatched');
  }
}

function assertChronology(command, snapshot, assessmentAt) {
  const issuedMs = Date.parse(command.issuedAt);
  const expiresMs = Date.parse(command.expiresAt);
  const observedMs = Date.parse(snapshot.observedAt);
  const assessedMs = Date.parse(assessmentAt);

  if (issuedMs > assessedMs) {
    throw new Error('remote steering command cannot be issued after assessment');
  }
  if (observedMs > assessedMs) {
    throw new Error('remote steering snapshot cannot be observed after assessment');
  }
  if (expiresMs <= issuedMs) {
    throw new Error('remote steering command expiry must follow issuance');
  }
  if (expiresMs - issuedMs > MAX_REMOTE_STEERING_TTL_MS) {
    throw new Error('remote steering command TTL exceeds the maximum');
  }
  if (assessedMs >= expiresMs) {
    throw new Error('remote steering command is expired');
  }
}

function canonicalFingerprintInput(command) {
  return JSON.stringify([
    'chatgpt-autopilot-remote-steering-v1',
    command.commandId,
    command.action,
    command.jobId,
    command.planId,
    command.expectedJobRevision,
    command.expectedPlanRevision,
    command.policyEnvelopeId,
    command.sourcePrincipalId,
    command.sourceDeviceId,
    command.sourceSessionId,
    command.issuedAt,
    command.expiresAt,
    command.redirectTarget?.kind ?? '',
    command.redirectTarget?.targetId ?? '',
  ]);
}

/**
 * Validates a remote steering proposal against state independently resolved
 * through the canonical durable-state boundary. This function is deliberately
 * non-authorizing: source identity is still an unverified reference and the
 * canonical runtime must authenticate the principal, re-evaluate policy,
 * deduplicate the command, and recheck state before any mutation.
 */
export async function assessRemoteSteeringCommandV1(input, options = undefined) {
  const request = snapshotRecord(input, 'RemoteSteeringAssessmentRequestV1', REQUEST_KEYS);
  const command = normalizeCommand(request.command);
  const trusted = normalizeOptions(options);
  const assessmentAt = trusted.assessmentAt;

  const resolvedSnapshot = await trusted.resolveCurrentSnapshot(Object.freeze({
    jobId: command.jobId,
    planId: command.planId,
  }));
  const currentSnapshot = normalizeCurrentSnapshot(resolvedSnapshot);

  assertExactCurrentBinding(command, currentSnapshot);
  assertChronology(command, currentSnapshot, assessmentAt);

  const commandFingerprint = await createSha256FingerprintV1(
    canonicalFingerprintInput(command),
  );

  return Object.freeze({
    schemaVersion: REMOTE_STEERING_SCHEMA_VERSION,
    status: 'READY_FOR_CANONICAL_AUTHORIZATION',
    commandFingerprint,
    commandId: command.commandId,
    action: command.action,
    jobId: command.jobId,
    planId: command.planId,
    jobRevision: currentSnapshot.jobRevision,
    planRevision: currentSnapshot.planRevision,
    policyEnvelopeId: command.policyEnvelopeId,
    sourcePrincipalId: command.sourcePrincipalId,
    sourceDeviceId: command.sourceDeviceId,
    sourceSessionId: command.sourceSessionId,
    issuedAt: command.issuedAt,
    expiresAt: command.expiresAt,
    assessmentAt,
    redirectTarget: command.redirectTarget,
    trustedCurrentStateBound: true,
    sourceIdentityAuthority: 'UNVERIFIED_REFERENCE',
    sourceAuthenticated: false,
    advisoryOnly: true,
    executionAuthorized: false,
    mutationAuthorized: false,
    credentialUseAuthorized: false,
    policyDecisionGranted: false,
    requiresCanonicalPrincipalAuthentication: true,
    requiresCanonicalRuntime: true,
    requiresCanonicalCommandDeduplication: true,
    requiresFreshPolicy: true,
    requiresFreshStateRecheck: true,
  });
}
