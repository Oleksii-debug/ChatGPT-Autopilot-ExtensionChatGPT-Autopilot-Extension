import {
  normalizePipelineConfig,
  createPipelineRuntime,
  planPipelineActions,
  applyPipelineLaunch,
  applyPipelineAssistantCompletion,
  applyPipelineTimeout,
  pipelineParticipants,
} from './scenario-pipeline.js';
export const ScenarioWorkMode = Object.freeze({
  CHAT_CYCLE: 'CHAT_CYCLE',
  PAIRS: 'PAIRS',
  AUDITOR_GROUP: 'AUDITOR_GROUP',
  AUDITOR_PIPELINE: 'AUDITOR_PIPELINE',
});

export const ScenarioWorkRunState = Object.freeze({
  STOPPED: 'STOPPED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  ERROR: 'ERROR',
});

export const ScenarioParticipantState = Object.freeze({
  NEW: 'NEW',
  WAITING: 'WAITING',
  READY: 'READY',
  COMPLETE: 'COMPLETE',
  TIMED_OUT: 'TIMED_OUT',
  RETIRED: 'RETIRED',
});

export const ScenarioTimeoutPolicy = Object.freeze({
  REPLACE_MEMBER: 'REPLACE_MEMBER',
  RESTART_GROUP: 'RESTART_GROUP',
});

export const ScenarioPhase = Object.freeze({
  BOOTSTRAP_AUDITOR: 'BOOTSTRAP_AUDITOR',
  BOOTSTRAP_WORKERS: 'BOOTSTRAP_WORKERS',
  AUDITOR_WORK: 'AUDITOR_WORK',
  WORKERS_WORK: 'WORKERS_WORK',
  TIMEOUT_AUDITOR: 'TIMEOUT_AUDITOR',
  REPLACEMENT_BOOTSTRAP: 'REPLACEMENT_BOOTSTRAP',
  CHAT_SEQUENCE: 'CHAT_SEQUENCE',
  COMPLETE: 'COMPLETE',
});

const MODES = new Set(Object.values(ScenarioWorkMode));
const TIMEOUT_POLICIES = new Set(Object.values(ScenarioTimeoutPolicy));

function clone(value) { return structuredClone(value); }
function text(value) { return typeof value === 'string' ? value : ''; }
function trimmed(value) { return text(value).trim(); }
function int(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
function bool(value, fallback = false) { return value === undefined ? fallback : value === true; }

function normalizeChatUrl(value) {
  const raw = trimmed(value) || 'https://chatgpt.com/';
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Некоректне посилання ChatGPT.'); }
  if (parsed.protocol !== 'https:' || !['chatgpt.com', 'www.chatgpt.com'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('Дозволені лише https://chatgpt.com посилання.');
  }
  parsed.hostname = 'chatgpt.com';
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
  return parsed.toString();
}

function normalizeStep(raw, index) {
  const prompt = text(raw?.prompt);
  if (!prompt.trim()) throw new Error(`Крок ${index + 1}: промпт порожній.`);
  return {
    id: trimmed(raw?.id) || `step-${index + 1}`,
    label: trimmed(raw?.label) || `Промпт ${index + 1}`,
    prompt,
    repeat: int(raw?.repeat, 1, 1, 10000),
  };
}

export function normalizeScenarioWorkConfig(raw = {}) {
  const mode = MODES.has(raw.mode) ? raw.mode : ScenarioWorkMode.CHAT_CYCLE;
  const timeoutPolicy = TIMEOUT_POLICIES.has(raw.timeoutPolicy)
    ? raw.timeoutPolicy
    : ScenarioTimeoutPolicy.REPLACE_MEMBER;
  const common = {
    schemaVersion: 1,
    id: trimmed(raw.id) || '',
    name: trimmed(raw.name) || 'Сценарна робота',
    mode,
    enabled: bool(raw.enabled, true),
    roundsPerGeneration: int(raw.roundsPerGeneration, 10, 1, 10000),
    maxGenerations: int(raw.maxGenerations, 0, 0, 10000),
    responseTimeoutMinutes: int(raw.responseTimeoutMinutes, 40, 1, 1440),
    pollSeconds: int(raw.pollSeconds, 15, 5, 600),
    minimumLaunchGapSeconds: int(raw.minimumLaunchGapSeconds, 0, 0, 3600),
    preSendDelaySeconds: int(raw.preSendDelaySeconds, 10, 1, 30),
    busyCheckDelaySeconds: int(raw.busyCheckDelaySeconds, 3, 1, 30),
    retryBackoffSeconds: int(raw.retryBackoffSeconds, 30, 5, 3600),
    timeoutPolicy,
  };

  if (mode === ScenarioWorkMode.CHAT_CYCLE) {
    const steps = Array.isArray(raw.steps) ? raw.steps.map(normalizeStep) : [];
    if (!steps.length) steps.push(normalizeStep({ prompt: 'Продовжуй.' }, 0));
    return {
      ...common,
      launchUrl: normalizeChatUrl(raw.launchUrl),
      steps,
      restartCurrentRoundOnTimeout: bool(raw.restartCurrentRoundOnTimeout, true),
    };
  }

  const roleFields = {
    auditorLaunchUrl: normalizeChatUrl(raw.auditorLaunchUrl),
    workerLaunchUrl: normalizeChatUrl(raw.workerLaunchUrl),
    auditorBootstrapPrompt: text(raw.auditorBootstrapPrompt),
    workerBootstrapPrompt: text(raw.workerBootstrapPrompt),
    auditorCyclePrompt: text(raw.auditorCyclePrompt) || 'Є на Drive.',
    workerCyclePrompt: text(raw.workerCyclePrompt) || 'Є на Drive.',
    timeoutAuditorPrompt: text(raw.timeoutAuditorPrompt) || 'Один або кілька працівників не завершили роботу вчасно. Перевір стан, онови спільний контекст і підготуй відновлення.',
    replacementAuditorPrompt: text(raw.replacementAuditorPrompt) || 'Попередня команда була перезапущена після зависання. Віднови контекст, перевір останні результати й продовж роботу.',
  };

  if (mode === ScenarioWorkMode.PAIRS) {
    return {
      ...common,
      ...roleFields,
      pairCount: int(raw.pairCount, 1, 1, 100),
    };
  }

  if (mode === ScenarioWorkMode.AUDITOR_PIPELINE) {
    return normalizePipelineConfig(raw, { ...common, ...roleFields });
  }

  return {
    ...common,
    ...roleFields,
    workerCount: int(raw.workerCount, 5, 1, 200),
  };
}

function participant(key, role, index = 0, generation = 1) {
  return {
    key,
    role,
    index,
    generation,
    state: ScenarioParticipantState.NEW,
    stage: 'NONE',
    chatUrl: '',
    sessionId: '',
    taskId: '',
    launchedAt: 0,
    deadlineAt: 0,
    completedAt: 0,
    lastError: '',
    replacementCount: 0,
  };
}

function createPairRuntime(config, generation) {
  const pairs = {};
  for (let index = 1; index <= config.pairCount; index += 1) {
    pairs[String(index)] = {
      index,
      round: 0,
      phase: ScenarioPhase.BOOTSTRAP_AUDITOR,
      auditor: participant(`pair:${index}:auditor`, 'AUDITOR', index, generation),
      worker: participant(`pair:${index}:worker`, 'WORKER', index, generation),
      timedOutRole: '',
      recoveryReason: '',
    };
  }
  return pairs;
}

function createGroupRuntime(config, generation) {
  const workers = {};
  for (let index = 1; index <= config.workerCount; index += 1) {
    workers[String(index)] = participant(`group:worker:${index}`, 'WORKER', index, generation);
  }
  return {
    round: 0,
    phase: ScenarioPhase.BOOTSTRAP_AUDITOR,
    auditor: participant('group:auditor', 'AUDITOR', 0, generation),
    workers,
    timedOutWorkerIndexes: [],
    recoveryReason: '',
  };
}

export function createScenarioWorkRuntime(configRaw, now = Date.now()) {
  const config = normalizeScenarioWorkConfig(configRaw);
  const base = {
    schemaVersion: 1,
    scenarioId: config.id,
    mode: config.mode,
    runState: ScenarioWorkRunState.STOPPED,
    generation: 1,
    createdAt: now,
    updatedAt: now,
    lastActionAt: 0,
    lastLaunchAt: 0,
    nextLaunchAt: 0,
    lastError: '',
    totalLaunches: 0,
    totalCompletedTurns: 0,
  };
  if (config.mode === ScenarioWorkMode.CHAT_CYCLE) {
    return {
      ...base,
      phase: ScenarioPhase.CHAT_SEQUENCE,
      round: 0,
      stepIndex: 0,
      repeatIndex: 0,
      chat: participant('chat', 'CHAT', 0, 1),
    };
  }
  if (config.mode === ScenarioWorkMode.PAIRS) {
    return { ...base, phase: 'PAIRS', pairs: createPairRuntime(config, 1) };
  }
  if (config.mode === ScenarioWorkMode.AUDITOR_PIPELINE) {
    return createPipelineRuntime(config, now, base);
  }
  return { ...base, phase: 'GROUP', group: createGroupRuntime(config, 1) };
}

function allPairs(runtime, predicate) {
  return Object.values(runtime.pairs || {}).every(predicate);
}
function allWorkers(group, predicate) {
  return Object.values(group.workers || {}).every(predicate);
}
function generationLimitReached(runtime, config) {
  return config.maxGenerations > 0 && runtime.generation >= config.maxGenerations;
}

function resetParticipantForGeneration(item, generation) {
  const replacements = item.replacementCount || 0;
  Object.assign(item, participant(item.key, item.role, item.index, generation));
  item.replacementCount = replacements;
}

function startNextGeneration(runtime, config, now) {
  if (generationLimitReached(runtime, config)) {
    runtime.runState = ScenarioWorkRunState.COMPLETED;
    runtime.phase = ScenarioPhase.COMPLETE;
    runtime.updatedAt = now;
    return false;
  }
  runtime.generation += 1;
  runtime.updatedAt = now;
  if (runtime.mode === ScenarioWorkMode.CHAT_CYCLE) {
    runtime.round = 0;
    runtime.stepIndex = 0;
    runtime.repeatIndex = 0;
    resetParticipantForGeneration(runtime.chat, runtime.generation);
    runtime.phase = ScenarioPhase.CHAT_SEQUENCE;
  } else if (runtime.mode === ScenarioWorkMode.PAIRS) {
    runtime.pairs = createPairRuntime(config, runtime.generation);
  } else {
    runtime.group = createGroupRuntime(config, runtime.generation);
  }
  return true;
}

function due(item, now) {
  return item?.state === ScenarioParticipantState.WAITING && Number(item.deadlineAt || 0) > 0 && Number(item.deadlineAt) <= now;
}

function launchAction(item, prompt, stage, launchUrl, now, config, reason = '') {
  return {
    type: 'LAUNCH',
    participantKey: item.key,
    role: item.role,
    index: item.index,
    generation: item.generation,
    stage,
    prompt,
    url: item.chatUrl || launchUrl,
    replaceExistingChat: !item.chatUrl,
    deadlineAt: now + config.responseTimeoutMinutes * 60_000,
    reason,
  };
}

function canLaunch(runtime, config, now) {
  if (!config.minimumLaunchGapSeconds) return true;
  const launchSpacingAt = runtime.lastLaunchAt
    ? runtime.lastLaunchAt + config.minimumLaunchGapSeconds * 1000
    : 0;
  const completionSpacingAt = Math.max(0, Number(runtime.nextLaunchAt || 0));
  return now >= Math.max(launchSpacingAt, completionSpacingAt);
}

function recordCompletionRelativeLaunchDeadline(runtime, config, now) {
  runtime.nextLaunchAt = config.minimumLaunchGapSeconds > 0
    ? now + config.minimumLaunchGapSeconds * 1000
    : 0;
}

function promptForBootstrap(prompt, fallback) {
  return text(prompt).trim() ? text(prompt) : fallback;
}

export function planScenarioWorkActions(configRaw, runtimeRaw, now = Date.now()) {
  const config = normalizeScenarioWorkConfig(configRaw);
  const runtime = clone(runtimeRaw || createScenarioWorkRuntime(config, now));
  const actions = [];
  if (runtime.runState !== ScenarioWorkRunState.RUNNING) return { runtime, actions };

  // Timeouts are safety/liveness events, not launches. Never let the minimum
  // launch gap postpone recognition of a participant that has already missed
  // its durable response deadline.
  if (config.mode === ScenarioWorkMode.CHAT_CYCLE) {
    if (due(runtime.chat, now)) {
      actions.push({ type: 'TIMEOUT', participantKey: runtime.chat.key });
      return { runtime, actions };
    }
    if (!canLaunch(runtime, config, now)) return { runtime, actions };
    if (runtime.chat.state === ScenarioParticipantState.NEW || runtime.chat.state === ScenarioParticipantState.READY) {
      const step = config.steps[runtime.stepIndex];
      actions.push(launchAction(runtime.chat, step.prompt, `STEP:${runtime.round}:${runtime.stepIndex}:${runtime.repeatIndex}`, config.launchUrl, now, config));
    }
    return { runtime, actions };
  }

  if (config.mode === ScenarioWorkMode.AUDITOR_PIPELINE) {
    // Pipeline owns its own timeout-first planner and applies launch-gap only
    // to actual LAUNCH actions.
    return planPipelineActions(config, runtime, now);
  }

  if (config.mode === ScenarioWorkMode.PAIRS) {
    for (const pair of Object.values(runtime.pairs)) {
      if (due(pair.auditor, now)) actions.push({ type: 'TIMEOUT', participantKey: pair.auditor.key });
      if (due(pair.worker, now)) actions.push({ type: 'TIMEOUT', participantKey: pair.worker.key });
    }
    if (actions.length) return { runtime, actions };
    if (!canLaunch(runtime, config, now)) return { runtime, actions };

    for (const pair of Object.values(runtime.pairs)) {
      if (!canLaunch(runtime, config, now) && actions.length) break;
      if (pair.phase === ScenarioPhase.BOOTSTRAP_AUDITOR && pair.auditor.state === ScenarioParticipantState.NEW) {
        const prompt = promptForBootstrap(config.auditorBootstrapPrompt, config.auditorCyclePrompt);
        actions.push(launchAction(pair.auditor, prompt, 'BOOTSTRAP_AUDITOR', config.auditorLaunchUrl, now, config));
      } else if (pair.phase === ScenarioPhase.BOOTSTRAP_WORKERS && pair.worker.state === ScenarioParticipantState.NEW) {
        const prompt = promptForBootstrap(config.workerBootstrapPrompt, config.workerCyclePrompt);
        actions.push(launchAction(pair.worker, prompt, 'BOOTSTRAP_WORKER', config.workerLaunchUrl, now, config));
      } else if (pair.phase === ScenarioPhase.AUDITOR_WORK && pair.auditor.state === ScenarioParticipantState.READY) {
        actions.push(launchAction(pair.auditor, config.auditorCyclePrompt, 'AUDITOR_WORK', config.auditorLaunchUrl, now, config));
      } else if (pair.phase === ScenarioPhase.WORKERS_WORK && pair.worker.state === ScenarioParticipantState.READY) {
        actions.push(launchAction(pair.worker, config.workerCyclePrompt, 'WORKER_WORK', config.workerLaunchUrl, now, config));
      } else if (pair.phase === ScenarioPhase.TIMEOUT_AUDITOR && pair.auditor.state === ScenarioParticipantState.READY) {
        actions.push(launchAction(pair.auditor, config.timeoutAuditorPrompt, 'TIMEOUT_AUDITOR', config.auditorLaunchUrl, now, config, pair.recoveryReason));
      } else if (pair.phase === ScenarioPhase.REPLACEMENT_BOOTSTRAP) {
        const target = pair.timedOutRole === 'AUDITOR' ? pair.auditor : pair.worker;
        if (target.state === ScenarioParticipantState.NEW) {
          const prompt = target.role === 'AUDITOR'
            ? promptForBootstrap(config.replacementAuditorPrompt, config.auditorBootstrapPrompt || config.auditorCyclePrompt)
            : promptForBootstrap(config.workerBootstrapPrompt, config.workerCyclePrompt);
          actions.push(launchAction(target, prompt, `REPLACEMENT_${target.role}`, target.role === 'AUDITOR' ? config.auditorLaunchUrl : config.workerLaunchUrl, now, config, pair.recoveryReason));
        }
      }
      if (actions.length && config.minimumLaunchGapSeconds > 0) break;
    }
    return { runtime, actions };
  }

  const group = runtime.group;
  if (due(group.auditor, now)) actions.push({ type: 'TIMEOUT', participantKey: group.auditor.key });
  for (const worker of Object.values(group.workers)) if (due(worker, now)) actions.push({ type: 'TIMEOUT', participantKey: worker.key });
  if (actions.length) return { runtime, actions };
  if (!canLaunch(runtime, config, now)) return { runtime, actions };

  if (group.phase === ScenarioPhase.BOOTSTRAP_AUDITOR && group.auditor.state === ScenarioParticipantState.NEW) {
    actions.push(launchAction(group.auditor, promptForBootstrap(config.auditorBootstrapPrompt, config.auditorCyclePrompt), 'BOOTSTRAP_AUDITOR', config.auditorLaunchUrl, now, config));
  } else if (group.phase === ScenarioPhase.BOOTSTRAP_WORKERS) {
    for (const worker of Object.values(group.workers)) {
      if (worker.state !== ScenarioParticipantState.NEW) continue;
      actions.push(launchAction(worker, promptForBootstrap(config.workerBootstrapPrompt, config.workerCyclePrompt), 'BOOTSTRAP_WORKER', config.workerLaunchUrl, now, config));
      if (config.minimumLaunchGapSeconds > 0) break;
    }
  } else if (group.phase === ScenarioPhase.AUDITOR_WORK && group.auditor.state === ScenarioParticipantState.READY) {
    actions.push(launchAction(group.auditor, config.auditorCyclePrompt, 'AUDITOR_WORK', config.auditorLaunchUrl, now, config));
  } else if (group.phase === ScenarioPhase.WORKERS_WORK) {
    for (const worker of Object.values(group.workers)) {
      if (worker.state !== ScenarioParticipantState.READY) continue;
      actions.push(launchAction(worker, config.workerCyclePrompt, 'WORKER_WORK', config.workerLaunchUrl, now, config));
      if (config.minimumLaunchGapSeconds > 0) break;
    }
  } else if (group.phase === ScenarioPhase.TIMEOUT_AUDITOR && group.auditor.state === ScenarioParticipantState.READY) {
    actions.push(launchAction(group.auditor, config.timeoutAuditorPrompt, 'TIMEOUT_AUDITOR', config.auditorLaunchUrl, now, config, group.recoveryReason));
  } else if (group.phase === ScenarioPhase.REPLACEMENT_BOOTSTRAP) {
    const pending = group.timedOutWorkerIndexes.map(index => group.workers[String(index)]).filter(worker => worker?.state === ScenarioParticipantState.NEW);
    if (pending.length) {
      for (const worker of pending) {
        actions.push(launchAction(worker, promptForBootstrap(config.workerBootstrapPrompt, config.workerCyclePrompt), 'REPLACEMENT_WORKER', config.workerLaunchUrl, now, config, group.recoveryReason));
        if (config.minimumLaunchGapSeconds > 0) break;
      }
    } else if (group.auditor.state === ScenarioParticipantState.NEW) {
      actions.push(launchAction(group.auditor, promptForBootstrap(config.replacementAuditorPrompt, config.auditorCyclePrompt), 'REPLACEMENT_AUDITOR', config.auditorLaunchUrl, now, config, group.recoveryReason));
    }
  }
  return { runtime, actions };
}

function findParticipant(runtime, key) {
  if (runtime.mode === ScenarioWorkMode.CHAT_CYCLE) return runtime.chat?.key === key ? runtime.chat : null;
  if (runtime.mode === ScenarioWorkMode.PAIRS) {
    for (const pair of Object.values(runtime.pairs || {})) {
      if (pair.auditor.key === key) return pair.auditor;
      if (pair.worker.key === key) return pair.worker;
    }
    return null;
  }
  if (runtime.group?.auditor?.key === key) return runtime.group.auditor;
  for (const worker of Object.values(runtime.group?.workers || {})) if (worker.key === key) return worker;
  return null;
}

export function applyScenarioLaunch(runtimeRaw, action, { sessionId, taskId, now = Date.now() } = {}) {
  if (runtimeRaw?.mode === ScenarioWorkMode.AUDITOR_PIPELINE) {
    return applyPipelineLaunch(runtimeRaw, action, { sessionId, taskId, now });
  }
  const runtime = clone(runtimeRaw);
  const item = findParticipant(runtime, action.participantKey);
  if (!item) throw new Error('Учасника сценарію не знайдено.');
  item.state = ScenarioParticipantState.WAITING;
  item.stage = action.stage;
  item.sessionId = sessionId || item.sessionId;
  item.taskId = taskId || item.taskId;
  item.launchedAt = now;
  item.deadlineAt = Number(action.deadlineAt || 0);
  item.completedAt = 0;
  item.lastError = '';
  runtime.lastLaunchAt = now;
  runtime.lastActionAt = now;
  runtime.totalLaunches += 1;
  runtime.updatedAt = now;
  return runtime;
}

function markReady(item, { chatUrl = '', now = Date.now() } = {}) {
  item.state = ScenarioParticipantState.READY;
  item.chatUrl = trimmed(chatUrl) || item.chatUrl;
  item.sessionId = '';
  item.taskId = '';
  item.deadlineAt = 0;
  item.completedAt = now;
  item.lastError = '';
}

function completeChatTurn(runtime, config, item, now) {
  markReady(item, { now });
  runtime.totalCompletedTurns += 1;
  const step = config.steps[runtime.stepIndex];
  if (runtime.repeatIndex + 1 < step.repeat) {
    runtime.repeatIndex += 1;
    return;
  }
  runtime.repeatIndex = 0;
  if (runtime.stepIndex + 1 < config.steps.length) {
    runtime.stepIndex += 1;
    return;
  }
  runtime.stepIndex = 0;
  runtime.round += 1;
  if (runtime.round >= config.roundsPerGeneration) startNextGeneration(runtime, config, now);
}

function pairForParticipant(runtime, key) {
  return Object.values(runtime.pairs || {}).find(pair => pair.auditor.key === key || pair.worker.key === key) || null;
}

function maybeAdvancePairsGeneration(runtime, config, now) {
  if (!allPairs(runtime, pair => pair.round >= config.roundsPerGeneration)) return;
  startNextGeneration(runtime, config, now);
}

function completePairTurn(runtime, config, pair, item, now) {
  const completedStage = item.stage;
  markReady(item, { now });
  runtime.totalCompletedTurns += 1;

  // A worker can time out while the auditor is already busy. We deliberately
  // do not inject a second prompt into that busy auditor; once the in-flight
  // turn completes, recovery must take precedence over the normal phase
  // transition and schedule the dedicated timeout-auditor turn.
  if (item.role === 'AUDITOR'
      && completedStage !== 'TIMEOUT_AUDITOR'
      && pair.timedOutRole === 'WORKER'
      && pair.worker.state === ScenarioParticipantState.TIMED_OUT) {
    pair.phase = ScenarioPhase.TIMEOUT_AUDITOR;
    return;
  }

  if (completedStage === 'BOOTSTRAP_AUDITOR') {
    pair.phase = ScenarioPhase.BOOTSTRAP_WORKERS;
  } else if (completedStage === 'BOOTSTRAP_WORKER') {
    pair.phase = ScenarioPhase.AUDITOR_WORK;
  } else if (completedStage === 'AUDITOR_WORK') {
    pair.phase = ScenarioPhase.WORKERS_WORK;
  } else if (completedStage === 'WORKER_WORK') {
    pair.round += 1;
    pair.phase = pair.round >= config.roundsPerGeneration ? ScenarioPhase.COMPLETE : ScenarioPhase.AUDITOR_WORK;
    maybeAdvancePairsGeneration(runtime, config, now);
  } else if (completedStage === 'TIMEOUT_AUDITOR') {
    if (config.timeoutPolicy === ScenarioTimeoutPolicy.RESTART_GROUP) {
      pair.timedOutRole = 'AUDITOR';
      resetParticipantForGeneration(pair.auditor, runtime.generation);
      resetParticipantForGeneration(pair.worker, runtime.generation);
      pair.auditor.replacementCount += 1;
      pair.worker.replacementCount += 1;
      pair.phase = ScenarioPhase.REPLACEMENT_BOOTSTRAP;
    } else {
      const target = pair.timedOutRole === 'AUDITOR' ? pair.auditor : pair.worker;
      resetParticipantForGeneration(target, runtime.generation);
      target.replacementCount += 1;
      pair.phase = ScenarioPhase.REPLACEMENT_BOOTSTRAP;
    }
  } else if (completedStage === 'REPLACEMENT_AUDITOR') {
    // If this auditor replacement happened while recovering a timed-out worker,
    // finish that recovery first. Otherwise resume the normal auditor turn when
    // the worker already has a durable chat; only a truly NEW worker needs
    // BOOTSTRAP_WORKERS.
    if (pair.timedOutRole === 'WORKER' && pair.worker.state === ScenarioParticipantState.TIMED_OUT) {
      pair.phase = ScenarioPhase.TIMEOUT_AUDITOR;
    } else {
      pair.phase = pair.worker.state === ScenarioParticipantState.NEW
        ? ScenarioPhase.BOOTSTRAP_WORKERS
        : ScenarioPhase.AUDITOR_WORK;
    }
  } else if (completedStage === 'REPLACEMENT_WORKER') {
    pair.phase = pair.round === 0 ? ScenarioPhase.AUDITOR_WORK : ScenarioPhase.WORKERS_WORK;
  }
}

function completeGroupTurn(runtime, config, group, item, now) {
  const completedStage = item.stage;
  markReady(item, { now });
  runtime.totalCompletedTurns += 1;

  // Same busy-auditor rule as pairs: a worker timeout discovered while an
  // auditor turn is already in flight becomes the next authoritative recovery
  // turn immediately after that in-flight turn completes.
  if (item.role === 'AUDITOR'
      && completedStage !== 'TIMEOUT_AUDITOR'
      && group.timedOutWorkerIndexes.length > 0
      && group.timedOutWorkerIndexes.some(index => group.workers[String(index)]?.state === ScenarioParticipantState.TIMED_OUT)) {
    group.phase = ScenarioPhase.TIMEOUT_AUDITOR;
    return;
  }

  if (completedStage === 'BOOTSTRAP_AUDITOR') {
    group.phase = ScenarioPhase.BOOTSTRAP_WORKERS;
  } else if (completedStage === 'BOOTSTRAP_WORKER') {
    if (allWorkers(group, worker => worker.state === ScenarioParticipantState.READY)) group.phase = ScenarioPhase.AUDITOR_WORK;
  } else if (completedStage === 'AUDITOR_WORK') {
    group.phase = ScenarioPhase.WORKERS_WORK;
  } else if (completedStage === 'WORKER_WORK') {
    if (allWorkers(group, worker => worker.state === ScenarioParticipantState.READY)) {
      group.round += 1;
      if (group.round >= config.roundsPerGeneration) startNextGeneration(runtime, config, now);
      else group.phase = ScenarioPhase.AUDITOR_WORK;
    }
  } else if (completedStage === 'TIMEOUT_AUDITOR') {
    if (config.timeoutPolicy === ScenarioTimeoutPolicy.RESTART_GROUP) {
      resetParticipantForGeneration(group.auditor, runtime.generation);
      group.auditor.replacementCount += 1;
      for (const worker of Object.values(group.workers)) {
        resetParticipantForGeneration(worker, runtime.generation);
        worker.replacementCount += 1;
      }
      group.timedOutWorkerIndexes = Object.values(group.workers).map(worker => worker.index);
      group.phase = ScenarioPhase.REPLACEMENT_BOOTSTRAP;
    } else {
      for (const index of group.timedOutWorkerIndexes) {
        const worker = group.workers[String(index)];
        resetParticipantForGeneration(worker, runtime.generation);
        worker.replacementCount += 1;
      }
      group.phase = ScenarioPhase.REPLACEMENT_BOOTSTRAP;
    }
  } else if (completedStage === 'REPLACEMENT_AUDITOR') {
    // An auditor can itself time out while handling worker recovery. In that
    // case the replacement auditor must still perform the dedicated recovery
    // turn before workers are reset. Otherwise resume normal work according to
    // the durable worker states.
    if (group.timedOutWorkerIndexes.some(index => group.workers[String(index)]?.state === ScenarioParticipantState.TIMED_OUT)) {
      group.phase = ScenarioPhase.TIMEOUT_AUDITOR;
    } else {
      group.phase = allWorkers(group, worker => worker.state === ScenarioParticipantState.READY)
        ? ScenarioPhase.AUDITOR_WORK
        : ScenarioPhase.BOOTSTRAP_WORKERS;
    }
  } else if (completedStage === 'REPLACEMENT_WORKER') {
    if (group.timedOutWorkerIndexes.every(index => group.workers[String(index)]?.state === ScenarioParticipantState.READY)) {
      group.timedOutWorkerIndexes = [];
      // RESTART_GROUP must not skip the replacement auditor. Keep the group in
      // replacement bootstrap while that auditor is still NEW.
      group.phase = group.auditor.state === ScenarioParticipantState.NEW
        ? ScenarioPhase.REPLACEMENT_BOOTSTRAP
        : ScenarioPhase.WORKERS_WORK;
    }
  }
}

export function applyScenarioCompletion(configRaw, runtimeRaw, participantKey, { chatUrl = '', assistantText = '', now = Date.now() } = {}) {
  const config = normalizeScenarioWorkConfig(configRaw);
  if (config.mode === ScenarioWorkMode.AUDITOR_PIPELINE) {
    return applyPipelineAssistantCompletion(config, runtimeRaw, participantKey, { chatUrl, assistantText, now });
  }
  const runtime = clone(runtimeRaw);
  const item = findParticipant(runtime, participantKey);
  if (!item || item.state !== ScenarioParticipantState.WAITING) return runtime;
  item.chatUrl = trimmed(chatUrl) || item.chatUrl;
  if (config.mode === ScenarioWorkMode.CHAT_CYCLE) completeChatTurn(runtime, config, item, now);
  else if (config.mode === ScenarioWorkMode.PAIRS) completePairTurn(runtime, config, pairForParticipant(runtime, participantKey), item, now);
  else completeGroupTurn(runtime, config, runtime.group, item, now);
  recordCompletionRelativeLaunchDeadline(runtime, config, now);
  runtime.lastActionAt = now;
  runtime.updatedAt = now;
  return runtime;
}

export function applyScenarioTimeout(configRaw, runtimeRaw, participantKey, { now = Date.now(), reason = 'Учасник не завершив відповідь до тайм-ауту.' } = {}) {
  const config = normalizeScenarioWorkConfig(configRaw);
  if (config.mode === ScenarioWorkMode.AUDITOR_PIPELINE) {
    return applyPipelineTimeout(config, runtimeRaw, participantKey, { now, reason });
  }
  const runtime = clone(runtimeRaw);
  const item = findParticipant(runtime, participantKey);
  if (!item || item.state !== ScenarioParticipantState.WAITING) return runtime;
  item.state = ScenarioParticipantState.TIMED_OUT;
  item.deadlineAt = 0;
  item.lastError = reason;
  runtime.lastError = reason;
  runtime.lastActionAt = now;
  runtime.updatedAt = now;

  if (config.mode === ScenarioWorkMode.CHAT_CYCLE) {
    item.state = ScenarioParticipantState.RETIRED;
    resetParticipantForGeneration(item, runtime.generation);
    item.replacementCount += 1;
    if (config.restartCurrentRoundOnTimeout) {
      runtime.stepIndex = 0;
      runtime.repeatIndex = 0;
    }
    return runtime;
  }

  if (config.mode === ScenarioWorkMode.PAIRS) {
    const pair = pairForParticipant(runtime, participantKey);
    pair.timedOutRole = item.role;
    pair.recoveryReason = reason;
    const auditor = pair.auditor;
    if (auditor.state === ScenarioParticipantState.WAITING && auditor.key !== participantKey) {
      // Do not inject a second prompt into a busy auditor. It will receive the
      // recovery prompt as soon as its current turn completes.
      return runtime;
    }
    if (item.role === 'AUDITOR') {
      resetParticipantForGeneration(auditor, runtime.generation);
      auditor.replacementCount += 1;
      pair.phase = ScenarioPhase.REPLACEMENT_BOOTSTRAP;
    } else {
      if (auditor.state === ScenarioParticipantState.NEW) auditor.state = ScenarioParticipantState.READY;
      pair.phase = ScenarioPhase.TIMEOUT_AUDITOR;
    }
    return runtime;
  }

  const group = runtime.group;
  group.recoveryReason = reason;
  if (item.role === 'AUDITOR') {
    resetParticipantForGeneration(group.auditor, runtime.generation);
    group.auditor.replacementCount += 1;
    group.phase = ScenarioPhase.REPLACEMENT_BOOTSTRAP;
  } else {
    if (!group.timedOutWorkerIndexes.includes(item.index)) group.timedOutWorkerIndexes.push(item.index);
    if (group.auditor.state === ScenarioParticipantState.NEW) group.auditor.state = ScenarioParticipantState.READY;
    if (group.auditor.state !== ScenarioParticipantState.WAITING) group.phase = ScenarioPhase.TIMEOUT_AUDITOR;
  }
  return runtime;
}

export function startScenarioWork(configRaw, runtimeRaw, now = Date.now()) {
  const config = normalizeScenarioWorkConfig(configRaw);
  const runtime = runtimeRaw ? clone(runtimeRaw) : createScenarioWorkRuntime(config, now);
  if (runtime.runState === ScenarioWorkRunState.COMPLETED) return createScenarioWorkRuntime(config, now);
  runtime.runState = ScenarioWorkRunState.RUNNING;
  runtime.updatedAt = now;
  runtime.lastError = '';
  return runtime;
}

export function pauseScenarioWork(runtimeRaw, now = Date.now()) {
  const runtime = clone(runtimeRaw);
  if (runtime.runState === ScenarioWorkRunState.RUNNING) runtime.runState = ScenarioWorkRunState.PAUSED;
  runtime.updatedAt = now;
  return runtime;
}

export function resumeScenarioWork(runtimeRaw, now = Date.now()) {
  const runtime = clone(runtimeRaw);
  if (runtime.runState === ScenarioWorkRunState.PAUSED) runtime.runState = ScenarioWorkRunState.RUNNING;
  runtime.updatedAt = now;
  return runtime;
}

export function stopScenarioWork(runtimeRaw, now = Date.now()) {
  const runtime = clone(runtimeRaw);
  runtime.runState = ScenarioWorkRunState.STOPPED;
  runtime.updatedAt = now;
  return runtime;
}

export function scenarioWorkParticipants(runtime) {
  if (!runtime) return [];
  if (runtime.mode === ScenarioWorkMode.AUDITOR_PIPELINE) return pipelineParticipants(runtime);
  if (runtime.mode === ScenarioWorkMode.CHAT_CYCLE) return runtime.chat ? [runtime.chat] : [];
  if (runtime.mode === ScenarioWorkMode.PAIRS) return Object.values(runtime.pairs || {}).flatMap(pair => [pair.auditor, pair.worker]);
  return runtime.group ? [runtime.group.auditor, ...Object.values(runtime.group.workers || {})] : [];
}
