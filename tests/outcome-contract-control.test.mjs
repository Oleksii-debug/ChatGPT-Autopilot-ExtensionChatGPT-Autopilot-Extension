import test from 'node:test';
import assert from 'node:assert/strict';

import { CoreCommandDispatcher } from '../src/core/commands.js';
import {
  createStoredOutcomeContractV1,
  deleteStoredOutcomeContractV1,
  listStoredOutcomeContractsV1,
  normalizeOutcomeContractRegistryV1,
  resolveStoredOutcomeContractV1,
  resolveCanonicalStoredOutcomeContractV1,
  updateStoredOutcomeContractV1,
} from '../src/core/outcome-contract-control.js';
import { createOutcomeContractV1, normalizeOutcomeContractV1 } from '../src/core/outcome-contract.js';
import { createEmptyState, validateState, STORAGE_KEY } from '../src/core/schema.js';
import { StorageRepository } from '../src/core/storage.js';
import { CoreCommand } from '../src/shared/protocol.js';

const CREATED_AT = '2026-09-29T04:00:00.000Z';

function buildInput(overrides = {}) {
  return {
    contractId: 'outcome-1',
    projectId: 'project-1',
    desiredResult: 'Deliver a verified reusable Agent outcome.',
    completionCriteria: [{
      criterionId: 'criterion-1',
      description: 'The intended product result is observable.',
      observable: 'Inspect canonical product evidence.',
      requiredEvidenceKinds: ['test-report'],
    }],
    constraints: ['Do not create a second scheduler.'],
    sourceTruth: [{
      sourceId: 'source-main',
      location: 'github://owner/repo/main',
      revisionId: 'source-r1',
      purpose: 'Canonical implementation truth.',
    }],
    allowedAuthority: [{
      authorityId: 'authority-repo',
      scopeId: 'scope-project-1',
      purpose: 'Required repository mutation authority.',
    }],
    budgetBoundaries: {
      maxModelCalls: 20,
      maxRuntimeSeconds: 3600,
      maxCostUsdMicros: 2_000_000,
      maxConcurrency: 2,
    },
    deliverables: [{
      deliverableId: 'deliverable-1',
      kind: 'code-change',
      description: 'Verified implementation.',
      criterionIds: ['criterion-1'],
    }],
    verifierPlan: {
      planId: 'verify-1',
      actorId: 'agent-actor',
      verifierId: 'agent-verifier',
      criterionIds: ['criterion-1'],
      requiredEvidenceArtifactCount: 1,
      independent: true,
    },
    triggerRefs: [],
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function contractV1(overrides = {}) {
  return createOutcomeContractV1(buildInput(overrides));
}

function nextContract(current, overrides = {}) {
  return normalizeOutcomeContractV1({
    ...structuredClone(current),
    ...overrides,
    revision: current.revision + 1,
  });
}

function fakeChrome(initial = undefined) {
  const data = initial === undefined ? {} : structuredClone(initial);
  return {
    data,
    storage: {
      local: {
        async get(key) {
          return { [key]: data[key] === undefined ? undefined : structuredClone(data[key]) };
        },
        async set(value) {
          for (const [key, entry] of Object.entries(value)) data[key] = structuredClone(entry);
        },
      },
    },
  };
}

test('durable OutcomeContract registry creates, resolves, lists, updates and deletes with exact revision CAS', () => {
  const state = createEmptyState(1);
  const created = createStoredOutcomeContractV1(state, contractV1());

  assert.equal(created.contractId, 'outcome-1');
  assert.equal(created.projectId, 'project-1');
  assert.equal(created.revision, 1);
  assert.equal(created.advisoryOnly, true);
  assert.equal(created.ownerAccepted, false);
  assert.equal(created.executionAuthorized, false);

  assert.deepEqual(
    listStoredOutcomeContractsV1(state, { projectId: 'project-1' }).map(item => item.contractId),
    ['outcome-1'],
  );
  assert.deepEqual(
    resolveStoredOutcomeContractV1(state, {
      projectId: 'project-1',
      contractId: 'outcome-1',
      expectedRevision: 1,
    }),
    created,
  );

  assert.throws(() => createStoredOutcomeContractV1(state, contractV1()), /already exists/);
  assert.throws(
    () => resolveStoredOutcomeContractV1(state, {
      projectId: 'project-other',
      contractId: 'outcome-1',
      expectedRevision: 1,
    }),
    /project binding mismatch/,
  );
  assert.throws(
    () => resolveStoredOutcomeContractV1(state, {
      projectId: 'project-1',
      contractId: 'outcome-1',
      expectedRevision: 2,
    }),
    /revision binding mismatch/,
  );

  const revised = nextContract(created, { desiredResult: 'Deliver revision two with exact proof.' });
  const updated = updateStoredOutcomeContractV1(state, {
    projectId: 'project-1',
    contractId: 'outcome-1',
    expectedRevision: 1,
    contract: revised,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.desiredResult, 'Deliver revision two with exact proof.');

  assert.throws(
    () => updateStoredOutcomeContractV1(state, {
      projectId: 'project-1',
      contractId: 'outcome-1',
      expectedRevision: 1,
      contract: revised,
    }),
    /revision binding mismatch/,
  );

  assert.throws(
    () => deleteStoredOutcomeContractV1(state, {
      projectId: 'project-1',
      contractId: 'outcome-1',
      expectedRevision: 1,
    }),
    /revision binding mismatch/,
  );
  const deleted = deleteStoredOutcomeContractV1(state, {
    projectId: 'project-1',
    contractId: 'outcome-1',
    expectedRevision: 2,
  });
  assert.equal(deleted.revision, 2);
  assert.deepEqual(listStoredOutcomeContractsV1(state, { projectId: 'project-1' }), []);
});

test('canonical verifier resolver matches the existing contractId/contractRevision bridge shape without dropping project binding', () => {
  const state = createEmptyState(1);
  const created = createStoredOutcomeContractV1(state, contractV1());

  const resolved = resolveCanonicalStoredOutcomeContractV1(state, {
    contractId: 'outcome-1',
    contractRevision: 1,
  });
  assert.deepEqual(resolved, created);
  assert.equal(resolved.projectId, 'project-1');
  assert.equal(resolved.advisoryOnly, true);
  assert.equal(resolved.executionAuthorized, false);

  assert.equal(resolveCanonicalStoredOutcomeContractV1(state, {
    contractId: 'outcome-missing',
    contractRevision: 1,
  }), null);
  assert.throws(
    () => resolveCanonicalStoredOutcomeContractV1(state, {
      contractId: 'outcome-1',
      contractRevision: 2,
    }),
    /revision binding mismatch/,
  );
});

test('contract identity, creation time and revision progression are immutable under update', () => {
  const state = createEmptyState(1);
  const current = createStoredOutcomeContractV1(state, contractV1());

  assert.throws(
    () => updateStoredOutcomeContractV1(state, {
      projectId: 'project-1',
      contractId: 'outcome-1',
      expectedRevision: 1,
      contract: normalizeOutcomeContractV1({
        ...structuredClone(current),
        contractId: 'outcome-other',
        revision: 2,
      }),
    }),
    /contractId is immutable/,
  );

  assert.throws(
    () => updateStoredOutcomeContractV1(state, {
      projectId: 'project-1',
      contractId: 'outcome-1',
      expectedRevision: 1,
      contract: normalizeOutcomeContractV1({
        ...structuredClone(current),
        projectId: 'project-other',
        revision: 2,
      }),
    }),
    /projectId is immutable/,
  );

  assert.throws(
    () => updateStoredOutcomeContractV1(state, {
      projectId: 'project-1',
      contractId: 'outcome-1',
      expectedRevision: 1,
      contract: normalizeOutcomeContractV1({
        ...structuredClone(current),
        createdAt: '2026-09-29T04:00:01.000Z',
        revision: 2,
      }),
    }),
    /createdAt is immutable/,
  );

  assert.throws(
    () => updateStoredOutcomeContractV1(state, {
      projectId: 'project-1',
      contractId: 'outcome-1',
      expectedRevision: 1,
      contract: current,
    }),
    /advance revision by exactly one/,
  );
});

test('registry and lookup boundaries reject shaped accessors without executing getters', () => {
  let getterCalls = 0;
  const state = createEmptyState(1);
  createStoredOutcomeContractV1(state, contractV1());

  const lookup = { contractId: 'outcome-1', expectedRevision: 1 };
  Object.defineProperty(lookup, 'projectId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'project-1';
    },
  });
  assert.throws(() => resolveStoredOutcomeContractV1(state, lookup), /enumerable own data properties/);
  assert.equal(getterCalls, 0);

  const registry = {};
  Object.defineProperty(registry, 'outcome-1', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return contractV1();
    },
  });
  assert.throws(() => normalizeOutcomeContractRegistryV1(registry), /enumerable own data properties/);
  assert.equal(getterCalls, 0);
});

test('legacy schema-v2 state without OutcomeContract registry remains valid and reads as empty', async () => {
  const legacy = createEmptyState(1);
  delete legacy.outcomeContractsById;
  assert.equal(validateState(legacy), legacy);

  const chrome = fakeChrome({ [STORAGE_KEY]: legacy });
  const repository = new StorageRepository(chrome);
  const loaded = await repository.load();
  assert.deepEqual(listStoredOutcomeContractsV1(loaded, { projectId: 'project-1' }), []);
});

test('corrupt persisted OutcomeContract fails canonical state load', async () => {
  const state = createEmptyState(1);
  state.outcomeContractsById['outcome-1'] = {
    ...structuredClone(contractV1()),
    executionAuthorized: true,
  };
  const repository = new StorageRepository(fakeChrome({ [STORAGE_KEY]: state }));
  await assert.rejects(repository.load(), /cannot grant execution authority/);
});

test('Core commands persist canonical OutcomeContracts across restart and return detached clones', async () => {
  const chrome = fakeChrome();
  const repository = new StorageRepository(chrome);
  const dispatcher = new CoreCommandDispatcher(repository, () => 1000);
  const initial = contractV1();

  const created = await dispatcher.execute(CoreCommand.CREATE_OUTCOME_CONTRACT, { contract: initial });
  assert.deepEqual(created.contract, initial);

  created.contract.desiredResult = 'caller mutation';
  const exact = await dispatcher.execute(CoreCommand.GET_OUTCOME_CONTRACT, {
    projectId: 'project-1',
    contractId: 'outcome-1',
    expectedRevision: 1,
  });
  assert.equal(exact.contract.desiredResult, initial.desiredResult);

  const restarted = new CoreCommandDispatcher(new StorageRepository(chrome), () => 2000);
  const listed = await restarted.execute(CoreCommand.LIST_OUTCOME_CONTRACTS, { projectId: 'project-1' });
  assert.deepEqual(listed.contracts.map(item => item.contractId), ['outcome-1']);

  const revision2 = nextContract(initial, { desiredResult: 'Second durable revision.' });
  const updated = await restarted.execute(CoreCommand.UPDATE_OUTCOME_CONTRACT, {
    projectId: 'project-1',
    contractId: 'outcome-1',
    expectedRevision: 1,
    contract: revision2,
  });
  assert.equal(updated.contract.revision, 2);
  assert.equal(updated.contract.desiredResult, 'Second durable revision.');

  await assert.rejects(
    restarted.execute(CoreCommand.GET_OUTCOME_CONTRACT, {
      projectId: 'project-1',
      contractId: 'outcome-1',
      expectedRevision: 1,
    }),
    /revision binding mismatch/,
  );

  const removed = await restarted.execute(CoreCommand.DELETE_OUTCOME_CONTRACT, {
    projectId: 'project-1',
    contractId: 'outcome-1',
    expectedRevision: 2,
  });
  assert.deepEqual(removed.deleted, {
    projectId: 'project-1',
    contractId: 'outcome-1',
    revision: 2,
  });
  assert.deepEqual(
    (await restarted.execute(CoreCommand.LIST_OUTCOME_CONTRACTS, { projectId: 'project-1' })).contracts,
    [],
  );
});
