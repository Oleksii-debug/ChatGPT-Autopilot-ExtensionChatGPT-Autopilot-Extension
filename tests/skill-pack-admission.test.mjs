import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkillPackAdmissionV1 } from '../src/core/skill-pack-admission.js';

const T0 = '2026-09-25T08:00:00.000Z';
const T1 = '2026-09-25T08:01:00.000Z';
const T2 = '2026-09-25T08:02:00.000Z';
const T3 = '2026-09-25T08:03:00.000Z';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const E = 'e'.repeat(64);

function artifact(artifactId, sha256, kind = 'skill-artifact') {
  return {
    schemaVersion: 1,
    artifactId,
    kind,
    uri: `artifact://skill/${artifactId}`,
    mediaType: 'application/json',
    sha256,
    sizeBytes: 128,
    createdAt: T0,
    producerInvocationId: 'build-invocation',
    sensitive: false,
  };
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    skillPackId: 'skill.analytics',
    version: '1.2.3',
    displayName: 'Analytics Skill',
    description: 'Verified portable analytics procedure',
    artifactRefs: [
      artifact('source', A, 'skill-source'),
      artifact('entry', B, 'skill-entrypoint'),
      artifact('unused', C, 'skill-support'),
      artifact('signature', D, 'signature'),
    ],
    sourceArtifactId: 'source',
    entrypoints: [{
      entrypointId: 'run-report',
      kind: 'WORKFLOW',
      artifactId: 'entry',
      exportName: 'runReport',
      readOnly: false,
      requiredCapabilityIds: ['cap.analytics'],
      requiredPermissionIds: ['perm.project.read'],
    }],
    dependencies: [{
      skillPackId: 'skill.base',
      version: '2.0.0',
      sourceSha256: E,
    }],
    requiredCapabilityIds: ['cap.analytics', 'cap.artifact.read'],
    requiredPermissionIds: ['perm.project.read', 'perm.artifact.read'],
    evaluationRequirements: [{
      evaluationRequirementId: 'eval.requirement.analytics',
      suiteId: 'suite.analytics',
      suiteRevisionId: 'suite.analytics.r3',
      subjectSha256: A,
      requiredEvidenceKinds: ['benchmark-log', 'golden-output'],
    }],
    signatureRefs: [{
      signatureId: 'sig.analytics',
      scheme: 'ed25519',
      keyId: 'owner-key-1',
      signatureArtifactId: 'signature',
      signedSha256: A,
      trustState: 'UNVERIFIED_REFERENCE',
    }],
    publishedAt: T1,
    admissionAuthorized: false,
    executionAuthorized: false,
    trustAuthority: 'UNVERIFIED_REFERENCES',
    ...overrides,
  };
}

function deps(inputManifest = manifest(), hooks = {}) {
  const artifacts = new Map(inputManifest.artifactRefs.map(item => [item.artifactId, item]));
  const artifactCalls = [];
  return {
    artifactCalls,
    options: {
      resolveManifest: async query => hooks.resolveManifest
        ? hooks.resolveManifest(query)
        : structuredClone(inputManifest),
      resolveArtifact: async query => {
        artifactCalls.push(query.artifactId);
        return hooks.resolveArtifact
          ? hooks.resolveArtifact(query)
          : structuredClone(artifacts.get(query.artifactId));
      },
      resolveEvaluation: async query => hooks.resolveEvaluation
        ? hooks.resolveEvaluation(query)
        : ({
          evaluationRequirementId: query.evaluationRequirementId,
          evaluationId: 'evaluation.analytics.pass',
          suiteId: query.suiteId,
          suiteRevisionId: query.suiteRevisionId,
          subjectSha256: query.subjectSha256,
          status: 'PASS',
          completedAt: T2,
          evidenceKinds: ['golden-output', 'benchmark-log'],
          verificationAuthorityId: 'benchmark-authority',
        }),
      resolveSignature: async query => hooks.resolveSignature
        ? hooks.resolveSignature(query)
        : ({
          signatureId: query.signatureId,
          scheme: query.scheme,
          keyId: query.keyId,
          signatureArtifactId: query.signatureArtifactId,
          signedSha256: query.signedSha256,
          status: 'VERIFIED',
          verifiedAt: T2,
          verificationAuthorityId: 'signature-authority',
        }),
      resolveDependencyAdmission: async query => hooks.resolveDependencyAdmission
        ? hooks.resolveDependencyAdmission(query)
        : ({
          skillPackId: query.skillPackId,
          version: query.version,
          sourceSha256: query.sourceSha256,
          status: 'READY_FOR_POLICY',
          admissionId: 'skill-admission:dependency',
          admittedAt: T2,
        }),
    },
  };
}

test('produces deterministic non-authorizing READY_FOR_POLICY admission with minimal on-demand artifacts', async () => {
  const m = manifest();
  const runtime = deps(m);
  const first = await createSkillPackAdmissionV1({
    manifest: m,
    entrypointId: 'run-report',
    admittedAt: T3,
  }, runtime.options);
  const secondRuntime = deps(m);
  const second = await createSkillPackAdmissionV1({
    manifest: structuredClone(m),
    entrypointId: 'run-report',
    admittedAt: T3,
  }, secondRuntime.options);

  assert.deepEqual(second, first);
  assert.equal(first.status, 'READY_FOR_POLICY');
  assert.match(first.admissionId, /^skill-admission:[a-f0-9]{64}$/u);
  assert.equal(first.executionAuthorized, false);
  assert.equal(first.artifactReadAuthorized, false);
  assert.equal(first.policyDecisionGranted, false);
  assert.equal(first.requiresCanonicalPolicyDecision, true);
  assert.equal(first.requiresCanonicalExecutionPlane, true);
  assert.deepEqual(first.loadArtifactRefs.map(item => item.artifactId), ['source', 'entry']);
  assert.deepEqual(runtime.artifactCalls, ['source', 'entry']);
  assert.equal(runtime.artifactCalls.includes('unused'), false);
  assert.equal(runtime.artifactCalls.includes('signature'), false);
  assert.deepEqual(first.requiredCapabilityIds, ['cap.analytics', 'cap.artifact.read']);
  assert.deepEqual(first.requiredPermissionIds, ['perm.artifact.read', 'perm.project.read']);
});

test('fails closed when caller manifest diverges from trusted manifest revision', async () => {
  const caller = manifest({ displayName: 'Forged name' });
  const trusted = manifest();
  const runtime = deps(caller, { resolveManifest: async () => structuredClone(trusted) });
  await assert.rejects(
    createSkillPackAdmissionV1({ manifest: caller, entrypointId: 'run-report', admittedAt: T3 }, runtime.options),
    /trusted manifest revision/u,
  );
});

test('fails closed on entrypoint material drift and never resolves unrelated artifacts', async () => {
  const m = manifest();
  const runtime = deps(m, {
    resolveArtifact: async query => {
      const expected = m.artifactRefs.find(item => item.artifactId === query.artifactId);
      if (query.artifactId === 'entry') return { ...expected, sha256: C };
      return structuredClone(expected);
    },
  });
  await assert.rejects(
    createSkillPackAdmissionV1({ manifest: m, entrypointId: 'run-report', admittedAt: T3 }, runtime.options),
    /materialized ArtifactRef/u,
  );
  assert.deepEqual(runtime.artifactCalls, ['source', 'entry']);
});

test('requires trusted PASS evaluation with exact suite subject and evidence kinds', async () => {
  const m = manifest();
  for (const proof of [
    { status: 'FAIL' },
    { subjectSha256: B },
    { suiteRevisionId: 'suite.analytics.stale' },
    { evidenceKinds: ['benchmark-log'] },
  ]) {
    const runtime = deps(m, {
      resolveEvaluation: async query => ({
        evaluationRequirementId: query.evaluationRequirementId,
        evaluationId: 'evaluation.analytics',
        suiteId: query.suiteId,
        suiteRevisionId: query.suiteRevisionId,
        subjectSha256: query.subjectSha256,
        status: 'PASS',
        completedAt: T2,
        evidenceKinds: ['benchmark-log', 'golden-output'],
        verificationAuthorityId: 'benchmark-authority',
        ...proof,
      }),
    });
    await assert.rejects(
      createSkillPackAdmissionV1({ manifest: m, entrypointId: 'run-report', admittedAt: T3 }, runtime.options),
    );
  }
});

test('requires exact VERIFIED signature including signature artifact binding', async () => {
  const m = manifest();
  for (const proof of [
    { status: 'UNVERIFIED' },
    { signedSha256: B },
    { signatureArtifactId: 'unused' },
    { keyId: 'different-key' },
  ]) {
    const runtime = deps(m, {
      resolveSignature: async query => ({
        signatureId: query.signatureId,
        scheme: query.scheme,
        keyId: query.keyId,
        signatureArtifactId: query.signatureArtifactId,
        signedSha256: query.signedSha256,
        status: 'VERIFIED',
        verifiedAt: T2,
        verificationAuthorityId: 'signature-authority',
        ...proof,
      }),
    });
    await assert.rejects(
      createSkillPackAdmissionV1({ manifest: m, entrypointId: 'run-report', admittedAt: T3 }, runtime.options),
    );
  }
});

test('requires exact dependency admission and rejects future dependency proof', async () => {
  const m = manifest();
  for (const proof of [
    { status: 'BLOCKED' },
    { sourceSha256: A },
    { version: '2.0.1' },
    { admittedAt: '2026-09-25T08:04:00.000Z' },
  ]) {
    const runtime = deps(m, {
      resolveDependencyAdmission: async query => ({
        skillPackId: query.skillPackId,
        version: query.version,
        sourceSha256: query.sourceSha256,
        status: 'READY_FOR_POLICY',
        admissionId: 'skill-admission:dependency',
        admittedAt: T2,
        ...proof,
      }),
    });
    await assert.rejects(
      createSkillPackAdmissionV1({ manifest: m, entrypointId: 'run-report', admittedAt: T3 }, runtime.options),
    );
  }
});

test('runtime admission requires at least one evaluation and one signature', async () => {
  for (const m of [
    manifest({ evaluationRequirements: [] }),
    manifest({ signatureRefs: [] }),
  ]) {
    const runtime = deps(m);
    await assert.rejects(
      createSkillPackAdmissionV1({ manifest: m, entrypointId: 'run-report', admittedAt: T3 }, runtime.options),
      /requires at least one trusted/u,
    );
  }
});

test('proof time cannot predate source or postdate admission', async () => {
  const m = manifest();
  for (const time of ['2026-09-25T07:59:00.000Z', '2026-09-25T08:04:00.000Z']) {
    const evalRuntime = deps(m, {
      resolveEvaluation: async query => ({
        evaluationRequirementId: query.evaluationRequirementId,
        evaluationId: 'evaluation.time',
        suiteId: query.suiteId,
        suiteRevisionId: query.suiteRevisionId,
        subjectSha256: query.subjectSha256,
        status: 'PASS',
        completedAt: time,
        evidenceKinds: ['benchmark-log', 'golden-output'],
        verificationAuthorityId: 'benchmark-authority',
      }),
    });
    await assert.rejects(
      createSkillPackAdmissionV1({ manifest: m, entrypointId: 'run-report', admittedAt: T3 }, evalRuntime.options),
      /time boundary/u,
    );
  }
});

test('dependency container rejects accessor authority without executing getter', async () => {
  const m = manifest();
  let getterCalls = 0;
  const runtime = deps(m);
  const hostile = { ...runtime.options };
  Object.defineProperty(hostile, 'resolveSignature', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return runtime.options.resolveSignature;
    },
  });
  await assert.rejects(
    createSkillPackAdmissionV1({ manifest: m, entrypointId: 'run-report', admittedAt: T3 }, hostile),
    /enumerable own data property/u,
  );
  assert.equal(getterCalls, 0);
});

test('unknown entrypoint fails before evaluation/signature/dependency resolution', async () => {
  const m = manifest();
  let expensiveCalls = 0;
  const runtime = deps(m, {
    resolveEvaluation: async () => { expensiveCalls += 1; throw new Error('should not run'); },
    resolveSignature: async () => { expensiveCalls += 1; throw new Error('should not run'); },
    resolveDependencyAdmission: async () => { expensiveCalls += 1; throw new Error('should not run'); },
  });
  await assert.rejects(
    createSkillPackAdmissionV1({ manifest: m, entrypointId: 'missing', admittedAt: T3 }, runtime.options),
    /entrypoint not found/u,
  );
  assert.equal(expensiveCalls, 0);
});
