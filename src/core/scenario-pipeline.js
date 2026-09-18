import {
  ScenarioBarrierPolicy,
  normalizeBarrierPolicy,
  parseScenarioResult,
  parseAuditorAllocation,
  validateScenarioResult,
  validateAuditorAllocation,
  dependenciesSatisfied,
  buildScenarioResultContract,
  buildAuditorAllocationContract,
} from './scenario-semantic.js';

const RUNNING = 'RUNNING';
const COMPLETED = 'COMPLETED';
const STOPPED = 'STOPPED';
const NEW = 'NEW';
const READY = 'READY';
const WAITING = 'WAITING';
const VERIFIED = 'COMPLETE';

function clone(value) { return structuredClone(value); }
function text(value) { return typeof value === 'string' ? value : ''; }
function trimmed(value) { return text(value).trim(); }
function int(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function pad(index) { return String(index).padStart(2, '0'); }
function phaseSlot(phase, index) { return `${phase}-${pad(index)}`; }

export function normalizePipelineConfig(raw = {}, common = {}) {
  return {
    ...common,
    firstCount: int(raw.firstCount, 10, 1, 100),
    secondCount: int(raw.secondCount, 9, 0, 100),
    barrierPolicy: normalizeBarrierPolicy(raw.barrierPolicy, ScenarioBarrierPolicy.TIMEBOXED_AUDIT),
    auditTimeboxMinutes: int(raw.auditTimeboxMinutes, 30, 1, 1440),
    maxCorrectionAttempts: int(raw.maxCorrectionAttempts, 2, 0, 10),
    maxReplacementAttempts: int(raw.maxReplacementAttempts, 2, 0, 10),
    firstWorkerPrompt: text(raw.firstWorkerPrompt) || text(raw.workerCyclePrompt) || 'Є на Drive. Виконай поточний FIRST slot.',
    secondWorkerPrompt: text(raw.secondWorkerPrompt) || text(raw.workerCyclePrompt) || 'Є на Drive. Виконай поточний SECOND slot.',
    auditorPrompt: text(raw.auditorPrompt) || text(raw.auditorCyclePrompt) || 'Є на Drive. Проаудитуй поточний раунд і створи наступну allocation.',
    workerCorrectionPrompt: text(raw.workerCorrectionPrompt) || 'Попередня відповідь не містила валідного машинного результату. Не повторюй виконану роботу. Перевір фактичний стан і поверни правильний фінальний AUTOPILOT_SCENARIO_RESULT.',
    auditorCorrectionPrompt: text(raw.auditorCorrectionPrompt) || 'Попередня allocation не пройшла машинну перевірку. Не створюй другу конкуруючу allocation. Виправ поточну відповідь/Drive readback і поверни один валідний AUTOPILOT_AUDITOR_ALLOCATION.',
  };
}

function workerSlot(config, runtime, phase, index, reservation = null, now = Date.now()) {
  const round = reservation?.round || runtime.round;
  const slot = reservation?.slot || phaseSlot(phase, index);
  return {
    key: `pipeline:g${runtime.generation}:r${round}:${phase.toLowerCase()}:${slot.toLowerCase()}`,
    role: 'WORKER',
    index,
    generation: runtime.generation,
    round,
    phase,
    slot,
    taskId: trimmed(reservation?.taskId),
    exclusiveKey: trimmed(reservation?.exclusiveKey),
    dependencies: Array.isArray(reservation?.dependencies) ? [...reservation.dependencies] : [],
    prompt: text(reservation?.prompt) || (phase === 'FIRST' ? config.firstWorkerPrompt : config.secondWorkerPrompt),
    sourceRef: trimmed(reservation?.sourceRef),
    state: READY,
    stage: `${phase}_WORK`,
    chatUrl: '',
    sessionId: '',
    taskIdCore: '',
    launchedAt: 0,
    deadlineAt: 0,
    completedAt: 0,
    replacementCount: 0,
    correctionCount: 0,
    correctionPending: false,
    replacementPending: false,
    replacementReason: '',
    validationErrors: [],
    result: null,
    createdAt: now,
  };
}

function auditor(runtime) {
  return {
    key: 'pipeline:auditor', role: 'AUDITOR', index: 0, generation: runtime.generation,
    state: READY, stage: 'AUDITOR_WORK', chatUrl: '', sessionId: '', taskId: '', launchedAt: 0,
    deadlineAt: 0, completedAt: 0, replacementCount: 0, correctionCount: 0,
    correctionPending: false, replacementPending: false, replacementReason: '', validationErrors: [],
    firstAuditSnapshot: null,
  };
}

function makeFirstSlots(config, runtime, reservations = null, now = Date.now()) {
  const out = {};
  for (let i = 1; i <= config.firstCount; i += 1) {
    const reservation = reservations?.find?.(item => item.slot === phaseSlot('FIRST', i)) || null;
    out[String(i)] = workerSlot(config, runtime, 'FIRST', i, reservation, now);
  }
  return out;
}

export function createPipelineRuntime(config, now = Date.now(), base = {}) {
  const runtime = {
    ...base,
    mode: 'AUDITOR_PIPELINE',
    runState: base.runState || STOPPED,
    generation: Number(base.generation || 1),
    round: 1,
    phase: 'FIRST',
    createdAt: base.createdAt || now,
    updatedAt: now,
    lastActionAt: 0,
    lastLaunchAt: 0,
    lastError: '',
    totalLaunches: Number(base.totalLaunches || 0),
    totalCompletedTurns: Number(base.totalCompletedTurns || 0),
    totalVerifiedSlots: 0,
    totalRejectedResults: 0,
    totalDependencyBlocks: 0,
    firstWaveStartedAt: now,
    auditEligibleAt: now + config.auditTimeboxMinutes * 60_000,
    firstSlots: {},
    secondSlots: {},
    nextFirstReservations: [],
    auditor: null,
    auditorLease: null,
    seenAllocationIds: [],
    allocation: null,
    diagnostics: { invalidWorkerResults: 0, invalidAuditorAllocations: 0, duplicateAuditorPrevented: 0 },
  };
  runtime.firstSlots = makeFirstSlots(config, runtime, null, now);
  runtime.auditor = auditor(runtime);
  return runtime;
}

function allVerified(slots) {
  const values = Object.values(slots || {});
  return values.length > 0 && values.every(item => item.state === VERIFIED);
}
function completedTaskIds(runtime) {
  const ids = [];
  for (const slot of [...Object.values(runtime.firstSlots || {}), ...Object.values(runtime.secondSlots || {})]) {
    if (slot.state === VERIFIED && slot.taskId) ids.push(slot.taskId);
  }
  for (const id of runtime.completedTaskIds || []) if (!ids.includes(id)) ids.push(id);
  return new Set(ids);
}
function knownTaskIds(runtime) {
  const ids = new Set(runtime.completedTaskIds || []);
  for (const slot of [...Object.values(runtime.firstSlots || {}), ...Object.values(runtime.secondSlots || {})]) if (slot.taskId) ids.add(slot.taskId);
  for (const item of runtime.nextFirstReservations || []) if (item.taskId) ids.add(item.taskId);
  return [...ids];
}

function firstAuditSnapshot(runtime) {
  return Object.values(runtime.firstSlots || {})
    .sort((a, b) => a.slot.localeCompare(b.slot))
    .map(slot => ({
      slot: slot.slot,
      taskId: slot.taskId || '',
      slotConsumed: slot.state === VERIFIED,
      evidenceRef: slot.result?.evidenceRefs?.[0] || '',
    }));
}

function actionForWorker(config, runtime, slot, now) {
  const replacement = slot.replacementPending === true;
  const correction = !replacement && slot.correctionPending;
  const expected = {
    scenarioId: config.id, generation: runtime.generation, round: slot.round, phase: slot.phase,
    slot: slot.slot, taskId: slot.taskId, exclusiveKey: slot.exclusiveKey,
    dependencies: [...(slot.dependencies || [])],
  };
  const base = replacement
    ? `${slot.prompt}\n\nRECOVERY: попередній чат вичерпав дозволені correction-спроби. Це новий фізичний чат для того самого slot; не змінюй task/exclusive scope. Причина: ${slot.replacementReason || (slot.validationErrors || []).join(', ')}`
    : correction
      ? `${config.workerCorrectionPrompt}\nValidation errors: ${(slot.validationErrors || []).join(', ')}`
      : slot.prompt;
  return {
    type: 'LAUNCH', participantKey: slot.key, role: 'WORKER', index: slot.index,
    generation: runtime.generation, stage: replacement ? `${slot.phase}_REPLACEMENT` : (correction ? `${slot.phase}_CORRECTION` : `${slot.phase}_WORK`),
    prompt: `${base}${buildScenarioResultContract(expected)}`,
    url: slot.chatUrl || config.workerLaunchUrl,
    replaceExistingChat: !slot.chatUrl,
    deadlineAt: now + config.responseTimeoutMinutes * 60_000,
    reason: replacement ? 'CORRECTION_EXHAUSTED_REPLACEMENT' : (correction ? 'INVALID_SCENARIO_RESULT' : ''),
  };
}

function actionForAuditor(config, runtime, now) {
  const replacement = runtime.auditor.replacementPending === true;
  const correction = !replacement && runtime.auditor.correctionPending;
  const snapshot = runtime.auditor.firstAuditSnapshot?.length
    ? clone(runtime.auditor.firstAuditSnapshot)
    : firstAuditSnapshot(runtime);
  const expected = { scenarioId: config.id, generation: runtime.generation, round: runtime.round, firstAudit: snapshot };
  const base = replacement
    ? `${config.auditorPrompt}\n\nRECOVERY: попередній auditor chat вичерпав correction-спроби. Це новий фізичний чат для ЦЬОГО САМОГО round; не створюй паралельну allocation. Причина: ${runtime.auditor.replacementReason || (runtime.auditor.validationErrors || []).join(', ')}`
    : correction
      ? `${config.auditorCorrectionPrompt}\nValidation errors: ${(runtime.auditor.validationErrors || []).join(', ')}`
      : config.auditorPrompt;
  return {
    type: 'LAUNCH', participantKey: runtime.auditor.key, role: 'AUDITOR', index: 0,
    generation: runtime.generation, stage: replacement ? 'AUDITOR_REPLACEMENT' : (correction ? 'AUDITOR_CORRECTION' : 'AUDITOR_WORK'),
    prompt: `${base}${buildAuditorAllocationContract(expected)}`,
    firstAuditSnapshot: snapshot,
    url: runtime.auditor.chatUrl || config.auditorLaunchUrl,
    replaceExistingChat: !runtime.auditor.chatUrl,
    deadlineAt: now + config.responseTimeoutMinutes * 60_000,
    reason: replacement ? 'CORRECTION_EXHAUSTED_REPLACEMENT' : (correction ? 'INVALID_AUDITOR_ALLOCATION' : ''),
  };
}

function dependencyReady(slot, runtime) {
  return dependenciesSatisfied(slot.dependencies, completedTaskIds(runtime));
}

function canLaunch(runtime, config, now) {
  return !config.minimumLaunchGapSeconds || !runtime.lastLaunchAt || now >= runtime.lastLaunchAt + config.minimumLaunchGapSeconds * 1000;
}

function resetAuditorForRound(runtime) {
  const keepUrl = runtime.auditor?.chatUrl || '';
  const replacements = runtime.auditor?.replacementCount || 0;
  runtime.auditor = auditor(runtime);
  runtime.auditor.chatUrl = keepUrl;
  runtime.auditor.replacementCount = replacements;
  runtime.auditorLease = null;
  runtime.allocation = null;
}

function advanceRound(config, runtime, now) {
  for (const slot of [...Object.values(runtime.firstSlots || {}), ...Object.values(runtime.secondSlots || {})]) {
    if (slot.state === VERIFIED && slot.taskId) {
      runtime.completedTaskIds ||= [];
      if (!runtime.completedTaskIds.includes(slot.taskId)) runtime.completedTaskIds.push(slot.taskId);
    }
  }
  if (runtime.round >= config.roundsPerGeneration) {
    if (config.maxGenerations > 0 && runtime.generation >= config.maxGenerations) {
      runtime.runState = COMPLETED;
      runtime.phase = 'COMPLETE';
      runtime.updatedAt = now;
      return;
    }
    runtime.generation += 1;
    runtime.round = 1;
    runtime.firstSlots = makeFirstSlots(config, runtime, null, now);
    runtime.secondSlots = {};
    runtime.nextFirstReservations = [];
    runtime.seenAllocationIds = [];
    runtime.completedTaskIds = [];
  } else {
    runtime.round += 1;
    runtime.firstSlots = makeFirstSlots(config, runtime, runtime.nextFirstReservations, now);
    runtime.secondSlots = {};
    runtime.nextFirstReservations = [];
  }
  runtime.phase = 'FIRST';
  runtime.firstWaveStartedAt = now;
  runtime.auditEligibleAt = now + config.auditTimeboxMinutes * 60_000;
  resetAuditorForRound(runtime);
  runtime.updatedAt = now;
}

export function planPipelineActions(config, runtimeRaw, now = Date.now()) {
  const runtime = clone(runtimeRaw);
  const actions = [];
  if (runtime.runState !== RUNNING) return { runtime, actions };

  const waiting = pipelineParticipants(runtime).filter(item => item.state === WAITING && item.deadlineAt > 0 && item.deadlineAt <= now);
  if (waiting.length) return { runtime, actions: waiting.map(item => ({ type: 'TIMEOUT', participantKey: item.key })) };

  if (runtime.phase === 'FIRST') {
    const firstDone = allVerified(runtime.firstSlots);
    const auditTime = config.barrierPolicy === ScenarioBarrierPolicy.TIMEBOXED_AUDIT && now >= runtime.auditEligibleAt;
    if (firstDone || auditTime) {
      runtime.phase = 'AUDITOR';
      runtime.updatedAt = now;
    } else if (canLaunch(runtime, config, now)) {
      for (const slot of Object.values(runtime.firstSlots)) {
        if (slot.state !== READY) continue;
        const gate = dependencyReady(slot, runtime);
        if (!gate.ready) { runtime.totalDependencyBlocks += 1; continue; }
        actions.push(actionForWorker(config, runtime, slot, now));
        if (config.minimumLaunchGapSeconds > 0) break;
      }
    }
  }

  if (runtime.phase === 'AUDITOR' && !actions.length) {
    if (runtime.auditor.state === READY && !runtime.auditorLease && canLaunch(runtime, config, now)) {
      actions.push(actionForAuditor(config, runtime, now));
    } else if (runtime.auditorLease?.active && runtime.auditor.state === READY) {
      runtime.diagnostics.duplicateAuditorPrevented += 1;
    }
  }

  if (runtime.phase === 'SECOND' && !actions.length) {
    const firstDone = allVerified(runtime.firstSlots);
    const secondDone = config.secondCount === 0 || allVerified(runtime.secondSlots);
    if (firstDone && secondDone) {
      advanceRound(config, runtime, now);
      if (runtime.runState !== RUNNING) return { runtime, actions };
      return planPipelineActions(config, runtime, now);
    }
    if (canLaunch(runtime, config, now)) {
      // TIMEBOXED_AUDIT is allowed to move planning forward, but unfinished FIRST
      // work remains live. Repairs/replacements continue even after allocation.
      for (const slot of Object.values(runtime.firstSlots)) {
        if (slot.state !== READY) continue;
        const gate = dependencyReady(slot, runtime);
        slot.missingDependencies = gate.missing;
        if (!gate.ready) { runtime.totalDependencyBlocks += 1; continue; }
        actions.push(actionForWorker(config, runtime, slot, now));
        if (config.minimumLaunchGapSeconds > 0) break;
      }
      if (config.minimumLaunchGapSeconds === 0 || actions.length === 0) {
        for (const slot of Object.values(runtime.secondSlots)) {
          if (slot.state !== READY) continue;
          const gate = dependencyReady(slot, runtime);
          slot.missingDependencies = gate.missing;
          if (!gate.ready) { runtime.totalDependencyBlocks += 1; continue; }
          actions.push(actionForWorker(config, runtime, slot, now));
          if (config.minimumLaunchGapSeconds > 0) break;
        }
      }
    }
  }
  return { runtime, actions };
}

function findSlot(runtime, key) {
  if (runtime.auditor?.key === key) return runtime.auditor;
  return [...Object.values(runtime.firstSlots || {}), ...Object.values(runtime.secondSlots || {})].find(item => item.key === key) || null;
}

export function applyPipelineLaunch(runtimeRaw, action, { sessionId = '', taskId = '', now = Date.now() } = {}) {
  const runtime = clone(runtimeRaw);
  const item = findSlot(runtime, action.participantKey);
  if (!item) throw new Error('Pipeline participant not found');
  item.state = WAITING;
  item.stage = action.stage;
  item.sessionId = sessionId;
  item.taskIdCore = taskId;
  if (item.role === 'AUDITOR') item.taskId = taskId;
  item.launchedAt = now;
  item.deadlineAt = Number(action.deadlineAt || 0);
  item.completedAt = 0;
  item.replacementPending = false;
  item.replacementReason = '';
  runtime.lastLaunchAt = now;
  runtime.lastActionAt = now;
  runtime.totalLaunches += 1;
  runtime.updatedAt = now;
  if (item.role === 'AUDITOR') {
    runtime.auditorLease = {
      active: true, generation: runtime.generation, round: runtime.round,
      token: `g${runtime.generation}:r${runtime.round}:${now}`,
      launchedAt: now,
      firstAuditSnapshot: clone(runtime.auditor.firstAuditSnapshot?.length
        ? runtime.auditor.firstAuditSnapshot
        : (action.firstAuditSnapshot || firstAuditSnapshot(runtime))),
    };
    if (!runtime.auditor.firstAuditSnapshot?.length) {
      runtime.auditor.firstAuditSnapshot = clone(runtime.auditorLease.firstAuditSnapshot);
    }
  }
  return runtime;
}

function markForCorrection(item, errors, now) {
  item.state = READY;
  item.deadlineAt = 0;
  item.sessionId = '';
  item.taskIdCore = '';
  item.completedAt = now;
  item.correctionPending = true;
  item.replacementPending = false;
  item.correctionCount += 1;
  item.validationErrors = [...errors];
}

function markForFreshReplacement(item, errors, now, reason) {
  item.state = READY;
  item.deadlineAt = 0;
  item.sessionId = '';
  item.taskIdCore = '';
  item.completedAt = now;
  item.chatUrl = '';
  item.correctionPending = false;
  item.correctionCount = 0;
  item.replacementPending = true;
  item.replacementReason = reason;
  item.replacementCount = Number(item.replacementCount || 0) + 1;
  item.validationErrors = [...errors];
}

function markExhausted(runtime, item, errors, now, reason) {
  item.state = 'EXHAUSTED';
  item.deadlineAt = 0;
  item.sessionId = '';
  item.taskIdCore = '';
  item.completedAt = now;
  item.correctionPending = false;
  item.replacementPending = false;
  item.replacementReason = reason;
  item.validationErrors = [...errors];
  runtime.runState = STOPPED;
  runtime.lastError = `${reason}:${errors.join(',')}`;
  runtime.updatedAt = now;
}

function markVerifiedWorker(runtime, slot, verdict, chatUrl, now) {
  slot.state = VERIFIED;
  slot.chatUrl = trimmed(chatUrl) || slot.chatUrl;
  slot.deadlineAt = 0;
  slot.sessionId = '';
  slot.taskIdCore = '';
  slot.completedAt = now;
  slot.correctionPending = false;
  slot.replacementPending = false;
  slot.replacementReason = '';
  slot.validationErrors = [];
  slot.result = verdict.value;
  if (!slot.taskId) slot.taskId = verdict.value.taskId;
  if (!slot.exclusiveKey) slot.exclusiveKey = verdict.value.exclusiveKey;
  runtime.completedTaskIds ||= [];
  if (slot.taskId && !runtime.completedTaskIds.includes(slot.taskId)) runtime.completedTaskIds.push(slot.taskId);
  runtime.totalVerifiedSlots += 1;
  runtime.totalCompletedTurns += 1;
  runtime.updatedAt = now;
}

function installAllocation(config, runtime, verdict, chatUrl, now) {
  runtime.auditor.state = VERIFIED;
  runtime.auditor.chatUrl = trimmed(chatUrl) || runtime.auditor.chatUrl;
  runtime.auditor.deadlineAt = 0;
  runtime.auditor.sessionId = '';
  runtime.auditor.taskId = '';
  runtime.auditor.completedAt = now;
  runtime.auditor.correctionPending = false;
  runtime.auditor.replacementPending = false;
  runtime.auditor.replacementReason = '';
  runtime.auditor.validationErrors = [];
  runtime.auditorLease = { ...(runtime.auditorLease || {}), active: false, verified: true, allocationId: verdict.value.allocationId };
  runtime.seenAllocationIds.push(verdict.value.allocationId);
  runtime.allocation = verdict.value;
  runtime.secondSlots = {};
  verdict.value.currentSecond.sort((a, b) => a.slot.localeCompare(b.slot)).forEach((reservation, index) => {
    runtime.secondSlots[String(index + 1)] = workerSlot(config, runtime, 'SECOND', index + 1, reservation, now);
  });
  runtime.nextFirstReservations = verdict.value.nextFirst.map(item => ({ ...item }));
  runtime.phase = 'SECOND';
  runtime.totalCompletedTurns += 1;
  runtime.updatedAt = now;
}

export function applyPipelineAssistantCompletion(config, runtimeRaw, participantKey, { assistantText = '', chatUrl = '', now = Date.now() } = {}) {
  const runtime = clone(runtimeRaw);
  const item = findSlot(runtime, participantKey);
  if (!item || item.state !== WAITING) return runtime;
  item.chatUrl = trimmed(chatUrl) || item.chatUrl;

  if (item.role === 'AUDITOR') {
    const raw = parseAuditorAllocation(assistantText);
    const verdict = validateAuditorAllocation(raw, {
      scenarioId: config.id, generation: runtime.generation, round: runtime.round,
      finalRound: runtime.round >= config.roundsPerGeneration,
      secondCount: config.secondCount, nextFirstCount: config.firstCount,
      firstAudit: runtime.auditor.firstAuditSnapshot?.length
        ? runtime.auditor.firstAuditSnapshot
        : (runtime.auditorLease?.firstAuditSnapshot || firstAuditSnapshot(runtime)),
      knownTaskIds: knownTaskIds(runtime), seenAllocationIds: new Set(runtime.seenAllocationIds || []),
    });
    if (!verdict.ok) {
      runtime.totalRejectedResults += 1;
      runtime.diagnostics.invalidAuditorAllocations += 1;
      runtime.auditorLease = null;
      if (item.correctionCount < config.maxCorrectionAttempts) markForCorrection(item, verdict.errors, now);
      else if (item.replacementCount < config.maxReplacementAttempts) {
        markForFreshReplacement(item, verdict.errors, now, 'AUDITOR_CORRECTION_EXHAUSTED');
        runtime.lastError = `AUDITOR_ALLOCATION_INVALID_REPLACEMENT:${verdict.errors.join(',')}`;
      } else {
        markExhausted(runtime, item, verdict.errors, now, 'AUDITOR_REPLACEMENT_EXHAUSTED');
      }
      runtime.updatedAt = now;
      return runtime;
    }
    installAllocation(config, runtime, verdict, chatUrl, now);
    return runtime;
  }

  const raw = parseScenarioResult(assistantText);
  const verdict = validateScenarioResult(raw, {
    scenarioId: config.id, generation: runtime.generation, round: item.round, phase: item.phase,
    slot: item.slot, taskId: item.taskId, exclusiveKey: item.exclusiveKey,
    dependencies: [...(item.dependencies || [])],
  });
  if (!verdict.ok) {
    runtime.totalRejectedResults += 1;
    runtime.diagnostics.invalidWorkerResults += 1;
    if (item.correctionCount < config.maxCorrectionAttempts) markForCorrection(item, verdict.errors, now);
    else if (item.replacementCount < config.maxReplacementAttempts) {
      markForFreshReplacement(item, verdict.errors, now, 'WORKER_CORRECTION_EXHAUSTED');
      runtime.lastError = `SCENARIO_RESULT_INVALID_REPLACEMENT:${verdict.errors.join(',')}`;
    } else {
      markExhausted(runtime, item, verdict.errors, now, 'WORKER_REPLACEMENT_EXHAUSTED');
    }
    runtime.updatedAt = now;
    return runtime;
  }
  markVerifiedWorker(runtime, item, verdict, chatUrl, now);
  return runtime;
}

export function applyPipelineTimeout(config, runtimeRaw, participantKey, { now = Date.now(), reason = 'TIMEOUT' } = {}) {
  const runtime = clone(runtimeRaw);
  const item = findSlot(runtime, participantKey);
  if (!item || item.state !== WAITING) return runtime;
  item.deadlineAt = 0;
  item.sessionId = '';
  item.taskIdCore = '';
  item.validationErrors = [reason];
  item.chatUrl = '';
  if (item.role === 'AUDITOR') runtime.auditorLease = null;
  if (item.replacementCount < config.maxReplacementAttempts) {
    markForFreshReplacement(item, [reason], now, item.role === 'AUDITOR' ? 'AUDITOR_TIMEOUT' : 'WORKER_TIMEOUT');
    runtime.lastError = reason;
  } else {
    markExhausted(runtime, item, [reason], now, item.role === 'AUDITOR' ? 'AUDITOR_TIMEOUT_REPLACEMENT_EXHAUSTED' : 'WORKER_TIMEOUT_REPLACEMENT_EXHAUSTED');
  }
  runtime.updatedAt = now;
  return runtime;
}

export function pipelineParticipants(runtime) {
  if (!runtime || runtime.mode !== 'AUDITOR_PIPELINE') return [];
  return [runtime.auditor, ...Object.values(runtime.firstSlots || {}), ...Object.values(runtime.secondSlots || {})].filter(Boolean);
}

export function pipelineSummary(runtime) {
  const first = Object.values(runtime.firstSlots || {});
  const second = Object.values(runtime.secondSlots || {});
  const completed = completedTaskIds(runtime);
  const blocked = [...first, ...second].filter(slot => slot.state === READY && !dependenciesSatisfied(slot.dependencies, completed).ready);
  return {
    generation: runtime.generation,
    round: runtime.round,
    phase: runtime.phase,
    firstVerified: first.filter(slot => slot.state === VERIFIED).length,
    firstTotal: first.length,
    secondVerified: second.filter(slot => slot.state === VERIFIED).length,
    secondTotal: second.length,
    dependencyBlocked: blocked.length,
    invalidWorkerResults: runtime.diagnostics?.invalidWorkerResults || 0,
    invalidAuditorAllocations: runtime.diagnostics?.invalidAuditorAllocations || 0,
    allocationId: runtime.allocation?.allocationId || '',
    auditorLeaseActive: runtime.auditorLease?.active === true,
  };
}
