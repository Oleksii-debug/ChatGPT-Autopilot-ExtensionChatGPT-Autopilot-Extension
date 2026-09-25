import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  MAX_REMOTE_STEERING_TTL_MS,
  RemoteSteeringAction,
  RemoteSteeringRedirectKind,
  assessRemoteSteeringCommandV1,
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
    assessmentAt: ASSESSMENT_AT,
  };

  if (overrides.command) Object.assign(input.command, overrides.command);
  if (Object.hasOwn(overrides, 'assessmentAt')) input.assessmentAt = overrides.assessmentAt;
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

async function assess(input, snapshot = currentSnapshot(), onResolve = null) {
  return assessRemoteSteeringCommandV1(input, {
    cryptoApi: webcrypto,
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
    () => assessRemoteSteeringCommandV1(validInput(), { cryptoApi: webcrypto }),
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
    () => assess(validInput({ assessmentAt: EXPIRES_AT })),
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

test('does not trust hidden or unknown dependency-injection option fields', async () => {
  const options = {
    cryptoApi: webcrypto,
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
