import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentProviderId } from '../src/core/capability-registry.js';
import { InteractionProviderRouter } from '../src/core/interaction-provider-router.js';

function readyTransport(calls = []) {
  return {
    async execute(tabId, request) {
      calls.push({ tabId, request });
      return { status: 'READY' };
    },
  };
}

test('router delegates current ChatGPT browser provider without changing request', async () => {
  const calls = [];
  const router = new InteractionProviderRouter().register(
    AgentProviderId.CHATGPT_BROWSER,
    readyTransport(calls),
  );
  const request = { providerId: AgentProviderId.CHATGPT_BROWSER, mode: 'CHECK_ONLY' };
  assert.deepEqual(await router.execute(42, request), { status: 'READY' });
  assert.deepEqual(calls, [{ tabId: 42, request }]);
});

test('router uses its validated default only when providerId is absent', async () => {
  const calls = [];
  const router = new InteractionProviderRouter().register(
    AgentProviderId.CHATGPT_BROWSER,
    readyTransport(calls),
  );
  const request = { mode: 'CHECK_ONLY' };
  assert.deepEqual(await router.execute(17, request), { status: 'READY' });
  assert.deepEqual(calls, [{ tabId: 17, request }]);

  await assert.rejects(
    () => router.execute(17, { providerId: '', mode: 'CHECK_ONLY' }),
    /exact canonical text representation/,
  );
  assert.equal(calls.length, 1);
});

test('router fails closed for unsupported or unregistered provider', async () => {
  const router = new InteractionProviderRouter();
  await assert.rejects(() => router.execute(1, { providerId: 'future-provider' }), /Unsupported agent provider/);
  await assert.rejects(() => router.execute(1, { providerId: AgentProviderId.CHATGPT_BROWSER }), /No interaction transport registered/);
});

test('router never canonicalizes provider aliases at construction, registration, lookup or execution', async () => {
  const alias = ` ${AgentProviderId.CHATGPT_BROWSER}`;
  assert.throws(
    () => new InteractionProviderRouter({ defaultProviderId: alias }),
    /exact canonical text representation/,
  );

  const calls = [];
  const router = new InteractionProviderRouter();
  assert.throws(
    () => router.register(alias, readyTransport(calls)),
    /exact canonical text representation/,
  );

  router.register(AgentProviderId.CHATGPT_BROWSER, readyTransport(calls));
  assert.equal(router.has(AgentProviderId.CHATGPT_BROWSER), true);
  assert.equal(router.has(alias), false);

  await assert.rejects(
    () => router.execute(5, { providerId: alias }),
    /exact canonical text representation/,
  );
  assert.equal(calls.length, 0);
});

test('router rejects coercive provider identities without invoking coercion', async () => {
  let coercions = 0;
  const coercive = {
    toString() {
      coercions += 1;
      return AgentProviderId.CHATGPT_BROWSER;
    },
  };
  const calls = [];
  const router = new InteractionProviderRouter().register(
    AgentProviderId.CHATGPT_BROWSER,
    readyTransport(calls),
  );

  assert.equal(router.has(coercive), false);
  await assert.rejects(
    () => router.execute(6, { providerId: coercive }),
    /exact canonical text representation/,
  );
  assert.equal(coercions, 0);
  assert.equal(calls.length, 0);
});

test('router reads providerId only from an own enumerable data descriptor', async () => {
  let getterReads = 0;
  const calls = [];
  const router = new InteractionProviderRouter().register(
    AgentProviderId.CHATGPT_BROWSER,
    readyTransport(calls),
  );

  const accessorRequest = {};
  Object.defineProperty(accessorRequest, 'providerId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return AgentProviderId.CHATGPT_BROWSER;
    },
  });
  await assert.rejects(
    () => router.execute(7, accessorRequest),
    /own enumerable data property/,
  );
  assert.equal(getterReads, 0);

  const hiddenRequest = {};
  Object.defineProperty(hiddenRequest, 'providerId', {
    enumerable: false,
    value: AgentProviderId.CHATGPT_BROWSER,
  });
  await assert.rejects(
    () => router.execute(7, hiddenRequest),
    /own enumerable data property/,
  );

  const inheritedRequest = Object.create({ providerId: AgentProviderId.CHATGPT_BROWSER });
  inheritedRequest.mode = 'CHECK_ONLY';
  await assert.rejects(
    () => router.execute(7, inheritedRequest),
    /own enumerable data property/,
  );

  const symbolRequest = { [Symbol('providerId')]: AgentProviderId.CHATGPT_BROWSER };
  await assert.rejects(
    () => router.execute(7, symbolRequest),
    /canonical string field/,
  );

  assert.equal(calls.length, 0);
});
