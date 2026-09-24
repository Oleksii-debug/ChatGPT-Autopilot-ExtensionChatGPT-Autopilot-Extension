import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createChromeDeterministicWebProviderV1,
  createChromeDeterministicWebStoreV1,
  createChromeDeterministicWebTransportV1,
  normalizeChromeDeterministicWebTargetV1,
} from '../src/core/deterministic-web-chrome-runtime.js';

const at = '2026-09-24T15:55:00.000Z';

function chromeFixture() {
  const storage = {};
  const calls = [];
  return {
    storage,
    calls,
    chrome: {
      storage: { local: {
        async get(key) { return key in storage ? { [key]: structuredClone(storage[key]) } : {}; },
        async set(record) { Object.assign(storage, structuredClone(record)); },
      } },
      tabs: {
        async get(id) { return { id, url: 'https://example.test/start' }; },
        async update(id, update) { calls.push(['navigate', id, update]); return { id, ...update }; },
      },
      scripting: {
        async executeScript(request) {
          calls.push(['script', request.target.tabId, request.args || []]);
          if ((request.args || [])[0] === 'CLICK') return [{ result: { ok: true } }];
          return [{ result: { url: 'https://example.test/start', visibleSelectors: ['#ready'] } }];
        },
      },
    },
  };
}

function invocationFixtures(invocationId = 'chrome-runtime-invocation') {
  return {
    toolDescriptor: {
      schemaVersion: 1,
      toolId: 'web.action',
      providerId: 'deterministic-web',
      label: 'Web action',
      description: '',
      capabilityIds: ['web.general'],
      inputSchemaRef: null,
      outputSchemaRef: null,
      readOnly: false,
    },
    invocation: {
      schemaVersion: 1,
      invocationId,
      toolId: 'web.action',
      providerId: 'deterministic-web',
      requestedCapabilityIds: ['web.general'],
      policyDecisionId: `decision-${invocationId}`,
      arguments: {},
      createdAt: at,
      parentInvocationId: null,
    },
    policyDecision: {
      schemaVersion: 1,
      decisionId: `decision-${invocationId}`,
      invocationId,
      decision: 'ALLOW',
      reasonCode: 'OWNER_POLICY',
      reason: '',
      approvalId: null,
      decidedAt: at,
    },
    grantedCapabilityIds: ['web.general'],
  };
}

test('durable store serializes competing updates without losing target ownership', async () => {
  const fixture = chromeFixture();
  const store = createChromeDeterministicWebStoreV1(fixture.chrome);
  await Promise.all([
    store.update(async draft => { await Promise.resolve(); draft.leasesByTargetId['tab:1'] = { leaseId: 'a' }; }),
    store.update(draft => { draft.effectsById.effectB = { state: 'prepared' }; }),
  ]);
  const saved = fixture.storage['autopilot.deterministicWebRuntime.v1'];
  assert.equal(saved.leasesByTargetId['tab:1'].leaseId, 'a');
  assert.equal(saved.effectsById.effectB.state, 'prepared');
});

test('Chrome transport binds navigation and scripted actions to exact tab target', async () => {
  const fixture = chromeFixture();
  const transport = createChromeDeterministicWebTransportV1(fixture.chrome);
  await transport.execute({ targetId: 'tab:7', action: { kind: 'NAVIGATE', url: 'https://example.test/next' } });
  await transport.execute({ targetId: 'tab:7', action: { kind: 'CLICK', selector: '#go' } });
  const observation = await transport.observe({ targetId: 'tab:7' });
  assert.deepEqual(fixture.calls[0], ['navigate', 7, { url: 'https://example.test/next' }]);
  assert.deepEqual(fixture.calls[1], ['script', 7, ['CLICK', '#go', '']]);
  assert.equal(observation.data.url, 'https://example.test/start');
  assert.deepEqual(observation.data.visibleSelectors, ['#ready']);
  assert.deepEqual(observation.artifactRefs, []);
});

test('Chrome runtime interoperates with canonical provider through VERIFIED to durable COMMITTED', async () => {
  const fixture = chromeFixture();
  const provider = createChromeDeterministicWebProviderV1({
    chromeApi: fixture.chrome,
    now: () => at,
    leaseId: () => 'chrome-runtime-lease',
  });
  const result = await provider.invoke({
    ...invocationFixtures(),
    targetId: 'tab:7',
    action: { kind: 'CLICK', selector: '#go' },
    postcondition: { selector: '#ready' },
  });
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.verification.reasonCode, 'SELECTOR_VISIBLE');
  const saved = fixture.storage['autopilot.deterministicWebRuntime.v1'];
  assert.equal(saved.effectsById['chrome-runtime-invocation'].state.phase, 'COMMITTED');
  assert.equal(saved.leasesByTargetId['tab:7'], null);
});

test('Chrome target identity is one canonical positive safe-integer spelling', () => {
  assert.deepEqual(normalizeChromeDeterministicWebTargetV1('tab:7'), { targetId: 'tab:7', tabId: 7 });
  for (const targetId of ['window:7', 'tab:007', 'tab:0', 'tab:-1', 'tab:9007199254740992']) {
    assert.throws(() => normalizeChromeDeterministicWebTargetV1(targetId), /canonical tab:<positive-safe-integer>/);
  }
});

test('Chrome transport rejects aliased and non-safe tab identities before Chrome dispatch', async () => {
  const fixture = chromeFixture();
  const transport = createChromeDeterministicWebTransportV1(fixture.chrome);
  await assert.rejects(() => transport.observe({ targetId: 'tab:007' }), /canonical tab:<positive-safe-integer>/);
  await assert.rejects(() => transport.execute({ targetId: 'tab:9007199254740992', action: { kind: 'CLICK', selector: '#go' } }), /canonical tab:<positive-safe-integer>/);
  assert.deepEqual(fixture.calls, []);
});

test('provider rejects aliased tab identity before durable lease admission or physical dispatch', () => {
  const fixture = chromeFixture();
  const provider = createChromeDeterministicWebProviderV1({
    chromeApi: fixture.chrome,
    now: () => at,
    leaseId: () => 'must-not-be-used',
  });
  assert.throws(() => provider.invoke({
    ...invocationFixtures('alias-invocation'),
    targetId: 'tab:007',
    action: { kind: 'CLICK', selector: '#go' },
    postcondition: { selector: '#ready' },
  }), /canonical tab:<positive-safe-integer>/);
  assert.equal(fixture.storage['autopilot.deterministicWebRuntime.v1'], undefined);
  assert.deepEqual(fixture.calls, []);
});


test('persisted malformed web journal fails closed instead of being replaced with a fresh effect store', async t => {
  const storageKey = 'autopilot.deterministicWebRuntime.v1';
  const malformedRecords = [
    null,
    [],
    'corrupt',
    { schemaVersion: 1, effectsById: {}, leasesByTargetId: null },
    { schemaVersion: 1, effectsById: [], leasesByTargetId: {} },
    { schemaVersion: 1, effectsById: {}, leasesByTargetId: {}, unexpected: true },
  ];

  for (const [index, malformed] of malformedRecords.entries()) {
    await t.test(`malformed persisted record ${index + 1}`, async () => {
      const fixture = chromeFixture();
      fixture.storage[storageKey] = structuredClone(malformed);
      const before = structuredClone(fixture.storage[storageKey]);
      const provider = createChromeDeterministicWebProviderV1({
        chromeApi: fixture.chrome,
        now: () => at,
        leaseId: () => 'must-not-be-used',
      });

      await assert.rejects(() => provider.invoke({
        ...invocationFixtures(`corrupt-journal-${index + 1}`),
        targetId: 'tab:7',
        action: { kind: 'CLICK', selector: '#go' },
        postcondition: { selector: '#ready' },
      }), /storage|effectsById|leasesByTargetId/);

      assert.deepEqual(fixture.storage[storageKey], before, 'corrupt durable evidence must not be overwritten');
      assert.deepEqual(fixture.calls, [], 'corrupt journal must fail before physical browser dispatch');
    });
  }
});

test('absence of the web journal key is the only state that initializes a fresh durable store', async () => {
  const fixture = chromeFixture();
  const store = createChromeDeterministicWebStoreV1(fixture.chrome);
  await store.update(draft => {
    draft.effectsById.fresh = { state: 'prepared' };
  });
  const saved = fixture.storage['autopilot.deterministicWebRuntime.v1'];
  assert.equal(saved.schemaVersion, 1);
  assert.deepEqual(saved.effectsById.fresh, { state: 'prepared' });
  assert.deepEqual(saved.leasesByTargetId, {});
});
