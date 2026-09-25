import assert from 'node:assert/strict';
import test from 'node:test';
import { createChromeDeterministicWebProviderV1, createChromeDeterministicWebReconcileVerifierV1 } from '../src/core/deterministic-web-chrome-runtime.js';
const at = '2026-09-24T16:50:00.000Z';
function auth(invocationId) { return { toolDescriptor: { schemaVersion: 1, toolId: 'web.action', providerId: 'deterministic-web', label: 'Web action', description: '', capabilityIds: ['web.general'], inputSchemaRef: null, outputSchemaRef: null, readOnly: false }, invocation: { schemaVersion: 1, invocationId, toolId: 'web.action', providerId: 'deterministic-web', requestedCapabilityIds: ['web.general'], policyDecisionId: `decision-${invocationId}`, arguments: {}, createdAt: at, parentInvocationId: null }, policyDecision: { schemaVersion: 1, decisionId: `decision-${invocationId}`, invocationId, decision: 'ALLOW', reasonCode: 'OWNER_POLICY', reason: '', approvalId: null, decidedAt: at }, grantedCapabilityIds: ['web.general'] }; }

test('accepted navigation with stale first readback remains fenced until fresh reconciliation', async () => {
  const storage = {}; const updates = []; let settled = false; const oldUrl = 'https://example.test/old'; const newUrl = 'https://example.test/new';
  const chromeApi = {
    permissions: { async contains() { return true; } },
    storage: { local: { async get(key) { return key in storage ? { [key]: structuredClone(storage[key]) } : {}; }, async set(record) { Object.assign(storage, structuredClone(record)); } } },
    tabs: { async get(id) { return { id, url: settled ? newUrl : oldUrl, status: settled ? 'complete' : 'loading' }; }, async update(id, update) { updates.push([id, structuredClone(update)]); return { id, ...update, status: 'loading' }; } },
    scripting: { async executeScript() { return [{ result: { url: settled ? newUrl : oldUrl, readyState: settled ? 'complete' : 'loading', visibleSelectors: [] } }]; } },
  };
  const verifier = createChromeDeterministicWebReconcileVerifierV1(chromeApi, { now: () => at });
  const provider = createChromeDeterministicWebProviderV1({ chromeApi, reconcileVerify: verifier, now: () => at, leaseId: () => 'navigation-lease' });
  const first = await provider.invoke({ ...auth('nav-1'), targetId: 'tab:7', action: { kind: 'NAVIGATE', url: newUrl }, postcondition: { url: newUrl } });
  assert.equal(first.status, 'AMBIGUOUS'); assert.equal(first.reconcileRequired, true); assert.equal(first.verification.reasonCode, 'URL_MISMATCH'); assert.equal(first.effectState.phase, 'RECONCILE'); assert.equal(updates.length, 1); assert.equal(storage['autopilot.deterministicWebRuntime.v1'].leasesByTargetId['tab:7'].ownerInvocationId, 'nav-1');
  const competing = await provider.invoke({ ...auth('nav-2'), targetId: 'tab:7', action: { kind: 'NAVIGATE', url: 'https://example.test/other' }, postcondition: { url: 'https://example.test/other' } });
  assert.equal(competing.status, 'TARGET_CONFLICT'); assert.equal(updates.length, 1, 'competing navigation must not dispatch while first navigation is unresolved');
  settled = true; const reconciled = await provider.reconcile({ invocationId: 'nav-1', outcome: 'VERIFIED' });
  assert.equal(reconciled.phase, 'COMMITTED'); assert.equal(storage['autopilot.deterministicWebRuntime.v1'].leasesByTargetId['tab:7'], null);
});
