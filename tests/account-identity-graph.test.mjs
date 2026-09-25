import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AccountIdentityContextStatus,
  AccountIdentityEnvironment,
  AccountIdentityKind,
  AccountIdentityVerdict,
  assessAccountIdentityScopeV1,
} from '../src/core/account-identity-graph.js';

function context(overrides = {}) {
  return {
    schemaVersion: 1,
    authorityRecordId: 'authority-context-1',
    contextId: 'context-google-work',
    organizationId: 'org-1',
    principalId: 'user-owner',
    providerId: 'google-workspace',
    status: AccountIdentityContextStatus.ACTIVE,
    accountKind: AccountIdentityKind.GOOGLE_ACCOUNT,
    environment: AccountIdentityEnvironment.WORK,
    accountSubjectId: 'user@example.test',
    tenantId: 'tenant-1',
    workspaceId: 'workspace-1',
    browserProfileId: 'chrome-profile-work',
    credentialBindingId: 'credential-binding-1',
    resourceKeys: ['project-1', 'resource-drive'],
    relatedContextIds: ['context-github-work'],
    createdAt: '2026-09-01T00:00:00.000Z',
    revokedAt: '',
    validThrough: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    schemaVersion: 1,
    observationId: 'observation-1',
    observationAuthorityId: 'identity-observer-1',
    contextId: 'context-google-work',
    providerId: 'google-workspace',
    accountKind: AccountIdentityKind.GOOGLE_ACCOUNT,
    environment: AccountIdentityEnvironment.WORK,
    accountSubjectId: 'user@example.test',
    tenantId: 'tenant-1',
    workspaceId: 'workspace-1',
    browserProfileId: 'chrome-profile-work',
    observedAt: '2026-09-25T08:00:00.000Z',
    validThrough: '2026-09-25T09:00:00.000Z',
    evidenceArtifactIds: ['artifact-identity-1'],
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    assessmentId: 'assessment-1',
    organizationId: 'org-1',
    principalId: 'user-owner',
    contextId: 'context-google-work',
    observationId: 'observation-1',
    providerId: 'google-workspace',
    resourceKey: 'project-1',
    invocationId: 'invocation-1',
    evaluatedAt: '2026-09-25T08:30:00.000Z',
    consequential: true,
    ...overrides,
  };
}

function deps(ctx = context(), obs = observation()) {
  return {
    resolveTrustedAccountContext: async id => id === ctx.contextId ? ctx : null,
    resolveTrustedIdentityObservation: async id => id === obs.observationId ? obs : null,
  };
}

test('exact trusted account and observed identity match may proceed to canonical policy only', async () => {
  const result = await assessAccountIdentityScopeV1(request(), deps());
  assert.equal(result.verdict, AccountIdentityVerdict.MATCH);
  assert.equal(result.identityMatch, true);
  assert.equal(result.mayProceedToPolicy, true);
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.credentialUseAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.requiresCanonicalGovernancePolicyDecision, true);
  assert.equal(result.credentialBindingId, 'credential-binding-1');
  assert.deepEqual(result.evidenceArtifactIds, ['artifact-identity-1']);
});

test('wrong authenticated account/profile/tenant/environment blocks and requires reconcile', async () => {
  const obs = observation({
    accountSubjectId: 'other@example.test',
    tenantId: 'tenant-2',
    workspaceId: 'workspace-2',
    browserProfileId: 'chrome-profile-personal',
    environment: AccountIdentityEnvironment.PERSONAL,
  });
  const result = await assessAccountIdentityScopeV1(request(), deps(context(), obs));
  assert.equal(result.verdict, AccountIdentityVerdict.BLOCKED_IDENTITY_MISMATCH);
  assert.equal(result.identityMatch, false);
  assert.equal(result.mayProceedToPolicy, false);
  assert.equal(result.reconciliationRequired, true);
  assert.deepEqual(result.blockers, [
    'ENVIRONMENT_MISMATCH',
    'ACCOUNT_SUBJECT_MISMATCH',
    'TENANT_MISMATCH',
    'WORKSPACE_MISMATCH',
    'BROWSER_PROFILE_MISMATCH',
  ]);
});

test('revoked or stale account context blocks before provider use', async () => {
  const revoked = context({
    status: AccountIdentityContextStatus.REVOKED,
    revokedAt: '2026-09-20T00:00:00.000Z',
  });
  const revokedResult = await assessAccountIdentityScopeV1(request(), deps(revoked, observation()));
  assert.equal(revokedResult.verdict, AccountIdentityVerdict.BLOCKED_CONTEXT_REVOKED);
  assert.deepEqual(revokedResult.blockers, ['CONTEXT_REVOKED']);

  const stale = context({ validThrough: '2026-09-25T08:15:00.000Z' });
  const staleResult = await assessAccountIdentityScopeV1(request(), deps(stale, observation()));
  assert.equal(staleResult.verdict, AccountIdentityVerdict.BLOCKED_CONTEXT_STALE);
  assert.deepEqual(staleResult.blockers, ['CONTEXT_STALE']);
});

test('stale authenticated observation blocks; future observation is invalid evidence', async () => {
  const staleObs = observation({ validThrough: '2026-09-25T08:15:00.000Z' });
  const stale = await assessAccountIdentityScopeV1(request(), deps(context(), staleObs));
  assert.equal(stale.verdict, AccountIdentityVerdict.BLOCKED_OBSERVATION_STALE);
  assert.deepEqual(stale.blockers, ['OBSERVATION_STALE']);

  const future = observation({ observedAt: '2026-09-25T08:45:00.000Z' });
  await assert.rejects(
    assessAccountIdentityScopeV1(request(), deps(context(), future)),
    /future-dated/,
  );
});

test('resource scope and caller/project/provider/principal aliases fail closed', async () => {
  const resource = await assessAccountIdentityScopeV1(
    request({ resourceKey: 'resource-denied' }),
    deps(),
  );
  assert.deepEqual(resource.blockers, ['RESOURCE_SCOPE_MISMATCH']);

  await assert.rejects(
    assessAccountIdentityScopeV1(request({ contextId: ' context-google-work' }), deps()),
    /exact canonical identity/,
  );
  await assert.rejects(
    assessAccountIdentityScopeV1(request({ principalId: 'user-other' }), deps()),
    /principalId does not match/,
  );
  await assert.rejects(
    assessAccountIdentityScopeV1(request({ providerId: 'provider-other' }), deps()),
    /providerId does not match/,
  );
});

test('resolver cannot substitute a different context or observation identity', async () => {
  await assert.rejects(
    assessAccountIdentityScopeV1(request(), {
      ...deps(),
      resolveTrustedAccountContext: async () => context({ contextId: 'context-other' }),
    }),
    /does not match requested contextId/,
  );
  await assert.rejects(
    assessAccountIdentityScopeV1(request(), {
      ...deps(),
      resolveTrustedIdentityObservation: async () => observation({ observationId: 'observation-other' }),
    }),
    /does not match requested observationId/,
  );
});

test('hostile getters in trusted context or observation arrays are never executed', async () => {
  let getterCalls = 0;
  const hostileContext = context();
  Object.defineProperty(hostileContext, 'accountSubjectId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'attacker@example.test';
    },
  });
  await assert.rejects(
    assessAccountIdentityScopeV1(request(), deps(hostileContext, observation())),
    /enumerable own data property/,
  );
  assert.equal(getterCalls, 0);

  let arrayGetterCalls = 0;
  const hostileObservation = observation();
  const evidence = [];
  Object.defineProperty(evidence, '0', {
    enumerable: true,
    configurable: true,
    get() {
      arrayGetterCalls += 1;
      return 'secret-derived-id';
    },
  });
  evidence.length = 1;
  hostileObservation.evidenceArtifactIds = evidence;
  await assert.rejects(
    assessAccountIdentityScopeV1(request(), deps(context(), hostileObservation)),
    /enumerable own data property/,
  );
  assert.equal(arrayGetterCalls, 0);
});

test('missing resolvers and malformed authority records fail closed', async () => {
  await assert.rejects(
    assessAccountIdentityScopeV1(request(), {}),
    /account-context resolver is required/,
  );
  await assert.rejects(
    assessAccountIdentityScopeV1(request(), {
      resolveTrustedAccountContext: async () => context(),
    }),
    /authenticated-identity resolver is required/,
  );

  await assert.rejects(
    assessAccountIdentityScopeV1(request(), deps(context({ relatedContextIds: ['context-google-work'] }), observation())),
    /cannot relate to itself/,
  );

  await assert.rejects(
    assessAccountIdentityScopeV1(
      request(),
      deps(context(), observation({ providerId: 'google-workspace ' })),
    ),
    /exact canonical identity/,
  );
});
