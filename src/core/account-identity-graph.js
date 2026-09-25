/**
 * Multi-Account Identity Graph V1.
 *
 * Deterministic identity-scope admission over owner-authorized account context
 * and independently trusted current authenticated-identity observations.
 *
 * This module does not own RBAC, credentials, providers, policy, effects, or a
 * durable identity store. A positive match is evidence for downstream policy,
 * never authorization.
 */

export const ACCOUNT_IDENTITY_GRAPH_VERSION = 1;

export const AccountIdentityContextStatus = Object.freeze({
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
});

export const AccountIdentityKind = Object.freeze({
  BROWSER_PROFILE: 'BROWSER_PROFILE',
  CHATGPT_ACCOUNT: 'CHATGPT_ACCOUNT',
  GOOGLE_ACCOUNT: 'GOOGLE_ACCOUNT',
  GITHUB_IDENTITY: 'GITHUB_IDENTITY',
  CMS_ACCOUNT: 'CMS_ACCOUNT',
  WORKSPACE: 'WORKSPACE',
  TENANT: 'TENANT',
  OTHER: 'OTHER',
});

export const AccountIdentityEnvironment = Object.freeze({
  PERSONAL: 'PERSONAL',
  WORK: 'WORK',
  DEVELOPMENT: 'DEVELOPMENT',
  STAGING: 'STAGING',
  PRODUCTION: 'PRODUCTION',
});

export const AccountIdentityVerdict = Object.freeze({
  MATCH: 'MATCH',
  BLOCKED_CONTEXT_REVOKED: 'BLOCKED_CONTEXT_REVOKED',
  BLOCKED_CONTEXT_STALE: 'BLOCKED_CONTEXT_STALE',
  BLOCKED_OBSERVATION_STALE: 'BLOCKED_OBSERVATION_STALE',
  BLOCKED_IDENTITY_MISMATCH: 'BLOCKED_IDENTITY_MISMATCH',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_IDS = 128;
const CONTEXT_STATUSES = new Set(Object.values(AccountIdentityContextStatus));
const ACCOUNT_KINDS = new Set(Object.values(AccountIdentityKind));
const ENVIRONMENTS = new Set(Object.values(AccountIdentityEnvironment));

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'assessmentId',
  'organizationId',
  'principalId',
  'contextId',
  'observationId',
  'providerId',
  'resourceKey',
  'invocationId',
  'evaluatedAt',
  'consequential',
]);

const CONTEXT_KEYS = new Set([
  'schemaVersion',
  'authorityRecordId',
  'contextId',
  'organizationId',
  'principalId',
  'providerId',
  'status',
  'accountKind',
  'environment',
  'accountSubjectId',
  'tenantId',
  'workspaceId',
  'browserProfileId',
  'credentialBindingId',
  'resourceKeys',
  'relatedContextIds',
  'createdAt',
  'revokedAt',
  'validThrough',
]);

const OBSERVATION_KEYS = new Set([
  'schemaVersion',
  'observationId',
  'observationAuthorityId',
  'contextId',
  'providerId',
  'accountKind',
  'environment',
  'accountSubjectId',
  'tenantId',
  'workspaceId',
  'browserProfileId',
  'observedAt',
  'validThrough',
  'evidenceArtifactIds',
]);

function record(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(label + ' must be a plain data object');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(input);
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    throw new Error(label + ' must expose stable data descriptors');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain data object');
  }

  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field');
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(snapshot);
}

function array(input, label, { min = 0, max = MAX_IDS } = {}) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(label + ' must be a bounded plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < min
      || lengthDescriptor.value > max) {
    throw new Error(label + ' length is invalid');
  }
  const length = lengthDescriptor.value;
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' contains non-canonical array data');
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

function id(value, label, { optional = false } = {}) {
  if (optional && (value === '' || value === null || value === undefined)) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must use exact canonical identity representation');
  }
  return value;
}

function timestamp(value, label, { optional = false } = {}) {
  if (optional && (value === '' || value === null || value === undefined)) return '';
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function enumValue(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function idList(input, label, { min = 0 } = {}) {
  const values = array(input, label, { min, max: MAX_IDS })
    .map((value, index) => id(value, label + '[' + index + ']'));
  if (new Set(values).size !== values.length) {
    throw new Error(label + ' contains duplicate identities');
  }
  return Object.freeze(values.sort(compare));
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function normalizeContext(input, expectedContextId) {
  const raw = record(input, CONTEXT_KEYS, 'TrustedAccountIdentityContextV1');
  if (raw.schemaVersion !== ACCOUNT_IDENTITY_GRAPH_VERSION) {
    throw new Error('TrustedAccountIdentityContextV1 schemaVersion must be 1');
  }
  const contextId = id(raw.contextId, 'TrustedAccountIdentityContextV1.contextId');
  if (contextId !== expectedContextId) {
    throw new Error('Trusted account context identity does not match requested contextId');
  }
  const status = enumValue(
    raw.status,
    CONTEXT_STATUSES,
    'TrustedAccountIdentityContextV1.status',
  );
  const accountKind = enumValue(
    raw.accountKind,
    ACCOUNT_KINDS,
    'TrustedAccountIdentityContextV1.accountKind',
  );
  const environment = enumValue(
    raw.environment,
    ENVIRONMENTS,
    'TrustedAccountIdentityContextV1.environment',
  );
  const createdAt = timestamp(raw.createdAt, 'TrustedAccountIdentityContextV1.createdAt');
  const revokedAt = timestamp(
    raw.revokedAt,
    'TrustedAccountIdentityContextV1.revokedAt',
    { optional: true },
  );
  const validThrough = timestamp(
    raw.validThrough,
    'TrustedAccountIdentityContextV1.validThrough',
  );
  if (validThrough < createdAt) {
    throw new Error('Trusted account context validity predates creation');
  }
  if (status === AccountIdentityContextStatus.ACTIVE && revokedAt) {
    throw new Error('ACTIVE trusted account context cannot have revokedAt');
  }
  if (status === AccountIdentityContextStatus.REVOKED && !revokedAt) {
    throw new Error('REVOKED trusted account context requires revokedAt');
  }
  if (revokedAt && (revokedAt < createdAt || revokedAt > validThrough)) {
    throw new Error('Trusted account context revokedAt is outside context lifetime');
  }

  const relatedContextIds = idList(
    raw.relatedContextIds,
    'TrustedAccountIdentityContextV1.relatedContextIds',
  );
  if (relatedContextIds.includes(contextId)) {
    throw new Error('Trusted account context cannot relate to itself');
  }

  return freeze({
    schemaVersion: ACCOUNT_IDENTITY_GRAPH_VERSION,
    authorityRecordId: id(
      raw.authorityRecordId,
      'TrustedAccountIdentityContextV1.authorityRecordId',
    ),
    contextId,
    organizationId: id(raw.organizationId, 'TrustedAccountIdentityContextV1.organizationId'),
    principalId: id(raw.principalId, 'TrustedAccountIdentityContextV1.principalId'),
    providerId: id(raw.providerId, 'TrustedAccountIdentityContextV1.providerId'),
    status,
    accountKind,
    environment,
    accountSubjectId: id(raw.accountSubjectId, 'TrustedAccountIdentityContextV1.accountSubjectId'),
    tenantId: id(raw.tenantId, 'TrustedAccountIdentityContextV1.tenantId', { optional: true }),
    workspaceId: id(
      raw.workspaceId,
      'TrustedAccountIdentityContextV1.workspaceId',
      { optional: true },
    ),
    browserProfileId: id(
      raw.browserProfileId,
      'TrustedAccountIdentityContextV1.browserProfileId',
      { optional: true },
    ),
    credentialBindingId: id(
      raw.credentialBindingId,
      'TrustedAccountIdentityContextV1.credentialBindingId',
      { optional: true },
    ),
    resourceKeys: idList(raw.resourceKeys, 'TrustedAccountIdentityContextV1.resourceKeys', { min: 1 }),
    relatedContextIds,
    createdAt,
    revokedAt,
    validThrough,
  });
}

function normalizeObservation(input, expectedObservationId) {
  const raw = record(input, OBSERVATION_KEYS, 'TrustedAuthenticatedIdentityObservationV1');
  if (raw.schemaVersion !== ACCOUNT_IDENTITY_GRAPH_VERSION) {
    throw new Error('TrustedAuthenticatedIdentityObservationV1 schemaVersion must be 1');
  }
  const observationId = id(
    raw.observationId,
    'TrustedAuthenticatedIdentityObservationV1.observationId',
  );
  if (observationId !== expectedObservationId) {
    throw new Error('Trusted authenticated observation does not match requested observationId');
  }
  const observedAt = timestamp(
    raw.observedAt,
    'TrustedAuthenticatedIdentityObservationV1.observedAt',
  );
  const validThrough = timestamp(
    raw.validThrough,
    'TrustedAuthenticatedIdentityObservationV1.validThrough',
  );
  if (validThrough < observedAt) {
    throw new Error('Trusted authenticated observation validity predates observation');
  }
  return freeze({
    schemaVersion: ACCOUNT_IDENTITY_GRAPH_VERSION,
    observationId,
    observationAuthorityId: id(
      raw.observationAuthorityId,
      'TrustedAuthenticatedIdentityObservationV1.observationAuthorityId',
    ),
    contextId: id(raw.contextId, 'TrustedAuthenticatedIdentityObservationV1.contextId'),
    providerId: id(raw.providerId, 'TrustedAuthenticatedIdentityObservationV1.providerId'),
    accountKind: enumValue(
      raw.accountKind,
      ACCOUNT_KINDS,
      'TrustedAuthenticatedIdentityObservationV1.accountKind',
    ),
    environment: enumValue(
      raw.environment,
      ENVIRONMENTS,
      'TrustedAuthenticatedIdentityObservationV1.environment',
    ),
    accountSubjectId: id(
      raw.accountSubjectId,
      'TrustedAuthenticatedIdentityObservationV1.accountSubjectId',
    ),
    tenantId: id(
      raw.tenantId,
      'TrustedAuthenticatedIdentityObservationV1.tenantId',
      { optional: true },
    ),
    workspaceId: id(
      raw.workspaceId,
      'TrustedAuthenticatedIdentityObservationV1.workspaceId',
      { optional: true },
    ),
    browserProfileId: id(
      raw.browserProfileId,
      'TrustedAuthenticatedIdentityObservationV1.browserProfileId',
      { optional: true },
    ),
    observedAt,
    validThrough,
    evidenceArtifactIds: idList(
      raw.evidenceArtifactIds,
      'TrustedAuthenticatedIdentityObservationV1.evidenceArtifactIds',
      { min: 1 },
    ),
  });
}

function resultBase(request, context, observation) {
  return {
    schemaVersion: ACCOUNT_IDENTITY_GRAPH_VERSION,
    assessmentId: request.assessmentId,
    organizationId: request.organizationId,
    principalId: request.principalId,
    invocationId: request.invocationId,
    providerId: request.providerId,
    resourceKey: request.resourceKey,
    contextId: context.contextId,
    contextAuthorityRecordId: context.authorityRecordId,
    observationId: observation.observationId,
    observationAuthorityId: observation.observationAuthorityId,
    evaluatedAt: request.evaluatedAt,
    consequential: request.consequential,
    evidenceArtifactIds: observation.evidenceArtifactIds,
    credentialBindingId: context.credentialBindingId,
    relatedContextIds: context.relatedContextIds,
    authorizationGranted: false,
    credentialUseAuthorized: false,
    executionAuthorized: false,
    policyDecision: 'NONE',
    requiresCanonicalGovernancePolicyDecision: true,
  };
}

function blocked(request, context, observation, verdict, blockers) {
  return freeze({
    ...resultBase(request, context, observation),
    verdict,
    identityMatch: false,
    blockers: Object.freeze(blockers),
    mayProceedToPolicy: false,
    reconciliationRequired: request.consequential,
  });
}

export async function assessAccountIdentityScopeV1(
  input = {},
  {
    resolveTrustedAccountContext,
    resolveTrustedIdentityObservation,
  } = {},
) {
  if (typeof resolveTrustedAccountContext !== 'function') {
    throw new Error('Canonical trusted account-context resolver is required');
  }
  if (typeof resolveTrustedIdentityObservation !== 'function') {
    throw new Error('Canonical trusted authenticated-identity resolver is required');
  }

  const raw = record(input, REQUEST_KEYS, 'AccountIdentityScopeAssessmentV1');
  if (raw.schemaVersion !== ACCOUNT_IDENTITY_GRAPH_VERSION) {
    throw new Error('AccountIdentityScopeAssessmentV1 schemaVersion must be 1');
  }
  const request = freeze({
    schemaVersion: ACCOUNT_IDENTITY_GRAPH_VERSION,
    assessmentId: id(raw.assessmentId, 'AccountIdentityScopeAssessmentV1.assessmentId'),
    organizationId: id(raw.organizationId, 'AccountIdentityScopeAssessmentV1.organizationId'),
    principalId: id(raw.principalId, 'AccountIdentityScopeAssessmentV1.principalId'),
    contextId: id(raw.contextId, 'AccountIdentityScopeAssessmentV1.contextId'),
    observationId: id(raw.observationId, 'AccountIdentityScopeAssessmentV1.observationId'),
    providerId: id(raw.providerId, 'AccountIdentityScopeAssessmentV1.providerId'),
    resourceKey: id(raw.resourceKey, 'AccountIdentityScopeAssessmentV1.resourceKey'),
    invocationId: id(raw.invocationId, 'AccountIdentityScopeAssessmentV1.invocationId'),
    evaluatedAt: timestamp(raw.evaluatedAt, 'AccountIdentityScopeAssessmentV1.evaluatedAt'),
    consequential: bool(raw.consequential, 'AccountIdentityScopeAssessmentV1.consequential'),
  });

  const contextInput = await resolveTrustedAccountContext(request.contextId);
  if (!contextInput) throw new Error('Trusted account context not found: ' + request.contextId);
  const context = normalizeContext(contextInput, request.contextId);

  const observationInput = await resolveTrustedIdentityObservation(request.observationId);
  if (!observationInput) {
    throw new Error('Trusted authenticated identity observation not found: ' + request.observationId);
  }
  const observation = normalizeObservation(observationInput, request.observationId);

  if (context.organizationId !== request.organizationId) {
    throw new Error('Trusted account context organizationId does not match request');
  }
  if (context.principalId !== request.principalId) {
    throw new Error('Trusted account context principalId does not match request');
  }
  if (context.providerId !== request.providerId) {
    throw new Error('Trusted account context providerId does not match request');
  }
  if (request.evaluatedAt < context.createdAt) {
    throw new Error('Identity assessment predates trusted account context');
  }
  if (!context.resourceKeys.includes(request.resourceKey)) {
    return blocked(
      request,
      context,
      observation,
      AccountIdentityVerdict.BLOCKED_IDENTITY_MISMATCH,
      ['RESOURCE_SCOPE_MISMATCH'],
    );
  }

  if (context.status === AccountIdentityContextStatus.REVOKED
      && request.evaluatedAt >= context.revokedAt) {
    return blocked(
      request,
      context,
      observation,
      AccountIdentityVerdict.BLOCKED_CONTEXT_REVOKED,
      ['CONTEXT_REVOKED'],
    );
  }
  if (request.evaluatedAt > context.validThrough) {
    return blocked(
      request,
      context,
      observation,
      AccountIdentityVerdict.BLOCKED_CONTEXT_STALE,
      ['CONTEXT_STALE'],
    );
  }

  if (observation.observedAt > request.evaluatedAt) {
    throw new Error('Trusted authenticated identity observation is future-dated');
  }
  if (request.evaluatedAt > observation.validThrough) {
    return blocked(
      request,
      context,
      observation,
      AccountIdentityVerdict.BLOCKED_OBSERVATION_STALE,
      ['OBSERVATION_STALE'],
    );
  }

  const blockers = [];
  const exactPairs = [
    ['CONTEXT_BINDING_MISMATCH', observation.contextId, context.contextId],
    ['PROVIDER_MISMATCH', observation.providerId, context.providerId],
    ['ACCOUNT_KIND_MISMATCH', observation.accountKind, context.accountKind],
    ['ENVIRONMENT_MISMATCH', observation.environment, context.environment],
    ['ACCOUNT_SUBJECT_MISMATCH', observation.accountSubjectId, context.accountSubjectId],
    ['TENANT_MISMATCH', observation.tenantId, context.tenantId],
    ['WORKSPACE_MISMATCH', observation.workspaceId, context.workspaceId],
    ['BROWSER_PROFILE_MISMATCH', observation.browserProfileId, context.browserProfileId],
  ];
  for (const [reason, observed, expected] of exactPairs) {
    if (observed !== expected) blockers.push(reason);
  }

  if (blockers.length > 0) {
    return blocked(
      request,
      context,
      observation,
      AccountIdentityVerdict.BLOCKED_IDENTITY_MISMATCH,
      blockers,
    );
  }

  return freeze({
    ...resultBase(request, context, observation),
    verdict: AccountIdentityVerdict.MATCH,
    identityMatch: true,
    blockers: Object.freeze([]),
    mayProceedToPolicy: true,
    reconciliationRequired: false,
  });
}
