import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const UNTRUSTED_CONTENT_GUARD_VERSION = 1;

export const UntrustedContentSourceKind = Object.freeze({
  WEB_PAGE: 'WEB_PAGE',
  EMAIL: 'EMAIL',
  DOCUMENT: 'DOCUMENT',
  CODE_COMMENT: 'CODE_COMMENT',
  TOOL_METADATA: 'TOOL_METADATA',
  REMOTE_AGENT: 'REMOTE_AGENT',
});

export const UntrustedContentGuardStatus = Object.freeze({
  SAFE_FOR_POLICY: 'SAFE_FOR_POLICY',
  BLOCKED: 'BLOCKED',
});

const SOURCE_KINDS = new Set(Object.values(UntrustedContentSourceKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_LIST = 128;

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

const SOURCE_KEYS = new Set([
  'schemaVersion',
  'sourceId',
  'sourceKind',
  'sourceOrigin',
  'artifactRef',
  'observedAt',
]);

const CEILING_KEYS = new Set([
  'schemaVersion',
  'envelopeId',
  'agentId',
  'jobId',
  'allowedCapabilityIds',
  'allowedToolIds',
  'allowedProviderIds',
  'allowedOutboundOrigins',
  'createdAt',
]);

const PROPOSAL_KEYS = new Set([
  'schemaVersion',
  'influenceId',
  'agentId',
  'jobId',
  'sourceId',
  'sourceArtifactId',
  'sourceSha256',
  'sourceObservedAt',
  'requestedCapabilityIds',
  'requestedToolIds',
  'requestedProviderIds',
  'requestedCredentialRefIds',
  'outboundOrigins',
  'createdAt',
]);

const ASSESSMENT_KEYS = new Set(['source', 'ceiling', 'proposal', 'assessedAt']);

function strictRecord(value, label, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new Error(`${label} must be a plain object`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} field ${key} must be an enumerable own data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function strictArray(value, label, { max = MAX_LIST } = {}) {
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
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must not be sparse`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function exactVersion(value, label) {
  if (value !== UNTRUSTED_CONTENT_GUARD_VERSION) {
    throw new Error(`Unsupported ${label} schemaVersion`);
  }
  return value;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${label} must be a timestamp`);
  const canonical = new Date(millis).toISOString();
  if (value !== canonical) throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  return canonical;
}

function canonicalOrigin(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim()) throw new Error(`${label} must be a canonical HTTP(S) origin`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a canonical HTTP(S) origin`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || value !== parsed.origin) {
    throw new Error(`${label} must be a canonical HTTP(S) origin`);
  }
  return parsed.origin;
}

function exactIdList(value, label) {
  const raw = strictArray(value ?? [], label);
  const out = raw.map((item, index) => exactId(item, `${label}[${index}]`));
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
}

function originList(value, label) {
  const raw = strictArray(value ?? [], label);
  const out = raw.map((item, index) => canonicalOrigin(item, `${label}[${index}]`));
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function normalizeArtifact(value) {
  const snapshot = strictRecord(value, 'UntrustedContentSourceV1 artifactRef', ARTIFACT_KEYS);
  const artifact = normalizeArtifactRefV1(snapshot);
  if (!artifact.sha256) throw new Error('UntrustedContentSourceV1 artifactRef requires sha256');
  if (artifact.sizeBytes < 1) throw new Error('UntrustedContentSourceV1 artifactRef requires non-empty material');
  return artifact;
}

export function normalizeUntrustedContentSourceV1(value) {
  const raw = strictRecord(value, 'UntrustedContentSourceV1', SOURCE_KEYS);
  exactVersion(raw.schemaVersion, 'UntrustedContentSourceV1');
  if (typeof raw.sourceKind !== 'string' || !SOURCE_KINDS.has(raw.sourceKind)) {
    throw new Error('UntrustedContentSourceV1 sourceKind is invalid');
  }
  const artifactRef = normalizeArtifact(raw.artifactRef);
  const observedAt = timestamp(raw.observedAt, 'UntrustedContentSourceV1 observedAt');
  if (artifactRef.createdAt > observedAt) {
    throw new Error('UntrustedContentSourceV1 artifact cannot postdate observation');
  }
  return freezeDeep({
    schemaVersion: UNTRUSTED_CONTENT_GUARD_VERSION,
    sourceId: exactId(raw.sourceId, 'UntrustedContentSourceV1 sourceId'),
    sourceKind: raw.sourceKind,
    sourceOrigin: canonicalOrigin(raw.sourceOrigin, 'UntrustedContentSourceV1 sourceOrigin', { optional: true }),
    artifactRef,
    observedAt,
    contentTrust: 'UNTRUSTED_DATA',
    instructionAuthority: 'NONE',
  });
}

export function normalizeUntrustedInfluenceCeilingV1(value) {
  const raw = strictRecord(value, 'UntrustedInfluenceCeilingV1', CEILING_KEYS);
  exactVersion(raw.schemaVersion, 'UntrustedInfluenceCeilingV1');
  return freezeDeep({
    schemaVersion: UNTRUSTED_CONTENT_GUARD_VERSION,
    envelopeId: exactId(raw.envelopeId, 'UntrustedInfluenceCeilingV1 envelopeId'),
    agentId: exactId(raw.agentId, 'UntrustedInfluenceCeilingV1 agentId'),
    jobId: exactId(raw.jobId, 'UntrustedInfluenceCeilingV1 jobId'),
    allowedCapabilityIds: exactIdList(raw.allowedCapabilityIds, 'UntrustedInfluenceCeilingV1 allowedCapabilityIds'),
    allowedToolIds: exactIdList(raw.allowedToolIds, 'UntrustedInfluenceCeilingV1 allowedToolIds'),
    allowedProviderIds: exactIdList(raw.allowedProviderIds, 'UntrustedInfluenceCeilingV1 allowedProviderIds'),
    allowedOutboundOrigins: originList(raw.allowedOutboundOrigins, 'UntrustedInfluenceCeilingV1 allowedOutboundOrigins'),
    createdAt: timestamp(raw.createdAt, 'UntrustedInfluenceCeilingV1 createdAt'),
  });
}

export function normalizeUntrustedInfluenceProposalV1(value) {
  const raw = strictRecord(value, 'UntrustedInfluenceProposalV1', PROPOSAL_KEYS);
  exactVersion(raw.schemaVersion, 'UntrustedInfluenceProposalV1');
  return freezeDeep({
    schemaVersion: UNTRUSTED_CONTENT_GUARD_VERSION,
    influenceId: exactId(raw.influenceId, 'UntrustedInfluenceProposalV1 influenceId'),
    agentId: exactId(raw.agentId, 'UntrustedInfluenceProposalV1 agentId'),
    jobId: exactId(raw.jobId, 'UntrustedInfluenceProposalV1 jobId'),
    sourceId: exactId(raw.sourceId, 'UntrustedInfluenceProposalV1 sourceId'),
    sourceArtifactId: exactId(raw.sourceArtifactId, 'UntrustedInfluenceProposalV1 sourceArtifactId'),
    sourceSha256: exactSha256(raw.sourceSha256, 'UntrustedInfluenceProposalV1 sourceSha256'),
    sourceObservedAt: timestamp(raw.sourceObservedAt, 'UntrustedInfluenceProposalV1 sourceObservedAt'),
    requestedCapabilityIds: exactIdList(raw.requestedCapabilityIds, 'UntrustedInfluenceProposalV1 requestedCapabilityIds'),
    requestedToolIds: exactIdList(raw.requestedToolIds, 'UntrustedInfluenceProposalV1 requestedToolIds'),
    requestedProviderIds: exactIdList(raw.requestedProviderIds, 'UntrustedInfluenceProposalV1 requestedProviderIds'),
    requestedCredentialRefIds: exactIdList(raw.requestedCredentialRefIds, 'UntrustedInfluenceProposalV1 requestedCredentialRefIds'),
    outboundOrigins: originList(raw.outboundOrigins, 'UntrustedInfluenceProposalV1 outboundOrigins'),
    createdAt: timestamp(raw.createdAt, 'UntrustedInfluenceProposalV1 createdAt'),
  });
}

function missing(requested, allowed) {
  const admitted = new Set(allowed);
  return requested.filter(item => !admitted.has(item));
}

function violation(code, values = []) {
  return freezeDeep({ code, values: [...values] });
}

/**
 * Pure pre-policy non-amplification assessment.
 *
 * SAFE_FOR_POLICY means only that untrusted content stayed inside the explicit
 * caller/job ceiling. It never grants permission. Canonical PolicyEngine,
 * provider admission, exact-effect and verifier requirements still apply.
 */
export function assessUntrustedContentInfluenceV1(value) {
  const request = strictRecord(value, 'Untrusted content assessment', ASSESSMENT_KEYS);
  const source = normalizeUntrustedContentSourceV1(request.source);
  const ceiling = normalizeUntrustedInfluenceCeilingV1(request.ceiling);
  const proposal = normalizeUntrustedInfluenceProposalV1(request.proposal);
  const assessedAt = timestamp(request.assessedAt, 'Untrusted content assessedAt');

  if (proposal.agentId !== ceiling.agentId || proposal.jobId !== ceiling.jobId) {
    throw new Error('Untrusted influence proposal identity does not match authority ceiling');
  }
  if (proposal.sourceId !== source.sourceId) {
    throw new Error('Untrusted influence proposal sourceId does not match source');
  }
  if (proposal.sourceArtifactId !== source.artifactRef.artifactId
      || proposal.sourceSha256 !== source.artifactRef.sha256
      || proposal.sourceObservedAt !== source.observedAt) {
    throw new Error('Untrusted influence proposal does not match exact source material observation');
  }
  if (source.observedAt > proposal.createdAt) {
    throw new Error('Untrusted influence proposal predates source observation');
  }
  if (ceiling.createdAt > proposal.createdAt) {
    throw new Error('Untrusted influence proposal predates authority ceiling');
  }
  if (proposal.createdAt > assessedAt) {
    throw new Error('Untrusted influence assessment predates proposal');
  }

  const violations = [];
  const capabilityEscalation = missing(proposal.requestedCapabilityIds, ceiling.allowedCapabilityIds);
  const toolEscalation = missing(proposal.requestedToolIds, ceiling.allowedToolIds);
  const providerEscalation = missing(proposal.requestedProviderIds, ceiling.allowedProviderIds);
  const outboundEscalation = missing(proposal.outboundOrigins, ceiling.allowedOutboundOrigins);

  if (capabilityEscalation.length) violations.push(violation('CAPABILITY_AUTHORITY_ESCALATION', capabilityEscalation));
  if (toolEscalation.length) violations.push(violation('TOOL_AUTHORITY_ESCALATION', toolEscalation));
  if (providerEscalation.length) violations.push(violation('PROVIDER_AUTHORITY_ESCALATION', providerEscalation));
  if (outboundEscalation.length) violations.push(violation('OUTBOUND_ORIGIN_ESCALATION', outboundEscalation));
  if (proposal.requestedCredentialRefIds.length) {
    violations.push(violation('UNTRUSTED_CREDENTIAL_SELECTION', proposal.requestedCredentialRefIds));
  }

  const signals = [];
  if (proposal.outboundOrigins.length) {
    if (!source.sourceOrigin) {
      signals.push('UNATTRIBUTED_SOURCE_OUTBOUND');
    } else if (proposal.outboundOrigins.some(origin => origin !== source.sourceOrigin)) {
      signals.push('CROSS_ORIGIN_OUTBOUND');
    }
  }

  const status = violations.length
    ? UntrustedContentGuardStatus.BLOCKED
    : UntrustedContentGuardStatus.SAFE_FOR_POLICY;

  return freezeDeep({
    schemaVersion: UNTRUSTED_CONTENT_GUARD_VERSION,
    status,
    influenceId: proposal.influenceId,
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
    sourceOrigin: source.sourceOrigin,
    sourceArtifactId: source.artifactRef.artifactId,
    sourceSha256: source.artifactRef.sha256,
    sourceObservedAt: source.observedAt,
    contentTrust: 'UNTRUSTED_DATA',
    instructionAuthority: 'NONE',
    authorityAmplificationAllowed: false,
    credentialSelectionAuthorized: false,
    executionAuthorized: false,
    policyDecisionGranted: false,
    requiresCanonicalPolicyDecision: true,
    requiresCanonicalProviderAdmission: true,
    requiresCanonicalVerificationForConsequentialEffects: true,
    violations,
    signals,
    assessedAt,
  });
}
