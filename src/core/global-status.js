import { scenarioWorkParticipants } from './scenario-work.js';

const CATEGORIES = Object.freeze([
  'RUNNING', 'WAITING_RESPONSE', 'READY', 'PAUSED', 'RECOVERING',
  'ERROR', 'AMBIGUOUS_EFFECT', 'COMPLETED', 'STOPPED',
]);
const MANAGED_FIELDS = ['scenarioWork', 'orchestrationCoordinator', 'orchestrationWorker', 'remoteDispatch'];
const num = value => Math.max(0, Number(value) || 0);
const managed = session => MANAGED_FIELDS.some(key => session?.[key]?.managed === true);
const ambiguous = session => session?.operation?.phase === 'AMBIGUOUS';

function sessionCategory(session) {
  if (ambiguous(session)) return 'AMBIGUOUS_EFFECT';
  if (session.runState === 'PAUSED') return 'PAUSED';
  if (session.runState === 'RECOVERING') return 'RECOVERING';
  if (session.runState === 'ERROR') return 'ERROR';
  if (session.runState === 'RUNNING') {
    if (session.operation?.phase === 'SENT_VERIFIED') return 'WAITING_RESPONSE';
    return 'RUNNING';
  }
  if (session.completedAt && session.runMode === 'ONE_PASS') return 'COMPLETED';
  return 'STOPPED';
}

function scenarioCategory(runtime, participant, coreSession) {
  if (ambiguous(coreSession)) return 'AMBIGUOUS_EFFECT';
  if (runtime.runState === 'PAUSED') return 'PAUSED';
  if (runtime.runState === 'ERROR') return 'ERROR';
  if (coreSession?.runState === 'RECOVERING') return 'RECOVERING';
  if (runtime.runState === 'STOPPED') return 'STOPPED';
  if (runtime.runState === 'COMPLETED') return 'COMPLETED';
  if (participant.state === 'WAITING') {
    return coreSession?.operation?.phase === 'SENT_VERIFIED' ? 'WAITING_RESPONSE' : 'RUNNING';
  }
  return participant.state === 'READY' || participant.state === 'COMPLETE' ? 'READY' : 'RUNNING';
}

function hierarchyCategory(lifecycle, ownerPaused, enabled) {
  if (ownerPaused) return 'PAUSED';
  if (!enabled) return 'STOPPED';
  if (lifecycle === 'MANUAL_REVIEW') return 'AMBIGUOUS_EFFECT';
  if (lifecycle === 'PAUSED') return 'PAUSED';
  if (lifecycle === 'STOPPED') return 'STOPPED';
  if (lifecycle === 'FAILED' || lifecycle === 'ERROR') return 'ERROR';
  if (lifecycle === 'AMBIGUOUS') return 'AMBIGUOUS_EFFECT';
  if (lifecycle === 'WAITING' || lifecycle === 'ACTIVE') return 'WAITING_RESPONSE';
  if (lifecycle === 'TERMINAL' || lifecycle === 'IDLE' || lifecycle === 'READY') return 'READY';
  return 'RUNNING';
}

function agentCategory(state) {
  if (state === 'COMPLETED') return 'COMPLETED';
  if (state === 'PAUSED') return 'PAUSED';
  if (state === 'ERROR') return 'ERROR';
  if (state === 'STOPPED') return 'STOPPED';
  if (state?.startsWith('WAITING_')) return 'READY';
  return 'RUNNING';
}

function verifiedScenarioTurn(participant, session) {
  // A verified Core effect can precede its assistant response. The latter is
  // counted in totalCompletedTurns; count only the still-in-flight effect here.
  return participant.state === 'WAITING'
    && session?.operation?.phase === 'SENT_VERIFIED'
    && num(session.successfulSendCount) > 0;
}

/** Pure read projection: no scheduler, counter mutation, or optimistic Send. */
export function projectGlobalStatus({ coreState = {}, scenarios = [], orchestras = [], agentJobs = [], modelWorkers = [] } = {}) {
  const sessionsById = coreState.sessionsById || {};
  const sessionOrder = coreState.sessionOrder || [];
  const units = [];
  const sessions = [];
  const simplifiedSessions = [];
  const scenarioSlots = [];
  const orchestration = [];
  const agents = [];
  const models = [];
  let scenarioVerifiedSends = 0;
  let verifiedSendHistoryComplete = true;
  const add = unit => { if (CATEGORIES.includes(unit.category)) units.push(unit); };

  for (const id of sessionOrder) {
    const session = sessionsById[id];
    if (!session || managed(session)) continue;
    const row = {
      id, name: session.name, category: sessionCategory(session),
      verifiedSends: num(session.successfulSendCount),
      completedCycles: num(session.cycleCount ?? session.onePassCompletedCount),
    };
    if (session.simplifiedSession === true) simplifiedSessions.push(row);
    else sessions.push(row);
    add({ ...row, kind: session.simplifiedSession === true ? 'SIMPLIFIED_SESSION' : 'SESSION' });
  }

  for (const scenario of scenarios) {
    const runtime = scenario.runtime || {};
    const config = scenario.config || {};
    const steps = Array.isArray(config.steps) ? config.steps : [];
    const generationSize = steps.reduce((n, step) => n + Math.max(1, Number(step.repeat) || 1), 0);
    const turnsPerGeneration = generationSize * Math.max(1, Number(config.roundsPerGeneration) || 1);
    const completedTurns = num(runtime.totalCompletedTurns);
    const completedInGeneration = runtime.mode === 'CHAT_CYCLE'
      ? Math.max(0, Math.min(turnsPerGeneration, completedTurns - (Math.max(1, num(runtime.generation)) - 1) * turnsPerGeneration))
      : 0;
    const pendingCleanup = new Set(runtime.cleanupPendingSessionIds || []);
    const activeSessions = Object.values(sessionsById).filter(session =>
      session?.scenarioWork?.managed === true
      && session.scenarioWork.scenarioId === scenario.id
      && !pendingCleanup.has(session.id));
    const activeConfirmed = activeSessions.reduce((n, session) => n + num(session.successfulSendCount), 0);
    const generationActiveConfirmed = activeSessions
      .filter(session => num(session.scenarioWork.generation) === num(runtime.generation))
      .reduce((n, session) => n + num(session.successfulSendCount), 0);
    const historyKnown = runtime.verifiedSendHistoryComplete === true;
    if (!historyKnown) verifiedSendHistoryComplete = false;
    const stepPosition = num(runtime.round) * generationSize
      + steps.slice(0, num(runtime.stepIndex)).reduce((n, step) => n + Math.max(1, Number(step.repeat) || 1), 0)
      + num(runtime.repeatIndex) + 1;
    let inFlightVerified = 0;
    for (const participant of scenarioWorkParticipants(runtime)) {
      const session = sessionsById[participant.sessionId];
      const verifiedPending = verifiedScenarioTurn(participant, session);
      if (verifiedPending) inFlightVerified += 1;
      const row = {
        id: `${scenario.id}:${participant.key}`, scenario: scenario.name, role: participant.role,
        generation: num(participant.generation || runtime.generation),
        message: runtime.mode === 'CHAT_CYCLE' ? Math.min(stepPosition, turnsPerGeneration) : null,
        messagesPerGeneration: runtime.mode === 'CHAT_CYCLE' ? turnsPerGeneration : null,
        verifiedSends: runtime.mode === 'CHAT_CYCLE'
          ? (historyKnown
            ? num(runtime.generationRetiredVerifiedSends) + generationActiveConfirmed
            : Math.max(completedInGeneration + Number(verifiedPending),
              num(runtime.generationRetiredVerifiedSends) + generationActiveConfirmed))
          : num(session?.successfulSendCount),
        completedResponses: runtime.mode === 'CHAT_CYCLE' ? completedInGeneration : completedTurns,
        category: scenarioCategory(runtime, participant, session),
      };
      scenarioSlots.push(row);
      add({ ...row, kind: 'SCENARIO' });
    }
    const durableTotal = num(runtime.retiredVerifiedSends) + activeConfirmed;
    scenarioVerifiedSends += historyKnown
      ? durableTotal
      : Math.max(completedTurns + inFlightVerified, durableTotal);
  }

  for (const orchestra of orchestras) {
    const hierarchy = orchestra.runtime?.hierarchy;
    const lifecycleCounts = hierarchy?.effectCounts || hierarchy?.lifecycleCounts || {};
    const counts = Object.fromEntries(CATEGORIES.map(key => [key, 0]));
    if (hierarchy?.nodeCount) {
      for (const [lifecycle, count] of Object.entries(lifecycleCounts)) {
        const category = hierarchy?.effectCounts
          ? orchestra.ownerPaused ? 'PAUSED' : orchestra.config?.enabled ? lifecycle : 'STOPPED'
          : hierarchyCategory(lifecycle, orchestra.ownerPaused, orchestra.config?.enabled);
        counts[category] += num(count);
        for (let i = 0; i < num(count); i += 1) add({ id: `${orchestra.id}:${lifecycle}:${i}`, kind: 'ORCHESTRATION', category });
      }
    } else {
      const category = orchestra.ownerPaused ? 'PAUSED' : orchestra.config?.enabled ? 'RUNNING' : 'STOPPED';
      add({ id: orchestra.id, kind: 'ORCHESTRATION', category });
      counts[category]++;
    }
    const roleEffectCounts = hierarchy?.roleEffectCounts || {};
    const projectedRoles = orchestra.ownerPaused || !orchestra.config?.enabled
      ? Object.fromEntries(['director', 'manager', 'worker'].map(role => [role, {
          READY: 0, WAITING_RESPONSE: 0,
          [orchestra.ownerPaused ? 'PAUSED' : 'STOPPED']: Object.values(roleEffectCounts[role] || {}).reduce((n, value) => n + num(value), 0),
        }]))
      : roleEffectCounts;
    orchestration.push({ id: orchestra.id, name: orchestra.name, round: num(hierarchy?.currentRound),
      director: num(hierarchy?.rootCount), managers: num(hierarchy?.managerCount),
      workers: num(hierarchy?.workerCount), phase: orchestra.runtime?.mode || '',
      roleCounts: hierarchy?.roleCounts || {}, roleEffectCounts: projectedRoles, counts });
  }

  for (const job of agentJobs) {
    const row = { id: job.id, name: job.config?.name || job.id,
      category: agentCategory(job.runtime?.runState), verifiedSends: 0 };
    agents.push(row);
    add({ ...row, kind: 'AGENT' });
  }
  for (const worker of modelWorkers) {
    const row = { id: worker.id, provider: worker.provider, model: worker.model,
      category: agentCategory(worker.state), verifiedSends: 0 };
    models.push(row);
    add({ ...row, kind: 'MODEL' });
  }
  const counts = Object.fromEntries(CATEGORIES.map(key => [key, units.filter(unit => unit.category === key).length]));
  const managedSends = Object.values(sessionsById)
    .filter(session => managed(session) && !session?.scenarioWork?.managed)
    .reduce((n, session) => n + num(session.successfulSendCount), 0);
  return {
    summary: {
      total: units.length, ...counts,
      verifiedSends: [...sessions, ...simplifiedSessions].reduce((n, row) => n + row.verifiedSends, managedSends + scenarioVerifiedSends),
      verifiedSendHistoryComplete,
      completedResponses: scenarios.reduce((n, scenario) => n + num(scenario.runtime?.totalCompletedTurns), 0),
    },
    sessions, simplifiedSessions, scenarioSlots, orchestration, agents, models,
  };
}
