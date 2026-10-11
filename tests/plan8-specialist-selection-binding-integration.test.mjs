import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSpecialistSelectionV1 } from '../src/core/specialist-registry.js';

const base = Object.freeze({
  schemaVersion: 1,
  registryId: 'registry:plan8',
  registryRevision: 1,
  specialistId: 'specialist:one',
  providerId: 'provider:one',
  definitionRevision: 1,
  executionPlane: 'LOCAL',
  requestedCapabilityIds: ['filesystem.write'],
  grantedToolIds: [],
  resultContractId: 'contract:result',
});

test('Plan 8 integration: optional durable registry binding survives exact selection and JSON restart', () => {
  const normalized = normalizeSpecialistSelectionV1({
    ...base,
    registryBindingKey: 'registry-binding:v1',
  });
  assert.equal(normalized.registryBindingKey, 'registry-binding:v1');
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(normalized.registryBindingKey,
    normalizeSpecialistSelectionV1(JSON.parse(JSON.stringify(normalized))).registryBindingKey);
  const legacy = normalizeSpecialistSelectionV1(base);
  assert.equal(Object.hasOwn(legacy, 'registryBindingKey'), false,
    'legacy selection must not invent a registry binding authority');
});

test('Plan 8 integration: forged registry binding values and getters fail closed', () => {
  for (const registryBindingKey of [null, undefined, false, 0, '', '  registry-binding:v1', {}, 'bad key']) {
    assert.throws(() => normalizeSpecialistSelectionV1({
      ...base, registryBindingKey,
    }), /registryBindingKey/u);
  }
  let getterCalls = 0;
  const hostile = { ...base };
  Object.defineProperty(hostile, 'registryBindingKey', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('secret value'); },
  });
  assert.throws(() => normalizeSpecialistSelectionV1(hostile), /data property/u);
  assert.equal(getterCalls, 0, 'untrusted getters must not run');
});

import { SpecialistProviderReadinessResolverV1 } from '../src/core/specialist-provider-readiness-resolver.js';

test('Plan 8 integration: trusted readiness preserves optional registry binding across JSON restart', async () => {
  const requests = [];
  const resolver = new SpecialistProviderReadinessResolverV1({
    bindings: [{
      providerId: 'provider:one',
      maxAgeMs: 5000,
      resolveReadiness: async request => {
        requests.push(request);
        throw new Error('fixture: no network probe permitted');
      },
    }],
    now: () => Date.parse('2026-10-10T12:00:00.000Z'),
  });
  const bound = normalizeSpecialistSelectionV1({
    ...base, registryBindingKey: 'registry-binding:v1',
  });
  await assert.rejects(resolver.resolve(JSON.parse(JSON.stringify(bound))), /fixture: no network probe/u);
  assert.equal(requests[0].registryBindingKey, 'registry-binding:v1');
  assert.equal(Object.isFrozen(requests[0]), true);

  const legacy = normalizeSpecialistSelectionV1(base);
  await assert.rejects(resolver.resolve(JSON.parse(JSON.stringify(legacy))), /fixture: no network probe/u);
  assert.equal(Object.hasOwn(requests[1], 'registryBindingKey'), false,
    'legacy readiness must not invent a binding or silently insert undefined');
  assert.equal(requests.length, 2);
});
