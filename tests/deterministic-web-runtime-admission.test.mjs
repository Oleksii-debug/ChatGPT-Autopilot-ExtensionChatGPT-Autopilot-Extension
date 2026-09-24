import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeterministicWebRuntimeAdmissionV1,
  DETERMINISTIC_WEB_RUNTIME_CHANNEL,
} from '../src/core/deterministic-web-runtime-admission.js';

function providerFixture() {
  const calls = [];
  let releaseRecovery;
  const recoveryGate = new Promise(resolve => { releaseRecovery = resolve; });
  const provider = {
    async recoverInterrupted() {
      calls.push(['recover']);
      await recoveryGate;
      return [{ invocationId: 'old-effect' }];
    },
    async invoke(payload) {
      calls.push(['invoke', structuredClone(payload)]);
      return { status: 'VERIFIED' };
    },
    async reconcile(payload) {
      calls.push(['reconcile', structuredClone(payload)]);
      return { phase: 'COMMITTED' };
    },
  };
  return { provider, calls, releaseRecovery };
}

test('runtime admission completes one cold-start recovery before first mutation dispatch', async () => {
  const fixture = providerFixture();
  const admission = createDeterministicWebRuntimeAdmissionV1({ provider: fixture.provider, extensionId: 'extension-1' });
  const pending = admission.dispatch({
    channel: DETERMINISTIC_WEB_RUNTIME_CHANNEL,
    command: 'INVOKE',
    payload: { targetId: 'tab:7' },
  }, { id: 'extension-1' });
  await Promise.resolve();
  assert.deepEqual(fixture.calls, [['recover']]);
  fixture.releaseRecovery();
  assert.deepEqual(await pending, { status: 'VERIFIED' });
  assert.deepEqual(fixture.calls, [['recover'], ['invoke', { targetId: 'tab:7' }]]);

  await admission.dispatch({
    channel: DETERMINISTIC_WEB_RUNTIME_CHANNEL,
    command: 'INVOKE',
    payload: { targetId: 'tab:8' },
  }, { id: 'extension-1' });
  assert.equal(fixture.calls.filter(([name]) => name === 'recover').length, 1);
});

test('runtime admission rejects foreign senders and unsupported reconciliation outcomes', async () => {
  const fixture = providerFixture();
  const admission = createDeterministicWebRuntimeAdmissionV1({ provider: fixture.provider, extensionId: 'extension-1' });
  fixture.releaseRecovery();
  await assert.rejects(() => admission.dispatch({
    channel: DETERMINISTIC_WEB_RUNTIME_CHANNEL,
    command: 'INVOKE',
    payload: {},
  }, { id: 'foreign-extension' }), /sender is not authorized/);
  assert.deepEqual(fixture.calls, []);

  await assert.rejects(() => admission.dispatch({
    channel: DETERMINISTIC_WEB_RUNTIME_CHANNEL,
    command: 'RECONCILE_SAFE_RETRY',
    payload: { invocationId: 'effect-1' },
  }, { id: 'extension-1' }), /command is not allowed/);
  assert.deepEqual(fixture.calls, [['recover']]);
});

test('verified reconciliation is pinned by admission to VERIFIED and ignores caller-supplied outcome', async () => {
  const fixture = providerFixture();
  const admission = createDeterministicWebRuntimeAdmissionV1({ provider: fixture.provider, extensionId: 'extension-1' });
  fixture.releaseRecovery();
  await admission.dispatch({
    channel: DETERMINISTIC_WEB_RUNTIME_CHANNEL,
    command: 'RECONCILE_VERIFIED',
    payload: { invocationId: 'effect-1', outcome: 'SAFE_RETRY', reasonCode: 'FRESH_READBACK' },
  }, { id: 'extension-1' });
  assert.deepEqual(fixture.calls, [
    ['recover'],
    ['reconcile', { invocationId: 'effect-1', outcome: 'VERIFIED', reasonCode: 'FRESH_READBACK' }],
  ]);
});
