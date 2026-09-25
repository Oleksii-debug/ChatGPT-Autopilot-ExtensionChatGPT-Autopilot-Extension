import { createSha256FingerprintV1 } from './fingerprint.js';
import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const AGENT_CHECKPOINT_VERSION = 1;

export const AgentCheckpointRewindStatus = Object.freeze({
  READY_FOR_RECONCILIATION: 'READY_FOR_RECONCILIATION',
  BLOCKED: 'BLOCKED',
  NOOP: 'NOOP',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CHECKPOINT_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_EVIDENCE_IDS = 128;
const MAX_UNRESOLVED_EFFECTS = 128;

const CHECKPOINT_KEYS = new Set([
  'schemaVersion',
  'checkpointId',
  'agentId',
  'jobId',
  'planId',
  'planRevision',
  'internalStateRevision',
  'exactEffectLedgerRevision',
  'policyRevisionId',
  'snapshotArtifact',
  'evidenceArtifactIds',
  'createdAt',
  'checkpointDigest',
]);

const CHECKPOINT_CREATE_KEYS = new Set([...CHECKPOINT_KEYS].filter(key => key !== 'checkpointDigest'));

const HEAD_KEYS = new Set([
  'schemaVersion',
  'agentId',
  'jobId',
  'planId',
  'planRevision',
  'internalStateRevision',
  'exactEffectLedgerRevision',
  'policyRevisionId',
  'unresolvedEffectIds',
  'observedAt',
]);

const ARTIFACT_KEYS = new Set([
  'schemaVersion',
  'artifactId',
  'kind',
  'uri',
  'mediaType',
  'sha256',
  'sizeBytes',
  'createdAt',
  'producerInvocationId',
  'sensitive',
]);

const ASSESSMENT_KEYS = new Set(['checkpoint', 'current', 'snapshotSha256']);

function strictRecord(value, label, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function strictArray(value, label, { max }) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const length = lengthDescriptor.value;
  const out = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains an invalid array property`);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
      throw new Error(`${label} contains an invalid array index`);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must not be sparse`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a timestamp`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${label} must be a timestamp`);
  return new Date(millis).toISOString();
}

function digest(value, label) {
  if (typeof value !== 'string' || !CHECKPOINT_DIGEST.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function bareSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function idList(value, label, { max }) {
  const raw = strictArray(value ?? [], label, { max });
  const out = raw.map((item, index) => exactId(item, `${label}[${index}]`));
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
}

function snapshotArtifact(value) {
  const safe = strictRecord(value, 'AgentCheckpointV1 snapshotArtifact', ARTIFACT_KEYS);
  const normalized = normalizeArtifactRefV1(safe);
  if (normalized.kind !== 'agent-state-checkpoint') {
    throw new Error('AgentCheckpointV1 snapshotArtifact kind must be agent-state-checkpoint');
  }
  if (!normalized.sha256) throw new Error('AgentCheckpointV1 snapshotArtifact requires sha256');
  if (normalized.sizeBytes < 1) throw new Error('AgentCheckpointV1 snapshotArtifact requires non-empty material');
  return normalized;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function normalizeCheckpointMaterial(raw, allowedKeys) {
  const input = strictRecord(raw, 'AgentCheckpointV1', allowedKeys);
  if (input.schemaVersion !== AGENT_CHECKPOINT_VERSION) {
    throw new Error('Unsupported AgentCheckpointV1 schemaVersion');
  }
  const createdAt = timestamp(input.createdAt, 'AgentCheckpointV1 createdAt');
  const artifact = snapshotArtifact(input.snapshotArtifact);
  if (artifact.createdAt > createdAt) {
    throw new Error('AgentCheckpointV1 snapshot artifact cannot be created after checkpoint');
  }
  return {
    schemaVersion: AGENT_CHECKPOINT_VERSION,
    checkpointId: exactId(input.checkpointId, 'AgentCheckpointV1 checkpointId'),
    agentId: exactId(input.agentId, 'AgentCheckpointV1 agentId'),
    jobId: exactId(input.jobId, 'AgentCheckpointV1 jobId'),
    planId: exactId(input.planId, 'AgentCheckpointV1 planId'),
    planRevision: positiveInteger(input.planRevision, 'AgentCheckpointV1 planRevision'),
    internalStateRevision: positiveInteger(input.internalStateRevision, 'AgentCheckpointV1 internalStateRevision'),
    exactEffectLedgerRevision: nonNegativeInteger(input.exactEffectLedgerRevision, 'AgentCheckpointV1 exactEffectLedgerRevision'),
    policyRevisionId: exactId(input.policyRevisionId, 'AgentCheckpointV1 policyRevisionId'),
    snapshotArtifact: artifact,
    evidenceArtifactIds: idList(input.evidenceArtifactIds ?? [], 'AgentCheckpointV1 evidenceArtifactIds', { max: MAX_EVIDENCE_IDS }),
    createdAt,
  };
}

function canonicalCheckpointMaterial(value) {
  const artifact = value.snapshotArtifact;
  return JSON.stringify([
    'chatgpt-autopilot-agent-checkpoint-v1',
    value.checkpointId,
    value.agentId,
    value.jobId,
    value.planId,
    value.planRevision,
    value.internalStateRevision,
    value.exactEffectLedgerRevision,
    value.policyRevisionId,
    [
      artifact.schemaVersion,
      artifact.artifactId,
      artifact.kind,
      artifact.uri,
      artifact.mediaType,
      artifact.sha256,
      artifact.sizeBytes,
      artifact.createdAt,
      artifact.producerInvocationId,
      artifact.sensitive,
    ],
    value.evidenceArtifactIds,
    value.createdAt,
  ]);
}

async function materialDigest(material, { cryptoApi = globalThis.crypto } = {}) {
  return createSha256FingerprintV1(canonicalCheckpointMaterial(material), { cryptoApi });
}

export async function createAgentCheckpointV1(raw, options = {}) {
  const material = normalizeCheckpointMaterial(raw, CHECKPOINT_CREATE_KEYS);
  const checkpointDigest = await materialDigest(material, options);
  return freezeDeep({ ...material, checkpointDigest });
}

export function normalizeAgentCheckpointV1(raw) {
  const material = normalizeCheckpointMaterial(raw, CHECKPOINT_KEYS);
  const input = strictRecord(raw, 'AgentCheckpointV1', CHECKPOINT_KEYS);
  return freezeDeep({
    ...material,
    checkpointDigest: digest(input.checkpointDigest, 'AgentCheckpointV1 checkpointDigest'),
  });
}

export async function verifyAgentCheckpointV1(raw, options = {}) {
  const checkpoint = normalizeAgentCheckpointV1(raw);
  const expected = await materialDigest(checkpoint, options);
  if (checkpoint.checkpointDigest !== expected) {
    throw new Error('AgentCheckpointV1 checkpointDigest does not match checkpoint material');
  }
  return checkpoint;
}

export function normalizeAgentCheckpointHeadV1(raw) {
  const input = strictRecord(raw, 'AgentCheckpointHeadV1', HEAD_KEYS);
  if (input.schemaVersion !== AGENT_CHECKPOINT_VERSION) {
    throw new Error('Unsupported AgentCheckpointHeadV1 schemaVersion');
  }
  return freezeDeep({
    schemaVersion: AGENT_CHECKPOINT_VERSION,
    agentId: exactId(input.agentId, 'AgentCheckpointHeadV1 agentId'),
    jobId: exactId(input.jobId, 'AgentCheckpointHeadV1 jobId'),
    planId: exactId(input.planId, 'AgentCheckpointHeadV1 planId'),
    planRevision: positiveInteger(input.planRevision, 'AgentCheckpointHeadV1 planRevision'),
    internalStateRevision: positiveInteger(input.internalStateRevision, 'AgentCheckpointHeadV1 internalStateRevision'),
    exactEffectLedgerRevision: nonNegativeInteger(input.exactEffectLedgerRevision, 'AgentCheckpointHeadV1 exactEffectLedgerRevision'),
    policyRevisionId: exactId(input.policyRevisionId, 'AgentCheckpointHeadV1 policyRevisionId'),
    unresolvedEffectIds: idList(input.unresolvedEffectIds ?? [], 'AgentCheckpointHeadV1 unresolvedEffectIds', { max: MAX_UNRESOLVED_EFFECTS }),
    observedAt: timestamp(input.observedAt, 'AgentCheckpointHeadV1 observedAt'),
  });
}

function blocked(checkpoint, current, reasonCode) {
  return freezeDeep({
    schemaVersion: AGENT_CHECKPOINT_VERSION,
    status: AgentCheckpointRewindStatus.BLOCKED,
    reasonCode,
    advisoryOnly: true,
    restoreAuthorized: false,
    requiresFreshPolicyEvaluation: true,
    requiresFreshReconciliation: true,
    checkpointId: checkpoint.checkpointId,
    snapshotArtifactId: checkpoint.snapshotArtifact.artifactId,
    preserveExactEffectLedgerRevision: current.exactEffectLedgerRevision,
    preservePolicyRevisionId: current.policyRevisionId,
  });
}

export async function assessAgentCheckpointRewindV1(raw, options = {}) {
  const request = strictRecord(raw, 'AgentCheckpoint rewind request', ASSESSMENT_KEYS);
  const checkpoint = await verifyAgentCheckpointV1(request.checkpoint, options);
  const current = normalizeAgentCheckpointHeadV1(request.current);
  const suppliedSnapshotSha256 = bareSha256(request.snapshotSha256, 'AgentCheckpoint rewind snapshotSha256');

  for (const key of ['agentId', 'jobId', 'planId']) {
    if (current[key] !== checkpoint[key]) {
      throw new Error(`AgentCheckpoint rewind ${key} does not match checkpoint`);
    }
  }
  if (suppliedSnapshotSha256 !== checkpoint.snapshotArtifact.sha256) {
    throw new Error('AgentCheckpoint rewind snapshot bytes do not match checkpoint artifact');
  }
  if (current.planRevision < checkpoint.planRevision
      || current.internalStateRevision < checkpoint.internalStateRevision
      || current.exactEffectLedgerRevision < checkpoint.exactEffectLedgerRevision) {
    throw new Error('AgentCheckpoint rewind current state regressed behind checkpoint');
  }
  if (current.observedAt < checkpoint.createdAt) {
    throw new Error('AgentCheckpoint rewind current observation predates checkpoint');
  }
  if (current.unresolvedEffectIds.length) {
    return blocked(checkpoint, current, 'UNRESOLVED_EXTERNAL_EFFECTS');
  }
  if (current.exactEffectLedgerRevision !== checkpoint.exactEffectLedgerRevision) {
    return blocked(checkpoint, current, 'EXTERNAL_EFFECTS_AFTER_CHECKPOINT');
  }
  if (current.planRevision === checkpoint.planRevision
      && current.internalStateRevision === checkpoint.internalStateRevision) {
    return freezeDeep({
      schemaVersion: AGENT_CHECKPOINT_VERSION,
      status: AgentCheckpointRewindStatus.NOOP,
      reasonCode: 'ALREADY_AT_CHECKPOINT',
      advisoryOnly: true,
      restoreAuthorized: false,
      requiresFreshPolicyEvaluation: true,
      requiresFreshReconciliation: true,
      checkpointId: checkpoint.checkpointId,
      snapshotArtifactId: checkpoint.snapshotArtifact.artifactId,
      preserveExactEffectLedgerRevision: current.exactEffectLedgerRevision,
      preservePolicyRevisionId: current.policyRevisionId,
    });
  }
  return freezeDeep({
    schemaVersion: AGENT_CHECKPOINT_VERSION,
    status: AgentCheckpointRewindStatus.READY_FOR_RECONCILIATION,
    reasonCode: 'INTERNAL_STATE_ONLY_REWIND',
    advisoryOnly: true,
    restoreAuthorized: false,
    requiresFreshPolicyEvaluation: true,
    requiresFreshReconciliation: true,
    checkpointId: checkpoint.checkpointId,
    snapshotArtifactId: checkpoint.snapshotArtifact.artifactId,
    snapshotSha256: checkpoint.snapshotArtifact.sha256,
    targetPlanRevision: checkpoint.planRevision,
    targetInternalStateRevision: checkpoint.internalStateRevision,
    preserveExactEffectLedgerRevision: current.exactEffectLedgerRevision,
    preservePolicyRevisionId: current.policyRevisionId,
  });
}
