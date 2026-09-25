export const SCENARIO_RESULT_MARKER = 'AUTOPILOT_SCENARIO_RESULT';
export const SCENARIO_RESULT_END_MARKER = 'END_AUTOPILOT_SCENARIO_RESULT';
export const AUDITOR_ALLOCATION_MARKER = 'AUTOPILOT_AUDITOR_ALLOCATION';
export const AUDITOR_ALLOCATION_END_MARKER = 'END_AUTOPILOT_AUDITOR_ALLOCATION';

export const ScenarioBarrierPolicy = Object.freeze({
  WAIT_ALL_TERMINAL: 'WAIT_ALL_TERMINAL',
  TIMEBOXED_AUDIT: 'TIMEBOXED_AUDIT',
});

export const ScenarioSlotOutcome = Object.freeze({
  DONE: 'DONE',
  READY_FOR_AUDIT: 'READY_FOR_AUDIT',
  BLOCKED: 'BLOCKED',
  HANDOFF: 'HANDOFF',
  SUPERSEDED_WITH_SUCCESSOR: 'SUPERSEDED_WITH_SUCCESSOR',
  NO_SAFE_ASSIGNED_WORK: 'NO_SAFE_ASSIGNED_WORK',
  CHANGES_REQUIRED: 'CHANGES_REQUIRED',
  PASS: 'PASS',
});

const OUTCOMES = new Set(Object.values(ScenarioSlotOutcome));
const BARRIERS = new Set(Object.values(ScenarioBarrierPolicy));

function text(value) { return typeof value === 'string' ? value : ''; }
function trimmed(value) { return text(value).trim(); }
function bool(value) { return value === true; }
function int(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}
function array(value) { return Array.isArray(value) ? value : []; }
function strings(value) { return array(value).map(item => trimmed(item)).filter(Boolean); }
function unique(items) { return new Set(items).size === items.length; }

function finalMarkedJson(body, marker, endMarker) {
  const source = text(body);
  if (!source) return null;
  const startToken = `${marker}\n`;
  let start = source.lastIndexOf(startToken);
  if (start < 0) {
    const windowsToken = `${marker}\r\n`;
    start = source.lastIndexOf(windowsToken);
    if (start < 0) return null;
    start += windowsToken.length;
  } else {
    start += startToken.length;
  }
  const end = source.indexOf(endMarker, start);
  if (end < 0) return null;
  const trailing = source.slice(end + endMarker.length).trim();
  if (trailing) return null;
  const raw = source.slice(start, end).trim();
  if (!raw.startsWith('{') || !raw.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseScenarioResult(body) {
  return finalMarkedJson(body, SCENARIO_RESULT_MARKER, SCENARIO_RESULT_END_MARKER);
}

export function parseAuditorAllocation(body) {
  return finalMarkedJson(body, AUDITOR_ALLOCATION_MARKER, AUDITOR_ALLOCATION_END_MARKER);
}

export function normalizeBarrierPolicy(value, fallback = ScenarioBarrierPolicy.WAIT_ALL_TERMINAL) {
  return BARRIERS.has(value) ? value : fallback;
}

export function validateScenarioResult(raw, expected = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['RESULT_NOT_OBJECT'], value: null };
  const value = {
    scenarioId: trimmed(raw.scenario_id),
    generation: int(raw.generation),
    round: int(raw.round),
    phase: trimmed(raw.phase).toUpperCase(),
    slot: trimmed(raw.slot).toUpperCase(),
    taskId: trimmed(raw.task_id),
    exclusiveKey: trimmed(raw.exclusive_key),
    outcome: trimmed(raw.outcome).toUpperCase(),
    slotConsumed: bool(raw.slot_consumed),
    evidencePublished: bool(raw.evidence_published),
    evidenceRefs: strings(raw.evidence_refs),
    dependenciesConsumed: strings(raw.dependencies_consumed),
    retryRequired: bool(raw.retry_required),
    failureClass: trimmed(raw.failure_class),
  };
  if (!value.scenarioId) errors.push('SCENARIO_ID_REQUIRED');
  if (value.generation < 1) errors.push('GENERATION_INVALID');
  if (value.round < 1) errors.push('ROUND_INVALID');
  if (!['FIRST', 'SECOND', 'WORKER'].includes(value.phase)) errors.push('PHASE_INVALID');
  if (!value.slot) errors.push('SLOT_REQUIRED');
  if (!value.taskId) errors.push('TASK_ID_REQUIRED');
  if (!value.exclusiveKey) errors.push('EXCLUSIVE_KEY_REQUIRED');
  if (!OUTCOMES.has(value.outcome)) errors.push('OUTCOME_INVALID');
  if (!value.slotConsumed) errors.push('SLOT_NOT_CONSUMED');
  if (value.evidencePublished && !value.evidenceRefs.length) errors.push('EVIDENCE_REFS_REQUIRED');
  if (value.retryRequired && value.slotConsumed) errors.push('RETRY_AND_CONSUMED_CONFLICT');

  const checks = [
    ['scenarioId', 'SCENARIO_ID_MISMATCH'],
    ['generation', 'GENERATION_MISMATCH'],
    ['round', 'ROUND_MISMATCH'],
    ['phase', 'PHASE_MISMATCH'],
    ['slot', 'SLOT_MISMATCH'],
    ['taskId', 'TASK_ID_MISMATCH'],
    ['exclusiveKey', 'EXCLUSIVE_KEY_MISMATCH'],
  ];
  for (const [field, code] of checks) {
    if (expected[field] !== undefined && expected[field] !== null && expected[field] !== '' && value[field] !== expected[field]) errors.push(code);
  }
  if (!unique(value.dependenciesConsumed)) errors.push('DEPENDENCIES_CONSUMED_DUPLICATE');
  if (Array.isArray(expected.dependencies)) {
    const expectedDependencies = strings(expected.dependencies);
    const actualDependencies = value.dependenciesConsumed;
    if (expectedDependencies.length !== actualDependencies.length
      || expectedDependencies.some(id => !actualDependencies.includes(id))
      || actualDependencies.some(id => !expectedDependencies.includes(id))) {
      errors.push('DEPENDENCIES_CONSUMED_MISMATCH');
    }
  }
  return { ok: errors.length === 0, errors, value };
}

function normalizeReservation(raw) {
  return {
    generation: int(raw?.generation),
    round: int(raw?.round),
    phase: trimmed(raw?.phase).toUpperCase(),
    slot: trimmed(raw?.slot).toUpperCase(),
    taskId: trimmed(raw?.task_id),
    exclusiveKey: trimmed(raw?.exclusive_key),
    dependencies: strings(raw?.scheduler_dependencies),
    prompt: text(raw?.prompt),
    sourceRef: trimmed(raw?.source_ref),
  };
}

export function validateAuditorAllocation(raw, expected = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['ALLOCATION_NOT_OBJECT'], value: null };
  const reservations = array(raw.reservations).map(normalizeReservation);
  const firstAudit = array(raw.first_audit).map(item => ({
    taskId: trimmed(item?.task_id),
    slot: trimmed(item?.slot).toUpperCase(),
    classification: trimmed(item?.classification).toUpperCase(),
    slotConsumed: item?.slot_consumed === true,
    evidenceRef: trimmed(item?.evidence_ref),
  }));
  const value = {
    scenarioId: trimmed(raw.scenario_id),
    generation: int(raw.generation),
    round: int(raw.round),
    allocationId: trimmed(raw.allocation_id),
    readbackVerified: bool(raw.readback_verified),
    allocationEvidenceRefs: strings(raw.allocation_evidence_refs),
    reservations,
    firstAudit,
  };
  if (!value.scenarioId) errors.push('SCENARIO_ID_REQUIRED');
  if (value.generation < 1) errors.push('GENERATION_INVALID');
  if (value.round < 1) errors.push('ROUND_INVALID');
  if (!value.allocationId) errors.push('ALLOCATION_ID_REQUIRED');
  if (!value.readbackVerified) errors.push('READBACK_NOT_VERIFIED');
  if (!value.allocationEvidenceRefs.length) errors.push('ALLOCATION_EVIDENCE_REQUIRED');
  if (!reservations.length) errors.push('RESERVATIONS_REQUIRED');

  if (expected.scenarioId && value.scenarioId !== expected.scenarioId) errors.push('SCENARIO_ID_MISMATCH');
  if (expected.generation && value.generation !== expected.generation) errors.push('GENERATION_MISMATCH');
  if (expected.round && value.round !== expected.round) errors.push('ROUND_MISMATCH');

  const finalRound = expected.finalRound === true;
  const secondCount = Number.isInteger(expected.secondCount) ? expected.secondCount : null;
  const nextFirstCount = finalRound ? 0 : (Number.isInteger(expected.nextFirstCount) ? expected.nextFirstCount : null);
  const currentSecond = reservations.filter(item => item.round === value.round && item.phase === 'SECOND');
  const nextFirst = reservations.filter(item => item.round === value.round + 1 && item.phase === 'FIRST');
  const unexpected = reservations.filter(item => !(
    (item.round === value.round && item.phase === 'SECOND')
    || (!finalRound && item.round === value.round + 1 && item.phase === 'FIRST')
  ));
  if (secondCount !== null && currentSecond.length !== secondCount) errors.push('SECOND_COUNT_MISMATCH');
  if (nextFirstCount !== null && nextFirst.length !== nextFirstCount) errors.push('NEXT_FIRST_COUNT_MISMATCH');
  if (unexpected.length) errors.push('UNEXPECTED_RESERVATION_SCOPE');

  for (const item of reservations) {
    if (item.generation !== value.generation) errors.push('RESERVATION_GENERATION_MISMATCH');
    if (!item.slot) errors.push('RESERVATION_SLOT_REQUIRED');
    if (!item.taskId) errors.push('RESERVATION_TASK_ID_REQUIRED');
    if (!item.exclusiveKey) errors.push('RESERVATION_EXCLUSIVE_KEY_REQUIRED');
    if (!item.sourceRef) errors.push(`RESERVATION_SOURCE_REF_REQUIRED:${item.slot || '<empty>'}`);
  }
  if (!unique(reservations.map(item => `${item.round}:${item.phase}:${item.slot}`))) errors.push('DUPLICATE_SLOT');
  if (!unique(reservations.map(item => item.taskId))) errors.push('DUPLICATE_TASK_ID');
  if (!unique(reservations.map(item => item.exclusiveKey))) errors.push('DUPLICATE_EXCLUSIVE_KEY');
  if (expected.seenAllocationIds?.has?.(value.allocationId)) errors.push('DUPLICATE_ALLOCATION_ID');

  const expectedFirstAudit = Array.isArray(expected.firstAudit) ? expected.firstAudit : null;
  if (expectedFirstAudit) {
    if (firstAudit.length !== expectedFirstAudit.length) errors.push('FIRST_AUDIT_COUNT_MISMATCH');
    if (!unique(firstAudit.map(item => item.slot))) errors.push('FIRST_AUDIT_DUPLICATE_SLOT');
    const bySlot = new Map(firstAudit.map(item => [item.slot, item]));
    for (const expectedItem of expectedFirstAudit) {
      const expectedSlot = trimmed(expectedItem?.slot).toUpperCase();
      const actual = bySlot.get(expectedSlot);
      if (!actual) {
        errors.push(`FIRST_AUDIT_SLOT_MISSING:${expectedSlot}`);
        continue;
      }
      if (!actual.classification) errors.push(`FIRST_AUDIT_CLASSIFICATION_REQUIRED:${expectedSlot}`);
      const expectedTaskId = trimmed(expectedItem?.taskId);
      if (expectedTaskId && actual.taskId !== expectedTaskId) errors.push(`FIRST_AUDIT_TASK_ID_MISMATCH:${expectedSlot}`);
      const expectedConsumed = expectedItem?.slotConsumed === true;
      if (actual.slotConsumed !== expectedConsumed) errors.push(`FIRST_AUDIT_CONSUMED_MISMATCH:${expectedSlot}`);
      if (actual.slotConsumed && !actual.evidenceRef) errors.push(`FIRST_AUDIT_EVIDENCE_REQUIRED:${expectedSlot}`);
    }
    const expectedSlots = new Set(expectedFirstAudit.map(item => trimmed(item?.slot).toUpperCase()).filter(Boolean));
    for (const actual of firstAudit) {
      if (!expectedSlots.has(actual.slot)) errors.push(`FIRST_AUDIT_UNEXPECTED_SLOT:${actual.slot || '<empty>'}`);
    }
  }

  const knownTaskIds = new Set(strings(expected.knownTaskIds));
  const reservationByTaskId = new Map(reservations.map(item => [item.taskId, item]));
  for (const reservation of reservations) knownTaskIds.add(reservation.taskId);
  for (const reservation of reservations) {
    for (const dependency of reservation.dependencies) {
      if (!knownTaskIds.has(dependency)) errors.push(`UNKNOWN_DEPENDENCY:${dependency}`);
      if (dependency === reservation.taskId) errors.push('SELF_DEPENDENCY');
      const dependencyReservation = reservationByTaskId.get(dependency);
      if (reservation.phase === 'SECOND'
        && dependencyReservation?.phase === 'FIRST'
        && dependencyReservation.round > reservation.round) {
        // The next round FIRST is materialized only after the current SECOND barrier.
        // Depending on it from the current SECOND would create a semantic deadlock
        // even when the raw graph has no structural cycle.
        errors.push('SECOND_DEPENDS_ON_FUTURE_FIRST');
      }
    }
  }

  // Reject allocation-internal dependency cycles before any downstream Core Session
  // is materialized. External/previous-round dependencies are already-known terminal
  // candidates and therefore cannot participate in a new-allocation cycle.
  const reservationIds = new Set(reservations.map(item => item.taskId).filter(Boolean));
  const graph = new Map(reservations.map(item => [
    item.taskId,
    item.dependencies.filter(dep => reservationIds.has(dep)),
  ]));
  const visiting = new Set();
  const visited = new Set();
  let cycle = false;
  const visit = id => {
    if (cycle || visited.has(id)) return;
    if (visiting.has(id)) { cycle = true; return; }
    visiting.add(id);
    for (const dep of graph.get(id) || []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
  if (cycle) errors.push('DEPENDENCY_CYCLE');
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    value: { ...value, currentSecond, nextFirst },
  };
}

export function dependenciesSatisfied(dependencies, completedTaskIds) {
  const completed = completedTaskIds instanceof Set ? completedTaskIds : new Set(strings(completedTaskIds));
  const missing = strings(dependencies).filter(id => !completed.has(id));
  return { ready: missing.length === 0, missing };
}

export function buildScenarioResultContract(expected = {}) {
  const payload = {
    scenario_id: expected.scenarioId || '<scenario-id>',
    generation: expected.generation || 1,
    round: expected.round || 1,
    phase: expected.phase || 'FIRST',
    slot: expected.slot || 'FIRST-01',
    task_id: expected.taskId || '<task-id>',
    exclusive_key: expected.exclusiveKey || '<exclusive-key>',
    outcome: 'DONE|READY_FOR_AUDIT|BLOCKED|HANDOFF|SUPERSEDED_WITH_SUCCESSOR|NO_SAFE_ASSIGNED_WORK|CHANGES_REQUIRED|PASS',
    slot_consumed: true,
    evidence_published: true,
    evidence_refs: ['<durable-reference>'],
    dependencies_consumed: strings(expected.dependencies),
    retry_required: false,
    failure_class: '',
  };
  return `\n\nSYSTEM CONTRACT — перед завершенням відповіді обов'язково надрукуй ОДИН фінальний машинний блок без тексту після нього. dependencies_consumed має ТОЧНО дорівнювати scheduler dependencies цього slot, без пропусків або вигаданих залежностей:\n${SCENARIO_RESULT_MARKER}\n${JSON.stringify(payload)}\n${SCENARIO_RESULT_END_MARKER}`;
}

export function buildAuditorAllocationContract(expected = {}) {
  const firstAudit = Array.isArray(expected.firstAudit)
    ? expected.firstAudit.map(item => ({
        task_id: item.taskId || '',
        slot: item.slot || '<FIRST-slot>',
        classification: item.slotConsumed ? '<terminal-classification>' : '<current-nonterminal-classification>',
        slot_consumed: item.slotConsumed === true,
        evidence_ref: item.slotConsumed ? (item.evidenceRef || '<durable-reference>') : '',
      }))
    : [];
  const payload = {
    scenario_id: expected.scenarioId || '<scenario-id>',
    generation: expected.generation || 1,
    round: expected.round || 1,
    allocation_id: '<unique-allocation-id>',
    readback_verified: true,
    allocation_evidence_refs: ['<Drive-or-control-readback-reference>'],
    first_audit: firstAudit,
    reservations: [{
      generation: expected.generation || 1,
      round: expected.round || 1,
      phase: 'SECOND',
      slot: 'SECOND-01',
      task_id: '<task-id>',
      exclusive_key: '<exclusive-key>',
      scheduler_dependencies: [],
      source_ref: '<Drive-or-control-reference>',
      prompt: '',
    }],
  };
  return `\n\nSYSTEM CONTRACT — перед завершенням відповіді обов'язково надрукуй ОДИН фінальний машинний блок без тексту після нього. first_audit має рівно один запис на кожен FIRST зі знімка запуску аудитора; slot_consumed не можна змінювати заднім числом. allocation_evidence_refs має містити durable readback-посилання. Кожна reservation повинна мати source_ref. reservations мають містити точну алокацію, а scheduler_dependencies — лише внутрішні task_id, які реально блокують запуск; цикли залежностей заборонені:\n${AUDITOR_ALLOCATION_MARKER}\n${JSON.stringify(payload)}\n${AUDITOR_ALLOCATION_END_MARKER}`;
}
