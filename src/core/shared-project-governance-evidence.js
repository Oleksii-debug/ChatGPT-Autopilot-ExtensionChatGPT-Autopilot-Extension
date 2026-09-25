import { assessSharedProjectAccessV1 } from './shared-project-collaboration.js';

export const SHARED_PROJECT_GOVERNANCE_EVIDENCE_SCHEMA_VERSION = 1;
export const SHARED_PROJECT_GOVERNANCE_EXPORT_CAPABILITY = 'project.governance.export';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_PRINCIPALS = 128;

const REQUEST_KEYS = new Set([
  'bindingId',
  'viewerPrincipalId',
  'principalIds',
  'evaluatedAt',
]);

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function strictRecord(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must contain enumerable own data properties only`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function strictArray(input, label, max) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const length = lengthDescriptor.value;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains non-index data`);
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || String(index) !== key
        || !descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} contains invalid indexed data`);
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must be dense data-only array`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must use exact canonical identity representation`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function principalIdList(input) {
  const values = strictArray(input, 'principalIds', MAX_PRINCIPALS)
    .map((value, index) => exactId(value, `principalIds[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new Error('principalIds contains duplicate IDs');
  }
  values.sort(asciiCompare);
  return Object.freeze(values);
}

function accessRequest(bindingId, principalId, at, capabilityIds = []) {
  return {
    bindingId,
    principalId,
    at,
    requestedCapabilityIds: capabilityIds,
    requestedProviderIds: [],
    requestedOutboundDataClassIds: [],
  };
}

function assertSameCanonicalProject(reference, candidate, label) {
  if (candidate.bindingId !== reference.bindingId
      || candidate.projectId !== reference.projectId
      || candidate.projectRevisionId !== reference.projectRevisionId
      || candidate.organizationId !== reference.organizationId
      || candidate.governanceRegistryId !== reference.governanceRegistryId
      || candidate.governanceRegistryRevision !== reference.governanceRegistryRevision
      || candidate.resourceKey !== reference.resourceKey
      || candidate.evaluatedAt !== reference.evaluatedAt) {
    throw new Error(`${label} does not resolve to the canonical shared Project governance context`);
  }
}

function principalEvidence(access) {
  return freezeDeep({
    principalId: access.principalId,
    active: access.active,
    projectOwnerCurrentlyBound: access.projectOwnerCurrentlyBound,
    collaborationEligible: access.collaborationEligible,
    reasonCode: access.reasonCode,
    effectiveRoleIds: [...access.effectiveRoleIds],
    effectiveGrantIds: [...access.effectiveGrantIds],
    capabilityCeilingIds: [...access.capabilityCeilingIds],
    providerCeilingIds: [...access.providerCeilingIds],
    outboundDataClassIds: [...access.outboundDataClassIds],
    ownedCredentialBindingIds: [...access.ownedCredentialBindingIds],
    authorizationGranted: false,
    executionAuthorized: false,
    mutationAuthorized: false,
    credentialUseAuthorized: false,
    requiresCanonicalPolicyDecision: true,
  });
}

/**
 * Builds a deterministic, read-only governance evidence projection for one
 * canonical shared Project. It never exposes credential IDs, credential
 * material, broker secrets, policy decisions, or mutation authority.
 *
 * The caller must itself be inside the canonical project.governance.export
 * governance ceiling. That ceiling is still only policy input: this function
 * never converts eligibility into authorization.
 */
export async function buildSharedProjectGovernanceEvidenceV1(
  input = {},
  trustedProjectResolver,
) {
  const request = strictRecord(
    input,
    REQUEST_KEYS,
    'SharedProjectGovernanceEvidenceRequestV1',
  );
  const bindingId = exactId(request.bindingId, 'bindingId');
  const viewerPrincipalId = exactId(request.viewerPrincipalId, 'viewerPrincipalId');
  const principalIds = principalIdList(request.principalIds);
  const evaluatedAt = timestamp(request.evaluatedAt, 'evaluatedAt');

  const viewerAccess = await assessSharedProjectAccessV1(
    accessRequest(
      bindingId,
      viewerPrincipalId,
      evaluatedAt,
      [SHARED_PROJECT_GOVERNANCE_EXPORT_CAPABILITY],
    ),
    trustedProjectResolver,
  );
  if (!viewerAccess.collaborationEligible) {
    throw new Error(
      `governance evidence viewer is outside canonical export ceiling: ${viewerAccess.reasonCode}`,
    );
  }

  const principals = [];
  for (const principalId of principalIds) {
    const access = await assessSharedProjectAccessV1(
      accessRequest(bindingId, principalId, evaluatedAt),
      trustedProjectResolver,
    );
    assertSameCanonicalProject(viewerAccess, access, `principal ${principalId}`);
    principals.push(principalEvidence(access));
  }

  return freezeDeep({
    schemaVersion: SHARED_PROJECT_GOVERNANCE_EVIDENCE_SCHEMA_VERSION,
    bindingId: viewerAccess.bindingId,
    projectId: viewerAccess.projectId,
    projectRevisionId: viewerAccess.projectRevisionId,
    organizationId: viewerAccess.organizationId,
    governanceRegistryId: viewerAccess.governanceRegistryId,
    governanceRegistryRevision: viewerAccess.governanceRegistryRevision,
    resourceKey: viewerAccess.resourceKey,
    evaluatedAt,
    viewerPrincipalId,
    viewerRequiredCapabilityId: SHARED_PROJECT_GOVERNANCE_EXPORT_CAPABILITY,
    viewerAccessReasonCode: viewerAccess.reasonCode,
    principals,
    credentialExposure: 'OPAQUE_BINDING_IDS_ONLY',
    canonicalSourcesResolved: true,
    readOnly: true,
    advisoryOnly: true,
    exportAuthorized: false,
    authorizationGranted: false,
    executionAuthorized: false,
    mutationAuthorized: false,
    credentialUseAuthorized: false,
    requiresCanonicalPolicyDecision: true,
  });
}
