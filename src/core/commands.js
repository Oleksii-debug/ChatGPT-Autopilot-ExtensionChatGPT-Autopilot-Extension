import { normalizeSessionPromptCadence } from './session-prompt-cadence.js';
import { normalizeSessionDrivePromptSources } from './session-drive-prompt-source.js';
import { CoreCommand } from '../shared/protocol.js';
import { DEFAULT_RATE_LIMIT_COOLDOWN_MS, MIN_RATE_LIMIT_COOLDOWN_MS, MAX_RATE_LIMIT_COOLDOWN_MS, MAX_PHYSICAL_TASKS, MAX_LOGICAL_TASKS, OperationPhase, PromptMode, RunMode, RunState, TabStrategy, createSession, createTask, isExclusiveConversationUrl, normalizeChatUrl } from './schema.js';
import { configuredTaskCount as logicalTaskCount, isCompactLogicalSession, onePassCompletedCount } from './scheduler.js';
import { pauseSession, resumeSession, startSession, stopSession } from './state-machine.js';
import { appendLog } from './logger.js';
import { EXECUTION_UNAVAILABLE_MESSAGE, healUnattendedManualHolds } from './recovery.js';
import { applyPortableProfile, exportPortableProfile, previewPortableProfile } from './portable-profile.js';
import { appendDiagnostic, createDiagnosticReport } from './diagnostics.js';
import { releaseSendLease, DEFAULT_PROFILE_SEND_GAP_MS } from './arbiter.js';
import { DEFAULT_LOCAL_AI_SETTINGS, normalizeLocalAiSettings } from './local-ai-provider.js';
import { DEFAULT_AI_ROUTER_SETTINGS, DEFAULT_AI_ROUTER_RUNTIME, normalizeAiRouterSettings, normalizeAiRouterRuntime, validateAiRouterReadiness } from './ai-orchestrator.js';
import { DEFAULT_AI_MANAGER_SETTINGS, DEFAULT_AI_MANAGER_RUNTIME, normalizeAiManagerSettings, normalizeAiManagerRuntime } from './ai-manager.js';

const promptModeFromUi = value => String(value).toLowerCase() === 'unique' ? PromptMode.UNIQUE : PromptMode.SHARED;
const runModeFromUi = value => String(value).toLowerCase() === 'one-pass' ? RunMode.ONE_PASS : RunMode.CONTINUOUS;
const tabStrategyFromUi = value => ({ worker: TabStrategy.ONE_WORKER_TAB_PER_SESSION, 'open-close': TabStrategy.OPEN_CLOSE_PER_TASK }[String(value).toLowerCase()] || TabStrategy.KEEP_TASK_TABS_OPEN);
const ACTIVE_STATES = new Set([RunState.RUNNING, RunState.RECOVERING]);
const STARTABLE_STATES = new Set([RunState.STOPPED, RunState.PAUSED, RunState.ERROR]);
const DELETABLE_STATES = new Set([RunState.STOPPED, RunState.PAUSED, RunState.ERROR]);
const TERMINAL_OPERATION_PHASES = new Set([OperationPhase.NONE, OperationPhase.SENT_VERIFIED, OperationPhase.FAILED_SAFE]);
const URL_OWNERSHIP_ERROR = 'Another active or unresolved session already owns one of these ChatGPT conversations';

const AI_ROUTER_OVERRIDE_MODES = new Set(['primary', 'strong', 'hybrid-auto', 'hybrid-rules']);
const AI_ROUTER_OVERRIDE_PROVIDERS = new Set(['ollama', 'openai', 'openai-compatible']);
function mergeAiRouterSettingsOverride(rawBase, rawOverride = {}) {
  const base = normalizeAiRouterSettings(rawBase || DEFAULT_AI_ROUTER_SETTINGS);
  const override = rawOverride && typeof rawOverride === 'object' ? rawOverride : {};
  const next = structuredClone(base);
  if (AI_ROUTER_OVERRIDE_MODES.has(override.mode)) next.mode = override.mode;
  for (const slotName of ['primary', 'strong']) {
    const slot = override[slotName];
    if (!slot || typeof slot !== 'object') continue;
    if (AI_ROUTER_OVERRIDE_PROVIDERS.has(slot.provider)) next[slotName].provider = slot.provider;
    if (typeof slot.model === 'string' && slot.model.trim()) next[slotName].model = slot.model.trim();
  }
  return normalizeAiRouterSettings(next);
}

function hasUnresolvedOperation(session) {
  return Boolean(session.operation && !TERMINAL_OPERATION_PHASES.has(session.operation.phase));
}

function onePassCompleted(session) {
  if (session.runMode !== RunMode.ONE_PASS) return false;
  const enabled = (session.taskOrder || []).filter(id => session.tasksById?.[id]?.enabled);
  if (!enabled.length) return false;
  if (isCompactLogicalSession(session)) return onePassCompletedCount(session) >= logicalTaskCount(session);
  const done = new Set(session.onePassCompletedTaskIds || []);
  return enabled.every(id => done.has(id));
}

function minimumSendIntervalMsFromUi(config) {
  const hasValueUnit = config.minimumSendIntervalValue !== undefined || config.minimumSendIntervalUnit !== undefined;
  if (hasValueUnit) {
    const unit = String(config.minimumSendIntervalUnit || 'minutes').toLowerCase() === 'seconds' ? 'seconds' : 'minutes';
    const value = Number(config.minimumSendIntervalValue);
    const min = 1;
    const max = unit === 'seconds' ? 86400 : 1440;
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Minimum send interval must be ${min}-${max} ${unit}`);
    return Math.round(value * (unit === 'seconds' ? 1000 : 60000));
  }
  if (config.minimumSendIntervalSeconds !== undefined) {
    const seconds = Number(config.minimumSendIntervalSeconds);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) throw new Error('Minimum send interval must be 1-86400 seconds');
    return Math.round(seconds * 1000);
  }
  const minutes = Number(config.minimumSendIntervalMinutes ?? 2);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) throw new Error('Minimum send interval must be greater than 0 and at most 1440 minutes');
  return Math.round(minutes * 60000);
}

function requestedLogicalTaskCount(config) {
  const raw = config.configuredTaskCount ?? config.taskCount ?? config.tasks?.length ?? 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LOGICAL_TASKS) throw new Error(`Task / cycle count must be 1-${MAX_LOGICAL_TASKS}`);
  return value;
}

function acknowledgeSafePreSubmitManualReview(session) {
  const currentTaskId = session.taskOrder?.[session.currentTaskIndex];
  const task = currentTaskId ? session.tasksById?.[currentTaskId] : null;
  const manualOperation = session.operation?.phase === OperationPhase.MANUAL_REVIEW;
  const taskHeld = Boolean(task?.manualReviewReason || task?.status === 'MANUAL_REVIEW');
  if (!manualOperation && !taskHeld) return false;

  // Once SUBMITTING ever began, clearing the operation could authorize a duplicate.
  // Such cases remain held for the uncertainty/recovery path.
  if (manualOperation && Number(session.operation?.submitStartedAt || 0) > 0) {
    throw new Error('Resolve the uncertain send operation before retrying');
  }

  if (task) {
    task.manualReviewReason = '';
    task.status = 'IDLE';
    task.retryAfterAt = 0;
  }
  if (manualOperation) session.operation = null;
  return true;
}

function requireSession(state, sessionId) {
  const session = state.sessionsById[sessionId];
  if (!session) throw new Error('Session not found');
  return session;
}

function taskFromUi(raw) {
  const id = raw?.id || crypto.randomUUID();
  if (!raw?.url) return { id, enabled: raw?.enabled !== false, label: raw?.label || '', url: '', normalizedUrl: '', promptOverride: raw?.promptOverride || '', status:'IDLE', lastCheckedAt:0, lastVerifiedSendAt:0, lastVerifiedFingerprint:'', retryAfterAt:0, manualReviewReason:'', lastConversationUrl:'', lastAssistantReport:'', lastAssistantReportAt:0, lastAssistantBaselineCount:0, lastAssistantBaselineKnown:false };
  return createTask({ id, enabled: raw.enabled !== false, label: raw.label || '', url: raw.url, promptOverride: raw.promptOverride || '' });
}

export function sessionFromUi(config, now = Date.now()) {
  const normalizedPromptMode = promptModeFromUi(config.promptMode);
  const normalizedUrlMode = config.urlMode === 'unique' ? 'unique' : 'shared';
  const logicalCount = requestedLogicalTaskCount(config);
  const rawTasks = config.tasks?.length ? config.tasks : [{ id: crypto.randomUUID(), url: '' }];
  const explicitLogicalCount = config.configuredTaskCount !== undefined || config.taskCount !== undefined;
  // Backward compatibility: legacy configs that contain repeated shared/shared
  // task objects keep their physical representation until the user saves them
  // through the new 0.9.14 UI. New configs carry configuredTaskCount and use a
  // single physical task definition for any number of identical cycles.
  const compactShared = normalizedPromptMode === PromptMode.SHARED && normalizedUrlMode === 'shared' && explicitLogicalCount;
  if (!compactShared && logicalCount > MAX_PHYSICAL_TASKS) throw new Error(`Distinct task configurations are limited to ${MAX_PHYSICAL_TASKS}; up to ${MAX_LOGICAL_TASKS} is available for one shared URL + one shared prompt`);
  const physicalLimit = compactShared ? 1 : Math.min(MAX_PHYSICAL_TASKS, logicalCount);
  const tasks = rawTasks.slice(0, physicalLimit).map(taskFromUi);
  while (tasks.length < physicalLimit) tasks.push(taskFromUi({ id: crypto.randomUUID(), url: rawTasks[0]?.url || '', promptOverride: '' }));
  const session = createSession({
    id: config.id || crypto.randomUUID(), name: config.name || 'New session', tasks,
    promptMode: normalizedPromptMode, sharedPrompt: config.sharedPrompt || '', runMode: runModeFromUi(config.runMode), configuredTaskCount: logicalCount,
    minimumSendIntervalMs: minimumSendIntervalMsFromUi(config),
    preSendDelayMs: Math.min(30000, Math.max(1000, Number(config.preSendDelaySeconds || 20) * 1000)),
    busyCheckDelayMs: Math.max(500, Number(config.busyCheckDelaySeconds || 2) * 1000),
    retryBackoffMs: Math.max(5000, Number(config.retryBackoffSeconds || 30) * 1000),
    tabStrategy: tabStrategyFromUi(config.tabStrategy), now
  });
  session.version = Math.max(1, Number(config.version) || 1);
  session.promptCadence = normalizeSessionPromptCadence(config.promptCadence);
  session.drivePromptSources = normalizeSessionDrivePromptSources(config.drivePromptSources);
  session.defaultUniquePrompt = config.defaultUniquePrompt || '';
  session.retryPolicy = config.retryPolicy === 'manual' ? 'manual' : 'safe';
  session.busyChatBehavior = 'skip-next';
  session.urlMode = normalizedUrlMode;
  session.pausedByMaster = false;
  return session;
}

export function validateRunnableSession(session, { allowUnresolved = false } = {}) {
  if (!allowUnresolved && hasUnresolvedOperation(session)) throw new Error('Resolve the uncertain send operation before starting');
  if (!session.name.trim()) throw new Error('Session name is required');
  if (session.taskOrder.length < 1 || session.taskOrder.length > MAX_PHYSICAL_TASKS) throw new Error(`Session requires 1-${MAX_PHYSICAL_TASKS} physical tasks`);
  const logicalCount = logicalTaskCount(session);
  if (logicalCount < 1 || logicalCount > MAX_LOGICAL_TASKS) throw new Error(`Session requires 1-${MAX_LOGICAL_TASKS} tasks / cycles`);
  if (logicalCount > session.taskOrder.length && !isCompactLogicalSession(session)) throw new Error('Invalid compact task configuration');
  let enabledCount = 0;
  for (const id of session.taskOrder) {
    const task = session.tasksById[id];
    if (!task.enabled) continue;
    enabledCount += 1;
    if (!task.url) throw new Error(`Task ${id} URL is required`);
    task.normalizedUrl = normalizeChatUrl(task.url);
    const prompt = session.promptMode === PromptMode.UNIQUE ? task.promptOverride : session.sharedPrompt;
    if (!prompt?.trim()) throw new Error(`Prompt is required for task ${id}`);
  }
  if (enabledCount === 0) throw new Error('Enable at least one task before starting');
  return session;
}

function hasReservedUrlCollision(state, session) {
  const targetUrls = new Set(session.taskOrder
    .map(id => session.tasksById[id])
    .filter(task => task.enabled)
    .map(task => task.normalizedUrl)
    .filter(isExclusiveConversationUrl));
  if (hasUnresolvedOperation(session) && isExclusiveConversationUrl(session.operation?.targetUrl)) targetUrls.add(session.operation.targetUrl);
  for (const other of Object.values(state.sessionsById)) {
    if (other.id === session.id) continue;
    if (ACTIVE_STATES.has(other.runState)) {
      const collision = other.taskOrder
        .map(id => other.tasksById[id])
        .filter(task => task.enabled)
        .some(task => isExclusiveConversationUrl(task.normalizedUrl) && targetUrls.has(task.normalizedUrl));
      if (collision) return true;
    }
    if (hasUnresolvedOperation(other) && isExclusiveConversationUrl(other.operation?.targetUrl) && targetUrls.has(other.operation?.targetUrl || '')) {
      return true;
    }
  }
  return false;
}

function assertNoActiveUrlCollision(state, session) {
  if (hasReservedUrlCollision(state, session)) throw new Error(URL_OWNERSHIP_ERROR);
}

function clearMasterPauseForExplicitSessionAction(state, now) {
  if (!state.profile.masterPaused) return false;
  state.profile.masterPaused = false;
  for (const candidate of Object.values(state.sessionsById)) {
    if (!candidate.pausedByMaster) continue;
    candidate.pausedByMaster = false;
    candidate.lastActionAt = now;
    candidate.updatedAt = now;
    appendLog(state, candidate.id, 'Master pause cleared by explicit session action; session remains paused unless explicitly started or resumed', { at: now });
  }
  return true;
}

function workerHintKeyForSession(sessionId) {
  return `__session_worker__:${sessionId}`;
}

function tabHintKeysRemovedByUpdatedSession(state, oldSession, replacement) {
  const workerHintKey = workerHintKeyForSession(oldSession.id);
  const workerMode = replacement.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION;
  const removed = [];
  for (const [key, hint] of Object.entries(state.tabHintsByTaskId || {})) {
    if (hint?.sessionId !== oldSession.id) continue;
    if (key === workerHintKey) {
      if (!workerMode) removed.push(key);
      continue;
    }
    if (workerMode) {
      removed.push(key);
      continue;
    }
    const nextTask = replacement.tasksById[key];
    if (!nextTask || hint.normalizedUrl !== nextTask.normalizedUrl) removed.push(key);
  }
  return removed;
}

function cleanTabHintsForUpdatedSession(state, oldSession, replacement) {
  for (const key of tabHintKeysRemovedByUpdatedSession(state, oldSession, replacement)) {
    delete state.tabHintsByTaskId[key];
  }
}

function hintIsExtensionOwnedForPhysicalClose(session, hint) {
  if (!hint || hint.tabId == null) return false;
  // OPEN_CLOSE never adopts an existing tab; legacy hints from older releases
  // may not have the explicit provenance bit, but are still extension-created.
  if (session?.tabStrategy === TabStrategy.OPEN_CLOSE_PER_TASK) return hint.ownedByExtension !== false;
  // Worker mode can adopt an existing concrete conversation, so only close a
  // worker tab when provenance explicitly says the extension created it.
  if (session?.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION) return hint.ownedByExtension === true;
  // KEEP_TASK_TABS_OPEN intentionally keeps tabs and may point at user tabs.
  return false;
}

function unresolvedEvidenceHintKey(session) {
  if (!hasUnresolvedOperation(session) || Number(session.operation?.submitStartedAt || 0) <= 0) return null;
  return session.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION
    ? workerHintKeyForSession(session.id)
    : session.operation?.taskId || null;
}

async function closeOwnedHintBeforeForget(chromeApi, session, hint) {
  if (!chromeApi?.tabs || !hintIsExtensionOwnedForPhysicalClose(session, hint)) return;
  try {
    await chromeApi.tabs.remove(hint.tabId);
    return;
  } catch (error) {
    try {
      await chromeApi.tabs.get(hint.tabId);
    } catch {
      // Chrome reports the tab missing: physical retirement is already true.
      return;
    }
    throw new Error(`Could not close extension-owned ChatGPT tab ${hint.tabId} before forgetting its ownership`);
  }
}

function sessionProgress(session) {
  const enabledIds = session.taskOrder.filter(id => session.tasksById[id]?.enabled);
  const compact = isCompactLogicalSession(session);
  const enabledTaskCount = compact ? logicalTaskCount(session) : enabledIds.length;
  const completedIds = session.runMode === RunMode.ONE_PASS && !compact
    ? enabledIds.filter(id => session.onePassCompletedTaskIds?.includes(id))
    : [];
  const completedTaskCount = session.runMode === RunMode.ONE_PASS
    ? (compact ? Math.min(enabledTaskCount, onePassCompletedCount(session)) : completedIds.length)
    : 0;
  const isCompleted = session.runMode === RunMode.ONE_PASS
    && enabledTaskCount > 0
    && completedTaskCount >= enabledTaskCount;
  return {
    enabledTaskCount,
    completedTaskCount,
    remainingTaskCount: Math.max(0, enabledTaskCount - completedTaskCount),
    successfulSendCount: Math.max(completedTaskCount, Number(session.successfulSendCount || 0)),
    isCompleted,
    displayRunState: isCompleted ? 'COMPLETED' : session.runState,
  };
}

export function sessionToUi(session, state) {
  const tasks = session.taskOrder.map(id => session.tasksById[id]);
  const currentTask = tasks[session.currentTaskIndex] || null;
  const log = state.logs[session.id] || [];
  const lastLog = log.at(-1);
  const progress = sessionProgress(session);
  return {
    ...structuredClone(session), version: session.version || 0,
    promptMode: session.promptMode === PromptMode.UNIQUE ? 'unique' : 'shared',
    runMode: session.runMode === RunMode.ONE_PASS ? 'one-pass' : 'continuous',
    tabStrategy: session.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION ? 'worker' : session.tabStrategy === TabStrategy.OPEN_CLOSE_PER_TASK ? 'open-close' : 'keep-open',
    tasks, configuredTaskCount: logicalTaskCount(session),
    minimumSendIntervalMinutes: session.minimumSendIntervalMs / 60000,
    minimumSendIntervalSeconds: session.minimumSendIntervalMs / 1000,
    minimumSendIntervalUnit: session.minimumSendIntervalMs >= 60000 && session.minimumSendIntervalMs % 60000 === 0 ? 'minutes' : 'seconds',
    minimumSendIntervalValue: session.minimumSendIntervalMs >= 60000 && session.minimumSendIntervalMs % 60000 === 0 ? session.minimumSendIntervalMs / 60000 : session.minimumSendIntervalMs / 1000,
    preSendDelaySeconds: session.preSendDelayMs / 1000,
    busyCheckDelaySeconds: session.busyCheckDelayMs / 1000, retryBackoffSeconds: session.retryBackoffMs / 1000,
    retryBackoffUnit: session.retryBackoffMs >= 60000 && session.retryBackoffMs % 60000 === 0 ? 'minutes' : 'seconds',
    actionAvailability: { start: STARTABLE_STATES.has(session.runState), pause: session.runState === RunState.RUNNING || session.runState === RunState.RECOVERING, resume: session.runState === RunState.PAUSED || STARTABLE_STATES.has(session.runState), stop: session.runState !== RunState.STOPPED },
    status: {
      displayRunState: progress.displayRunState,
      isCompleted: progress.isCompleted,
      successfulSendCount: progress.successfulSendCount,
      completedTaskCount: progress.completedTaskCount,
      remainingTaskCount: progress.remainingTaskCount,
      completedAt: session.completedAt || 0,
      currentTaskLabel: progress.isCompleted ? '' : (currentTask?.label || ''),
      currentTaskUrl: progress.isCompleted ? '' : (currentTask?.url || ''),
      currentTaskStatus: progress.isCompleted ? 'COMPLETED' : (currentTask?.status || 'IDLE'),
      currentTaskRetryAt: progress.isCompleted ? 0 : (currentTask?.retryAfterAt || 0),
      currentTaskManualReviewReason: currentTask?.manualReviewReason || '',
      operationPhase: session.operation?.phase || OperationPhase.NONE,
      uncertainOperationId: session.retryPolicy === 'manual' && session.operation &&
        [OperationPhase.AMBIGUOUS, OperationPhase.MANUAL_REVIEW].includes(session.operation.phase)
        && session.operation.submitStartedAt > 0 ? session.operation.operationId : null,
      lastAction: lastLog?.message || '',
      lastActionAt: lastLog?.at || session.lastActionAt || 0,
      lastSuccessfulSendAt: session.lastSuccessfulSendAt,
      nextAllowedSendAt: progress.isCompleted ? 0 : session.nextAllowedSendAt,
      enabledTaskCount: progress.enabledTaskCount,
      lastError: session.lastError
    },
    log
  };
}

export class CoreCommandDispatcher {
  constructor(repository, now = () => Date.now(), { executionAvailable = true, localAiClient = null, aiGatewayClient = null, aiOrchestrator = null, chromeApi = null } = {}) {
    this.repo = repository;
    this.now = now;
    this.executionAvailable = executionAvailable;
    this.localAiClient = localAiClient;
    this.aiGatewayClient = aiGatewayClient;
    this.aiOrchestrator = aiOrchestrator;
    this.chromeApi = chromeApi;
  }

  async retireStoppedSessionTabs(sessionId) {
    if (!this.chromeApi?.tabs) return;
    const snapshot = await this.repo.load();
    const session = snapshot.sessionsById?.[sessionId];
    if (!session || session.runState !== RunState.STOPPED) return;
    const preserveKey = unresolvedEvidenceHintKey(session);

    for (const [hintKey, hint] of Object.entries(snapshot.tabHintsByTaskId || {})) {
      if (hint?.sessionId !== sessionId || hintKey === preserveKey) continue;
      if (!hintIsExtensionOwnedForPhysicalClose(session, hint)) continue;
      const tabId = hint.tabId;
      let retired = false;
      try {
        await this.chromeApi.tabs.remove(tabId);
        retired = true;
      } catch {
        try {
          await this.chromeApi.tabs.get(tabId);
        } catch {
          retired = true;
        }
      }

      await this.repo.update(draft => {
        const live = draft.sessionsById?.[sessionId];
        const liveHint = draft.tabHintsByTaskId?.[hintKey];
        if (!live || live.runState !== RunState.STOPPED || liveHint?.tabId !== tabId || liveHint?.sessionId !== sessionId) return draft;
        if (retired) {
          delete draft.tabHintsByTaskId[hintKey];
          appendDiagnostic(draft, {
            event: 'ВЛАСНУ_ВКЛАДКУ_ЗАКРИТО_ПІСЛЯ_STOP',
            sessionId,
            taskId: hintKey === workerHintKeyForSession(sessionId) ? live.operation?.taskId : hintKey,
            tabId,
            message: 'Власну вкладку фізично закрито після явного Stop; ownership прибрано лише після підтвердження.',
          }, { at: this.now() });
        } else {
          liveHint.ownedByExtension = true;
          liveHint.retirePending = true;
          liveHint.retireAttempts = Number(liveHint.retireAttempts || 0) + 1;
          liveHint.retireRetryAt = this.now() + 1000;
          appendDiagnostic(draft, {
            event: 'ВЛАСНА_ВКЛАДКА_ОЧІКУЄ_ЗАКРИТТЯ_ПІСЛЯ_STOP',
            sessionId,
            taskId: hintKey === workerHintKeyForSession(sessionId) ? live.operation?.taskId : hintKey,
            tabId,
            message: 'Chrome тимчасово не закрив власну вкладку після Stop; ownership збережено до наступної підтвердженої спроби.',
          }, { at: this.now() });
        }
        return draft;
      });
    }
  }
  async execute(command, payload = {}) {
    if (command === CoreCommand.RESOLVE_UNCERTAIN) {
      const state = await this.repo.update(draft => {
        const session = requireSession(draft, payload.sessionId);
        const operation = session.operation;
        if (!operation || operation.operationId !== payload.operationId
          || ![OperationPhase.AMBIGUOUS, OperationPhase.MANUAL_REVIEW].includes(operation.phase)
          || !(operation.submitStartedAt > 0)) throw new Error('Стан операції змінився. Оновіть панель.');
        if (!['check', 'retry', 'skip'].includes(payload.resolution)) throw new Error('Невідома дія відновлення.');
        if (payload.resolution !== 'check' && payload.confirmed !== true) {
          throw new Error('Спочатку позначте підтвердження під станом сеансу.');
        }
        const task = session.tasksById[operation.taskId];
        const now = this.now();
        task.manualReviewReason = '';
        task.retryAfterAt = 0;
        if (payload.resolution === 'check') {
          if (!this.executionAvailable || draft.profile.masterPaused) throw new Error('Спочатку відновіть роботу розширення.');
          operation.phase = OperationPhase.AMBIGUOUS;
          operation.verificationDeadline = now + 120000;
          task.status = 'SUBMISSION_UNCERTAIN';
          session.runState = RunState.RECOVERING;
          session.lastError = 'Повторна перевірка без натискання Надіслати.';
        } else {
          releaseSendLease(draft, { sessionId: session.id, operationId: operation.operationId, now, profileGapMs: DEFAULT_PROFILE_SEND_GAP_MS });
          // Do not report an uncertain send as success or discard the user's draft.
          if (payload.resolution === 'skip') {
            task.enabled = false;
            task.status = 'IDLE';
            session.currentTaskIndex = (session.taskOrder.indexOf(task.id) + 1) % session.taskOrder.length;
          } else {
            task.status = 'IDLE';
            session.currentTaskIndex = session.taskOrder.indexOf(task.id);
          }
          session.operation = null;
          session.runState = RunState.PAUSED;
          session.lastError = '';
          session.version = (session.version || 0) + 1;
        }
        session.updatedAt = now;
        session.lastActionAt = now;
        appendLog(draft, session.id, {
          check: 'Запущено повторну перевірку без надсилання',
          retry: 'Користувач дозволив повтор невизначеного завдання. Натисніть Продовжити',
          skip: 'Невизначене завдання вимкнено без позначки успіху. Натисніть Продовжити для решти',
        }[payload.resolution], { at: now });
        return draft;
      });
      return { session: sessionToUi(state.sessionsById[payload.sessionId], state) };
    }
    if (command === CoreCommand.LIST_SESSIONS) {
      const state = await this.repo.load();
      return { sessions: state.sessionOrder.map(id => { const s=state.sessionsById[id]; const progress=sessionProgress(s); const managedKind = s.orchestrationCoordinator?.managed ? 'orchestration-coordinator' : s.orchestrationWorker?.managed ? 'orchestration-worker' : s.remoteDispatch?.managed ? 'remote-dispatch' : ''; return { id, name:s.name, runState:s.runState, displayRunState:progress.displayRunState, enabledTaskCount:progress.enabledTaskCount, completedTaskCount:progress.completedTaskCount, remainingTaskCount:progress.remainingTaskCount, successfulSendCount:progress.successfulSendCount, isCompleted:progress.isCompleted, managedKind }; }) };
    }
    if (command === CoreCommand.GET_PROFILE_SETTINGS) {
      const state = await this.repo.load();
      const ms = Number(state.profile?.rateLimitCooldownMs || DEFAULT_RATE_LIMIT_COOLDOWN_MS);
      return { rateLimitCooldownMinutes: Math.round(ms / 60000) };
    }
    if (command === CoreCommand.UPDATE_PROFILE_SETTINGS) {
      const minutes = Number(payload.rateLimitCooldownMinutes);
      const ms = minutes * 60000;
      if (!Number.isInteger(minutes) || ms < MIN_RATE_LIMIT_COOLDOWN_MS || ms > MAX_RATE_LIMIT_COOLDOWN_MS) {
        throw new Error('Rate-limit pause must be a whole number from 1 to 120 minutes');
      }
      await this.repo.update(draft => {
        draft.profile.rateLimitCooldownMs = ms;
        return draft;
      });
      return { rateLimitCooldownMinutes: minutes };
    }
    if (command === CoreCommand.GET_LOCAL_AI_SETTINGS) {
      const state = await this.repo.load();
      return { settings: normalizeLocalAiSettings(state.profile?.localAi || DEFAULT_LOCAL_AI_SETTINGS) };
    }
    if (command === CoreCommand.UPDATE_LOCAL_AI_SETTINGS) {
      const settings = normalizeLocalAiSettings(payload.settings || {});
      await this.repo.update(draft => {
        draft.profile.localAi = structuredClone(settings);
        return draft;
      });
      return { settings };
    }
    if (command === CoreCommand.TEST_LOCAL_AI_CONNECTION) {
      if (!this.localAiClient) throw new Error('Local AI runtime is unavailable');
      const state = await this.repo.load();
      const settings = normalizeLocalAiSettings(payload.settings || state.profile?.localAi || DEFAULT_LOCAL_AI_SETTINGS);
      return { result: await this.localAiClient.listModels(settings) };
    }
    if (command === CoreCommand.RUN_LOCAL_AI_PROMPT) {
      if (!this.localAiClient) throw new Error('Local AI runtime is unavailable');
      const state = await this.repo.load();
      const settings = normalizeLocalAiSettings(payload.settings || state.profile?.localAi || DEFAULT_LOCAL_AI_SETTINGS);
      return { result: await this.localAiClient.complete(settings, payload.prompt, { systemPrompt: payload.systemPrompt || '' }) };
    }
    if (command === CoreCommand.GET_AI_ROUTER_SETTINGS) {
      const state = await this.repo.load();
      return {
        settings: normalizeAiRouterSettings(state.profile?.aiRouter || DEFAULT_AI_ROUTER_SETTINGS),
        runtime: normalizeAiRouterRuntime(state.profile?.aiRouterRuntime || DEFAULT_AI_ROUTER_RUNTIME),
      };
    }
    if (command === CoreCommand.UPDATE_AI_ROUTER_SETTINGS) {
      const settings = validateAiRouterReadiness(payload.settings || {});
      await this.repo.update(draft => {
        draft.profile.aiRouter = structuredClone(settings);
        draft.profile.aiRouterRuntime = normalizeAiRouterRuntime(draft.profile.aiRouterRuntime || DEFAULT_AI_ROUTER_RUNTIME);
        return draft;
      });
      return { settings };
    }
    if (command === CoreCommand.TEST_AI_GATEWAY) {
      if (!this.aiGatewayClient) throw new Error('AI Gateway runtime is unavailable');
      const state = await this.repo.load();
      const settings = normalizeAiRouterSettings(payload.settings || state.profile?.aiRouter || DEFAULT_AI_ROUTER_SETTINGS);
      const health = await this.aiGatewayClient.health(settings);
      let status = null;
      try { status = await this.aiGatewayClient.status(settings); } catch (_) {}
      return { result: { ...health, providerStatus: status?.providers || [] } };
    }
    if (command === CoreCommand.LIST_AI_ROUTER_MODELS) {
      if (!this.aiGatewayClient) throw new Error('AI Gateway runtime is unavailable');
      const state = await this.repo.load();
      const settings = normalizeAiRouterSettings(payload.settings || state.profile?.aiRouter || DEFAULT_AI_ROUTER_SETTINGS);
      const provider = payload.provider;
      return { result: await this.aiGatewayClient.listModels({ gatewayUrl: settings.gatewayUrl, timeoutSeconds: settings.timeoutSeconds, provider }) };
    }
    if (command === CoreCommand.RUN_AI_ROUTED_PROMPT) {
      if (!this.aiOrchestrator) throw new Error('AI coordinator runtime is unavailable');
      const state = await this.repo.load();
      const baseSettings = normalizeAiRouterSettings(payload.settings || state.profile?.aiRouter || DEFAULT_AI_ROUTER_SETTINGS);
      const settings = payload.routerOverride
        ? mergeAiRouterSettingsOverride(baseSettings, payload.routerOverride)
        : baseSettings;
      const isolatedRuntime = payload.isolatedRuntime === true;
      const runtime = isolatedRuntime
        ? normalizeAiRouterRuntime(payload.routerRuntime || DEFAULT_AI_ROUTER_RUNTIME)
        : normalizeAiRouterRuntime(state.profile?.aiRouterRuntime || DEFAULT_AI_ROUTER_RUNTIME);
      const result = await this.aiOrchestrator.run(settings, runtime, payload.prompt, {
        systemPrompt: payload.systemPrompt || '',
        forceStrong: payload.forceStrong === true,
        maxOutputTokens: Number(payload.maxOutputTokens || 0),
        maxModelCallsForRequest: Number(payload.maxModelCallsForRequest || 0),
        imageDataUrl: payload.imageDataUrl || '',
      });
      if (isolatedRuntime) {
        result.runtime = normalizeAiRouterRuntime(result.runtime || runtime);
        return { result };
      }
      await this.repo.update(draft => {
        draft.profile.aiRouter = structuredClone(settings);
        const current = normalizeAiRouterRuntime(draft.profile.aiRouterRuntime || DEFAULT_AI_ROUTER_RUNTIME);
        current.requestCount += 1;
        current.startedAt = current.startedAt || result.runtime.startedAt || this.now();
        if (result.primary) current.primaryCount += 1;
        if (result.strong) {
          current.strongCount += 1;
          current.lastStrongAt = result.runtime.lastStrongAt;
          current.lastStrongResult = result.runtime.lastStrongResult;
          const mergedStrongHistory = [...(current.strongHistoryAt || []), Number(result.runtime.lastStrongAt || 0)]
            .filter(value => Number.isFinite(value) && value > 0)
            .filter((value, index, array) => array.indexOf(value) === index)
            .sort((a, b) => a - b)
            .slice(-1000);
          current.strongHistoryAt = mergedStrongHistory;
        }
        current.lastRoute = result.route || current.lastRoute;
        draft.profile.aiRouterRuntime = current;
        result.runtime = structuredClone(current);
        return draft;
      });
      return { result };
    }
    if (command === CoreCommand.RESET_AI_ROUTER_RUNTIME) {
      await this.repo.update(draft => {
        draft.profile.aiRouterRuntime = structuredClone(DEFAULT_AI_ROUTER_RUNTIME);
        return draft;
      });
      return { runtime: structuredClone(DEFAULT_AI_ROUTER_RUNTIME) };
    }
    if (command === CoreCommand.GET_AI_MANAGER_SETTINGS) {
      const state = await this.repo.load();
      return {
        settings: normalizeAiManagerSettings(state.profile?.aiManager || DEFAULT_AI_MANAGER_SETTINGS),
        runtime: normalizeAiManagerRuntime(state.profile?.aiManagerRuntime || DEFAULT_AI_MANAGER_RUNTIME),
      };
    }
    if (command === CoreCommand.UPDATE_AI_MANAGER_SETTINGS) {
      const settings = normalizeAiManagerSettings(payload.settings || {});
      await this.repo.update(draft => {
        draft.profile.aiManager = structuredClone(settings);
        draft.profile.aiManagerRuntime = normalizeAiManagerRuntime(draft.profile.aiManagerRuntime || DEFAULT_AI_MANAGER_RUNTIME);
        return draft;
      });
      return { settings };
    }
    if (command === CoreCommand.RESET_AI_MANAGER_RUNTIME) {
      await this.repo.update(draft => {
        draft.profile.aiManagerRuntime = structuredClone(DEFAULT_AI_MANAGER_RUNTIME);
        return draft;
      });
      return { runtime: structuredClone(DEFAULT_AI_MANAGER_RUNTIME) };
    }
    if (command === CoreCommand.GET_SNAPSHOT) { const state=await this.repo.load(); return { snapshot: structuredClone(state) }; }
    if (command === CoreCommand.GET_SESSION) { const state=await this.repo.load(); const s=state.sessionsById[payload.sessionId]; if(!s) throw new Error('Session not found'); return { session: sessionToUi(s,state) }; }
    if (command === CoreCommand.GET_DIAGNOSTIC_REPORT) {
      const state = await this.repo.load();
      return {
        report: createDiagnosticReport(state, {
          now: this.now(),
          extensionVersion: payload.extensionVersion,
        }),
      };
    }
    if (command === CoreCommand.RECORD_DIAGNOSTIC_SNAPSHOT) {
      if (!payload.sessionId) return { recorded: false };
      let recorded = false;
      await this.repo.update(draft => {
        const session = draft.sessionsById[payload.sessionId];
        if (!session || !ACTIVE_STATES.has(session.runState)) return draft;
        const taskId = session.operation?.taskId
          || session.taskOrder[session.currentTaskIndex]
          || null;
        appendDiagnostic(draft, {
          event: 'ЗРІЗ_СТАНУ_ПАНЕЛІ',
          sessionId: session.id,
          taskId,
          phase: session.operation?.phase,
          runState: session.runState,
          code: session.lastError
            ? 'Є_ПОВІДОМЛЕННЯ_ПРО_ПОМИЛКУ'
            : 'СТАН_БЕЗ_НОВОЇ_ПОМИЛКИ',
          message: session.lastError
            || 'Сеанс активний; панель отримала контрольний знімок стану.',
        }, { at: this.now() });
        recorded = true;
        return draft;
      });
      return { recorded };
    }
    if (command === CoreCommand.PREVIEW_PORTABLE_PROFILE) {
      return { preview: previewPortableProfile(payload.profile, this.now()) };
    }
    if (command === CoreCommand.EXPORT_PORTABLE_PROFILE) {
      const state = await this.repo.load();
      return { profile: exportPortableProfile(state, { sessionIds: payload.sessionIds, profileName: payload.profileName }) };
    }
    if (command === CoreCommand.IMPORT_PORTABLE_PROFILE) {
      let summary = null;
      const state = await this.repo.update(async draft => {
        const options = {
          now: this.now(),
          confirmAutoStart: payload.confirmAutoStart === true,
          executionAvailable: this.executionAvailable,
        };
        // Validate the complete import against a disposable clone before doing
        // any physical tab side effects. This avoids closing a tab for an import
        // that would later fail schema/ownership/auto-start validation.
        const probe = structuredClone(draft);
        const validated = applyPortableProfile(probe, payload.profile, options);
        for (const sessionId of validated.importedSessionIds) {
          const existing = draft.sessionsById?.[sessionId];
          if (!existing) continue;
          for (const hint of Object.values(draft.tabHintsByTaskId || {})) {
            if (hint?.sessionId !== sessionId) continue;
            await closeOwnedHintBeforeForget(this.chromeApi, existing, hint);
          }
        }
        summary = applyPortableProfile(draft, payload.profile, options);
        return draft;
      });
      return {
        summary,
        sessions: summary.importedSessionIds.map(id => sessionToUi(state.sessionsById[id], state)),
      };
    }
    if (command === CoreCommand.CREATE_SESSION) {
      const state = await this.repo.update(draft => { const s=sessionFromUi(payload.config || {}, this.now()); if(draft.sessionsById[s.id]) throw new Error('Session id already exists'); draft.sessionsById[s.id]=s; draft.sessionOrder.push(s.id); appendLog(draft,s.id,'Session created',{at:this.now()}); return draft; });
      const id=state.sessionOrder.at(-1); return { session: sessionToUi(state.sessionsById[id],state) };
    }
    if (command === CoreCommand.UPDATE_SESSION) {
      const state = await this.repo.update(async draft => {
        const old=requireSession(draft,payload.sessionId);
        if(ACTIVE_STATES.has(old.runState)||hasUnresolvedOperation(old)) throw new Error('Pause or stop the session and resolve uncertain work before editing');
        if(Number(payload.expectedVersion)!==Number(old.version||0)) throw new Error('This session changed in another view. Reload before saving');
        const replacement=sessionFromUi({...payload.config,id:old.id,version:(old.version||0)+1},this.now());
        replacement.runState=old.runState;
        const oldTaskId=old.taskOrder[old.currentTaskIndex];
        replacement.currentTaskIndex=Math.max(0,replacement.taskOrder.indexOf(oldTaskId));
        replacement.nextAllowedSendAt=old.nextAllowedSendAt;
        replacement.operation=old.operation;
        replacement.lastSuccessfulSendAt=old.lastSuccessfulSendAt;
        replacement.successfulSendCount=old.successfulSendCount||0;
        replacement.completedAt=old.completedAt||0;
        replacement.createdAt=old.createdAt;
        replacement.onePassCompletedTaskIds=(old.onePassCompletedTaskIds||[]).filter(id=>replacement.tasksById[id]);
        replacement.onePassCompletedCount=Math.min(logicalTaskCount(replacement), Number(old.onePassCompletedCount ?? old.onePassCompletedTaskIds?.length ?? 0));
        for(const id of replacement.taskOrder){const previous=old.tasksById[id];const current=replacement.tasksById[id];if(previous&&previous.normalizedUrl===current.normalizedUrl){for(const field of ['status','lastCheckedAt','lastVerifiedSendAt','lastVerifiedFingerprint','retryAfterAt','manualReviewReason']) current[field]=previous[field];}}
        const removedHintKeys = tabHintKeysRemovedByUpdatedSession(draft, old, replacement);
        for (const key of removedHintKeys) {
          await closeOwnedHintBeforeForget(this.chromeApi, old, draft.tabHintsByTaskId?.[key]);
        }
        cleanTabHintsForUpdatedSession(draft, old, replacement);
        draft.sessionsById[old.id]=replacement;
        appendLog(draft,old.id,'Session configuration saved',{at:this.now()});
        return draft;
      });
      return { session: sessionToUi(state.sessionsById[payload.sessionId],state) };
    }
    if (command === CoreCommand.DELETE_SESSION) {
      await this.repo.update(async d=>{
        const s=requireSession(d,payload.sessionId);
        if(!DELETABLE_STATES.has(s.runState)) throw new Error('Pause or stop the session before deleting');
        if(hasUnresolvedOperation(s) && s.runState!==RunState.STOPPED) throw new Error('Stop the session before deleting unfinished work');
        for(const hint of Object.values(d.tabHintsByTaskId || {})) {
          if(hint?.sessionId!==payload.sessionId) continue;
          await closeOwnedHintBeforeForget(this.chromeApi, s, hint);
        }
        if(s.operation?.operationId) releaseSendLease(d,{sessionId:s.id,operationId:s.operation.operationId,now:this.now(),profileGapMs:0});
        delete d.sessionsById[payload.sessionId];
        d.sessionOrder=d.sessionOrder.filter(id=>id!==payload.sessionId);
        delete d.logs[payload.sessionId];
        for(const [taskId,hint] of Object.entries(d.tabHintsByTaskId)) if(hint?.sessionId===payload.sessionId) delete d.tabHintsByTaskId[taskId];
        return d;
      });
      return {};
    }
    if (command === CoreCommand.DUPLICATE_SESSION) {
      const state=await this.repo.update(d=>{
        const old=requireSession(d,payload.sessionId);
        if(hasUnresolvedOperation(old)) throw new Error('Resolve the uncertain send operation before duplicating');
        const copy=structuredClone(old);
        const now=this.now();
        copy.id=crypto.randomUUID();
        copy.version=1;
        copy.name=`${old.name} copy`;
        copy.runState=RunState.STOPPED;
        copy.currentTaskIndex=0;
        copy.operation=null;
        copy.nextAllowedSendAt=0;
        copy.lastActionAt=0;
        copy.lastSuccessfulSendAt=0;
        copy.successfulSendCount=0;
        copy.completedAt=0;
        copy.lastError='';
        copy.onePassCompletedTaskIds=[];
        copy.onePassCompletedCount=0;
        copy.createdAt=now;
        copy.updatedAt=now;
        copy.pausedByMaster=false;
        const nextTasks={};
        copy.taskOrder=old.taskOrder.map(id=>{
          const nid=crypto.randomUUID();
          nextTasks[nid]={...structuredClone(old.tasksById[id]),id:nid,status:'IDLE',lastCheckedAt:0,lastVerifiedSendAt:0,lastVerifiedFingerprint:'',retryAfterAt:0,manualReviewReason:''};
          return nid;
        });
        copy.tasksById=nextTasks;
        d.sessionsById[copy.id]=copy;
        d.sessionOrder.push(copy.id);
        appendLog(d,copy.id,'Session duplicated',{at:now});
        return d;
      });
      const id=state.sessionOrder.at(-1);
      return {session:sessionToUi(state.sessionsById[id],state)};
    }
    if ([CoreCommand.START_SESSION,CoreCommand.PAUSE_SESSION,CoreCommand.RESUME_SESSION,CoreCommand.STOP_SESSION].includes(command)) {
      const state=await this.repo.update(d=>{
        const s=requireSession(d,payload.sessionId);
        if(command===CoreCommand.START_SESSION){
          if(!this.executionAvailable) throw new Error(EXECUTION_UNAVAILABLE_MESSAGE);
          if(!STARTABLE_STATES.has(s.runState)) throw new Error('Session is already active');
          const now = this.now();
          const continuingPaused = s.runState === RunState.PAUSED;
          const masterPauseCleared = clearMasterPauseForExplicitSessionAction(d, now);
          const healedLegacyHold = healUnattendedManualHolds(s, now, { resumeMachinePause: false });
          const retriedManualReview=acknowledgeSafePreSubmitManualReview(s);
          let unresolved=hasUnresolvedOperation(s);
          if (unresolved && s.retryPolicy !== 'manual' && s.operation?.phase === OperationPhase.SUBMITTING) {
            s.operation.phase = OperationPhase.AMBIGUOUS;
            s.operation.updatedAt = now;
            const operationTask = s.tasksById?.[s.operation.taskId];
            if (operationTask) {
              operationTask.status = 'SUBMISSION_UNCERTAIN';
              operationTask.manualReviewReason = '';
              operationTask.retryAfterAt = Math.max(operationTask.retryAfterAt || 0, now);
            }
          }
          unresolved=hasUnresolvedOperation(s);
          validateRunnableSession(s,{allowUnresolved: unresolved && s.retryPolicy !== 'manual'});
          assertNoActiveUrlCollision(d,s);
          // Start is also an owner-friendly Continue action when the Session is
          // PAUSED. In that case it must preserve progress exactly like Resume.
          // Only a genuine STOPPED/ERROR fresh Start of a completed one-pass run
          // intentionally resets that pass.
          if(s.runMode===RunMode.ONE_PASS && !unresolved && !continuingPaused && onePassCompleted(s)){s.onePassCompletedTaskIds=[];s.onePassCompletedCount=0;s.successfulSendCount=0;s.completedAt=0;}
          if (continuingPaused) resumeSession(s,now); else startSession(s,now);
          if(unresolved)s.runState=RunState.RECOVERING;
          s.pausedByMaster=false;
          const startMessage = unresolved
            ? (continuingPaused ? 'Paused session continued into unattended recovery' : 'Session started into unattended recovery; unresolved operation preserved')
            : retriedManualReview || healedLegacyHold
              ? 'Session started; pre-send manual review cleared for retry'
              : continuingPaused
                ? 'Paused session continued by explicit Start'
                : masterPauseCleared
                  ? 'Session started; global pause cleared by explicit Start'
                  : 'Session started';
          appendLog(d,s.id,startMessage,{at:now});
        }
        if(command===CoreCommand.PAUSE_SESSION){
          if(!ACTIVE_STATES.has(s.runState)) throw new Error('Only an active session can be paused');
          pauseSession(s,this.now());
          appendLog(d,s.id,'Session paused',{at:this.now()});
        }
        if(command===CoreCommand.RESUME_SESSION){
          if(!this.executionAvailable) throw new Error(EXECUTION_UNAVAILABLE_MESSAGE);
          const now = this.now();
          const masterPauseCleared = clearMasterPauseForExplicitSessionAction(d, now);
          const healedLegacyHold = healUnattendedManualHolds(s, now, { resumeMachinePause: false });
          const retriedManualReview=acknowledgeSafePreSubmitManualReview(s);
          let unresolved=hasUnresolvedOperation(s);

          // Owner UX treats "Continue" as the natural inverse of both Pause and
          // Stop.  Preserve the stricter state-machine semantics internally, but
          // make an explicit Resume on STOPPED/ERROR follow the same durable Start
          // path instead of surfacing "Only a paused session can be resumed".
          if (s.runState === RunState.PAUSED) {
            if(!unresolved)validateRunnableSession(s);
            assertNoActiveUrlCollision(d,s);
            resumeSession(s,now);
            if(unresolved)s.runState=RunState.RECOVERING;
            s.pausedByMaster=false;
            appendLog(d,s.id,(retriedManualReview||healedLegacyHold)?'Session resumed; pre-send manual review cleared for retry':(unresolved?'Session resumed into recovery':(masterPauseCleared?'Session resumed; global pause cleared by explicit Resume':'Session resumed')),{at:now});
          } else if (STARTABLE_STATES.has(s.runState)) {
            if (unresolved && s.retryPolicy !== 'manual' && s.operation?.phase === OperationPhase.SUBMITTING) {
              s.operation.phase = OperationPhase.AMBIGUOUS;
              s.operation.updatedAt = now;
              const operationTask = s.tasksById?.[s.operation.taskId];
              if (operationTask) {
                operationTask.status = 'SUBMISSION_UNCERTAIN';
                operationTask.manualReviewReason = '';
                operationTask.retryAfterAt = Math.max(operationTask.retryAfterAt || 0, now);
              }
            }
            unresolved=hasUnresolvedOperation(s);
            validateRunnableSession(s,{allowUnresolved: unresolved && s.retryPolicy !== 'manual'});
            assertNoActiveUrlCollision(d,s);
            if(s.runMode===RunMode.ONE_PASS && !unresolved && onePassCompleted(s)){s.onePassCompletedTaskIds=[];s.onePassCompletedCount=0;s.successfulSendCount=0;s.completedAt=0;}
            startSession(s,now);
            if(unresolved)s.runState=RunState.RECOVERING;
            s.pausedByMaster=false;
            appendLog(d,s.id,unresolved?'Stopped session continued into unattended recovery':'Stopped session continued by explicit Resume',{at:now});
          } else {
            throw new Error('Only a paused, stopped, or failed session can be resumed');
          }
        }
        if(command===CoreCommand.STOP_SESSION){
          const now = this.now();
          const operation = s.operation;
          const operationTask = operation?.taskId ? s.tasksById?.[operation.taskId] : null;
          if (operation && !TERMINAL_OPERATION_PHASES.has(operation.phase)
              && Number(operation.submitStartedAt || 0) <= 0) {
            // Stop before a physical Send is safe to cancel. Do not carry a
            // pre-submit phantom operation into Continue/Start and do not keep
            // an open-close tab alive as if post-submit evidence existed.
            operation.phase = OperationPhase.FAILED_SAFE;
            operation.updatedAt = now;
            if (operationTask) {
              operationTask.status = 'RETRY_WAIT';
              operationTask.retryAfterAt = Math.max(operationTask.retryAfterAt || 0, now);
              operationTask.manualReviewReason = '';
            }
          }
          stopSession(s,now);
          appendLog(d,s.id,hasUnresolvedOperation(s)?'Session stopped; unresolved post-submit operation preserved':'Session stopped safely',{at:now});
        }
        return d;
      });
      if (command === CoreCommand.STOP_SESSION) {
        await this.retireStoppedSessionTabs(payload.sessionId);
        const refreshed = await this.repo.load();
        return {session:sessionToUi(refreshed.sessionsById[payload.sessionId],refreshed)};
      }
      return {session:sessionToUi(state.sessionsById[payload.sessionId],state)};
    }
    if (command === CoreCommand.CLEAR_LOG) { const state=await this.repo.update(d=>{requireSession(d,payload.sessionId);d.logs[payload.sessionId]=[];return d;}); return {session:sessionToUi(state.sessionsById[payload.sessionId],state)}; }
    if (command === CoreCommand.MASTER_PAUSE) { await this.repo.update(d=>{d.profile.masterPaused=true; for(const s of Object.values(d.sessionsById)) if(ACTIVE_STATES.has(s.runState)){pauseSession(s,this.now());s.pausedByMaster=true;appendLog(d,s.id,'Session paused by master pause',{at:this.now()});} return d;}); return {masterPaused:true}; }
    if (command === CoreCommand.MASTER_RESUME) { await this.repo.update(d=>{d.profile.masterPaused=false; for(const s of Object.values(d.sessionsById)) if(s.runState===RunState.PAUSED&&s.pausedByMaster){if(this.executionAvailable){s.pausedByMaster=false;s.lastActionAt=this.now();const healed=healUnattendedManualHolds(s,this.now(),{resumeMachinePause:true});const unresolved=hasUnresolvedOperation(s);if(unresolved&&s.operation?.phase===OperationPhase.MANUAL_REVIEW){appendLog(d,s.id,'Session remains paused for manual review after master resume',{at:this.now()});}else if(hasReservedUrlCollision(d,s)){s.runState=RunState.PAUSED;s.lastError=URL_OWNERSHIP_ERROR;appendLog(d,s.id,'Session remains paused because another active or unresolved session owns a ChatGPT conversation',{at:this.now()});}else{s.runState=unresolved?RunState.RECOVERING:RunState.RUNNING;appendLog(d,s.id,healed?'Session resumed after master pause; legacy manual hold converted to unattended recovery':'Session resumed after master pause',{at:this.now()});}}else{s.lastError=EXECUTION_UNAVAILABLE_MESSAGE;appendLog(d,s.id,'Session remains paused because automatic execution is unavailable',{at:this.now()});}} return d;}); return {masterPaused:false}; }
    throw new Error(`Unknown Core command: ${command}`);
  }
}
