import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENARIO_RESULT_MARKER, SCENARIO_RESULT_END_MARKER,
  AUDITOR_ALLOCATION_MARKER, AUDITOR_ALLOCATION_END_MARKER,
  parseScenarioResult, parseAuditorAllocation,
  validateScenarioResult, validateAuditorAllocation, dependenciesSatisfied,
} from '../src/core/scenario-semantic.js';

function result(overrides = {}) {
  return {
    scenario_id: 's', generation: 1, round: 2, phase: 'FIRST', slot: 'FIRST-01',
    task_id: 'r2f1', exclusive_key: 'k1', outcome: 'BLOCKED', slot_consumed: true,
    evidence_published: true, evidence_refs: ['drive:1'], dependencies_consumed: [], retry_required: false,
    ...overrides,
  };
}
function block(marker, end, payload) { return `${marker}\n${JSON.stringify(payload)}\n${end}`; }

test('scenario result parser uses only final strict terminal block', () => {
  const old = block(SCENARIO_RESULT_MARKER, SCENARIO_RESULT_END_MARKER, result({ task_id: 'old' }));
  const good = block(SCENARIO_RESULT_MARKER, SCENARIO_RESULT_END_MARKER, result());
  assert.equal(parseScenarioResult(`${old}\ntext\n${good}`).task_id, 'r2f1');
  assert.equal(parseScenarioResult(`${good}\ntrailing`), null);
});

test('assistant completion alone is insufficient: slot_consumed must be true and identity exact', () => {
  const expected = { scenarioId: 's', generation: 1, round: 2, phase: 'FIRST', slot: 'FIRST-01', taskId: 'r2f1', exclusiveKey: 'k1' };
  assert.equal(validateScenarioResult(result({ slot_consumed: false }), expected).ok, false);
  assert.equal(validateScenarioResult(result({ task_id: 'wrong' }), expected).ok, false);
  assert.equal(validateScenarioResult(result(), expected).ok, true);
});

test('terminal BLOCKED/HANDOFF outcomes count when exact slot is consumed', () => {
  for (const outcome of ['BLOCKED', 'HANDOFF', 'SUPERSEDED_WITH_SUCCESSOR', 'NO_SAFE_ASSIGNED_WORK']) {
    assert.equal(validateScenarioResult(result({ outcome })).ok, true, outcome);
  }
});

function reservation(round, phase, n, deps = []) {
  const prefix = phase === 'SECOND' ? 'S' : 'F';
  return { generation: 1, round, phase, slot: `${phase}-${String(n).padStart(2, '0')}`, task_id: `R${round}${prefix}${n}`, exclusive_key: `K-${round}-${prefix}-${n}`, scheduler_dependencies: deps, source_ref: `drive:r${round}-${phase}-${n}` };
}
function allocation({ second = 9, first = 10, duplicate = false, readback = true } = {}) {
  const reservations = [
    ...Array.from({ length: second }, (_, i) => reservation(2, 'SECOND', i + 1)),
    ...Array.from({ length: first }, (_, i) => reservation(3, 'FIRST', i + 1)),
  ];
  if (duplicate && reservations[1]) reservations[1].task_id = reservations[0].task_id;
  return { scenario_id: 's', generation: 1, round: 2, allocation_id: 'a2', readback_verified: readback, allocation_evidence_refs:['drive:allocation'], first_audit: [], reservations };
}

test('auditor parser requires final strict block', () => {
  const body = block(AUDITOR_ALLOCATION_MARKER, AUDITOR_ALLOCATION_END_MARKER, allocation());
  assert.equal(parseAuditorAllocation(body).allocation_id, 'a2');
  assert.equal(parseAuditorAllocation(`${body}\nextra`), null);
});

test('non-final auditor allocation must be exact 9 SECOND + 10 next FIRST and unique', () => {
  const expected = { scenarioId: 's', generation: 1, round: 2, secondCount: 9, nextFirstCount: 10, knownTaskIds: [] };
  assert.equal(validateAuditorAllocation(allocation(), expected).ok, true);
  assert.ok(validateAuditorAllocation(allocation({ second: 8 }), expected).errors.includes('SECOND_COUNT_MISMATCH'));
  assert.ok(validateAuditorAllocation(allocation({ duplicate: true }), expected).errors.includes('DUPLICATE_TASK_ID'));
  assert.ok(validateAuditorAllocation(allocation({ readback: false }), expected).errors.includes('READBACK_NOT_VERIFIED'));
});

test('final round accepts exactly current SECOND and no next FIRST', () => {
  const raw = allocation({ first: 0 });
  const verdict = validateAuditorAllocation(raw, { scenarioId: 's', generation: 1, round: 2, finalRound: true, secondCount: 9, nextFirstCount: 10 });
  assert.equal(verdict.ok, true);
});

test('duplicate allocation id is blocked', () => {
  const verdict = validateAuditorAllocation(allocation(), { scenarioId: 's', generation: 1, round: 2, secondCount: 9, nextFirstCount: 10, seenAllocationIds: new Set(['a2']) });
  assert.ok(verdict.errors.includes('DUPLICATE_ALLOCATION_ID'));
});



test('auditor allocation requires durable allocation evidence and a source reference for every reservation', () => {
  const expected = { scenarioId: 's', generation: 1, round: 2, secondCount: 9, nextFirstCount: 10, knownTaskIds: [] };
  const noEvidence = allocation();
  noEvidence.allocation_evidence_refs = [];
  assert.ok(validateAuditorAllocation(noEvidence, expected).errors.includes('ALLOCATION_EVIDENCE_REQUIRED'));

  const noSource = allocation();
  delete noSource.reservations[0].source_ref;
  assert.ok(validateAuditorAllocation(noSource, expected).errors.includes('RESERVATION_SOURCE_REF_REQUIRED:SECOND-01'));
});

test('auditor allocation rejects dependency cycles before downstream work is materialized', () => {
  const raw = allocation();
  raw.reservations[0].scheduler_dependencies = [raw.reservations[1].task_id];
  raw.reservations[1].scheduler_dependencies = [raw.reservations[0].task_id];
  const verdict = validateAuditorAllocation(raw, { scenarioId: 's', generation: 1, round: 2, secondCount: 9, nextFirstCount: 10, knownTaskIds: [] });
  assert.ok(verdict.errors.includes('DEPENDENCY_CYCLE'));
});
test('current SECOND cannot depend on a future FIRST reservation even without a raw graph cycle', () => {
  const raw = allocation();
  const futureFirst = raw.reservations.find(item => item.round === 3 && item.phase === 'FIRST');
  const currentSecond = raw.reservations.find(item => item.round === 2 && item.phase === 'SECOND');
  currentSecond.scheduler_dependencies = [futureFirst.task_id];
  const verdict = validateAuditorAllocation(raw, { scenarioId: 's', generation: 1, round: 2, secondCount: 9, nextFirstCount: 10, knownTaskIds: [] });
  assert.ok(verdict.errors.includes('SECOND_DEPENDS_ON_FUTURE_FIRST'));
});

test('worker result must acknowledge exactly the scheduler dependencies frozen into its launch contract', () => {
  const expected = { scenarioId: 's', generation: 1, round: 2, phase: 'FIRST', slot: 'FIRST-01', taskId: 'r2f1', exclusiveKey: 'k1', dependencies: ['A', 'B'] };
  assert.equal(validateScenarioResult(result({ dependencies_consumed: ['B', 'A'] }), expected).ok, true);
  assert.ok(validateScenarioResult(result({ dependencies_consumed: ['A'] }), expected).errors.includes('DEPENDENCIES_CONSUMED_MISMATCH'));
  assert.ok(validateScenarioResult(result({ dependencies_consumed: ['A', 'B', 'C'] }), expected).errors.includes('DEPENDENCIES_CONSUMED_MISMATCH'));
  assert.ok(validateScenarioResult(result({ dependencies_consumed: ['A', 'A', 'B'] }), expected).errors.includes('DEPENDENCIES_CONSUMED_DUPLICATE'));
});

test('dependency gate prevents launch until every internal prerequisite is terminal', () => {
  assert.deepEqual(dependenciesSatisfied(['A', 'B'], new Set(['A'])), { ready: false, missing: ['B'] });
  assert.deepEqual(dependenciesSatisfied(['A', 'B'], new Set(['A', 'B'])), { ready: true, missing: [] });
});


test('auditor first_audit must cover the exact FIRST launch snapshot without rewriting consumption', () => {
  const raw = allocation();
  raw.first_audit = [
    { task_id:'F1', slot:'FIRST-01', classification:'DONE', slot_consumed:true, evidence_ref:'drive:f1' },
    { task_id:'F2', slot:'FIRST-02', classification:'IN_PROGRESS', slot_consumed:false, evidence_ref:'' },
  ];
  const expected = {
    scenarioId:'s', generation:1, round:2, secondCount:9, nextFirstCount:10,
    firstAudit:[
      { taskId:'F1', slot:'FIRST-01', slotConsumed:true, evidenceRef:'drive:f1' },
      { taskId:'F2', slot:'FIRST-02', slotConsumed:false, evidenceRef:'' },
    ],
  };
  assert.equal(validateAuditorAllocation(raw, expected).ok, true);
  const missing = structuredClone(raw); missing.first_audit.pop();
  assert.ok(validateAuditorAllocation(missing, expected).errors.includes('FIRST_AUDIT_COUNT_MISMATCH'));
  const rewrite = structuredClone(raw); rewrite.first_audit[1].slot_consumed = true; rewrite.first_audit[1].evidence_ref='drive:invented';
  assert.ok(validateAuditorAllocation(rewrite, expected).errors.includes('FIRST_AUDIT_CONSUMED_MISMATCH:FIRST-02'));
});
