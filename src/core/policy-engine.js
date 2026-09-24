import {
  PolicyDecisionKind,
  normalizeCapabilityV1,
  normalizePolicyDecisionV1,
  normalizeToolDescriptorV1,
  normalizeToolInvocationV1,
} from './universal-agent-contracts.js';

export const CentralPolicySchemaVersion = 1;

export const EffectRiskClass = Object.freeze({
  R0: 'R0',
  R1: 'R1',
  R2: 'R2',
  R3: 'R3',
  R4: 'R4',
});

export const DataSensitivityClass = Object.freeze({
  S0: 'S0',
  S1: 'S1',
  S2: 'S2',
  S3: 'S3',
});

export const OwnerPolicyDecision = Object.freeze({
  ALLOW: 'ALLOW',
  ASK: 'ASK',
  DENY: 'DENY',
});

const RISK_ORDER = new Map(Object.values(EffectRiskClass).map((value, index) => [value, index]));
const SENSITIVITY_ORDER = new Map(Object.values(DataSensitivityClass).map((value, index) => [value, index]));
const OWNER_DECISIONS = new Set(Object.values(OwnerPolicyDecision));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_RULES = 128;
const MAX_LIST = 128;

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  let prototype;
  try { prototype = Object.getPrototypeOf(value); }
  catch { throw new Error(`${label} must be a plain object`); }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length) {
    throw new Error(`${label} must not contain symbol fields`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function exactVersion(value, label) {
  if (value !== CentralPolicySchemaVersion) {
    throw new Error(`Unsupported ${label} schemaVersion`);
  }
  return value;
}

function id(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!ID.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a timestamp`);
  return new Date(parsed).toISOString();
}

function decision(value, label = 'decision') {
  if (typeof value !== 'string' || !OWNER_DECISIONS.has(value)) {
    throw new Error(`${label} must be ALLOW, ASK, or DENY`);
  }
  return value;
}

function risk(value, label = 'effectRisk') {
  if (typeof value !== 'string' || !RISK_ORDER.has(value)) {
    throw new Error(`${label} must be R0, R1, R2, R3, or R4`);
  }
  return value;
}

function sensitivity(value, label = 'dataSensitivity') {
  if (typeof value !== 'string' || !SENSITIVITY_ORDER.has(value)) {
    throw new Error(`${label} must be S0, S1, S2, or S3`);
  }
  return value;
}

function idList(value, label, { optional = true, max = MAX_LIST } = {}) {
  if (value == null && optional) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`${label} must be a bounded array`);
  }
  const normalized = value.map((item, index) => id(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicates`);
  return normalized;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const CLASSIFICATION_KEYS = new Set([
  'schemaVersion',
  'classificationId',
  'invocationId',
  'classifierId',
  'effectRisk',
  'dataSensitivity',
  'classifiedAt',
]);

export function normalizePolicyClassificationV1(input) {
  const raw = plainRecord(input, 'PolicyClassificationV1');
  exactKeys(raw, CLASSIFICATION_KEYS, 'PolicyClassificationV1');
  return deepFreeze({
    schemaVersion: exactVersion(raw.schemaVersion, 'PolicyClassificationV1'),
    classificationId: id(raw.classificationId, 'classificationId'),
    invocationId: id(raw.invocationId, 'classification invocationId'),
    classifierId: id(raw.classifierId, 'classifierId'),
    effectRisk: risk(raw.effectRisk),
    dataSensitivity: sensitivity(raw.dataSensitivity),
    classifiedAt: timestamp(raw.classifiedAt, 'classifiedAt'),
  });
}

const RULE_KEYS = new Set([
  'ruleId',
  'priority',
  'decision',
  'capabilityIds',
  'toolIds',
  'providerIds',
  'maxEffectRisk',
  'maxDataSensitivity',
]);

function normalizeRule(input, index) {
  const raw = plainRecord(input, `OwnerPolicyProfileV1.rules[${index}]`);
  exactKeys(raw, RULE_KEYS, `OwnerPolicyProfileV1.rules[${index}]`);
  if (!Number.isInteger(raw.priority) || raw.priority < 0 || raw.priority > 10_000) {
    throw new Error(`OwnerPolicyProfileV1.rules[${index}].priority is invalid`);
  }
  return deepFreeze({
    ruleId: id(raw.ruleId, `rules[${index}].ruleId`),
    priority: raw.priority,
    decision: decision(raw.decision, `rules[${index}].decision`),
    capabilityIds: idList(raw.capabilityIds, `rules[${index}].capabilityIds`),
    toolIds: idList(raw.toolIds, `rules[${index}].toolIds`),
    providerIds: idList(raw.providerIds, `rules[${index}].providerIds`),
    maxEffectRisk: risk(raw.maxEffectRisk, `rules[${index}].maxEffectRisk`),
    maxDataSensitivity: sensitivity(raw.maxDataSensitivity, `rules[${index}].maxDataSensitivity`),
  });
}

const PROFILE_KEYS = new Set([
  'schemaVersion',
  'policyId',
  'defaultDecision',
  'trustedClassifierIds',
  'rules',
]);

export function normalizeOwnerPolicyProfileV1(input) {
  const raw = plainRecord(input, 'OwnerPolicyProfileV1');
  exactKeys(raw, PROFILE_KEYS, 'OwnerPolicyProfileV1');
  exactVersion(raw.schemaVersion, 'OwnerPolicyProfileV1');
  const rulesRaw = raw.rules == null ? [] : raw.rules;
  if (!Array.isArray(rulesRaw) || rulesRaw.length > MAX_RULES) {
    throw new Error('OwnerPolicyProfileV1.rules must be a bounded array');
  }
  const rules = rulesRaw.map(normalizeRule);
  const ruleIds = rules.map(item => item.ruleId);
  if (new Set(ruleIds).size !== ruleIds.length) throw new Error('OwnerPolicyProfileV1.rules contains duplicate ruleId');
  const priorities = rules.map(item => item.priority);
  if (new Set(priorities).size !== priorities.length) throw new Error('OwnerPolicyProfileV1.rules contains duplicate priority');
  rules.sort((a, b) => b.priority - a.priority);
  const trustedClassifierIds = idList(raw.trustedClassifierIds, 'trustedClassifierIds', { optional: false, max: 64 });
  if (!trustedClassifierIds.length) throw new Error('trustedClassifierIds must not be empty');
  return deepFreeze({
    schemaVersion: CentralPolicySchemaVersion,
    policyId: id(raw.policyId, 'policyId'),
    defaultDecision: decision(raw.defaultDecision, 'defaultDecision'),
    trustedClassifierIds,
    rules,
  });
}

function strictUniversalAuthorityShape(raw, label, stringFields) {
  plainRecord(raw, label);
  if (raw.schemaVersion !== CentralPolicySchemaVersion) throw new Error(`Unsupported ${label} schemaVersion`);
  for (const field of stringFields) {
    if (raw[field] != null && typeof raw[field] !== 'string') {
      throw new Error(`${label}.${field} must be a string`);
    }
  }
}

function strictInvocation(input) {
  strictUniversalAuthorityShape(input, 'ToolInvocationV1', [
    'invocationId', 'toolId', 'providerId', 'policyDecisionId', 'createdAt', 'parentInvocationId',
  ]);
  if (!Array.isArray(input.requestedCapabilityIds)
    || input.requestedCapabilityIds.some(item => typeof item !== 'string')) {
    throw new Error('ToolInvocationV1.requestedCapabilityIds must contain strings');
  }
  return normalizeToolInvocationV1(input);
}

function strictToolDescriptor(input) {
  strictUniversalAuthorityShape(input, 'ToolDescriptorV1', [
    'toolId', 'providerId', 'label', 'description', 'inputSchemaRef', 'outputSchemaRef',
  ]);
  if (!Array.isArray(input.capabilityIds) || input.capabilityIds.some(item => typeof item !== 'string')) {
    throw new Error('ToolDescriptorV1.capabilityIds must contain strings');
  }
  return normalizeToolDescriptorV1(input);
}

function strictCapability(input, index) {
  strictUniversalAuthorityShape(input, `CapabilityV1[${index}]`, [
    'capabilityId', 'description', 'riskClass',
  ]);
  if (!RISK_ORDER.has(input.riskClass)) {
    throw new Error(`CapabilityV1[${index}].riskClass must be R0, R1, R2, R3, or R4`);
  }
  const normalized = normalizeCapabilityV1(input);
  risk(normalized.riskClass, `CapabilityV1[${index}].riskClass`);
  return normalized;
}

function subset(values, allowed) {
  const set = new Set(allowed);
  return values.every(value => set.has(value));
}

function ruleMatches(rule, invocation, effectiveRisk, dataSensitivity) {
  if (RISK_ORDER.get(effectiveRisk) > RISK_ORDER.get(rule.maxEffectRisk)) return false;
  if (SENSITIVITY_ORDER.get(dataSensitivity) > SENSITIVITY_ORDER.get(rule.maxDataSensitivity)) return false;
  if (rule.capabilityIds.length && !subset(invocation.requestedCapabilityIds, rule.capabilityIds)) return false;
  if (rule.toolIds.length && !rule.toolIds.includes(invocation.toolId)) return false;
  if (rule.providerIds.length && !rule.providerIds.includes(invocation.providerId)) return false;
  return true;
}

function canonicalDecision(ownerDecision) {
  if (ownerDecision === OwnerPolicyDecision.ALLOW) return PolicyDecisionKind.ALLOW;
  if (ownerDecision === OwnerPolicyDecision.ASK) return PolicyDecisionKind.REQUIRE_APPROVAL;
  return PolicyDecisionKind.DENY;
}

function makeDecision({
  invocationId,
  decisionId,
  ownerDecision,
  reasonCode,
  reason,
  decidedAt,
}) {
  const canonical = canonicalDecision(ownerDecision);
  return normalizePolicyDecisionV1({
    schemaVersion: CentralPolicySchemaVersion,
    decisionId,
    invocationId,
    decision: canonical,
    reasonCode,
    reason,
    approvalId: canonical === PolicyDecisionKind.REQUIRE_APPROVAL ? decisionId : null,
    decidedAt,
  });
}

function denyResult(context, reasonCode, reason) {
  const policyDecision = makeDecision({
    ...context,
    ownerDecision: OwnerPolicyDecision.DENY,
    reasonCode,
    reason,
  });
  return deepFreeze({
    policyDecision,
    policyId: context.profile.policyId,
    classificationId: context.classification.classificationId,
    classifierId: context.classification.classifierId,
    matchedRuleId: '',
    effectiveEffectRisk: context.effectiveRisk || context.classification.effectRisk,
    dataSensitivity: context.classification.dataSensitivity,
  });
}

/**
 * Pure central owner-policy evaluation.
 *
 * Risk/sensitivity never invent owner authority. They only select an explicit
 * owner rule/default. An explicit owner ALLOW therefore remains ALLOW even at
 * R4/S3. ASK maps to the existing REQUIRE_APPROVAL contract and DENY stays DENY.
 *
 * The classification itself must come from a classifier explicitly trusted by
 * the owner policy. Capability risk is canonical lower-bound evidence: a caller
 * may raise risk, but cannot lower a requested capability below its declared
 * CapabilityV1.riskClass.
 */
export function evaluateOwnerPolicyV1({
  profile,
  classification,
  invocation,
  toolDescriptor,
  capabilityDescriptors,
  grantedCapabilityIds,
  decisionId,
  decidedAt,
} = {}) {
  const normalizedProfile = normalizeOwnerPolicyProfileV1(profile);
  const normalizedClassification = normalizePolicyClassificationV1(classification);
  const normalizedInvocation = strictInvocation(invocation);
  const normalizedTool = strictToolDescriptor(toolDescriptor);
  const normalizedDecisionId = id(decisionId, 'decisionId');
  const normalizedDecidedAt = timestamp(decidedAt, 'decidedAt');
  const granted = idList(grantedCapabilityIds, 'grantedCapabilityIds', { optional: false });

  if (normalizedInvocation.policyDecisionId !== normalizedDecisionId) {
    throw new Error('ToolInvocationV1.policyDecisionId must equal decisionId');
  }

  if (!Array.isArray(capabilityDescriptors) || capabilityDescriptors.length > MAX_LIST) {
    throw new Error('capabilityDescriptors must be a bounded array');
  }
  const capabilities = capabilityDescriptors.map(strictCapability);
  const capabilityIds = capabilities.map(item => item.capabilityId);
  if (new Set(capabilityIds).size !== capabilityIds.length) {
    throw new Error('capabilityDescriptors contains duplicate capabilityId');
  }
  const byCapability = new Map(capabilities.map(item => [item.capabilityId, item]));

  const baseContext = {
    profile: normalizedProfile,
    classification: normalizedClassification,
    invocationId: normalizedInvocation.invocationId,
    decisionId: normalizedDecisionId,
    decidedAt: normalizedDecidedAt,
  };

  if (normalizedClassification.invocationId !== normalizedInvocation.invocationId) {
    return denyResult(baseContext, 'CLASSIFICATION_INVOCATION_MISMATCH', 'Policy classification is not bound to this invocation.');
  }
  if (!normalizedProfile.trustedClassifierIds.includes(normalizedClassification.classifierId)) {
    return denyResult(baseContext, 'CLASSIFIER_NOT_TRUSTED', 'Policy classification authority is not trusted by the owner profile.');
  }
  if (normalizedTool.toolId !== normalizedInvocation.toolId
    || normalizedTool.providerId !== normalizedInvocation.providerId) {
    return denyResult(baseContext, 'TOOL_DESCRIPTOR_MISMATCH', 'Tool descriptor identity does not match the invocation.');
  }
  if (!subset(normalizedInvocation.requestedCapabilityIds, normalizedTool.capabilityIds)) {
    return denyResult(baseContext, 'TOOL_CAPABILITY_NOT_ADVERTISED', 'Invocation requests a capability not advertised by the selected tool.');
  }
  if (!subset(normalizedInvocation.requestedCapabilityIds, granted)) {
    return denyResult(baseContext, 'CAPABILITY_NOT_GRANTED', 'Invocation exceeds the caller/parent capability grant.');
  }

  let effectiveRisk = normalizedClassification.effectRisk;
  for (const capabilityId of normalizedInvocation.requestedCapabilityIds) {
    const descriptor = byCapability.get(capabilityId);
    if (!descriptor) {
      return denyResult({ ...baseContext, effectiveRisk }, 'CAPABILITY_CLASSIFICATION_MISSING', 'A requested capability has no canonical risk descriptor.');
    }
    if (RISK_ORDER.get(descriptor.riskClass) > RISK_ORDER.get(effectiveRisk)) {
      effectiveRisk = descriptor.riskClass;
    }
  }

  const matchedRule = normalizedProfile.rules.find(rule =>
    ruleMatches(rule, normalizedInvocation, effectiveRisk, normalizedClassification.dataSensitivity));
  const ownerDecision = matchedRule?.decision || normalizedProfile.defaultDecision;
  const origin = matchedRule ? 'RULE' : 'DEFAULT';
  const policyDecision = makeDecision({
    invocationId: normalizedInvocation.invocationId,
    decisionId: normalizedDecisionId,
    ownerDecision,
    reasonCode: `OWNER_POLICY_${origin}_${ownerDecision}`,
    reason: matchedRule
      ? `Owner policy rule ${matchedRule.ruleId} resolved ${effectiveRisk}/${normalizedClassification.dataSensitivity} to ${ownerDecision}.`
      : `Owner policy default resolved ${effectiveRisk}/${normalizedClassification.dataSensitivity} to ${ownerDecision}.`,
    decidedAt: normalizedDecidedAt,
  });

  return deepFreeze({
    policyDecision,
    policyId: normalizedProfile.policyId,
    classificationId: normalizedClassification.classificationId,
    classifierId: normalizedClassification.classifierId,
    matchedRuleId: matchedRule?.ruleId || '',
    effectiveEffectRisk: effectiveRisk,
    dataSensitivity: normalizedClassification.dataSensitivity,
  });
}
