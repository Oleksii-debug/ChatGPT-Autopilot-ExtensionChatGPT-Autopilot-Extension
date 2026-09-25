import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SecretDataFlowStatus,
  assessSecretDataFlowV1,
} from '../src/core/secret-data-flow-guard.js';

const PROJECT = 'project-1';
const T0 = '2026-09-25T05:00:00.000Z';
const T1 = '2026-09-25T05:01:00.000Z';
const T2 = '2026-09-25T05:02:00.000Z';
const T3 = '2026-09-25T05:03:00.000Z';
const T4 = '2026-09-25T05:04:00.000Z';

const SHA_A1 = 'a'.repeat(64);
const SHA_A2 = 'd'.repeat(64);
const SHA_B1 = 'b'.repeat(64);
const SHA_C1 = 'c'.repeat(64);

function artifactRef({
  artifactId,
  sha256,
  sensitive = false,
  createdAt = T0,
  producerInvocationId = null,
} = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'data',
    uri: `artifact://flow/${artifactId}`,
    mediaType: 'application/json',
    sha256,
    sizeBytes: 64,
    createdAt,
    producerInvocationId,
    sensitive,
  };
}

function version({
  artifactId,
  versionId,
  parentVersionId = null,
  sha256,
  sensitive = false,
  inputArtifactIds = [],
  createdAt = T0,
  provenanceAt = createdAt,
  registeredAt = provenanceAt,
} = {}) {
  const ref = artifactRef({
    artifactId,
    sha256,
    sensitive,
    createdAt,
    producerInvocationId: inputArtifactIds.length ? `invocation-${versionId}` : null,
  });
  return {
    schemaVersion: 1,
    projectId: PROJECT,
    versionId,
    parentVersionId,
    artifactRef: ref,
    provenance: {
      schemaVersion: 1,
      projectId: PROJECT,
      artifactRef: { ...ref },
      sourceBindings: [],
      inputArtifactIds: [...inputArtifactIds],
      createdAt: provenanceAt,
    },
    registeredAt,
  };
}

function entry(artifactId, versions) {
  return {
    artifactId,
    currentVersionId: versions[versions.length - 1].versionId,
    versions,
  };
}

function registry(entries) {
  return {
    schemaVersion: 1,
    projectId: PROJECT,
    revision: entries.reduce((count, item) => count + item.versions.length, 0),
    artifacts: entries,
  };
}

function defaultRegistry({
  aSensitive = false,
  bSensitive = false,
  bInputs = ['artifact-a'],
} = {}) {
  const a1 = version({
    artifactId: 'artifact-a',
    versionId: 'version-a1',
    sha256: SHA_A1,
    sensitive: aSensitive,
    createdAt: T0,
  });
  const b1 = version({
    artifactId: 'artifact-b',
    versionId: 'version-b1',
    sha256: SHA_B1,
    sensitive: bSensitive,
    inputArtifactIds: bInputs,
    createdAt: T1,
  });
  return registry([
    entry('artifact-a', [a1]),
    entry('artifact-b', [b1]),
  ]);
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    flowId: 'flow-1',
    agentId: 'agent-1',
    jobId: 'job-1',
    projectId: PROJECT,
    registryRevision: 2,
    artifactBindings: [{
      artifactId: 'artifact-b',
      versionId: 'version-b1',
      sha256: SHA_B1,
    }],
    egresses: [{
      egressId: 'egress-1',
      artifactId: 'artifact-b',
      destinationOrigin: 'https://example.com',
      requestedAt: T2,
    }],
    assessedAt: T3,
    ...overrides,
  };
}

function assess(value = request(), artifactRegistry = defaultRegistry()) {
  return assessSecretDataFlowV1(value, { artifactRegistry });
}

test('canonical non-sensitive lineage is only ready for owner policy and never self-authorizes', () => {
  const result = assess();

  assert.equal(result.status, SecretDataFlowStatus.READY_FOR_POLICY);
  assert.equal(result.projectId, PROJECT);
  assert.equal(result.registryRevision, 2);
  assert.equal(result.lineageProvenance, 'CANONICAL_ARTIFACT_REGISTRY');
  assert.equal(result.lineageCompletenessVerified, true);
  assert.equal(result.exactInputVersionBindingVerified, false);
  assert.equal(result.inputVersionResolution, 'CONSERVATIVE_ALL_PLAUSIBLE_VERSIONS');
  assert.equal(result.requiresExactInputVersionBindingUpgrade, true);
  assert.equal(result.requiresCanonicalPolicyDecision, true);
  assert.equal(result.requiresIndependentSecretScan, true);
  assert.equal(result.declassificationAuthorized, false);
  assert.equal(result.credentialUseAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.artifactStates, [{
    artifactId: 'artifact-b',
    versionId: 'version-b1',
    sha256: SHA_B1,
    declaredSensitive: false,
    inheritedSensitive: false,
    effectiveSensitive: false,
    derived: true,
    registeredAt: T1,
  }]);
  assert.equal(result.egresses[0].policyDecisionRequired, true);
  assert.equal(result.egresses[0].independentSecretReviewRequired, false);
  assert.equal(result.egresses[0].executionAuthorized, false);
});

test('sensitive canonical input propagates into a correctly marked derived artifact', () => {
  const result = assess(
    request(),
    defaultRegistry({ aSensitive: true, bSensitive: true }),
  );

  assert.equal(result.status, SecretDataFlowStatus.REVIEW_REQUIRED);
  assert.deepEqual(result.violations, []);
  assert.equal(result.artifactStates[0].inheritedSensitive, true);
  assert.equal(result.artifactStates[0].effectiveSensitive, true);
  assert.equal(result.egresses[0].effectiveSensitive, true);
  assert.equal(result.egresses[0].independentSecretReviewRequired, true);
  assert.equal(result.executionAuthorized, false);
});

test('canonical provenance prevents caller omission from hiding sensitive ancestry', () => {
  const result = assess(
    request({
      artifactBindings: [{
        artifactId: 'artifact-b',
        versionId: 'version-b1',
        sha256: SHA_B1,
      }],
    }),
    defaultRegistry({ aSensitive: true, bSensitive: false }),
  );

  assert.equal(result.status, SecretDataFlowStatus.BLOCKED);
  assert.deepEqual(result.violations, [{
    code: 'SENSITIVE_DERIVATION_LAUNDERING',
    artifactId: 'artifact-b',
    versionId: 'version-b1',
  }]);
  assert.equal(result.artifactStates[0].declaredSensitive, false);
  assert.equal(result.artifactStates[0].inheritedSensitive, true);
  assert.equal(result.artifactStates[0].effectiveSensitive, true);
});

test('sensitivity propagates transitively through canonical registry ancestry', () => {
  const a1 = version({
    artifactId: 'artifact-a',
    versionId: 'version-a1',
    sha256: SHA_A1,
    sensitive: true,
    createdAt: T0,
  });
  const b1 = version({
    artifactId: 'artifact-b',
    versionId: 'version-b1',
    sha256: SHA_B1,
    sensitive: true,
    inputArtifactIds: ['artifact-a'],
    createdAt: T1,
  });
  const c1 = version({
    artifactId: 'artifact-c',
    versionId: 'version-c1',
    sha256: SHA_C1,
    sensitive: false,
    inputArtifactIds: ['artifact-b'],
    createdAt: T2,
  });
  const reg = registry([
    entry('artifact-a', [a1]),
    entry('artifact-b', [b1]),
    entry('artifact-c', [c1]),
  ]);

  const result = assessSecretDataFlowV1(request({
    registryRevision: 3,
    artifactBindings: [{
      artifactId: 'artifact-c',
      versionId: 'version-c1',
      sha256: SHA_C1,
    }],
    egresses: [],
  }), { artifactRegistry: reg });

  assert.equal(result.status, SecretDataFlowStatus.BLOCKED);
  assert.deepEqual(result.violations, [{
    code: 'SENSITIVE_DERIVATION_LAUNDERING',
    artifactId: 'artifact-c',
    versionId: 'version-c1',
  }]);
  assert.equal(result.artifactStates[0].effectiveSensitive, true);
  assert.equal(result.requiresCanonicalPolicyDecision, false);
});

test('artifact family cannot clear prior sensitivity through a later version', () => {
  const a1 = version({
    artifactId: 'artifact-a',
    versionId: 'version-a1',
    sha256: SHA_A1,
    sensitive: true,
    createdAt: T0,
  });
  const a2 = version({
    artifactId: 'artifact-a',
    versionId: 'version-a2',
    parentVersionId: 'version-a1',
    sha256: SHA_A2,
    sensitive: false,
    createdAt: T1,
  });
  const reg = registry([entry('artifact-a', [a1, a2])]);

  const result = assessSecretDataFlowV1(request({
    registryRevision: 2,
    artifactBindings: [{
      artifactId: 'artifact-a',
      versionId: 'version-a2',
      sha256: SHA_A2,
    }],
    egresses: [{
      egressId: 'egress-a',
      artifactId: 'artifact-a',
      destinationOrigin: 'https://example.com',
      requestedAt: T2,
    }],
  }), { artifactRegistry: reg });

  assert.equal(result.status, SecretDataFlowStatus.BLOCKED);
  assert.deepEqual(result.violations, [{
    code: 'SENSITIVE_VERSION_DOWNGRADE',
    artifactId: 'artifact-a',
    versionId: 'version-a2',
  }]);
  assert.equal(result.artifactStates[0].declaredSensitive, false);
  assert.equal(result.artifactStates[0].effectiveSensitive, true);
});

test('binding is exact to canonical project, registry revision, version identity and digest', () => {
  const reg = defaultRegistry();

  assert.throws(
    () => assessSecretDataFlowV1(request({ projectId: 'project-other' }), {
      artifactRegistry: reg,
    }),
    /projectId does not match/,
  );

  assert.throws(
    () => assessSecretDataFlowV1(request({ registryRevision: 1 }), {
      artifactRegistry: reg,
    }),
    /registryRevision is stale or mismatched/,
  );

  assert.throws(
    () => assessSecretDataFlowV1(request({
      artifactBindings: [{
        artifactId: 'artifact-b',
        versionId: 'version-a1',
        sha256: SHA_A1,
      }],
    }), { artifactRegistry: reg }),
    /version identity mismatch/,
  );

  assert.throws(
    () => assessSecretDataFlowV1(request({
      artifactBindings: [{
        artifactId: 'artifact-b',
        versionId: 'version-b1',
        sha256: 'f'.repeat(64),
      }],
    }), { artifactRegistry: reg }),
    /version digest mismatch/,
  );

  assert.throws(
    () => assessSecretDataFlowV1(request({
      artifactBindings: [{
        artifactId: 'artifact-b',
        versionId: 'version-missing',
        sha256: SHA_B1,
      }],
    }), { artifactRegistry: reg }),
    /version is unavailable/,
  );
});

test('canonical lineage fails closed on unknown dependency and cyclic provenance', () => {
  const unknown = defaultRegistry({ bInputs: ['artifact-missing'] });
  assert.throws(
    () => assess(request(), unknown),
    /references unknown artifact/,
  );

  const a1 = version({
    artifactId: 'artifact-a',
    versionId: 'version-a1',
    sha256: SHA_A1,
    inputArtifactIds: ['artifact-b'],
    createdAt: T0,
    provenanceAt: T1,
    registeredAt: T1,
  });
  const b1 = version({
    artifactId: 'artifact-b',
    versionId: 'version-b1',
    sha256: SHA_B1,
    inputArtifactIds: ['artifact-a'],
    createdAt: T0,
    provenanceAt: T1,
    registeredAt: T1,
  });
  const cyclic = registry([
    entry('artifact-a', [a1]),
    entry('artifact-b', [b1]),
  ]);

  assert.throws(
    () => assessSecretDataFlowV1(request({
      artifactBindings: [{
        artifactId: 'artifact-b',
        versionId: 'version-b1',
        sha256: SHA_B1,
      }],
      egresses: [],
      assessedAt: T2,
    }), { artifactRegistry: cyclic }),
    /provenance contains a cycle/,
  );
});

test('dependency must have a canonically admitted version before use', () => {
  const a1 = version({
    artifactId: 'artifact-a',
    versionId: 'version-a1',
    sha256: SHA_A1,
    createdAt: T1,
    provenanceAt: T1,
    registeredAt: T2,
  });
  const b1 = version({
    artifactId: 'artifact-b',
    versionId: 'version-b1',
    sha256: SHA_B1,
    inputArtifactIds: ['artifact-a'],
    createdAt: T1,
    provenanceAt: T1,
    registeredAt: T2,
  });
  const reg = registry([
    entry('artifact-a', [a1]),
    entry('artifact-b', [b1]),
  ]);

  assert.throws(
    () => assessSecretDataFlowV1(request({
      artifactBindings: [{
        artifactId: 'artifact-b',
        versionId: 'version-b1',
        sha256: SHA_B1,
      }],
      egresses: [],
      assessedAt: T3,
    }), { artifactRegistry: reg }),
    /no admitted version before dependency use/,
  );
});

test('egress must bind an admitted exact artifact and causal request time', () => {
  const reg = defaultRegistry();

  assert.throws(
    () => assessSecretDataFlowV1(request({
      egresses: [{
        egressId: 'egress-unbound',
        artifactId: 'artifact-a',
        destinationOrigin: 'https://example.com',
        requestedAt: T2,
      }],
    }), { artifactRegistry: reg }),
    /references an unbound artifact/,
  );

  assert.throws(
    () => assessSecretDataFlowV1(request({
      egresses: [{
        egressId: 'egress-early',
        artifactId: 'artifact-b',
        destinationOrigin: 'https://example.com',
        requestedAt: T0,
      }],
    }), { artifactRegistry: reg }),
    /predates canonical artifact admission/,
  );

  assert.throws(
    () => assessSecretDataFlowV1(request({
      egresses: [{
        egressId: 'egress-future',
        artifactId: 'artifact-b',
        destinationOrigin: 'https://example.com',
        requestedAt: T4,
      }],
    }), { artifactRegistry: reg }),
    /postdates assessment/,
  );
});

test('request and trusted options reject accessors without ordinary getter execution', () => {
  let reads = 0;
  const hostileRequest = request();
  Object.defineProperty(hostileRequest, 'egresses', {
    enumerable: true,
    get() {
      reads += 1;
      return [];
    },
  });
  assert.throws(
    () => assessSecretDataFlowV1(hostileRequest, {
      artifactRegistry: defaultRegistry(),
    }),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);

  const hostileOptions = {};
  Object.defineProperty(hostileOptions, 'artifactRegistry', {
    enumerable: true,
    get() {
      reads += 1;
      return defaultRegistry();
    },
  });
  assert.throws(
    () => assessSecretDataFlowV1(request(), hostileOptions),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);
});

test('arrays are dense descriptor snapshots and authority smuggling fails closed', () => {
  let reads = 0;
  const proxiedBindings = new Proxy(request().artifactBindings, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const result = assessSecretDataFlowV1(request({
    artifactBindings: proxiedBindings,
  }), { artifactRegistry: defaultRegistry() });
  assert.equal(result.status, SecretDataFlowStatus.READY_FOR_POLICY);
  assert.equal(reads, 0);

  const sparse = [];
  sparse.length = 2;
  sparse[1] = {
    artifactId: 'artifact-b',
    versionId: 'version-b1',
    sha256: SHA_B1,
  };
  assert.throws(
    () => assessSecretDataFlowV1(request({ artifactBindings: sparse }), {
      artifactRegistry: defaultRegistry(),
    }),
    /must not be sparse/,
  );

  assert.throws(
    () => assessSecretDataFlowV1(request({
      artifactBindings: [{
        artifactId: 'artifact-b',
        versionId: 'version-b1',
        sha256: SHA_B1,
        sensitive: false,
      }],
    }), { artifactRegistry: defaultRegistry() }),
    /unknown field: sensitive/,
  );

  const egress = request().egresses[0];
  Object.defineProperty(egress, 'executionAuthorized', {
    enumerable: false,
    value: true,
  });
  assert.throws(
    () => assessSecretDataFlowV1(request({ egresses: [egress] }), {
      artifactRegistry: defaultRegistry(),
    }),
    /unknown field: executionAuthorized/,
  );

  const symbolRequest = request();
  symbolRequest[Symbol('allow')] = true;
  assert.throws(
    () => assessSecretDataFlowV1(symbolRequest, {
      artifactRegistry: defaultRegistry(),
    }),
    /unknown field: Symbol\(allow\)/,
  );
});

test('null, omitted and coercive representations fail closed', () => {
  assert.throws(
    () => assessSecretDataFlowV1(request({ artifactBindings: null }), {
      artifactRegistry: defaultRegistry(),
    }),
    /bounded plain array/,
  );
  assert.throws(
    () => assessSecretDataFlowV1(request({ egresses: null }), {
      artifactRegistry: defaultRegistry(),
    }),
    /bounded plain array/,
  );

  const omitted = request();
  delete omitted.egresses;
  assert.throws(
    () => assessSecretDataFlowV1(omitted, {
      artifactRegistry: defaultRegistry(),
    }),
    /bounded plain array/,
  );

  assert.throws(
    () => assessSecretDataFlowV1(request({ registryRevision: -0 }), {
      artifactRegistry: defaultRegistry(),
    }),
    /safe integer/,
  );
  assert.throws(
    () => assessSecretDataFlowV1(request({ registryRevision: '2' }), {
      artifactRegistry: defaultRegistry(),
    }),
    /safe integer/,
  );
  assert.throws(
    () => assessSecretDataFlowV1(request({ assessedAt: '2026-09-25T05:03:00Z' }), {
      artifactRegistry: defaultRegistry(),
    }),
    /canonical ISO-8601 UTC/,
  );
  assert.throws(
    () => assessSecretDataFlowV1(request({
      egresses: [{
        ...request().egresses[0],
        destinationOrigin: 'https://example.com/',
      }],
    }), { artifactRegistry: defaultRegistry() }),
    /canonical HTTP\(S\) origin/,
  );
});

test('missing canonical registry fails closed and no caller graph field is accepted', () => {
  assert.throws(
    () => assessSecretDataFlowV1(request(), {}),
    /requires canonical artifactRegistry/,
  );

  assert.throws(
    () => assessSecretDataFlowV1({
      ...request(),
      transforms: [],
    }, { artifactRegistry: defaultRegistry() }),
    /unknown field: transforms/,
  );
});
