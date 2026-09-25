import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTOPILOT_PROGRAMMATIC_CONTROL_VERSION,
  AutopilotProgrammaticDispatchStatus,
  AutopilotProgrammaticOperation,
  executeAutopilotProgrammaticControlV1,
  isAutopilotProgrammaticOperationReadOnly,
  normalizeAutopilotProgrammaticRequestV1,
} from '../src/core/autopilot-programmatic-control.js';

const requestedAt = '2026-09-25T18:00:00.000Z';
const assessedAt = '2026-09-25T18:00:10.000Z';
const verifiedAt = '2026-09-25T18:00:05.000Z';
const validThrough = '2026-09-25T18:05:00.000Z';
const observedAt = '2026-09-25T18:00:11.000Z';
const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);

function artifact(artifactId = 'payload-1', sha256 = shaA, createdAt = '2026-09-25T17:59:00.000Z') {
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'programmatic-control-payload',
    uri: 'artifact://' + artifactId,
    mediaType: 'application/json',
    sha256,
    sizeBytes: 64,
    createdAt,
    producerInvocationId: 'invocation-payload-1',
    sensitive: false,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: 'request-1',
    principalId: 'owner-1',
    projectId: 'project-1',
    operation: AutopilotProgrammaticOperation.STATUS_GET,
    targetId: 'job-1',
    payloadArtifactRef: null,
    requestedAt,
    ...overrides,
  };
}

function scopeFor(requestOrLookup, overrides = {}) {
  const normalizedRequest = requestOrLookup.request ?? requestOrLookup;
  return {
    schemaVersion: 1,
    scopeRevisionId: 'scope-revision-1',
    requestId: normalizedRequest.requestId,
    principalId: normalizedRequest.principalId,
    projectId: normalizedRequest.projectId,
    operation: normalizedRequest.operation,
    targetId: normalizedRequest.targetId,
    payloadArtifactId: normalizedRequest.payloadArtifactRef?.artifactId ?? null,
    payloadSha256: normalizedRequest.payloadArtifactRef?.sha256 ?? null,
    allowed: true,
    verifiedAt,
    validThrough,
    ...overrides,
  };
}

function fixedNow() {
  return Date.parse(assessedAt);
}

function nowSequence(...timestamps) {
  let index = 0;
  return () => Date.parse(timestamps[Math.min(index++, timestamps.length - 1)]);
}

function receiptFor(envelope, overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: envelope.request.requestId,
    projectId: envelope.request.projectId,
    operation: envelope.request.operation,
    dispatchId: 'dispatch-1',
    status: AutopilotProgrammaticDispatchStatus.COMPLETED,
    resultArtifactRef: null,
    observedAt,
    ...overrides,
  };
}

test('read-only SDK request is exact-scoped and dispatched through the canonical control plane', async () => {
  let scopes = 0;
  let dispatches = 0;
  const output = await executeAutopilotProgrammaticControlV1(request(), {
    now: nowSequence(assessedAt, assessedAt, observedAt),
    async resolveTrustedScope(normalizedRequest) {
      scopes += 1;
      assert.equal(Object.isFrozen(normalizedRequest), true);
      return scopeFor(normalizedRequest);
    },
    async dispatchCanonicalControl(envelope) {
      dispatches += 1;
      assert.equal(envelope.request.requestId, 'request-1');
      assert.equal(envelope.readOnly, true);
      assert.equal(envelope.downstreamAuthorityRequired, false);
      assert.equal(envelope.adapterGrantsAuthority, false);
      return receiptFor(envelope);
    },
  });

  assert.equal(scopes, 1);
  assert.equal(dispatches, 1);
  assert.equal(output.readOnly, true);
  assert.equal(output.downstreamAuthorityRequired, false);
  assert.equal(output.adapterGrantsAuthority, false);
  assert.equal(output.executionAuthorized, false);
  assert.equal(output.policyDecisionAuthorized, false);
  assert.equal(output.storeMutationAuthority, false);
  assert.equal(output.schedulerAuthority, false);
  assert.equal(output.exactEffectAuthority, false);
  assert.equal(output.receipt.requestId, output.request.requestId);
  assert.equal(output.completedAt, observedAt);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.scopeProof), true);
  assert.equal(Object.isFrozen(output.receipt), true);
});

test('mutating SDK operation carries a versioned payload artifact but does not mint execution authority', async () => {
  const payload = artifact('outcome-contract-payload');
  const raw = request({
    requestId: 'request-outcome',
    operation: AutopilotProgrammaticOperation.OUTCOME_SUBMIT,
    targetId: 'outcome-contract-1',
    payloadArtifactRef: payload,
  });
  const resultArtifact = artifact(
    'dispatch-result-1',
    shaB,
    '2026-09-25T18:00:10.500Z',
  );

  const output = await executeAutopilotProgrammaticControlV1(raw, {
    now: nowSequence(assessedAt, assessedAt, observedAt),
    resolveTrustedScope(normalizedRequest) {
      assert.equal(normalizedRequest.request.payloadArtifactRef.sha256, shaA);
      return scopeFor(normalizedRequest);
    },
    dispatchCanonicalControl(envelope) {
      assert.equal(envelope.readOnly, false);
      assert.equal(envelope.downstreamAuthorityRequired, true);
      assert.equal(envelope.adapterGrantsAuthority, false);
      return receiptFor(envelope, {
        status: AutopilotProgrammaticDispatchStatus.ACCEPTED,
        resultArtifactRef: resultArtifact,
      });
    },
  });

  assert.equal(output.readOnly, false);
  assert.equal(output.downstreamAuthorityRequired, true);
  assert.equal(output.executionAuthorized, false);
  assert.equal(output.receipt.resultArtifactRef.artifactId, 'dispatch-result-1');
  assert.equal(output.receipt.observedAt, observedAt);
});

test('operation-specific target and payload rules fail closed before any authority call', async () => {
  assert.throws(
    () => normalizeAutopilotProgrammaticRequestV1(request({
      operation: AutopilotProgrammaticOperation.PROJECT_OPEN,
      targetId: 'different-project',
    })),
    /targetId must equal projectId/u,
  );
  assert.throws(
    () => normalizeAutopilotProgrammaticRequestV1(request({
      operation: AutopilotProgrammaticOperation.OUTCOME_SUBMIT,
      targetId: 'outcome-1',
    })),
    /requires payloadArtifactRef/u,
  );
  assert.throws(
    () => normalizeAutopilotProgrammaticRequestV1(request({
      operation: AutopilotProgrammaticOperation.STATUS_GET,
      payloadArtifactRef: artifact(),
    })),
    /does not accept payloadArtifactRef/u,
  );

  const capabilities = normalizeAutopilotProgrammaticRequestV1(request({
    operation: AutopilotProgrammaticOperation.PROVIDER_CAPABILITIES_GET,
    targetId: null,
  }));
  assert.equal(capabilities.targetId, null);
  assert.equal(isAutopilotProgrammaticOperationReadOnly(capabilities.operation), true);
  assert.equal(isAutopilotProgrammaticOperationReadOnly(AutopilotProgrammaticOperation.AGENT_STOP), false);
});

test('scope proof must bind exact principal, project, request, operation, target and payload before dispatch', async () => {
  let dispatches = 0;
  const raw = request({
    requestId: 'request-scope-binding',
    operation: AutopilotProgrammaticOperation.RECIPE_TRIGGER,
    targetId: 'recipe-1',
    payloadArtifactRef: artifact('recipe-input'),
  });

  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(raw, {
      now: nowSequence(assessedAt, assessedAt, observedAt),
      resolveTrustedScope(normalizedRequest) {
        return scopeFor(normalizedRequest, { principalId: 'other-owner' });
      },
      dispatchCanonicalControl() {
        dispatches += 1;
        return {};
      },
    }),
    /scope proof does not match/u,
  );
  assert.equal(dispatches, 0);

  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(raw, {
      now: nowSequence(assessedAt, assessedAt, observedAt),
      resolveTrustedScope(normalizedRequest) {
        return scopeFor(normalizedRequest, { allowed: false });
      },
      dispatchCanonicalControl() {
        dispatches += 1;
        return {};
      },
    }),
    /scope denied/u,
  );
  assert.equal(dispatches, 0);
});

test('scope chronology is causal and unexpired at assessment', async () => {
  let dispatches = 0;
  for (const override of [
    { verifiedAt: '2026-09-25T17:59:59.000Z' },
    { verifiedAt: '2026-09-25T18:00:11.000Z' },
    { validThrough: '2026-09-25T18:00:09.999Z' },
  ]) {
    await assert.rejects(
      () => executeAutopilotProgrammaticControlV1(request(), {
        now: nowSequence(assessedAt, assessedAt, observedAt),
        resolveTrustedScope(normalizedRequest) {
          return scopeFor(normalizedRequest, override);
        },
        dispatchCanonicalControl() {
          dispatches += 1;
          return {};
        },
      }),
      /scope\.|expired/u,
    );
  }
  assert.equal(dispatches, 0);
});

test('dispatch receipt is exact-bound and its result artifact is causal to receipt observation', async () => {
  let attempt = 0;
  const dependencies = {
    now: nowSequence(assessedAt, assessedAt, observedAt),
    resolveTrustedScope(normalizedRequest) {
      return scopeFor(normalizedRequest);
    },
    dispatchCanonicalControl(envelope) {
      attempt += 1;
      if (attempt === 1) {
        return receiptFor(envelope, { requestId: 'other-request' });
      }
      if (attempt === 2) {
        return receiptFor(envelope, { observedAt: '2026-09-25T18:00:09.000Z' });
      }
      return receiptFor(envelope, {
        resultArtifactRef: artifact(
          'future-result',
          shaB,
          '2026-09-25T18:00:12.000Z',
        ),
      });
    },
  };

  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request(), dependencies),
    /receipt does not match/u,
  );
  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request(), dependencies),
    /cannot predate dispatchAt/u,
  );
  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request(), dependencies),
    /cannot be created after receipt\.observedAt/u,
  );

  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request(), {
      now: nowSequence(assessedAt, assessedAt, observedAt),
      resolveTrustedScope(lookup) {
        return scopeFor(lookup);
      },
      dispatchCanonicalControl(envelope) {
        return receiptFor(envelope, { observedAt: '2026-09-25T18:00:12.000Z' });
      },
    }),
    /cannot be after trusted completedAt/u,
  );
});

test('outer request and dependency records reject accessors without executing getters', async () => {
  let requestGetterCalls = 0;
  let dependencyGetterCalls = 0;
  let scopes = 0;

  const hostileRequest = request();
  Object.defineProperty(hostileRequest, 'principalId', {
    enumerable: true,
    get() {
      requestGetterCalls += 1;
      return 'owner-1';
    },
  });

  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(hostileRequest, {
      now: nowSequence(assessedAt, assessedAt, observedAt),
      resolveTrustedScope() {
        scopes += 1;
        return {};
      },
      dispatchCanonicalControl() {
        return {};
      },
    }),
    /enumerable own data properties/u,
  );
  assert.equal(requestGetterCalls, 0);
  assert.equal(scopes, 0);

  const hostileDependencies = {
    dispatchCanonicalControl() {
      return {};
    },
  };
  Object.defineProperty(hostileDependencies, 'resolveTrustedScope', {
    enumerable: true,
    get() {
      dependencyGetterCalls += 1;
      return () => ({});
    },
  });
  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request(), hostileDependencies),
    /enumerable own data properties/u,
  );
  assert.equal(dependencyGetterCalls, 0);
});

test('payload, scope proof and receipt descriptor boundaries reject getters without executing them', async () => {
  let payloadGetterCalls = 0;
  let scopeGetterCalls = 0;
  let receiptGetterCalls = 0;
  let dispatches = 0;

  const hostilePayload = artifact();
  Object.defineProperty(hostilePayload, 'sha256', {
    enumerable: true,
    get() {
      payloadGetterCalls += 1;
      return shaA;
    },
  });
  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request({
      operation: AutopilotProgrammaticOperation.OUTCOME_SUBMIT,
      targetId: 'outcome-1',
      payloadArtifactRef: hostilePayload,
    }), {
      now: nowSequence(assessedAt, assessedAt, observedAt),
      resolveTrustedScope() {
        return {};
      },
      dispatchCanonicalControl() {
        dispatches += 1;
        return {};
      },
    }),
    /enumerable own data properties/u,
  );
  assert.equal(payloadGetterCalls, 0);
  assert.equal(dispatches, 0);

  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request(), {
      now: nowSequence(assessedAt, assessedAt, observedAt),
      resolveTrustedScope(normalizedRequest) {
        const proof = scopeFor(normalizedRequest);
        Object.defineProperty(proof, 'allowed', {
          enumerable: true,
          get() {
            scopeGetterCalls += 1;
            return true;
          },
        });
        return proof;
      },
      dispatchCanonicalControl() {
        dispatches += 1;
        return {};
      },
    }),
    /enumerable own data properties/u,
  );
  assert.equal(scopeGetterCalls, 0);
  assert.equal(dispatches, 0);

  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request(), {
      now: nowSequence(assessedAt, assessedAt, observedAt),
      resolveTrustedScope(normalizedRequest) {
        return scopeFor(normalizedRequest);
      },
      dispatchCanonicalControl(envelope) {
        dispatches += 1;
        const receipt = receiptFor(envelope);
        Object.defineProperty(receipt, 'status', {
          enumerable: true,
          get() {
            receiptGetterCalls += 1;
            return AutopilotProgrammaticDispatchStatus.COMPLETED;
          },
        });
        return receipt;
      },
    }),
    /enumerable own data properties/u,
  );
  assert.equal(receiptGetterCalls, 0);
  assert.equal(dispatches, 1);
});

test('payload artifact identities reject normalization aliases before scope resolution', async () => {
  let scopes = 0;
  const uppercase = artifact('payload-uppercase', shaA.toUpperCase());
  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request({
      operation: AutopilotProgrammaticOperation.OUTCOME_SUBMIT,
      targetId: 'outcome-1',
      payloadArtifactRef: uppercase,
    }), {
      now: nowSequence(assessedAt, assessedAt, observedAt),
      resolveTrustedScope() {
        scopes += 1;
        return {};
      },
      dispatchCanonicalControl() {
        return {};
      },
    }),
    /lowercase sha256/u,
  );
  assert.equal(scopes, 0);

  const futurePayload = artifact(
    'payload-future',
    shaA,
    '2026-09-25T18:00:00.001Z',
  );
  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request({
      operation: AutopilotProgrammaticOperation.OUTCOME_SUBMIT,
      targetId: 'outcome-1',
      payloadArtifactRef: futurePayload,
    }), {
      now: nowSequence(assessedAt, assessedAt, observedAt),
      resolveTrustedScope() {
        scopes += 1;
        return {};
      },
      dispatchCanonicalControl() {
        return {};
      },
    }),
    /created after requestedAt/u,
  );
  assert.equal(scopes, 0);
});

test('null-prototype request, dependencies, scope proof and receipt remain supported', async () => {
  const rawRequest = Object.assign(Object.create(null), request({
    requestId: 'request-null-prototype',
  }));
  const dependencies = Object.create(null);
  dependencies.now = nowSequence(assessedAt, assessedAt, observedAt);
  dependencies.resolveTrustedScope = normalizedRequest => Object.assign(
    Object.create(null),
    scopeFor(normalizedRequest),
  );
  dependencies.dispatchCanonicalControl = envelope => Object.assign(
    Object.create(null),
    receiptFor(envelope),
  );

  const output = await executeAutopilotProgrammaticControlV1(rawRequest, dependencies);
  assert.equal(output.receipt.status, AutopilotProgrammaticDispatchStatus.COMPLETED);
  assert.equal(output.request.requestId, 'request-null-prototype');
});

test('trusted clock, not caller timestamps, controls scope freshness through dispatch', async () => {
  let scopes = 0;
  let dispatches = 0;

  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request({
      requestedAt: '2026-09-25T18:00:11.000Z',
    }), {
      now: nowSequence(assessedAt, assessedAt, observedAt),
      resolveTrustedScope() {
        scopes += 1;
        return {};
      },
      dispatchCanonicalControl() {
        dispatches += 1;
        return {};
      },
    }),
    /after trusted assessedAt/u,
  );
  assert.equal(scopes, 0);
  assert.equal(dispatches, 0);

  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request(), {
      now: nowSequence(assessedAt, '2026-09-25T18:05:00.001Z'),
      resolveTrustedScope(lookup) {
        scopes += 1;
        return scopeFor(lookup);
      },
      dispatchCanonicalControl() {
        dispatches += 1;
        return {};
      },
    }),
    /scope expired before dispatch/u,
  );
  assert.equal(dispatches, 0);

  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request(), {
      now: nowSequence(assessedAt, observedAt, assessedAt),
      resolveTrustedScope(lookup) {
        return scopeFor(lookup);
      },
      dispatchCanonicalControl(envelope) {
        return receiptFor(envelope);
      },
    }),
    /clock regressed after dispatch/u,
  );

  const callerTime = request();
  callerTime.assessedAt = assessedAt;
  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(callerTime, {
      now: nowSequence(assessedAt, assessedAt, observedAt),
      resolveTrustedScope() {
        return {};
      },
      dispatchCanonicalControl() {
        return {};
      },
    }),
    /unknown field: assessedAt/u,
  );
});

test('scope proof binds payload artifact identity as well as bytes', async () => {
  let dispatches = 0;
  const raw = request({
    operation: AutopilotProgrammaticOperation.OUTCOME_SUBMIT,
    targetId: 'outcome-identity',
    payloadArtifactRef: artifact('payload-exact-id'),
  });

  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(raw, {
      now: nowSequence(assessedAt, assessedAt, observedAt),
      resolveTrustedScope(lookup) {
        return scopeFor(lookup, { payloadArtifactId: 'payload-alias-id' });
      },
      dispatchCanonicalControl() {
        dispatches += 1;
        return {};
      },
    }),
    /scope proof does not match/u,
  );
  assert.equal(dispatches, 0);
});

test('unknown, symbol, hidden and exotic dependency/request authority fields fail closed', async () => {
  const unknownRequest = request();
  unknownRequest.unexpectedAuthority = true;
  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(unknownRequest, {}),
    /unknown field/u,
  );

  const symbolic = request();
  symbolic[Symbol('authority')] = true;
  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(symbolic, {}),
    /unknown field/u,
  );

  const hiddenDependencies = {
    now: nowSequence(assessedAt, assessedAt, observedAt),
    resolveTrustedScope() {},
    dispatchCanonicalControl() {},
  };
  Object.defineProperty(hiddenDependencies, 'hiddenAuthority', {
    enumerable: false,
    value: true,
  });
  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request(), hiddenDependencies),
    /unknown field/u,
  );

  await assert.rejects(
    () => executeAutopilotProgrammaticControlV1(request(), new Map()),
    /plain or null-prototype object/u,
  );
});
