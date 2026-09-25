import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSharedProjectGovernanceV1,
  SHARED_PROJECT_GOVERNANCE_SCHEMA_VERSION,
} from '../src/core/shared-project-governance.js';
import {
  GovernancePrincipalKind,
  GovernancePrincipalStatus,
} from '../src/core/identity-governance.js';

const T0 = '2026-09-25T08:00:00.000Z';
const T1 = '2026-09-25T08:10:00.000Z';
const T2 = '2026-09-25T08:20:00.000Z';
const T3 = '2026-09-25T09:00:00.000Z';
const T4 = '2026-09-25T10:00:00.000Z';

function project(revisionId = 'project-r1') {
  return {
    schemaVersion: 1,
    projectId: 'project-a',
    revisionId,
    title: 'Project A',
    sourceRefs: [],
    artifactRefs: [],
    createdAt: T0,
  };
}

function principal(principalId, kind, parentPrincipalId, createdAt = T0, overrides = {}) {
  return {
    principalId,
    organizationId: 'org-1',
    kind,
    displayName: principalId,
    parentPrincipalId,
    status: GovernancePrincipalStatus.ACTIVE,
    createdAt,
    revokedAt: '',
    ...overrides,
  };
}

function identityRegistry(overrides = {}) {
  return {
    schemaVersion: 1,
    registryId: 'identity-registry-1',
    organizationId: 'org-1',
    revision: 7,
    principals: [
      principal('owner', GovernancePrincipalKind.USER, ''),
      principal('agent-a', GovernancePrincipalKind.AGENT, 'owner', T1),
      principal('agent-child', GovernancePrincipalKind.AGENT, 'agent-a', T2),
    ],
    roles: [
      {
        roleId: 'project-owner',
        title: 'Project owner',
        capabilityCeilingIds: ['artifact.read', 'artifact.write', 'project.read'],
        providerCeilingIds: ['drive', 'github'],
        outboundDataClassIds: ['internal', 'public'],
      },
      {
        roleId: 'project-agent',
        title: 'Project agent',
        capabilityCeilingIds: ['artifact.read', 'project.read'],
        providerCeilingIds: ['github'],
        outboundDataClassIds: ['public'],
      },
      {
        roleId: 'project-child',
        title: 'Project child',
        capabilityCeilingIds: ['artifact.delete', 'artifact.read', 'project.read'],
        providerCeilingIds: ['github'],
        outboundDataClassIds: ['public', 'secret'],
      },
    ],
    grants: [
      {
        grantId: 'grant-owner',
        principalId: 'owner',
        roleId: 'project-owner',
        resourceKeys: ['project:project-a'],
        grantedByPrincipalId: 'owner',
        createdAt: T1,
        expiresAt: '',
        revokedAt: '',
      },
      {
        grantId: 'grant-agent',
        principalId: 'agent-a',
        roleId: 'project-agent',
        resourceKeys: ['project:project-a'],
        grantedByPrincipalId: 'owner',
        createdAt: T2,
        expiresAt: '',
        revokedAt: '',
      },
      {
        grantId: 'grant-child',
        principalId: 'agent-child',
        roleId: 'project-child',
        resourceKeys: ['project:project-a'],
        grantedByPrincipalId: 'agent-a',
        createdAt: T2,
        expiresAt: '',
        revokedAt: '',
      },
    ],
    credentialOwnership: [],
    updatedAt: T4,
    ...overrides,
  };
}

function membership(membershipId, principalId, invitedByPrincipalId, joinedAt, overrides = {}) {
  return {
    membershipId,
    projectId: 'project-a',
    principalId,
    invitedByPrincipalId,
    joinedAt,
    leftAt: '',
    ...overrides,
  };
}

function audit(eventId, actorPrincipalId, eventType, overrides = {}) {
  return {
    eventId,
    projectId: 'project-a',
    principalId: '',
    actorPrincipalId,
    eventType,
    subjectId: '',
    occurredAt: T3,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    projectSnapshot: project(),
    identityRegistry: identityRegistry(),
    memberships: [
      membership('m-owner', 'owner', 'owner', T1),
      membership('m-agent', 'agent-a', 'owner', T2),
      membership('m-child', 'agent-child', 'agent-a', T2),
    ],
    auditEvents: [
      audit('event-2', 'owner', 'MEMBER_ADDED', { principalId: 'agent-a', subjectId: 'm-agent' }),
      audit('event-1', 'owner', 'PROJECT_SHARED', { occurredAt: T2 }),
    ],
    evaluatedAt: T3,
    ...overrides,
  };
}

test('shared Project governance reuses canonical identity ceilings and never grants action authority', () => {
  const result = buildSharedProjectGovernanceV1(request());

  assert.equal(result.schemaVersion, SHARED_PROJECT_GOVERNANCE_SCHEMA_VERSION);
  assert.equal(result.projectId, 'project-a');
  assert.equal(result.projectRevisionId, 'project-r1');
  assert.equal(result.resourceKey, 'project:project-a');
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.credentialUseAuthorized, false);
  assert.equal(result.requiresPolicyDecision, true);
  assert.equal(result.policyDecision, 'NONE');

  assert.deepEqual(result.participants.map((item) => item.principalId), [
    'agent-a',
    'agent-child',
    'owner',
  ]);

  const owner = result.participants.find((item) => item.principalId === 'owner');
  assert.deepEqual(owner.capabilityCeilingIds, ['artifact.read', 'artifact.write', 'project.read']);
  assert.deepEqual(owner.providerCeilingIds, ['drive', 'github']);

  const agent = result.participants.find((item) => item.principalId === 'agent-a');
  assert.deepEqual(agent.capabilityCeilingIds, ['artifact.read', 'project.read']);
  assert.deepEqual(agent.providerCeilingIds, ['github']);
  assert.deepEqual(agent.outboundDataClassIds, ['public']);

  const child = result.participants.find((item) => item.principalId === 'agent-child');
  assert.deepEqual(child.capabilityCeilingIds, ['artifact.read', 'project.read']);
  assert.equal(child.capabilityCeilingIds.includes('artifact.delete'), false);
  assert.equal(child.outboundDataClassIds.includes('secret'), false);

  assert.equal(result.participants.every((item) => item.authorizationGranted === false), true);
  assert.equal(result.participants.every((item) => item.credentialUseAuthorized === false), true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.participants), true);
});

test('audit history is deterministic and future evidence is not exposed at earlier evaluation time', () => {
  const result = buildSharedProjectGovernanceV1(request({
    auditEvents: [
      audit('future-event', 'owner', 'LATER', { occurredAt: T4 }),
      audit('same-z', 'owner', 'SECOND', { occurredAt: T3 }),
      audit('same-a', 'owner', 'FIRST', { occurredAt: T3 }),
      audit('earlier', 'owner', 'EARLY', { occurredAt: T2 }),
    ],
  }));

  assert.deepEqual(result.auditEvents.map((item) => item.eventId), ['earlier', 'same-a', 'same-z']);
});

test('membership is logical-project scoped and survives a new Project snapshot revision without re-authorizing it', () => {
  const first = buildSharedProjectGovernanceV1(request({ projectSnapshot: project('project-r1') }));
  const second = buildSharedProjectGovernanceV1(request({ projectSnapshot: project('project-r2') }));

  assert.equal(first.projectRevisionId, 'project-r1');
  assert.equal(second.projectRevisionId, 'project-r2');
  assert.deepEqual(
    second.participants.map((item) => [item.principalId, item.capabilityCeilingIds]),
    first.participants.map((item) => [item.principalId, item.capabilityCeilingIds]),
  );
  assert.equal(second.authorizationGranted, false);
});

test('left membership is absent after its exact leftAt boundary while audit evidence remains visible', () => {
  const result = buildSharedProjectGovernanceV1(request({
    memberships: [
      membership('m-owner', 'owner', 'owner', T1),
      membership('m-agent', 'agent-a', 'owner', T2, { leftAt: T3 }),
    ],
    auditEvents: [
      audit('left-agent', 'owner', 'MEMBER_REMOVED', {
        principalId: 'agent-a',
        subjectId: 'm-agent',
        occurredAt: T3,
      }),
    ],
  }));

  assert.deepEqual(result.participants.map((item) => item.principalId), ['owner']);
  assert.deepEqual(result.auditEvents.map((item) => item.eventId), ['left-agent']);
});

test('identity revocation makes a still-listed membership non-authoritative', () => {
  const registry = identityRegistry();
  registry.principals = registry.principals.map((item) => (
    item.principalId === 'agent-a'
      ? { ...item, status: GovernancePrincipalStatus.REVOKED, revokedAt: T3 }
      : item
  ));
  registry.grants = registry.grants.map((item) => (
    item.grantId === 'grant-agent'
      ? { ...item, revokedAt: T3 }
      : item
  ));

  const before = buildSharedProjectGovernanceV1(request({
    identityRegistry: registry,
    evaluatedAt: '2026-09-25T08:59:59.000Z',
    auditEvents: [],
  }));
  assert.equal(before.participants.find((item) => item.principalId === 'agent-a').identityActive, true);

  const after = buildSharedProjectGovernanceV1(request({
    identityRegistry: registry,
    evaluatedAt: T3,
    auditEvents: [],
  }));
  const agent = after.participants.find((item) => item.principalId === 'agent-a');
  const child = after.participants.find((item) => item.principalId === 'agent-child');
  assert.equal(agent.identityActive, false);
  assert.deepEqual(agent.capabilityCeilingIds, []);
  assert.equal(child.identityActive, false);
  assert.deepEqual(child.capabilityCeilingIds, []);
  assert.equal(after.authorizationGranted, false);
});

test('projection fails closed on unknown principals, wrong project, duplicate active memberships, and future evaluation', () => {
  assert.throws(
    () => buildSharedProjectGovernanceV1(request({
      memberships: [membership('m-unknown', 'missing', 'owner', T2)],
    })),
    /unknown principalId/,
  );

  assert.throws(
    () => buildSharedProjectGovernanceV1(request({
      memberships: [membership('m-owner', 'owner', 'owner', T1, { projectId: 'project-b' })],
    })),
    /does not match ProjectSnapshotV1/,
  );

  assert.throws(
    () => buildSharedProjectGovernanceV1(request({
      memberships: [
        membership('m-a', 'owner', 'owner', T1),
        membership('m-b', 'owner', 'owner', T2),
      ],
    })),
    /multiple active memberships/,
  );

  assert.throws(
    () => buildSharedProjectGovernanceV1(request({ evaluatedAt: '2026-09-25T10:00:00.001Z' })),
    /later than identity registry updatedAt/,
  );
});

test('membership cannot predate principal creation or be created by an inactive inviter', () => {
  assert.throws(
    () => buildSharedProjectGovernanceV1(request({
      memberships: [membership('m-child', 'agent-child', 'owner', T1)],
    })),
    /predates principal creation/,
  );

  const registry = identityRegistry();
  registry.principals = registry.principals.map((item) => (
    item.principalId === 'owner'
      ? { ...item, status: GovernancePrincipalStatus.REVOKED, revokedAt: T2 }
      : item
  ));
  registry.grants = registry.grants.map((item) => (
    item.grantId === 'grant-owner'
      ? { ...item, revokedAt: T2 }
      : item
  ));

  assert.throws(
    () => buildSharedProjectGovernanceV1(request({
      identityRegistry: registry,
      memberships: [membership('m-agent', 'agent-a', 'owner', T3)],
      auditEvents: [],
    })),
    /inviting principal was inactive/,
  );
});

test('request and arrays reject getters, hidden authority, exotic prototypes, and sparse data before use', () => {
  const base = request();
  let reads = 0;
  const getterRequest = { ...base };
  Object.defineProperty(getterRequest, 'memberships', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return base.memberships;
    },
  });
  assert.throws(
    () => buildSharedProjectGovernanceV1(getterRequest),
    /enumerable data properties only/,
  );
  assert.equal(reads, 0);

  assert.throws(
    () => buildSharedProjectGovernanceV1({ ...base, authorizationGranted: true }),
    /unknown field/,
  );

  const exotic = Object.assign(Object.create({ inheritedAuthority: true }), base);
  assert.throws(
    () => buildSharedProjectGovernanceV1(exotic),
    /plain object/,
  );

  const sparse = new Array(2);
  sparse[0] = base.memberships[0];
  assert.throws(
    () => buildSharedProjectGovernanceV1({ ...base, memberships: sparse }),
    /dense data-only array/,
  );

  const hidden = [...base.auditEvents];
  Object.defineProperty(hidden, 'authority', {
    value: 'ALLOW',
    enumerable: false,
  });
  assert.throws(
    () => buildSharedProjectGovernanceV1({ ...base, auditEvents: hidden }),
    /non-index data/,
  );
});
