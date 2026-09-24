export const IDENTITY_GOVERNANCE_SCHEMA_VERSION = 1;

export const GovernancePrincipalKind = Object.freeze({
  USER: 'USER',
  AGENT: 'AGENT',
  SERVICE: 'SERVICE',
  REMOTE_AGENT: 'REMOTE_AGENT',
});

export const GovernancePrincipalStatus = Object.freeze({
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
});

export const CredentialOwnershipStatus = Object.freeze({
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
});

const PRINCIPAL_KINDS = new Set(Object.values(GovernancePrincipalKind));
const PRINCIPAL_STATUSES = new Set(Object.values(GovernancePrincipalStatus));
const CREDENTIAL_STATUSES = new Set(Object.values(CredentialOwnershipStatus));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_TEXT = 4_000;
const MAX_PRINCIPALS = 2_000;
const MAX_ROLES = 512;
const MAX_GRANTS = 20_000;
const MAX_CREDENTIAL_BINDINGS = 10_000;
const MAX_IDS = 512;

const REGISTRY_KEYS = new Set([
  'schemaVersion', 'registryId', 'organizationId', 'revision',
  'principals', 'roles', 'grants', 'credentialOwnership', 'updatedAt',
]);
const PRINCIPAL_KEYS = new Set([
  'principalId', 'organizationId', 'kind', 'displayName',
  'parentPrincipalId', 'status', 'createdAt', 'revokedAt',
]);
const ROLE_KEYS = new Set([
  'roleId', 'title', 'capabilityCeilingIds',
  'providerCeilingIds', 'outboundDataClassIds',
]);
const GRANT_KEYS = new Set([
  'grantId', 'principalId', 'roleId', 'resourceKeys',
  'grantedByPrincipalId', 'createdAt', 'expiresAt', 'revokedAt',
]);
const CREDENTIAL_KEYS = new Set([
  'bindingId', 'credentialId', 'brokerId', 'ownerPrincipalId',
  'status', 'createdAt', 'revokedAt',
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
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error(`${label} must contain enumerable data properties only`);
    }
  }
  for (const key of allowed) {
    if (key in input && !Object.prototype.hasOwnProperty.call(input, key)) {
      throw new Error(`${label} contains inherited field: ${key}`);
    }
  }
  return input;
}

function strictArray(input, label, { min = 0, max } = {}) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(`${label} must be a plain array`);
  }
  if (!Number.isInteger(max) || input.length < min || input.length > max) {
    throw new Error(`${label} must contain ${min}-${max} items`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains non-index field`);
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index) || index < 0 || index >= input.length) {
      throw new Error(`${label} contains invalid index`);
    }
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
  }
  const out = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must not be sparse`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function id(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function text(value, label, { optional = false, max = MAX_TEXT } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new Error(`${label} must be bounded canonical text`);
  }
  return value;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function idList(input, label, { min = 0, max = MAX_IDS } = {}) {
  const raw = strictArray(input, label, { min, max });
  const values = raw.map((value, index) => id(value, `${label}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicate IDs`);
  }
  values.sort(asciiCompare);
  return Object.freeze(values);
}

function normalizePrincipal(input, index, organizationId) {
  const label = `principals[${index}]`;
  const raw = strictRecord(input, PRINCIPAL_KEYS, label);
  const kind = id(raw.kind, `${label}.kind`);
  const status = id(raw.status, `${label}.status`);
  if (!PRINCIPAL_KINDS.has(kind)) throw new Error(`${label}.kind is invalid`);
  if (!PRINCIPAL_STATUSES.has(status)) throw new Error(`${label}.status is invalid`);

  const principalOrganizationId = id(raw.organizationId, `${label}.organizationId`);
  if (principalOrganizationId !== organizationId) {
    throw new Error(`${label}.organizationId does not match registry organizationId`);
  }
  const parentPrincipalId = id(raw.parentPrincipalId, `${label}.parentPrincipalId`, { optional: true });
  if (kind === GovernancePrincipalKind.USER && parentPrincipalId) {
    throw new Error(`${label} USER principal cannot have parentPrincipalId`);
  }
  if (kind !== GovernancePrincipalKind.USER && !parentPrincipalId) {
    throw new Error(`${label} non-USER principal requires parentPrincipalId`);
  }

  const createdAt = timestamp(raw.createdAt, `${label}.createdAt`);
  const revokedAt = timestamp(raw.revokedAt, `${label}.revokedAt`, { optional: true });
  if (status === GovernancePrincipalStatus.ACTIVE && revokedAt) {
    throw new Error(`${label} ACTIVE principal cannot have revokedAt`);
  }
  if (status === GovernancePrincipalStatus.REVOKED && !revokedAt) {
    throw new Error(`${label} REVOKED principal requires revokedAt`);
  }
  if (revokedAt && Date.parse(revokedAt) < Date.parse(createdAt)) {
    throw new Error(`${label}.revokedAt cannot predate createdAt`);
  }

  return freezeDeep({
    principalId: id(raw.principalId, `${label}.principalId`),
    organizationId: principalOrganizationId,
    kind,
    displayName: text(raw.displayName, `${label}.displayName`, { max: 500 }),
    parentPrincipalId,
    status,
    createdAt,
    revokedAt,
  });
}

function normalizeRole(input, index) {
  const label = `roles[${index}]`;
  const raw = strictRecord(input, ROLE_KEYS, label);
  return freezeDeep({
    roleId: id(raw.roleId, `${label}.roleId`),
    title: text(raw.title, `${label}.title`, { max: 500 }),
    capabilityCeilingIds: idList(raw.capabilityCeilingIds, `${label}.capabilityCeilingIds`),
    providerCeilingIds: idList(raw.providerCeilingIds, `${label}.providerCeilingIds`),
    outboundDataClassIds: idList(raw.outboundDataClassIds, `${label}.outboundDataClassIds`),
  });
}

function normalizeGrant(input, index) {
  const label = `grants[${index}]`;
  const raw = strictRecord(input, GRANT_KEYS, label);
  const createdAt = timestamp(raw.createdAt, `${label}.createdAt`);
  const expiresAt = timestamp(raw.expiresAt, `${label}.expiresAt`, { optional: true });
  const revokedAt = timestamp(raw.revokedAt, `${label}.revokedAt`, { optional: true });
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new Error(`${label}.expiresAt must be after createdAt`);
  }
  if (revokedAt && Date.parse(revokedAt) < Date.parse(createdAt)) {
    throw new Error(`${label}.revokedAt cannot predate createdAt`);
  }
  return freezeDeep({
    grantId: id(raw.grantId, `${label}.grantId`),
    principalId: id(raw.principalId, `${label}.principalId`),
    roleId: id(raw.roleId, `${label}.roleId`),
    resourceKeys: idList(raw.resourceKeys, `${label}.resourceKeys`, { min: 1 }),
    grantedByPrincipalId: id(raw.grantedByPrincipalId, `${label}.grantedByPrincipalId`),
    createdAt,
    expiresAt,
    revokedAt,
  });
}

function normalizeCredentialOwnership(input, index) {
  const label = `credentialOwnership[${index}]`;
  const raw = strictRecord(input, CREDENTIAL_KEYS, label);
  const status = id(raw.status, `${label}.status`);
  if (!CREDENTIAL_STATUSES.has(status)) throw new Error(`${label}.status is invalid`);
  const createdAt = timestamp(raw.createdAt, `${label}.createdAt`);
  const revokedAt = timestamp(raw.revokedAt, `${label}.revokedAt`, { optional: true });
  if (status === CredentialOwnershipStatus.ACTIVE && revokedAt) {
    throw new Error(`${label} ACTIVE credential binding cannot have revokedAt`);
  }
  if (status === CredentialOwnershipStatus.REVOKED && !revokedAt) {
    throw new Error(`${label} REVOKED credential binding requires revokedAt`);
  }
  if (revokedAt && Date.parse(revokedAt) < Date.parse(createdAt)) {
    throw new Error(`${label}.revokedAt cannot predate createdAt`);
  }
  return freezeDeep({
    bindingId: id(raw.bindingId, `${label}.bindingId`),
    credentialId: id(raw.credentialId, `${label}.credentialId`),
    brokerId: id(raw.brokerId, `${label}.brokerId`),
    ownerPrincipalId: id(raw.ownerPrincipalId, `${label}.ownerPrincipalId`),
    status,
    createdAt,
    revokedAt,
  });
}

function uniqueBy(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) throw new Error(`${label} contains duplicate ${key}: ${value}`);
    seen.add(value);
  }
}

function assertPrincipalGraph(principals) {
  const byId = new Map(principals.map((principal) => [principal.principalId, principal]));
  for (const principal of principals) {
    if (!principal.parentPrincipalId) continue;
    const parent = byId.get(principal.parentPrincipalId);
    if (!parent) throw new Error(`principal ${principal.principalId} references unknown parentPrincipalId`);
    if (Date.parse(parent.createdAt) > Date.parse(principal.createdAt)) {
      throw new Error(`principal ${principal.principalId} predates its parent principal`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (principalId) => {
    if (visited.has(principalId)) return;
    if (visiting.has(principalId)) throw new Error('principal hierarchy contains a cycle');
    visiting.add(principalId);
    const parent = byId.get(principalId).parentPrincipalId;
    if (parent) visit(parent);
    visiting.delete(principalId);
    visited.add(principalId);
  };
  for (const principal of principals) visit(principal.principalId);
}

export function normalizeIdentityGovernanceRegistryV1(input) {
  const raw = strictRecord(input, REGISTRY_KEYS, 'IdentityGovernanceRegistryV1');
  if (raw.schemaVersion !== IDENTITY_GOVERNANCE_SCHEMA_VERSION) {
    throw new Error('Unsupported IdentityGovernanceRegistryV1 schemaVersion');
  }
  const registryId = id(raw.registryId, 'registryId');
  const organizationId = id(raw.organizationId, 'organizationId');
  const revision = integer(raw.revision, 'revision', { min: 1, max: 1_000_000_000 });
  const updatedAt = timestamp(raw.updatedAt, 'updatedAt');

  const principals = strictArray(raw.principals, 'principals', {
    max: MAX_PRINCIPALS,
  }).map((value, index) => normalizePrincipal(value, index, organizationId));
  const roles = strictArray(raw.roles, 'roles', {
    max: MAX_ROLES,
  }).map(normalizeRole);
  const grants = strictArray(raw.grants, 'grants', {
    max: MAX_GRANTS,
  }).map(normalizeGrant);
  const credentialOwnership = strictArray(raw.credentialOwnership, 'credentialOwnership', {
    max: MAX_CREDENTIAL_BINDINGS,
  }).map(normalizeCredentialOwnership);

  uniqueBy(principals, 'principalId', 'principals');
  uniqueBy(roles, 'roleId', 'roles');
  uniqueBy(grants, 'grantId', 'grants');
  uniqueBy(credentialOwnership, 'bindingId', 'credentialOwnership');
  uniqueBy(credentialOwnership, 'credentialId', 'credentialOwnership');

  principals.sort((a, b) => asciiCompare(a.principalId, b.principalId));
  roles.sort((a, b) => asciiCompare(a.roleId, b.roleId));
  grants.sort((a, b) => asciiCompare(a.grantId, b.grantId));
  credentialOwnership.sort((a, b) => asciiCompare(a.bindingId, b.bindingId));

  assertPrincipalGraph(principals);
  const principalById = new Map(principals.map((principal) => [principal.principalId, principal]));
  const roleById = new Map(roles.map((role) => [role.roleId, role]));

  for (const principal of principals) {
    if (Date.parse(principal.createdAt) > Date.parse(updatedAt)) {
      throw new Error(`registry updatedAt predates principal: ${principal.principalId}`);
    }
    if (principal.revokedAt && Date.parse(principal.revokedAt) > Date.parse(updatedAt)) {
      throw new Error(`registry updatedAt predates principal revocation: ${principal.principalId}`);
    }
  }

  for (const grant of grants) {
    if (!principalById.has(grant.principalId)) {
      throw new Error(`grant ${grant.grantId} references unknown principalId`);
    }
    if (!principalById.has(grant.grantedByPrincipalId)) {
      throw new Error(`grant ${grant.grantId} references unknown grantedByPrincipalId`);
    }
    if (!roleById.has(grant.roleId)) {
      throw new Error(`grant ${grant.grantId} references unknown roleId`);
    }
    const targetPrincipal = principalById.get(grant.principalId);
    const grantingPrincipal = principalById.get(grant.grantedByPrincipalId);
    const grantCreatedMillis = Date.parse(grant.createdAt);
    if (!isPrincipalActiveAt(targetPrincipal, grantCreatedMillis)) {
      throw new Error(`grant ${grant.grantId} target principal is not active at grant creation`);
    }
    if (!isPrincipalActiveAt(grantingPrincipal, grantCreatedMillis)) {
      throw new Error(`grant ${grant.grantId} granting principal is not active at grant creation`);
    }
    if (Date.parse(grant.createdAt) > Date.parse(updatedAt)) {
      throw new Error(`registry updatedAt predates grant: ${grant.grantId}`);
    }
    if (grant.revokedAt && Date.parse(grant.revokedAt) > Date.parse(updatedAt)) {
      throw new Error(`registry updatedAt predates grant revocation: ${grant.grantId}`);
    }
  }

  for (const binding of credentialOwnership) {
    if (!principalById.has(binding.ownerPrincipalId)) {
      throw new Error(`credential binding ${binding.bindingId} references unknown ownerPrincipalId`);
    }
    const credentialOwner = principalById.get(binding.ownerPrincipalId);
    if (!isPrincipalActiveAt(credentialOwner, Date.parse(binding.createdAt))) {
      throw new Error(`credential binding ${binding.bindingId} owner principal is not active at binding creation`);
    }
    if (Date.parse(binding.createdAt) > Date.parse(updatedAt)) {
      throw new Error(`registry updatedAt predates credential binding: ${binding.bindingId}`);
    }
    if (binding.revokedAt && Date.parse(binding.revokedAt) > Date.parse(updatedAt)) {
      throw new Error(`registry updatedAt predates credential revocation: ${binding.bindingId}`);
    }
  }

  return freezeDeep({
    schemaVersion: IDENTITY_GOVERNANCE_SCHEMA_VERSION,
    registryId,
    organizationId,
    revision,
    principals: Object.freeze(principals),
    roles: Object.freeze(roles),
    grants: Object.freeze(grants),
    credentialOwnership: Object.freeze(credentialOwnership),
    updatedAt,
  });
}

function isPrincipalActiveAt(principal, atMillis) {
  if (atMillis < Date.parse(principal.createdAt)) return false;
  if (principal.status === GovernancePrincipalStatus.REVOKED) {
    return atMillis < Date.parse(principal.revokedAt);
  }
  return true;
}

function isGrantActiveAt(grant, atMillis) {
  if (atMillis < Date.parse(grant.createdAt)) return false;
  if (grant.expiresAt && atMillis >= Date.parse(grant.expiresAt)) return false;
  if (grant.revokedAt && atMillis >= Date.parse(grant.revokedAt)) return false;
  return true;
}

function unionRoleCeiling(registry, principalId, resourceKey, atMillis) {
  const roleById = new Map(registry.roles.map((role) => [role.roleId, role]));
  const capabilityIds = new Set();
  const providerIds = new Set();
  const dataClassIds = new Set();
  const roleIds = new Set();
  const grantIds = [];

  for (const grant of registry.grants) {
    if (grant.principalId !== principalId
        || !grant.resourceKeys.includes(resourceKey)
        || !isGrantActiveAt(grant, atMillis)) {
      continue;
    }
    const role = roleById.get(grant.roleId);
    roleIds.add(role.roleId);
    grantIds.push(grant.grantId);
    for (const value of role.capabilityCeilingIds) capabilityIds.add(value);
    for (const value of role.providerCeilingIds) providerIds.add(value);
    for (const value of role.outboundDataClassIds) dataClassIds.add(value);
  }

  return {
    roleIds: [...roleIds].sort(asciiCompare),
    grantIds: grantIds.sort(asciiCompare),
    capabilityIds,
    providerIds,
    dataClassIds,
  };
}

function intersectSets(left, right) {
  return new Set([...left].filter((value) => right.has(value)));
}

function activeCredentialBindingsForPrincipal(registry, principalId, atMillis) {
  return registry.credentialOwnership
    .filter((binding) => (
      binding.ownerPrincipalId === principalId
      && atMillis >= Date.parse(binding.createdAt)
      && (binding.status === CredentialOwnershipStatus.ACTIVE
        || atMillis < Date.parse(binding.revokedAt))
    ))
    .map((binding) => freezeDeep({
      bindingId: binding.bindingId,
      credentialId: binding.credentialId,
      brokerId: binding.brokerId,
    }))
    .sort((a, b) => asciiCompare(a.bindingId, b.bindingId));
}

export function derivePrincipalGovernanceCeilingV1({
  registry: registryInput,
  principalId: principalIdInput,
  resourceKey: resourceKeyInput,
  at: atInput,
} = {}) {
  const registry = normalizeIdentityGovernanceRegistryV1(registryInput);
  const principalId = id(principalIdInput, 'principalId');
  const resourceKey = id(resourceKeyInput, 'resourceKey');
  const at = timestamp(atInput, 'at');
  const atMillis = Date.parse(at);
  const principalById = new Map(registry.principals.map((principal) => [principal.principalId, principal]));
  const principal = principalById.get(principalId);
  if (!principal) throw new Error('principalId is not present in identity governance registry');

  const chain = [];
  let cursor = principal;
  while (cursor) {
    chain.push(cursor);
    cursor = cursor.parentPrincipalId ? principalById.get(cursor.parentPrincipalId) : null;
  }

  const inactive = chain.find((item) => !isPrincipalActiveAt(item, atMillis));
  if (inactive) {
    return freezeDeep({
      schemaVersion: IDENTITY_GOVERNANCE_SCHEMA_VERSION,
      registryId: registry.registryId,
      organizationId: registry.organizationId,
      registryRevision: registry.revision,
      principalId,
      resourceKey,
      evaluatedAt: at,
      active: false,
      reasonCode: inactive.principalId === principalId ? 'PRINCIPAL_INACTIVE' : 'ANCESTOR_INACTIVE',
      effectiveRoleIds: Object.freeze([]),
      effectiveGrantIds: Object.freeze([]),
      capabilityCeilingIds: Object.freeze([]),
      providerCeilingIds: Object.freeze([]),
      outboundDataClassIds: Object.freeze([]),
      ownedCredentialBindings: Object.freeze([]),
      policyDecision: 'NONE',
    });
  }

  let effectiveCapabilities = null;
  let effectiveProviders = null;
  let effectiveDataClasses = null;
  const roleIds = new Set();
  const grantIds = new Set();

  for (const chainPrincipal of chain) {
    const direct = unionRoleCeiling(registry, chainPrincipal.principalId, resourceKey, atMillis);
    for (const roleId of direct.roleIds) roleIds.add(roleId);
    for (const grantId of direct.grantIds) grantIds.add(grantId);
    effectiveCapabilities = effectiveCapabilities === null
      ? direct.capabilityIds
      : intersectSets(effectiveCapabilities, direct.capabilityIds);
    effectiveProviders = effectiveProviders === null
      ? direct.providerIds
      : intersectSets(effectiveProviders, direct.providerIds);
    effectiveDataClasses = effectiveDataClasses === null
      ? direct.dataClassIds
      : intersectSets(effectiveDataClasses, direct.dataClassIds);
  }

  return freezeDeep({
    schemaVersion: IDENTITY_GOVERNANCE_SCHEMA_VERSION,
    registryId: registry.registryId,
    organizationId: registry.organizationId,
    registryRevision: registry.revision,
    principalId,
    resourceKey,
    evaluatedAt: at,
    active: true,
    reasonCode: 'ACTIVE_POLICY_INPUT',
    effectiveRoleIds: Object.freeze([...roleIds].sort(asciiCompare)),
    effectiveGrantIds: Object.freeze([...grantIds].sort(asciiCompare)),
    capabilityCeilingIds: Object.freeze([...(effectiveCapabilities || new Set())].sort(asciiCompare)),
    providerCeilingIds: Object.freeze([...(effectiveProviders || new Set())].sort(asciiCompare)),
    outboundDataClassIds: Object.freeze([...(effectiveDataClasses || new Set())].sort(asciiCompare)),
    ownedCredentialBindings: Object.freeze(activeCredentialBindingsForPrincipal(registry, principalId, atMillis)),
    policyDecision: 'NONE',
  });
}

function assertImmutableJson(previous, next, label) {
  if (JSON.stringify(previous) !== JSON.stringify(next)) {
    throw new Error(`${label} is immutable`);
  }
}

function assertRevocablePrincipal(previous, next, previousUpdatedAt) {
  const stablePrevious = { ...previous, status: GovernancePrincipalStatus.ACTIVE, revokedAt: '' };
  const stableNext = { ...next, status: GovernancePrincipalStatus.ACTIVE, revokedAt: '' };
  assertImmutableJson(stablePrevious, stableNext, `principal ${previous.principalId}`);
  if (previous.status === GovernancePrincipalStatus.REVOKED) {
    assertImmutableJson(previous, next, `revoked principal ${previous.principalId}`);
    return;
  }
  if (next.status === GovernancePrincipalStatus.REVOKED
      && Date.parse(next.revokedAt) < Date.parse(previousUpdatedAt)) {
    throw new Error(`principal ${previous.principalId} revocation cannot rewrite prior history`);
  }
}

function assertRevocableGrant(previous, next, previousUpdatedAt) {
  const stablePrevious = { ...previous, revokedAt: '' };
  const stableNext = { ...next, revokedAt: '' };
  assertImmutableJson(stablePrevious, stableNext, `grant ${previous.grantId}`);
  if (previous.revokedAt) {
    assertImmutableJson(previous, next, `revoked grant ${previous.grantId}`);
    return;
  }
  if (next.revokedAt && Date.parse(next.revokedAt) < Date.parse(previousUpdatedAt)) {
    throw new Error(`grant ${previous.grantId} revocation cannot rewrite prior history`);
  }
}

function assertRevocableCredential(previous, next, previousUpdatedAt) {
  const stablePrevious = { ...previous, status: CredentialOwnershipStatus.ACTIVE, revokedAt: '' };
  const stableNext = { ...next, status: CredentialOwnershipStatus.ACTIVE, revokedAt: '' };
  assertImmutableJson(stablePrevious, stableNext, `credential binding ${previous.bindingId}`);
  if (previous.status === CredentialOwnershipStatus.REVOKED) {
    assertImmutableJson(previous, next, `revoked credential binding ${previous.bindingId}`);
    return;
  }
  if (next.status === CredentialOwnershipStatus.REVOKED
      && Date.parse(next.revokedAt) < Date.parse(previousUpdatedAt)) {
    throw new Error(`credential binding ${previous.bindingId} revocation cannot rewrite prior history`);
  }
}

export function assertIdentityGovernanceRegistryExtensionV1(previousInput, nextInput) {
  const previous = normalizeIdentityGovernanceRegistryV1(previousInput);
  const next = normalizeIdentityGovernanceRegistryV1(nextInput);

  if (next.registryId !== previous.registryId) throw new Error('registryId is immutable');
  if (next.organizationId !== previous.organizationId) throw new Error('organizationId is immutable');
  if (next.revision !== previous.revision + 1) throw new Error('registry revision must advance exactly once');
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
    throw new Error('registry updatedAt cannot move backwards');
  }

  const previousRoles = new Map(previous.roles.map((item) => [item.roleId, item]));
  const nextRoles = new Map(next.roles.map((item) => [item.roleId, item]));
  for (const [roleId, role] of previousRoles) {
    const current = nextRoles.get(roleId);
    if (!current) throw new Error(`existing role cannot be removed: ${roleId}`);
    assertImmutableJson(role, current, `role ${roleId}`);
  }

  const previousPrincipals = new Map(previous.principals.map((item) => [item.principalId, item]));
  const nextPrincipals = new Map(next.principals.map((item) => [item.principalId, item]));
  for (const [principalId, principal] of previousPrincipals) {
    const current = nextPrincipals.get(principalId);
    if (!current) throw new Error(`existing principal cannot be removed: ${principalId}`);
    assertRevocablePrincipal(principal, current, previous.updatedAt);
  }
  for (const principal of next.principals) {
    if (!previousPrincipals.has(principal.principalId)
        && Date.parse(principal.createdAt) < Date.parse(previous.updatedAt)) {
      throw new Error(`new principal cannot be backdated: ${principal.principalId}`);
    }
  }

  const previousGrants = new Map(previous.grants.map((item) => [item.grantId, item]));
  const nextGrants = new Map(next.grants.map((item) => [item.grantId, item]));
  for (const [grantId, grant] of previousGrants) {
    const current = nextGrants.get(grantId);
    if (!current) throw new Error(`existing grant cannot be removed: ${grantId}`);
    assertRevocableGrant(grant, current, previous.updatedAt);
  }
  for (const grant of next.grants) {
    if (!previousGrants.has(grant.grantId)
        && Date.parse(grant.createdAt) < Date.parse(previous.updatedAt)) {
      throw new Error(`new grant cannot be backdated: ${grant.grantId}`);
    }
  }

  const previousCredentials = new Map(previous.credentialOwnership.map((item) => [item.bindingId, item]));
  const nextCredentials = new Map(next.credentialOwnership.map((item) => [item.bindingId, item]));
  for (const [bindingId, binding] of previousCredentials) {
    const current = nextCredentials.get(bindingId);
    if (!current) throw new Error(`existing credential binding cannot be removed: ${bindingId}`);
    assertRevocableCredential(binding, current, previous.updatedAt);
  }
  for (const binding of next.credentialOwnership) {
    if (!previousCredentials.has(binding.bindingId)
        && Date.parse(binding.createdAt) < Date.parse(previous.updatedAt)) {
      throw new Error(`new credential binding cannot be backdated: ${binding.bindingId}`);
    }
  }

  return next;
}

export function inventoryIdentityGovernanceV1(registryInput) {
  const registry = normalizeIdentityGovernanceRegistryV1(registryInput);
  return freezeDeep({
    schemaVersion: IDENTITY_GOVERNANCE_SCHEMA_VERSION,
    registryId: registry.registryId,
    organizationId: registry.organizationId,
    revision: registry.revision,
    principalIds: Object.freeze(registry.principals.map((item) => item.principalId)),
    roleIds: Object.freeze(registry.roles.map((item) => item.roleId)),
    grantIds: Object.freeze(registry.grants.map((item) => item.grantId)),
    credentialBindingIds: Object.freeze(registry.credentialOwnership.map((item) => item.bindingId)),
    updatedAt: registry.updatedAt,
  });
}
