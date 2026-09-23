import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeterministicWebProviderV1, normalizeDeterministicWebActionV1 } from '../src/core/deterministic-web-provider.js';

const at = '2026-09-23T15:20:00.000Z';
function fixtures(invocationId = 'inv-1') {
  const toolDescriptor = { schemaVersion: 1, toolId: 'web.action', providerId: 'deterministic-web', label: 'Web action', description: '', capabilityIds: ['web.general'], inputSchemaRef: null, outputSchemaRef: null, readOnly: false };
  const invocation = { schemaVersion: 1, invocationId, toolId: 'web.action', providerId: 'deterministic-web', requestedCapabilityIds: ['web.general'], policyDecisionId: `decision-${invocationId}`, arguments: {}, createdAt: at, parentInvocationId: null };
  const policyDecision = { schemaVersion: 1, decisionId: `decision-${invocationId}`, invocationId, decision: 'ALLOW', reasonCode: 'OWNER_POLICY', reason: '', approvalId: null, decidedAt: at };
  return { toolDescriptor, invocation, policyDecision, grantedCapabilityIds: ['web.general'] };
}

function provider(transport, leaseState = { value: null }) {
  return createDeterministicWebProviderV1({
    transport,
    readLease: async () => leaseState.value,
    writeLease: async (_targetId, value) => { leaseState.value = value; },
    now: () => at,
    leaseId: () => 'lease-1',
  });
}

test('normalizes bounded deterministic web actions and rejects unsafe URL protocols', () => {
  assert.deepEqual(normalizeDeterministicWebActionV1({ kind: 'navigate', url: 'https://example.test/path' }), { kind: 'NAVIGATE', url: 'https://example.test/path' });
  assert.throws(() => normalizeDeterministicWebActionV1({ kind: 'navigate', url: 'javascript:alert(1)' }), /protocol/);
  assert.throws(() => normalizeDeterministicWebActionV1({ kind: 'click', selector: '' }), /selector/);
  assert.throws(() => normalizeDeterministicWebActionV1({ kind: 'click', selector: '#ok', surprise: true }), /unknown field/);
});

test('executes only authorized invocation and independently verifies URL postcondition', async () => {
  const calls = [];
  const leaseState = { value: null };
  const p = provider({
    execute: async payload => calls.push(['execute', payload]),
    observe: async payload => { calls.push(['observe', payload]); return { data: { url: 'https://example.test/done' }, artifactRefs: [] }; },
  }, leaseState);
  const result = await p.invoke({ ...fixtures(), targetId: 'tab-7', action: { kind: 'NAVIGATE', url: 'https://example.test/done' }, postcondition: { url: 'https://example.test/done' } });
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.verification.reasonCode, 'URL_MATCH');
  assert.deepEqual(calls.map(([name]) => name), ['execute', 'observe']);
  assert.equal(leaseState.value, null, 'target lease is released after verification');
});

test('fails closed before transport when policy is not ALLOW', async () => {
  let called = false;
  const p = provider({ execute: async () => { called = true; }, observe: async () => ({ data: {} }) });
  const fx = fixtures();
  fx.policyDecision = { ...fx.policyDecision, decision: 'DENY' };
  await assert.rejects(() => p.invoke({ ...fx, targetId: 'tab-1', action: { kind: 'CLICK', selector: '#go' }, postcondition: { selector: '#done' } }), /not authorized/);
  assert.equal(called, false);
});

test('does not mutate a target with a live lease owned by another invocation', async () => {
  let called = false;
  const leaseState = { value: { schemaVersion: 1, targetId: 'tab-1', ownerInvocationId: 'other', leaseId: 'other-lease', acquiredAt: '2026-09-23T15:19:59.000Z', expiresAt: '2026-09-23T15:21:00.000Z' } };
  const p = provider({ execute: async () => { called = true; }, observe: async () => ({ data: {} }) }, leaseState);
  const result = await p.invoke({ ...fixtures(), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#go' }, postcondition: { selector: '#done' } });
  assert.equal(result.status, 'TARGET_CONFLICT');
  assert.equal(called, false);
});

test('post-effect observation failure is AMBIGUOUS and requires reconciliation, never blind retry', async () => {
  const p = provider({ execute: async () => {}, observe: async () => { throw new Error('browser disconnected'); } });
  const result = await p.invoke({ ...fixtures(), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#buy' }, postcondition: { selector: '#receipt' } });
  assert.equal(result.status, 'AMBIGUOUS');
  assert.equal(result.reconcileRequired, true);
  assert.match(result.error, /disconnected/);
});

test('independent verifier fails when expected selector is absent', async () => {
  const p = provider({ execute: async () => {}, observe: async () => ({ data: { visibleSelectors: ['#other'] }, artifactRefs: [] }) });
  const result = await p.invoke({ ...fixtures(), targetId: 'tab-1', action: { kind: 'CLICK', selector: '#go' }, postcondition: { selector: '#done' } });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.verification.reasonCode, 'SELECTOR_NOT_VISIBLE');
});
