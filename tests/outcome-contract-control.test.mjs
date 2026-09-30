import test from 'node:test';
import assert from 'node:assert/strict';

import { CoreCommandDispatcher } from '../src/core/commands.js';
import {
  createStoredOutcomeContractV1,
  deleteStoredOutcomeContractV1,
  listStoredOutcomeContractsV1,
  normalizeOutcomeContractRegistryV1,
  validateOutcomeContractRegistryStateV1,
  resolveStoredOutcomeContractV1,
  resolveCurrentStoredOutcomeContractV1,
  resolveCanonicalStoredOutcomeContractV1,
  updateStoredOutcomeContractV1,
} from '../src/core/outcome-contract-control.js';
import { createOutcomeContractV1, normalizeOutcomeContractV1 } from '../src/core/outcome-contract.js';
import { adjudicateOutcomeVerificationV1 } from '../src/core/outcome-verification-bridge.js';
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
  assert.equal(
    resolveCanonicalStoredOutcomeContractV1(state, {
      contractId: 'outcome-1',
      contractRevision: 1,
    }).desiredResult,
    created.desiredResult,
    'revision 1 remains canonical after revision 2 is admitted',
  );
  assert.equal(
    resolveCanonicalStoredOutcomeContractV1(state, {
      contractId: 'outcome-1',
      contractRevision: 2,
    }).desiredResult,
    updated.desiredResult,
  );

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
  assert.throws(
    () => resolveStoredOutcomeContractV1(state, {
      projectId: 'project-1',
      contractId: 'outcome-1',
      expectedRevision: 2,
    }),
    /is deleted/,
  );
  assert.equal(
    resolveCanonicalStoredOutcomeContractV1(state, {
      contractId: 'outcome-1',
      contractRevision: 1,
    }).revision,
    1,
    'tombstone preserves historical revision 1 for in-flight verifier/recovery',
  );
  assert.equal(
    resolveCanonicalStoredOutcomeContractV1(state, {
      contractId: 'outcome-1',
      contractRevision: 2,
    }).revision,
    2,
    'tombstone preserves latest exact revision for verifier/recovery',
  );
});


test('contractId remains globally non-reusable across projects and tombstones for historical verifier identity', () => {
  const state = createEmptyState(1);
  createStoredOutcomeContractV1(state, contractV1({
    contractId: 'global-contract-id',
    projectId: 'project-1',
  }));

  assert.throws(
    () => createStoredOutcomeContractV1(state, contractV1({
      contractId: 'global-contract-id',
      projectId: 'project-2',
    })),
    /already exists/,
    'historical resolver identity has no projectId and therefore contractId must remain globally unique',
  );

  deleteStoredOutcomeContractV1(state, {
    projectId: 'project-1',
    contractId: 'global-contract-id',
    expectedRevision: 1,
  });

  assert.throws(
    () => createStoredOutcomeContractV1(state, contractV1({
      contractId: 'global-contract-id',
      projectId: 'project-2',
    })),
    /already exists/,
    'tombstoning must not make a historical contractId reusable',
  );
  assert.equal(
    resolveCanonicalStoredOutcomeContractV1(state, {
      contractId: 'global-contract-id',
      contractRevision: 1,
    }).projectId,
    'project-1',
  );
});


test('internal current resolver selects an exact project-bound revision for downstream admission without weakening public exact reads', () => {
  const state = createEmptyState(1);
  const first = createStoredOutcomeContractV1(state, contractV1());

  assert.equal(resolveCurrentStoredOutcomeContractV1(state, {
    projectId: 'project-1',
    contractId: 'outcome-1',
  }).revision, 1);
  assert.throws(
    () => resolveCurrentStoredOutcomeContractV1(state, {
      projectId: 'project-other',
      contractId: 'outcome-1',
    }),
    /project binding mismatch/,
  );

  const second = nextContract(first, { desiredResult: 'Current revision selected at later admission.' });
  updateStoredOutcomeContractV1(state, {
    projectId: 'project-1',
    contractId: 'outcome-1',
    expectedRevision: 1,
    contract: second,
  });

  const admitted = resolveCurrentStoredOutcomeContractV1(state, {
    projectId: 'project-1',
    contractId: 'outcome-1',
  });
  assert.equal(admitted.revision, 2);
  assert.equal(
    resolveCanonicalStoredOutcomeContractV1(state, {
      contractId: 'outcome-1',
      contractRevision: 1,
    }).revision,
    1,
    'historical exact revision remains independently resolvable after current revision advances',
  );

  deleteStoredOutcomeContractV1(state, {
    projectId: 'project-1',
    contractId: 'outcome-1',
    expectedRevision: 2,
  });
  assert.throws(
    () => resolveCurrentStoredOutcomeContractV1(state, {
      projectId: 'project-1',
      contractId: 'outcome-1',
    }),
    /is deleted/,
  );
  assert.equal(
    resolveCanonicalStoredOutcomeContractV1(state, {
      contractId: 'outcome-1',
      contractRevision: admitted.revision,
    }).revision,
    2,
    'admitted exact revision remains recoverable after owner tombstones the current contract',
  );
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

test('existing independent Outcome verifier consumes the durable canonical resolver without authority widening', async () => {
  const state = createEmptyState(1);
  const stored = createStoredOutcomeContractV1(state, contractV1());
  const criterion = stored.completionCriteria[0];
  const evidenceArtifact = {
    schemaVersion: 1, artifactId: 'evidence-1', kind: 'test-report',
    uri: 'artifact://outcome/evidence-1', mediaType: 'application/json',
    sha256: 'a'.repeat(64), sizeBytes: 128,
    createdAt: '2026-09-29T04:04:00.000Z',
    producerInvocationId: 'actor-tool-invocation', sensitive: false,
  };
  const trustedRecord = {
    schemaVersion: 1, recordId: 'trusted-record-1',
    contractId: stored.contractId, contractRevision: stored.revision,
    verifierPlanId: stored.verifierPlan.planId,
    criterion: {
      criterionId: criterion.criterionId, description: criterion.description,
      observable: criterion.observable,
      requiredEvidenceKinds: [...criterion.requiredEvidenceKinds],
    },
    verifierId: stored.verifierPlan.verifierId,
    verificationAuthorityId: 'verification-authority-1',
    verification: {
      schemaVersion: 1, verificationId: 'verification-1',
      invocationId: 'effect-1', observationId: 'observation-1',
      status: 'VERIFIED', reasonCode: 'PASS', summary: '',
      evidenceArtifactIds: ['evidence-1'],
      verifiedAt: '2026-09-29T04:05:00.000Z',
      verifierId: stored.verifierPlan.verifierId,
      verificationAuthorityId: 'verification-authority-1',
    },
    evidenceArtifacts: [evidenceArtifact],
    recordedAt: '2026-09-29T04:06:00.000Z',
    validThrough: '2026-09-29T05:00:00.000Z',
  };
  const revision2 = nextContract(stored, {
    desiredResult: 'Deliver a newer owner-controlled revision while revision one remains verifiable.',
  });
  updateStoredOutcomeContractV1(state, {
    projectId: stored.projectId, contractId: stored.contractId,
    expectedRevision: stored.revision, contract: revision2,
  });
  let verificationLookup = null;
  const result = await adjudicateOutcomeVerificationV1({
    contract: stored,
    criterionVerifications: [{ criterionId: criterion.criterionId, verificationId: 'verification-1' }],
    evaluatedAt: '2026-09-29T04:10:00.000Z',
  }, {
    resolveTrustedOutcomeContract: async lookup => resolveCanonicalStoredOutcomeContractV1(state, lookup),
    resolveTrustedVerificationRecord: async lookup => {
      verificationLookup = lookup;
      return trustedRecord;
    },
  });
  assert.equal(result.verdict, 'VERIFIED');
  assert.equal(result.contractRevision, 1);
  assert.equal(verificationLookup.contractRevision, 1);
  assert.equal(verificationLookup.verifierPlanId, stored.verifierPlan.planId);
  assert.equal(resolveStoredOutcomeContractV1(state, {
    projectId: stored.projectId, contractId: stored.contractId, expectedRevision: 2,
  }).revision, 2);
  assert.equal(result.completionEvidenceReady, true);
  assert.equal(result.completionAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.verificationAuthorityMinted, false);
});
test('contract registry stores valid prototype-adjacent ids as data and rejects non-canonical prototype keys', async () => {
  const contractId = 'constructor';
  const state = createEmptyState(1);
  const created = createStoredOutcomeContractV1(state, contractV1({ contractId }));
  assert.equal(created.contractId, contractId);
  assert.equal(Object.getPrototypeOf(state.outcomeContractsById), null);
  assert.equal(Object.hasOwn(state.outcomeContractsById, contractId), true);

  const exact = resolveCurrentStoredOutcomeContractV1(state, {
    projectId: 'project-1',
    contractId,
  });
  assert.equal(exact.contractId, contractId);
  assert.equal(
    resolveCanonicalStoredOutcomeContractV1(state, {
      contractId,
      contractRevision: 1,
    }).contractId,
    contractId,
  );
  assert.equal(validateState(state), state);

  const chrome = fakeChrome();
  await new StorageRepository(chrome).save(state);
  const restarted = await new StorageRepository(chrome).load();
  assert.equal(Object.hasOwn(restarted.outcomeContractsById, contractId), true);
  assert.equal(
    resolveCurrentStoredOutcomeContractV1(restarted, {
      projectId: 'project-1',
      contractId,
    }).contractId,
    contractId,
  );
  assert.equal(
    resolveCanonicalStoredOutcomeContractV1(restarted, {
      contractId,
      contractRevision: 1,
    }).contractId,
    contractId,
  );

  assert.throws(
    () => contractV1({ contractId: '__proto__' }),
    /contractId must be an exact id/,
    'canonical OutcomeContract IDs must begin with an alphanumeric code point',
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

test('state authority distinguishes an absent legacy registry from present undefined or accessor-shaped registry state', () => {
  const legacy = createEmptyState(1);
  delete legacy.outcomeContractsById;
  assert.equal(validateOutcomeContractRegistryStateV1(legacy), legacy);
  assert.equal(validateState(legacy), legacy);

  const undefinedRegistry = createEmptyState(1);
  undefinedRegistry.outcomeContractsById = undefined;
  assert.throws(
    () => validateOutcomeContractRegistryStateV1(undefinedRegistry),
    /cannot be undefined when present/,
  );
  assert.throws(() => validateState(undefinedRegistry), /cannot be undefined when present/);

  let getterCalls = 0;
  const accessorState = createEmptyState(1);
  delete accessorState.outcomeContractsById;
  Object.defineProperty(accessorState, 'outcomeContractsById', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return {};
    },
  });
  assert.throws(
    () => validateOutcomeContractRegistryStateV1(accessorState),
    /enumerable own data property/,
  );
  assert.equal(getterCalls, 0);
  assert.throws(() => validateState(accessorState), /enumerable own data property/);
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
  createStoredOutcomeContractV1(state, contractV1());
  state.outcomeContractsById['outcome-1'].revisionsByNumber['1'].executionAuthorized = true;
  const repository = new StorageRepository(fakeChrome({ [STORAGE_KEY]: state }));
  await assert.rejects(repository.load(), /cannot grant execution authority/);
});

test('persisted revision history rejects gaps, rebinding and creation-time drift', () => {
  const state = createEmptyState(1);
  const first = createStoredOutcomeContractV1(state, contractV1());
  const second = nextContract(first, { desiredResult: 'Revision two.' });
  updateStoredOutcomeContractV1(state, {
    projectId: 'project-1',
    contractId: 'outcome-1',
    expectedRevision: 1,
    contract: second,
  });

  const gap = structuredClone(state.outcomeContractsById);
  delete gap['outcome-1'].revisionsByNumber['1'];
  assert.throws(() => normalizeOutcomeContractRegistryV1(gap), /must be contiguous/);

  const rebound = structuredClone(state.outcomeContractsById);
  rebound['outcome-1'].revisionsByNumber['1'].projectId = 'project-other';
  assert.throws(() => normalizeOutcomeContractRegistryV1(rebound), /project binding mismatch/);

  const timeDrift = structuredClone(state.outcomeContractsById);
  timeDrift['outcome-1'].revisionsByNumber['2'].createdAt = '2026-09-29T04:00:01.000Z';
  assert.throws(() => normalizeOutcomeContractRegistryV1(timeDrift), /createdAt is immutable/);
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



test('Core OutcomeContract command wrappers reject accessors and unknown fields before authority reads', async () => {
  const chrome = fakeChrome();
  const dispatcher = new CoreCommandDispatcher(new StorageRepository(chrome), () => 1000);
  const initial = contractV1();
  let getterCalls = 0;

  const accessorPayload = {};
  Object.defineProperty(accessorPayload, 'projectId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'project-1';
    },
  });

  await assert.rejects(
    dispatcher.execute(CoreCommand.LIST_OUTCOME_CONTRACTS, accessorPayload),
    /fields must be enumerable own data properties/,
  );
  assert.equal(getterCalls, 0, 'command wrapper must not execute payload getters');

  await assert.rejects(
    dispatcher.execute(CoreCommand.CREATE_OUTCOME_CONTRACT, {
      contract: initial,
      ignoredAuthorityHint: true,
    }),
    /contains unknown field: ignoredAuthorityHint/,
  );

  await dispatcher.execute(CoreCommand.CREATE_OUTCOME_CONTRACT, { contract: initial });

  await assert.rejects(
    dispatcher.execute(CoreCommand.GET_OUTCOME_CONTRACT, {
      projectId: 'project-1',
      contractId: 'outcome-1',
      expectedRevision: 1,
      extra: 'ignored-before-hardening',
    }),
    /contains unknown field: extra/,
  );

  const updatePayload = Object.create(null);
  updatePayload.projectId = 'project-1';
  updatePayload.contractId = 'outcome-1';
  updatePayload.expectedRevision = 1;
  updatePayload.contract = nextContract(initial, { desiredResult: 'Data-only wrapper update.' });
  const updated = await dispatcher.execute(CoreCommand.UPDATE_OUTCOME_CONTRACT, updatePayload);
  assert.equal(updated.contract.revision, 2, 'null-prototype data payload remains supported');

  const deletePayload = {
    projectId: 'project-1',
    contractId: 'outcome-1',
    expectedRevision: 2,
  };
  Object.defineProperty(deletePayload, 'unexpected', {
    enumerable: false,
    value: true,
  });
  await assert.rejects(
    dispatcher.execute(CoreCommand.DELETE_OUTCOME_CONTRACT, deletePayload),
    /contains unknown field: unexpected/,
  );
});


test('Core CREATE and UPDATE snapshot nested OutcomeContract before queued storage mutation', async () => {
  const chrome = fakeChrome();
  const repository = new StorageRepository(chrome);
  const dispatcher = new CoreCommandDispatcher(repository, () => 1000);

  const createInput = structuredClone(contractV1());
  const expectedCreateDesired = createInput.desiredResult;
  const expectedCreateCriterion = createInput.completionCriteria[0].description;
  const createPending = dispatcher.execute(CoreCommand.CREATE_OUTCOME_CONTRACT, {
    contract: createInput,
  });
  createInput.desiredResult = 'caller mutation after CREATE admission';
  createInput.completionCriteria[0].description = 'caller criterion mutation after CREATE admission';
  await createPending;

  const created = await dispatcher.execute(CoreCommand.GET_OUTCOME_CONTRACT, {
    projectId: 'project-1',
    contractId: 'outcome-1',
    expectedRevision: 1,
  });
  assert.equal(created.contract.desiredResult, expectedCreateDesired);
  assert.equal(created.contract.completionCriteria[0].description, expectedCreateCriterion);

  const updateInput = structuredClone(nextContract(created.contract, {
    desiredResult: 'Revision two admitted before caller mutation.',
  }));
  const expectedUpdateDesired = updateInput.desiredResult;
  const expectedUpdateCriterion = updateInput.completionCriteria[0].description;
  const updatePending = dispatcher.execute(CoreCommand.UPDATE_OUTCOME_CONTRACT, {
    projectId: 'project-1',
    contractId: 'outcome-1',
    expectedRevision: 1,
    contract: updateInput,
  });
  updateInput.desiredResult = 'caller mutation after UPDATE admission';
  updateInput.completionCriteria[0].description = 'caller criterion mutation after UPDATE admission';
  await updatePending;

  const updated = await dispatcher.execute(CoreCommand.GET_OUTCOME_CONTRACT, {
    projectId: 'project-1',
    contractId: 'outcome-1',
    expectedRevision: 2,
  });
  assert.equal(updated.contract.desiredResult, expectedUpdateDesired);
  assert.equal(updated.contract.completionCriteria[0].description, expectedUpdateCriterion);

  let getterCalls = 0;
  const hostile = structuredClone(contractV1({ contractId: 'hostile-contract' }));
  Object.defineProperty(hostile, 'desiredResult', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'must not execute';
    },
  });
  await assert.rejects(
    dispatcher.execute(CoreCommand.CREATE_OUTCOME_CONTRACT, { contract: hostile }),
    /data propert/u,
  );
  assert.equal(getterCalls, 0, 'nested OutcomeContract snapshot must reject accessors without getter execution');
  assert.equal(
    listStoredOutcomeContractsV1(await repository.load(), { projectId: 'project-1' })
      .some(item => item.contractId === 'hostile-contract'),
    false,
  );
});


test('concurrent Core revision CAS serializes writers so exactly one stale peer fails', async () => {
  const chrome = fakeChrome();
  const repository = new StorageRepository(chrome);
  const dispatcher = new CoreCommandDispatcher(repository, () => 1000);
  const initial = contractV1();
  await dispatcher.execute(CoreCommand.CREATE_OUTCOME_CONTRACT, { contract: initial });

  const candidateA = nextContract(initial, { desiredResult: 'Concurrent candidate A.' });
  const candidateB = nextContract(initial, { desiredResult: 'Concurrent candidate B.' });
  const settled = await Promise.allSettled([
    dispatcher.execute(CoreCommand.UPDATE_OUTCOME_CONTRACT, {
      projectId: 'project-1',
      contractId: 'outcome-1',
      expectedRevision: 1,
      contract: candidateA,
    }),
    dispatcher.execute(CoreCommand.UPDATE_OUTCOME_CONTRACT, {
      projectId: 'project-1',
      contractId: 'outcome-1',
      expectedRevision: 1,
      contract: candidateB,
    }),
  ]);

  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(item => item.status === 'rejected').length, 1);
  assert.match(
    String(settled.find(item => item.status === 'rejected').reason?.message || ''),
    /revision binding mismatch/,
  );

  const state = await repository.load();
  const durable = resolveCurrentStoredOutcomeContractV1(state, {
    projectId: 'project-1',
    contractId: 'outcome-1',
  });
  assert.equal(durable.revision, 2);
  assert.ok(
    ['Concurrent candidate A.', 'Concurrent candidate B.'].includes(durable.desiredResult),
    'durable winner must be exactly one admitted revision-2 candidate',
  );
  assert.throws(
    () => resolveCanonicalStoredOutcomeContractV1(state, {
      contractId: 'outcome-1',
      contractRevision: 3,
    }),
    /revision binding mismatch/,
  );
});

test('stack OutcomeContract exact integer boundary rejects signed zero before durable revision storage', () => {
  assert.throws(
    () => createOutcomeContractV1(buildInput({
      budgetBoundaries: {
        maxModelCalls: -0, maxRuntimeSeconds: 3600,
        maxCostUsdMicros: 2_000_000, maxConcurrency: 2,
      },
    })),
    /maxModelCalls must be an exact integer/,
  );
  const canonicalZero = contractV1({
    budgetBoundaries: {
      maxModelCalls: 0, maxRuntimeSeconds: 3600,
      maxCostUsdMicros: 0, maxConcurrency: 2,
    },
  });
  const state = createEmptyState(1);
  const stored = createStoredOutcomeContractV1(state, canonicalZero);
  assert.equal(Object.is(stored.budgetBoundaries.maxModelCalls, -0), false);
  assert.equal(Object.is(stored.budgetBoundaries.maxCostUsdMicros, -0), false);
});
