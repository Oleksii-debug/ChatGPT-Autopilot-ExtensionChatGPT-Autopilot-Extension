import test from 'node:test';
import assert from 'node:assert/strict';

import {
  prepareSpecialistOutcomeContractAdmissionV1,
} from '../src/core/specialist-outcome-contract-admission.js';
import {
  createOutcomeContractV1,
  normalizeOutcomeContractV1,
} from '../src/core/outcome-contract.js';

function selection(overrides = {}) {
  return {
    schemaVersion: 1,
    registryId: 'registry-1',
    registryRevision: 7,
    registryBindingKey: '["registry-1",7,"exact"]',
    specialistId: 'specialist-coder',
    providerId: 'openhands',
    definitionRevision: 4,
    executionPlane: 'LOCAL',
    requestedCapabilityIds: ['code.edit'],
    grantedToolIds: ['github.write'],
    resultContractId: 'outcome-ship',
    ...overrides,
  };
}

function outcomeContract({ revision = 3, projectId = 'project-1', contractId = 'outcome-ship' } = {}) {
  const first = createOutcomeContractV1({
    contractId,
    projectId,
    desiredResult: 'Ship the exact requested product result.',
    completionCriteria: [{
      criterionId: 'criterion-1',
      description: 'The requested product result is complete.',
      observable: 'Independent verification observes the required result.',
      requiredEvidenceKinds: ['test-report'],
    }],
    constraints: ['Preserve canonical authority boundaries.'],
    sourceTruth: [{
      sourceId: 'source-main',
      location: 'github://owner/repo/main',
      revisionId: 'main-exact',
      purpose: 'Canonical implementation truth.',
    }],
    allowedAuthority: [],
    budgetBoundaries: {
      maxModelCalls: 10,
      maxRuntimeSeconds: 3600,
      maxCostUsdMicros: 1_000_000,
      maxConcurrency: 1,
    },
    deliverables: [{
      deliverableId: 'deliverable-1',
      kind: 'code-change',
      description: 'Verified product result.',
      criterionIds: ['criterion-1'],
    }],
    verifierPlan: {
      planId: 'verify-plan-1',
      actorId: 'specialist-coder',
      verifierId: 'independent-verifier',
      criterionIds: ['criterion-1'],
      requiredEvidenceArtifactCount: 1,
      independent: true,
    },
    triggerRefs: [],
    createdAt: '2026-09-29T19:00:00.000Z',
  });
  return revision === 1 ? first : normalizeOutcomeContractV1({ ...first, revision });
}

test('freezes Specialist resultContractId to exact current canonical OutcomeContract revision', async () => {
  const contract = outcomeContract({ revision: 3 });
  let lookup = null;
  const admission = await prepareSpecialistOutcomeContractAdmissionV1({
    projectId: 'project-1',
    selection: selection(),
  }, {
    resolveCurrentOutcomeContract: async value => {
      lookup = value;
      return contract;
    },
  });

  assert.deepEqual(lookup, { projectId: 'project-1', contractId: 'outcome-ship' });
  assert.equal(Object.isFrozen(lookup), true);
  assert.equal(admission.projectId, 'project-1');
  assert.equal(admission.resultContractId, 'outcome-ship');
  assert.equal(admission.resultContractRevision, 3);
  assert.match(admission.outcomeContractBindingKey, /^sha256:[0-9a-f]{64}$/u);
  assert.match(admission.bindingKey, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(admission.registryRevision, 7);
  assert.equal(admission.definitionRevision, 4);
  assert.equal(admission.executionAuthorized, false);
  assert.equal(admission.verificationAuthorized, false);
  assert.equal(admission.completionAuthorized, false);
  assert.equal(Object.isFrozen(admission), true);
  assert.equal(Object.isFrozen(admission.requestedCapabilityIds), true);
});

test('rejects resolver identity drift instead of accepting mutable resultContractId semantics', async () => {
  await assert.rejects(
    prepareSpecialistOutcomeContractAdmissionV1({
      projectId: 'project-1',
      selection: selection(),
    }, {
      resolveCurrentOutcomeContract: async () => outcomeContract({ projectId: 'project-other' }),
    }),
    /project identity does not match/,
  );

  await assert.rejects(
    prepareSpecialistOutcomeContractAdmissionV1({
      projectId: 'project-1',
      selection: selection(),
    }, {
      resolveCurrentOutcomeContract: async () => outcomeContract({ contractId: 'outcome-other' }),
    }),
    /identity does not match Specialist resultContractId/,
  );
});

test('snapshots selection before async resolution so caller mutation cannot rebind admission', async () => {
  const mutableSelection = selection();
  const contract = outcomeContract({ revision: 5 });
  let releaseResolver;
  let observedLookup;
  const pending = prepareSpecialistOutcomeContractAdmissionV1({
    projectId: 'project-1',
    selection: mutableSelection,
  }, {
    resolveCurrentOutcomeContract: async lookup => {
      observedLookup = lookup;
      await new Promise(resolve => { releaseResolver = resolve; });
      return contract;
    },
  });

  mutableSelection.resultContractId = 'outcome-rebound';
  mutableSelection.registryRevision = 99;
  releaseResolver();
  const admission = await pending;

  assert.equal(observedLookup.contractId, 'outcome-ship');
  assert.equal(admission.resultContractId, 'outcome-ship');
  assert.equal(admission.resultContractRevision, 5);
  assert.equal(admission.registryRevision, 7);
});

test('fails closed on accessor, unknown dependency and malformed resolver output boundaries', async () => {
  let reads = 0;
  const accessorRequest = { selection: selection() };
  Object.defineProperty(accessorRequest, 'projectId', {
    enumerable: true,
    get() {
      reads += 1;
      return 'project-1';
    },
  });
  await assert.rejects(
    prepareSpecialistOutcomeContractAdmissionV1(accessorRequest, {
      resolveCurrentOutcomeContract: async () => outcomeContract(),
    }),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);

  await assert.rejects(
    prepareSpecialistOutcomeContractAdmissionV1({
      projectId: 'project-1',
      selection: selection(),
    }, {
      resolveCurrentOutcomeContract: async () => outcomeContract(),
      fallbackResolver: async () => outcomeContract(),
    }),
    /unknown field: fallbackResolver/,
  );

  await assert.rejects(
    prepareSpecialistOutcomeContractAdmissionV1({
      projectId: 'project-1',
      selection: selection(),
    }, {
      resolveCurrentOutcomeContract: async () => ({
        contractId: 'outcome-ship',
        projectId: 'project-1',
        revision: 3,
      }),
    }),
    /OutcomeContractV1 must provide schemaVersion|Unsupported OutcomeContractV1 schemaVersion/,
  );
});
