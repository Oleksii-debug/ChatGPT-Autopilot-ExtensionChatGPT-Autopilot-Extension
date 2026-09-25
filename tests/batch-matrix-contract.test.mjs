import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BatchItemStatus,
  BatchMatrixState,
  MAX_BATCH_CONCURRENCY_INTENT,
  assessBatchMatrixV1,
  expandBatchMatrixV1,
  normalizeBatchMatrixSpecV1,
} from '../src/core/batch-matrix-contract.js';

const WORKLOAD_SHA = 'a'.repeat(64);
const EVIDENCE_SHA = 'b'.repeat(64);

function evidenceRef(artifactId = 'evidence-1', versionId = 'evidence-1@v1', digest = EVIDENCE_SHA) {
  return {
    projectId: 'project-1',
    artifactId,
    versionId,
    sha256: digest,
  };
}

function value(valueId, valueRef, sensitive = false) {
  return { valueId, valueRef, sensitive };
}

function spec(overrides = {}) {
  return {
    schemaVersion: 1,
    batchId: 'batch-1',
    workloadId: 'recipe.report',
    workloadRevisionId: 'recipe.report@7',
    workloadSha256: WORKLOAD_SHA,
    producerId: 'owner-agent',
    createdAt: '2026-09-25T06:30:00.000Z',
    maxConcurrency: 4,
    axes: [
      {
        axisId: 'region',
        values: [
          value('west', 'param-ref.region.west'),
          value('east', 'param-ref.region.east'),
        ],
      },
      {
        axisId: 'format',
        values: [
          value('txt', 'param-ref.format.txt'),
          value('pdf', 'param-ref.format.pdf'),
        ],
      },
    ],
    ...overrides,
  };
}

function terminal(item, status = BatchItemStatus.PASS, overrides = {}) {
  return {
    schemaVersion: 1,
    batchId: item.batchId,
    itemId: item.itemId,
    itemSha256: item.itemSha256,
    status,
    actorId: 'worker-1',
    verifierId: 'verifier-1',
    reasonCode: status === BatchItemStatus.PASS ? '' : 'ITEM_NOT_COMPLETE',
    evidenceRefs: [evidenceRef()],
    startedAt: '2026-09-25T06:31:00.000Z',
    completedAt: '2026-09-25T06:31:10.000Z',
    ...overrides,
  };
}

test('normalizes axes deterministically and treats maxConcurrency as intent only', async () => {
  const expansion = await expandBatchMatrixV1(spec());
  assert.equal(expansion.spec.itemCount, 4);
  assert.equal(expansion.items.length, 4);
  assert.deepEqual(expansion.spec.axes.map(axis => axis.axisId), ['format', 'region']);
  assert.equal(expansion.spec.maxConcurrency, 4);
  assert.equal(expansion.maxConcurrencyIsIntentOnly, true);
  assert.equal(expansion.schedulingAuthorized, false);
  assert.equal(expansion.executionAuthorized, false);
  assert.equal(Object.isFrozen(expansion), true);
  assert.equal(Object.isFrozen(expansion.items), true);

  for (const item of expansion.items) {
    assert.match(item.itemId, /^batch-item:[a-f0-9]{32}$/u);
    assert.match(item.itemSha256, /^[a-f0-9]{64}$/u);
    assert.equal(item.workloadSha256, WORKLOAD_SHA);
    assert.deepEqual(item.parameters.map(parameter => parameter.axisId), ['format', 'region']);
  }
});

test('Cartesian expansion is independent from caller axis and value ordering', async () => {
  const left = await expandBatchMatrixV1(spec());

  const reordered = spec();
  reordered.axes.reverse();
  for (const axis of reordered.axes) axis.values.reverse();
  const right = await expandBatchMatrixV1(reordered);

  assert.deepEqual(left.spec, right.spec);
  assert.deepEqual(left.items, right.items);
});

test('item SHA-256 binds workload revision and exact opaque parameter refs', async () => {
  const base = await expandBatchMatrixV1(spec());

  const changedRef = spec();
  changedRef.axes[0].values[0].valueRef = 'param-ref.region.west-v2';
  const refExpansion = await expandBatchMatrixV1(changedRef);
  assert.notDeepEqual(
    base.items.map(item => item.itemSha256),
    refExpansion.items.map(item => item.itemSha256),
  );

  const changedWorkload = await expandBatchMatrixV1(spec({
    workloadRevisionId: 'recipe.report@8',
  }));
  assert.notDeepEqual(
    base.items.map(item => item.itemSha256),
    changedWorkload.items.map(item => item.itemSha256),
  );
});

test('matrix accepts opaque refs only and rejects raw parameter value fields', async () => {
  const raw = spec();
  raw.axes[0].values[0].rawValue = 'super-secret';
  assert.throws(() => normalizeBatchMatrixSpecV1(raw), /unknown field: rawValue/u);

  const normalized = normalizeBatchMatrixSpecV1(spec());
  assert.equal(JSON.stringify(normalized).includes('super-secret'), false);
});

test('duplicate axes, value IDs and valueRef aliases fail closed', () => {
  const duplicateAxis = spec();
  duplicateAxis.axes[1].axisId = duplicateAxis.axes[0].axisId;
  assert.throws(() => normalizeBatchMatrixSpecV1(duplicateAxis), /duplicate axisId/u);

  const duplicateValue = spec();
  duplicateValue.axes[0].values[1].valueId = duplicateValue.axes[0].values[0].valueId;
  assert.throws(() => normalizeBatchMatrixSpecV1(duplicateValue), /duplicate valueId/u);

  const alias = spec();
  alias.axes[0].values[1].valueRef = alias.axes[0].values[0].valueRef;
  assert.throws(() => normalizeBatchMatrixSpecV1(alias), /duplicate valueRef alias/u);

  const crossAxisAlias = spec();
  crossAxisAlias.axes[1].values[0].valueRef = crossAxisAlias.axes[0].values[0].valueRef;
  assert.throws(() => normalizeBatchMatrixSpecV1(crossAxisAlias), /duplicate valueRef alias/u);
});

test('matrix bounds axes, values, Cartesian product and concurrency intent', () => {
  assert.throws(
    () => normalizeBatchMatrixSpecV1(spec({ maxConcurrency: 0 })),
    /maxConcurrency/u,
  );
  assert.throws(
    () => normalizeBatchMatrixSpecV1(spec({
      maxConcurrency: MAX_BATCH_CONCURRENCY_INTENT + 1,
    })),
    /maxConcurrency/u,
  );

  const huge = spec({
    axes: [
      {
        axisId: 'a',
        values: Array.from({ length: 32 }, (_, index) =>
          value('a' + index, 'ref.a.' + index)),
      },
      {
        axisId: 'b',
        values: Array.from({ length: 32 }, (_, index) =>
          value('b' + index, 'ref.b.' + index)),
      },
      {
        axisId: 'c',
        values: [
          value('c0', 'ref.c.0'),
          value('c1', 'ref.c.1'),
        ],
      },
    ],
  });
  assert.throws(
    () => normalizeBatchMatrixSpecV1(huge),
    /Cartesian product exceeds item bound/u,
  );
});

test('missing results are implicit PENDING and only PENDING items are resume candidates', async () => {
  const expansion = await expandBatchMatrixV1(spec());
  const report = await assessBatchMatrixV1(spec(), [
    terminal(expansion.items[0], BatchItemStatus.PASS),
  ]);

  assert.equal(report.state, BatchMatrixState.IN_PROGRESS);
  assert.equal(report.totalItems, 4);
  assert.deepEqual(report.counts, {
    pending: 3,
    running: 0,
    pass: 1,
    fail: 0,
    cancelled: 0,
  });
  assert.equal(report.resumeCandidateItemIds.length, 3);
  assert.deepEqual(report.reconciliationRequiredItemIds, []);
  assert.equal(report.resumeAuthorized, false);
  assert.equal(report.reconciliationAuthorized, false);
  assert.equal(report.executionAuthorized, false);
  assert.equal(report.schedulingAuthorized, false);
  assert.equal(report.reportedAllPassed, false);
  assert.equal(report.reportedPartialFailure, false);
  assert.equal(report.resultEvidenceTrust, 'UNVERIFIED_INPUT');
  assert.equal(report.completionAuthorized, false);
  assert.equal(report.requiresCanonicalEvidenceResolution, true);
  assert.equal(report.requiresIndependentVerifierAuthority, true);
});

test('RUNNING item is reconciliation-required and never blind-resume candidate', async () => {
  const expansion = await expandBatchMatrixV1(spec());
  const running = {
    schemaVersion: 1,
    batchId: expansion.items[0].batchId,
    itemId: expansion.items[0].itemId,
    itemSha256: expansion.items[0].itemSha256,
    status: BatchItemStatus.RUNNING,
    actorId: 'worker-1',
    verifierId: '',
    reasonCode: '',
    evidenceRefs: [],
    startedAt: '2026-09-25T06:31:00.000Z',
    completedAt: '',
  };
  const report = await assessBatchMatrixV1(spec(), [running]);
  assert.deepEqual(report.reconciliationRequiredItemIds, [expansion.items[0].itemId]);
  assert.equal(report.resumeCandidateItemIds.includes(expansion.items[0].itemId), false);
  assert.equal(report.state, BatchMatrixState.IN_PROGRESS);
});

test('all independent PASS evidence produces COMPLETE and nothing else can', async () => {
  const expansion = await expandBatchMatrixV1(spec());
  const results = expansion.items.map((item, index) =>
    terminal(item, BatchItemStatus.PASS, {
      actorId: 'worker-' + index,
      verifierId: 'verifier-' + index,
      evidenceRefs: [evidenceRef('evidence-' + index, 'evidence-' + index + '@v1')],
    }));

  const report = await assessBatchMatrixV1(spec(), results);
  assert.equal(report.state, BatchMatrixState.COMPLETE);
  assert.equal(report.reportedAllPassed, true);
  assert.equal(report.reportedPartialFailure, false);
  assert.equal(report.resultEvidenceTrust, 'UNVERIFIED_INPUT');
  assert.equal(report.completionAuthorized, false);
  assert.equal(report.counts.pass, 4);
  assert.deepEqual(report.resumeCandidateItemIds, []);
  assert.deepEqual(report.reconciliationRequiredItemIds, []);
});

test('terminal FAIL or CANCELLED yields truthful PARTIAL rather than success', async () => {
  const expansion = await expandBatchMatrixV1(spec());
  const statuses = [
    BatchItemStatus.PASS,
    BatchItemStatus.PASS,
    BatchItemStatus.FAIL,
    BatchItemStatus.CANCELLED,
  ];
  const results = expansion.items.map((item, index) =>
    terminal(item, statuses[index], {
      actorId: 'worker-' + index,
      verifierId: 'verifier-' + index,
      reasonCode: statuses[index] === BatchItemStatus.PASS ? '' : 'NOT_COMPLETED',
      evidenceRefs: [evidenceRef('evidence-' + index, 'evidence-' + index + '@v1')],
    }));

  const report = await assessBatchMatrixV1(spec(), results);
  assert.equal(report.state, BatchMatrixState.PARTIAL);
  assert.equal(report.reportedAllPassed, false);
  assert.equal(report.reportedPartialFailure, true);
  assert.equal(report.counts.pass, 2);
  assert.equal(report.counts.fail, 1);
  assert.equal(report.counts.cancelled, 1);
});

test('result must bind exact item identity and digest', async () => {
  const expansion = await expandBatchMatrixV1(spec());
  const forgedHash = terminal(expansion.items[0]);
  forgedHash.itemSha256 = 'f'.repeat(64);
  await assert.rejects(
    () => assessBatchMatrixV1(spec(), [forgedHash]),
    /itemSha256 mismatch/u,
  );

  const unknown = terminal(expansion.items[0]);
  unknown.itemId = 'batch-item:ffffffffffffffffffffffffffffffff';
  await assert.rejects(
    () => assessBatchMatrixV1(spec(), [unknown]),
    /unknown itemId/u,
  );

  await assert.rejects(
    () => assessBatchMatrixV1(spec(), [
      terminal(expansion.items[0]),
      terminal(expansion.items[0]),
    ]),
    /duplicate itemId/u,
  );
});

test('terminal evidence binds exact Project artifact version and SHA-256', async () => {
  const expansion = await expandBatchMatrixV1(spec());
  const item = expansion.items[0];

  const duplicateVersion = terminal(item, BatchItemStatus.PASS, {
    evidenceRefs: [evidenceRef(), evidenceRef()],
  });
  await assert.rejects(
    () => assessBatchMatrixV1(spec(), [duplicateVersion]),
    /duplicate artifact version identity/u,
  );

  const badDigest = terminal(item, BatchItemStatus.PASS, {
    evidenceRefs: [evidenceRef('evidence-1', 'evidence-1@v1', 'B'.repeat(64))],
  });
  await assert.rejects(
    () => assessBatchMatrixV1(spec(), [badDigest]),
    /lowercase SHA-256/u,
  );

  const extra = terminal(item, BatchItemStatus.PASS);
  extra.evidenceRefs[0].uri = 'file:///secret';
  await assert.rejects(
    () => assessBatchMatrixV1(spec(), [extra]),
    /unknown field: uri/u,
  );
});

test('terminal result requires independent verifier, evidence and causal times', async () => {
  const expansion = await expandBatchMatrixV1(spec());
  const item = expansion.items[0];

  await assert.rejects(
    () => assessBatchMatrixV1(spec(), [
      terminal(item, BatchItemStatus.PASS, { verifierId: 'worker-1' }),
    ]),
    /independent from actor/u,
  );

  await assert.rejects(
    () => assessBatchMatrixV1(spec(), [
      terminal(item, BatchItemStatus.PASS, { evidenceRefs: [] }),
    ]),
    /requires actor, verifier, times and evidence/u,
  );

  await assert.rejects(
    () => assessBatchMatrixV1(spec(), [
      terminal(item, BatchItemStatus.FAIL, { reasonCode: '' }),
    ]),
    /requires reasonCode/u,
  );

  await assert.rejects(
    () => assessBatchMatrixV1(spec(), [
      terminal(item, BatchItemStatus.PASS, { reasonCode: 'FAKE_REASON' }),
    ]),
    /must not carry failure reasonCode/u,
  );

  await assert.rejects(
    () => assessBatchMatrixV1(spec(), [
      terminal(item, BatchItemStatus.PASS, {
        startedAt: '2026-09-25T06:29:59.000Z',
      }),
    ]),
    /predates batch creation/u,
  );

  await assert.rejects(
    () => assessBatchMatrixV1(spec(), [
      terminal(item, BatchItemStatus.PASS, {
        startedAt: '2026-09-25T06:31:10.000Z',
        completedAt: '2026-09-25T06:31:09.000Z',
      }),
    ]),
    /completedAt predates startedAt/u,
  );
});

test('PENDING and RUNNING cannot smuggle terminal evidence', async () => {
  const expansion = await expandBatchMatrixV1(spec());
  const item = expansion.items[0];

  const pending = {
    schemaVersion: 1,
    batchId: item.batchId,
    itemId: item.itemId,
    itemSha256: item.itemSha256,
    status: BatchItemStatus.PENDING,
    actorId: 'worker-1',
    verifierId: '',
    reasonCode: '',
    evidenceRefs: [],
    startedAt: '',
    completedAt: '',
  };
  await assert.rejects(
    () => assessBatchMatrixV1(spec(), [pending]),
    /PENDING cannot carry execution or terminal evidence/u,
  );

  const running = {
    ...pending,
    status: BatchItemStatus.RUNNING,
    actorId: 'worker-1',
    verifierId: 'verifier-1',
    evidenceRefs: [evidenceRef()],
    startedAt: '2026-09-25T06:31:00.000Z',
  };
  await assert.rejects(
    () => assessBatchMatrixV1(spec(), [running]),
    /RUNNING cannot carry terminal evidence/u,
  );
});

test('strict spec boundary rejects accessors without executing getters', () => {
  let reads = 0;
  const hostile = spec();
  Object.defineProperty(hostile, 'batchId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'batch-pwned';
    },
  });
  assert.throws(
    () => normalizeBatchMatrixSpecV1(hostile),
    /enumerable own data properties/u,
  );
  assert.equal(reads, 0);

  const hostileValue = spec();
  Object.defineProperty(hostileValue.axes[0].values[0], 'valueRef', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'secret.ref';
    },
  });
  assert.throws(
    () => normalizeBatchMatrixSpecV1(hostileValue),
    /enumerable own data properties/u,
  );
  assert.equal(reads, 0);
});

test('strict boundary rejects hidden/symbol/exotic records and sparse/side arrays', () => {
  const hidden = spec();
  Object.defineProperty(hidden, 'executionAuthorized', {
    enumerable: false,
    configurable: true,
    value: true,
  });
  assert.throws(() => normalizeBatchMatrixSpecV1(hidden), /enumerable own data properties/u);

  const symbolic = spec();
  symbolic[Symbol('authority')] = true;
  assert.throws(() => normalizeBatchMatrixSpecV1(symbolic), /symbol fields/u);

  const exotic = Object.assign(Object.create({ executionAuthorized: true }), spec());
  assert.throws(() => normalizeBatchMatrixSpecV1(exotic), /plain object/u);

  const sparse = spec();
  sparse.axes = new Array(1);
  assert.throws(() => normalizeBatchMatrixSpecV1(sparse), /must not be sparse/u);

  const side = spec();
  side.axes.extraAuthority = true;
  assert.throws(() => normalizeBatchMatrixSpecV1(side), /non-index array data/u);
});
