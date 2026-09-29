import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ShadowExecutionMode,
  createShadowExecutionV1,
} from '../src/core/shadow-execution.js';

const CREATED = '2026-09-25T06:50:00.000Z';
const RECORDED = '2026-09-25T06:50:01.000Z';

function invocation(overrides = {}) {
  return {
    schemaVersion: 1,
    invocationId: 'invoke-shadow-1',
    toolId: 'github.update-file',
    providerId: 'github',
    requestedCapabilityIds: ['repo.write'],
    policyDecisionId: 'shadow-policy-assertion-1',
    arguments: {
      repository: 'owner/repo',
      path: 'README.md',
      content: 'public content',
    },
    createdAt: CREATED,
    parentInvocationId: null,
    ...overrides,
  };
}

function shadow(overrides = {}) {
  return {
    schemaVersion: 1,
    shadowRunId: 'shadow-run-1',
    projectId: 'autopilot',
    subjectRevisionId: 'main:7d2f7895',
    invocation: invocation(),
    predictedEffect: {
      effectClass: 'repository.mutation',
      summary: 'Would update one repository file.',
      targetResourceIds: ['repo:owner/repo:README.md'],
      expectedChangeSummary: 'README bytes would change.',
      reversible: true,
      compensatingActionRequired: true,
    },
    verificationPlan: {
      verifierId: 'verifier-independent-1',
      successCondition: 'Observed repository file bytes match the proposed result.',
      requiredEvidenceKinds: ['repository.readback'],
      independent: true,
    },
    recordedAt: RECORDED,
    ...overrides,
  };
}

test('ShadowExecutionV1 is immutable, non-authorizing, and stores no invocation argument bytes', async () => {
  const secret = 'TOP-SECRET-DO-NOT-PERSIST';
  const value = await createShadowExecutionV1(shadow({
    invocation: invocation({
      arguments: {
        repository: 'owner/repo',
        tokenLikeValue: secret,
      },
    }),
  }));

  assert.equal(value.mode, ShadowExecutionMode.SHADOW);
  assert.equal(value.executionAuthorized, false);
  assert.equal(value.providerCallAuthorized, false);
  assert.equal(value.externalEffectAuthorized, false);
  assert.equal(value.replayAuthorized, false);
  assert.equal(value.authorityUpgradeAuthorized, false);
  assert.equal(value.policyDecisionVerified, false);
  assert.equal(value.policyDecisionAuthority, 'UNVERIFIED_INPUT');
  assert.equal(value.requiresFreshWorldState, true);
  assert.equal(value.requiresCanonicalPolicyAtExecution, true);
  assert.equal(value.requiresIndependentVerificationAtExecution, true);
  assert.match(value.invocationIdentityFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(value.argumentsRetained, false);
  assert.equal(value.argumentDerivedFingerprintRetained, false);
  assert.equal(value.requiresProposalArgumentsAtExecution, true);
  assert.equal(Object.hasOwn(value.proposedInvocation, 'arguments'), false);
  assert.equal(JSON.stringify(value).includes(secret), false);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.predictedEffect), true);
  assert.equal(Object.isFrozen(value.verificationPlan), true);
});

test('private proposal arguments neither persist nor influence a durable fingerprint', async () => {
  const first = await createShadowExecutionV1(shadow({
    invocation: invocation({ arguments: { target: 'A', secret: 'SECRET_ALPHA_4bd27f' } }),
  }));
  const second = await createShadowExecutionV1(shadow({
    invocation: invocation({ arguments: { target: 'A', secret: 'SECRET_BETA_93ac51' } }),
  }));
  assert.equal(first.invocationIdentityFingerprint, second.invocationIdentityFingerprint);
  assert.equal(first.argumentDerivedFingerprintRetained, false);
  assert.equal(second.argumentDerivedFingerprintRetained, false);
  assert.equal(JSON.stringify(first).includes('SECRET_ALPHA_4bd27f'), false);
  assert.equal(JSON.stringify(second).includes('SECRET_BETA_93ac51'), false);

  const differentIdentity = await createShadowExecutionV1(shadow({
    invocation: invocation({ invocationId: 'invoke-shadow-2', arguments: { secret: 'SECRET_ALPHA_4bd27f' } }),
  }));
  assert.notEqual(first.invocationIdentityFingerprint, differentIdentity.invocationIdentityFingerprint);
});

test('capability-set permutations produce one stable public identity fingerprint', async () => {
  const first = await createShadowExecutionV1(shadow({
    invocation: invocation({ requestedCapabilityIds: ['repo.write', 'repo.read'] }),
  }));
  const second = await createShadowExecutionV1(shadow({
    invocation: invocation({ requestedCapabilityIds: ['repo.read', 'repo.write'] }),
  }));
  assert.deepEqual(first.proposedInvocation.requestedCapabilityIds, ['repo.read', 'repo.write']);
  assert.deepEqual(second.proposedInvocation.requestedCapabilityIds, ['repo.read', 'repo.write']);
  assert.equal(first.invocationIdentityFingerprint, second.invocationIdentityFingerprint);
});

test('shadow identities and timestamps require exact representation and causal time', async () => {
  await assert.rejects(
    createShadowExecutionV1(shadow({ shadowRunId: ' shadow-run-1' })),
    /exact id/,
  );
  await assert.rejects(
    createShadowExecutionV1(shadow({ recordedAt: '2026-09-25T06:50:01Z' })),
    /canonical ISO-8601 UTC/,
  );
  await assert.rejects(
    createShadowExecutionV1(shadow({ recordedAt: '2026-09-25T06:49:59.000Z' })),
    /cannot predate/,
  );
  await assert.rejects(
    createShadowExecutionV1(shadow({
      invocation: invocation({ invocationId: ' invoke-shadow-1' }),
    })),
    /exact canonical identity/,
  );
  await assert.rejects(
    createShadowExecutionV1(shadow({
      invocation: invocation({ createdAt: '2026-09-25T06:50:00Z' }),
    })),
    /exact canonical identity and timestamp/,
  );
});

test('predicted effect and verifier plan are bounded data, deduplicated, and independently verified', async () => {
  await assert.rejects(
    createShadowExecutionV1(shadow({
      predictedEffect: {
        ...shadow().predictedEffect,
        targetResourceIds: ['repo:a', 'repo:a'],
      },
    })),
    /duplicates/,
  );
  await assert.rejects(
    createShadowExecutionV1(shadow({
      verificationPlan: {
        ...shadow().verificationPlan,
        requiredEvidenceKinds: ['readback', 'readback'],
      },
    })),
    /duplicates/,
  );
  await assert.rejects(
    createShadowExecutionV1(shadow({
      verificationPlan: {
        ...shadow().verificationPlan,
        independent: false,
      },
    })),
    /independent verifier/,
  );
});

test('caller accessors, hidden/symbol fields, exotic records and unknown authority fields fail closed', async () => {
  let reads = 0;
  const withGetter = shadow();
  Object.defineProperty(withGetter, 'projectId', {
    enumerable: true,
    get() {
      reads += 1;
      return 'autopilot';
    },
  });
  await assert.rejects(createShadowExecutionV1(withGetter), /enumerable own data property/);
  assert.equal(reads, 0);

  const hidden = shadow();
  Object.defineProperty(hidden, 'executeNow', { value: true, enumerable: false });
  await assert.rejects(createShadowExecutionV1(hidden), /enumerable own data property/);

  const symbolic = shadow();
  symbolic[Symbol('authority')] = 'ALLOW';
  await assert.rejects(createShadowExecutionV1(symbolic), /symbol field/);

  const exotic = Object.assign(Object.create({ executionAuthorized: true }), shadow());
  await assert.rejects(createShadowExecutionV1(exotic), /plain data object/);

  await assert.rejects(
    createShadowExecutionV1({ ...shadow(), executionAuthorized: true }),
    /unknown field/,
  );
});

test('authority-bearing arrays use descriptor snapshots without ordinary caller reads', async () => {
  let reads = 0;
  const targets = new Proxy(['repo:a', 'repo:b'], {
    get(target, key, receiver) {
      if (key === 'length' || key === '0' || key === '1') reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const value = await createShadowExecutionV1(shadow({
    predictedEffect: {
      ...shadow().predictedEffect,
      targetResourceIds: targets,
    },
  }));
  assert.deepEqual(value.predictedEffect.targetResourceIds, ['repo:a', 'repo:b']);
  assert.equal(reads, 0);

  const sparse = new Array(2);
  sparse[0] = 'repo:a';
  await assert.rejects(
    createShadowExecutionV1(shadow({
      predictedEffect: { ...shadow().predictedEffect, targetResourceIds: sparse },
    })),
    /dense data-only array/,
  );

  const custom = ['repo:a'];
  custom.extra = 'authority';
  await assert.rejects(
    createShadowExecutionV1(shadow({
      predictedEffect: { ...shadow().predictedEffect, targetResourceIds: custom },
    })),
    /non-index field/,
  );

  const symbolic = ['repo:a'];
  symbolic[Symbol('authority')] = 'ALLOW';
  await assert.rejects(
    createShadowExecutionV1(shadow({
      predictedEffect: { ...shadow().predictedEffect, targetResourceIds: symbolic },
    })),
    /non-index field/,
  );
});

test('public shadow fingerprinting ignores caller-supplied crypto authority', async () => {
  let optionReads = 0;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, 'cryptoApi', {
    enumerable: true,
    get() {
      optionReads += 1;
      throw new Error('caller crypto getter must not execute');
    },
  });

  const first = await createShadowExecutionV1(shadow({
    invocation: invocation({ invocationId: 'invoke-shadow-runtime-hash-a' }),
  }), accessorOptions);
  assert.equal(optionReads, 0);

  const fixedDigestOptions = {
    cryptoApi: {
      subtle: {
        async digest() {
          return new Uint8Array(32);
        },
      },
    },
  };
  const second = await createShadowExecutionV1(shadow({
    invocation: invocation({ invocationId: 'invoke-shadow-runtime-hash-b' }),
  }), fixedDigestOptions);

  assert.notEqual(first.invocationIdentityFingerprint, second.invocationIdentityFingerprint);
  assert.match(first.invocationIdentityFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.match(second.invocationIdentityFingerprint, /^sha256:[a-f0-9]{64}$/u);
});

test('canonical proposal policy identity is comparison-only and never upgrades shadow authority', async () => {
  const value = await createShadowExecutionV1(shadow({
    invocation: invocation({ policyDecisionId: 'policy-allow-looking-id' }),
  }));
  assert.equal(value.proposedInvocation.policyDecisionId, 'policy-allow-looking-id');
  assert.equal(value.policyDecisionAuthority, 'UNVERIFIED_INPUT');
  assert.equal(value.policyDecisionVerified, false);
  assert.equal(value.executionAuthorized, false);
  assert.equal(value.externalEffectAuthorized, false);
});
