import {
  AgentPlanNodeState,
  normalizeAgentPlanV1,
} from './agent-plan.js';
import {
  VerificationStatus,
  normalizeArtifactRefV1,
  normalizeVerificationV1,
} from './universal-agent-contracts.js';

export const PARALLEL_FANIN_SCHEMA_VERSION = 1;

export const ParallelFanInStatus = Object.freeze({
  WAITING: 'WAITING',
  EVIDENCE_INCOMPLETE: 'EVIDENCE_INCOMPLETE',
  REPORTED_NEGATIVE: 'REPORTED_NEGATIVE',
  CONTRADICTION_REPORTED: 'CONTRADICTION_REPORTED',
  EVIDENCE_COMPLETE: 'EVIDENCE_COMPLETE',
});

const MAX_PARTICIPANTS = 128;
const MAX_RESULTS = 128;
const MAX_CLAIMS_PER_RESULT = 128;
const MAX_EVIDENCE_ARTIFACTS = 512;
const MAX_EVIDENCE_PER_CLAIM = 64;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TERMINAL = new Set([
  AgentPlanNodeState.VERIFIED,
  AgentPlanNodeState.FAILED,
  AgentPlanNodeState.CANCELLED,
]);

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'fanInId',
  'evaluatedAt',
  'plan',
  'participantNodeIds',
  'results',
  'evidenceArtifacts',
]);
const RESULT_KEYS = new Set([
  'nodeId',
  'verification',
  'resultArtifactIds',
  'claims',
]);
const CLAIM_KEYS = new Set([
  'claimId',
  'subjectId',
  'predicateId',
  'valueDigest',
  'evidenceArtifactIds',
]);

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function record(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain or null-prototype object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' fields must be enumerable own data properties');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function array(input, label, { min = 0, max = 128 } = {}) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(label + ' must be a canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < min || length > max) {
    throw new Error(label + ' must contain ' + min + '..' + max + ' items');
  }
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' contains non-canonical array fields');
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '[' + index + '] must be an enumerable own data property');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must be a canonical identity');
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(label + ' must be a lowercase sha256 digest');
  }
  return value;
}

function uniqueIds(input, label, { min = 0, max = 128 } = {}) {
  const values = array(input, label, { min, max })
    .map((value, index) => id(value, label + '[' + index + ']'));
  if (new Set(values).size !== values.length) {
    throw new Error(label + ' contains duplicates');
  }
  return values;
}

function normalizeArtifact(input, index, evaluatedAt) {
  const label = 'evidenceArtifacts[' + index + ']';
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(label + ' must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(label + ' contains symbol fields');
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' fields must be enumerable own data properties');
    }
  }
  const rawSha = descriptors.sha256?.value;
  if (typeof rawSha !== 'string' || !SHA256.test(rawSha)) {
    throw new Error(label + '.sha256 must be an exact lowercase sha256 digest');
  }
  const rawCreatedAt = descriptors.createdAt?.value;
  timestamp(rawCreatedAt, label + '.createdAt');
  const artifact = normalizeArtifactRefV1(input);
  if (Date.parse(artifact.createdAt) > Date.parse(evaluatedAt)) {
    throw new Error(label + ' cannot be created after evaluatedAt');
  }
  return artifact;
}

function normalizeClaim(input, label, evidenceById, verificationEvidence) {
  const raw = record(input, CLAIM_KEYS, label);
  for (const key of CLAIM_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error(label + '.' + key + ' is required');
    }
  }
  const evidenceArtifactIds = uniqueIds(
    raw.evidenceArtifactIds,
    label + '.evidenceArtifactIds',
    { min: 1, max: MAX_EVIDENCE_PER_CLAIM },
  ).sort(asciiCompare);
  for (const artifactId of evidenceArtifactIds) {
    if (!evidenceById.has(artifactId)) {
      throw new Error(label + ' references unknown evidence artifact: ' + artifactId);
    }
    if (!verificationEvidence.has(artifactId)) {
      throw new Error(label + ' evidence must be included in result verification evidence');
    }
  }
  return deepFreeze({
    claimId: id(raw.claimId, label + '.claimId'),
    subjectId: id(raw.subjectId, label + '.subjectId'),
    predicateId: id(raw.predicateId, label + '.predicateId'),
    valueDigest: digest(raw.valueDigest, label + '.valueDigest'),
    evidenceArtifactIds,
  });
}

function normalizeResult(input, index, context) {
  const {
    participantSet,
    nodeById,
    evidenceById,
    evaluatedAt,
  } = context;
  const label = 'results[' + index + ']';
  const raw = record(input, RESULT_KEYS, label);
  for (const key of RESULT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error(label + '.' + key + ' is required');
    }
  }

  const nodeId = id(raw.nodeId, label + '.nodeId');
  if (!participantSet.has(nodeId)) {
    throw new Error(label + ' nodeId is not a fan-in participant');
  }
  const node = nodeById.get(nodeId);
  if (!TERMINAL.has(node.state)) {
    throw new Error(label + ' cannot report a non-terminal participant');
  }

  if (!raw.verification || typeof raw.verification !== 'object' || Array.isArray(raw.verification)) {
    throw new Error(label + '.verification must be a plain object');
  }
  const verificationDescriptors = Object.getOwnPropertyDescriptors(raw.verification);
  const rawVerifiedAt = verificationDescriptors.verifiedAt?.value;
  timestamp(rawVerifiedAt, label + '.verification.verifiedAt');
  const verification = normalizeVerificationV1(raw.verification);
  if (verification.verifiedAt !== rawVerifiedAt) {
    throw new Error(label + '.verification.verifiedAt representation is non-canonical');
  }
  if (Date.parse(verification.verifiedAt) < Date.parse(node.updatedAt)) {
    throw new Error(label + ' verification predates terminal node state');
  }
  if (Date.parse(verification.verifiedAt) > Date.parse(evaluatedAt)) {
    throw new Error(label + ' verification is after evaluatedAt');
  }

  const verificationEvidence = new Set(verification.evidenceArtifactIds);
  for (const artifactId of verificationEvidence) {
    if (!evidenceById.has(artifactId)) {
      throw new Error(label + ' verification references unknown evidence artifact: ' + artifactId);
    }
    const artifact = evidenceById.get(artifactId);
    if (Date.parse(artifact.createdAt) > Date.parse(verification.verifiedAt)) {
      throw new Error(label + ' verification references evidence created after verification: ' + artifactId);
    }
  }

  const resultArtifactIds = uniqueIds(
    raw.resultArtifactIds,
    label + '.resultArtifactIds',
    { max: 128 },
  ).sort(asciiCompare);
  for (const artifactId of resultArtifactIds) {
    if (!evidenceById.has(artifactId)) {
      throw new Error(label + ' references unknown result artifact: ' + artifactId);
    }
    if (!verificationEvidence.has(artifactId)) {
      throw new Error(label + ' result artifact must be included in result verification evidence');
    }
  }

  const claims = array(raw.claims, label + '.claims', { max: MAX_CLAIMS_PER_RESULT })
    .map((claim, claimIndex) => normalizeClaim(
      claim,
      label + '.claims[' + claimIndex + ']',
      evidenceById,
      verificationEvidence,
    ));
  const claimIds = new Set();
  for (const claim of claims) {
    if (claimIds.has(claim.claimId)) {
      throw new Error(label + ' contains duplicate claimId: ' + claim.claimId);
    }
    claimIds.add(claim.claimId);
  }
  claims.sort((left, right) => (
    asciiCompare(left.subjectId, right.subjectId)
    || asciiCompare(left.predicateId, right.predicateId)
    || asciiCompare(left.claimId, right.claimId)
  ));

  return deepFreeze({
    nodeId,
    nodeState: node.state,
    ownerId: node.ownerId,
    verification,
    resultArtifactIds,
    claims,
    selfVerificationReported: Boolean(
      node.ownerId && verification.verifierId && node.ownerId === verification.verifierId
    ),
  });
}

function buildContradictions(results) {
  const byKey = new Map();
  for (const result of results) {
    if (result.verification.status !== VerificationStatus.VERIFIED) continue;
    for (const claim of result.claims) {
      const key = claim.subjectId + '\u0000' + claim.predicateId;
      const group = byKey.get(key) || [];
      group.push({
        nodeId: result.nodeId,
        claimId: claim.claimId,
        subjectId: claim.subjectId,
        predicateId: claim.predicateId,
        valueDigest: claim.valueDigest,
        evidenceArtifactIds: claim.evidenceArtifactIds,
      });
      byKey.set(key, group);
    }
  }

  const contradictions = [];
  for (const group of byKey.values()) {
    const values = new Set(group.map(item => item.valueDigest));
    if (values.size <= 1) continue;
    const sorted = [...group].sort((left, right) => (
      asciiCompare(left.valueDigest, right.valueDigest)
      || asciiCompare(left.nodeId, right.nodeId)
      || asciiCompare(left.claimId, right.claimId)
    ));
    contradictions.push(deepFreeze({
      subjectId: sorted[0].subjectId,
      predicateId: sorted[0].predicateId,
      distinctValueDigests: [...values].sort(asciiCompare),
      reports: sorted,
      truthResolved: false,
      requiresIndependentResolution: true,
    }));
  }
  return contradictions.sort((left, right) => (
    asciiCompare(left.subjectId, right.subjectId)
    || asciiCompare(left.predicateId, right.predicateId)
  ));
}

function deriveStatus({
  nonTerminalParticipantIds,
  missingResultNodeIds,
  results,
  contradictions,
}) {
  if (nonTerminalParticipantIds.length) return ParallelFanInStatus.WAITING;
  if (missingResultNodeIds.length) return ParallelFanInStatus.EVIDENCE_INCOMPLETE;
  if (results.some(result => (
    result.nodeState !== AgentPlanNodeState.VERIFIED
    || result.verification.status !== VerificationStatus.VERIFIED
    || result.selfVerificationReported
    || result.verification.evidenceArtifactIds.length === 0
  ))) {
    return ParallelFanInStatus.REPORTED_NEGATIVE;
  }
  if (contradictions.length) return ParallelFanInStatus.CONTRADICTION_REPORTED;
  return ParallelFanInStatus.EVIDENCE_COMPLETE;
}

export function buildParallelFanInEvidenceV1(input) {
  const raw = record(input, REQUEST_KEYS, 'ParallelFanInRequestV1');
  for (const key of REQUEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error('ParallelFanInRequestV1.' + key + ' is required');
    }
  }
  if (raw.schemaVersion !== PARALLEL_FANIN_SCHEMA_VERSION) {
    throw new Error('ParallelFanInRequestV1 schemaVersion must be numeric 1');
  }

  const fanInId = id(raw.fanInId, 'fanInId');
  const evaluatedAt = timestamp(raw.evaluatedAt, 'evaluatedAt');
  const plan = normalizeAgentPlanV1(raw.plan);
  if (Date.parse(plan.updatedAt) > Date.parse(evaluatedAt)) {
    throw new Error('AgentPlan updatedAt cannot be after evaluatedAt');
  }

  const participantNodeIds = uniqueIds(
    raw.participantNodeIds,
    'participantNodeIds',
    { min: 2, max: MAX_PARTICIPANTS },
  ).sort(asciiCompare);
  const nodeById = new Map(plan.nodes.map(node => [node.nodeId, node]));
  for (const nodeId of participantNodeIds) {
    if (!nodeById.has(nodeId)) {
      throw new Error('participantNodeIds references unknown AgentPlan node: ' + nodeId);
    }
  }
  const participantSet = new Set(participantNodeIds);

  const evidenceArtifacts = array(
    raw.evidenceArtifacts,
    'evidenceArtifacts',
    { max: MAX_EVIDENCE_ARTIFACTS },
  ).map((artifact, index) => normalizeArtifact(artifact, index, evaluatedAt));
  const evidenceById = new Map();
  for (const artifact of evidenceArtifacts) {
    if (evidenceById.has(artifact.artifactId)) {
      throw new Error('evidenceArtifacts contains duplicate artifactId: ' + artifact.artifactId);
    }
    evidenceById.set(artifact.artifactId, artifact);
  }

  const results = array(raw.results, 'results', { max: MAX_RESULTS })
    .map((result, index) => normalizeResult(result, index, {
      participantSet,
      nodeById,
      evidenceById,
      evaluatedAt,
    }));
  const resultNodes = new Set();
  for (const result of results) {
    if (resultNodes.has(result.nodeId)) {
      throw new Error('results contains duplicate nodeId: ' + result.nodeId);
    }
    resultNodes.add(result.nodeId);
  }
  results.sort((left, right) => asciiCompare(left.nodeId, right.nodeId));

  const nonTerminalParticipantIds = participantNodeIds
    .filter(nodeId => !TERMINAL.has(nodeById.get(nodeId).state));
  const missingResultNodeIds = participantNodeIds
    .filter(nodeId => TERMINAL.has(nodeById.get(nodeId).state) && !resultNodes.has(nodeId));
  const contradictions = buildContradictions(results);
  const status = deriveStatus({
    nonTerminalParticipantIds,
    missingResultNodeIds,
    results,
    contradictions,
  });

  return deepFreeze({
    schemaVersion: PARALLEL_FANIN_SCHEMA_VERSION,
    fanInId,
    evaluatedAt,
    sourcePlan: {
      planId: plan.planId,
      jobId: plan.jobId,
      revision: plan.revision,
      updatedAt: plan.updatedAt,
    },
    participantNodeIds,
    status,
    results,
    nonTerminalParticipantIds,
    missingResultNodeIds,
    contradictions,
    evidenceArtifacts: evidenceArtifacts
      .map(artifact => ({
        artifactId: artifact.artifactId,
        sha256: artifact.sha256,
        createdAt: artifact.createdAt,
        sensitive: artifact.sensitive,
      }))
      .sort((left, right) => asciiCompare(left.artifactId, right.artifactId)),
    summary: {
      participantCount: participantNodeIds.length,
      terminalParticipantCount: participantNodeIds.length - nonTerminalParticipantIds.length,
      resultCount: results.length,
      reportedVerifiedCount: results.filter(
        result => result.verification.status === VerificationStatus.VERIFIED,
      ).length,
      reportedNegativeCount: results.filter(
        result => (
          result.nodeState !== AgentPlanNodeState.VERIFIED
          || result.verification.status !== VerificationStatus.VERIFIED
        ),
      ).length,
      negativeTerminalNodeCount: results.filter(
        result => result.nodeState !== AgentPlanNodeState.VERIFIED,
      ).length,
      selfVerificationRiskCount: results.filter(
        result => result.selfVerificationReported,
      ).length,
      contradictionCount: contradictions.length,
      missingResultCount: missingResultNodeIds.length,
    },
    sourceTrust: 'UNVERIFIED_INPUT',
    readOnly: true,
    advisoryOnly: true,
    truthResolved: false,
    synthesisAuthorized: false,
    mergeAuthorized: false,
    taskMutationAuthorized: false,
    executionAuthorized: false,
    verificationAuthorityMinted: false,
    requiresCanonicalVerificationResolution: true,
    requiresCanonicalArtifactResolution: true,
    requiresIndependentContradictionResolution: contradictions.length > 0,
  });
}
