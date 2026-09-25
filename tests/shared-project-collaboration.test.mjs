import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHARED_PROJECT_COLLABORATION_SCHEMA_VERSION,
  SharedProjectCollaborationKind,
  assessSharedProjectAccessV1,
  assessSharedProjectCollaborationEventV1,
  normalizeSharedProjectBindingV1,
  normalizeSharedProjectCollaborationEventV1,
} from '../src/core/shared-project-collaboration.js';
import {
  CredentialOwnershipStatus,
  GovernancePrincipalKind,
  GovernancePrincipalStatus,
  IDENTITY_GOVERNANCE_SCHEMA_VERSION,
} from '../src/core/identity-governance.js';

const T0 = '2026-09-25T10:00:00.000Z';
const T05 = '2026-09-25T10:05:00.000Z';
const T1 = '2026-09-25T10:10:00.000Z';
const T2 = '2026-09-25T10:20:00.000Z';
const T25 = '2026-09-25T10:25:00.000Z';
const T3 = '2026-09-25T10:30:00.000Z';
const T4 = '2026-09-25T11:00:00.000Z';
const RESOURCE = 'project:project-a';

function artifact() {
  return {
    schemaVersion: 1,
    artifactId: 'build',
    kind: 'ZIP',
    uri: 'drive://build',
    mediaType: 'application/zip',
    sha256: 'b'.repeat(64),
    sizeBytes: 10,
    createdAt: T0,
    producerInvocationId: null,
    sensitive: false,
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: 'project-a',
    revisionId: 'project-r1',
    title: 'Shared project A',
    sourceRefs: [],
    artifactRefs: [artifact()],
    createdAt: T0,
    ...overrides,
  };
}

function principal(principalId, kind, overrides = {}) {
  return {
    principalId,
    organizationId: 'org-1',
    kind,
    displayName: principalId,
    parentPrincipalId: kind === GovernancePrincipalKind.USER ? '' : 'user-owner',
    status: GovernancePrincipalStatus.ACTIVE,
    createdAt: kind === GovernancePrincipalKind.USER ? T0 : T05,
    revokedAt: '',
    ...overrides,
  };
}

function registry(overrides = {}) {
  return {
    schemaVersion: IDENTITY_GOVERNANCE_SCHEMA_VERSION,
    registryId: 'identity-registry-1',
    organizationId: 'org-1',
    revision: 7,
    principals: [
      principal('user-owner', GovernancePrincipalKind.USER),
      principal('agent-worker', GovernancePrincipalKind.AGENT),
      principal('user-collab', GovernancePrincipalKind.USER),
      principal('user-handoff-only', GovernancePrincipalKind.USER),
      principal('user-guest', GovernancePrincipalKind.USER),
      principal('user-revoked', GovernancePrincipalKind.USER, {
        status: GovernancePrincipalStatus.REVOKED,
        revokedAt: T25,
      }),
    ],
    roles: [
      {
        roleId: 'role-owner',
        title: 'Owner',
        capabilityCeilingIds: ['project.read', 'project.comment', 'project.handoff'],
        providerCeilingIds: ['drive', 'github'],
        outboundDataClassIds: ['internal', 'public'],
      },
      {
        roleId: 'role-agent',
        title: 'Agent collaborator',
        capabilityCeilingIds: ['project.read', 'project.comment'],
        providerCeilingIds: ['drive'],
        outboundDataClassIds: ['internal'],
      },
      {
        roleId: 'role-collab',
        title: 'Human collaborator',
        capabilityCeilingIds: ['project.read', 'project.handoff'],
        providerCeilingIds: ['github'],
        outboundDataClassIds: ['public'],
      },
      {
        roleId: 'role-handoff-only',
        title: 'Handoff-only collaborator',
        capabilityCeilingIds: ['project.handoff'],
        providerCeilingIds: ['github'],
        outboundDataClassIds: ['public'],
      },
    ],
    grants: [
      {
        grantId: 'grant-owner',
        principalId: 'user-owner',
        roleId: 'role-owner',
        resourceKeys: [RESOURCE],
        grantedByPrincipalId: 'user-owner',
        createdAt: T1,
        expiresAt: '',
        revokedAt: '',
      },
      {
        grantId: 'grant-agent',
        principalId: 'agent-worker',
        roleId: 'role-agent',
        resourceKeys: [RESOURCE],
        grantedByPrincipalId: 'user-owner',
        createdAt: T1,
        expiresAt: '',
        revokedAt: '',
      },
      {
        grantId: 'grant-collab',
        principalId: 'user-collab',
        roleId: 'role-collab',
        resourceKeys: [RESOURCE],
        grantedByPrincipalId: 'user-owner',
        createdAt: T1,
        expiresAt: '',
        revokedAt: '',
      },
      {
        grantId: 'grant-handoff-only',
        principalId: 'user-handoff-only',
        roleId: 'role-handoff-only',
        resourceKeys: [RESOURCE],
        grantedByPrincipalId: 'user-owner',
        createdAt: T1,
        expiresAt: '',
        revokedAt: '',
      },
      {
        grantId: 'grant-revoked',
        principalId: 'user-revoked',
        roleId: 'role-collab',
        resourceKeys: [RESOURCE],
        grantedByPrincipalId: 'user-owner',
        createdAt: T1,
        expiresAt: '',
        revokedAt: '',
      },
    ],
    credentialOwnership: [
      {
        bindingId: 'binding-owner',
        credentialId: 'credential-owner',
        brokerId: 'broker-local',
        ownerPrincipalId: 'user-owner',
        status: CredentialOwnershipStatus.ACTIVE,
        createdAt: T1,
        revokedAt: '',
      },
      {
        bindingId: 'binding-agent',
        credentialId: 'credential-agent',
        brokerId: 'broker-local',
        ownerPrincipalId: 'agent-worker',
        status: CredentialOwnershipStatus.ACTIVE,
        createdAt: T1,
        revokedAt: '',
      },
    ],
    updatedAt: T4,
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    schemaVersion: SHARED_PROJECT_COLLABORATION_SCHEMA_VERSION,
    bindingId: 'shared-project-1',
    projectId: 'project-a',
    projectRevisionId: 'project-r1',
    organizationId: 'org-1',
    governanceRegistryId: 'identity-registry-1',
    governanceRegistryRevision: 7,
    ownerPrincipalId: 'user-owner',
    resourceKey: RESOURCE,
    createdAt: T2,
    ...overrides,
  };
}

function trusted(overrides = {}) {
  const calls = [];
  const values = {
    binding: overrides.bindingValue || binding(),
    snapshot: overrides.snapshotValue || snapshot(),
    registry: overrides.registryValue || registry(),
  };
  return {
    calls,
    async resolveSharedProjectBinding(bindingId) {
      calls.push(['binding', bindingId]);
      return values.binding;
    },
    async resolveProjectSnapshot(query) {
      calls.push(['snapshot', structuredClone(query)]);
      return values.snapshot;
    },
    async resolveIdentityGovernanceRegistry(query) {
      calls.push(['registry', structuredClone(query)]);
      return values.registry;
    },
  };
}

function access(principalId = 'agent-worker', overrides = {}) {
  return {
    bindingId: 'shared-project-1',
    principalId,
    at: T3,
    requestedCapabilityIds: ['project.comment', 'project.read'],
    requestedProviderIds: ['drive'],
    requestedOutboundDataClassIds: ['internal'],
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    schemaVersion: SHARED_PROJECT_COLLABORATION_SCHEMA_VERSION,
    eventId: 'event-1',
    kind: SharedProjectCollaborationKind.HANDOFF,
    bindingId: 'shared-project-1',
    projectId: 'project-a',
    projectRevisionId: 'project-r1',
    actorPrincipalId: 'user-owner',
    recipientPrincipalId: 'agent-worker',
    taskId: 'task-1',
    artifactIds: ['build'],
    message: 'Review the exact build artifact.',
    createdAt: T3,
    ...overrides,
  };
}

test('binding exactly couples one project revision to one governance registry revision', () => {
  const value = normalizeSharedProjectBindingV1(binding());
  assert.equal(value.projectId, 'project-a');
  assert.equal(value.projectRevisionId, 'project-r1');
  assert.equal(value.organizationId, 'org-1');
  assert.equal(value.resourceKey, RESOURCE);
  assert.equal(Object.isFrozen(value), true);

  assert.throws(
    () => normalizeSharedProjectBindingV1(binding({ resourceKey: 'project:other' })),
    /exactly bind/,
  );
});

test('access resolves exact trusted binding, Project snapshot and governance registry before membership evidence', async () => {
  const resolver = trusted();
  const result = await assessSharedProjectAccessV1(access(), resolver);
  assert.equal(result.collaborationEligible, true);
  assert.equal(result.reasonCode, 'ELIGIBLE_FOR_CANONICAL_POLICY');
  assert.equal(result.canonicalSourcesResolved, true);
  assert.equal(result.projectOwnerCurrentlyBound, true);
  assert.deepEqual(result.effectiveGrantIds, ['grant-agent', 'grant-owner']);
  assert.deepEqual(result.capabilityCeilingIds, ['project.comment', 'project.read']);
  assert.deepEqual(result.providerCeilingIds, ['drive']);
  assert.deepEqual(result.outboundDataClassIds, ['internal']);
  assert.deepEqual(result.ownedCredentialBindingIds, ['binding-agent']);
  assert.equal(Object.hasOwn(result, 'credentialId'), false);
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.credentialUseAuthorized, false);
  assert.equal(result.requiresCanonicalPolicyDecision, true);
  assert.deepEqual(resolver.calls, [
    ['binding', 'shared-project-1'],
    ['snapshot', { projectId: 'project-a', projectRevisionId: 'project-r1' }],
    ['registry', {
      governanceRegistryId: 'identity-registry-1',
      governanceRegistryRevision: 7,
      organizationId: 'org-1',
    }],
  ]);
});

test('requested authority outside inherited ceiling is visible but never admitted', async () => {
  const result = await assessSharedProjectAccessV1(access('agent-worker', {
    requestedCapabilityIds: ['project.handoff', 'project.read'],
  }), trusted());
  assert.equal(result.collaborationEligible, false);
  assert.equal(result.reasonCode, 'CAPABILITY_OUTSIDE_CEILING');
  assert.deepEqual(result.missingCapabilityIds, ['project.handoff']);
  assert.equal(result.authorizationGranted, false);
});

test('active principal without a project resource grant is not a collaborator', async () => {
  const result = await assessSharedProjectAccessV1(access('user-guest', {
    requestedCapabilityIds: [],
    requestedProviderIds: [],
    requestedOutboundDataClassIds: [],
  }), trusted());
  assert.equal(result.active, true);
  assert.equal(result.collaborationEligible, false);
  assert.equal(result.reasonCode, 'NO_PROJECT_GRANT');
  assert.deepEqual(result.effectiveGrantIds, []);
});

test('revoked principals fail closed at assessment instant', async () => {
  const result = await assessSharedProjectAccessV1(access('user-revoked', {
    requestedCapabilityIds: [],
    requestedProviderIds: [],
    requestedOutboundDataClassIds: [],
  }), trusted());
  assert.equal(result.active, false);
  assert.equal(result.collaborationEligible, false);
  assert.equal(result.reasonCode, 'PRINCIPAL_INACTIVE');
});

test('current owner revocation invalidates collaboration even for an independently granted user', async () => {
  const revokedOwnerRegistry = registry();
  revokedOwnerRegistry.principals = revokedOwnerRegistry.principals.map(item => (
    item.principalId === 'user-owner'
      ? { ...item, status: GovernancePrincipalStatus.REVOKED, revokedAt: T25 }
      : item
  ));
  const result = await assessSharedProjectAccessV1(access('user-collab', {
    requestedCapabilityIds: ['project.read'],
    requestedProviderIds: ['github'],
    requestedOutboundDataClassIds: ['public'],
  }), trusted({ registryValue: revokedOwnerRegistry }));
  assert.equal(result.active, true);
  assert.equal(result.projectOwnerCurrentlyBound, false);
  assert.equal(result.collaborationEligible, false);
  assert.equal(result.reasonCode, 'PROJECT_OWNER_INACTIVE_OR_UNBOUND');
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.credentialUseAuthorized, false);
});

test('trusted source identity, project revision and governance revision drift fail closed', async () => {
  await assert.rejects(
    assessSharedProjectAccessV1(access(), trusted({
      bindingValue: binding({ bindingId: 'shared-project-other' }),
    })),
    /binding identity mismatch/,
  );
  await assert.rejects(
    assessSharedProjectAccessV1(access(), trusted({
      snapshotValue: snapshot({ revisionId: 'project-r2' }),
    })),
    /does not match trusted project snapshot/,
  );
  await assert.rejects(
    assessSharedProjectAccessV1(access(), trusted({
      registryValue: registry({ revision: 8 }),
    })),
    /does not match trusted identity governance registry/,
  );
  await assert.rejects(
    assessSharedProjectAccessV1(access(), trusted({
      bindingValue: binding({ organizationId: 'org-other' }),
    })),
    /does not match trusted identity governance registry/,
  );
});

test('handoff is bound to trusted collaborators and canonical project artifacts but remains non-authorizing', async () => {
  const result = await assessSharedProjectCollaborationEventV1({
    event: event(),
    at: T3,
  }, trusted());
  assert.equal(result.eventAdmissibleForCollaboration, true);
  assert.equal(result.reasonCode, 'ELIGIBLE_FOR_CANONICAL_AUDIT_APPEND');
  assert.equal(result.actorRequiredCapabilityId, 'project.handoff');
  assert.equal(result.recipientRequiredCapabilityId, 'project.read');
  assert.equal(result.actorAccessReasonCode, 'ELIGIBLE_FOR_CANONICAL_POLICY');
  assert.equal(result.recipientAccessReasonCode, 'ELIGIBLE_FOR_CANONICAL_POLICY');
  assert.equal(result.event.artifactIds[0], 'build');
  assert.equal(result.canonicalSourcesResolved, true);
  assert.equal(result.contentTrust, 'UNTRUSTED_DATA');
  assert.equal(result.auditAppendAuthorized, false);
  assert.equal(result.commentPublishAuthorized, false);
  assert.equal(result.handoffAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.requiresCanonicalAuditAppend, true);
});

test('collaboration event kinds enforce actor and recipient capability ceilings before policy', async () => {
  const commentByNoCommentPrincipal = await assessSharedProjectCollaborationEventV1({
    event: event({
      kind: SharedProjectCollaborationKind.COMMENT,
      actorPrincipalId: 'user-collab',
      recipientPrincipalId: '',
      taskId: '',
      artifactIds: [],
      message: 'Attempted note.',
    }),
    at: T3,
  }, trusted());
  assert.equal(commentByNoCommentPrincipal.eventAdmissibleForCollaboration, false);
  assert.equal(commentByNoCommentPrincipal.actorRequiredCapabilityId, 'project.comment');
  assert.equal(commentByNoCommentPrincipal.actorAccessReasonCode, 'CAPABILITY_OUTSIDE_CEILING');
  assert.equal(commentByNoCommentPrincipal.auditAppendAuthorized, false);

  const handoffByNoHandoffPrincipal = await assessSharedProjectCollaborationEventV1({
    event: event({
      actorPrincipalId: 'agent-worker',
      recipientPrincipalId: 'user-collab',
    }),
    at: T3,
  }, trusted());
  assert.equal(handoffByNoHandoffPrincipal.eventAdmissibleForCollaboration, false);
  assert.equal(handoffByNoHandoffPrincipal.actorRequiredCapabilityId, 'project.handoff');
  assert.equal(handoffByNoHandoffPrincipal.actorAccessReasonCode, 'CAPABILITY_OUTSIDE_CEILING');

  const handoffToNoReadPrincipal = await assessSharedProjectCollaborationEventV1({
    event: event({
      actorPrincipalId: 'user-owner',
      recipientPrincipalId: 'user-handoff-only',
    }),
    at: T3,
  }, trusted());
  assert.equal(handoffToNoReadPrincipal.eventAdmissibleForCollaboration, false);
  assert.equal(handoffToNoReadPrincipal.recipientRequiredCapabilityId, 'project.read');
  assert.equal(handoffToNoReadPrincipal.recipientAccessReasonCode, 'CAPABILITY_OUTSIDE_CEILING');
  assert.equal(handoffToNoReadPrincipal.handoffAuthorized, false);
});

test('comments may be project-wide while handoffs require a distinct recipient', () => {
  const comment = normalizeSharedProjectCollaborationEventV1(event({
    kind: SharedProjectCollaborationKind.COMMENT,
    recipientPrincipalId: '',
    taskId: '',
    artifactIds: [],
    message: 'Project note.',
  }));
  assert.equal(comment.kind, 'COMMENT');
  assert.equal(comment.recipientPrincipalId, '');

  assert.throws(
    () => normalizeSharedProjectCollaborationEventV1(event({ recipientPrincipalId: '' })),
    /HANDOFF requires/,
  );
  assert.throws(
    () => normalizeSharedProjectCollaborationEventV1(event({ recipientPrincipalId: 'user-owner' })),
    /must differ/,
  );
});

test('recipient revocation blocks current handoff admission without rewriting audit payload', async () => {
  const result = await assessSharedProjectCollaborationEventV1({
    event: event({ recipientPrincipalId: 'user-revoked' }),
    at: T3,
  }, trusted());
  assert.equal(result.eventAdmissibleForCollaboration, false);
  assert.equal(result.reasonCode, 'RECIPIENT_PRINCIPAL_INACTIVE');
  assert.equal(result.event.recipientPrincipalId, 'user-revoked');
  assert.equal(result.handoffAuthorized, false);
});

test('event revision, time and artifact substitution fail closed', async () => {
  await assert.rejects(
    assessSharedProjectCollaborationEventV1({
      event: event({ projectRevisionId: 'project-r2' }),
      at: T3,
    }, trusted()),
    /does not match trusted shared project binding/,
  );
  await assert.rejects(
    assessSharedProjectCollaborationEventV1({
      event: event({ artifactIds: ['foreign'] }),
      at: T3,
    }, trusted()),
    /outside trusted project snapshot/,
  );
  await assert.rejects(
    assessSharedProjectCollaborationEventV1({
      event: event({ createdAt: T25 }),
      at: T3,
    }, trusted()),
    /must equal admission assessment time/,
  );
});

test('trusted resolver methods must be data methods and accessor injection executes zero getters', async () => {
  let reads = 0;
  const hostile = trusted();
  Object.defineProperty(hostile, 'resolveSharedProjectBinding', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return async () => binding();
    },
  });
  await assert.rejects(
    assessSharedProjectAccessV1(access(), hostile),
    /must expose resolveSharedProjectBinding as a data method/,
  );
  assert.equal(reads, 0);
});

test('descriptor-hostile request fields reject without invoking getters', async () => {
  let reads = 0;
  const hostile = access();
  Object.defineProperty(hostile, 'bindingId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'shared-project-1';
    },
  });
  await assert.rejects(
    assessSharedProjectAccessV1(hostile, trusted()),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);
});

test('sparse arrays and symbol event fields reject before trusted resolution', async () => {
  const sparse = new Array(1);
  const resolver = trusted();
  await assert.rejects(
    assessSharedProjectAccessV1(access('agent-worker', {
      requestedCapabilityIds: sparse,
    }), resolver),
    /must not be sparse/,
  );
  assert.deepEqual(resolver.calls, []);

  const withSymbol = event();
  withSymbol[Symbol('hidden')] = 'hidden';
  assert.throws(
    () => normalizeSharedProjectCollaborationEventV1(withSymbol),
    /unknown field/,
  );
});

test('requested scope and artifact IDs are canonically sorted for deterministic evidence', async () => {
  const result = await assessSharedProjectAccessV1(access('user-owner', {
    requestedCapabilityIds: ['project.read', 'project.comment'],
    requestedProviderIds: ['github', 'drive'],
    requestedOutboundDataClassIds: ['public', 'internal'],
  }), trusted());
  assert.deepEqual(result.requestedCapabilityIds, ['project.comment', 'project.read']);
  assert.deepEqual(result.requestedProviderIds, ['drive', 'github']);
  assert.deepEqual(result.requestedOutboundDataClassIds, ['internal', 'public']);

  const normalizedEvent = normalizeSharedProjectCollaborationEventV1(event({
    artifactIds: ['build'],
  }));
  assert.deepEqual(normalizedEvent.artifactIds, ['build']);
});
