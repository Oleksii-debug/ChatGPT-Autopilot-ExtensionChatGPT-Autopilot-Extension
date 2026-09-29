import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSpecialistDefinitionV1 } from '../src/core/specialist-registry.js';
import { buildSpecialistDefinitionFromFormV1 } from '../src/ui/specialist-definition-form.js';

function form(overrides = {}) {
  return {
    specialistId: 'specialist.coding',
    providerId: 'openhands',
    label: 'Coding specialist',
    description: 'Bounded coding specialist',
    executionPlane: 'LOCAL',
    capabilityIdsText: 'code.edit\ncode.test',
    toolIdsText: 'filesystem.write\ngithub.read',
    resultContractId: 'result.code-change.v1',
    enabled: true,
    ...overrides,
  };
}

test('builds canonical SpecialistDefinitionV1 and sorts identity sets', () => {
  const definition = buildSpecialistDefinitionFromFormV1(form({
    capabilityIdsText: 'z.capability\na.capability',
    toolIdsText: 'z.tool\na.tool',
  }), { definitionRevision: 3 });
  assert.deepEqual(definition, {
    schemaVersion: 1,
    specialistId: 'specialist.coding',
    providerId: 'openhands',
    label: 'Coding specialist',
    description: 'Bounded coding specialist',
    executionPlane: 'LOCAL',
    capabilityIds: ['a.capability', 'z.capability'],
    toolIds: ['a.tool', 'z.tool'],
    resultContractId: 'result.code-change.v1',
    enabled: true,
    definitionRevision: 3,
  });
  assert.deepEqual(normalizeSpecialistDefinitionV1(definition), definition);
});

test('requires at least one capability but allows an empty tool set', () => {
  assert.throws(
    () => buildSpecialistDefinitionFromFormV1(form({ capabilityIdsText: '' })),
    /щонайменше 1/,
  );
  const definition = buildSpecialistDefinitionFromFormV1(form({ toolIdsText: '' }));
  assert.deepEqual(definition.toolIds, []);
});

test('rejects unsupported planes, non-canonical identities and duplicates', () => {
  assert.throws(
    () => buildSpecialistDefinitionFromFormV1(form({ executionPlane: 'local' })),
    /Execution plane не підтримується/,
  );
  assert.throws(
    () => buildSpecialistDefinitionFromFormV1(form({ providerId: ' provider' })),
    /канонічним ID/,
  );
  assert.throws(
    () => buildSpecialistDefinitionFromFormV1(form({ resultContractId: 'result contract' })),
    /канонічним ID/,
  );
  assert.throws(
    () => buildSpecialistDefinitionFromFormV1(form({ capabilityIdsText: 'code.edit\ncode.edit' })),
    /дублікат/,
  );
});

test('rejects aliases, overlong text and invalid revisions before Core mutation', () => {
  assert.throws(
    () => buildSpecialistDefinitionFromFormV1(form({ label: ' label' })),
    /канонічним текстом/,
  );
  assert.throws(
    () => buildSpecialistDefinitionFromFormV1(form({ description: 'x'.repeat(4001) })),
    /канонічним текстом/,
  );
  assert.throws(
    () => buildSpecialistDefinitionFromFormV1(form(), { definitionRevision: 0 }),
    /додатним цілим/,
  );
});

test('form admission never executes accessor-backed authority fields', () => {
  let reads = 0;
  const input = form();
  Object.defineProperty(input, 'executionPlane', {
    enumerable: true,
    get() { reads += 1; return 'LOCAL'; },
  });
  assert.throws(
    () => buildSpecialistDefinitionFromFormV1(input),
    /data property/,
  );
  assert.equal(reads, 0);
});

test('rejects exotic form prototypes and preserves explicit disabled state', () => {
  const exotic = Object.create({ executionPlane: 'LOCAL' });
  Object.assign(exotic, form());
  delete exotic.executionPlane;
  assert.throws(
    () => buildSpecialistDefinitionFromFormV1(exotic),
    /data object/,
  );

  const definition = buildSpecialistDefinitionFromFormV1(form({ enabled: false }));
  assert.equal(definition.enabled, false);
});


test('rejects non-boolean enabled aliases instead of coercing them to disabled', () => {
  assert.throws(
    () => buildSpecialistDefinitionFromFormV1(form({ enabled: 'false' })),
    /Enabled має бути boolean/,
  );
});
