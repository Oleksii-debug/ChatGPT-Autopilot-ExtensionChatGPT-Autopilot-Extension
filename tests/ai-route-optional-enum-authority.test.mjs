import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAiRoutePolicy,
  normalizeAiRoutePool,
  normalizeAiWorkerPolicy,
} from '../src/core/ai-route-pool.js';

const baseRoute = Object.freeze({
  routeId:'local-default',
  provider:'ollama',
  model:'local',
});

for (const malformed of [false, 0, '', null]) {
  test(`present route locality alias ${JSON.stringify(malformed)} fails closed`, () => {
    assert.throws(
      () => normalizeAiRoutePool([{ ...baseRoute, locality:malformed }]),
      /AI route locality is invalid/u,
    );
  });

  test(`present route costClass alias ${JSON.stringify(malformed)} fails closed`, () => {
    assert.throws(
      () => normalizeAiRoutePool([{ ...baseRoute, costClass:malformed }]),
      /AI route costClass is invalid/u,
    );
  });

  test(`present route-policy locality alias ${JSON.stringify(malformed)} fails closed`, () => {
    assert.throws(
      () => normalizeAiRoutePolicy({ locality:malformed }),
      /AI route policy locality is invalid/u,
    );
  });

  test(`present worker allocationMode alias ${JSON.stringify(malformed)} fails closed`, () => {
    assert.throws(
      () => normalizeAiWorkerPolicy({ allocationMode:malformed }, [baseRoute]),
      /AI worker allocationMode is invalid/u,
    );
  });
}

test('optional enum authorities reject padded canonical-value aliases', () => {
  assert.throws(
    () => normalizeAiRoutePool([{ ...baseRoute, locality:' local ' }]),
    /AI route locality is invalid/u,
  );
  assert.throws(
    () => normalizeAiRoutePool([{ ...baseRoute, costClass:' free ' }]),
    /AI route costClass is invalid/u,
  );
  assert.throws(
    () => normalizeAiRoutePolicy({ locality:' any ' }),
    /AI route policy locality is invalid/u,
  );
  assert.throws(
    () => normalizeAiWorkerPolicy({ allocationMode:' manual ' }, [baseRoute]),
    /AI worker allocationMode is invalid/u,
  );
});

test('absent and explicit-undefined optional enums preserve canonical defaults', () => {
  const [omittedRoute] = normalizeAiRoutePool([baseRoute]);
  const [undefinedRoute] = normalizeAiRoutePool([{
    ...baseRoute,
    locality:undefined,
    costClass:undefined,
  }]);
  assert.equal(omittedRoute.locality, 'local');
  assert.equal(omittedRoute.costClass, 'free');
  assert.equal(undefinedRoute.locality, 'local');
  assert.equal(undefinedRoute.costClass, 'free');

  assert.equal(normalizeAiRoutePolicy({}).locality, 'any');
  assert.equal(normalizeAiRoutePolicy({ locality:undefined }).locality, 'any');
  assert.equal(normalizeAiWorkerPolicy({}, [baseRoute]).allocationMode, 'auto');
  assert.equal(normalizeAiWorkerPolicy({ allocationMode:undefined }, [baseRoute]).allocationMode, 'auto');
});

test('canonical exact optional enum values remain accepted', () => {
  const [remotePaid] = normalizeAiRoutePool([{
    routeId:'remote-paid',
    provider:'openai',
    model:'strong',
    locality:'remote',
    costClass:'paid',
    inputPricePerMillionUsd:0,
    outputPricePerMillionUsd:0,
  }]);
  assert.equal(remotePaid.locality, 'remote');
  assert.equal(remotePaid.costClass, 'paid');
  assert.equal(normalizeAiRoutePolicy({ locality:'local' }).locality, 'local');
  assert.equal(normalizeAiWorkerPolicy({ allocationMode:'manual' }, [baseRoute]).allocationMode, 'manual');
});
