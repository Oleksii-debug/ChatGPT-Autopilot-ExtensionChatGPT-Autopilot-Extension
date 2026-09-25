import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSharedProjectGovernanceEvidenceV1,
  SHARED_PROJECT_GOVERNANCE_EVIDENCE_SCHEMA_VERSION,
  SHARED_PROJECT_GOVERNANCE_EXPORT_CAPABILITY,
} from '../src/core/shared-project-governance-evidence.js';
import {
  GovernancePrincipalKind,
  GovernancePrincipalStatus,
} from '../src/core/identity-governance.js';

const T0 = '2026-09-25T08:00:00.000Z';
const T1 = '2026-09-25T08:10:00.000Z';
const T2 = '2026-09-25T08:20:00.000Z';
const T3 = '2026-09-25T09:00:00.000Z';
const T4 = '2026-09-25T10:00:00.000Z';

function project() {
  return {
    schemaVersion: 1,
    projectId: 'project-a',
    revisionId: 'project-r1',
    title: 'Project A',
    sourceRefs: [],
    artifactRefs: [],
    createdAt: T0,
  };
}

function binding() {
  return {
    schemaVersion: 1,
    bindingId: 'shared-project-a',
    projectId: 'project-a',
    projectRevisionId: 'project-r1',
    organizationId: 'org-1',
    governanceRegistryId: 'identity-registry-1',
    governanceRegistryRevision: 4,
    ownerPrincipalId: 'owner',
    resourceKey: 'project:project-a',
    createdAt: T2,
  };
}

function registry({ ownerCanExport = true, revokeAgentAt = '' } = {}) {
  return {
    schemaVersion: 1,
    registryId: 'identity-registry-1',
    organizationId: 'org-1',
    revision: 4,
    principals: [
      {
        principalId: 'owner',
        organizationId: 'org-1',
        kind: GovernancePrincipalKind.USER,
        displayName: 'Owner',
        parentPrincipalId: '',
        status: GovernancePrincipalStatus.ACTIVE,
        createdAt: T0,
        revokedAt: '',
      },
      {
        principalId: 'agent-a',
        organizationId: 'org-1',
        kind: GovernancePrincipalKind.AGENT,
        displayName: 'Agent A',
        parentPrincipalId: 'owner',
        status: revokeAgentAt ? GovernancePrincipalStatus.REVOKED : GovernancePrincipalStatus.ACTIVE,
        createdAt: T1,
        revokedAt: revokeAgentAt,
      },
      {
        principalId: 'observer',
        organizationId: 'org-1',
        kind: GovernancePrincipalKind.USER,
        displayName: 'Observer without project grant',
        parentPrincipalId: '',
        status: GovernancePrincipalStatus.ACTIVE,
        createdAt: T1,
        revokedAt: '',
      },
    ],
    roles: [
      {
        roleId: 'role-owner',
        title: 'Project owner',
        capabilityCeilingIds: ownerCanExport
          ? ['project.read', SHARED_PROJECT_GOVERNANCE_EXPORT_CAPABILITY]
          : ['project.read'],
        providerCeilingIds: ['provider-a'],
        outboundDataClassIds: ['internal'],
      },
      {
        roleId: 'role-agent',
        title: 'Project agent',
        capabilityCeilingIds: ['project.read'],
        providerCeilingIds: ['provider-a'],
        outboundDataClassIds: ['internal'],
      },
    ],
    grants: [
      {
        grantId: 'grant-owner',
        principalId: 'owner',
        roleId: 'role-owner',
        resourceKeys: ['project:project-a'],
        grantedByPrincipalId: 'owner',
        createdAt: T1,
        expiresAt: '',
        revokedAt: '',
      },
      {
        grantId: 'grant-agent',
        principalId: 'agent-a',
        roleId: 'role-agent',
        resourceKeys: ['project:project-a'],
        grantedByPrincipalId: 'owner',
        createdAt: T2,
        expiresAt: '',
        revokedAt: '',
      },
    ],
    credentialOwnership: [
      {
        bindingId: 'cred-binding-agent',
        credentialId: 'credential-private-identifier',
        brokerId: 'broker-private-identifier',
        ownerPrincipalId: 'agent-a',
        status: 'ACTIVE',
        createdAt: T2,
        revokedAt: '',
      },
    ],
    updatedAt: T4,
  };
}

function trustedResolver({
  projectSnapshot = project(),
  projectBinding = binding(),
  governanceRegistry = registry(),
} = {}) {
  return {
    resolveSharedProjectBinding(bindingId) {
      return projectBinding && bindingId === projectBinding.bindingId
        ? projectBinding
        : null;
    },
    resolveProjectSnapshot({ projectId, projectRevisionId }) {
      return projectSnapshot
        && projectId === projectSnapshot.projectId
        && projectRevisionId === projectSnapshot.revisionId
        ? projectSnapshot
        : null;
    },
    resolveIdentityGovernanceRegistry({
      governanceRegistryId,
      governanceRegistryRevision,
      organizationId,
    }) {
      return governanceRegistry
        && governanceRegistryId === governanceRegistry.registryId
        && governanceRegistryRevision === governanceRegistry.revision
        && organizationId === governanceRegistry.organizationId
        ? governanceRegistry
        : null;
    },
  };
}

function request(overrides = {}) {
  return {
    bindingId: 'shared-project-a',
    viewerPrincipalId: 'owner',
    principalIds: ['owner', 'observer', 'agent-a'],
    evaluatedAt: T4,
    ...overrides,
  };
}

test('shared Project governance evidence is canonical, deterministic, scoped and non-authorizing', async () => {
  const out = await buildSharedProjectGovernanceEvidenceV1(
    request(),
    trustedResolver(),
  );

  assert.equal(out.schemaVersion, SHARED_PROJECT_GOVERNANCE_EVIDENCE_SCHEMA_VERSION);
  assert.equal(out.bindingId, 'shared-project-a');
  assert.equal(out.projectId, 'project-a');
  assert.equal(out.projectRevisionId, 'project-r1');
  assert.equal(out.organizationId, 'org-1');
  assert.equal(out.governanceRegistryId, 'identity-registry-1');
  assert.equal(out.governanceRegistryRevision, 4);
  assert.equal(out.resourceKey, 'project:project-a');
  assert.equal(out.viewerPrincipalId, 'owner');
  assert.equal(out.viewerRequiredCapabilityId, SHARED_PROJECT_GOVERNANCE_EXPORT_CAPABILITY);
  assert.equal(out.viewerAccessReasonCode, 'ELIGIBLE_FOR_CANONICAL_POLICY');
  assert.deepEqual(out.principals.map(item => item.principalId), ['agent-a', 'observer', 'owner']);

  const agent = out.principals[0];
  assert.equal(agent.active, true);
  assert.equal(agent.reasonCode, 'ELIGIBLE_FOR_CANONICAL_POLICY');
  assert.deepEqual(agent.effectiveRoleIds, ['role-agent', 'role-owner']);
  assert.deepEqual(agent.effectiveGrantIds, ['grant-agent', 'grant-owner']);
  assert.deepEqual(agent.capabilityCeilingIds, ['project.read']);
  assert.deepEqual(agent.providerCeilingIds, ['provider-a']);
  assert.deepEqual(agent.outboundDataClassIds, ['internal']);
  assert.deepEqual(agent.ownedCredentialBindingIds, ['cred-binding-agent']);

  const observer = out.principals[1];
  assert.equal(observer.active, true);
  assert.equal(observer.collaborationEligible, false);
  assert.equal(observer.reasonCode, 'NO_PROJECT_GRANT');
  assert.deepEqual(observer.effectiveGrantIds, []);

  assert.equal(out.credentialExposure, 'OPAQUE_BINDING_IDS_ONLY');
  assert.equal(out.canonicalSourcesResolved, true);
  assert.equal(out.readOnly, true);
  assert.equal(out.advisoryOnly, true);
  assert.equal(out.exportAuthorized, false);
  assert.equal(out.authorizationGranted, false);
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.mutationAuthorized, false);
  assert.equal(out.credentialUseAuthorized, false);
  assert.equal(out.requiresCanonicalPolicyDecision, true);
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.principals), true);
  assert.equal(Object.isFrozen(out.principals[0]), true);

  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes('credential-private-identifier'), false);
  assert.equal(serialized.includes('broker-private-identifier'), false);
  assert.equal(serialized.includes('cred-binding-agent'), true);
});

test('viewer must fit canonical project.governance.export ceiling', async () => {
  await assert.rejects(
    buildSharedProjectGovernanceEvidenceV1(
      request(),
      trustedResolver({ governanceRegistry: registry({ ownerCanExport: false }) }),
    ),
    /outside canonical export ceiling: CAPABILITY_OUTSIDE_CEILING/,
  );

  await assert.rejects(
    buildSharedProjectGovernanceEvidenceV1(
      request({ viewerPrincipalId: 'observer' }),
      trustedResolver(),
    ),
    /outside canonical export ceiling: NO_PROJECT_GRANT/,
  );
});

test('revoked principal remains visible only as non-authorizing current governance evidence', async () => {
  const out = await buildSharedProjectGovernanceEvidenceV1(
    request({ principalIds: ['agent-a'] }),
    trustedResolver({ governanceRegistry: registry({ revokeAgentAt: T4 }) }),
  );

  assert.equal(out.principals.length, 1);
  assert.equal(out.principals[0].principalId, 'agent-a');
  assert.equal(out.principals[0].active, false);
  assert.equal(out.principals[0].collaborationEligible, false);
  assert.equal(out.principals[0].reasonCode, 'PRINCIPAL_INACTIVE');
  assert.deepEqual(out.principals[0].effectiveRoleIds, []);
  assert.deepEqual(out.principals[0].effectiveGrantIds, []);
  assert.deepEqual(out.principals[0].ownedCredentialBindingIds, []);
  assert.equal(out.principals[0].authorizationGranted, false);
  assert.equal(out.principals[0].credentialUseAuthorized, false);
});

test('unknown principal and missing canonical binding fail closed', async () => {
  await assert.rejects(
    buildSharedProjectGovernanceEvidenceV1(
      request({ principalIds: ['unknown-principal'] }),
      trustedResolver(),
    ),
    /principalId is not present in identity governance registry/,
  );

  await assert.rejects(
    buildSharedProjectGovernanceEvidenceV1(
      request({ bindingId: 'missing-binding' }),
      trustedResolver(),
    ),
    /Trusted shared-project binding was not found/,
  );
});

test('empty principal selection still proves canonical Project identity through export viewer access', async () => {
  const out = await buildSharedProjectGovernanceEvidenceV1(
    request({ principalIds: [] }),
    trustedResolver(),
  );

  assert.equal(out.projectId, 'project-a');
  assert.equal(out.projectRevisionId, 'project-r1');
  assert.equal(out.organizationId, 'org-1');
  assert.equal(out.governanceRegistryRevision, 4);
  assert.deepEqual(out.principals, []);
  assert.equal(out.exportAuthorized, false);
});

test('request boundaries reject getters, sparse arrays, duplicates, aliases and hidden authority', async () => {
  const base = request();
  let reads = 0;
  const getter = { ...base };
  Object.defineProperty(getter, 'principalIds', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return base.principalIds;
    },
  });
  await assert.rejects(
    buildSharedProjectGovernanceEvidenceV1(getter, trustedResolver()),
    /enumerable own data properties only/,
  );
  assert.equal(reads, 0);

  const sparse = new Array(2);
  sparse[0] = 'owner';
  await assert.rejects(
    buildSharedProjectGovernanceEvidenceV1(
      request({ principalIds: sparse }),
      trustedResolver(),
    ),
    /dense data-only array/,
  );

  await assert.rejects(
    buildSharedProjectGovernanceEvidenceV1(
      request({ principalIds: ['owner', 'owner'] }),
      trustedResolver(),
    ),
    /duplicate IDs/,
  );

  await assert.rejects(
    buildSharedProjectGovernanceEvidenceV1(
      request({ viewerPrincipalId: ' owner' }),
      trustedResolver(),
    ),
    /exact canonical identity representation/,
  );

  await assert.rejects(
    buildSharedProjectGovernanceEvidenceV1(
      request({ evaluatedAt: '2026-09-25T10:00:00Z' }),
      trustedResolver(),
    ),
    /canonical ISO timestamp/,
  );

  await assert.rejects(
    buildSharedProjectGovernanceEvidenceV1(
      { ...base, exportAuthorized: true },
      trustedResolver(),
    ),
    /unknown field/,
  );

  const hidden = [...base.principalIds];
  Object.defineProperty(hidden, 'authority', { value: 'ALLOW', enumerable: false });
  await assert.rejects(
    buildSharedProjectGovernanceEvidenceV1(
      request({ principalIds: hidden }),
      trustedResolver(),
    ),
    /non-index data/,
  );
});
