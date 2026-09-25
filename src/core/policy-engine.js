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

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      throw new Error(`${label} must not contain symbol fields`);
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
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
  if (value !== value.trim() || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
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

function strictArray(value, label, { optional = false, max = MAX_LIST } = {}) {
  if (value == null && optional) return [];
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains an invalid array property`);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
      throw new Error(`${label} contains an invalid array index`);
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
  }
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must not be sparse`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function dataOnlyJson(value, label, depth = 0) {
  if (depth > 64) throw new Error(`${label} is too deeply nested`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return strictArray(value, label, { max: 4096 })
      .map((item, index) => dataOnlyJson(item, `${label}[${index}]`, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} must contain JSON data only`);
  }
  const raw = plainRecord(value, label);
  const keys = Reflect.ownKeys(raw);
  if (keys.length > 4096) throw new Error(`${label} contains too many fields`);
  const out = Object.create(null);
  for (const key of keys) {
    out[key] = dataOnlyJson(raw[key], `${label}.${key}`, depth + 1);
  }
  return out;
}

function idList(value, label, { optional = true, max = MAX_LIST } = {}) {
  const input = strictArray(value, label, { optional, max });
  const normalized = input.map((item, index) => id(item, `${label}[${index}]`));
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
  'invocationFingerprint',
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
    invocationFingerprint: (() => {
      if (typeof raw.invocationFingerprint !== 'string'
          || !raw.invocationFingerprint
          || raw.invocationFingerprint.length > 300_000) {
        throw new Error('invocationFingerprint is invalid');
      }
      return raw.invocationFingerprint;
    })(),
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
  const rulesRaw = strictArray(raw.rules, 'OwnerPolicyProfileV1.rules', { optional: true, max: MAX_RULES });
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

function strictUniversalAuthorityShape(input, label, stringFields) {
  const raw = plainRecord(input, label);
  if (raw.schemaVersion !== CentralPolicySchemaVersion) throw new Error(`Unsupported ${label} schemaVersion`);
  for (const field of stringFields) {
    if (raw[field] != null && typeof raw[field] !== 'string') {
      throw new Error(`${label}.${field} must be a string`);
    }
  }
  return raw;
}

function strictInvocation(input) {
  const raw = strictUniversalAuthorityShape(input, 'ToolInvocationV1', [
    'invocationId', 'toolId', 'providerId', 'policyDecisionId', 'createdAt', 'parentInvocationId',
  ]);
  const requestedCapabilityIds = idList(
    raw.requestedCapabilityIds,
    'ToolInvocationV1.requestedCapabilityIds',
    { optional: false, max: MAX_LIST },
  );
  return normalizeToolInvocationV1({
    ...raw,
    invocationId: id(raw.invocationId, 'ToolInvocationV1.invocationId'),
    toolId: id(raw.toolId, 'ToolInvocationV1.toolId'),
    providerId: id(raw.providerId, 'ToolInvocationV1.providerId'),
    policyDecisionId: id(raw.policyDecisionId, 'ToolInvocationV1.policyDecisionId'),
    parentInvocationId: raw.parentInvocationId == null
      ? null
      : id(raw.parentInvocationId, 'ToolInvocationV1.parentInvocationId'),
    requestedCapabilityIds,
    arguments: dataOnlyJson(raw.arguments, 'ToolInvocationV1.arguments'),
  });
}

function canonicalFingerprintValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(canonicalFingerprintValue);
  const out = Object.create(null);
  for (const key of Object.keys(value).sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)))) {
    out[key] = canonicalFingerprintValue(value[key]);
  }
  return out;
}

export function createPolicyInvocationFingerprintV1(invocationInput) {
  const invocation = strictInvocation(invocationInput);
  return JSON.stringify([
    'chatgpt-autopilot-policy-invocation-v1',
    invocation.schemaVersion,
    invocation.invocationId,
    invocation.toolId,
    invocation.providerId,
    [...invocation.requestedCapabilityIds].sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0))),
    invocation.policyDecisionId,
    canonicalFingerprintValue(invocation.arguments),
    invocation.createdAt,
    invocation.parentInvocationId,
  ]);
}

function strictToolDescriptor(input) {
  const raw = strictUniversalAuthorityShape(input, 'ToolDescriptorV1', [
    'toolId', 'providerId', 'label', 'description', 'inputSchemaRef', 'outputSchemaRef',
  ]);
  const capabilityIds = idList(
    raw.capabilityIds,
    'ToolDescriptorV1.capabilityIds',
    { optional: false, max: MAX_LIST },
  );
  return normalizeToolDescriptorV1({
    ...raw,
    toolId: id(raw.toolId, 'ToolDescriptorV1.toolId'),
    providerId: id(raw.providerId, 'ToolDescriptorV1.providerId'),
    inputSchemaRef: raw.inputSchemaRef == null
      ? null
      : id(raw.inputSchemaRef, 'ToolDescriptorV1.inputSchemaRef'),
    outputSchemaRef: raw.outputSchemaRef == null
      ? null
      : id(raw.outputSchemaRef, 'ToolDescriptorV1.outputSchemaRef'),
    capabilityIds,
  });
}

function strictCapability(input, index) {
  const label = `CapabilityV1[${index}]`;
  const raw = strictUniversalAuthorityShape(input, label, [
    'capabilityId', 'description', 'riskClass',
  ]);
  if (!RISK_ORDER.has(raw.riskClass)) {
    throw new Error(`${label}.riskClass must be R0, R1, R2, R3, or R4`);
  }
  const normalized = normalizeCapabilityV1({
    ...raw,
    capabilityId: id(raw.capabilityId, `${label}.capabilityId`),
    attributes: raw.attributes == null ? {} : dataOnlyJson(raw.attributes, `${label}.attributes`),
  });
  risk(normalized.riskClass, `${label}.riskClass`);
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

  const capabilityInputs = strictArray(capabilityDescriptors, 'capabilityDescriptors', { max: MAX_LIST });
  const capabilities = capabilityInputs.map(strictCapability);
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
  const invocationFingerprint = createPolicyInvocationFingerprintV1(normalizedInvocation);
  if (normalizedClassification.invocationFingerprint !== invocationFingerprint) {
    return denyResult(baseContext, 'CLASSIFICATION_INVOCATION_FINGERPRINT_MISMATCH', 'Policy classification does not match the exact invocation bytes.');
  }
  if (Date.parse(normalizedClassification.classifiedAt) < Date.parse(normalizedInvocation.createdAt)) {
    return denyResult(baseContext, 'CLASSIFICATION_PREDATES_INVOCATION', 'Policy classification predates the invocation.');
  }
  if (Date.parse(normalizedDecidedAt) < Date.parse(normalizedClassification.classifiedAt)) {
    return denyResult(baseContext, 'POLICY_DECISION_PREDATES_CLASSIFICATION', 'Policy decision predates the classification.');
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
