import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindSpecialistHandoffToRegistryV1,
  createEmptySpecialistRegistryV1,
  normalizeSpecialistDefinitionV1,
  normalizeSpecialistRegistryV1,
  putSpecialistDefinitionV1,
  selectSpecialistCandidatesV1,
} from '../src/core/agent-specialist-registry.js';

function specialist(overrides = {}) {
  return {
    schemaVersion:1,
    specialistId:'coding.primary',
    providerId:'provider.local',
    label:'Coding specialist',
    enabled:true,
    priority:100,
    maxConcurrentAssignments:2,
    capabilityIds:['code.edit', 'code.test'],
    taskKinds:['CODING'],
    ...overrides,
  };
}

function handoff(overrides = {}) {
  return {
    schemaVersion:1,
    handoffId:'handoff.1',
    specialistId:'coding.primary',
    goal:'Implement and verify the requested change.',
    requestedCapabilityIds:['code.edit'],
    artifactRefs:[],
    credentialRefs:[],
    maxModelCalls:10,
    maxRuntimeSeconds:600,
    maxCostUsdMicros:0,
    createdAt:'2026-09-29T00:00:00.000Z',
    parentInvocationId:null,
    ...overrides,
  };
}

function registryWith(...definitions) {
  let registry = createEmptySpecialistRegistryV1();
  for (const definition of definitions) {
    registry = putSpecialistDefinitionV1({
      registry,
      expectedRevision:registry.revision,
      definition,
    });
  }
  return registry;
}

test('specialist registry persists canonical immutable definitions', () => {
  const registry = registryWith(specialist({ capabilityIds:['code.test', 'code.edit'] }));
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.revision, 1);
  assert.deepEqual(registry.specialists[0].capabilityIds, ['code.edit', 'code.test']);
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry.specialists));
  assert.ok(Object.isFrozen(registry.specialists[0]));
});

test('exact replay is idempotent and does not consume a new revision', () => {
  const first = registryWith(specialist());
  const replay = putSpecialistDefinitionV1({
    registry:first,
    expectedRevision:first.revision,
    definition:specialist(),
  });
  assert.strictEqual(replay, first);
  assert.equal(replay.revision, 1);
});

test('divergent update requires current CAS revision and increments it exactly once', () => {
  const first = registryWith(specialist());
  assert.throws(() => putSpecialistDefinitionV1({
    registry:first,
    expectedRevision:0,
    definition:specialist({ priority:200 }),
  }), /SPECIALIST_REGISTRY_REVISION_CONFLICT/);
  const second = putSpecialistDefinitionV1({
    registry:first,
    expectedRevision:1,
    definition:specialist({ priority:200 }),
  });
  assert.equal(second.revision, 2);
  assert.equal(second.specialists[0].priority, 200);
});

test('selection is deterministic, capability-bound and advisory only', () => {
  const registry = registryWith(
    specialist({ specialistId:'coding.secondary', priority:100 }),
    specialist({ specialistId:'coding.primary', priority:200 }),
    specialist({
      specialistId:'research.primary',
      providerId:'provider.cloud',
      label:'Research specialist',
      priority:999,
      capabilityIds:['research.web'],
      taskKinds:['RESEARCH'],
    }),
  );
  const selection = selectSpecialistCandidatesV1({
    registry,
    taskKind:'CODING',
    requiredCapabilityIds:['code.test'],
  });
  assert.equal(selection.schemaVersion, 1);
  assert.deepEqual(selection.candidateSpecialistIds, ['coding.primary', 'coding.secondary']);
  assert.equal(selection.advisoryOnly, true);
  assert.equal(selection.specialistSelectionAuthorized, false);
  assert.equal(selection.handoffAuthorized, false);
  assert.equal(selection.executionAuthorized, false);
  assert.equal(selection.providerCallAuthorized, false);
  assert.equal(selection.credentialUseAuthorized, false);
  assert.equal(selection.policyDecisionGranted, false);
  assert.equal(selection.persistenceAuthorized, false);
  assert.equal(selection.schedulingAuthorized, false);
  assert.equal(selection.completionAuthorized, false);
  assert.equal(selection.verificationAuthorized, false);
  assert.equal(selection.requiresCanonicalSpecialistHandoff, true);
  assert.equal(selection.requiresCurrentPolicyRevalidation, true);
  assert.equal(selection.requiresCurrentBudgetRevalidation, true);
});

test('owner/provider filters only narrow candidate discovery', () => {
  const registry = registryWith(
    specialist({ specialistId:'coding.local', providerId:'provider.local', priority:100 }),
    specialist({ specialistId:'coding.cloud', providerId:'provider.cloud', priority:200 }),
  );
  const selection = selectSpecialistCandidatesV1({
    registry,
    taskKind:'CODING',
    requiredCapabilityIds:['code.edit'],
    allowedSpecialistIds:['coding.cloud', 'coding.local'],
    allowedProviderIds:['provider.local'],
  });
  assert.deepEqual(selection.candidateSpecialistIds, ['coding.local']);
});

test('disabled or task/capability-incompatible specialists cannot be selected', () => {
  const registry = registryWith(
    specialist({ specialistId:'disabled', enabled:false, priority:999 }),
    specialist({ specialistId:'missing-capability', capabilityIds:['code.edit'], priority:900 }),
    specialist({ specialistId:'wrong-task', taskKinds:['RESEARCH'], priority:800 }),
    specialist({ specialistId:'valid', priority:1 }),
  );
  const selection = selectSpecialistCandidatesV1({
    registry,
    taskKind:'CODING',
    requiredCapabilityIds:['code.edit', 'code.test'],
  });
  assert.deepEqual(selection.candidateSpecialistIds, ['valid']);
});

test('canonical SpecialistHandoffV1 binds to exact registry revision and capability scope', () => {
  const registry = registryWith(specialist());
  const binding = bindSpecialistHandoffToRegistryV1({
    registry,
    expectedRegistryRevision:registry.revision,
    handoff:handoff({ requestedCapabilityIds:['code.test', 'code.edit'] }),
    allowedSpecialistIds:['coding.primary'],
    allowedProviderIds:['provider.local'],
  });
  assert.equal(binding.schemaVersion, 1);
  assert.equal(binding.registryRevision, 1);
  assert.equal(binding.handoffId, 'handoff.1');
  assert.equal(binding.specialistId, 'coding.primary');
  assert.equal(binding.providerId, 'provider.local');
  assert.deepEqual(binding.requestedCapabilityIds, ['code.test', 'code.edit']);
  assert.equal(binding.canonicalSpecialistHandoffValidated, true);
  assert.equal(binding.advisoryOnly, true);
  assert.equal(binding.handoffAuthorized, false);
  assert.equal(binding.executionAuthorized, false);
  assert.equal(binding.providerCallAuthorized, false);
  assert.equal(binding.credentialUseAuthorized, false);
  assert.equal(binding.requiresCurrentPolicyRevalidation, true);
  assert.equal(binding.requiresCurrentBudgetRevalidation, true);
  assert.equal(binding.requiresCurrentCredentialScopeRevalidation, true);
});

test('handoff binding fails closed on stale registry, disabled specialist, filter exclusion and capability widening', () => {
  const registry = registryWith(specialist());
  assert.throws(() => bindSpecialistHandoffToRegistryV1({
    registry,
    expectedRegistryRevision:0,
    handoff:handoff(),
  }), /SPECIALIST_HANDOFF_REGISTRY_REVISION_CONFLICT/);
  assert.throws(() => bindSpecialistHandoffToRegistryV1({
    registry:registryWith(specialist({ enabled:false })),
    expectedRegistryRevision:1,
    handoff:handoff(),
  }), /SPECIALIST_HANDOFF_SPECIALIST_DISABLED/);
  assert.throws(() => bindSpecialistHandoffToRegistryV1({
    registry,
    expectedRegistryRevision:1,
    handoff:handoff(),
    allowedProviderIds:['provider.other'],
  }), /SPECIALIST_PROVIDER_NOT_ALLOWED/);
  assert.throws(() => bindSpecialistHandoffToRegistryV1({
    registry,
    expectedRegistryRevision:1,
    handoff:handoff({ requestedCapabilityIds:['code.deploy'] }),
  }), /Specialist handoff exceeds granted capabilities/);
});

test('registry identities compose with canonical SpecialistHandoffV1 ID rules', () => {
  assert.throws(
    () => normalizeSpecialistDefinitionV1(specialist({ specialistId:'bad id' })),
    /SPECIALIST_ID_INVALID/,
  );
  assert.throws(
    () => normalizeSpecialistDefinitionV1(specialist({ providerId:' provider.local' })),
    /SPECIALIST_PROVIDER_ID_INVALID/,
  );
  assert.throws(
    () => normalizeSpecialistDefinitionV1(specialist({ capabilityIds:['code edit'] })),
    /SPECIALIST_CAPABILITY_IDS_0_INVALID/,
  );
  assert.throws(
    () => selectSpecialistCandidatesV1({
      registry:registryWith(specialist()),
      taskKind:'CODING',
      requiredCapabilityIds:[],
    }),
    /SPECIALIST_SELECTION_REQUIRED_CAPABILITY_IDS_EMPTY/,
  );
});

test('definition normalization rejects authority aliases and unknown fields', () => {
  assert.throws(
    () => normalizeSpecialistDefinitionV1({ ...specialist(), executionAuthorized:true }),
    /SPECIALIST_DEFINITION_UNKNOWN_FIELD/,
  );
  assert.throws(
    () => normalizeSpecialistDefinitionV1({ ...specialist(), credentialRef:'secret' }),
    /SPECIALIST_DEFINITION_UNKNOWN_FIELD/,
  );
});

test('duplicate and signed-zero canonical aliases fail closed', () => {
  assert.throws(
    () => normalizeSpecialistDefinitionV1(specialist({ capabilityIds:['code.edit', 'code.edit'] })),
    /SPECIALIST_CAPABILITY_IDS_DUPLICATE/,
  );
  assert.throws(
    () => normalizeSpecialistDefinitionV1(specialist({ priority:-0 })),
    /SPECIALIST_PRIORITY_INVALID/,
  );
  assert.throws(
    () => normalizeSpecialistRegistryV1({ schemaVersion:1, revision:-0, specialists:[] }),
    /SPECIALIST_REGISTRY_REVISION_INVALID/,
  );
});

test('sparse and decorated arrays fail closed', () => {
  const sparse = new Array(1);
  assert.throws(
    () => normalizeSpecialistDefinitionV1(specialist({ capabilityIds:sparse })),
    /SPECIALIST_CAPABILITY_IDS_ARRAY_DENSE_REQUIRED/,
  );
  const decorated = ['code.edit'];
  decorated.extra = true;
  assert.throws(
    () => normalizeSpecialistDefinitionV1(specialist({ capabilityIds:decorated })),
    /SPECIALIST_CAPABILITY_IDS_ARRAY_DECORATED/,
  );
});

test('hostile accessors are rejected without getter execution', () => {
  let getterRuns = 0;
  const hostile = specialist();
  Object.defineProperty(hostile, 'providerId', {
    enumerable:true,
    get() {
      getterRuns += 1;
      return 'provider.evil';
    },
  });
  assert.throws(() => normalizeSpecialistDefinitionV1(hostile), /SPECIALIST_DEFINITION_DATA_FIELD_REQUIRED/);
  assert.equal(getterRuns, 0);
});

test('selection and handoff binding reject caller authority injection', () => {
  const registry = registryWith(specialist());
  assert.throws(() => selectSpecialistCandidatesV1({
    registry,
    taskKind:'CODING',
    requiredCapabilityIds:['code.edit'],
    executionAuthorized:true,
  }), /SPECIALIST_SELECTION_UNKNOWN_FIELD/);
  assert.throws(() => selectSpecialistCandidatesV1({
    registry,
    taskKind:' CODING',
    requiredCapabilityIds:['code.edit'],
  }), /SPECIALIST_SELECTION_TASK_KIND_INVALID/);
  assert.throws(() => bindSpecialistHandoffToRegistryV1({
    registry,
    expectedRegistryRevision:1,
    handoff:handoff(),
    executionAuthorized:true,
  }), /SPECIALIST_HANDOFF_BINDING_UNKNOWN_FIELD/);
});
