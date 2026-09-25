export const AGENT_IDENTITY_GOVERNANCE_SCHEMA_VERSION = 1;

export const AgentPrincipalKind = Object.freeze({
  OWNER: 'OWNER',
  HUMAN: 'HUMAN',
  AGENT: 'AGENT',
  SERVICE: 'SERVICE',
});

export const GovernanceScopeKind = Object.freeze({
  GLOBAL: 'GLOBAL',
  PROJECT: 'PROJECT',
  AGENT: 'AGENT',
});

const PRINCIPAL_KINDS = new Set(Object.values(AgentPrincipalKind));
const SCOPE_KINDS = new Set(Object.values(GovernanceScopeKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const LIMITS = Object.freeze({
  principals: 1024,
  roles: 512,
  bindings: 4096,
  credentials: 2048,
  ids: 512,
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
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !('value' in d) || d.enumerable !== true) {
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    if (!allowed.has(key)) throw new Error(label + ' contains unknown field: ' + key);
    out[key] = d.value;
  }
  return out;
}

function array(value, label, max, min = 0) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a plain dense array');
  }
  if (value.length < min || value.length > max) throw new Error(label + ' has invalid length');
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(label + ' contains non-index fields');
    }
  }
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !('value' in d) || d.enumerable !== true) {
      throw new Error(label + '[' + i + '] must be an enumerable own data item');
    }
    out.push(d.value);
  }
  return out;
}

function version(value, label) {
  if (value !== 1) throw new Error(label + '.schemaVersion must be 1');
  return 1;
}

function id(value, label, optional = false) {
  if ((value === null || value === undefined) && optional) return null;
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(label + ' is invalid');
  return value;
}

function labelText(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function time(value, label, optional = false) {
  if ((value === null || value === undefined) && optional) return null;
  if (typeof value !== 'string') throw new Error(label + ' must be a canonical timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(label + ' must be a canonical timestamp');
  }
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(label + ' is invalid');
  return value;
}

function sortIds(items) {
  return items.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function ids(value, label) {
  const out = array(value, label, LIMITS.ids).map((item, i) => id(item, label + '[' + i + ']'));
  if (new Set(out).size !== out.length) throw new Error(label + ' contains duplicates');
  return sortIds(out);
}

function unique(items, field, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item[field])) throw new Error(label + ' contains duplicate ' + field);
    seen.add(item[field]);
  }
  return items;
}

const PRINCIPAL_KEYS = new Set([
  'schemaVersion', 'principalId', 'organizationId', 'kind', 'displayName',
  'parentPrincipalId', 'createdAt', 'disabledAt',
]);

export function normalizeAgentPrincipalV1(input) {
  const raw = record(input, 'AgentPrincipalV1', PRINCIPAL_KEYS);
  version(raw.schemaVersion, 'AgentPrincipalV1');
  if (typeof raw.kind !== 'string' || !PRINCIPAL_KINDS.has(raw.kind)) {
    throw new Error('AgentPrincipalV1.kind is invalid');
  }
  const createdAt = time(raw.createdAt, 'AgentPrincipalV1.createdAt');
  const disabledAt = time(raw.disabledAt, 'AgentPrincipalV1.disabledAt', true);
  if (disabledAt && Date.parse(disabledAt) < Date.parse(createdAt)) {
    throw new Error('AgentPrincipalV1.disabledAt cannot predate createdAt');
  }
  const parentPrincipalId = id(raw.parentPrincipalId, 'AgentPrincipalV1.parentPrincipalId', true);
  if (raw.kind === AgentPrincipalKind.OWNER && parentPrincipalId) {
    throw new Error('OWNER principal cannot have a parent');
  }
  if (raw.kind === AgentPrincipalKind.AGENT && !parentPrincipalId) {
    throw new Error('AGENT principal requires parentPrincipalId');
  }
  return freeze({
    schemaVersion: 1,
    principalId: id(raw.principalId, 'AgentPrincipalV1.principalId'),
    organizationId: id(raw.organizationId, 'AgentPrincipalV1.organizationId'),
    kind: raw.kind,
    displayName: labelText(raw.displayName, 'AgentPrincipalV1.displayName'),
    parentPrincipalId,
    createdAt,
    disabledAt,
  });
}

const ROLE_KEYS = new Set([
  'schemaVersion', 'roleId', 'organizationId', 'label', 'capabilityIds', 'permissionIds',
]);

export function normalizeGovernanceRoleV1(input) {
  const raw = record(input, 'GovernanceRoleV1', ROLE_KEYS);
  version(raw.schemaVersion, 'GovernanceRoleV1');
  return freeze({
    schemaVersion: 1,
    roleId: id(raw.roleId, 'GovernanceRoleV1.roleId'),
    organizationId: id(raw.organizationId, 'GovernanceRoleV1.organizationId'),
    label: labelText(raw.label, 'GovernanceRoleV1.label'),
    capabilityIds: ids(raw.capabilityIds, 'GovernanceRoleV1.capabilityIds'),
    permissionIds: ids(raw.permissionIds, 'GovernanceRoleV1.permissionIds'),
  });
}

const BINDING_KEYS = new Set([
  'schemaVersion', 'bindingId', 'principalId', 'roleId',
  'scopeKind', 'scopeId', 'validFrom', 'validUntil',
]);

export function normalizeGovernanceRoleBindingV1(input) {
  const raw = record(input, 'GovernanceRoleBindingV1', BINDING_KEYS);
  version(raw.schemaVersion, 'GovernanceRoleBindingV1');
  if (typeof raw.scopeKind !== 'string' || !SCOPE_KINDS.has(raw.scopeKind)) {
    throw new Error('GovernanceRoleBindingV1.scopeKind is invalid');
  }
  const scopeId = id(raw.scopeId, 'GovernanceRoleBindingV1.scopeId', true);
  if (raw.scopeKind === GovernanceScopeKind.GLOBAL && scopeId) {
    throw new Error('GLOBAL binding cannot have scopeId');
  }
  if (raw.scopeKind !== GovernanceScopeKind.GLOBAL && !scopeId) {
    throw new Error('Non-GLOBAL binding requires scopeId');
  }
  const validFrom = time(raw.validFrom, 'GovernanceRoleBindingV1.validFrom');
  const validUntil = time(raw.validUntil, 'GovernanceRoleBindingV1.validUntil', true);
  if (validUntil && Date.parse(validUntil) <= Date.parse(validFrom)) {
    throw new Error('GovernanceRoleBindingV1.validUntil must be after validFrom');
  }
  return freeze({
    schemaVersion: 1,
    bindingId: id(raw.bindingId, 'GovernanceRoleBindingV1.bindingId'),
    principalId: id(raw.principalId, 'GovernanceRoleBindingV1.principalId'),
    roleId: id(raw.roleId, 'GovernanceRoleBindingV1.roleId'),
    scopeKind: raw.scopeKind,
    scopeId,
    validFrom,
    validUntil,
  });
}

const CREDENTIAL_KEYS = new Set([
  'schemaVersion', 'ownershipId', 'credentialRefId', 'ownerPrincipalId',
  'delegatePrincipalIds', 'createdAt', 'revokedAt',
]);

export function normalizeCredentialOwnershipRefV1(input) {
  const raw = record(input, 'CredentialOwnershipRefV1', CREDENTIAL_KEYS);
  version(raw.schemaVersion, 'CredentialOwnershipRefV1');
  const createdAt = time(raw.createdAt, 'CredentialOwnershipRefV1.createdAt');
  const revokedAt = time(raw.revokedAt, 'CredentialOwnershipRefV1.revokedAt', true);
  if (revokedAt && Date.parse(revokedAt) < Date.parse(createdAt)) {
    throw new Error('CredentialOwnershipRefV1.revokedAt cannot predate createdAt');
  }
  const ownerPrincipalId = id(raw.ownerPrincipalId, 'CredentialOwnershipRefV1.ownerPrincipalId');
  const delegatePrincipalIds = ids(raw.delegatePrincipalIds, 'CredentialOwnershipRefV1.delegatePrincipalIds');
  if (delegatePrincipalIds.includes(ownerPrincipalId)) {
    throw new Error('Credential owner cannot also be a delegate');
  }
  return freeze({
    schemaVersion: 1,
    ownershipId: id(raw.ownershipId, 'CredentialOwnershipRefV1.ownershipId'),
    credentialRefId: id(raw.credentialRefId, 'CredentialOwnershipRefV1.credentialRefId'),
    ownerPrincipalId,
    delegatePrincipalIds,
    createdAt,
    revokedAt,
    secretMaterialPresent: false,
    credentialUseAuthorized: false,
  });
}

const SNAPSHOT_KEYS = new Set([
  'schemaVersion', 'organizationId', 'revision', 'ownerPrincipalId',
  'principals', 'roles', 'bindings', 'credentialOwnerships', 'capturedAt',
]);

function assertNoCycles(byId) {
  for (const start of byId.values()) {
    const seen = new Set();
    let current = start;
    while (current && current.parentPrincipalId) {
      if (seen.has(current.principalId)) throw new Error('Principal ancestry cycle detected');
      seen.add(current.principalId);
      current = byId.get(current.parentPrincipalId);
    }
  }
}

export function normalizeAgentGovernanceSnapshotV1(input) {
  const raw = record(input, 'AgentGovernanceSnapshotV1', SNAPSHOT_KEYS);
  version(raw.schemaVersion, 'AgentGovernanceSnapshotV1');
  const organizationId = id(raw.organizationId, 'AgentGovernanceSnapshotV1.organizationId');
  const capturedAt = time(raw.capturedAt, 'AgentGovernanceSnapshotV1.capturedAt');
  const principals = unique(
    array(raw.principals, 'principals', LIMITS.principals, 1).map(normalizeAgentPrincipalV1),
    'principalId',
    'principals',
  ).sort((a, b) => a.principalId < b.principalId ? -1 : a.principalId > b.principalId ? 1 : 0);
  const roles = unique(
    array(raw.roles, 'roles', LIMITS.roles).map(normalizeGovernanceRoleV1),
    'roleId',
    'roles',
  ).sort((a, b) => a.roleId < b.roleId ? -1 : a.roleId > b.roleId ? 1 : 0);
  const bindings = unique(
    array(raw.bindings, 'bindings', LIMITS.bindings).map(normalizeGovernanceRoleBindingV1),
    'bindingId',
    'bindings',
  ).sort((a, b) => a.bindingId < b.bindingId ? -1 : a.bindingId > b.bindingId ? 1 : 0);
  const credentialOwnerships = unique(
    array(raw.credentialOwnerships, 'credentialOwnerships', LIMITS.credentials)
      .map(normalizeCredentialOwnershipRefV1),
    'ownershipId',
    'credentialOwnerships',
  ).sort((a, b) => a.ownershipId < b.ownershipId ? -1 : a.ownershipId > b.ownershipId ? 1 : 0);

  const principalsById = new Map(principals.map(item => [item.principalId, item]));
  const rolesById = new Map(roles.map(item => [item.roleId, item]));
  const ownerPrincipalId = id(raw.ownerPrincipalId, 'ownerPrincipalId');
  const owner = principalsById.get(ownerPrincipalId);
  if (!owner || owner.kind !== AgentPrincipalKind.OWNER) {
    throw new Error('ownerPrincipalId must reference the OWNER principal');
  }
  if (principals.filter(item => item.kind === AgentPrincipalKind.OWNER).length !== 1) {
    throw new Error('Snapshot requires exactly one OWNER principal');
  }

  for (const principal of principals) {
    if (principal.organizationId !== organizationId) throw new Error('Principal organization mismatch');
    if (Date.parse(principal.createdAt) > Date.parse(capturedAt)) {
      throw new Error('Principal creation postdates snapshot');
    }
    if (principal.parentPrincipalId && !principalsById.has(principal.parentPrincipalId)) {
      throw new Error('Unknown parent principal');
    }
  }
  assertNoCycles(principalsById);

  for (const role of roles) {
    if (role.organizationId !== organizationId) throw new Error('Role organization mismatch');
  }
  for (const binding of bindings) {
    const principal = principalsById.get(binding.principalId);
    if (!principal) throw new Error('Unknown binding principal');
    if (!rolesById.has(binding.roleId)) throw new Error('Unknown binding role');
    if (Date.parse(binding.validFrom) < Date.parse(principal.createdAt)) {
      throw new Error('Binding predates principal creation');
    }
    if (binding.scopeKind === GovernanceScopeKind.AGENT) {
      const target = principalsById.get(binding.scopeId);
      if (!target || target.kind !== AgentPrincipalKind.AGENT) {
        throw new Error('AGENT scope must reference an AGENT principal');
      }
    }
  }

  const credentialRefs = new Set();
  for (const ownership of credentialOwnerships) {
    if (credentialRefs.has(ownership.credentialRefId)) {
      throw new Error('Credential ref has multiple ownership records');
    }
    credentialRefs.add(ownership.credentialRefId);
    const credentialOwner = principalsById.get(ownership.ownerPrincipalId);
    if (!credentialOwner || ![AgentPrincipalKind.OWNER, AgentPrincipalKind.HUMAN].includes(credentialOwner.kind)) {
      throw new Error('Credential owner must be an OWNER or HUMAN principal');
    }
    for (const delegateId of ownership.delegatePrincipalIds) {
      if (!principalsById.has(delegateId)) throw new Error('Unknown credential delegate');
    }
  }

  return freeze({
    schemaVersion: 1,
    organizationId,
    revision: integer(raw.revision, 'revision'),
    ownerPrincipalId,
    principals,
    roles,
    bindings,
    credentialOwnerships,
    capturedAt,
    advisoryOnly: true,
    authorizationGranted: false,
    credentialUseAuthorized: false,
    policyAuthority: 'EXTERNAL_OWNER_POLICY',
  });
}

const PROJECTION_KEYS = new Set([
  'principalId', 'scopeKind', 'scopeId', 'ownerGrantedCapabilityIds',
  'ownerGrantedPermissionIds', 'ownerGrantedCredentialRefIds', 'assessedAt',
]);

function intersect(left, right) {
  const allowed = new Set(right);
  return sortIds(left.filter(item => allowed.has(item)));
}

function active(startAt, endAt, at) {
  return Date.parse(startAt) <= at && (!endAt || Date.parse(endAt) > at);
}

function directDeclarations(snapshot, principalId, scopeKind, scopeId, at) {
  const roles = new Map(snapshot.roles.map(item => [item.roleId, item]));
  const roleIds = snapshot.bindings.filter(binding => (
    binding.principalId === principalId
    && active(binding.validFrom, binding.validUntil, at)
    && (binding.scopeKind === GovernanceScopeKind.GLOBAL
      || (binding.scopeKind === scopeKind && binding.scopeId === scopeId))
  )).map(binding => binding.roleId);
  const caps = new Set();
  const perms = new Set();
  for (const roleId of roleIds) {
    const role = roles.get(roleId);
    role.capabilityIds.forEach(item => caps.add(item));
    role.permissionIds.forEach(item => perms.add(item));
  }
  return {
    roleIds: sortIds([...new Set(roleIds)]),
    capabilityIds: sortIds([...caps]),
    permissionIds: sortIds([...perms]),
  };
}

export function projectAgentGovernanceAccessV1(snapshotInput, projectionInput) {
  const snapshot = normalizeAgentGovernanceSnapshotV1(snapshotInput);
  const raw = record(projectionInput, 'AgentGovernanceAccessProjectionV1', PROJECTION_KEYS);
  const principalId = id(raw.principalId, 'principalId');
  if (typeof raw.scopeKind !== 'string' || !SCOPE_KINDS.has(raw.scopeKind)) {
    throw new Error('scopeKind is invalid');
  }
  const scopeId = id(raw.scopeId, 'scopeId', true);
  if (raw.scopeKind === GovernanceScopeKind.GLOBAL && scopeId) throw new Error('GLOBAL projection cannot have scopeId');
  if (raw.scopeKind !== GovernanceScopeKind.GLOBAL && !scopeId) throw new Error('Non-GLOBAL projection requires scopeId');
  const assessedAt = time(raw.assessedAt, 'assessedAt');
  if (Date.parse(assessedAt) < Date.parse(snapshot.capturedAt)) {
    throw new Error('Access assessment cannot predate governance snapshot');
  }

  const principals = new Map(snapshot.principals.map(item => [item.principalId, item]));
  const principal = principals.get(principalId);
  if (!principal) throw new Error('Unknown principal');
  const at = Date.parse(assessedAt);
  const ancestry = [];
  let cursor = principal;
  let blockedPrincipalId = null;
  while (cursor) {
    ancestry.push(cursor.principalId);
    if (cursor.disabledAt && Date.parse(cursor.disabledAt) <= at) {
      blockedPrincipalId = cursor.principalId;
      break;
    }
    cursor = cursor.parentPrincipalId ? principals.get(cursor.parentPrincipalId) : null;
  }

  const direct = directDeclarations(snapshot, principalId, raw.scopeKind, scopeId, at);
  let declaredCapabilityIds = direct.capabilityIds;
  let declaredPermissionIds = direct.permissionIds;
  if (!blockedPrincipalId && principal.kind === AgentPrincipalKind.AGENT) {
    let parent = principal.parentPrincipalId ? principals.get(principal.parentPrincipalId) : null;
    while (parent && parent.kind === AgentPrincipalKind.AGENT) {
      const parentDirect = directDeclarations(snapshot, parent.principalId, raw.scopeKind, scopeId, at);
      declaredCapabilityIds = intersect(declaredCapabilityIds, parentDirect.capabilityIds);
      declaredPermissionIds = intersect(declaredPermissionIds, parentDirect.permissionIds);
      parent = parent.parentPrincipalId ? principals.get(parent.parentPrincipalId) : null;
    }
  }
  if (blockedPrincipalId) {
    declaredCapabilityIds = [];
    declaredPermissionIds = [];
  }

  const declaredCredentialRefIds = blockedPrincipalId ? [] : sortIds(
    snapshot.credentialOwnerships.filter(item => (
      active(item.createdAt, item.revokedAt, at)
      && (item.ownerPrincipalId === principalId || item.delegatePrincipalIds.includes(principalId))
    )).map(item => item.credentialRefId),
  );

  return freeze({
    schemaVersion: 1,
    organizationId: snapshot.organizationId,
    snapshotRevision: snapshot.revision,
    principalId,
    scopeKind: raw.scopeKind,
    scopeId,
    assessedAt,
    ancestry,
    applicableRoleIds: direct.roleIds,
    declaredCapabilityIds,
    declaredPermissionIds,
    declaredCredentialRefIds,
    effectiveCapabilityIds: intersect(declaredCapabilityIds, ids(raw.ownerGrantedCapabilityIds, 'ownerGrantedCapabilityIds')),
    effectivePermissionIds: intersect(declaredPermissionIds, ids(raw.ownerGrantedPermissionIds, 'ownerGrantedPermissionIds')),
    effectiveCredentialRefIds: intersect(declaredCredentialRefIds, ids(raw.ownerGrantedCredentialRefIds, 'ownerGrantedCredentialRefIds')),
    principalActive: blockedPrincipalId === null,
    blockedPrincipalId,
    advisoryOnly: true,
    authorizationGranted: false,
    credentialUseAuthorized: false,
    requiresPolicyDecision: true,
    policyAuthority: 'EXTERNAL_OWNER_POLICY',
  });
}
