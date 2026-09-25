import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IDENTITY_GOVERNANCE_SCHEMA_VERSION,
  GovernancePrincipalKind,
  GovernancePrincipalStatus,
  CredentialOwnershipStatus,
  normalizeIdentityGovernanceRegistryV1,
  derivePrincipalGovernanceCeilingV1,
  assertIdentityGovernanceRegistryExtensionV1,
  inventoryIdentityGovernanceV1,
} from '../src/core/identity-governance.js';

const T0 = '2026-09-24T20:00:00.000Z';
const T01 = '2026-09-24T20:10:00.000Z';
const T02 = '2026-09-24T20:20:00.000Z';
const T03 = '2026-09-24T20:30:00.000Z';
const T1 = '2026-09-24T21:00:00.000Z';
const T2 = '2026-09-24T22:00:00.000Z';
const T25 = '2026-09-24T22:30:00.000Z';
const T3 = '2026-09-24T23:00:00.000Z';
const RESOURCE = 'project:p1';

function user(overrides = {}) {
  return {
    principalId: 'user-owner',
    organizationId: 'org-1',
    kind: GovernancePrincipalKind.USER,
    displayName: 'Owner',
    parentPrincipalId: '',
    status: GovernancePrincipalStatus.ACTIVE,
    createdAt: T0,
    revokedAt: '',
    ...overrides,
  };
}

function topAgent(overrides = {}) {
  return {
    principalId: 'agent-top',
    organizationId: 'org-1',
    kind: GovernancePrincipalKind.AGENT,
    displayName: 'Top agent',
    parentPrincipalId: 'user-owner',
    status: GovernancePrincipalStatus.ACTIVE,
    createdAt: T01,
    revokedAt: '',
    ...overrides,
  };
}

function childAgent(overrides = {}) {
  return {
    principalId: 'agent-child',
    organizationId: 'org-1',
    kind: GovernancePrincipalKind.AGENT,
    displayName: 'Child agent',
    parentPrincipalId: 'agent-top',
    status: GovernancePrincipalStatus.ACTIVE,
    createdAt: T02,
    revokedAt: '',
    ...overrides,
  };
}

function service(overrides = {}) {
  return {
    principalId: 'service-1',
    organizationId: 'org-1',
    kind: GovernancePrincipalKind.SERVICE,
    displayName: 'Service',
    parentPrincipalId: 'user-owner',
    status: GovernancePrincipalStatus.ACTIVE,
    createdAt: T02,
    revokedAt: '',
    ...overrides,
  };
}

function remoteAgent(overrides = {}) {
  return {
    principalId: 'remote-1',
    organizationId: 'org-1',
    kind: GovernancePrincipalKind.REMOTE_AGENT,
    displayName: 'Remote peer',
    parentPrincipalId: 'user-owner',
    status: GovernancePrincipalStatus.ACTIVE,
    createdAt: T02,
    revokedAt: '',
    ...overrides,
  };
}

function roles() {
  return [
    {
      roleId: 'role-owner',
      title: 'Owner ceiling',
      capabilityCeilingIds: ['fs.write', 'fs.read', 'web.navigate'],
      providerCeilingIds: ['native', 'browser'],
      outboundDataClassIds: ['internal', 'public'],
    },
    {
      roleId: 'role-agent',
      title: 'Agent ceiling',
      capabilityCeilingIds: ['web.click', 'fs.read', 'web.navigate'],
      providerCeilingIds: ['extra', 'browser'],
      outboundDataClassIds: ['secret', 'public'],
    },
    {
      roleId: 'role-child',
      title: 'Child ceiling',
      capabilityCeilingIds: ['os.admin', 'fs.read', 'web.navigate'],
      providerCeilingIds: ['browser'],
      outboundDataClassIds: ['public'],
    },
    {
      roleId: 'role-service',
      title: 'Service ceiling',
      capabilityCeilingIds: ['fs.read'],
      providerCeilingIds: ['native'],
      outboundDataClassIds: ['internal'],
    },
  ];
}

function grants() {
  return [
    {
      grantId: 'grant-owner',
      principalId: 'user-owner',
      roleId: 'role-owner',
      resourceKeys: [RESOURCE],
      grantedByPrincipalId: 'user-owner',
      createdAt: T03,
      expiresAt: '',
      revokedAt: '',
    },
    {
      grantId: 'grant-top',
      principalId: 'agent-top',
      roleId: 'role-agent',
      resourceKeys: [RESOURCE],
      grantedByPrincipalId: 'user-owner',
      createdAt: T03,
      expiresAt: '',
      revokedAt: '',
    },
    {
      grantId: 'grant-child',
      principalId: 'agent-child',
      roleId: 'role-child',
      resourceKeys: [RESOURCE],
      grantedByPrincipalId: 'agent-top',
      createdAt: T03,
      expiresAt: '',
      revokedAt: '',
    },
    {
      grantId: 'grant-service',
      principalId: 'service-1',
      roleId: 'role-service',
      resourceKeys: [RESOURCE],
      grantedByPrincipalId: 'user-owner',
      createdAt: T03,
      expiresAt: '',
      revokedAt: '',
    },
  ];
}

function credentials() {
  return [
    {
      bindingId: 'binding-owner',
      credentialId: 'credential-owner',
      brokerId: 'broker-local',
      ownerPrincipalId: 'user-owner',
      status: CredentialOwnershipStatus.ACTIVE,
      createdAt: T03,
      revokedAt: '',
    },
    {
      bindingId: 'binding-child',
      credentialId: 'credential-child',
      brokerId: 'broker-local',
      ownerPrincipalId: 'agent-child',
      status: CredentialOwnershipStatus.ACTIVE,
      createdAt: T03,
      revokedAt: '',
    },
  ];
}

function registry(overrides = {}) {
  return {
    schemaVersion: IDENTITY_GOVERNANCE_SCHEMA_VERSION,
    registryId: 'identity-registry-1',
    organizationId: 'org-1',
    revision: 1,
    principals: [remoteAgent(), childAgent(), user(), service(), topAgent()],
    roles: roles(),
    grants: grants(),
    credentialOwnership: credentials(),
    updatedAt: T3,
    ...overrides,
  };
}

test('registry normalizes deterministic identity inventory for all required principal kinds', () => {
  const normalized = normalizeIdentityGovernanceRegistryV1(registry());

  assert.deepEqual(
    normalized.principals.map((item) => [item.principalId, item.kind]),
    [
      ['agent-child', GovernancePrincipalKind.AGENT],
      ['agent-top', GovernancePrincipalKind.AGENT],
      ['remote-1', GovernancePrincipalKind.REMOTE_AGENT],
      ['service-1', GovernancePrincipalKind.SERVICE],
      ['user-owner', GovernancePrincipalKind.USER],
    ],
  );
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.principals), true);

  const inventory = inventoryIdentityGovernanceV1(normalized);
  assert.deepEqual(inventory.principalIds, [
    'agent-child',
    'agent-top',
    'remote-1',
    'service-1',
    'user-owner',
  ]);
  assert.deepEqual(inventory.credentialBindingIds, ['binding-child', 'binding-owner']);
  assert.equal(inventory.authorizationGranted, false);
  assert.equal(inventory.credentialUseAuthorized, false);
});

test('root user ceiling is resource-scoped policy input and never an authorization decision', () => {
  const result = derivePrincipalGovernanceCeilingV1({
    registry: registry(),
    principalId: 'user-owner',
    resourceKey: RESOURCE,
    at: T1,
  });

  assert.equal(result.active, true);
  assert.equal(result.reasonCode, 'ACTIVE_POLICY_INPUT');
  assert.equal(result.policyDecision, 'NONE');
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.credentialUseAuthorized, false);
  assert.equal(result.requiresPolicyDecision, true);
  assert.deepEqual(result.capabilityCeilingIds, ['fs.read', 'fs.write', 'web.navigate']);
  assert.deepEqual(result.providerCeilingIds, ['browser', 'native']);
  assert.deepEqual(result.outboundDataClassIds, ['internal', 'public']);
  assert.deepEqual(result.ownedCredentialBindings, [
    {
      bindingId: 'binding-owner',
      credentialId: 'credential-owner',
      brokerId: 'broker-local',
    },
  ]);
});

test('child agent authority is the intersection of its own grant and every active ancestor', () => {
  const top = derivePrincipalGovernanceCeilingV1({
    registry: registry(),
    principalId: 'agent-top',
    resourceKey: RESOURCE,
    at: T1,
  });
  assert.deepEqual(top.capabilityCeilingIds, ['fs.read', 'web.navigate']);
  assert.deepEqual(top.providerCeilingIds, ['browser']);
  assert.deepEqual(top.outboundDataClassIds, ['public']);

  const child = derivePrincipalGovernanceCeilingV1({
    registry: registry(),
    principalId: 'agent-child',
    resourceKey: RESOURCE,
    at: T1,
  });
  assert.deepEqual(child.capabilityCeilingIds, ['fs.read', 'web.navigate']);
  assert.deepEqual(child.providerCeilingIds, ['browser']);
  assert.deepEqual(child.outboundDataClassIds, ['public']);
  assert.equal(child.capabilityCeilingIds.includes('os.admin'), false);
  assert.equal(child.capabilityCeilingIds.includes('web.click'), false);
  assert.equal(child.providerCeilingIds.includes('extra'), false);
  assert.equal(child.outboundDataClassIds.includes('secret'), false);
});

test('credential ownership is not inherited through principal ancestry', () => {
  const child = derivePrincipalGovernanceCeilingV1({
    registry: registry(),
    principalId: 'agent-child',
    resourceKey: RESOURCE,
    at: T1,
  });
  assert.deepEqual(child.ownedCredentialBindings, [
    {
      bindingId: 'binding-child',
      credentialId: 'credential-child',
      brokerId: 'broker-local',
    },
  ]);
  assert.equal(child.ownedCredentialBindings.some((item) => item.credentialId === 'credential-owner'), false);

  const top = derivePrincipalGovernanceCeilingV1({
    registry: registry(),
    principalId: 'agent-top',
    resourceKey: RESOURCE,
    at: T1,
  });
  assert.deepEqual(top.ownedCredentialBindings, []);
});

test('resource scope is exact and a child grant cannot create authority absent from ancestors', () => {
  const changed = registry();
  changed.grants.push({
    grantId: 'grant-child-other',
    principalId: 'agent-child',
    roleId: 'role-child',
    resourceKeys: ['project:p2'],
    grantedByPrincipalId: 'agent-top',
    createdAt: T03,
    expiresAt: '',
    revokedAt: '',
  });
  const result = derivePrincipalGovernanceCeilingV1({
    registry: changed,
    principalId: 'agent-child',
    resourceKey: 'project:p2',
    at: T1,
  });
  assert.deepEqual(result.capabilityCeilingIds, []);
  assert.deepEqual(result.providerCeilingIds, []);
  assert.deepEqual(result.outboundDataClassIds, []);
  assert.equal(result.policyDecision, 'NONE');
});

test('grant expiry and revocation boundaries deterministically collapse downstream ceilings', () => {
  const expiring = registry();
  expiring.grants = expiring.grants.map((grant) => (
    grant.grantId === 'grant-top' ? { ...grant, expiresAt: T2 } : grant
  ));

  const before = derivePrincipalGovernanceCeilingV1({
    registry: expiring,
    principalId: 'agent-child',
    resourceKey: RESOURCE,
    at: '2026-09-24T21:59:59.999Z',
  });
  assert.deepEqual(before.capabilityCeilingIds, ['fs.read', 'web.navigate']);

  const boundary = derivePrincipalGovernanceCeilingV1({
    registry: expiring,
    principalId: 'agent-child',
    resourceKey: RESOURCE,
    at: T2,
  });
  assert.deepEqual(boundary.capabilityCeilingIds, []);

  const revoked = registry();
  revoked.grants = revoked.grants.map((grant) => (
    grant.grantId === 'grant-top' ? { ...grant, revokedAt: T2 } : grant
  ));
  assert.deepEqual(
    derivePrincipalGovernanceCeilingV1({
      registry: revoked,
      principalId: 'agent-child',
      resourceKey: RESOURCE,
      at: T2,
    }).capabilityCeilingIds,
    [],
  );
});

test('principal or ancestor revocation makes the evaluated identity inactive at the boundary', () => {
  const revoked = registry();
  revoked.principals = revoked.principals.map((principal) => (
    principal.principalId === 'agent-top'
      ? {
          ...principal,
          status: GovernancePrincipalStatus.REVOKED,
          revokedAt: T2,
        }
      : principal
  ));

  const historical = derivePrincipalGovernanceCeilingV1({
    registry: revoked,
    principalId: 'agent-child',
    resourceKey: RESOURCE,
    at: T1,
  });
  assert.equal(historical.active, true);

  const after = derivePrincipalGovernanceCeilingV1({
    registry: revoked,
    principalId: 'agent-child',
    resourceKey: RESOURCE,
    at: T2,
  });
  assert.equal(after.active, false);
  assert.equal(after.reasonCode, 'ANCESTOR_INACTIVE');
  assert.deepEqual(after.capabilityCeilingIds, []);
  assert.deepEqual(after.ownedCredentialBindings, []);
  assert.equal(after.authorizationGranted, false);
  assert.equal(after.credentialUseAuthorized, false);
  assert.equal(after.requiresPolicyDecision, true);
});

test('registry rejects unknown references, invalid hierarchy and invalid grant/credential causality', () => {
  const unknownRole = registry();
  unknownRole.grants[0] = { ...unknownRole.grants[0], roleId: 'role-unknown' };
  assert.throws(() => normalizeIdentityGovernanceRegistryV1(unknownRole), /unknown roleId/);

  const unknownPrincipal = registry();
  unknownPrincipal.grants[0] = { ...unknownPrincipal.grants[0], principalId: 'principal-unknown' };
  assert.throws(() => normalizeIdentityGovernanceRegistryV1(unknownPrincipal), /unknown principalId/);

  const unknownOwner = registry();
  unknownOwner.credentialOwnership[0] = {
    ...unknownOwner.credentialOwnership[0],
    ownerPrincipalId: 'principal-unknown',
  };
  assert.throws(() => normalizeIdentityGovernanceRegistryV1(unknownOwner), /unknown ownerPrincipalId/);

  const userWithParent = registry();
  userWithParent.principals = userWithParent.principals.map((principal) => (
    principal.principalId === 'user-owner'
      ? { ...principal, parentPrincipalId: 'agent-top' }
      : principal
  ));
  assert.throws(() => normalizeIdentityGovernanceRegistryV1(userWithParent), /USER principal cannot have parent/);

  const missingParent = registry();
  missingParent.principals = missingParent.principals.map((principal) => (
    principal.principalId === 'agent-top'
      ? { ...principal, parentPrincipalId: '' }
      : principal
  ));
  assert.throws(() => normalizeIdentityGovernanceRegistryV1(missingParent), /requires parentPrincipalId/);

  const cycle = registry();
  cycle.principals = cycle.principals.map((principal) => {
    if (principal.principalId === 'agent-top') {
      return { ...principal, parentPrincipalId: 'agent-child', createdAt: T02 };
    }
    if (principal.principalId === 'agent-child') {
      return { ...principal, parentPrincipalId: 'agent-top', createdAt: T02 };
    }
    return principal;
  });
  assert.throws(() => normalizeIdentityGovernanceRegistryV1(cycle), /cycle/);

  const revokedGranter = registry();
  revokedGranter.principals.push(user({
    principalId: 'user-revoked',
    displayName: 'Revoked user',
    status: GovernancePrincipalStatus.REVOKED,
    revokedAt: T02,
  }));
  revokedGranter.grants[1] = {
    ...revokedGranter.grants[1],
    grantedByPrincipalId: 'user-revoked',
    createdAt: T03,
  };
  assert.throws(
    () => normalizeIdentityGovernanceRegistryV1(revokedGranter),
    /granting principal is not active/,
  );

  const earlyCredential = registry();
  earlyCredential.credentialOwnership[1] = {
    ...earlyCredential.credentialOwnership[1],
    createdAt: T01,
  };
  assert.throws(
    () => normalizeIdentityGovernanceRegistryV1(earlyCredential),
    /owner principal is not active/,
  );
});

test('strict trust boundary rejects coercion, symbols, accessors, exotic prototypes and sparse arrays', () => {
  assert.throws(
    () => normalizeIdentityGovernanceRegistryV1(registry({ schemaVersion: '1' })),
    /schemaVersion/,
  );
  assert.throws(
    () => normalizeIdentityGovernanceRegistryV1(registry({ revision: '1' })),
    /revision is invalid/,
  );

  const symbol = registry();
  symbol.principals[0][Symbol('authority')] = 'admin';
  assert.throws(
    () => normalizeIdentityGovernanceRegistryV1(symbol),
    /unknown field/,
  );

  const accessor = registry();
  let getterExecuted = false;
  Object.defineProperty(accessor.roles[0], 'capabilityCeilingIds', {
    enumerable: true,
    get() {
      getterExecuted = true;
      throw new Error('getter must not execute');
    },
  });
  assert.throws(
    () => normalizeIdentityGovernanceRegistryV1(accessor),
    /data properties only/,
  );
  assert.equal(getterExecuted, false);

  const exotic = Object.create({ organizationId: 'org-1' });
  Object.assign(exotic, registry());
  assert.throws(
    () => normalizeIdentityGovernanceRegistryV1(exotic),
    /plain object/,
  );

  const sparse = registry();
  sparse.grants = new Array(2);
  sparse.grants[0] = grants()[0];
  assert.throws(
    () => normalizeIdentityGovernanceRegistryV1(sparse),
    /must not be sparse/,
  );

  const numericPrincipal = registry();
  numericPrincipal.principals[0] = { ...numericPrincipal.principals[0], principalId: 7 };
  assert.throws(
    () => normalizeIdentityGovernanceRegistryV1(numericPrincipal),
    /principalId is invalid/,
  );
});

test('record normalization snapshots verified descriptors before authority values can change', () => {
  const input = registry();
  const original = input.roles[0];
  let valueReads = 0;
  input.roles[0] = new Proxy(original, {
    get(target, property, receiver) {
      valueReads += 1;
      if (property === 'capabilityCeilingIds') return ['os.admin'];
      return Reflect.get(target, property, receiver);
    },
  });

  const normalized = normalizeIdentityGovernanceRegistryV1(input);
  assert.equal(valueReads, 0);
  assert.deepEqual(
    normalized.roles.find((item) => item.roleId === 'role-owner').capabilityCeilingIds,
    ['fs.read', 'fs.write', 'web.navigate'],
  );
});

test('null-prototype registry records are accepted without authority widening', () => {
  const input = registry();
  const nullRegistry = Object.assign(Object.create(null), input);
  nullRegistry.principals = input.principals.map((item) => Object.assign(Object.create(null), item));
  nullRegistry.roles = input.roles.map((item) => Object.assign(Object.create(null), item));
  nullRegistry.grants = input.grants.map((item) => Object.assign(Object.create(null), item));
  nullRegistry.credentialOwnership = input.credentialOwnership.map(
    (item) => Object.assign(Object.create(null), item),
  );

  const normalized = normalizeIdentityGovernanceRegistryV1(nullRegistry);
  assert.equal(normalized.organizationId, 'org-1');
  assert.equal(normalized.principals.length, 5);
});

test('registry extension permits append and one-way revocation without rewriting prior history', () => {
  const previous = registry({ revision: 1, updatedAt: T2 });
  const next = structuredClone(previous);
  next.revision = 2;
  next.updatedAt = T3;
  next.principals = next.principals.map((principal) => (
    principal.principalId === 'agent-child'
      ? { ...principal, status: GovernancePrincipalStatus.REVOKED, revokedAt: T25 }
      : principal
  ));
  next.grants = next.grants.map((grant) => (
    grant.grantId === 'grant-child'
      ? { ...grant, revokedAt: T25 }
      : grant
  ));
  next.credentialOwnership = next.credentialOwnership.map((binding) => (
    binding.bindingId === 'binding-child'
      ? { ...binding, status: CredentialOwnershipStatus.REVOKED, revokedAt: T25 }
      : binding
  ));
  next.roles.push({
    roleId: 'role-auditor',
    title: 'Auditor',
    capabilityCeilingIds: ['fs.read'],
    providerCeilingIds: [],
    outboundDataClassIds: [],
  });
  next.grants.push({
    grantId: 'grant-auditor',
    principalId: 'user-owner',
    roleId: 'role-auditor',
    resourceKeys: [RESOURCE],
    grantedByPrincipalId: 'user-owner',
    createdAt: '2026-09-24T22:40:00.000Z',
    expiresAt: '',
    revokedAt: '',
  });
  next.credentialOwnership.push({
    bindingId: 'binding-owner-rotated',
    credentialId: 'credential-owner-v2',
    brokerId: 'broker-local',
    ownerPrincipalId: 'user-owner',
    status: CredentialOwnershipStatus.ACTIVE,
    createdAt: '2026-09-24T22:40:00.000Z',
    revokedAt: '',
  });

  const accepted = assertIdentityGovernanceRegistryExtensionV1(previous, next);
  assert.equal(accepted.revision, 2);
  assert.equal(
    accepted.principals.find((item) => item.principalId === 'agent-child').status,
    GovernancePrincipalStatus.REVOKED,
  );
});

test('registry extension rejects removal, rewrite, reactivation, retroactive revocation and backdated additions', () => {
  const previous = registry({ revision: 1, updatedAt: T2 });

  const removed = structuredClone(previous);
  removed.revision = 2;
  removed.updatedAt = T3;
  removed.grants = removed.grants.filter((grant) => grant.grantId !== 'grant-child');
  assert.throws(
    () => assertIdentityGovernanceRegistryExtensionV1(previous, removed),
    /existing grant cannot be removed/,
  );

  const roleRewrite = structuredClone(previous);
  roleRewrite.revision = 2;
  roleRewrite.updatedAt = T3;
  roleRewrite.roles = roleRewrite.roles.map((role) => (
    role.roleId === 'role-agent'
      ? { ...role, capabilityCeilingIds: [...role.capabilityCeilingIds, 'os.admin'] }
      : role
  ));
  assert.throws(
    () => assertIdentityGovernanceRegistryExtensionV1(previous, roleRewrite),
    /role role-agent is immutable/,
  );

  const reparent = structuredClone(previous);
  reparent.revision = 2;
  reparent.updatedAt = T3;
  reparent.principals = reparent.principals.map((principal) => (
    principal.principalId === 'agent-child'
      ? { ...principal, parentPrincipalId: 'user-owner' }
      : principal
  ));
  assert.throws(
    () => assertIdentityGovernanceRegistryExtensionV1(previous, reparent),
    /principal agent-child is immutable/,
  );

  const retroactive = structuredClone(previous);
  retroactive.revision = 2;
  retroactive.updatedAt = T3;
  retroactive.grants = retroactive.grants.map((grant) => (
    grant.grantId === 'grant-child'
      ? { ...grant, revokedAt: '2026-09-24T21:59:59.999Z' }
      : grant
  ));
  assert.throws(
    () => assertIdentityGovernanceRegistryExtensionV1(previous, retroactive),
    /cannot rewrite prior history/,
  );

  const backdated = structuredClone(previous);
  backdated.revision = 2;
  backdated.updatedAt = T3;
  backdated.grants.push({
    grantId: 'grant-backdated',
    principalId: 'user-owner',
    roleId: 'role-owner',
    resourceKeys: [RESOURCE],
    grantedByPrincipalId: 'user-owner',
    createdAt: '2026-09-24T21:30:00.000Z',
    expiresAt: '',
    revokedAt: '',
  });
  assert.throws(
    () => assertIdentityGovernanceRegistryExtensionV1(previous, backdated),
    /new grant cannot be backdated/,
  );

  const revokedPrevious = structuredClone(previous);
  revokedPrevious.principals = revokedPrevious.principals.map((principal) => (
    principal.principalId === 'agent-child'
      ? { ...principal, status: GovernancePrincipalStatus.REVOKED, revokedAt: T2 }
      : principal
  ));
  const reactivated = structuredClone(revokedPrevious);
  reactivated.revision = 2;
  reactivated.updatedAt = T3;
  reactivated.principals = reactivated.principals.map((principal) => (
    principal.principalId === 'agent-child'
      ? { ...principal, status: GovernancePrincipalStatus.ACTIVE, revokedAt: '' }
      : principal
  ));
  assert.throws(
    () => assertIdentityGovernanceRegistryExtensionV1(revokedPrevious, reactivated),
    /revoked principal agent-child is immutable/,
  );
});
