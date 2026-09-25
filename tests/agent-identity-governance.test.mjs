import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeAgentGovernanceSnapshotV1,
  normalizeCredentialOwnershipRefV1,
  projectAgentGovernanceAccessV1,
} from '../src/core/agent-identity-governance.js';

const T0 = '2026-09-25T00:00:00.000Z';
const T1 = '2026-09-25T00:10:00.000Z';
const T2 = '2026-09-25T00:20:00.000Z';

function principal(id, kind, parentPrincipalId = null, overrides = {}) {
  return {
    schemaVersion: 1,
    principalId: id,
    organizationId: 'org.autopilot',
    kind,
    displayName: id,
    parentPrincipalId,
    createdAt: T0,
    disabledAt: null,
    ...overrides,
  };
}

function role(roleId, capabilityIds, permissionIds = []) {
  return {
    schemaVersion: 1,
    roleId,
    organizationId: 'org.autopilot',
    label: roleId,
    capabilityIds,
    permissionIds,
  };
}

function binding(bindingId, principalId, roleId, overrides = {}) {
  return {
    schemaVersion: 1,
    bindingId,
    principalId,
    roleId,
    scopeKind: 'PROJECT',
    scopeId: 'project.alpha',
    validFrom: T0,
    validUntil: null,
    ...overrides,
  };
}

function credential(overrides = {}) {
  return {
    schemaVersion: 1,
    ownershipId: 'credential-ownership-1',
    credentialRefId: 'credential.github.main',
    ownerPrincipalId: 'owner',
    delegatePrincipalIds: ['agent.child'],
    createdAt: T0,
    revokedAt: null,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    organizationId: 'org.autopilot',
    revision: 7,
    ownerPrincipalId: 'owner',
    principals: [
      principal('agent.child', 'AGENT', 'agent.parent'),
      principal('owner', 'OWNER'),
      principal('agent.parent', 'AGENT', 'owner'),
    ],
    roles: [
      role('role.child', ['repo.read', 'repo.admin'], ['review.read', 'admin.all']),
      role('role.parent', ['repo.read', 'repo.write'], ['review.read', 'review.write']),
    ],
    bindings: [
      binding('bind-child', 'agent.child', 'role.child'),
      binding('bind-parent', 'agent.parent', 'role.parent'),
    ],
    credentialOwnerships: [credential()],
    capturedAt: T0,
    ...overrides,
  };
}

function projection(overrides = {}) {
  return {
    principalId: 'agent.child',
    scopeKind: 'PROJECT',
    scopeId: 'project.alpha',
    ownerGrantedCapabilityIds: ['repo.admin', 'repo.read', 'repo.write'],
    ownerGrantedPermissionIds: ['admin.all', 'review.read', 'review.write'],
    ownerGrantedCredentialRefIds: ['credential.github.main', 'credential.other'],
    assessedAt: T1,
    ...overrides,
  };
}

test('governance snapshot is deterministic and never grants execution authority', () => {
  const normalized = normalizeAgentGovernanceSnapshotV1(snapshot());
  assert.deepEqual(
    normalized.principals.map(item => item.principalId),
    ['agent.child', 'agent.parent', 'owner'],
  );
  assert.deepEqual(normalized.roles.map(item => item.roleId), ['role.child', 'role.parent']);
  assert.equal(normalized.advisoryOnly, true);
  assert.equal(normalized.authorizationGranted, false);
  assert.equal(normalized.credentialUseAuthorized, false);
  assert.equal(normalized.policyAuthority, 'EXTERNAL_OWNER_POLICY');
  assert(Object.isFrozen(normalized));
  assert(Object.isFrozen(normalized.principals));
});

test('descriptor-safe boundaries reject accessors, hidden fields, symbols and sparse arrays without reads', () => {
  let reads = 0;
  const accessor = snapshot();
  Object.defineProperty(accessor, 'organizationId', {
    enumerable: true,
    get() { reads += 1; return 'org.evil'; },
  });
  assert.throws(() => normalizeAgentGovernanceSnapshotV1(accessor), /enumerable own data property/);
  assert.equal(reads, 0);

  const hidden = snapshot();
  Object.defineProperty(hidden, 'authorizationGranted', { enumerable: false, value: true });
  assert.throws(() => normalizeAgentGovernanceSnapshotV1(hidden), /enumerable own data property/);

  const symbol = snapshot();
  symbol[Symbol('role')] = 'admin';
  assert.throws(() => normalizeAgentGovernanceSnapshotV1(symbol), /symbol fields/);

  const sparse = snapshot();
  sparse.bindings = new Array(1);
  assert.throws(() => normalizeAgentGovernanceSnapshotV1(sparse), /enumerable own data item/);
});

test('referential integrity, one owner and ancestry cycles fail closed', () => {
  const unknownRole = snapshot();
  unknownRole.bindings[0].roleId = 'role.missing';
  assert.throws(() => normalizeAgentGovernanceSnapshotV1(unknownRole), /Unknown binding role/);

  const twoOwners = snapshot();
  twoOwners.principals.push(principal('owner.two', 'OWNER'));
  assert.throws(() => normalizeAgentGovernanceSnapshotV1(twoOwners), /exactly one OWNER/);

  const cycled = snapshot();
  cycled.principals.find(item => item.principalId === 'agent.parent').parentPrincipalId = 'agent.child';
  assert.throws(() => normalizeAgentGovernanceSnapshotV1(cycled), /ancestry cycle/);

  const crossOrg = snapshot();
  crossOrg.roles[0].organizationId = 'org.other';
  assert.throws(() => normalizeAgentGovernanceSnapshotV1(crossOrg), /Role organization mismatch/);
});

test('child Agent authority is narrowed by Agent ancestry before owner-policy intersection', () => {
  const access = projectAgentGovernanceAccessV1(snapshot(), projection());
  assert.deepEqual(access.ancestry, ['agent.child', 'agent.parent', 'owner']);
  assert.deepEqual(access.applicableRoleIds, ['role.child']);
  assert.deepEqual(access.declaredCapabilityIds, ['repo.read']);
  assert.deepEqual(access.declaredPermissionIds, ['review.read']);
  assert.deepEqual(access.effectiveCapabilityIds, ['repo.read']);
  assert.deepEqual(access.effectivePermissionIds, ['review.read']);
  assert.equal(access.authorizationGranted, false);
  assert.equal(access.requiresPolicyDecision, true);
});

test('owner-policy inputs can only narrow declarations and never widen them', () => {
  const access = projectAgentGovernanceAccessV1(
    snapshot(),
    projection({
      ownerGrantedCapabilityIds: ['repo.admin', 'repo.write'],
      ownerGrantedPermissionIds: ['admin.all', 'review.write'],
    }),
  );
  assert.deepEqual(access.declaredCapabilityIds, ['repo.read']);
  assert.deepEqual(access.effectiveCapabilityIds, []);
  assert.deepEqual(access.declaredPermissionIds, ['review.read']);
  assert.deepEqual(access.effectivePermissionIds, []);
});

test('disabled ancestry and expired bindings remove declared access', () => {
  const disabled = snapshot();
  disabled.principals.find(item => item.principalId === 'agent.parent').disabledAt = T1;
  const blocked = projectAgentGovernanceAccessV1(disabled, projection({ assessedAt: T2 }));
  assert.equal(blocked.principalActive, false);
  assert.equal(blocked.blockedPrincipalId, 'agent.parent');
  assert.deepEqual(blocked.effectiveCapabilityIds, []);

  const expired = snapshot();
  expired.bindings.find(item => item.bindingId === 'bind-child').validUntil = T1;
  const noRole = projectAgentGovernanceAccessV1(expired, projection({ assessedAt: T2 }));
  assert.deepEqual(noRole.applicableRoleIds, []);
  assert.deepEqual(noRole.effectiveCapabilityIds, []);
});

test('credential ownership remains opaque, explicit and independently owner-gated', () => {
  const normalized = normalizeCredentialOwnershipRefV1(credential());
  assert.equal(normalized.secretMaterialPresent, false);
  assert.equal(normalized.credentialUseAuthorized, false);
  assert.equal('secret' in normalized, false);

  const access = projectAgentGovernanceAccessV1(snapshot(), projection());
  assert.deepEqual(access.declaredCredentialRefIds, ['credential.github.main']);
  assert.deepEqual(access.effectiveCredentialRefIds, ['credential.github.main']);
  assert.equal(access.credentialUseAuthorized, false);

  const withheld = projectAgentGovernanceAccessV1(
    snapshot(),
    projection({ ownerGrantedCredentialRefIds: ['credential.other'] }),
  );
  assert.deepEqual(withheld.effectiveCredentialRefIds, []);

  const revokedSnapshot = snapshot();
  revokedSnapshot.credentialOwnerships[0].revokedAt = T1;
  const revoked = projectAgentGovernanceAccessV1(
    revokedSnapshot,
    projection({ assessedAt: T2 }),
  );
  assert.deepEqual(revoked.declaredCredentialRefIds, []);
});

test('strict type and authority-field aliases fail closed while null-prototype records remain valid', () => {
  const badVersion = snapshot();
  badVersion.schemaVersion = '1';
  assert.throws(() => normalizeAgentGovernanceSnapshotV1(badVersion), /schemaVersion must be 1/);

  const injected = snapshot();
  injected.authorizationGranted = true;
  assert.throws(() => normalizeAgentGovernanceSnapshotV1(injected), /unknown field/);

  const selfDelegate = credential({ delegatePrincipalIds: ['owner'] });
  assert.throws(() => normalizeCredentialOwnershipRefV1(selfDelegate), /cannot also be a delegate/);

  const badAgent = snapshot();
  badAgent.principals[0].parentPrincipalId = null;
  assert.throws(() => normalizeAgentGovernanceSnapshotV1(badAgent), /requires parentPrincipalId/);

  const nullProto = Object.assign(Object.create(null), snapshot());
  assert.doesNotThrow(() => normalizeAgentGovernanceSnapshotV1(nullProto));
});
