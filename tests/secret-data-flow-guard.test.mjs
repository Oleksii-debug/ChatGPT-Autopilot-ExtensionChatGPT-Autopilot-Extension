import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SecretDataFlowStatus,
  assessSecretDataFlowV1,
} from '../src/core/secret-data-flow-guard.js';

const T0 = '2026-09-25T05:00:00.000Z';
const T1 = '2026-09-25T05:01:00.000Z';
const T2 = '2026-09-25T05:02:00.000Z';
const T3 = '2026-09-25T05:03:00.000Z';
const T4 = '2026-09-25T05:04:00.000Z';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function artifact({
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

function artifactMap(overrides = {}) {
  return new Map([
    ['artifact-a', artifact({
      artifactId: 'artifact-a',
      sha256: SHA_A,
      createdAt: T0,
      sensitive: false,
    })],
    ['artifact-b', artifact({
      artifactId: 'artifact-b',
      sha256: SHA_B,
      createdAt: T1,
      producerInvocationId: 'invocation-transform-1',
      sensitive: false,
    })],
    ['artifact-c', artifact({
      artifactId: 'artifact-c',
      sha256: SHA_C,
      createdAt: T2,
      producerInvocationId: 'invocation-transform-2',
      sensitive: false,
    })],
    ...Object.entries(overrides),
  ]);
}

function resolverFrom(map) {
  return artifactId => map.get(artifactId) ?? null;
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    flowId: 'flow-1',
    agentId: 'agent-1',
    jobId: 'job-1',
    artifactBindings: [
      { artifactId: 'artifact-a', sha256: SHA_A },
      { artifactId: 'artifact-b', sha256: SHA_B },
    ],
    transforms: [{
      transformId: 'transform-1',
      inputArtifactIds: ['artifact-a'],
      outputArtifactId: 'artifact-b',
      completedAt: T1,
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

test('non-sensitive derivation is only ready for canonical policy and never self-authorizes', () => {
  const result = assessSecretDataFlowV1(request(), {
    resolveArtifactRef: resolverFrom(artifactMap()),
  });

  assert.equal(result.status, SecretDataFlowStatus.READY_FOR_POLICY);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.credentialUseAuthorized, false);
  assert.equal(result.declassificationAuthorized, false);
  assert.equal(result.requiresCanonicalArtifactResolution, true);
  assert.equal(result.requiresCanonicalLineageResolution, true);
  assert.equal(result.requiresCanonicalPolicyDecision, true);
  assert.equal(result.requiresIndependentSecretScan, true);
  assert.equal(result.lineageProvenance, 'UNVERIFIED_INPUT');
  assert.equal(result.lineageCompletenessVerified, false);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(
    result.artifactStates.map(item => [item.artifactId, item.effectiveSensitive]),
    [['artifact-a', false], ['artifact-b', false]],
  );
  assert.equal(result.egresses[0].policyDecisionRequired, true);
  assert.equal(result.egresses[0].independentSecretReviewRequired, false);
  assert.equal(result.egresses[0].executionAuthorized, false);
});

test('sensitive lineage stays sensitive and sensitive egress requires independent review', () => {
  const map = artifactMap({
    'artifact-a': artifact({
      artifactId: 'artifact-a',
      sha256: SHA_A,
      sensitive: true,
      createdAt: T0,
    }),
    'artifact-b': artifact({
      artifactId: 'artifact-b',
      sha256: SHA_B,
      sensitive: true,
      createdAt: T1,
      producerInvocationId: 'invocation-transform-1',
    }),
  });

  const result = assessSecretDataFlowV1(request(), {
    resolveArtifactRef: resolverFrom(map),
  });

  assert.equal(result.status, SecretDataFlowStatus.REVIEW_REQUIRED);
  assert.deepEqual(result.violations, []);
  assert.equal(result.artifactStates.find(item => item.artifactId === 'artifact-b').effectiveSensitive, true);
  assert.equal(result.egresses[0].effectiveSensitive, true);
  assert.equal(result.egresses[0].independentSecretReviewRequired, true);
  assert.equal(result.executionAuthorized, false);
});

test('derived artifact cannot launder sensitive ancestry by declaring sensitive=false', () => {
  const map = artifactMap({
    'artifact-a': artifact({
      artifactId: 'artifact-a',
      sha256: SHA_A,
      sensitive: true,
      createdAt: T0,
    }),
  });

  const result = assessSecretDataFlowV1(request(), {
    resolveArtifactRef: resolverFrom(map),
  });

  assert.equal(result.status, SecretDataFlowStatus.BLOCKED);
  assert.deepEqual(result.violations, [{
    code: 'SENSITIVE_DERIVATION_LAUNDERING',
    artifactId: 'artifact-b',
  }]);
  assert.equal(result.artifactStates.find(item => item.artifactId === 'artifact-b').declaredSensitive, false);
  assert.equal(result.artifactStates.find(item => item.artifactId === 'artifact-b').effectiveSensitive, true);
});

test('sensitivity propagates transitively across multiple derivations', () => {
  const map = artifactMap({
    'artifact-a': artifact({
      artifactId: 'artifact-a',
      sha256: SHA_A,
      sensitive: true,
      createdAt: T0,
    }),
    'artifact-b': artifact({
      artifactId: 'artifact-b',
      sha256: SHA_B,
      sensitive: true,
      createdAt: T1,
      producerInvocationId: 'invocation-transform-1',
    }),
  });

  const result = assessSecretDataFlowV1(request({
    artifactBindings: [
      { artifactId: 'artifact-a', sha256: SHA_A },
      { artifactId: 'artifact-b', sha256: SHA_B },
      { artifactId: 'artifact-c', sha256: SHA_C },
    ],
    transforms: [
      {
        transformId: 'transform-1',
        inputArtifactIds: ['artifact-a'],
        outputArtifactId: 'artifact-b',
        completedAt: T1,
      },
      {
        transformId: 'transform-2',
        inputArtifactIds: ['artifact-b'],
        outputArtifactId: 'artifact-c',
        completedAt: T2,
      },
    ],
    egresses: [],
  }), {
    resolveArtifactRef: resolverFrom(map),
  });

  assert.equal(result.status, SecretDataFlowStatus.BLOCKED);
  assert.deepEqual(result.violations, [{
    code: 'SENSITIVE_DERIVATION_LAUNDERING',
    artifactId: 'artifact-c',
  }]);
  assert.equal(result.requiresCanonicalPolicyDecision, false);
});

test('caller binding must match trusted resolver artifact identity and exact digest', () => {
  const map = artifactMap();

  assert.throws(
    () => assessSecretDataFlowV1(request({
      artifactBindings: [
        { artifactId: 'artifact-a', sha256: 'd'.repeat(64) },
        { artifactId: 'artifact-b', sha256: SHA_B },
      ],
    }), { resolveArtifactRef: resolverFrom(map) }),
    /digest mismatch/,
  );

  const wrongIdentity = new Map(map);
  wrongIdentity.set('artifact-a', artifact({
    artifactId: 'artifact-other',
    sha256: SHA_A,
    createdAt: T0,
  }));
  assert.throws(
    () => assessSecretDataFlowV1(request(), {
      resolveArtifactRef: resolverFrom(wrongIdentity),
    }),
    /identity mismatch/,
  );

  const missing = new Map(map);
  missing.delete('artifact-a');
  assert.throws(
    () => assessSecretDataFlowV1(request(), {
      resolveArtifactRef: resolverFrom(missing),
    }),
    /Canonical artifact is unavailable/,
  );
});

test('caller cannot supply ArtifactRef authority in artifact bindings', () => {
  assert.throws(
    () => assessSecretDataFlowV1(request({
      artifactBindings: [{
        artifactId: 'artifact-a',
        sha256: SHA_A,
        sensitive: false,
      }],
      transforms: [],
      egresses: [],
    }), {
      resolveArtifactRef: resolverFrom(artifactMap()),
    }),
    /unknown field: sensitive/,
  );
});

test('resolver artifact representation is exact and accessors execute zero times', () => {
  let reads = 0;
  const hostile = artifact({
    artifactId: 'artifact-a',
    sha256: SHA_A,
    createdAt: T0,
  });
  Object.defineProperty(hostile, 'sensitive', {
    enumerable: true,
    get() {
      reads += 1;
      return false;
    },
  });

  const map = artifactMap({ 'artifact-a': hostile });
  assert.throws(
    () => assessSecretDataFlowV1(request(), {
      resolveArtifactRef: resolverFrom(map),
    }),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);

  const upper = artifact({
    artifactId: 'artifact-a',
    sha256: SHA_A.toUpperCase(),
    createdAt: T0,
  });
  const upperMap = artifactMap({ 'artifact-a': upper });
  assert.throws(
    () => assessSecretDataFlowV1(request(), {
      resolveArtifactRef: resolverFrom(upperMap),
    }),
    /lowercase SHA-256/,
  );

  const aliasTime = artifact({
    artifactId: 'artifact-a',
    sha256: SHA_A,
    createdAt: '2026-09-25T05:00:00Z',
  });
  const aliasMap = artifactMap({ 'artifact-a': aliasTime });
  assert.throws(
    () => assessSecretDataFlowV1(request(), {
      resolveArtifactRef: resolverFrom(aliasMap),
    }),
    /canonical ISO-8601 UTC/,
  );

  const negativeZero = artifact({
    artifactId: 'artifact-a',
    sha256: SHA_A,
    createdAt: T0,
  });
  negativeZero.sizeBytes = -0;
  const zeroMap = artifactMap({ 'artifact-a': negativeZero });
  assert.throws(
    () => assessSecretDataFlowV1(request(), {
      resolveArtifactRef: resolverFrom(zeroMap),
    }),
    /safe integer/,
  );
});

test('artifact lineage rejects dangling references, duplicate producers and cycles', () => {
  const map = artifactMap();

  assert.throws(
    () => assessSecretDataFlowV1(request({
      transforms: [{
        transformId: 'transform-dangling',
        inputArtifactIds: ['artifact-missing'],
        outputArtifactId: 'artifact-b',
        completedAt: T1,
      }],
    }), { resolveArtifactRef: resolverFrom(map) }),
    /unknown input artifact/,
  );

  assert.throws(
    () => assessSecretDataFlowV1(request({
      transforms: [
        {
          transformId: 'transform-1',
          inputArtifactIds: ['artifact-a'],
          outputArtifactId: 'artifact-b',
          completedAt: T1,
        },
        {
          transformId: 'transform-2',
          inputArtifactIds: ['artifact-a'],
          outputArtifactId: 'artifact-b',
          completedAt: T2,
        },
      ],
    }), { resolveArtifactRef: resolverFrom(map) }),
    /duplicate outputArtifactId/,
  );

  const cycleMap = new Map([
    ['artifact-a', artifact({
      artifactId: 'artifact-a',
      sha256: SHA_A,
      createdAt: T0,
    })],
    ['artifact-b', artifact({
      artifactId: 'artifact-b',
      sha256: SHA_B,
      createdAt: T0,
    })],
  ]);
  assert.throws(
    () => assessSecretDataFlowV1(request({
      transforms: [
        {
          transformId: 'transform-a-to-b',
          inputArtifactIds: ['artifact-a'],
          outputArtifactId: 'artifact-b',
          completedAt: T1,
        },
        {
          transformId: 'transform-b-to-a',
          inputArtifactIds: ['artifact-b'],
          outputArtifactId: 'artifact-a',
          completedAt: T1,
        },
      ],
      egresses: [],
    }), { resolveArtifactRef: resolverFrom(cycleMap) }),
    /acyclic artifact graph/,
  );
});

test('lineage and egress chronology fail closed', () => {
  const futureOutput = artifactMap({
    'artifact-b': artifact({
      artifactId: 'artifact-b',
      sha256: SHA_B,
      createdAt: T4,
      producerInvocationId: 'invocation-transform-1',
    }),
  });
  assert.throws(
    () => assessSecretDataFlowV1(request(), {
      resolveArtifactRef: resolverFrom(futureOutput),
    }),
    /postdates assessment/,
  );

  const outputBeforeInput = artifactMap({
    'artifact-a': artifact({
      artifactId: 'artifact-a',
      sha256: SHA_A,
      createdAt: T1,
    }),
    'artifact-b': artifact({
      artifactId: 'artifact-b',
      sha256: SHA_B,
      createdAt: T0,
      producerInvocationId: 'invocation-transform-1',
    }),
  });
  assert.throws(
    () => assessSecretDataFlowV1(request({
      transforms: [{
        transformId: 'transform-1',
        inputArtifactIds: ['artifact-a'],
        outputArtifactId: 'artifact-b',
        completedAt: T1,
      }],
    }), { resolveArtifactRef: resolverFrom(outputBeforeInput) }),
    /output predates an input artifact/,
  );

  assert.throws(
    () => assessSecretDataFlowV1(request({
      transforms: [{
        transformId: 'transform-1',
        inputArtifactIds: ['artifact-a'],
        outputArtifactId: 'artifact-b',
        completedAt: T0,
      }],
    }), { resolveArtifactRef: resolverFrom(artifactMap()) }),
    /completes before output materialization/,
  );

  assert.throws(
    () => assessSecretDataFlowV1(request({
      egresses: [{
        egressId: 'egress-1',
        artifactId: 'artifact-b',
        destinationOrigin: 'https://example.com',
        requestedAt: T0,
      }],
    }), { resolveArtifactRef: resolverFrom(artifactMap()) }),
    /predates artifact materialization/,
  );
});

test('authority envelopes reject getters, hidden fields, symbols and sparse arrays without ordinary getter reads', () => {
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
      resolveArtifactRef: resolverFrom(artifactMap()),
    }),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);

  const proxiedBindings = new Proxy(request().artifactBindings, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const result = assessSecretDataFlowV1(request({
    artifactBindings: proxiedBindings,
  }), {
    resolveArtifactRef: resolverFrom(artifactMap()),
  });
  assert.equal(result.status, SecretDataFlowStatus.READY_FOR_POLICY);
  assert.equal(reads, 0);

  const hiddenTransform = request().transforms[0];
  Object.defineProperty(hiddenTransform, 'executionAuthorized', {
    enumerable: false,
    value: true,
  });
  assert.throws(
    () => assessSecretDataFlowV1(request({
      transforms: [hiddenTransform],
    }), { resolveArtifactRef: resolverFrom(artifactMap()) }),
    /unknown field: executionAuthorized/,
  );

  const symbolEgress = request().egresses[0];
  symbolEgress[Symbol('allow')] = true;
  assert.throws(
    () => assessSecretDataFlowV1(request({
      egresses: [symbolEgress],
    }), { resolveArtifactRef: resolverFrom(artifactMap()) }),
    /unknown field: Symbol\(allow\)/,
  );

  const sparse = [];
  sparse.length = 2;
  sparse[1] = { artifactId: 'artifact-a', sha256: SHA_A };
  assert.throws(
    () => assessSecretDataFlowV1(request({
      artifactBindings: sparse,
      transforms: [],
      egresses: [],
    }), { resolveArtifactRef: resolverFrom(artifactMap()) }),
    /must not be sparse/,
  );
});

test('exact IDs, timestamps, origins and synchronous resolver representation are required', () => {
  assert.throws(
    () => assessSecretDataFlowV1(request({ flowId: ' flow-1' }), {
      resolveArtifactRef: resolverFrom(artifactMap()),
    }),
    /flowId is invalid/,
  );

  assert.throws(
    () => assessSecretDataFlowV1(request({ assessedAt: '2026-09-25T05:03:00Z' }), {
      resolveArtifactRef: resolverFrom(artifactMap()),
    }),
    /canonical ISO-8601 UTC/,
  );

  assert.throws(
    () => assessSecretDataFlowV1(request({
      egresses: [{
        ...request().egresses[0],
        destinationOrigin: 'https://example.com/',
      }],
    }), { resolveArtifactRef: resolverFrom(artifactMap()) }),
    /canonical HTTP\(S\) origin/,
  );

  assert.throws(
    () => assessSecretDataFlowV1(request(), {
      resolveArtifactRef: async artifactId => artifactMap().get(artifactId),
    }),
    /synchronous trusted artifact resolver/,
  );
});
