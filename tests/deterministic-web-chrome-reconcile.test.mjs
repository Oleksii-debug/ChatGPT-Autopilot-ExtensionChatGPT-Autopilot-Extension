import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createChromeDeterministicWebProviderV1,
  createChromeDeterministicWebReconcileVerifierV1,
} from '../src/core/deterministic-web-chrome-runtime.js';

const at = '2026-09-24T16:40:00.000Z';

function fixtures(invocationId = 'chrome-reconcile') {
  return {
    toolDescriptor: { schemaVersion: 1, toolId: 'web.action', providerId: 'deterministic-web', label: 'Web action', description: '', capabilityIds: ['web.general'], inputSchemaRef: null, outputSchemaRef: null, readOnly: false },
    invocation: { schemaVersion: 1, invocationId, toolId: 'web.action', providerId: 'deterministic-web', requestedCapabilityIds: ['web.general'], policyDecisionId: `decision-${invocationId}`, arguments: {}, createdAt: at, parentInvocationId: null },
    policyDecision: { schemaVersion: 1, decisionId: `decision-${invocationId}`, invocationId, decision: 'ALLOW', reasonCode: 'OWNER_POLICY', reason: '', approvalId: null, decidedAt: at },
    grantedCapabilityIds: ['web.general'], targetId: 'tab:7', action: { kind: 'CLICK', selector: '#go' }, postcondition: { selector: '#ready' },
  };
}

function chromeFixture({ closeBeforeReconcile = false } = {}) {
  const storage = {}; let clickAttempts = 0;
  return {
    storage,
    chrome: {
      permissions: { async contains() { return true; } },
      storage: { local: { async get(key) { return key in storage ? { [key]: structuredClone(storage[key]) } : {}; }, async set(record) { Object.assign(storage, structuredClone(record)); } } },
      tabs: { async get(id) { if (closeBeforeReconcile && clickAttempts > 0) throw new Error('tab closed'); return { id, url: 'https://example.test/start', status: 'complete' }; }, async query() { return closeBeforeReconcile && clickAttempts > 0 ? [] : [{ id: 7, url: 'https://example.test/start' }]; }, async update(id, update) { return { id, ...update }; } },
      scripting: { async executeScript(request) { if ((request.args || [])[0] === 'CLICK') { clickAttempts += 1; if (clickAttempts === 1) throw new Error('connection lost after click dispatch'); return [{ result: { ok: true } }]; } return [{ result: { url: 'https://example.test/start', readyState: 'complete', visibleSelectors: ['#ready'] } }]; } },
    },
    get clickAttempts() { return clickAttempts; },
  };
}

test('fresh independent Chrome readback can reconcile an ambiguous exact effect to committed without replay', async () => {
  const fixture = chromeFixture();
  const verifier = createChromeDeterministicWebReconcileVerifierV1(fixture.chrome, { now: () => at });
  const provider = createChromeDeterministicWebProviderV1({ chromeApi: fixture.chrome, reconcileVerify: verifier, now: () => at, leaseId: () => 'reconcile-lease' });
  const ambiguous = await provider.invoke(fixtures());
  assert.equal(ambiguous.status, 'AMBIGUOUS');
  assert.equal(fixture.clickAttempts, 1);
  assert.equal(fixture.storage['autopilot.deterministicWebRuntime.v1'].leasesByTargetId['tab:7'].ownerInvocationId, 'chrome-reconcile');
  const reconciled = await provider.reconcile({ invocationId: 'chrome-reconcile', outcome: 'VERIFIED' });
  assert.equal(reconciled.phase, 'COMMITTED');
  assert.equal(fixture.clickAttempts, 1, 'reconciliation must not re-dispatch the click');
  assert.equal(fixture.storage['autopilot.deterministicWebRuntime.v1'].leasesByTargetId['tab:7'], null);
});

test('tab disappearance during reconciliation fails closed and preserves the exact target lease', async () => {
  const fixture = chromeFixture({ closeBeforeReconcile: true });
  const verifier = createChromeDeterministicWebReconcileVerifierV1(fixture.chrome, { now: () => at });
  const provider = createChromeDeterministicWebProviderV1({ chromeApi: fixture.chrome, reconcileVerify: verifier, now: () => at, leaseId: () => 'reconcile-lease' });
  assert.equal((await provider.invoke(fixtures('closed-tab'))).status, 'AMBIGUOUS');
  await assert.rejects(() => provider.reconcile({ invocationId: 'closed-tab', outcome: 'VERIFIED' }), /tab closed|unavailable/);
  const saved = fixture.storage['autopilot.deterministicWebRuntime.v1'];
  assert.equal(saved.effectsById['closed-tab'].state.phase, 'RECONCILE');
  assert.equal(saved.leasesByTargetId['tab:7'].ownerInvocationId, 'closed-tab');
  assert.equal(fixture.clickAttempts, 1);
});


test('closed target can settle to MANUAL_REVIEW and release its lease without replay', async () => {
  const fixture = chromeFixture({ closeBeforeReconcile: true });
  const verifier = createChromeDeterministicWebReconcileVerifierV1(fixture.chrome, { now: () => at });
  const provider = createChromeDeterministicWebProviderV1({
    chromeApi: fixture.chrome,
    reconcileVerify: verifier,
    now: () => at,
    leaseId: () => 'closed-target-lease',
  });
  assert.equal((await provider.invoke(fixtures('closed-target-manual'))).status, 'AMBIGUOUS');
  assert.equal(fixture.clickAttempts, 1);
  const settled = await provider.reconcile({
    invocationId: 'closed-target-manual',
    outcome: 'MANUAL_REVIEW',
    reasonCode: 'TARGET_CLOSED_QUIESCENT',
  });
  assert.equal(settled.phase, 'MANUAL_REVIEW');
  assert.equal(fixture.clickAttempts, 1, 'closed-target settlement must never replay the click');
  const saved = fixture.storage['autopilot.deterministicWebRuntime.v1'];
  assert.equal(saved.leasesByTargetId['tab:7'], null);
  assert.equal(saved.effectsById['closed-target-manual'].state.reconciliation.outcome, 'MANUAL_REVIEW');
});

test('open target cannot use closed-target MANUAL_REVIEW settlement', async () => {
  const fixture = chromeFixture();
  const verifier = createChromeDeterministicWebReconcileVerifierV1(fixture.chrome, { now: () => at });
  const provider = createChromeDeterministicWebProviderV1({
    chromeApi: fixture.chrome,
    reconcileVerify: verifier,
    now: () => at,
    leaseId: () => 'open-target-lease',
  });
  assert.equal((await provider.invoke(fixtures('open-target-manual'))).status, 'AMBIGUOUS');
  await assert.rejects(() => provider.reconcile({
    invocationId: 'open-target-manual',
    outcome: 'MANUAL_REVIEW',
    reasonCode: 'TARGET_CLOSED_QUIESCENT',
  }), /target tab to be closed/);
  const saved = fixture.storage['autopilot.deterministicWebRuntime.v1'];
  assert.equal(saved.effectsById['open-target-manual'].state.phase, 'RECONCILE');
  assert.equal(saved.leasesByTargetId['tab:7'].ownerInvocationId, 'open-target-manual');
  assert.equal(fixture.clickAttempts, 1);
});
