import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_DEFINITION_BINDING_VERSION,
  normalizeAgentDefinitionV1,
  normalizeAgentDefinitionCatalogV1,
  instantiateAgentDefinitionV1,
} from '../src/core/agent-definition.js';

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    definitionId: 'research-agent',
    revision: 3,
    name: 'Research Agent',
    description: 'Reusable research configuration',
    goal: 'Research the requested topic and verify the result.',
    policy: {
      approvalMode: 'consequential',
      acceptanceCriteria: ['The requested outcome is visibly verified'],
      aiPinnedRouteId: 'mistral-agent',
      maxModelCalls: 12,
      maxRuntimeMinutes: 30,
      maxCostUsd: 2,
      inputPricePerMillionUsd: 1,
      outputPricePerMillionUsd: 2,
    },
    tags: ['research', 'verified'],
    enabled: true,
    ...overrides,
  };
}

function catalog(definitions = [definition()]) {
  return {
    schemaVersion: 1,
    catalogId: 'owner-agent-catalog',
    revision: 7,
    definitions,
  };
}

test('reusable Agent definition canonicalizes through Browser Agent policy without runtime or credentials', () => {
  const normalized = normalizeAgentDefinitionV1(definition());
  assert.equal(normalized.definitionId, 'research-agent');
  assert.equal(normalized.revision, 3);
  assert.equal(normalized.policy.aiPinnedRouteId, 'mistral-agent');
  assert.equal(normalized.policy.maxModelCalls, 12);
  assert.deepEqual(normalized.policy.acceptanceCriteria, ['The requested outcome is visibly verified']);
  assert.equal(Object.hasOwn(normalized.policy, 'runtime'), false);
  assert.equal(Object.hasOwn(normalized.policy, 'credentialRef'), false);
  assert.equal(Object.hasOwn(normalized.policy, 'projectId'), false);
  assert.equal(Object.hasOwn(normalized.policy, 'goal'), false);
  assert.equal(Object.hasOwn(normalized.policy, 'id'), false);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.policy));
  assert.ok(Object.isFrozen(normalized.policy.acceptanceCriteria));
});

test('definition catalog ordering is deterministic and duplicate identities fail closed', () => {
  const second = definition({
    definitionId: 'browser-agent',
    revision: 1,
    name: 'Browser Agent',
    goal: '',
    tags: ['browser'],
  });
  const normalized = normalizeAgentDefinitionCatalogV1(catalog([definition(), second]));
  assert.deepEqual(normalized.definitions.map(item => item.definitionId), ['browser-agent', 'research-agent']);
  assert.throws(
    () => normalizeAgentDefinitionCatalogV1(catalog([definition(), definition({ revision: 4 })])),
    /duplicate definitionId/,
  );
});

test('instantiation binds exact catalog and definition revision into a fresh canonical job config', () => {
  const source = catalog();
  const bound = instantiateAgentDefinitionV1({
    catalog: source,
    definitionId: 'research-agent',
    expectedDefinitionRevision: 3,
    jobId: 'job-42',
    projectId: 'project-1',
    name: 'Quarterly research',
    goal: 'Research the current release blockers.',
  });
  assert.equal(bound.schemaVersion, AGENT_DEFINITION_BINDING_VERSION);
  assert.deepEqual(bound.definitionRef, {
    catalogId: 'owner-agent-catalog',
    catalogRevision: 7,
    definitionId: 'research-agent',
    definitionRevision: 3,
  });
  assert.equal(bound.config.id, 'job-42');
  assert.equal(bound.config.projectId, 'project-1');
  assert.equal(bound.config.name, 'Quarterly research');
  assert.equal(bound.config.goal, 'Research the current release blockers.');
  assert.equal(bound.config.aiPinnedRouteId, 'mistral-agent');
  assert.equal(bound.config.maxModelCalls, 12);
  assert.equal(bound.config.maxRuntimeMinutes, 30);
  assert.ok(Object.isFrozen(bound));
  assert.ok(Object.isFrozen(bound.definitionRef));
  assert.ok(Object.isFrozen(bound.config));
  assert.equal(source.definitions[0].policy.maxModelCalls, 12, 'caller input is not mutated');
});

test('stale, missing, disabled and goal-less definitions cannot instantiate', () => {
  assert.throws(() => instantiateAgentDefinitionV1({
    catalog: catalog(),
    definitionId: 'research-agent',
    expectedDefinitionRevision: 2,
    jobId: 'job-1',
  }), /revision drifted/);
  assert.throws(() => instantiateAgentDefinitionV1({
    catalog: catalog(),
    definitionId: 'missing-agent',
    expectedDefinitionRevision: 1,
    jobId: 'job-1',
  }), /missing or disabled/);
  assert.throws(() => instantiateAgentDefinitionV1({
    catalog: catalog([definition({ enabled: false })]),
    definitionId: 'research-agent',
    expectedDefinitionRevision: 3,
    jobId: 'job-1',
  }), /missing or disabled/);
  assert.throws(() => instantiateAgentDefinitionV1({
    catalog: catalog([definition({ goal: '' })]),
    definitionId: 'research-agent',
    expectedDefinitionRevision: 3,
    jobId: 'job-1',
  }), /requires a goal/);
});

test('portable definition rejects credential, runtime and unknown policy fields', () => {
  for (const field of ['credentialRef', 'apiKey', 'runtime', 'cookies', 'token']) {
    const policy = { ...definition().policy, [field]: 'secret-or-runtime-state' };
    assert.throws(() => normalizeAgentDefinitionV1(definition({ policy })), /unknown field/);
  }
  assert.throws(
    () => normalizeAgentDefinitionV1({ ...definition(), runtime: { state: 'RUNNING' } }),
    /unknown field/,
  );
});

test('descriptor-safe admission executes no hostile Agent definition getters', () => {
  let reads = 0;
  const hostile = definition();
  Object.defineProperty(hostile, 'policy', {
    enumerable: true,
    get() {
      reads += 1;
      return {};
    },
  });
  assert.throws(() => normalizeAgentDefinitionV1(hostile), /enumerable own data property/);
  assert.equal(reads, 0);

  const nested = definition();
  const rule = Object.create(null);
  Object.defineProperty(rule, 'origin', {
    enumerable: true,
    get() {
      reads += 1;
      return 'https://example.com';
    },
  });
  nested.policy = { ...nested.policy, siteRules: [rule] };
  assert.throws(() => normalizeAgentDefinitionV1(nested), /enumerable own data property/);
  assert.equal(reads, 0);
});

test('symbols, sparse arrays, signed zero and exotic objects fail before becoming reusable authority', () => {
  const withSymbol = definition();
  withSymbol.policy = { ...withSymbol.policy };
  withSymbol.policy[Symbol('secret')] = 'hidden';
  assert.throws(() => normalizeAgentDefinitionV1(withSymbol), /unknown field/);

  const sparse = definition();
  sparse.tags = new Array(2);
  sparse.tags[1] = 'research';
  assert.throws(() => normalizeAgentDefinitionV1(sparse), /enumerable own data property/);

  assert.throws(
    () => normalizeAgentDefinitionV1(definition({ revision: -0 })),
    /revision.*invalid/,
  );

  const exotic = definition();
  exotic.policy = new (class Policy {})();
  assert.throws(() => normalizeAgentDefinitionV1(exotic), /plain data object/);
});

test('null-prototype definitions and policy remain portable after canonicalization', () => {
  const raw = Object.assign(Object.create(null), definition());
  raw.policy = Object.assign(Object.create(null), definition().policy);
  const normalized = normalizeAgentDefinitionV1(raw);
  assert.equal(normalized.definitionId, 'research-agent');
  assert.equal(normalized.policy.aiPinnedRouteId, 'mistral-agent');
});
