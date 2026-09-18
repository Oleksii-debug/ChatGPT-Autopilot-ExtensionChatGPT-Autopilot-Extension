import {
  CoordinatorEventType,
  CoordinatorStatus,
  WorkerState,
  acquireCoordinatorLease,
  applyControlDecision,
  parseDirectControlResponse,
  applyCoordinatorCompletionProbe,
  applyWorkerCompletionProbe,
  buildCoordinatorTickPrompt,
  coordinatorCompletionProbe,
  coordinatorNeedsRotation,
  enqueueCoordinatorEvent,
  enqueueStaleWorkerCandidates,
  enqueueWatchdogIfDue,
  expireQueuedWorkerAuthorizations,
  ensureCoordinatorSession,
  materializeWorkersIntoCore,
  nextWorkerLaunchAt,
  orchestrationSnapshot,
  projectBackpressureUntil,
  recordProviderFetch,
  releaseExpiredWorkerBackpressure,
  rotateCoordinator,
  syncCoordinatorDeliveryFromCore,
  syncWorkerDeliveryFromCore,
  validateOrchestrationConfig,
  workerCompletionProbe,
} from './orchestration-v2.js';
import {
  ORCHESTRATION_CONFIG_STORAGE_KEY,
  ORCHESTRATION_RUNTIME_STORAGE_KEY,
  OrchestrationConfigRepository,
  OrchestrationRuntimeRepository,
} from './orchestration-v2-storage.js';
import { fetchGitHubOrchestrationControl } from './orchestration-v2-github.js';
import { OperationPhase, RunState } from './schema.js';
import { exportOrchestrationProfile, importOrchestrationProfile, previewOrchestrationProfile } from './orchestration-v2-profile.js';

export const ORCHESTRATION_V2_ALARM = 'autopilot-orchestration-v2-wake';
const MIN_CONTROL_RETRY_MS = 15_000;
const MIN_ACTIVE_PROBE_MS = 30_000;
const MAX_PROBES_PER_CYCLE = 200;
const SAFE_TERMINAL_PHASES = new Set([OperationPhase.SENT_VERIFIED, OperationPhase.FAILED_SAFE]);

function isUnresolvedOperation(session) {
  return Boolean(session?.operation && !SAFE_TERMINAL_PHASES.has(session.operation.phase));
}

function isManagedOrchestrationSession(session, projectId) {
  return (session?.orchestrationWorker?.managed && session.orchestrationWorker.projectId === projectId)
    || (session?.orchestrationCoordinator?.managed && session.orchestrationCoordinator.projectId === projectId);
}

function isTabAlreadyGoneError(error) {
  return /no tab with id|invalid tab id|tab not found/i.test(String(error?.message || error || ''));
}

export class OrchestrationV2Controller {
  constructor({
    coreRepository,
    chromeApi,
    fetchFn = globalThis.fetch,
    collectAssistantReport = null,
    now = () => Date.now(),
    configRepository = null,
    runtimeRepository = null,
    alarmName = ORCHESTRATION_V2_ALARM,
  } = {}) {
    if (!coreRepository || !chromeApi) throw new Error('Orchestration V2 controller dependencies are required');
    this.coreRepository = coreRepository;
    this.chrome = chromeApi;
    this.fetchFn = fetchFn;
    this.collectAssistantReport = collectAssistantReport;
    this.now = now;
    this.configRepository = configRepository || new OrchestrationConfigRepository(chromeApi);
    this.runtimeRepository = runtimeRepository || new OrchestrationRuntimeRepository(chromeApi, this.configRepository, { now });
    this.alarmName = alarmName;
    this.cycleInFlight = null;
  }

  async getStatus() {
    const config = await this.configRepository.load();
    const runtime = await this.runtimeRepository.load();
    return { config, runtime: orchestrationSnapshot(runtime, config) };
  }

  async revokeFutureAuthority(projectId, nowMs = this.now()) {
    await this.runtimeRepository.update(runtime => {
      runtime.mode = 'PAUSE';
      runtime.desiredActiveWorkers = 0;
      runtime.pendingCoordinatorEvents = [];
      runtime.coordinator.rotationRequested = false;
      return runtime;
    });
    await this.coreRepository.update(state => {
      for (const session of Object.values(state.sessionsById || {})) {
        if (!isManagedOrchestrationSession(session, projectId)) continue;
        session.enabled = false;
        if (!isUnresolvedOperation(session)) session.runState = RunState.STOPPED;
      }
      return state;
    });
  }

  async updateConfig(raw) {
    const current = await this.configRepository.load();
    const next = validateOrchestrationConfig(raw);
    const identityChanged = current.projectId !== next.projectId
      || current.controlRepository !== next.controlRepository
      || current.controlIssueNumber !== next.controlIssueNumber
      || current.controlCommentId !== next.controlCommentId;
    if (current.enabled && identityChanged) throw new Error('Disable Orchestration V2 before changing project/control identity.');
    if (current.enabled && !next.enabled) await this.revokeFutureAuthority(current.projectId, this.now());
    const saved = await this.configRepository.save(next);
    if (!current.enabled && identityChanged) await this.runtimeRepository.reset();
    await this.reconcileAlarm();
    return saved;
  }

  async reconcileAlarm({ nowMs = this.now() } = {}) {
    const config = await this.configRepository.load();
    if (!config.enabled) {
      await this.chrome.alarms?.clear?.(this.alarmName);
      return 0;
    }
    const runtime = await this.runtimeRepository.load();
    const activeProbeNeeded = runtime.workerOrder.some(workerId => [WorkerState.ACTIVE, WorkerState.BUSY].includes(runtime.workersById[workerId]?.state));
    const watchdogBaseline = runtime.lastWatchdogAt || runtime.lastCoordinatorDecisionAt || runtime.createdAt || nowMs;
    const candidates = [watchdogBaseline + config.watchdogIntervalSeconds * 1000];
    if (runtime.coordinator.lease) {
      const controlWait = runtime.coordinator.status === CoordinatorStatus.WAITING_CONTROL;
      const coordinatorBackoff = Number(runtime.coordinator.retryAfterAt || 0);
      if (coordinatorBackoff > nowMs) candidates.push(coordinatorBackoff);
      else candidates.push(nowMs + (controlWait ? MIN_CONTROL_RETRY_MS : MIN_ACTIVE_PROBE_MS));
      if (controlWait && runtime.provider.retryAfterAt > nowMs) candidates.push(runtime.provider.retryAfterAt);
    }
    if (activeProbeNeeded) candidates.push(nowMs + config.workerProbeIntervalSeconds * 1000);
    const workerLaunchAt = nextWorkerLaunchAt(runtime, config, nowMs);
    if (workerLaunchAt > 0) candidates.push(workerLaunchAt <= nowMs ? nowMs + 1_000 : workerLaunchAt);
    // Launch authorization expiry is itself a durable orchestration deadline. If
    // an owner launch-rate/min-gap gate opens later than a queued worker's
    // expiresAt, waking only for the gate/watchdog leaves revoked work QUEUED
    // and delays the required WORKER_TERMINAL -> coordinator replan.
    const queuedExpiryAt = (runtime.workerOrder || [])
      .map(workerId => runtime.workersById?.[workerId])
      .filter(worker => worker?.state === WorkerState.QUEUED)
      .map(worker => Number(worker.expiresAt || 0))
      .filter(value => Number.isFinite(value) && value > nowMs)
      .sort((a, b) => a - b)[0] || 0;
    if (queuedExpiryAt > 0) candidates.push(queuedExpiryAt);
    // Project backpressure blocks new launches/coordinator turns until the latest
    // active retry deadline, but individual rate-limited workers become probeable
    // at their own retry deadlines. Wake at the earliest worker retry as well so
    // one long provider backoff cannot delay another worker's completion recovery.
    const earliestWorkerRetryAt = (runtime.workerOrder || [])
      .map(workerId => runtime.workersById?.[workerId])
      .filter(worker => worker?.state === WorkerState.RATE_LIMITED)
      .map(worker => Number(worker.retryAfterAt || 0))
      .filter(value => Number.isFinite(value) && value > nowMs)
      .sort((a, b) => a - b)[0] || 0;
    if (earliestWorkerRetryAt > 0) candidates.push(earliestWorkerRetryAt);
    const backpressureUntil = projectBackpressureUntil(runtime, nowMs);
    if (backpressureUntil > nowMs) candidates.push(backpressureUntil);
    let wakeAt = Math.max(nowMs + 1_000, Math.min(...candidates.filter(value => Number.isFinite(value) && value > 0)));
    await this.chrome.alarms?.create?.(this.alarmName, { when: wakeAt });
    return wakeAt;
  }

  async syncAfterCoreCycle({ nowMs = this.now() } = {}) {
    const config = await this.configRepository.load();
    if (!config.enabled) return { kind: 'DISABLED' };
    const retirement = await this.retryRetirePendingWorkerTabs();
    const coreState = await this.coreRepository.load();
    let delivery = null;
    await this.runtimeRepository.update(runtime => {
      const workers = syncWorkerDeliveryFromCore(runtime, coreState, nowMs);
      const coordinator = syncCoordinatorDeliveryFromCore(runtime, coreState, nowMs);
      delivery = { workers, coordinator };
      return runtime;
    });
    const materialized = await this.materializeQueuedWorkers({ nowMs });
    await this.reconcileAlarm({ nowMs });
    return { kind: 'SYNCED', delivery, materialized, retirement };
  }

  async materializeQueuedWorkers({ nowMs = this.now() } = {}) {
    const config = await this.configRepository.load();
    if (!config.enabled) return { launched: [] };
    let result = { launched: [], expired: [] };

    // Keep worker materialization inside the serialized runtime mutation chain.
    // A stale load -> Core update -> runtime save sequence can otherwise overwrite
    // a coordinator/event mutation that lands while the Core write is in flight.
    // Core remains the only Send authority; this only makes the orchestration
    // binding + launch-accounting checkpoint durable without lost updates.
    await this.runtimeRepository.update(async runtime => {
      const expiration = expireQueuedWorkerAuthorizations(runtime, nowMs);
      await this.coreRepository.update(state => {
        const materialized = materializeWorkersIntoCore(state, runtime, config, nowMs);
        result = { ...materialized, expired: expiration.expired };
        return materialized.state;
      });
      return runtime;
    });
    return result;
  }

  async closeManagedWorkerTabs(workerIds = []) {
    if (!workerIds.length) return { closed: [], pending: [], releasedUserTabs: [] };
    const runtime = await this.runtimeRepository.load();
    const targets = [];
    const state = await this.coreRepository.load();
    for (const workerId of workerIds) {
      const worker = runtime.workersById?.[workerId];
      if (!worker?.sessionId || !worker.sessionTaskId) continue;
      const session = state.sessionsById?.[worker.sessionId];
      if (!session?.orchestrationWorker?.managed) continue;
      const hint = state.tabHintsByTaskId?.[worker.sessionTaskId];
      const matchingHint = hint?.sessionId === worker.sessionId && hint?.kind === 'TASK' && Number.isInteger(hint.tabId)
        ? hint
        : null;
      targets.push({
        workerId, sessionId: worker.sessionId, taskId: worker.sessionTaskId,
        tabId: matchingHint?.tabId ?? null,
        ownedByExtension: matchingHint ? matchingHint.ownedByExtension !== false : false,
      });
    }
    const closed = [];
    const pending = [];
    const releasedUserTabs = [];
    const outcomes = [];
    for (const target of targets) {
      let tabClosedOrGone = target.tabId == null;
      let retirementPending = false;
      if (Number.isInteger(target.tabId)) {
        if (!target.ownedByExtension) {
          // Explicitly adopted/user-owned tabs are released from orchestration
          // ownership but are never physically closed.
          releasedUserTabs.push(target.workerId);
          tabClosedOrGone = true;
        } else if (this.chrome.tabs?.remove) {
          try {
            await this.chrome.tabs.remove(target.tabId);
            tabClosedOrGone = true;
            closed.push(target.workerId);
          } catch (error) {
            if (isTabAlreadyGoneError(error)) {
              tabClosedOrGone = true;
              closed.push(target.workerId);
            } else {
              try {
                if (!this.chrome.tabs?.get) throw new Error('TAB_EXISTENCE_UNPROVEN');
                await this.chrome.tabs.get(target.tabId);
                retirementPending = true;
                pending.push(target.workerId);
              } catch (getError) {
                if (String(getError?.message || '') === 'TAB_EXISTENCE_UNPROVEN') {
                  retirementPending = true;
                  pending.push(target.workerId);
                } else {
                  tabClosedOrGone = true;
                  closed.push(target.workerId);
                }
              }
            }
          }
        } else {
          retirementPending = true;
          pending.push(target.workerId);
        }
      }
      outcomes.push({ ...target, tabClosedOrGone, retirementPending });
    }
    if (outcomes.length) {
      await this.coreRepository.update(draft => {
        for (const target of outcomes) {
          const hint = draft.tabHintsByTaskId?.[target.taskId];
          const session = draft.sessionsById?.[target.sessionId];
          if (!session?.orchestrationWorker?.managed) continue;

          // Revoked orchestration authority always stops a safe managed Core
          // Session. Tab ownership is forgotten only after physical close/gone
          // proof, or when provenance explicitly says it is a user-owned tab.
          if (!isUnresolvedOperation(session)) {
            session.enabled = false;
            session.runState = RunState.STOPPED;
          }

          if (hint?.sessionId !== target.sessionId || (target.tabId !== null && hint?.tabId !== target.tabId)) continue;
          if (target.retirementPending && target.ownedByExtension) {
            hint.ownedByExtension = true;
            hint.retirePending = true;
          } else if (target.tabClosedOrGone) {
            delete draft.tabHintsByTaskId[target.taskId];
          }
        }
        return draft;
      });
    }
    return { closed, pending, releasedUserTabs };
  }

  async retryRetirePendingWorkerTabs() {
    const state = await this.coreRepository.load();
    const pending = [];
    for (const [taskId, hint] of Object.entries(state.tabHintsByTaskId || {})) {
      if (!hint?.retirePending || hint?.ownedByExtension !== true || !Number.isInteger(hint.tabId)) continue;
      const session = state.sessionsById?.[hint.sessionId];
      if (!session?.orchestrationWorker?.managed) continue;
      pending.push({ taskId, sessionId: hint.sessionId, tabId: hint.tabId });
    }
    if (!pending.length) return { retired: [], pending: [] };
    const retired = [];
    const stillPending = [];
    for (const target of pending) {
      let gone = false;
      try {
        await this.chrome.tabs?.remove?.(target.tabId);
        gone = true;
      } catch (error) {
        if (isTabAlreadyGoneError(error)) gone = true;
        else {
          try {
            if (!this.chrome.tabs?.get) throw new Error('TAB_EXISTENCE_UNPROVEN');
            await this.chrome.tabs.get(target.tabId);
          } catch (getError) {
            if (String(getError?.message || '') !== 'TAB_EXISTENCE_UNPROVEN') gone = true;
          }
        }
      }
      if (gone) retired.push(target); else stillPending.push(target);
    }
    if (retired.length) {
      await this.coreRepository.update(draft => {
        for (const target of retired) {
          const hint = draft.tabHintsByTaskId?.[target.taskId];
          if (hint?.sessionId === target.sessionId && hint?.tabId === target.tabId && hint?.retirePending) {
            delete draft.tabHintsByTaskId[target.taskId];
          }
        }
        return draft;
      });
    }
    return { retired: retired.map(item => item.tabId), pending: stillPending.map(item => item.tabId) };
  }

  async closeCoordinatorTabForRotation() {
    if (!this.chrome.tabs?.remove) return false;
    const runtime = await this.runtimeRepository.load();
    if (!coordinatorNeedsRotation(runtime) || runtime.coordinator.lease) return false;
    const state = await this.coreRepository.load();
    const session = Object.values(state.sessionsById || {}).find(item => item?.orchestrationCoordinator?.managed && item.orchestrationCoordinator.projectId === runtime.projectId);
    if (!session || isUnresolvedOperation(session)) return false;
    const taskId = session.taskOrder?.[0];
    const hint = taskId ? state.tabHintsByTaskId?.[taskId] : null;
    if (!hint || hint.sessionId !== session.id || !Number.isInteger(hint.tabId)) return false;
    try { await this.chrome.tabs.remove(hint.tabId); } catch (_) { return false; }
    await this.coreRepository.update(draft => {
      const current = draft.tabHintsByTaskId?.[taskId];
      if (current?.sessionId === session.id && current?.tabId === hint.tabId) delete draft.tabHintsByTaskId[taskId];
      return draft;
    });
    return true;
  }

  async ensureCoordinatorTurnDelivery({ nowMs = this.now() } = {}) {
    const config = await this.configRepository.load();
    if (!config.enabled) return { kind: 'DISABLED' };
    let runtime = await this.runtimeRepository.load();
    if (!runtime.coordinator.lease) return { kind: 'NO_LEASE' };
    const backpressureUntil = projectBackpressureUntil(runtime, nowMs);
    if (backpressureUntil > nowMs) return { kind: 'PROJECT_BACKPRESSURE', wakeAt: backpressureUntil };
    const prompt = buildCoordinatorTickPrompt(runtime, config, {
      initial: !runtime.coordinator.chatUrl,
      nowMs: runtime.coordinator.lease.acquiredAt || nowMs,
    });
    let binding = null;
    await this.coreRepository.update(state => {
      binding = ensureCoordinatorSession(state, runtime, config, prompt, nowMs);
      return binding.state;
    });
    return { kind: 'COORDINATOR_DELIVERY_READY', binding, prompt, lease: runtime.coordinator.lease };
  }

  async beginCoordinatorTurn({ reason = 'RECONCILE', nowMs = this.now() } = {}) {
    const config = await this.configRepository.load();
    if (!config.enabled) return { kind: 'DISABLED' };
    const currentRuntime = await this.runtimeRepository.load();
    const backpressureUntil = projectBackpressureUntil(currentRuntime, nowMs);
    if (backpressureUntil > nowMs) {
      await this.reconcileAlarm({ nowMs });
      return { kind: 'PROJECT_BACKPRESSURE', wakeAt: backpressureUntil };
    }
    if (coordinatorNeedsRotation(currentRuntime)) await this.closeCoordinatorTabForRotation();
    let acquisition = null;
    let runtime = await this.runtimeRepository.update(async draft => {
      if (draft.coordinator.lease) {
        acquisition = { acquired: false, reason: 'BUSY', lease: draft.coordinator.lease };
        return draft;
      }
      if (coordinatorNeedsRotation(draft)) {
        // Rotation changes the durable coordinator generation. Never advance that
        // generation while the existing managed Core coordinator still owns an
        // unresolved Send/recovery operation, even if physical tab close failed
        // or a service-worker restart lost transient state.
        const coreState = await this.coreRepository.load();
        const coordinatorSession = Object.values(coreState.sessionsById || {}).find(session =>
          session?.orchestrationCoordinator?.managed
          && session.orchestrationCoordinator.projectId === draft.projectId);
        if (isUnresolvedOperation(coordinatorSession)) {
          draft.coordinator.status = CoordinatorStatus.ROTATION_REQUIRED;
          draft.coordinator.lastError = 'Coordinator rotation blocked by unresolved Send/recovery evidence.';
          acquisition = { acquired: false, reason: 'ROTATION_BLOCKED_UNRESOLVED_SEND' };
          return draft;
        }
        rotateCoordinator(draft, nowMs);
      }
      acquisition = acquireCoordinatorLease(draft, { nowMs, reason });
      return draft;
    });
    if (!acquisition?.acquired) {
      await this.reconcileAlarm({ nowMs });
      return { kind: acquisition?.reason || 'NOT_ACQUIRED', acquisition };
    }
    const delivery = await this.ensureCoordinatorTurnDelivery({ nowMs });
    await this.reconcileAlarm({ nowMs });
    return { kind: 'COORDINATOR_TURN_STARTED', acquisition, delivery, runtime };
  }

  async probeWorkerCompletions({ nowMs = this.now() } = {}) {
    if (typeof this.collectAssistantReport !== 'function') return { probed: 0, terminal: [], staleCandidates: [] };
    const config = await this.configRepository.load();
    const runtime = await this.runtimeRepository.load();
    const probes = runtime.workerOrder
      .map(workerId => workerCompletionProbe(runtime.workersById[workerId], nowMs))
      .filter(Boolean)
      .slice(0, MAX_PROBES_PER_CYCLE);
    const terminal = [];
    for (const probe of probes) {
      let result;
      try { result = await this.collectAssistantReport(probe); }
      catch (error) { result = { status: 'TEMPORARY_ERROR', safeDiagnosticCode: error?.safeDiagnosticCode || 'WORKER_REPORT_PROBE_FAILED' }; }
      await this.runtimeRepository.update(draft => {
        const applied = applyWorkerCompletionProbe(draft, probe.workerId, result, nowMs);
        if (applied?.terminal) terminal.push(probe.workerId);
        return draft;
      });
    }
    let staleCandidates = [];
    await this.runtimeRepository.update(draft => {
      staleCandidates = enqueueStaleWorkerCandidates(draft, config, nowMs).added;
      return draft;
    });
    const cleanup = await this.closeManagedWorkerTabs(terminal);
    return { probed: probes.length, terminal, staleCandidates, cleanup };
  }

  async probeCoordinatorCompletion({ nowMs = this.now() } = {}) {
    if (typeof this.collectAssistantReport !== 'function') return { kind: 'NO_COLLECTOR' };
    const runtime = await this.runtimeRepository.load();
    if (Number(runtime.coordinator.retryAfterAt || 0) > nowMs) return { kind: 'COORDINATOR_BACKOFF', wakeAt: runtime.coordinator.retryAfterAt };
    const probe = coordinatorCompletionProbe(runtime);
    if (!probe || runtime.coordinator.responseCompleteAt) return { kind: 'NOT_READY_FOR_PROBE' };
    let result;
    try { result = await this.collectAssistantReport(probe); }
    catch (error) { result = { status:'TEMPORARY_ERROR', safeDiagnosticCode:error?.safeDiagnosticCode || 'COORDINATOR_REPORT_PROBE_FAILED' }; }
    let applied = null;
    await this.runtimeRepository.update(draft => {
      applied = applyCoordinatorCompletionProbe(draft, result, nowMs);
      return draft;
    });
    return { kind: 'PROBED', result, applied };
  }

  async exportProfile(name = 'Orchestration') {
    const config = await this.configRepository.load();
    return exportOrchestrationProfile(config, { name });
  }

  async previewProfile(profile) {
    return previewOrchestrationProfile(profile);
  }

  async importProfile(profile) {
    const imported = importOrchestrationProfile(profile);
    const current = await this.configRepository.load();
    if (current.enabled) throw new Error('Disable Orchestration V2 before importing configuration.');
    const saved = await this.updateConfig({ ...imported, enabled: false });
    return { config: saved, preview: previewOrchestrationProfile(profile) };
  }

  async testControl(rawSettings = null, { nowMs = this.now() } = {}) {
    const persisted = await this.configRepository.load();
    const merged = rawSettings && typeof rawSettings === 'object' ? { ...persisted, ...rawSettings } : persisted;
    // Feed testing intentionally does not require enabling orchestration or
    // creating a coordinator lease. Reuse normal config validation by supplying
    // harmless non-persisted placeholders for fields unrelated to GitHub read.
    const config = validateOrchestrationConfig({
      ...merged,
      enabled: true,
      targetRepository: merged.targetRepository || merged.controlRepository,
      masterCoordinatorPrompt: merged.masterCoordinatorPrompt || 'CONTROL_TEST_ONLY',
    });
    const runtime = await this.runtimeRepository.load();
    const sameProject = runtime.projectId === config.projectId;
    const generation = sameProject ? runtime.coordinator.generation : 1;
    const commentId = config.controlCommentId || (sameProject ? runtime.provider.canonicalCommentId : 0);
    const fetched = await fetchGitHubOrchestrationControl({
      fetchFn: this.fetchFn,
      repository: config.controlRepository,
      issueNumber: config.controlIssueNumber,
      commentId,
      projectId: config.projectId,
      coordinatorGeneration: generation,
      lastAppliedRevision: 0,
      nowMs,
    });
    return {
      kind: 'CONTROL_TEST',
      projectId: config.projectId,
      coordinatorGeneration: generation,
      commentId,
      selected: fetched.selected,
      diagnostics: fetched.diagnostics || [],
      rateLimitRemaining: fetched.rateLimitRemaining,
    };
  }

  async pollControl({ nowMs = this.now(), force = false } = {}) {
    const config = await this.configRepository.load();
    if (!config.enabled) return { kind: 'DISABLED' };
    const runtime = await this.runtimeRepository.load();
    if (!runtime.coordinator.lease) return { kind: 'NO_COORDINATOR_LEASE' };
    if (!force && runtime.coordinator.status !== CoordinatorStatus.WAITING_CONTROL) return { kind: 'COORDINATOR_RESPONSE_NOT_COMPLETE' };
    if (!force && runtime.provider.retryAfterAt > nowMs) return { kind: 'PROVIDER_BACKOFF', wakeAt: runtime.provider.retryAfterAt };

    let fetched;
    try {
      fetched = await fetchGitHubOrchestrationControl({
        fetchFn: this.fetchFn,
        repository: config.controlRepository,
        issueNumber: config.controlIssueNumber,
        commentId: config.controlCommentId || runtime.provider.canonicalCommentId,
        projectId: config.projectId,
        coordinatorGeneration: runtime.coordinator.generation,
        lastAppliedRevision: runtime.lastAppliedControlRevision,
        nowMs,
      });
    } catch (error) {
      await this.runtimeRepository.update(draft => recordProviderFetch(draft, {
        ok: false,
        nowMs,
        error: error?.code || error?.message || 'CONTROL_FETCH_FAILED',
        retryAfterAt: error?.retryAfterAt || nowMs + MIN_CONTROL_RETRY_MS,
        rateLimitRemaining: error?.rateLimitRemaining,
      }));
      await this.reconcileAlarm({ nowMs });
      return { kind: 'FETCH_ERROR', error };
    }

    if (!fetched.selected) {
      const diagnostic = fetched.diagnostics?.[0]?.message || '';
      await this.runtimeRepository.update(draft => recordProviderFetch(draft, {
        ok: true,
        nowMs,
        error: diagnostic,
        rateLimitRemaining: fetched.rateLimitRemaining,
      }));
      await this.reconcileAlarm({ nowMs });
      return { kind: 'UNCHANGED', diagnostics: fetched.diagnostics || [] };
    }

    let applied = null;
    await this.runtimeRepository.update(draft => {
      recordProviderFetch(draft, {
        ok: true,
        nowMs,
        canonicalCommentId: fetched.selected.commentId,
        rateLimitRemaining: fetched.rateLimitRemaining,
      });
      applied = applyControlDecision(draft, fetched.selected.control, config, nowMs, { source: 'GITHUB' });
      return draft;
    });
    const cleanup = await this.closeManagedWorkerTabs(applied?.result?.superseded || []);
    const materialized = await this.materializeQueuedWorkers({ nowMs });
    await this.reconcileAlarm({ nowMs });
    return { kind: 'CONTROL_APPLIED', selected: fetched.selected, applied, cleanup, materialized };
  }

  async applyDirectCoordinatorControl({ nowMs = this.now() } = {}) {
    const config = await this.configRepository.load();
    if (!config.enabled) return { kind: 'DISABLED' };
    const runtime = await this.runtimeRepository.load();
    if (!runtime.coordinator.lease || runtime.coordinator.status !== CoordinatorStatus.WAITING_CONTROL) {
      return { kind: 'DIRECT_NOT_READY' };
    }
    const report = String(runtime.coordinator.lastAssistantReport || '');
    let parsed;
    try {
      parsed = parseDirectControlResponse(report, {
        projectId: config.projectId,
        coordinatorGeneration: runtime.coordinator.generation,
        nowMs,
      });
    } catch (error) {
      return { kind: 'DIRECT_INVALID', error };
    }
    if (!parsed.executable) return { kind: 'DIRECT_UNAVAILABLE', reason: parsed.reason || 'UNMARKED' };
    if (parsed.control.revision <= runtime.lastAppliedControlRevision) {
      return { kind: 'DIRECT_STALE', revision: parsed.control.revision };
    }

    let applied = null;
    try {
      await this.runtimeRepository.update(draft => {
        applied = applyControlDecision(draft, parsed.control, config, nowMs, { source: 'DIRECT_CHAT' });
        return draft;
      });
    } catch (error) {
      return { kind: 'DIRECT_INVALID', error };
    }
    const cleanup = await this.closeManagedWorkerTabs(applied?.result?.superseded || []);
    const materialized = await this.materializeQueuedWorkers({ nowMs });
    await this.reconcileAlarm({ nowMs });
    return { kind: 'CONTROL_APPLIED', source: 'DIRECT_CHAT', applied, cleanup, materialized };
  }

  async bootstrapPinnedControl({ nowMs = this.now() } = {}) {
    const config = await this.configRepository.load();
    if (!config.enabled || !config.bootstrapPinnedControlFirst) return { kind: 'BOOTSTRAP_DISABLED' };
    const runtime = await this.runtimeRepository.load();
    const freshRuntime = runtime.lastAppliedControlRevision === 0
      && !runtime.coordinator.chatUrl
      && runtime.coordinator.turnsUsed === 0
      && !runtime.coordinator.lease;
    if (!freshRuntime) return { kind: 'BOOTSTRAP_NOT_FRESH' };
    if (!config.controlCommentId && !runtime.provider.canonicalCommentId) return { kind: 'BOOTSTRAP_NO_PINNED_COMMENT' };
    if (runtime.provider.retryAfterAt > nowMs) return { kind: 'PROVIDER_BACKOFF', wakeAt: runtime.provider.retryAfterAt };

    let fetched;
    try {
      fetched = await fetchGitHubOrchestrationControl({
        fetchFn: this.fetchFn,
        repository: config.controlRepository,
        issueNumber: config.controlIssueNumber,
        commentId: config.controlCommentId || runtime.provider.canonicalCommentId,
        projectId: config.projectId,
        coordinatorGeneration: runtime.coordinator.generation,
        lastAppliedRevision: runtime.lastAppliedControlRevision,
        nowMs,
      });
    } catch (error) {
      await this.runtimeRepository.update(draft => recordProviderFetch(draft, {
        ok: false, nowMs, error: error?.code || error?.message || 'BOOTSTRAP_CONTROL_FETCH_FAILED',
        retryAfterAt: error?.retryAfterAt || nowMs + MIN_CONTROL_RETRY_MS,
        rateLimitRemaining: error?.rateLimitRemaining,
      }));
      return { kind: 'BOOTSTRAP_FETCH_ERROR', error };
    }

    if (!fetched.selected) {
      await this.runtimeRepository.update(draft => recordProviderFetch(draft, {
        ok: true, nowMs, error: fetched.diagnostics?.[0]?.message || '',
        rateLimitRemaining: fetched.rateLimitRemaining,
      }));
      return { kind: 'BOOTSTRAP_UNCHANGED', diagnostics: fetched.diagnostics || [] };
    }

    let applied = null;
    await this.runtimeRepository.update(draft => {
      recordProviderFetch(draft, {
        ok: true, nowMs, canonicalCommentId: fetched.selected.commentId,
        rateLimitRemaining: fetched.rateLimitRemaining,
      });
      applied = applyControlDecision(draft, fetched.selected.control, config, nowMs, {
        consumeCoordinatorLease: false,
        source: 'GITHUB_BOOTSTRAP',
      });
      return draft;
    });
    const cleanup = await this.closeManagedWorkerTabs(applied?.result?.superseded || []);
    const materialized = await this.materializeQueuedWorkers({ nowMs });
    await this.reconcileAlarm({ nowMs });
    return { kind: 'BOOTSTRAP_APPLIED', selected: fetched.selected, applied, cleanup, materialized };
  }

  async enqueueRecoveryEvent({ nowMs = this.now(), detail = 'Cold-start reconciliation completed.' } = {}) {
    const config = await this.configRepository.load();
    if (!config.enabled) return { kind: 'DISABLED' };
    let queued = null;
    await this.runtimeRepository.update(runtime => {
      queued = enqueueCoordinatorEvent(runtime, { type: CoordinatorEventType.RECOVERY_RECONCILE, key:'cold-start', at:nowMs, detail }, nowMs);
      return runtime;
    });
    return { kind: 'RECOVERY_EVENT', queued };
  }

  async cycle({ nowMs = this.now() } = {}) {
    if (this.cycleInFlight) return this.cycleInFlight;
    const operation = (async () => {
      const config = await this.configRepository.load();
      if (!config.enabled) {
        await this.reconcileAlarm({ nowMs });
        return { kind: 'DISABLED' };
      }

      await this.runtimeRepository.update(draft => {
        releaseExpiredWorkerBackpressure(draft, nowMs);
        return draft;
      });
      const sync = await this.syncAfterCoreCycle({ nowMs });
      const workers = await this.probeWorkerCompletions({ nowMs });
      const coordinatorProbe = await this.probeCoordinatorCompletion({ nowMs });
      let control = null;
      let runtime = await this.runtimeRepository.load();

      if (runtime.coordinator.status === CoordinatorStatus.WAITING_CONTROL) {
        const direct = await this.applyDirectCoordinatorControl({ nowMs });
        if (direct.kind === 'CONTROL_APPLIED') control = direct;
        else control = await this.pollControl({ nowMs });
        runtime = await this.runtimeRepository.load();
      }

      // Watchdog is a durable reconciliation event, not a spawn command. It may
      // become due while a coordinator turn is still BUSY/backpressured; enqueue
      // it anyway so the event coalesces into the next single-flight turn and the
      // alarm baseline advances instead of hot-looping on an overdue watchdog.
      await this.runtimeRepository.update(draft => {
        enqueueWatchdogIfDue(draft, config, nowMs);
        return draft;
      });
      runtime = await this.runtimeRepository.load();

      let bootstrap = null;
      if (!runtime.coordinator.lease
          && !runtime.coordinator.chatUrl
          && runtime.coordinator.turnsUsed === 0
          && runtime.lastAppliedControlRevision === 0
          && config.bootstrapPinnedControlFirst) {
        bootstrap = await this.bootstrapPinnedControl({ nowMs });
        runtime = await this.runtimeRepository.load();
      }

      if (!runtime.coordinator.lease) {
        const initial = !runtime.coordinator.chatUrl && runtime.coordinator.turnsUsed === 0;
        if (initial) {
          await this.beginCoordinatorTurn({ reason:'INITIALIZE', nowMs });
        } else if (runtime.pendingCoordinatorEvents.length || coordinatorNeedsRotation(runtime)) {
          await this.beginCoordinatorTurn({ reason:'RECONCILE', nowMs });
        }
      } else {
        // A terminal event that arrived while the coordinator was BUSY remains queued
        // and will be included in exactly one follow-up lease after the current control is applied.
        await this.ensureCoordinatorTurnDelivery({ nowMs }).catch(() => undefined);
      }

      await this.reconcileAlarm({ nowMs });
      return { kind:'CYCLE', sync, workers, coordinatorProbe, control, bootstrap, status: await this.getStatus() };
    })();
    this.cycleInFlight = operation.finally(() => { this.cycleInFlight = null; });
    return this.cycleInFlight;
  }
}

export { ORCHESTRATION_CONFIG_STORAGE_KEY, ORCHESTRATION_RUNTIME_STORAGE_KEY };
