import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_REMOTE_STEERING_TTL_MS,
  RemoteSteeringAction,
  RemoteSteeringRedirectKind,
  assessRemoteSteeringCommandV1,
  submitRemoteSteeringViaCanonicalRuntimeV1,
} from '../src/core/remote-steering-contract.js';

const OBSERVED_AT = '2026-09-25T03:30:00.000Z';
const ISSUED_AT = '2026-09-25T03:31:00.000Z';
const ASSESSMENT_AT = '2026-09-25T03:32:00.000Z';
const EXPIRES_AT = '2026-09-25T03:40:00.000Z';

function validInput(overrides = {}) {
  const input = {
    command: {
      schemaVersion: 1,
      commandId: 'steer-1',
      action: RemoteSteeringAction.PAUSE,
      jobId: 'job-1',
      planId: 'plan-1',
      expectedJobRevision: 7,
      expectedPlanRevision: 11,
      policyEnvelopeId: 'policy-1',
      sourcePrincipalId: 'owner-1',
      sourceDeviceId: 'device-web-1',
      sourceSessionId: 'remote-session-1',
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    },
  };

  if (overrides.command) Object.assign(input.command, overrides.command);
  return input;
}

function currentSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    jobId: 'job-1',
    planId: 'plan-1',
    jobRevision: 7,
    planRevision: 11,
    policyEnvelopeId: 'policy-1',
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

async function assess(input, snapshot = currentSnapshot(), onResolve = null, assessmentAt = ASSESSMENT_AT) {
  return assessRemoteSteeringCommandV1(input, {
    assessmentAt,
    async resolveCurrentSnapshot(request) {
      if (onResolve) onResolve(request);
      return snapshot;
    },
  });
}

test('admits exact current PAUSE proposal only for canonical authorization', async () => {
  let resolverRequest = null;
  const result = await assess(validInput(), currentSnapshot(), (request) => {
    resolverRequest = request;
  });

  assert.deepEqual(resolverRequest, { jobId: 'job-1', planId: 'plan-1' });
  assert.equal(Object.isFrozen(resolverRequest), true);
  assert.equal(result.status, 'READY_FOR_CANONICAL_AUTHORIZATION');
  assert.match(result.commandFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(result.action, RemoteSteeringAction.PAUSE);
  assert.equal(result.jobId, 'job-1');
  assert.equal(result.planId, 'plan-1');
  assert.equal(result.jobRevision, 7);
  assert.equal(result.planRevision, 11);
  assert.equal(result.policyEnvelopeId, 'policy-1');
  assert.equal(result.trustedCurrentStateBound, true);
  assert.equal(result.sourceIdentityAuthority, 'UNVERIFIED_REFERENCE');
  assert.equal(result.sourceAuthenticated, false);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.credentialUseAuthorized, false);
  assert.equal(result.policyDecisionGranted, false);
  assert.equal(result.requiresCanonicalPrincipalAuthentication, true);
  assert.equal(result.requiresCanonicalRuntime, true);
  assert.equal(result.requiresCanonicalCommandDeduplication, true);
  assert.equal(result.requiresFreshPolicy, true);
  assert.equal(result.requiresFreshStateRecheck, true);
  assert.equal(result.redirectTarget, null);
  assert.equal(Object.isFrozen(result), true);
});

test('requires a trusted canonical current-state resolver and ignores no caller snapshot', async () => {
  await assert.rejects(
    () => assessRemoteSteeringCommandV1(validInput(), { assessmentAt: ASSESSMENT_AT }),
    /trusted current-state resolver/u,
  );

  await assert.rejects(
    () => assessRemoteSteeringCommandV1(validInput()),
    /trusted current-state resolver/u,
  );

  const forged = validInput();
  forged.currentSnapshot = currentSnapshot({ jobRevision: 999 });
  await assert.rejects(
    () => assess(forged),
    /unknown field: currentSnapshot/u,
  );

  const backdated = validInput();
  backdated.assessmentAt = '2026-09-25T03:20:00.000Z';
  await assert.rejects(
    () => assess(backdated),
    /unknown field: assessmentAt/u,
  );

  await assert.rejects(
    () => assessRemoteSteeringCommandV1(validInput(), {
      resolveCurrentSnapshot: async () => currentSnapshot(),
    }),
    /assessmentAt must be a canonical ISO timestamp/u,
  );
});

test('fingerprint is deterministic and changes with command semantics', async () => {
  const first = await assess(validInput());
  const second = await assess(validInput());
  assert.equal(first.commandFingerprint, second.commandFingerprint);

  const changed = await assess(validInput({
    command: {
      action: RemoteSteeringAction.STOP,
      commandId: 'steer-2',
    },
  }));
  assert.notEqual(first.commandFingerprint, changed.commandFingerprint);

  const differentSource = await assess(validInput({
    command: {
      sourceDeviceId: 'device-web-2',
    },
  }));
  assert.notEqual(first.commandFingerprint, differentSource.commandFingerprint);
});

test('rejects stale or mismatched canonical job, plan, revision and policy bindings', async () => {
  const cases = [
    [validInput(), currentSnapshot({ jobId: 'job-2' }), /job identity/u],
    [validInput(), currentSnapshot({ planId: 'plan-2' }), /plan identity/u],
    [validInput({ command: { expectedJobRevision: 6 } }), currentSnapshot(), /job revision is stale/u],
    [validInput({ command: { expectedPlanRevision: 10 } }), currentSnapshot(), /plan revision is stale/u],
    [validInput({ command: { policyEnvelopeId: 'policy-2' } }), currentSnapshot(), /policy envelope/u],
  ];

  for (const [input, snapshot, expected] of cases) {
    await assert.rejects(() => assess(input, snapshot), expected);
  }
});

test('fails closed on expiry, future chronology, oversized TTL and non-canonical timestamps', async () => {
  await assert.rejects(
    () => assess(validInput(), currentSnapshot(), null, EXPIRES_AT),
    /expired/u,
  );

  await assert.rejects(
    () => assess(validInput({
      command: { issuedAt: '2026-09-25T03:33:00.000Z' },
    })),
    /issued after assessment/u,
  );

  await assert.rejects(
    () => assess(validInput(), currentSnapshot({
      observedAt: '2026-09-25T03:33:00.000Z',
    })),
    /observed after assessment/u,
  );

  await assert.rejects(
    () => assess(validInput({
      command: {
        expiresAt: new Date(Date.parse(ISSUED_AT) + MAX_REMOTE_STEERING_TTL_MS + 1).toISOString(),
      },
    })),
    /TTL exceeds/u,
  );

  await assert.rejects(
    () => assess(validInput({
      command: { expiresAt: ISSUED_AT },
    })),
    /expiry must follow issuance/u,
  );

  await assert.rejects(
    () => assess(validInput({
      command: { issuedAt: '2026-09-25T03:31:00Z' },
    })),
    /canonical ISO timestamp/u,
  );
});

test('REDIRECT carries only a bounded advisory target reference', async () => {
  const input = validInput({
    command: {
      action: RemoteSteeringAction.REDIRECT,
      redirectTarget: {
        kind: RemoteSteeringRedirectKind.EXECUTION_PLANE,
        targetId: 'CLOUD',
      },
    },
  });
  const result = await assess(input);

  assert.deepEqual(result.redirectTarget, {
    kind: RemoteSteeringRedirectKind.EXECUTION_PLANE,
    targetId: 'CLOUD',
  });
  assert.equal(Object.isFrozen(result.redirectTarget), true);
  assert.equal(result.mutationAuthorized, false);

  const missing = validInput({
    command: { action: RemoteSteeringAction.REDIRECT },
  });
  await assert.rejects(() => assess(missing), /requires redirectTarget/u);

  const wrongAction = validInput();
  wrongAction.command.redirectTarget = {
    kind: RemoteSteeringRedirectKind.AGENT,
    targetId: 'agent-2',
  };
  await assert.rejects(() => assess(wrongAction), /only valid for REDIRECT/u);

  const badKind = validInput({
    command: {
      action: RemoteSteeringAction.REDIRECT,
      redirectTarget: { kind: 'URL', targetId: 'https://example.test' },
    },
  });
  await assert.rejects(() => assess(badKind), /kind is invalid/u);

  const secretSmuggle = validInput({
    command: {
      action: RemoteSteeringAction.REDIRECT,
      redirectTarget: {
        kind: RemoteSteeringRedirectKind.AGENT,
        targetId: 'agent-2',
        credentialRef: 'secret-1',
      },
    },
  });
  await assert.rejects(() => assess(secretSmuggle), /unknown field: credentialRef/u);
});

test('accepts null-prototype command/request records but rejects exotic prototypes and symbols', async () => {
  const base = validInput();
  const nullProto = Object.assign(Object.create(null), base);
  nullProto.command = Object.assign(Object.create(null), base.command);

  const result = await assess(nullProto, Object.assign(Object.create(null), currentSnapshot()));
  assert.equal(result.commandId, 'steer-1');

  const exotic = Object.assign(Object.create({ inheritedAuthority: true }), validInput());
  await assert.rejects(() => assess(exotic), /plain or null-prototype/u);

  const symbolBearing = validInput();
  symbolBearing.command[Symbol('policyDecision')] = 'ALLOW';
  await assert.rejects(() => assess(symbolBearing), /symbol fields/u);
});

test('rejects accessor-backed and non-enumerable request authority without executing getters', async () => {
  let getterReads = 0;
  const accessor = validInput();
  Object.defineProperty(accessor, 'command', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return validInput().command;
    },
  });

  await assert.rejects(() => assess(accessor), /data properties only/u);
  assert.equal(getterReads, 0);

  let nestedReads = 0;
  const nested = validInput();
  Object.defineProperty(nested.command, 'policyEnvelopeId', {
    enumerable: true,
    configurable: true,
    get() {
      nestedReads += 1;
      return 'policy-1';
    },
  });
  await assert.rejects(() => assess(nested), /data properties only/u);
  assert.equal(nestedReads, 0);

  const hidden = validInput();
  Object.defineProperty(hidden.command, 'credentialRef', {
    enumerable: false,
    configurable: true,
    value: 'secret-1',
  });
  await assert.rejects(() => assess(hidden), /unknown field: credentialRef/u);
});

test('uses descriptor snapshots rather than ordinary Proxy reads', async () => {
  let ordinaryReads = 0;
  const target = validInput().command;
  const proxy = new Proxy(target, {
    get(object, property, receiver) {
      ordinaryReads += 1;
      return Reflect.get(object, property, receiver);
    },
  });
  const input = validInput();
  input.command = proxy;

  const result = await assess(input);
  assert.equal(result.commandId, 'steer-1');
  assert.equal(ordinaryReads, 0);
});

test('rejects unknown authority-bearing fields rather than silently ignoring them', async () => {
  const forbiddenFields = [
    ['credentialRef', 'cred-1'],
    ['policyDecision', 'ALLOW'],
    ['providerArgs', { prompt: 'do it' }],
    ['effectVerified', true],
  ];

  for (const [key, value] of forbiddenFields) {
    const input = validInput();
    input.command[key] = value;
    await assert.rejects(() => assess(input), new RegExp('unknown field: ' + key, 'u'));
  }

  const outer = validInput();
  outer.authorization = 'ALLOW';
  await assert.rejects(() => assess(outer), /unknown field: authorization/u);
});

test('uses exact types and canonical identity spelling without coercion aliases', async () => {
  const cases = [
    [{ command: { jobId: 1 } }, /jobId is invalid/u],
    [{ command: { jobId: ' job-1 ' } }, /jobId is invalid/u],
    [{ command: { expectedJobRevision: '7' } }, /positive safe integer/u],
    [{ command: { expectedPlanRevision: 11.5 } }, /positive safe integer/u],
    [{ command: { action: 'pause' } }, /action is invalid/u],
  ];

  for (const [override, expected] of cases) {
    await assert.rejects(() => assess(validInput(override)), expected);
  }

  await assert.rejects(
    () => assess(validInput(), currentSnapshot({ jobRevision: '7' })),
    /positive safe integer/u,
  );
  await assert.rejects(
    () => assess(validInput(), currentSnapshot({
      policyEnvelopeId: { toString: () => 'policy-1' },
    })),
    /policyEnvelopeId is invalid/u,
  );
});

test('rejects unknown and hidden redirect fields with exact target identity', async () => {
  const padded = validInput({
    command: {
      action: RemoteSteeringAction.REDIRECT,
      redirectTarget: {
        kind: RemoteSteeringRedirectKind.PLAN_NODE,
        targetId: ' node-2 ',
      },
    },
  });
  await assert.rejects(() => assess(padded), /targetId is invalid/u);

  const hidden = validInput({
    command: {
      action: RemoteSteeringAction.REDIRECT,
      redirectTarget: {
        kind: RemoteSteeringRedirectKind.AGENT,
        targetId: 'agent-2',
      },
    },
  });
  Object.defineProperty(hidden.command.redirectTarget, 'policyDecision', {
    value: 'ALLOW',
    enumerable: false,
  });
  await assert.rejects(() => assess(hidden), /unknown field: policyDecision/u);
});

test('remote command fingerprint cannot use caller-supplied digest authority', async () => {
  let digestCalls = 0;
  const fakeCrypto = {
    subtle: {
      async digest() {
        digestCalls += 1;
        return new Uint8Array(32).buffer;
      },
    },
  };

  await assert.rejects(
    () => assessRemoteSteeringCommandV1(validInput(), {
      cryptoApi: fakeCrypto,
      assessmentAt: ASSESSMENT_AT,
      resolveCurrentSnapshot: async () => currentSnapshot(),
    }),
    /unknown field: cryptoApi/u,
  );
  assert.equal(digestCalls, 0);

  const symbolOptions = {
    assessmentAt: ASSESSMENT_AT,
    resolveCurrentSnapshot: async () => currentSnapshot(),
  };
  symbolOptions[Symbol('cryptoAuthority')] = fakeCrypto;
  await assert.rejects(
    () => assessRemoteSteeringCommandV1(validInput(), symbolOptions),
    /symbol fields/u,
  );
  assert.equal(digestCalls, 0);
});

test('does not trust hidden or unknown dependency-injection option fields', async () => {
  const options = {
    assessmentAt: ASSESSMENT_AT,
    resolveCurrentSnapshot: async () => currentSnapshot(),
    authority: 'ALLOW',
  };
  await assert.rejects(
    () => assessRemoteSteeringCommandV1(validInput(), options),
    /unknown field: authority/u,
  );

  let getterReads = 0;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, 'resolveCurrentSnapshot', {
    enumerable: true,
    get() {
      getterReads += 1;
      return async () => currentSnapshot();
    },
  });
  await assert.rejects(
    () => assessRemoteSteeringCommandV1(validInput(), accessorOptions),
    /data properties only/u,
  );
  assert.equal(getterReads, 0);
});

test('epoch-bound remote command accepts only the exact trusted current control epoch', async () => {
  const result = await assess(
    validInput({ command: { expectedControlEpoch: 9 } }),
    currentSnapshot({ controlEpoch: 9 }),
  );
  assert.equal(result.status, 'READY_FOR_CANONICAL_AUTHORIZATION');
  assert.equal(result.controlEpoch, 9);
  assert.equal(result.controlEpochBound, true);
  assert.equal(result.requiresCanonicalControlEpochRecheck, true);
  assert.equal(result.sourceAuthenticated, false);
  assert.equal(result.mutationAuthorized, false);

  await assert.rejects(
    () => assess(validInput({ command: { expectedControlEpoch: 8 } }), currentSnapshot({ controlEpoch: 9 })),
    /control epoch/u,
  );
  await assert.rejects(
    () => assess(validInput(), currentSnapshot({ controlEpoch: 9 })),
    /control epoch/u,
  );
  await assert.rejects(
    () => assess(validInput({ command: { expectedControlEpoch: 9 } }), currentSnapshot()),
    /control epoch/u,
  );
});

test('epoch-specific command fingerprints are stable and prevent stale replay aliasing', async () => {
  const old = await assess(validInput({ command: { expectedControlEpoch: 9 } }), currentSnapshot({ controlEpoch: 9 }));
  const next = await assess(validInput({ command: { expectedControlEpoch: 10 } }), currentSnapshot({ controlEpoch: 10 }));
  assert.notEqual(old.commandFingerprint, next.commandFingerprint);
  const replay = await assess(validInput({ command: { expectedControlEpoch: 9 } }), currentSnapshot({ controlEpoch: 9 }));
  assert.equal(replay.commandFingerprint, old.commandFingerprint);
  assert.equal((await assess(validInput())).controlEpochBound, false);
});

test('remote control epoch rejects string, zero, unsafe or accessor authority without reading getters', async () => {
  for (const invalid of ['9', 0, -1, Number.MAX_SAFE_INTEGER + 1, null]) {
    await assert.rejects(
      () => assess(validInput({ command: { expectedControlEpoch: invalid } }), currentSnapshot({ controlEpoch: 9 })),
      /positive safe integer/u,
    );
    await assert.rejects(
      () => assess(validInput({ command: { expectedControlEpoch: 9 } }), currentSnapshot({ controlEpoch: invalid })),
      /positive safe integer/u,
    );
  }
  let reads = 0;
  const attacker = validInput();
  Object.defineProperty(attacker.command, 'expectedControlEpoch', {
    enumerable: true,
    get() { reads += 1; return 9; },
  });
  await assert.rejects(
    () => assess(attacker, currentSnapshot({ controlEpoch: 9 })),
    /data properties only/u,
  );
  assert.equal(reads, 0);
});

function epochCommand() {
  return validInput({ command: { expectedControlEpoch: 9 } });
}
function durableReceipt(tx, overrides = {}) {
  return {
    schemaVersion: 1,
    commandId: tx.commandId,
    commandFingerprint: tx.commandFingerprint,
    jobId: tx.jobId,
    planId: tx.planId,
    sourcePrincipalId: tx.sourcePrincipalId,
    sourceDeviceId: tx.sourceDeviceId,
    policyEnvelopeId: tx.policyEnvelopeId,
    expectedControlEpoch: tx.expectedControlEpoch,
    outcome: 'APPLIED',
    authenticated: true,
    policyRechecked: true,
    controlEpochRechecked: true,
    durablyDeduplicated: true,
    persisted: true,
    ...overrides,
  };
}
test('remote runtime bridge authenticates and commits via canonical transaction with exact durable readback', async () => {
  const store = { controlEpoch: 9, receipts: Object.create(null), writes: 0 };
  const committed = await submitRemoteSteeringViaCanonicalRuntimeV1(epochCommand(), {
    assessmentAt: ASSESSMENT_AT,
    resolveCurrentSnapshot: async () => currentSnapshot({ controlEpoch: store.controlEpoch }),
    atomicAuthenticateAuthorizeAndCommit: async tx => {
      assert.equal(tx.expectedControlEpoch, store.controlEpoch);
      assert.equal(tx.requireAtomicAuthentication, true);
      assert.equal(tx.requireFreshPolicy, true);
      assert.equal(tx.requireExactEpochRecheck, true);
      assert.equal(tx.requireDurableDeduplication, true);
      assert.equal(Object.isFrozen(tx), true);
      store.receipts[tx.commandId] = JSON.parse(JSON.stringify(durableReceipt(tx)));
      store.controlEpoch++;
      store.writes++;
    },
    readDurableReceipt: async key => {
      assert.equal(key.commandId, 'steer-1');
      return JSON.parse(JSON.stringify(store.receipts[key.commandId]));
    },
  });
  assert.equal(store.writes, 1);
  assert.equal(committed.status, 'CANONICAL_DURABLE_READBACK');
  assert.equal(committed.controlEpoch, 9);
  assert.equal(committed.outcome, 'APPLIED');
  assert.equal(committed.readbackVerified, true);
  assert.equal(committed.mutationAuthorized, false);
  assert.equal(Object.isFrozen(committed), true);
});
test('runtime bridge fails closed on old epoch and does not touch canonical transaction', async () => {
  let writes = 0;
  const options = {
    assessmentAt: ASSESSMENT_AT,
    resolveCurrentSnapshot: async () => currentSnapshot({ controlEpoch: 10 }),
    atomicAuthenticateAuthorizeAndCommit: async () => { writes++; },
    readDurableReceipt: async () => null,
  };
  await assert.rejects(
    () => submitRemoteSteeringViaCanonicalRuntimeV1(epochCommand(), options),
    /control epoch/u,
  );
  assert.equal(writes, 0);
  await assert.rejects(
    () => submitRemoteSteeringViaCanonicalRuntimeV1(validInput(), {
      ...options, resolveCurrentSnapshot: async () => currentSnapshot(),
    }), /control-epoch binding/u,
  );
  assert.equal(writes, 0);
});
test('runtime bridge detects recheck race: epoch changes between proposal and atomic commit', async () => {
  let atomicCalls = 0, readbackCalls = 0;
  let storedEpoch = 9;
  await assert.rejects(
    () => submitRemoteSteeringViaCanonicalRuntimeV1(epochCommand(), {
      assessmentAt: ASSESSMENT_AT,
      resolveCurrentSnapshot: async () => {
        const old = currentSnapshot({ controlEpoch: storedEpoch });
        storedEpoch = 10; // another local device STOPs after snapshot
        return old;
      },
      atomicAuthenticateAuthorizeAndCommit: async tx => {
        atomicCalls++;
        if (tx.expectedControlEpoch !== storedEpoch) {
          throw new Error('canonical transaction rejects stale control epoch');
        }
      },
      readDurableReceipt: async () => { readbackCalls++; return null; },
    }), /stale control epoch/u,
  );
  assert.equal(atomicCalls, 1);
  assert.equal(readbackCalls, 0);
});
test('runtime bridge rejects forged durable receipts and does not confuse callback completion with persistence', async () => {
  const invalid = [
    { authenticated: false },
    { policyRechecked: false },
    { controlEpochRechecked: false },
    { durablyDeduplicated: false },
    { persisted: false },
    { outcome: 'PROPOSED' },
    { commandFingerprint: 'sha256:' + 'f'.repeat(64) },
    { expectedControlEpoch: 8 },
    { sourcePrincipalId: 'attacker' },
    { extraAuthority: true },
  ];
  for (const mutation of invalid) {
    let transaction = null;
    await assert.rejects(
      () => submitRemoteSteeringViaCanonicalRuntimeV1(epochCommand(), {
        assessmentAt: ASSESSMENT_AT,
        resolveCurrentSnapshot: async () => currentSnapshot({ controlEpoch: 9 }),
        atomicAuthenticateAuthorizeAndCommit: async tx => { transaction = tx; },
        readDurableReceipt: async () => durableReceipt(transaction, mutation),
      }), /durable receipt|unknown field/u,
    );
  }
});
test('runtime bridge rejects forged callback options without invoking accessors', async () => {
  const options = {
    assessmentAt: ASSESSMENT_AT,
    resolveCurrentSnapshot: async () => currentSnapshot({ controlEpoch: 9 }),
    readDurableReceipt: async () => null,
  };
  let reads = 0;
  Object.defineProperty(options, 'atomicAuthenticateAuthorizeAndCommit', {
    enumerable: true, get() { reads++; return async () => {}; },
  });
  await assert.rejects(
    () => submitRemoteSteeringViaCanonicalRuntimeV1(epochCommand(), options),
    /data properties only/u,
  );
  assert.equal(reads, 0);
});
