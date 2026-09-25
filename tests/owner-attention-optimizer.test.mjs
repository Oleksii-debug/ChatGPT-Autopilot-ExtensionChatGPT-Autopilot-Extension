import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OwnerAttentionDelayCost,
  OwnerAttentionDisposition,
  OwnerAttentionReversibility,
  OwnerAttentionUncertainty,
  OwnerAttentionWrongDecisionConsequence,
  buildOwnerAttentionPlanV1,
} from '../src/core/owner-attention-optimizer.js';

const NOW = '2026-09-25T12:00:00.000Z';
const HOUR = 60 * 60 * 1000;

function attentionItem(overrides = {}) {
  return {
    schemaVersion: 1,
    itemId: 'attention-1',
    status: 'OPEN',
    severity: 'NORMAL',
    ownerActionKind: 'REVIEW',
    title: 'Review material outcome',
    materialityReason: 'Canonical verification needs owner review.',
    sourceKind: 'JOB',
    sourceId: 'job-1',
    sourceRevisionId: 'rev-1',
    sourceEffectId: '',
    evidenceArtifactIds: ['evidence-1'],
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T11:00:00.000Z',
    closedAt: '',
    supersededByItemId: '',
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    attentionItem: attentionItem(),
    wrongDecisionConsequence: OwnerAttentionWrongDecisionConsequence.MEDIUM,
    reversibility: OwnerAttentionReversibility.REVERSIBLE,
    delayCost: OwnerAttentionDelayCost.LOW,
    uncertainty: OwnerAttentionUncertainty.MEDIUM,
    canonicalEvidenceAvailable: true,
    safeEvidenceGatheringAvailable: false,
    canContinueAround: false,
    batchKey: '',
    decisionDeadlineAt: '',
    ...overrides,
  };
}

function request(items, overrides = {}) {
  return {
    schemaVersion: 1,
    evaluatedAt: NOW,
    nearDeadlineWindowMs: HOUR,
    items,
    ...overrides,
  };
}

test('BLOCKING Action Center attention always escalates and cannot be hidden by evidence or continue-around hints', () => {
  const out = buildOwnerAttentionPlanV1(request([
    candidate({
      attentionItem: attentionItem({ severity: 'BLOCKING' }),
      canonicalEvidenceAvailable: false,
      safeEvidenceGatheringAvailable: true,
      canContinueAround: true,
      batchKey: 'batch-a',
    }),
  ]));

  assert.equal(out.items[0].disposition, OwnerAttentionDisposition.ESCALATE_NOW);
  assert.equal(out.items[0].reasonCode, 'ACTION_CENTER_BLOCKING');
  assert.equal(out.summary.escalateNowCount, 1);
  assert.equal(out.summary.batchCount, 0);
});

test('nonblocking uncertainty gathers safe canonical evidence before interrupting the owner', () => {
  const out = buildOwnerAttentionPlanV1(request([
    candidate({
      attentionItem: attentionItem({ severity: 'HIGH' }),
      canonicalEvidenceAvailable: false,
      safeEvidenceGatheringAvailable: true,
      wrongDecisionConsequence: OwnerAttentionWrongDecisionConsequence.CRITICAL,
    }),
  ]));

  assert.equal(out.items[0].disposition, OwnerAttentionDisposition.GATHER_EVIDENCE_FIRST);
  assert.equal(out.items[0].reasonCode, 'SAFE_CANONICAL_EVIDENCE_PATH_AVAILABLE');
  assert.equal(out.notificationAuthorized, false);
  assert.equal(out.evidenceGatheringAuthorized, false);
});

test('missing canonical evidence with no safe deterministic evidence path escalates instead of fabricating certainty', () => {
  const out = buildOwnerAttentionPlanV1(request([
    candidate({
      canonicalEvidenceAvailable: false,
      safeEvidenceGatheringAvailable: false,
      canContinueAround: true,
    }),
  ]));

  assert.equal(out.items[0].disposition, OwnerAttentionDisposition.ESCALATE_NOW);
  assert.equal(out.items[0].reasonCode, 'CANONICAL_EVIDENCE_MISSING');
});

test('reached and near decision deadlines dominate batching and deferral', () => {
  const reached = candidate({
    attentionItem: attentionItem({ itemId: 'reached' }),
    decisionDeadlineAt: NOW,
    batchKey: 'batch-a',
    canContinueAround: true,
  });
  const near = candidate({
    attentionItem: attentionItem({ itemId: 'near', sourceId: 'job-2' }),
    decisionDeadlineAt: '2026-09-25T12:30:00.000Z',
    batchKey: 'batch-a',
    canContinueAround: true,
  });

  const out = buildOwnerAttentionPlanV1(request([near, reached]));

  assert.equal(out.items[0].itemId, 'reached');
  assert.equal(out.items[0].disposition, OwnerAttentionDisposition.ESCALATE_NOW);
  assert.equal(out.items[0].reasonCode, 'DECISION_DEADLINE_REACHED');
  assert.equal(out.items[1].itemId, 'near');
  assert.equal(out.items[1].reasonCode, 'DECISION_DEADLINE_NEAR');
  assert.equal(out.batches.length, 0);
});

test('related low-materiality canonical decisions are batched deterministically', () => {
  const out = buildOwnerAttentionPlanV1(request([
    candidate({
      attentionItem: attentionItem({
        itemId: 'attention-b',
        sourceId: 'job-b',
        evidenceArtifactIds: ['evidence-b'],
      }),
      batchKey: 'project-review',
    }),
    candidate({
      attentionItem: attentionItem({
        itemId: 'attention-a',
        sourceId: 'job-a',
        evidenceArtifactIds: ['evidence-a'],
      }),
      batchKey: 'project-review',
    }),
  ]));

  assert.deepEqual(out.items.map(item => item.itemId), ['attention-a', 'attention-b']);
  assert.ok(out.items.every(item => item.disposition === OwnerAttentionDisposition.BATCH));
  assert.equal(out.batches.length, 1);
  assert.deepEqual(out.batches[0].itemIds, ['attention-a', 'attention-b']);
  assert.deepEqual(out.batches[0].evidenceArtifactIds, ['evidence-a', 'evidence-b']);
  assert.equal(out.batches[0].notificationAuthorized, false);
  assert.equal(out.batches[0].decisionAuthorized, false);
});

test('a singleton batch candidate defers only when safe work can continue around it', () => {
  const deferred = buildOwnerAttentionPlanV1(request([
    candidate({ batchKey: 'batch-a', canContinueAround: true }),
  ]));
  assert.equal(
    deferred.items[0].disposition,
    OwnerAttentionDisposition.DEFER_WHILE_CONTINUING,
  );
  assert.equal(deferred.items[0].reasonCode, 'BATCH_PEER_NOT_AVAILABLE_CONTINUE_AROUND');

  const escalated = buildOwnerAttentionPlanV1(request([
    candidate({ batchKey: 'batch-a', canContinueAround: false }),
  ]));
  assert.equal(escalated.items[0].disposition, OwnerAttentionDisposition.ESCALATE_NOW);
});

test('HIGH severity and irreversible or critical-consequence decisions remain owner-visible after evidence is current', () => {
  const out = buildOwnerAttentionPlanV1(request([
    candidate({
      attentionItem: attentionItem({ itemId: 'high', severity: 'HIGH' }),
    }),
    candidate({
      attentionItem: attentionItem({ itemId: 'irreversible', sourceId: 'job-2' }),
      reversibility: OwnerAttentionReversibility.IRREVERSIBLE,
      canContinueAround: true,
    }),
    candidate({
      attentionItem: attentionItem({ itemId: 'critical', sourceId: 'job-3' }),
      wrongDecisionConsequence: OwnerAttentionWrongDecisionConsequence.CRITICAL,
      canContinueAround: true,
    }),
  ]));

  assert.equal(out.summary.escalateNowCount, 3);
  assert.ok(out.items.every(item => item.disposition === OwnerAttentionDisposition.ESCALATE_NOW));
});

test('nonblocking low-delay attention can be deferred while independent work continues', () => {
  const out = buildOwnerAttentionPlanV1(request([
    candidate({ canContinueAround: true }),
  ]));

  assert.equal(
    out.items[0].disposition,
    OwnerAttentionDisposition.DEFER_WHILE_CONTINUING,
  );
  assert.equal(out.items[0].reasonCode, 'SAFE_CONTINUE_AROUND_AVAILABLE');
});

test('future Action Center observations and impossible pre-creation deadlines fail closed', () => {
  assert.throws(
    () => buildOwnerAttentionPlanV1(request([
      candidate({
        attentionItem: attentionItem({ updatedAt: '2026-09-25T12:00:00.001Z' }),
      }),
    ])),
    /observed after evaluatedAt/u,
  );

  assert.throws(
    () => buildOwnerAttentionPlanV1(request([
      candidate({ decisionDeadlineAt: '2026-09-25T09:59:59.999Z' }),
    ])),
    /cannot predate attention item creation/u,
  );
});

test('duplicate Action Center identities fail closed', () => {
  assert.throws(
    () => buildOwnerAttentionPlanV1(request([
      candidate(),
      candidate({ attentionItem: attentionItem({ sourceId: 'different-job' }) }),
    ])),
    /duplicate Action Center itemId/u,
  );
});

test('request and candidate descriptor boundaries reject accessors, symbols and sparse arrays without executing getters', () => {
  let getterCalls = 0;
  const bad = candidate();
  Object.defineProperty(bad, 'canonicalEvidenceAvailable', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return true;
    },
  });

  assert.throws(
    () => buildOwnerAttentionPlanV1(request([bad])),
    /enumerable own data properties/u,
  );
  assert.equal(getterCalls, 0);

  const symbolic = request([candidate()]);
  symbolic[Symbol('authority')] = true;
  assert.throws(
    () => buildOwnerAttentionPlanV1(symbolic),
    /unknown field/u,
  );

  const sparse = new Array(1);
  assert.throws(
    () => buildOwnerAttentionPlanV1(request(sparse)),
    /enumerable own data property/u,
  );
});

test('near-deadline window and numeric boundaries reject aliases and negative zero', () => {
  assert.throws(
    () => buildOwnerAttentionPlanV1(request([candidate()], { nearDeadlineWindowMs: -0 })),
    /exact integer/u,
  );
  assert.throws(
    () => buildOwnerAttentionPlanV1(request([candidate()], { nearDeadlineWindowMs: '3600000' })),
    /exact integer/u,
  );
});

test('output is deeply frozen, bounded and grants no notification, decision, evidence or task authority', () => {
  const out = buildOwnerAttentionPlanV1(request([
    candidate({ canContinueAround: true }),
  ]));

  assert.equal(out.readOnly, true);
  assert.equal(out.advisoryOnly, true);
  assert.equal(out.requiresCanonicalSourceResolution, true);
  assert.equal(out.notificationAuthorized, false);
  assert.equal(out.decisionAuthorized, false);
  assert.equal(out.evidenceGatheringAuthorized, false);
  assert.equal(out.taskMutationAuthorized, false);
  assert.ok(Object.isFrozen(out));
  assert.ok(Object.isFrozen(out.items));
  assert.ok(Object.isFrozen(out.items[0]));
  assert.ok(Object.isFrozen(out.summary));
});
