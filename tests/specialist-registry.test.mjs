import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentExecutionPlane } from '../src/core/agent-plan.js';
import {
  bindSpecialistHandoffToRegistryV1,
  discoverSpecialistsV1,
  normalizeSpecialistDefinitionV1,
  normalizeSpecialistRegistryV1,
  proposeSpecialistRegistryMutationV1,
  SpecialistRegistryMutationKind,
} from '../src/core/specialist-registry.js';
import {
  OPENHANDS_CODING_PROVIDER_ID,
  OPENHANDS_CODING_SPECIALIST_ID,
} from '../src/core/coding-specialist-provider.js';

const CREATED_AT = '2026-09-27T00:20:00.000Z';

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    specialistId: OPENHANDS_CODING_SPECIALIST_ID,
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    label: 'OpenHands Coding',
    description: 'Bounded coding specialist behind the canonical Agent control plane.',
    executionPlane: AgentExecutionPlane.LOCAL,
    capabilityIds: ['coding.read', 'coding.workspace'],
    toolIds: ['filesystem.read', 'github.read', 'workspace.patch'],
    resultContractId: 'result.coding.workspace.v1',
    enabled: true,
    definitionRevision: 7,
    ...overrides,
  };
}

function researchDefinition(overrides = {}) {
  return definition({
    specialistId: 'research-local',
    providerId: 'mcp-research-provider',
    label: 'Research',
    executionPlane: AgentExecutionPlane.LOCAL,
    capabilityIds: ['research.web'],
    toolIds: ['browser.read', 'files.read'],
    resultContractId: 'result.research.v1',
    definitionRevision: 2,
    ...overrides,
  });
}

function registry(overrides = {}) {
  return {
    schemaVersion: 1,
    registryId: 'specialists:project-1',
    revision: 3,
    definitions: [researchDefinition(), definition()],
    ...overrides,
  };
}

function discovery(overrides = {}) {
  return {
    registry: registry(),
    requiredCapabilityIds: ['coding.workspace'],
    requiredToolIds: ['workspace.patch', 'filesystem.read'],
    parentCapabilityIds: ['coding.read', 'coding.workspace', 'filesystem.archive'],
    parentToolIds: ['workspace.patch', 'filesystem.read', 'github.read'],
    executionPlanes: [AgentExecutionPlane.LOCAL],
    ...overrides,
  };
}

function handoff(overrides = {}) {
  return {
    schemaVersion: 1,
    handoffId: 'handoff-coding-001',
    specialistId: OPENHANDS_CODING_SPECIALIST_ID,
    goal: 'Repair the bounded repository defect and return evidence artifacts.',
    requestedCapabilityIds: ['coding.workspace'],
    artifactRefs: [],
    credentialRefs: [],
    maxModelCalls: 0,
    maxRuntimeSeconds: 600,
    maxCostUsdMicros: 0,
    createdAt: CREATED_AT,
    parentInvocationId: 'invoke-parent-001',
    ...overrides,
  };
}

test('portable registry normalizes deterministically and interoperates with the existing OpenHands specialist identity', () => {
  const normalized = normalizeSpecialistRegistryV1(registry());
  assert.equal(normalized.registryId, 'specialists:project-1');
  assert.deepEqual(normalized.definitions.map(item => item.specialistId), [OPENHANDS_CODING_SPECIALIST_ID, 'research-local']);
  const coding = normalized.definitions[0];
  assert.equal(coding.providerId, OPENHANDS_CODING_PROVIDER_ID);
  assert.equal(coding.executionPlane, AgentExecutionPlane.LOCAL);
  assert.equal(coding.resultContractId, 'result.coding.workspace.v1');
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(coding.capabilityIds));
});

test('discovery grants only requested parent capabilities and explicitly requested tools', () => {
  const result = discoverSpecialistsV1(discovery());
  assert.equal(result.specialists.length, 1);
  const selected = result.specialists[0];
  assert.equal(selected.specialistId, OPENHANDS_CODING_SPECIALIST_ID);
  assert.deepEqual(selected.requestedCapabilityIds, ['coding.workspace']);
  assert.deepEqual(selected.grantedToolIds, ['filesystem.read', 'workspace.patch']);
  assert.equal(selected.grantedToolIds.includes('github.read'), false, 'parent-granted but unrequested tools must not reach the child');
  assert.equal(selected.definitionRevision, 7);
  assert.equal(selected.registryRevision, 3);

  assert.throws(() => discoverSpecialistsV1(discovery({
    requiredCapabilityIds: ['coding.admin'],
  })), /exceeds parent or specialist authority/);

  const noMatch = discoverSpecialistsV1(discovery({
    requiredToolIds: ['browser.read'],
    parentToolIds: ['browser.read'],
  }));
  assert.deepEqual(noMatch.specialists, []);
});

test('binding preserves exact selection provenance and never mints execution or completion authority', () => {
  const request = discovery();
  const selected = discoverSpecialistsV1(request).specialists[0];
  const bound = bindSpecialistHandoffToRegistryV1({
    registry: request.registry,
    selection: selected,
    handoff: handoff(),
    parentCapabilityIds: request.parentCapabilityIds,
    parentToolIds: request.parentToolIds,
  });
  assert.deepEqual(bound.childContext, {
    goal: 'Repair the bounded repository defect and return evidence artifacts.',
    artifactRefs: [],
    credentialRefs: [],
    parentInvocationId: 'invoke-parent-001',
  });
  assert.deepEqual(bound.childScope.capabilityIds, ['coding.workspace']);
  assert.deepEqual(bound.childScope.toolIds, ['filesystem.read', 'workspace.patch']);
  assert.deepEqual(bound.authority, {
    executionAuthorized: false,
    policyAuthorized: false,
    schedulingAuthorized: false,
    recoveryAuthorized: false,
    credentialAuthorized: false,
    completionAuthorized: false,
    verificationAuthorized: false,
  });
  assert.equal(bound.handoff.handoffId, 'handoff-coding-001');
  assert.ok(Object.isFrozen(bound.childContext));
  assert.ok(Object.isFrozen(bound.childScope));
  assert.equal(Object.hasOwn(bound, 'parentContext'), false);
});

test('disabled, removed or revision-drifted specialist definitions fail closed after selection', () => {
  const request = discovery();
  const selected = discoverSpecialistsV1(request).specialists[0];
  const bind = nextRegistry => bindSpecialistHandoffToRegistryV1({
    registry: nextRegistry,
    selection: selected,
    handoff: handoff(),
    parentCapabilityIds: request.parentCapabilityIds,
    parentToolIds: request.parentToolIds,
  });

  assert.throws(() => bind(registry({
    definitions: [researchDefinition(), definition({ enabled: false })],
  })), /missing or disabled/);
  assert.throws(() => bind(registry({
    definitions: [researchDefinition()],
  })), /missing or disabled/);
  assert.throws(() => bind(registry({
    definitions: [researchDefinition(), definition({ definitionRevision: 8 })],
  })), /drifted from current registry definition/);
  assert.throws(() => bind(registry({ revision: 4 })), /registry identity or revision drifted/);
});

test('parent capability or tool-scope drift requires rediscovery instead of widening or silently changing child authority', () => {
  const request = discovery();
  const selected = discoverSpecialistsV1(request).specialists[0];
  const base = {
    registry: request.registry,
    selection: selected,
    handoff: handoff(),
  };

  assert.throws(() => bindSpecialistHandoffToRegistryV1({
    ...base,
    parentCapabilityIds: ['coding.read'],
    parentToolIds: request.parentToolIds,
  }), /exceeds parent or specialist authority/);

  assert.throws(() => bindSpecialistHandoffToRegistryV1({
    ...base,
    parentCapabilityIds: request.parentCapabilityIds,
    parentToolIds: ['workspace.patch'],
  }), /Selected child tools exceeds parent or specialist authority/);

  assert.throws(() => bindSpecialistHandoffToRegistryV1({
    ...base,
    handoff: handoff({ requestedCapabilityIds: ['coding.read'] }),
    parentCapabilityIds: request.parentCapabilityIds,
    parentToolIds: request.parentToolIds,
  }), /capability scope changed after selection/);
});

test('authority subset denial redacts caller-controlled capability and tool IDs without widening grants', () => {
  const secret = 'SECRET_SCOPE_DIAGNOSTIC_PRIVATE_20261010';
  const request = discovery();
  const selected = discoverSpecialistsV1(request).specialists[0];
  const denied = action => {
    assert.throws(action, error => {
      assert.match(error.message, /exceeds parent or specialist authority/);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  };
  denied(() => discoverSpecialistsV1(discovery({
    requiredCapabilityIds: [secret],
  })));
  denied(() => discoverSpecialistsV1(discovery({
    requiredToolIds: [secret],
  })));
  denied(() => bindSpecialistHandoffToRegistryV1({
    registry: request.registry,
    selection: {...selected, grantedToolIds: [secret]},
    handoff: handoff(),
    parentCapabilityIds: request.parentCapabilityIds,
    parentToolIds: request.parentToolIds,
  }));
  const allowed = bindSpecialistHandoffToRegistryV1({
    registry: request.registry,
    selection: selected,
    handoff: handoff(),
    parentCapabilityIds: request.parentCapabilityIds,
    parentToolIds: request.parentToolIds,
  });
  assert.deepEqual(allowed.childScope.toolIds, ['filesystem.read', 'workspace.patch']);
  assert.equal(allowed.authority.executionAuthorized, false);
});

test('registry rejects duplicate identities, numeric aliases, secret-shaped unknown fields and text aliases', () => {
  assert.throws(() => normalizeSpecialistRegistryV1(registry({
    definitions: [definition(), definition()],
  })), /duplicate specialistId/);
  assert.throws(() => normalizeSpecialistRegistryV1(registry({ revision: -0 })), /registry revision is invalid/);
  assert.throws(() => normalizeSpecialistDefinitionV1(definition({ definitionRevision: -0 })), /definitionRevision is invalid/);
  assert.throws(() => normalizeSpecialistDefinitionV1({ ...definition(), apiKey: 'must-never-enter-registry' }), /contains unknown field/);
  assert.throws(() => normalizeSpecialistDefinitionV1(definition({ specialistId: ' openhands-coding' })), /exact canonical identity/);
  assert.throws(() => normalizeSpecialistDefinitionV1(definition({ label: ' OpenHands Coding' })), /exact bounded text/);
});

test('authority records reject accessors and hidden/symbol fields without executing getters', () => {
  let reads = 0;
  const hostile = definition();
  Object.defineProperty(hostile, 'providerId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return OPENHANDS_CODING_PROVIDER_ID;
    },
  });
  assert.throws(() => normalizeSpecialistDefinitionV1(hostile), /providerId must be an enumerable own data property/);
  assert.equal(reads, 0);

  const hidden = definition();
  Object.defineProperty(hidden, 'enabled', { enumerable: false, value: true });
  assert.throws(() => normalizeSpecialistDefinitionV1(hidden), /enabled must be an enumerable own data property/);

  const symbolic = definition();
  symbolic[Symbol('authority')] = true;
  assert.throws(() => normalizeSpecialistDefinitionV1(symbolic), /unknown field/);
});

test('untrusted registry Proxy reflection and secret-shaped keys fail closed with normal recovery', () => {
  const secret = 'SECRET_REGISTRY_PROXY_TRAP_PRIVATE';
  let getterReads = 0;
  const denied = operation => {
    assert.throws(operation, error => {
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /cannot be inspected safely|contains unknown field/);
      return true;
    });
  };
  for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
    const handler = {
      [trap]() {
        throw new Error(secret);
      },
    };
    denied(() => normalizeSpecialistDefinitionV1(new Proxy(definition(), handler)));
    denied(() => normalizeSpecialistDefinitionV1(definition({
      capabilityIds: new Proxy(['coding.workspace'], handler),
    })));
  }

  const unknown = { ...definition(), [secret]: 'must-not-be-echoed' };
  denied(() => normalizeSpecialistDefinitionV1(unknown));
  const accessor = definition();
  Object.defineProperty(accessor, 'specialistId', {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error(secret);
    },
  });
  assert.throws(() => normalizeSpecialistDefinitionV1(accessor), /enumerable own data property/);
  assert.equal(getterReads, 0, 'no hostile accessor may execute');

  const restart = JSON.parse(JSON.stringify(definition()));
  const recovered = normalizeSpecialistDefinitionV1(restart);
  assert.equal(recovered.specialistId, OPENHANDS_CODING_SPECIALIST_ID);
  assert.equal(recovered.enabled, true);
  assert.equal(Object.isFrozen(recovered), true);
});

test('signed-zero Proxy length is rejected without accepting fabricated empty specialist scope; JSON restart remains valid', () => {
  // A Proxy over a mutable empty Array can legally forge its length data
  // descriptor as negative zero. Never normalize that non-canonical authority
  // boundary into an ordinary empty list.
  const forgedEmpty = () => new Proxy([], {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === 'length' ? { ...descriptor, value: -0 } : descriptor;
    },
  });
  assert.equal(Object.is(Object.getOwnPropertyDescriptor(forgedEmpty(), 'length').value, -0), true);
  assert.throws(() => normalizeSpecialistDefinitionV1(definition({
    toolIds: forgedEmpty(),
  })), /toolIds has invalid length/);
  assert.throws(() => normalizeSpecialistRegistryV1(registry({
    definitions: forgedEmpty(),
  })), /definitions has invalid length/);
  assert.throws(() => discoverSpecialistsV1(discovery({
    requiredToolIds: forgedEmpty(),
  })), /requiredToolIds has invalid length/);

  const safeDefinition = normalizeSpecialistDefinitionV1(JSON.parse(JSON.stringify(definition({
    toolIds: [],
  }))));
  assert.deepEqual(safeDefinition.toolIds, []);
  assert.equal(safeDefinition.enabled, true);
  const safeRegistry = normalizeSpecialistRegistryV1(JSON.parse(JSON.stringify(registry({
    definitions: [],
  }))));
  assert.deepEqual(safeRegistry.definitions, []);
  assert.equal(Object.isFrozen(safeRegistry), true);
});

test('null-prototype records are accepted and caller-owned registry inputs remain unchanged', () => {
  const coding = Object.assign(Object.create(null), definition());
  const portable = Object.assign(Object.create(null), registry({ definitions: [coding] }));
  const before = JSON.stringify(portable);
  const normalized = normalizeSpecialistRegistryV1(portable);
  assert.equal(normalized.definitions.length, 1);
  assert.equal(JSON.stringify(portable), before);
  assert.equal(portable.definitions[0].enabled, true);
});


test('registry mutation proposals enforce exact CREATE/UPDATE/DELETE revisions without persistence authority', () => {
  const empty = normalizeSpecialistRegistryV1({
    schemaVersion: 1,
    registryId: 'specialists:mutations',
    revision: 1,
    definitions: [],
  });
  const created = proposeSpecialistRegistryMutationV1({
    registry: empty,
    registryId: 'specialists:mutations',
    expectedRegistryRevision: 1,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: definition({ definitionRevision: 1 }),
  });
  assert.equal(created.nextRegistryRevision, 2);
  assert.equal(created.nextDefinitionRevision, 1);
  assert.equal(created.nextRegistry.definitions[0].definitionRevision, 1);
  assert.equal(created.authority.persistenceAuthorized, false);
  assert.equal(created.authority.executionAuthorized, false);

  const updated = proposeSpecialistRegistryMutationV1({
    registry: created.nextRegistry,
    registryId: 'specialists:mutations',
    expectedRegistryRevision: 2,
    kind: SpecialistRegistryMutationKind.UPDATE,
    specialistId: OPENHANDS_CODING_SPECIALIST_ID,
    expectedDefinitionRevision: 1,
    definition: definition({ label: 'OpenHands Coding v2', definitionRevision: 2 }),
  });
  assert.equal(updated.previousRegistryRevision, 2);
  assert.equal(updated.nextRegistryRevision, 3);
  assert.equal(updated.previousDefinitionRevision, 1);
  assert.equal(updated.nextDefinitionRevision, 2);
  assert.equal(updated.nextRegistry.definitions[0].label, 'OpenHands Coding v2');

  const removed = proposeSpecialistRegistryMutationV1({
    registry: updated.nextRegistry,
    registryId: 'specialists:mutations',
    expectedRegistryRevision: 3,
    kind: SpecialistRegistryMutationKind.DELETE,
    specialistId: OPENHANDS_CODING_SPECIALIST_ID,
    expectedDefinitionRevision: 2,
  });
  assert.equal(removed.nextRegistryRevision, 4);
  assert.equal(removed.nextDefinitionRevision, 0);
  assert.deepEqual(removed.nextRegistry.definitions, []);
});

test('registry mutation proposals fail closed on stale or non-monotonic revisions', () => {
  const current = normalizeSpecialistRegistryV1({
    schemaVersion: 1,
    registryId: 'specialists:cas',
    revision: 9,
    definitions: [definition({ definitionRevision: 4 })],
  });
  assert.throws(() => proposeSpecialistRegistryMutationV1({
    registry: current,
    registryId: 'specialists:cas',
    expectedRegistryRevision: 8,
    kind: SpecialistRegistryMutationKind.DELETE,
    specialistId: OPENHANDS_CODING_SPECIALIST_ID,
    expectedDefinitionRevision: 4,
  }), /registry revision drifted/);

  assert.throws(() => proposeSpecialistRegistryMutationV1({
    registry: current,
    registryId: 'specialists:cas',
    expectedRegistryRevision: 9,
    kind: SpecialistRegistryMutationKind.UPDATE,
    specialistId: OPENHANDS_CODING_SPECIALIST_ID,
    expectedDefinitionRevision: 3,
    definition: definition({ definitionRevision: 5 }),
  }), /definition revision drifted/);

  assert.throws(() => proposeSpecialistRegistryMutationV1({
    registry: current,
    registryId: 'specialists:cas',
    expectedRegistryRevision: 9,
    kind: SpecialistRegistryMutationKind.UPDATE,
    specialistId: OPENHANDS_CODING_SPECIALIST_ID,
    expectedDefinitionRevision: 4,
    definition: definition({ definitionRevision: 6 }),
  }), /increment definitionRevision exactly once/);
});

test('registry mutation snapshots nested definitions without executing accessors', () => {
  let reads = 0;
  const hostile = definition({ definitionRevision: 1 });
  Object.defineProperty(hostile, 'toolIds', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return ['filesystem.read'];
    },
  });
  const current = normalizeSpecialistRegistryV1({
    schemaVersion: 1,
    registryId: 'specialists:hostile',
    revision: 1,
    definitions: [],
  });
  assert.throws(() => proposeSpecialistRegistryMutationV1({
    registry: current,
    registryId: 'specialists:hostile',
    expectedRegistryRevision: 1,
    kind: SpecialistRegistryMutationKind.CREATE,
    definition: hostile,
  }), /toolIds must be an enumerable own data property/);
  assert.equal(reads, 0);
});


test('specialist owner-facing metadata fails closed on bidi, hidden control and non-durable UTF-16', () => {
  for (const [field, forged] of [
    ['label', 'QA\u202Erelease'],
    ['label', 'Research\nDifferent specialist'],
    ['label', 'Coder\u200Bhidden'],
    ['description', 'Safe description\rForged decision'],
    ['description', 'Hidden\u2066isolate'],
    ['description', 'Broken high surrogate \uD800'],
    ['label', 'Broken low surrogate \uDC00'],
  ]) {
    assert.throws(
      () => normalizeSpecialistDefinitionV1(definition({ [field]: forged })),
      /must be exact bounded text/,
      field + ' must not publish spoofable or non-durable owner-visible text',
    );
  }
  const restored = JSON.parse(JSON.stringify(definition({
    label: 'QA — valid emoji 🙂',
    description: 'First line\nSecond line with legitimate Unicode: Україна',
  })));
  const accepted = normalizeSpecialistDefinitionV1(restored);
  assert.equal(accepted.label, restored.label);
  assert.equal(accepted.description, restored.description);
  assert.equal(accepted.enabled, true);
  assert.equal(accepted.definitionRevision, restored.definitionRevision);
});


test('specialist metadata rejects Arabic Letter Mark and Unicode line separator spoofing', () => {
  // U+061C is the Arabic Letter Mark (an invisible bidi control). U+2028 and
  // U+2029 render as line breaks without being literal permitted newlines.
  for (const field of ['label', 'description']) {
    for (const invisible of ['\u061C', '\u2028', '\u2029']) {
      const forged = 'Qualified' + invisible + 'Untrusted';
      assert.throws(
        () => normalizeSpecialistDefinitionV1(definition({ [field]: forged })),
        /must be exact bounded text/,
        field + ' must reject owner-facing spoofing controls',
      );
    }
  }

  // Ordinary Arabic script and explicit description line breaks are valid.
  const persisted = JSON.parse(JSON.stringify(definition({
    label: 'QA — العربية Україна',
    description: 'First line\nSecond line — العربية',
  })));
  const recovered = normalizeSpecialistDefinitionV1(persisted);
  assert.equal(recovered.label, persisted.label);
  assert.equal(recovered.description, persisted.description);
  assert.equal(recovered.enabled, true);
});
