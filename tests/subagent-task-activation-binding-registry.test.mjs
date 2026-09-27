import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OrchestrationActivationPurpose,
  compactOrchestrationEventId,
} from '../src/core/orchestration-hierarchy.js';
import {
  MAX_SUBAGENT_TASK_ACTIVATION_BINDINGS,
  MAX_SUBAGENT_TASK_ACTIVATION_BINDINGS_PER_TASK,
  SUBAGENT_TASK_ACTIVATION_BINDING_REGISTRY_AUTHORITY,
  createSubagentTaskActivationBindingRegistryV1,
  normalizeSubagentTaskActivationBindingRegistryV1,
  putSubagentTaskActivationBindingV1,
  resolveSubagentTaskActivationBindingForActivationV1,
  resolveSubagentTaskActivationBindingV1,
} from '../src/core/subagent-task-activation-binding-registry.js';

const BOUND = '2026-09-27T18:00:00.000Z';
const REGISTERED = '2026-09-27T18:00:01.000Z';

function binding(overrides = {}) {
  const value = {
    schemaVersion: 1,
    projectId: 'project-1',
    parentAgentId: 'parent-1',
    childAgentId: 'child-1',
    taskId: 'task-1',
    taskEnvelopeId: 'envelope-1',
    planId: 'plan-1',
    planRevision: 3,
    outcomeContractId: 'outcome-1',
    outcomeContractRevision: 1,
    invocationId: 'invocation-1',
    controlEpoch: 7,
    activationId: 'activation-1',
    generation: 1,
    activationPurpose: OrchestrationActivationPurpose.WORK,
    boundAt: BOUND,
    ...overrides,
  };
  value.bindingId = compactOrchestrationEventId(
    'subagent-task-activation-binding',
    value.projectId,
    value.parentAgentId,
    value.childAgentId,
    value.taskId,
    value.taskEnvelopeId,
    value.planId,
    String(value.planRevision),
    value.outcomeContractId,
    String(value.outcomeContractRevision),
    String(value.controlEpoch),
    value.activationId,
    String(value.generation),
    value.activationPurpose,
    value.invocationId,
  );
  if (Object.hasOwn(overrides, 'bindingId')) value.bindingId = overrides.bindingId;
  return value;
}

function append(registry, value = binding(), registeredAt = REGISTERED) {
  return putSubagentTaskActivationBindingV1(registry, {
    binding: value,
    registeredAt,
  });
}

test('empty activation-binding registry is canonical append-only restart state', () => {
  const registry = createSubagentTaskActivationBindingRegistryV1();
  assert.deepEqual(registry, { schemaVersion: 1, revision: 0, records: [] });
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(registry.records), true);
  assert.deepEqual(normalizeSubagentTaskActivationBindingRegistryV1(registry), registry);
});

test('append persists exact binding and resolves by binding ID and current activation coordinates', () => {
  const value = binding();
  const registry = append(createSubagentTaskActivationBindingRegistryV1(), value);
  assert.equal(registry.revision, 1);
  assert.equal(registry.records.length, 1);
  assert.equal(Object.isFrozen(registry.records[0]), true);
  assert.equal(Object.isFrozen(registry.records[0].binding), true);

  assert.deepEqual(
    resolveSubagentTaskActivationBindingV1(registry, { bindingId: value.bindingId }),
    registry.records[0].binding,
  );
  assert.deepEqual(
    resolveSubagentTaskActivationBindingForActivationV1(registry, {
      projectId: value.projectId,
      childAgentId: value.childAgentId,
      controlEpoch: value.controlEpoch,
      activationId: value.activationId,
      generation: value.generation,
    }),
    registry.records[0].binding,
  );
  assert.equal(
    resolveSubagentTaskActivationBindingV1(
      registry,
      { bindingId: binding({ taskId: 'missing' }).bindingId },
    ),
    null,
  );
});

test('exact append replay is idempotent and preserves first registration chronology', () => {
  const value = binding();
  const once = append(createSubagentTaskActivationBindingRegistryV1(), value);
  const replay = append(once, structuredClone(value), '2026-09-27T18:05:00.000Z');
  assert.equal(replay, once);
  assert.equal(replay.revision, 1);
  assert.equal(replay.records[0].registeredAt, REGISTERED);
});

test('binding ID cannot be reused with divergent boundAt even though boundAt is not part of identity hash', () => {
  const value = binding();
  const registry = append(createSubagentTaskActivationBindingRegistryV1(), value);
  const divergent = binding({ boundAt: '2026-09-27T18:00:00.500Z' });
  assert.equal(divergent.bindingId, value.bindingId);
  assert.throws(
    () => append(registry, divergent, '2026-09-27T18:05:00.000Z'),
    /Divergent subagent task activation bindingId collision/u,
  );
});

test('one activation cannot be rebound to another task even with a fresh invocation ID', () => {
  const first = binding();
  const registry = append(createSubagentTaskActivationBindingRegistryV1(), first);
  const rebound = binding({
    taskId: 'task-2',
    taskEnvelopeId: 'envelope-2',
    invocationId: 'invocation-2',
  });
  assert.notEqual(rebound.bindingId, first.bindingId);
  assert.throws(
    () => append(registry, rebound, '2026-09-27T18:05:00.000Z'),
    /activation cannot be rebound/u,
  );
});

test('one child invocation ID cannot be rebound to another activation or task', () => {
  const first = binding();
  const registry = append(createSubagentTaskActivationBindingRegistryV1(), first);
  const rebound = binding({
    activationId: 'activation-2',
    generation: 2,
    taskId: 'task-2',
    taskEnvelopeId: 'envelope-2',
  });
  assert.notEqual(rebound.bindingId, first.bindingId);
  assert.throws(
    () => append(registry, rebound, '2026-09-27T18:05:00.000Z'),
    /invocationId cannot be rebound/u,
  );
});

test('same task may accumulate bounded retry generations with unique activation and invocation identities', () => {
  let registry = createSubagentTaskActivationBindingRegistryV1();
  for (let index = 0; index < MAX_SUBAGENT_TASK_ACTIVATION_BINDINGS_PER_TASK; index += 1) {
    registry = append(
      registry,
      binding({
        activationId: 'activation-' + (index + 1),
        generation: index + 1,
        invocationId: 'invocation-' + (index + 1),
        boundAt: '2026-09-27T18:' + String(index).padStart(2, '0') + ':00.000Z',
      }),
      '2026-09-27T18:' + String(index).padStart(2, '0') + ':30.000Z',
    );
  }
  assert.equal(registry.revision, MAX_SUBAGENT_TASK_ACTIVATION_BINDINGS_PER_TASK);
  assert.throws(
    () => append(
      registry,
      binding({
        activationId: 'activation-overflow',
        generation: MAX_SUBAGENT_TASK_ACTIVATION_BINDINGS_PER_TASK + 1,
        invocationId: 'invocation-overflow',
        boundAt: '2026-09-27T18:40:00.000Z',
      }),
      '2026-09-27T18:40:30.000Z',
    ),
    /history limit exceeded/u,
  );
});

test('registration cannot predate boundAt or regress across durable owner history', () => {
  const later = binding({ boundAt: '2026-09-27T18:10:00.000Z' });
  assert.throws(
    () => append(
      createSubagentTaskActivationBindingRegistryV1(),
      later,
      '2026-09-27T18:09:59.999Z',
    ),
    /cannot predate boundAt/u,
  );

  const registry = append(
    createSubagentTaskActivationBindingRegistryV1(),
    binding(),
    '2026-09-27T18:20:00.000Z',
  );
  assert.throws(
    () => append(
      registry,
      binding({
        activationId: 'activation-2',
        generation: 2,
        invocationId: 'invocation-2',
        boundAt: '2026-09-27T18:10:00.000Z',
      }),
      '2026-09-27T18:19:59.999Z',
    ),
    /chronology cannot regress/u,
  );
});

test('restart normalization rejects duplicate IDs, activation rebinding, invocation rebinding and revision drift', () => {
  const first = binding();
  const second = binding({
    activationId: 'activation-2',
    generation: 2,
    invocationId: 'invocation-2',
    boundAt: '2026-09-27T18:01:00.000Z',
  });
  let registry = append(createSubagentTaskActivationBindingRegistryV1(), first, REGISTERED);
  registry = append(registry, second, '2026-09-27T18:01:01.000Z');

  const revision = structuredClone(registry);
  revision.revision = 99;
  assert.throws(
    () => normalizeSubagentTaskActivationBindingRegistryV1(revision),
    /revision must equal append-only record count/u,
  );

  const duplicateId = structuredClone(registry);
  duplicateId.records[1].binding = structuredClone(duplicateId.records[0].binding);
  assert.throws(
    () => normalizeSubagentTaskActivationBindingRegistryV1(duplicateId),
    /duplicate bindingId/u,
  );

  const activationRebind = structuredClone(registry);
  activationRebind.records[1].binding = binding({
    taskId: 'task-2',
    taskEnvelopeId: 'envelope-2',
    invocationId: 'invocation-x',
  });
  assert.throws(
    () => normalizeSubagentTaskActivationBindingRegistryV1(activationRebind),
    /activation is rebound/u,
  );

  const invocationRebind = structuredClone(registry);
  invocationRebind.records[1].binding = binding({
    activationId: 'activation-x',
    generation: 2,
  });
  assert.throws(
    () => normalizeSubagentTaskActivationBindingRegistryV1(invocationRebind),
    /invocationId is rebound/u,
  );
});

test('registry and read boundaries reject sparse/decorated arrays, accessors and unknown authority fields without getter reads', () => {
  const sparse = {
    schemaVersion: 1,
    revision: 1,
    records: new Array(1),
  };
  assert.throws(
    () => normalizeSubagentTaskActivationBindingRegistryV1(sparse),
    /dense and data-only|enumerable own data property/u,
  );

  const decoratedRecords = [];
  decoratedRecords.extra = binding();
  assert.throws(
    () => normalizeSubagentTaskActivationBindingRegistryV1({
      schemaVersion: 1,
      revision: 0,
      records: decoratedRecords,
    }),
    /dense and data-only/u,
  );

  let reads = 0;
  const request = { binding: binding(), registeredAt: REGISTERED };
  Object.defineProperty(request, 'registeredAt', {
    enumerable: true,
    get() {
      reads += 1;
      return REGISTERED;
    },
  });
  assert.throws(
    () => putSubagentTaskActivationBindingV1(
      createSubagentTaskActivationBindingRegistryV1(),
      request,
    ),
    /registeredAt.*enumerable own data property/u,
  );
  assert.equal(reads, 0);

  assert.throws(
    () => resolveSubagentTaskActivationBindingV1(
      createSubagentTaskActivationBindingRegistryV1(),
      { bindingId: binding().bindingId, completionAuthority: true },
    ),
    /unknown field/u,
  );
});

test('global registry bound rejects oversized durable arrays before record traversal', () => {
  assert.throws(
    () => normalizeSubagentTaskActivationBindingRegistryV1({
      schemaVersion: 1,
      revision: MAX_SUBAGENT_TASK_ACTIVATION_BINDINGS + 1,
      records: new Array(MAX_SUBAGENT_TASK_ACTIVATION_BINDINGS + 1).fill(null),
    }),
    /invalid length/u,
  );
});

test('registry is state evidence only and grants no persistence, execution, completion or verification authority', () => {
  assert.equal(
    SUBAGENT_TASK_ACTIVATION_BINDING_REGISTRY_AUTHORITY.appendOnlyBindingHistory,
    true,
  );
  assert.equal(
    SUBAGENT_TASK_ACTIVATION_BINDING_REGISTRY_AUTHORITY.ownerStateProjectionOnly,
    true,
  );
  for (const key of [
    'persistenceAuthorized',
    'executionAuthorized',
    'schedulingAuthorized',
    'completionAuthorized',
    'verificationAuthorized',
    'policyAuthorized',
    'credentialAuthorized',
    'recoveryAuthorized',
  ]) {
    assert.equal(SUBAGENT_TASK_ACTIVATION_BINDING_REGISTRY_AUTHORITY[key], false, key);
  }
  assert.equal(Object.isFrozen(SUBAGENT_TASK_ACTIVATION_BINDING_REGISTRY_AUTHORITY), true);
});
