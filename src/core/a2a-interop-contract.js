export const A2A_INTEROP_SCHEMA_VERSION = 1;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PROTOCOL_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;
const MAX = Object.freeze({
  interfaces: 32,
  skills: 256,
  securitySchemes: 64,
  securityRequirements: 64,
  securityRequirementSchemes: 32,
  securityScopes: 128,
  skillSecurityRequirements: 256,
  evidence: 128,
  capabilities: 256,
  artifacts: 256,
});

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function record(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain data object');
  }
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(label + ' contains symbol fields');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    if (!allowed.has(key)) throw new Error(label + ' contains unknown field: ' + key);
    out[key] = descriptor.value;
  }
  return out;
}

function array(value, label, max, min = 0) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a plain dense array');
  }
  if (value.length < min || value.length > max) throw new Error(label + ' has invalid length');
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(label + ' contains non-index fields');
    }
  }
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(label + '[' + index + '] must be an enumerable own data item');
    }
    out.push(descriptor.value);
  }
  return out;
}

function version(value, label) {
  if (value !== A2A_INTEROP_SCHEMA_VERSION) {
    throw new Error(label + '.schemaVersion must be 1');
  }
  return value;
}

function id(value, label, optional = false) {
  if ((value === null || value === undefined) && optional) return null;
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(label + ' is invalid');
  return value;
}

function text(value, label, max = 1000) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(label + ' is invalid');
  return value;
}

function protocolVersion(value, label) {
  if (typeof value !== 'string' || !PROTOCOL_VERSION.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function protocolBinding(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 512) {
    throw new Error(label + ' is invalid');
  }
  if (/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u.test(value)) return value;
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(label + ' is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error(label + ' is invalid');
  }
  return parsed.toString();
}

function timestamp(value, label, optional = false) {
  if ((value === null || value === undefined) && optional) return null;
  if (typeof value !== 'string') throw new Error(label + ' must be a canonical timestamp');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(label + ' must be a canonical timestamp');
  }
  return value;
}

function httpsUrl(value, label) {
  if (typeof value !== 'string' || value.length > 4096 || value !== value.trim()) {
    throw new Error(label + ' must be an HTTPS URL');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(label + ' must be an HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error(label + ' must be an HTTPS URL');
  }
  return parsed.toString();
}

function secureCustomUrl(value, label) {
  if (typeof value !== 'string' || value.length > 4096 || value !== value.trim()) {
    throw new Error(label + ' must be a secure URL');
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(label + ' must be a secure URL'); }
  if (!['https:', 'wss:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.hash) {
    throw new Error(label + ' must be a secure URL');
  }
  return parsed.toString();
}

function grpcAddress(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 1024
      || value.includes('://')) {
    throw new Error(label + ' must be a canonical gRPC host:port');
  }
  let parsed;
  try { parsed = new URL('grpc://' + value); } catch {
    throw new Error(label + ' must be a canonical gRPC host:port');
  }
  const port = Number(parsed.port);
  if (!parsed.hostname || !parsed.port || !Number.isInteger(port) || port < 1 || port > 65535
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error(label + ' must be a canonical gRPC host:port');
  }
  return parsed.hostname + ':' + parsed.port;
}

function interfaceEndpoint(value, binding, label) {
  if (binding === 'GRPC') return grpcAddress(value, label);
  if (binding === 'JSONRPC' || binding === 'HTTP+JSON') return httpsUrl(value, label);
  return secureCustomUrl(value, label);
}

function ids(value, label, max, min = 0) {
  const out = array(value, label, max, min).map((item, index) => id(item, label + '[' + index + ']'));
  if (new Set(out).size !== out.length) throw new Error(label + ' contains duplicates');
  return out.sort(ascii);
}

function ascii(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function strings(value, label, max, min = 0) {
  const out = array(value, label, max, min)
    .map((item, index) => text(item, label + '[' + index + ']', 512));
  if (new Set(out).size !== out.length) throw new Error(label + ' contains duplicates');
  return out.sort(ascii);
}

function unique(items, field, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item[field])) throw new Error(label + ' contains duplicate ' + field);
    seen.add(item[field]);
  }
  return items;
}

function subset(requested, allowed) {
  const allowedSet = new Set(allowed);
  return requested.every(item => allowedSet.has(item));
}

const INTERFACE_KEYS = new Set(['url', 'protocolBinding', 'protocolVersion', 'tenant']);

function normalizeInterface(input, label) {
  const raw = record(input, label, INTERFACE_KEYS);
  const binding = protocolBinding(raw.protocolBinding, label + '.protocolBinding');
  return freeze({
    url: interfaceEndpoint(raw.url, binding, label + '.url'),
    protocolBinding: binding,
    protocolVersion: protocolVersion(raw.protocolVersion, label + '.protocolVersion'),
    tenant: id(raw.tenant, label + '.tenant', true),
  });
}

const SECURITY_SCHEME_REQUIREMENT_KEYS = new Set(['schemeId', 'scopeIds']);
const SECURITY_REQUIREMENT_KEYS = new Set(['schemes']);
const SKILL_SECURITY_REQUIREMENT_KEYS = new Set(['skillId', 'securityRequirements']);

function normalizeSecurityRequirement(input, label) {
  const raw = record(input, label, SECURITY_REQUIREMENT_KEYS);
  const schemes = array(
    raw.schemes,
    label + '.schemes',
    MAX.securityRequirementSchemes,
  ).map((item, index) => {
    const schemeLabel = label + '.schemes[' + index + ']';
    const schemeRaw = record(item, schemeLabel, SECURITY_SCHEME_REQUIREMENT_KEYS);
    return freeze({
      schemeId: id(schemeRaw.schemeId, schemeLabel + '.schemeId'),
      scopeIds: strings(schemeRaw.scopeIds, schemeLabel + '.scopeIds', MAX.securityScopes),
    });
  }).sort((left, right) => ascii(left.schemeId, right.schemeId));
  unique(schemes, 'schemeId', label + '.schemes');
  return freeze({ schemes });
}

function normalizeSecurityRequirements(input, label) {
  const source = input == null ? [] : input;
  const requirements = array(source, label, MAX.securityRequirements)
    .map((item, index) => normalizeSecurityRequirement(item, label + '[' + index + ']'));
  const seen = new Set();
  for (const requirement of requirements) {
    const key = JSON.stringify(requirement);
    if (seen.has(key)) throw new Error(label + ' contains duplicate requirements');
    seen.add(key);
  }
  return requirements;
}

function normalizeSkillSecurityRequirement(input, label) {
  const raw = record(input, label, SKILL_SECURITY_REQUIREMENT_KEYS);
  return freeze({
    skillId: id(raw.skillId, label + '.skillId'),
    securityRequirements: normalizeSecurityRequirements(
      raw.securityRequirements,
      label + '.securityRequirements',
    ),
  });
}

function requirementSchemeIds(requirement) {
  return requirement.schemes.map(item => item.schemeId);
}

function requirementSatisfied(required, declared) {
  const declaredByScheme = new Map(
    declared.schemes.map(item => [item.schemeId, new Set(item.scopeIds)]),
  );
  return required.schemes.every((scheme) => {
    const declaredScopes = declaredByScheme.get(scheme.schemeId);
    return declaredScopes && scheme.scopeIds.every(scopeId => declaredScopes.has(scopeId));
  });
}

const CARD_KEYS = new Set([
  'schemaVersion', 'remoteAgentId', 'cardUrl', 'cardSha256', 'name',
  'supportedInterfaces', 'skillIds', 'securitySchemeIds',
  'securityRequirements', 'skillSecurityRequirements',
  'signatureEvidenceArtifactIds', 'discoveredAt',
  'advisoryOnly', 'executionAuthorized', 'credentialMaterialPresent',
]);

export function normalizeA2ARemoteAgentCardRefV1(input) {
  const raw = record(input, 'A2ARemoteAgentCardRefV1', CARD_KEYS);
  version(raw.schemaVersion, 'A2ARemoteAgentCardRefV1');
  if (raw.advisoryOnly != null && raw.advisoryOnly !== true) {
    throw new Error('A2ARemoteAgentCardRefV1 must remain advisoryOnly');
  }
  if (raw.executionAuthorized != null && raw.executionAuthorized !== false) {
    throw new Error('A2ARemoteAgentCardRefV1 cannot authorize execution');
  }
  if (raw.credentialMaterialPresent != null && raw.credentialMaterialPresent !== false) {
    throw new Error('A2ARemoteAgentCardRefV1 cannot contain credential material');
  }

  const supportedInterfaces = array(raw.supportedInterfaces, 'supportedInterfaces', MAX.interfaces, 1)
    .map((item, index) => normalizeInterface(item, 'supportedInterfaces[' + index + ']'));
  const interfaceKeys = new Set();
  for (const iface of supportedInterfaces) {
    const key = [iface.url, iface.protocolBinding, iface.protocolVersion, iface.tenant || ''].join('\u0000');
    if (interfaceKeys.has(key)) throw new Error('supportedInterfaces contains duplicate interface binding');
    interfaceKeys.add(key);
  }

  const skillIds = ids(raw.skillIds, 'skillIds', MAX.skills, 1);
  const securitySchemeIds = ids(raw.securitySchemeIds, 'securitySchemeIds', MAX.securitySchemes);
  const securityRequirements = normalizeSecurityRequirements(
    raw.securityRequirements,
    'securityRequirements',
  );
  const skillSecurityRequirements = array(
    raw.skillSecurityRequirements == null ? [] : raw.skillSecurityRequirements,
    'skillSecurityRequirements',
    MAX.skillSecurityRequirements,
  ).map((item, index) => normalizeSkillSecurityRequirement(
    item,
    'skillSecurityRequirements[' + index + ']',
  )).sort((left, right) => ascii(left.skillId, right.skillId));
  unique(skillSecurityRequirements, 'skillId', 'skillSecurityRequirements');

  for (const requirement of securityRequirements) {
    if (!subset(requirementSchemeIds(requirement), securitySchemeIds)) {
      throw new Error('securityRequirements references unknown security scheme');
    }
  }
  for (const skillRequirement of skillSecurityRequirements) {
    if (!skillIds.includes(skillRequirement.skillId)) {
      throw new Error('skillSecurityRequirements references unknown skill');
    }
    for (const requirement of skillRequirement.securityRequirements) {
      if (!subset(requirementSchemeIds(requirement), securitySchemeIds)) {
        throw new Error('skillSecurityRequirements references unknown security scheme');
      }
    }
  }

  return freeze({
    schemaVersion: 1,
    remoteAgentId: id(raw.remoteAgentId, 'remoteAgentId'),
    cardUrl: httpsUrl(raw.cardUrl, 'cardUrl'),
    cardSha256: digest(raw.cardSha256, 'cardSha256'),
    name: text(raw.name, 'name', 500),
    supportedInterfaces,
    skillIds,
    securitySchemeIds,
    securityRequirements,
    skillSecurityRequirements,
    signatureEvidenceArtifactIds: ids(
      raw.signatureEvidenceArtifactIds,
      'signatureEvidenceArtifactIds',
      MAX.evidence,
    ),
    discoveredAt: timestamp(raw.discoveredAt, 'discoveredAt'),
    advisoryOnly: true,
    executionAuthorized: false,
    credentialMaterialPresent: false,
  });
}

const ADMISSION_KEYS = new Set([
  'schemaVersion', 'admissionRefId', 'remoteAgentId', 'cardSha256',
  'interfaceUrl', 'protocolBinding', 'protocolVersion', 'tenant',
  'allowedSkillIds', 'allowedCapabilityIds', 'allowedSecuritySchemeIds',
  'decidedAt', 'expiresAt',
  'advisoryOnly', 'executionAuthorized', 'credentialUseAuthorized',
]);

export function normalizeA2ARemoteAdmissionRefV1(input) {
  const raw = record(input, 'A2ARemoteAdmissionRefV1', ADMISSION_KEYS);
  version(raw.schemaVersion, 'A2ARemoteAdmissionRefV1');
  if (raw.advisoryOnly != null && raw.advisoryOnly !== true) {
    throw new Error('A2ARemoteAdmissionRefV1 must remain advisoryOnly');
  }
  if (raw.executionAuthorized != null && raw.executionAuthorized !== false) {
    throw new Error('A2ARemoteAdmissionRefV1 cannot authorize execution');
  }
  if (raw.credentialUseAuthorized != null && raw.credentialUseAuthorized !== false) {
    throw new Error('A2ARemoteAdmissionRefV1 cannot authorize credential use');
  }
  const decidedAt = timestamp(raw.decidedAt, 'decidedAt');
  const expiresAt = timestamp(raw.expiresAt, 'expiresAt', true);
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(decidedAt)) {
    throw new Error('expiresAt must be after decidedAt');
  }
  const binding = protocolBinding(raw.protocolBinding, 'protocolBinding');
  return freeze({
    schemaVersion: 1,
    admissionRefId: id(raw.admissionRefId, 'admissionRefId'),
    remoteAgentId: id(raw.remoteAgentId, 'remoteAgentId'),
    cardSha256: digest(raw.cardSha256, 'cardSha256'),
    interfaceUrl: interfaceEndpoint(raw.interfaceUrl, binding, 'interfaceUrl'),
    protocolBinding: binding,
    protocolVersion: protocolVersion(raw.protocolVersion, 'protocolVersion'),
    tenant: id(raw.tenant, 'tenant', true),
    allowedSkillIds: ids(raw.allowedSkillIds, 'allowedSkillIds', MAX.skills, 1),
    allowedCapabilityIds: ids(raw.allowedCapabilityIds, 'allowedCapabilityIds', MAX.capabilities),
    allowedSecuritySchemeIds: ids(
      raw.allowedSecuritySchemeIds,
      'allowedSecuritySchemeIds',
      MAX.securitySchemes,
    ),
    decidedAt,
    expiresAt,
    advisoryOnly: true,
    executionAuthorized: false,
    credentialUseAuthorized: false,
  });
}

const DELEGATION_KEYS = new Set([
  'schemaVersion', 'delegationId', 'localAgentId', 'localTaskId', 'effectId', 'remoteAgentId',
  'requestedSkillId', 'requestedCapabilityIds', 'declaredSecurityRequirement',
  'taskEnvelopeArtifactId', 'inputArtifactIds', 'policyDecisionId', 'createdAt',
  'credentialMaterialPresent', 'executionAuthorized',
]);

export function normalizeA2ADelegationRequestV1(input) {
  const raw = record(input, 'A2ADelegationRequestV1', DELEGATION_KEYS);
  version(raw.schemaVersion, 'A2ADelegationRequestV1');
  if (raw.credentialMaterialPresent != null && raw.credentialMaterialPresent !== false) {
    throw new Error('A2ADelegationRequestV1 cannot contain credential material');
  }
  if (raw.executionAuthorized != null && raw.executionAuthorized !== false) {
    throw new Error('A2ADelegationRequestV1 cannot authorize execution');
  }
  return freeze({
    schemaVersion: 1,
    delegationId: id(raw.delegationId, 'delegationId'),
    localAgentId: id(raw.localAgentId, 'localAgentId'),
    localTaskId: id(raw.localTaskId, 'localTaskId'),
    effectId: id(raw.effectId, 'effectId'),
    remoteAgentId: id(raw.remoteAgentId, 'remoteAgentId'),
    requestedSkillId: id(raw.requestedSkillId, 'requestedSkillId'),
    requestedCapabilityIds: ids(
      raw.requestedCapabilityIds,
      'requestedCapabilityIds',
      MAX.capabilities,
    ),
    declaredSecurityRequirement: normalizeSecurityRequirement(
      raw.declaredSecurityRequirement,
      'declaredSecurityRequirement',
    ),
    taskEnvelopeArtifactId: id(raw.taskEnvelopeArtifactId, 'taskEnvelopeArtifactId'),
    inputArtifactIds: ids(raw.inputArtifactIds, 'inputArtifactIds', MAX.artifacts),
    policyDecisionId: id(raw.policyDecisionId, 'policyDecisionId'),
    createdAt: timestamp(raw.createdAt, 'createdAt'),
    credentialMaterialPresent: false,
    executionAuthorized: false,
  });
}

function sameInterface(admission, iface) {
  return admission.interfaceUrl === iface.url
    && admission.protocolBinding === iface.protocolBinding
    && admission.protocolVersion === iface.protocolVersion
    && admission.tenant === iface.tenant;
}

export function assessA2ADelegationV1({
  card: cardInput,
  admission: admissionInput,
  delegation: delegationInput,
} = {}) {
  const card = normalizeA2ARemoteAgentCardRefV1(cardInput);
  const admission = normalizeA2ARemoteAdmissionRefV1(admissionInput);
  const delegation = normalizeA2ADelegationRequestV1(delegationInput);
  const reasons = [];

  if (admission.remoteAgentId !== card.remoteAgentId) reasons.push('ADMISSION_AGENT_MISMATCH');
  if (delegation.remoteAgentId !== card.remoteAgentId) reasons.push('DELEGATION_AGENT_MISMATCH');
  if (admission.cardSha256 !== card.cardSha256) reasons.push('CARD_DIGEST_DRIFT');

  const selectedInterface = card.supportedInterfaces.find(iface => sameInterface(admission, iface)) || null;
  if (!selectedInterface) reasons.push('INTERFACE_NOT_IN_CARD');

  if (!subset(admission.allowedSkillIds, card.skillIds)) reasons.push('ADMISSION_SKILL_SET_NOT_IN_CARD');
  if (!subset(admission.allowedSecuritySchemeIds, card.securitySchemeIds)) {
    reasons.push('ADMISSION_SECURITY_SET_NOT_IN_CARD');
  }
  if (!card.skillIds.includes(delegation.requestedSkillId)) reasons.push('SKILL_NOT_IN_CARD');
  if (!admission.allowedSkillIds.includes(delegation.requestedSkillId)) reasons.push('SKILL_NOT_ADMITTED');

  if (!subset(delegation.requestedCapabilityIds, admission.allowedCapabilityIds)) {
    reasons.push('CAPABILITY_NOT_ADMITTED');
  }
  const declaredSecuritySchemeIds = requirementSchemeIds(delegation.declaredSecurityRequirement);
  if (!subset(declaredSecuritySchemeIds, card.securitySchemeIds)) {
    reasons.push('SECURITY_SCHEME_NOT_IN_CARD');
  }
  if (!subset(declaredSecuritySchemeIds, admission.allowedSecuritySchemeIds)) {
    reasons.push('SECURITY_SCHEME_NOT_ADMITTED');
  }
  if (card.securityRequirements.length
      && !card.securityRequirements.some(
        requirement => requirementSatisfied(requirement, delegation.declaredSecurityRequirement),
      )) {
    reasons.push('AGENT_SECURITY_REQUIREMENT_UNSATISFIED');
  }
  const skillSecurity = card.skillSecurityRequirements.find(
    item => item.skillId === delegation.requestedSkillId,
  );
  if (skillSecurity && skillSecurity.securityRequirements.length
      && !skillSecurity.securityRequirements.some(
        requirement => requirementSatisfied(requirement, delegation.declaredSecurityRequirement),
      )) {
    reasons.push('SKILL_SECURITY_REQUIREMENT_UNSATISFIED');
  }

  const createdMs = Date.parse(delegation.createdAt);
  if (createdMs < Date.parse(card.discoveredAt)) reasons.push('DELEGATION_PREDATES_DISCOVERY');
  if (createdMs < Date.parse(admission.decidedAt)) reasons.push('DELEGATION_PREDATES_ADMISSION');
  if (admission.expiresAt && createdMs >= Date.parse(admission.expiresAt)) {
    reasons.push('ADMISSION_EXPIRED');
  }

  reasons.sort(ascii);
  return freeze({
    schemaVersion: 1,
    remoteAgentId: card.remoteAgentId,
    cardSha256: card.cardSha256,
    admissionRefId: admission.admissionRefId,
    delegationId: delegation.delegationId,
    localAgentId: delegation.localAgentId,
    localTaskId: delegation.localTaskId,
    effectId: delegation.effectId,
    requestedSkillId: delegation.requestedSkillId,
    selectedInterface,
    status: reasons.length ? 'BLOCKED' : 'READY_FOR_POLICY',
    reasons,
    policyDecisionId: delegation.policyDecisionId,
    taskEnvelopeArtifactId: delegation.taskEnvelopeArtifactId,
    inputArtifactIds: delegation.inputArtifactIds,
    requestedCapabilityIds: delegation.requestedCapabilityIds,
    declaredSecurityRequirement: delegation.declaredSecurityRequirement,
    declaredSecuritySchemeIds,
    advisoryOnly: true,
    executionAuthorized: false,
    credentialUseAuthorized: false,
    requiresPolicyDecision: true,
    credentialsOutOfBand: true,
    remoteTaskCreated: false,
  });
}

export function assessA2ARemoteCardDriftV1(baselineInput, currentInput) {
  const baseline = normalizeA2ARemoteAgentCardRefV1(baselineInput);
  const current = normalizeA2ARemoteAgentCardRefV1(currentInput);
  if (baseline.remoteAgentId !== current.remoteAgentId) {
    throw new Error('Remote Agent identity mismatch');
  }
  const signals = [];
  if (baseline.cardUrl !== current.cardUrl) signals.push('CARD_URL_CHANGED');
  if (baseline.cardSha256 !== current.cardSha256) signals.push('CARD_DIGEST_CHANGED');
  if (baseline.name !== current.name) signals.push('NAME_CHANGED');
  if (JSON.stringify(baseline.supportedInterfaces) !== JSON.stringify(current.supportedInterfaces)) {
    signals.push('INTERFACES_CHANGED');
  }
  if (JSON.stringify(baseline.skillIds) !== JSON.stringify(current.skillIds)) signals.push('SKILLS_CHANGED');
  if (JSON.stringify(baseline.securitySchemeIds) !== JSON.stringify(current.securitySchemeIds)) {
    signals.push('SECURITY_SCHEMES_CHANGED');
  }
  if (JSON.stringify(baseline.securityRequirements) !== JSON.stringify(current.securityRequirements)) {
    signals.push('SECURITY_REQUIREMENTS_CHANGED');
  }
  if (JSON.stringify(baseline.skillSecurityRequirements)
      !== JSON.stringify(current.skillSecurityRequirements)) {
    signals.push('SKILL_SECURITY_REQUIREMENTS_CHANGED');
  }
  if (JSON.stringify(baseline.signatureEvidenceArtifactIds)
      !== JSON.stringify(current.signatureEvidenceArtifactIds)) {
    signals.push('SIGNATURE_EVIDENCE_CHANGED');
  }
  if (Date.parse(current.discoveredAt) < Date.parse(baseline.discoveredAt)) {
    signals.push('OBSERVATION_REGRESSED');
  }
  return freeze({
    schemaVersion: 1,
    remoteAgentId: baseline.remoteAgentId,
    baselineCardSha256: baseline.cardSha256,
    currentCardSha256: current.cardSha256,
    status: signals.length ? 'DRIFTED' : 'UNCHANGED',
    signals,
    advisoryOnly: true,
    executionAuthorized: false,
    credentialUseAuthorized: false,
  });
}
