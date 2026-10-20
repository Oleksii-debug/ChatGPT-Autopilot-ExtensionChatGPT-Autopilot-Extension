import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_CENTER_SCHEMA_VERSION,
  ActionCenterItemStatus,
  ActionCenterOwnerActionKind,
  ActionCenterSeverity,
  ActionCenterSourceKind,
  buildActionCenterProjectionV1,
  normalizeActionCenterItemV1,
} from '../src/core/action-center-contract.js';

const T0 = '2026-09-25T00:00:00.000Z';
const T1 = '2026-09-25T00:01:00.000Z';
const T2 = '2026-09-25T00:02:00.000Z';

function item(itemId, overrides = {}) {
  return {
    schemaVersion: ACTION_CENTER_SCHEMA_VERSION,
    itemId,
    status: ActionCenterItemStatus.OPEN,
    severity: ActionCenterSeverity.NORMAL,
    ownerActionKind: ActionCenterOwnerActionKind.REVIEW,
    title: `Review ${itemId}`,
    materialityReason: 'Owner review is required before the upstream authority may continue.',
    sourceKind: ActionCenterSourceKind.REVIEW,
    sourceId: `source:${itemId}`,
    sourceRevisionId: `rev:${itemId}`,
    sourceEffectId: '',
    evidenceArtifactIds: [`artifact:${itemId}`],
    createdAt: T0,
    updatedAt: T0,
    closedAt: '',
    supersededByItemId: '',
    ...overrides,
  };
}

test('projects deterministic advisory attention without granting decision authority', () => {
  const low = item('low', {
    severity: ActionCenterSeverity.LOW,
    createdAt: T1,
    updatedAt: T1,
  });
  const blockingLater = item('blocking-later', {
    severity: ActionCenterSeverity.BLOCKING,
    createdAt: T1,
    updatedAt: T1,
    ownerActionKind: ActionCenterOwnerActionKind.RECONCILE,
  });
  const blockingEarlier = item('blocking-earlier', {
    severity: ActionCenterSeverity.BLOCKING,
    createdAt: T0,
    updatedAt: T0,
    ownerActionKind: ActionCenterOwnerActionKind.APPROVE_OR_DENY,
  });
  const resolved = item('resolved', {
    status: ActionCenterItemStatus.RESOLVED,
    severity: ActionCenterSeverity.BLOCKING,
    ownerActionKind: ActionCenterOwnerActionKind.NONE,
    createdAt: T0,
    updatedAt: T1,
    closedAt: T2,
  });

  const projection = buildActionCenterProjectionV1([
    resolved,
    low,
    blockingLater,
    blockingEarlier,
  ].reverse());

  assert.deepEqual(
    projection.items.map((entry) => entry.itemId),
    ['blocking-earlier', 'blocking-later', 'low', 'resolved'],
  );
  assert.equal(projection.advisoryOnly, true);
  assert.equal(projection.requiresCanonicalSourceResolution, true);
  assert.equal(projection.decisionAuthorized, false);
  assert.equal(projection.summary.totalCount, 4);
  assert.equal(projection.summary.openCount, 3);
  assert.equal(projection.summary.blockingOpenCount, 2);
  assert.equal(projection.summary.openBySeverity.BLOCKING, 2);
  assert.equal(projection.summary.openBySeverity.LOW, 1);
  assert.equal(projection.summary.resolvedCount, 1);
  assert.equal(projection.items.every((entry) => entry.sourceTrust === 'UNVERIFIED_INPUT'), true);
  assert.equal(projection.items.every((entry) => entry.decisionAuthorized === false), true);
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.items), true);
  assert.equal(Object.isFrozen(projection.items[0]), true);
});

test('input ordering cannot change deterministic projection', () => {
  const records = [
    item('b', { severity: ActionCenterSeverity.HIGH, createdAt: T1, updatedAt: T1 }),
    item('a', { severity: ActionCenterSeverity.HIGH, createdAt: T1, updatedAt: T1 }),
    item('c', { severity: ActionCenterSeverity.NORMAL }),
  ];
  const first = buildActionCenterProjectionV1(records);
  const second = buildActionCenterProjectionV1([...records].reverse());
  assert.deepEqual(second, first);
});

test('OPEN requires material owner action while closed items cannot request one', () => {
  assert.throws(
    () => normalizeActionCenterItemV1(item('open-none', {
      ownerActionKind: ActionCenterOwnerActionKind.NONE,
    })),
    /requires a concrete owner action/,
  );

  assert.throws(
    () => normalizeActionCenterItemV1(item('resolved-live-action', {
      status: ActionCenterItemStatus.RESOLVED,
      ownerActionKind: ActionCenterOwnerActionKind.REVIEW,
      updatedAt: T1,
      closedAt: T2,
    })),
    /cannot request live owner action/,
  );

  assert.throws(
    () => normalizeActionCenterItemV1(item('open-closed', { closedAt: T1 })),
    /OPEN attention item cannot have closedAt/,
  );
});

test('resolved and superseded lifecycle is causal and exact', () => {
  assert.throws(
    () => normalizeActionCenterItemV1(item('missing-close', {
      status: ActionCenterItemStatus.RESOLVED,
      ownerActionKind: ActionCenterOwnerActionKind.NONE,
      updatedAt: T1,
    })),
    /requires closedAt/,
  );

  assert.throws(
    () => normalizeActionCenterItemV1(item('backdated-close', {
      status: ActionCenterItemStatus.RESOLVED,
      ownerActionKind: ActionCenterOwnerActionKind.NONE,
      updatedAt: T2,
      closedAt: T1,
    })),
    /closedAt cannot predate updatedAt/,
  );

  const superseded = item('old', {
    status: ActionCenterItemStatus.SUPERSEDED,
    ownerActionKind: ActionCenterOwnerActionKind.NONE,
    updatedAt: T1,
    closedAt: T2,
    supersededByItemId: 'new',
  });
  const replacement = item('new', {
    createdAt: T1,
    updatedAt: T1,
  });
  const projection = buildActionCenterProjectionV1([replacement, superseded]);
  assert.equal(projection.summary.supersededCount, 1);
  assert.equal(projection.items.find((entry) => entry.itemId === 'old').supersededByItemId, 'new');

  assert.throws(
    () => buildActionCenterProjectionV1([
      item('orphan', {
        status: ActionCenterItemStatus.SUPERSEDED,
        ownerActionKind: ActionCenterOwnerActionKind.NONE,
        updatedAt: T1,
        closedAt: T2,
        supersededByItemId: 'missing',
      }),
    ]),
    /unknown superseding item/,
  );
});

test('supersession graph rejects time travel and cycles', () => {
  assert.throws(
    () => buildActionCenterProjectionV1([
      item('old', {
        status: ActionCenterItemStatus.SUPERSEDED,
        ownerActionKind: ActionCenterOwnerActionKind.NONE,
        createdAt: T1,
        updatedAt: T1,
        closedAt: T2,
        supersededByItemId: 'earlier',
      }),
      item('earlier', { createdAt: T0, updatedAt: T0 }),
    ]),
    /predates superseded item/,
  );

  assert.throws(
    () => buildActionCenterProjectionV1([
      item('closed-before-successor', {
        status: ActionCenterItemStatus.SUPERSEDED,
        ownerActionKind: ActionCenterOwnerActionKind.NONE,
        updatedAt: T1,
        closedAt: T2,
        supersededByItemId: 'future-successor',
      }),
      item('future-successor', {
        createdAt: '2026-09-25T00:03:00.000Z',
        updatedAt: '2026-09-25T00:03:00.000Z',
      }),
    ]),
    /postdates superseded item closure/,
  );

  assert.throws(
    () => buildActionCenterProjectionV1([
      item('predecessor', {
        status: ActionCenterItemStatus.SUPERSEDED,
        ownerActionKind: ActionCenterOwnerActionKind.NONE,
        updatedAt: T1,
        closedAt: T2,
        supersededByItemId: 'already-closed-successor',
      }),
      item('already-closed-successor', {
        status: ActionCenterItemStatus.RESOLVED,
        ownerActionKind: ActionCenterOwnerActionKind.NONE,
        createdAt: T0,
        updatedAt: T1,
        closedAt: T1,
      }),
    ]),
    /closed before predecessor supersession/,
  );

  const boundarySuccessor = item('boundary-successor', {
    status: ActionCenterItemStatus.RESOLVED,
    ownerActionKind: ActionCenterOwnerActionKind.NONE,
    createdAt: T0,
    updatedAt: T1,
    closedAt: T2,
  });
  assert.doesNotThrow(() => buildActionCenterProjectionV1([
    boundarySuccessor,
    item('boundary-predecessor', {
      status: ActionCenterItemStatus.SUPERSEDED,
      ownerActionKind: ActionCenterOwnerActionKind.NONE,
      updatedAt: T1,
      closedAt: T2,
      supersededByItemId: 'boundary-successor',
    }),
  ]));

  assert.throws(
    () => buildActionCenterProjectionV1([
      item('a', {
        status: ActionCenterItemStatus.SUPERSEDED,
        ownerActionKind: ActionCenterOwnerActionKind.NONE,
        updatedAt: T1,
        closedAt: T2,
        supersededByItemId: 'b',
      }),
      item('b', {
        status: ActionCenterItemStatus.SUPERSEDED,
        ownerActionKind: ActionCenterOwnerActionKind.NONE,
        updatedAt: T1,
        closedAt: T2,
        supersededByItemId: 'a',
      }),
    ]),
    /supersession graph contains a cycle/,
  );
});

test('duplicate item identity and evidence aliases fail closed', () => {
  assert.throws(
    () => buildActionCenterProjectionV1([item('dup'), item('dup')]),
    /duplicate itemId/,
  );
  assert.throws(
    () => normalizeActionCenterItemV1(item('evidence-dup', {
      evidenceArtifactIds: ['artifact:a', 'artifact:a'],
    })),
    /evidenceArtifactIds contains duplicates/,
  );
});

test('record accessors, hidden fields, symbols and inherited authority fail closed without reads', () => {
  let reads = 0;
  const accessor = item('accessor');
  Object.defineProperty(accessor, 'severity', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return ActionCenterSeverity.BLOCKING;
    },
  });
  assert.throws(() => normalizeActionCenterItemV1(accessor), /enumerable own data properties/);
  assert.equal(reads, 0);

  const hidden = item('hidden');
  Object.defineProperty(hidden, 'ownerActionKind', {
    enumerable: false,
    configurable: true,
    value: ActionCenterOwnerActionKind.APPROVE_OR_DENY,
  });
  assert.throws(() => normalizeActionCenterItemV1(hidden), /enumerable own data properties/);

  const symbol = item('symbol');
  symbol[Symbol('authority')] = 'ALLOW';
  assert.throws(() => normalizeActionCenterItemV1(symbol), /symbol fields/);

  const inherited = Object.create({ decisionAuthorized: true });
  Object.assign(inherited, item('inherited'));
  assert.throws(() => normalizeActionCenterItemV1(inherited), /plain or null-prototype object/);
});

test('array boundary rejects accessors, sparse arrays, symbols and custom prototypes without reads', () => {
  let reads = 0;
  const records = [item('one')];
  const original = records[0];
  Object.defineProperty(records, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return original;
    },
  });
  assert.throws(() => buildActionCenterProjectionV1(records), /enumerable own data property/);
  assert.equal(reads, 0);

  assert.throws(() => buildActionCenterProjectionV1(new Array(1)), /enumerable own data property/);

  const withSymbol = [item('symbol-array')];
  withSymbol[Symbol('authority')] = true;
  assert.throws(() => buildActionCenterProjectionV1(withSymbol), /non-canonical array fields/);

  const custom = [item('custom')];
  Object.setPrototypeOf(custom, Object.create(Array.prototype));
  assert.throws(() => buildActionCenterProjectionV1(custom), /canonical array/);
});

test('canonical identities, timestamps and enums reject coercion or aliases', () => {
  assert.throws(() => normalizeActionCenterItemV1(item('numeric-source', { sourceId: 7 })), /canonical string identity/);
  assert.throws(() => normalizeActionCenterItemV1(item('trimmed', { itemId: ' trimmed ' })), /canonical string identity/);
  assert.throws(() => normalizeActionCenterItemV1(item('bad-time', { createdAt: '2026-09-25T00:00:00Z' })), /canonical ISO timestamp/);
  assert.throws(() => normalizeActionCenterItemV1(item('bad-state', { status: 'open' })), /status is invalid/);

  let coerced = 0;
  const severity = { toString() { coerced += 1; return 'BLOCKING'; } };
  assert.throws(() => normalizeActionCenterItemV1(item('coercive', { severity })), /severity is invalid/);
  assert.equal(coerced, 0);
});

test('closed blocking history cannot inflate live blocking count', () => {
  const projection = buildActionCenterProjectionV1([
    item('historical-blocker', {
      status: ActionCenterItemStatus.RESOLVED,
      severity: ActionCenterSeverity.BLOCKING,
      ownerActionKind: ActionCenterOwnerActionKind.NONE,
      updatedAt: T1,
      closedAt: T2,
    }),
    item('low-open', {
      severity: ActionCenterSeverity.LOW,
      ownerActionKind: ActionCenterOwnerActionKind.CLARIFY,
    }),
  ]);
  assert.equal(projection.summary.openCount, 1);
  assert.equal(projection.summary.blockingOpenCount, 0);
  assert.equal(projection.summary.ownerActionOpenCount, 1);
});


test('Action Center orders canonical extended-year timestamps by epoch instead of lexical text', () => {
  const earlier = item('year-9999', {
    createdAt: '9999-12-31T23:59:59.999Z',
    updatedAt: '9999-12-31T23:59:59.999Z',
  });
  const later = item('year-10000', {
    createdAt: '+010000-01-01T00:00:00.000Z',
    updatedAt: '+010000-01-01T00:00:00.000Z',
  });

  const forward = buildActionCenterProjectionV1([later, earlier]);
  const reverse = buildActionCenterProjectionV1([earlier, later]);

  assert.deepEqual(
    forward.items.map(entry => entry.itemId),
    ['year-9999', 'year-10000'],
  );
  assert.deepEqual(reverse, forward);
});
