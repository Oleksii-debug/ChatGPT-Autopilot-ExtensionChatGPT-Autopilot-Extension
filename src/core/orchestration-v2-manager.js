import { OrchestrationV2Controller, ORCHESTRATION_V2_ALARM } from './orchestration-v2-controller.js';
import {
  ORCHESTRATION_CONFIG_STORAGE_KEY,
  ORCHESTRATION_RUNTIME_STORAGE_KEY,
  OrchestrationConfigRepository,
  OrchestrationRuntimeRepository,
} from './orchestration-v2-storage.js';
import { validateOrchestrationConfig } from './orchestration-v2.js';
import { OperationPhase, RunState } from './schema.js';
import {
  OrchestrationHierarchyEventType,
  compactOrchestrationEventId,
  validateOrchestrationHierarchyRuntimeV1,
} from './orchestration-hierarchy.js';
import { buildThreeLevelHierarchyTemplate } from './orchestration-role-prompts.js';
import { exportOrchestrationProfile, importOrchestrationProfileDocument, previewOrchestrationProfile } from './orchestration-v2-profile.js';
import { evaluateSubagentStructureAdmissionV1, normalizeSubagentStructurePolicyV1 } from './subagent-structure-policy.js';
import {
  createOrchestrationProjectAuthorityV1,
  inspectBrowserAgentOrchestrationNodeBindingV1,
  normalizeBrowserAgentOrchestrationNodeBindingV1,
} from './browser-agent-orchestration-binding.js';

export const ORCHESTRATION_V2_MANAGER_STORAGE_KEY = 'autopilotOrchestrationV2Manager';
export const ORCHESTRATION_V2_ALARM_PREFIX = `${ORCHESTRATION_V2_ALARM}:`;
const MANAGER_SCHEMA_VERSION = 1;
const SAFE_TERMINAL_PHASES = new Set([OperationPhase.SENT_VERIFIED, OperationPhase.FAILED_SAFE]);
const LIVE_WORKER_STATES = new Set(['QUEUED', 'LAUNCHING', 'ACTIVE', 'BUSY', 'RATE_LIMITED', 'BLOCKED', 'STALE', 'MANUAL_REVIEW']);
const SUBAGENT_ADMISSION_INTENT_KEYS = new Set(['initiator', 'parentNodeId', 'requestedChildren']);
const BROWSER_AGENT_LIFECYCLE_OPTION_KEYS = new Set(['browserControlEpoch', 'nowMs']);

export const OrchestrationProjectAuthorityErrorCode = Object.freeze({
  PROJECT_UNOWNED: 'PROJECT_UNOWNED',
  PROJECT_NON_UNIQUE: 'PROJECT_NON_UNIQUE',
  HIERARCHY_UNAVAILABLE: 'HIERARCHY_UNAVAILABLE',
  HIERARCHY_INCONSISTENT: 'HIERARCHY_INCONSISTENT',
});

function orchestrationProjectAuthorityError(code, message, cause = undefined) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  Object.defineProperty(error, 'code', {
    value: code,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return error;
}

function clone(value) { return structuredClone(value); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function safeName(value, fallback = 'Оркестр') { return text(value).slice(0, 120) || fallback; }
function plainIntent(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  const normalized = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !SUBAGENT_ADMISSION_INTENT_KEYS.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
    normalized[key] = descriptor.value;
  }
  return normalized;
}

function plainBrowserAgentLifecycleOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Browser Agent lifecycle options must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Browser Agent lifecycle options must be a plain object');
  }
  const normalized = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !BROWSER_AGENT_LIFECYCLE_OPTION_KEYS.has(key)) {
      throw new Error(`Browser Agent lifecycle options contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error('Browser Agent lifecycle options fields must be enumerable own data properties');
    }
    normalized[key] = descriptor.value;
  }
  return normalized;
}
function storedSubagentPolicy(value) {
  return { ...normalizeSubagentStructurePolicyV1(value === undefined ? {} : value) };
}
function configKey(id) { return `${ORCHESTRATION_CONFIG_STORAGE_KEY}:${id}`; }
function runtimeKey(id) { return `${ORCHESTRATION_RUNTIME_STORAGE_KEY}:${id}`; }
function alarmName(id) { return `${ORCHESTRATION_V2_ALARM_PREFIX}${id}`; }
function isUnresolvedOperation(session) { return Boolean(session?.operation && !SAFE_TERMINAL_PHASES.has(session.operation.phase)); }
function purgeManagedSessionState(state, sessionId) {
  delete state.sessionsById[sessionId];
  state.sessionOrder = (state.sessionOrder || []).filter(value => value !== sessionId);
  if (state.logs && typeof state.logs === 'object') delete state.logs[sessionId];
  for (const [hintKey, hint] of Object.entries(state.tabHintsByTaskId || {})) {
    if (hint?.sessionId === sessionId) delete state.tabHintsByTaskId[hintKey];
  }
}

function hierarchyGraphId(runtime) {
  return text(runtime?.hierarchy?.graph?.graphId);
}
async function setHierarchyRootScopes(controller, runtime, eventType, eventPrefix, orchestraId, nowMs) {
  const graph = runtime?.hierarchy?.graph;
  const state = runtime?.hierarchy?.state;
  if (!graph || !state || !Array.isArray(graph.rootIds) || !graph.rootIds.length) return [];
  const eventBase = Object.keys(state.processedEventIds || {}).length;
  const results = [];
  for (let index = 0; index < graph.rootIds.length; index += 1) {
    const nodeId = graph.rootIds[index];
    results.push(await controller.dispatchHierarchyEvent({
      type: eventType,
      eventId: compactOrchestrationEventId(`owner-${eventPrefix}`, orchestraId, graph.graphId, state.controlEpoch, eventBase + index + 1, nodeId),
      controlEpoch: state.controlEpoch,
      nodeId,
    }, { nowMs }));
  }
  return results;
}
function isManagedSession(session, projectId, graphId = '') {
  return (session?.orchestrationWorker?.managed && session.orchestrationWorker.projectId === projectId)
    || (session?.orchestrationCoordinator?.managed && session.orchestrationCoordinator.projectId === projectId)
    || (Boolean(graphId)
      && session?.orchestrationHierarchy?.managed
      && session.orchestrationHierarchy.graphId === graphId);
}
function identityChanged(a, b) {
  return a.projectId !== b.projectId
    || a.targetRepository !== b.targetRepository
    || a.controlRepository !== b.controlRepository
    || a.controlIssueNumber !== b.controlIssueNumber
    || a.controlCommentId !== b.controlCommentId
    || a.coordinatorAgentProviderId !== b.coordinatorAgentProviderId
    || a.workerAgentProviderId !== b.workerAgentProviderId
    || a.coordinatorLaunchUrl !== b.coordinatorLaunchUrl;
}
function freshMeta() { return { schemaVersion: MANAGER_SCHEMA_VERSION, selectedId: '', order: [], byId: {} }; }
function normalizeMeta(raw) {
  if (!raw || raw.schemaVersion !== MANAGER_SCHEMA_VERSION || !Array.isArray(raw.order) || typeof raw.byId !== 'object') return freshMeta();
  const byId = {};
  const order = [];
  for (const id of raw.order) {
    if (typeof id !== 'string' || !id || !raw.byId[id] || byId[id]) continue;
    const item = raw.byId[id];
    byId[id] = {
      id,
      name: safeName(item.name, 'Оркестр'),
      ownerPaused: item.ownerPaused === true,
      pausedSessionIds: Array.isArray(item.pausedSessionIds) ? [...new Set(item.pausedSessionIds.filter(v => typeof v === 'string'))] : [],
      subagentPolicy: storedSubagentPolicy(item.subagentPolicy),
      createdAt: Math.max(0, Number(item.createdAt || 0)),
      updatedAt: Math.max(0, Number(item.updatedAt || 0)),
    };
    order.push(id);
  }
  return { schemaVersion: MANAGER_SCHEMA_VERSION, selectedId: byId[raw.selectedId] ? raw.selectedId : (order[0] || ''), order, byId };
}

export class OrchestrationV2Manager {
  constructor({
    coreRepository,
    chromeApi,
    fetchFn = globalThis.fetch,
    collectAssistantReport = null,
    resolveHierarchyProvider = null,
    now = () => Date.now(),
    createId = null,
  } = {}) {
    if (!coreRepository || !chromeApi?.storage?.local) throw new Error('Orchestration V2 manager dependencies are required');
    this.coreRepository = coreRepository;
    this.chrome = chromeApi;
    this.fetchFn = fetchFn;
    this.collectAssistantReport = collectAssistantReport;
    this.resolveHierarchyProvider = typeof resolveHierarchyProvider === 'function' ? resolveHierarchyProvider : null;
    this.now = now;
    this.createId = createId || (() => `orch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    this.controllers = new Map();
    this.updateChain = Promise.resolve();
    // Canonical in-process authority fence. Manager-owned mutations that can
    // change Project ownership, hierarchy provenance or owner subagent policy
    // serialize with Browser Agent binding admission through this same chain.
    this.projectAuthorityChain = Promise.resolve();
    this.migrationBarrier = null;
  }

  async loadMeta({ migrate = true } = {}) {
    if (migrate) await this.ensureMigrated();
    const result = await this.chrome.storage.local.get(ORCHESTRATION_V2_MANAGER_STORAGE_KEY);
    return normalizeMeta(result?.[ORCHESTRATION_V2_MANAGER_STORAGE_KEY]);
  }

  async saveMeta(meta) {
    const normalized = normalizeMeta(meta);
    await this.chrome.storage.local.set({ [ORCHESTRATION_V2_MANAGER_STORAGE_KEY]: normalized });
    return normalized;
  }

  updateMeta(mutator) {
    const operation = this.updateChain.then(async () => {
      await this.ensureMigrated();
      const meta = await this.loadMeta({ migrate: false });
      const updated = await mutator(meta) || meta;
      return this.saveMeta(updated);
    });
    this.updateChain = operation.catch(() => undefined);
    return operation;
  }

  runProjectAuthorityExclusive(operation) {
    if (typeof operation !== 'function') {
      throw new Error('Orchestration Project authority operation must be a function');
    }
    const run = this.projectAuthorityChain.then(operation);
    this.projectAuthorityChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Keep canonical Project -> hierarchy authority stable while a dependent
   * durable mutation commits. The callback is awaited under the same fence
   * used by manager-owned authority mutations.
   */
  withProjectHierarchyAuthority(projectId, operation) {
    if (typeof operation !== 'function') {
      throw new Error('Orchestration Project authority callback is required');
    }
    return this.runProjectAuthorityExclusive(async () => {
      const authority = await this.resolveProjectHierarchyAuthority(projectId);
      return operation(authority);
    });
  }

  /**
   * Hold canonical Project/hierarchy authority while BrowserAgentManager runs
   * its serialized owner-lifecycle mutation and the exact bound subtree event.
   * The shared lock order is Project -> Browser, matching durable BIND, so
   * lifecycle and binding cannot create a cross-authority lock inversion.
   *
   * This remains a thin adapter over the existing hierarchy reducer/runtime;
   * it creates no lifecycle authority.
   */
  withBrowserAgentBoundLifecycleAuthority(bindingRaw, operation) {
    const binding = normalizeBrowserAgentOrchestrationNodeBindingV1(bindingRaw);
    if (typeof operation !== 'function') {
      throw new Error('Browser Agent bound lifecycle authority callback is required');
    }

    return this.runProjectAuthorityExclusive(async () => {
      const authority = await this.resolveProjectHierarchyAuthority(binding.projectId);
      const inspection = inspectBrowserAgentOrchestrationNodeBindingV1({ binding, authority });
      if (!inspection.current) {
        throw new Error(`Browser Agent orchestration binding is stale: ${inspection.status}`);
      }
      const controller = this.controllerFor(authority.orchestraId);

      const applyBoundLifecycle = async (transitionRaw, options = {}) => {
        const admittedOptions = plainBrowserAgentLifecycleOptions(options);
        const browserControlEpoch = admittedOptions.browserControlEpoch;
        const nowMs = admittedOptions.nowMs === undefined ? this.now() : admittedOptions.nowMs;
        const transition = typeof transitionRaw === 'string' ? transitionRaw.trim().toUpperCase() : '';
        const eventType = transition === 'PAUSE'
          ? OrchestrationHierarchyEventType.PAUSE_SCOPE
          : transition === 'RESUME'
            ? OrchestrationHierarchyEventType.RESUME_SCOPE
            : transition === 'STOP'
              ? OrchestrationHierarchyEventType.STOP_SCOPE
              : '';
        if (!eventType) throw new Error('Invalid Browser Agent bound lifecycle transition');
        if (typeof browserControlEpoch !== 'number'
            || !Number.isSafeInteger(browserControlEpoch)
            || Object.is(browserControlEpoch, -0)
            || browserControlEpoch < 1) {
          throw new Error('Invalid Browser Agent lifecycle control epoch');
        }
        if (typeof nowMs !== 'number'
            || !Number.isSafeInteger(nowMs)
            || Object.is(nowMs, -0)
            || nowMs < 0) {
          throw new Error('Invalid Browser Agent lifecycle timestamp');
        }

        // Re-check durable hierarchy provenance after the Browser Agent has
        // queued behind its own update chain but while this Project fence is
        // still held.
        const runtimeBefore = await controller.runtimeRepository.load();
        const graphBefore = runtimeBefore?.hierarchy?.graph;
        const stateBefore = runtimeBefore?.hierarchy?.state;
        if (!graphBefore
            || !stateBefore
            || graphBefore.graphId !== binding.graphId
            || graphBefore.controlEpoch !== binding.controlEpoch
            || stateBefore.graphId !== binding.graphId
            || stateBefore.controlEpoch !== binding.controlEpoch
            || !stateBefore.nodesById?.[binding.nodeId]) {
          throw new Error('Browser Agent hierarchy authority changed before lifecycle transition');
        }

        const eventId = compactOrchestrationEventId(
          'browser-agent-lifecycle',
          binding.jobId,
          binding.projectId,
          binding.orchestraId,
          binding.graphId,
          binding.controlEpoch,
          binding.nodeId,
          transition,
          browserControlEpoch,
        );
        const result = await controller.dispatchHierarchyEvent({
          type: eventType,
          eventId,
          controlEpoch: binding.controlEpoch,
          nodeId: binding.nodeId,
        }, { nowMs });

        const expectedReason = transition === 'PAUSE'
          ? 'PAUSED'
          : transition === 'STOP'
            ? 'STOPPED'
            : 'RUNNING';
        if (result?.kind !== 'HIERARCHY_EVENT' || result.reason !== expectedReason) {
          throw new Error(`Browser Agent hierarchy lifecycle transition was not accepted: ${String(result?.reason || result?.kind || 'UNKNOWN')}`);
        }

        // RESUME_SCOPE deliberately leaves terminal STOPPED nodes stopped. The
        // aggregate reducer reason describes the requested scope, so bind
        // authorization to the actual durable target state.
        const latestRuntime = await controller.runtimeRepository.load();
        const latestGraph = latestRuntime?.hierarchy?.graph;
        const latestState = latestRuntime?.hierarchy?.state;
        if (!latestGraph
            || !latestState
            || latestGraph.graphId !== binding.graphId
            || latestState.graphId !== binding.graphId
            || latestState.controlEpoch !== binding.controlEpoch) {
          throw new Error('Browser Agent hierarchy authority changed during lifecycle transition');
        }
        const target = latestState.nodesById?.[binding.nodeId];
        if (!target || target.scopeState !== expectedReason) {
          throw new Error(
            `Browser Agent hierarchy target did not enter requested lifecycle scope: ${String(target?.scopeState || 'MISSING')}`,
          );
        }

        return Object.freeze({
          binding,
          transition,
          eventId,
          targetScopeState: target.scopeState,
          result: structuredClone(result),
        });
      };

      return operation(applyBoundLifecycle);
    });
  }

  ensureMigrated() {
    if (this.migrationBarrier) return this.migrationBarrier;
    this.migrationBarrier = (async () => {
      const current = await this.chrome.storage.local.get([ORCHESTRATION_V2_MANAGER_STORAGE_KEY, ORCHESTRATION_CONFIG_STORAGE_KEY, ORCHESTRATION_RUNTIME_STORAGE_KEY]);
      if (current?.[ORCHESTRATION_V2_MANAGER_STORAGE_KEY]) return;
      const legacyConfig = current?.[ORCHESTRATION_CONFIG_STORAGE_KEY];
      const legacyRuntime = current?.[ORCHESTRATION_RUNTIME_STORAGE_KEY];
      if (!legacyConfig && !legacyRuntime) {
        await this.saveMeta(freshMeta());
        return;
      }
      const id = 'legacy-default';
      const nowMs = this.now();
      const meta = freshMeta();
      meta.order = [id];
      meta.selectedId = id;
      meta.byId[id] = { id, name: safeName(legacyConfig?.projectId, 'Оркестр 1'), ownerPaused: false, pausedSessionIds: [], createdAt: nowMs, updatedAt: nowMs };
      const payload = { [ORCHESTRATION_V2_MANAGER_STORAGE_KEY]: meta };
      if (legacyConfig) payload[configKey(id)] = legacyConfig;
      if (legacyRuntime) payload[runtimeKey(id)] = legacyRuntime;
      await this.chrome.storage.local.set(payload);
    })().finally(() => { this.migrationBarrier = null; });
    return this.migrationBarrier;
  }

  controllerFor(id) {
    if (!id) throw new Error('No orchestra selected.');
    if (this.controllers.has(id)) return this.controllers.get(id);
    const configRepository = new OrchestrationConfigRepository(this.chrome, { storageKey: configKey(id) });
    const runtimeRepository = new OrchestrationRuntimeRepository(this.chrome, configRepository, { now: this.now, storageKey: runtimeKey(id) });
    const controller = new OrchestrationV2Controller({
      coreRepository: this.coreRepository,
      chromeApi: this.chrome,
      fetchFn: this.fetchFn,
      collectAssistantReport: this.collectAssistantReport,
      now: this.now,
      configRepository,
      runtimeRepository,
      alarmName: alarmName(id),
      resolveHierarchyProvider: this.resolveHierarchyProvider,
    });
    this.controllers.set(id, controller);
    return controller;
  }

  async selectedRecord() {
    const meta = await this.loadMeta();
    return meta.selectedId ? meta.byId[meta.selectedId] : null;
  }

  async list() {
    const meta = await this.loadMeta();
    const out = [];
    for (const id of meta.order) {
      const record = meta.byId[id];
      const status = await this.controllerFor(id).getStatus();
      out.push({ id, name: record.name, ownerPaused: record.ownerPaused, selected: id === meta.selectedId, config: status.config, runtime: status.runtime });
    }
    return { selectedId: meta.selectedId, orchestras: out };
  }

  async getStatus(id = '') {
    const meta = await this.loadMeta();
    const orchestraId = id || meta.selectedId;
    if (!orchestraId || !meta.byId[orchestraId]) {
      return { selectedId: '', orchestra: null, orchestras: [], config: validateOrchestrationConfig({}), runtime: null, ownerPaused: false };
    }
    const status = await this.controllerFor(orchestraId).getStatus();
    return {
      selectedId: orchestraId,
      orchestra: { ...clone(meta.byId[orchestraId]), selected: orchestraId === meta.selectedId },
      orchestras: meta.order.map(itemId => ({ ...clone(meta.byId[itemId]), selected: itemId === meta.selectedId })),
      ...status,
      ownerPaused: meta.byId[orchestraId].ownerPaused,
    };
  }

  async create({ name = 'Новий оркестр', config = null, select = true } = {}) {
    const id = this.createId();
    if (!/^[A-Za-z0-9._-]+$/u.test(id)) throw new Error('Invalid orchestra id');
    const nowMs = this.now();
    await this.updateMeta(meta => {
      if (meta.byId[id]) throw new Error('Orchestra id already exists');
      meta.byId[id] = { id, name: safeName(name), ownerPaused: false, pausedSessionIds: [], subagentPolicy: storedSubagentPolicy(), createdAt: nowMs, updatedAt: nowMs };
      meta.order.push(id);
      if (select || !meta.selectedId) meta.selectedId = id;
      return meta;
    });
    if (config) {
      try {
        await this.updateConfig({ ...config, enabled: false }, id);
      } catch (error) {
        // updateConfig is authority-fenced, but a failing repository write may
        // have partially persisted config/runtime. Keep cleanup under the same
        // fence so BIND cannot observe authority that is being rolled back.
        await this.runProjectAuthorityExclusive(async () => {
          await this.chrome.storage.local.remove?.([configKey(id), runtimeKey(id)]);
          this.controllers.delete(id);
          await this.updateMeta(meta => {
            delete meta.byId[id];
            meta.order = meta.order.filter(value => value !== id);
            if (meta.selectedId === id) meta.selectedId = meta.order[0] || '';
            return meta;
          });
        });
        throw error;
      }
    }
    return this.getStatus(id);
  }

  async select(id) {
    await this.updateMeta(meta => {
      if (!meta.byId[id]) throw new Error('Orchestra not found');
      meta.selectedId = id;
      return meta;
    });
    return this.getStatus(id);
  }

  async rename(id, name) {
    return this.runProjectAuthorityExclusive(() => this._renameUnfenced(id, name));
  }

  async _renameUnfenced(id, name) {
    await this.updateMeta(meta => {
      if (!meta.byId[id]) throw new Error('Orchestra not found');
      meta.byId[id].name = safeName(name);
      meta.byId[id].updatedAt = this.now();
      return meta;
    });
    return this.getStatus(id);
  }

  async managedCoreSafety(projectId, graphId = '') {
    const state = await this.coreRepository.load();
    const managed = Object.values(state.sessionsById || {}).filter(session => isManagedSession(session, projectId, graphId));
    return {
      managed,
      unresolved: managed.filter(isUnresolvedOperation),
      live: managed.filter(session => [RunState.RUNNING, RunState.RECOVERING].includes(session.runState)),
    };
  }

  async pause(id = '') {
    return this.runProjectAuthorityExclusive(() => this._pauseUnfenced(id));
  }

  async _pauseUnfenced(id = '') {
    const meta = await this.loadMeta();
    const orchestraId = id || meta.selectedId;
    if (!orchestraId || !meta.byId[orchestraId]) throw new Error('Orchestra not found');
    const controller = this.controllerFor(orchestraId);
    const { config } = await controller.getStatus();
    const runtime = await controller.runtimeRepository.load();
    const graphId = hierarchyGraphId(runtime);
    const nowMs = this.now();

    // Owner Pause must be durable orchestration authority, not only a Core
    // Session run-state toggle. Pausing every hierarchy root deterministically
    // covers the entire graph/subtrees through the existing reducer.
    await setHierarchyRootScopes(
      controller,
      runtime,
      OrchestrationHierarchyEventType.PAUSE_SCOPE,
      'pause',
      orchestraId,
      nowMs,
    );

    const pausedSessionIds = [];
    await this.coreRepository.update(state => {
      for (const session of Object.values(state.sessionsById || {})) {
        if (!isManagedSession(session, config.projectId, graphId)) continue;
        if (session.enabled && [RunState.RUNNING, RunState.RECOVERING, RunState.PAUSED].includes(session.runState)) {
          session.enabled = false;
          session.runState = RunState.PAUSED;
          pausedSessionIds.push(session.id);
        }
      }
      return state;
    });
    await this.updateMeta(draft => {
      const item = draft.byId[orchestraId];
      item.ownerPaused = true;
      item.pausedSessionIds = [...new Set([...(item.pausedSessionIds || []), ...pausedSessionIds])];
      item.updatedAt = nowMs;
      return draft;
    });
    await this.chrome.alarms?.clear?.(alarmName(orchestraId));
    return this.getStatus(orchestraId);
  }

  async resume(id = '') {
    return this.runProjectAuthorityExclusive(() => this._resumeUnfenced(id));
  }

  async _resumeUnfenced(id = '') {
    const meta = await this.loadMeta();
    const orchestraId = id || meta.selectedId;
    const item = meta.byId[orchestraId];
    if (!item) throw new Error('Orchestra not found');
    const controller = this.controllerFor(orchestraId);
    const { config } = await controller.getStatus();
    const runtime = await controller.runtimeRepository.load();
    const graphId = hierarchyGraphId(runtime);
    const nowMs = this.now();

    // Restore hierarchy authority first while Core Sessions are still disabled.
    // This prevents scope synchronization from accidentally starting a paused
    // Session before the owner-local resume set is restored below.
    await setHierarchyRootScopes(
      controller,
      runtime,
      OrchestrationHierarchyEventType.RESUME_SCOPE,
      'resume',
      orchestraId,
      nowMs,
    );

    const resumeIds = new Set(item.pausedSessionIds || []);
    await this.coreRepository.update(state => {
      for (const session of Object.values(state.sessionsById || {})) {
        if (!resumeIds.has(session.id) || !isManagedSession(session, config.projectId, graphId)) continue;
        session.enabled = true;
        if (session.runState === RunState.PAUSED) session.runState = RunState.RECOVERING;
      }
      return state;
    });
    await this.updateMeta(draft => {
      const current = draft.byId[orchestraId];
      current.ownerPaused = false;
      current.pausedSessionIds = [];
      current.updatedAt = nowMs;
      return draft;
    });
    if (config.enabled) {
      if (!graphId) {
        await controller.enqueueRecoveryEvent({ detail: 'Owner-local pause ended; reconcile live external truth.' });
      }
      await controller.cycle({ nowMs });
    }
    await controller.reconcileAlarm();
    return this.getStatus(orchestraId);
  }

  async assertSafeIdentityChange(id, currentConfig) {
    const controller = this.controllerFor(id);
    const runtime = await controller.runtimeRepository.load();
    const safety = await this.managedCoreSafety(currentConfig.projectId, hierarchyGraphId(runtime));
    const liveWorker = (runtime.workerOrder || []).some(workerId => LIVE_WORKER_STATES.has(runtime.workersById?.[workerId]?.state));
    if (safety.unresolved.length || runtime.coordinator?.lease || liveWorker || safety.live.length) {
      throw new Error('Pause is active, but identity cannot change while unresolved Send, active Coordinator or live worker state remains.');
    }
  }

  async assertUniqueProjectId(meta, orchestraId, projectId) {
    const normalized = text(projectId);
    if (!normalized) return;
    for (const otherId of meta.order || []) {
      if (otherId === orchestraId) continue;
      const otherConfig = await this.controllerFor(otherId).configRepository.load();
      if (text(otherConfig.projectId) === normalized) {
        throw new Error(`Project ID ${normalized} is already used by orchestra ${meta.byId[otherId]?.name || otherId}.`);
      }
    }
  }

  async updateConfig(raw, id = '') {
    return this.runProjectAuthorityExclusive(() => this._updateConfigUnfenced(raw, id));
  }

  async purgeManagedProjectSessionState(projectId, graphId = '') {
    await this.coreRepository.update(state => {
      for (const [sessionId, session] of Object.entries(state.sessionsById || {})) {
        if (!isManagedSession(session, projectId, graphId)) continue;
        if (isUnresolvedOperation(session)) {
          throw new Error('Unresolved Send prevents project identity change.');
        }
        purgeManagedSessionState(state, sessionId);
      }
      return state;
    });
  }

  async _updateConfigUnfenced(raw, id = '', { deferManagedSessionPurge = false } = {}) {
    const meta = await this.loadMeta();
    const orchestraId = id || meta.selectedId;
    const item = meta.byId[orchestraId];
    if (!item) throw new Error('Create or select an orchestra first.');
    const controller = this.controllerFor(orchestraId);
    const current = await controller.configRepository.load();
    const next = validateOrchestrationConfig(raw);
    await this.assertUniqueProjectId(meta, orchestraId, next.projectId);
    const changed = identityChanged(current, next);
    if (changed && current.enabled && !item.ownerPaused) {
      throw new Error('Pause the orchestra before changing project/repository/provider/Coordinator identity.');
    }
    if (changed && item.ownerPaused) {
      await this.assertSafeIdentityChange(orchestraId, current);
      if (current.projectId && current.projectId !== next.projectId) {
        const currentRuntime = await controller.runtimeRepository.load();
        const currentGraphId = hierarchyGraphId(currentRuntime);
        if (!deferManagedSessionPurge) {
          await this.purgeManagedProjectSessionState(current.projectId, currentGraphId);
        }
      }
      await controller.configRepository.save(next);
      await controller.runtimeRepository.reset();
      await this.chrome.alarms?.clear?.(alarmName(orchestraId));
    } else {
      await controller.updateConfig(next);
    }
    return this.getStatus(orchestraId);
  }

  async snapshotImportAuthorityState(orchestraId, metaRecord) {
    const keys = [configKey(orchestraId), runtimeKey(orchestraId)];
    const raw = await this.chrome.storage.local.get(keys);
    return {
      orchestraId,
      configPresent: Object.hasOwn(raw || {}, keys[0]),
      config: Object.hasOwn(raw || {}, keys[0]) ? clone(raw[keys[0]]) : undefined,
      runtimePresent: Object.hasOwn(raw || {}, keys[1]),
      runtime: Object.hasOwn(raw || {}, keys[1]) ? clone(raw[keys[1]]) : undefined,
      metaRecord: clone(metaRecord),
    };
  }

  async restoreImportAuthorityState(snapshot) {
    const configStorageKey = configKey(snapshot.orchestraId);
    const runtimeStorageKey = runtimeKey(snapshot.orchestraId);
    const restore = {};
    const remove = [];

    if (snapshot.configPresent) restore[configStorageKey] = clone(snapshot.config);
    else remove.push(configStorageKey);
    if (snapshot.runtimePresent) restore[runtimeStorageKey] = clone(snapshot.runtime);
    else remove.push(runtimeStorageKey);

    if (Object.keys(restore).length) {
      await this.chrome.storage.local.set(restore);
    }
    if (remove.length) {
      await this.chrome.storage.local.remove(remove);
    }

    await this.updateMeta(meta => {
      if (!meta.byId[snapshot.orchestraId]) {
        throw new Error('Orchestra disappeared while rolling back failed profile import.');
      }
      meta.byId[snapshot.orchestraId] = clone(snapshot.metaRecord);
      return meta;
    });

    // Alarm state is derived from the restored canonical config/runtime. A
    // reconcile failure must not replace the original import error or weaken
    // the already-restored authority snapshot.
    try {
      await this.controllerFor(snapshot.orchestraId).reconcileAlarm({ nowMs: this.now() });
    } catch {
      // Recovery/alarm reconciliation remains retryable from canonical state.
    }
  }

  async start(id = '') {
    return this.runProjectAuthorityExclusive(() => this._startUnfenced(id));
  }

  async _startUnfenced(id = '') {
    const meta = await this.loadMeta();
    const orchestraId = id || meta.selectedId;
    const item = meta.byId[orchestraId];
    if (!item) throw new Error('Orchestra not found');
    if (item.ownerPaused) throw new Error('Orchestra is locally paused. Use Resume instead of Start.');
    const controller = this.controllerFor(orchestraId);
    const current = await controller.configRepository.load();
    if (!current.enabled) await controller.updateConfig({ ...current, enabled: true });
    const nowMs = this.now();
    const runtime = await controller.runtimeRepository.load();
    const hierarchyStart = runtime?.hierarchy?.graph
      ? await controller.startHierarchy({ nowMs })
      : null;
    const cycle = await controller.cycle({ nowMs });
    return { ...(await this.getStatus(orchestraId)), hierarchyStart, startCycle: cycle };
  }

  async delete(id = '') {
    return this.runProjectAuthorityExclusive(() => this._deleteUnfenced(id));
  }

  async _deleteUnfenced(id = '') {
    const meta = await this.loadMeta();
    const orchestraId = id || meta.selectedId;
    const item = meta.byId[orchestraId];
    if (!item) throw new Error('Orchestra not found');
    const controller = this.controllerFor(orchestraId);
    const { config } = await controller.getStatus();
    const runtime = await controller.runtimeRepository.load();
    const graphId = hierarchyGraphId(runtime);
    const safety = await this.managedCoreSafety(config.projectId, graphId);
    const liveWorker = (runtime.workerOrder || []).some(workerId => LIVE_WORKER_STATES.has(runtime.workersById?.[workerId]?.state));
    if (safety.unresolved.length || runtime.coordinator?.lease || liveWorker || safety.live.length) {
      throw new Error('Cannot delete orchestra while unresolved Send, active Coordinator or live worker state remains. Pause/stop and reconcile first.');
    }
    await this.coreRepository.update(state => {
      for (const [sessionId, session] of Object.entries(state.sessionsById || {})) {
        if (!isManagedSession(session, config.projectId, graphId)) continue;
        purgeManagedSessionState(state, sessionId);
      }
      return state;
    });
    await this.chrome.alarms?.clear?.(alarmName(orchestraId));
    await this.chrome.storage.local.remove?.([configKey(orchestraId), runtimeKey(orchestraId)]);
    this.controllers.delete(orchestraId);
    await this.updateMeta(draft => {
      delete draft.byId[orchestraId];
      draft.order = draft.order.filter(value => value !== orchestraId);
      if (draft.selectedId === orchestraId) draft.selectedId = draft.order[0] || '';
      return draft;
    });
    return this.getStatus();
  }

  /**
   * Read-only canonical Project -> Orchestration hierarchy authority resolver.
   * Project identity comes from durable orchestra config; topology and owner
   * subagent policy come from the same orchestra's durable state. No spawn,
   * scheduling or execution authority is granted here.
   */
  async resolveProjectHierarchyAuthority(projectId) {
    if (typeof projectId !== 'string'
        || projectId !== projectId.trim()
        || !projectId
        || projectId.length > 180
        || !/^[A-Za-z0-9._:@/+~-]+$/u.test(projectId)) {
      throw new Error('Project ID for orchestration authority is invalid');
    }
    const meta = await this.loadMeta();
    const matches = [];
    for (const orchestraId of meta.order) {
      const controller = this.controllerFor(orchestraId);
      const config = await controller.configRepository.load();
      if (config.projectId === projectId) {
        matches.push({ orchestraId, item: meta.byId[orchestraId], controller });
      }
    }
    if (matches.length === 0) {
      throw orchestrationProjectAuthorityError(OrchestrationProjectAuthorityErrorCode.PROJECT_UNOWNED, 'No canonical orchestra owns this Project ID');
    }
    if (matches.length !== 1) {
      throw orchestrationProjectAuthorityError(OrchestrationProjectAuthorityErrorCode.PROJECT_NON_UNIQUE, 'Project ID is not uniquely owned by one canonical orchestra');
    }
    const match = matches[0];
    const runtime = await match.controller.runtimeRepository.load();
    const graph = runtime?.hierarchy?.graph;
    const state = runtime?.hierarchy?.state;
    if (!graph || !state) {
      throw orchestrationProjectAuthorityError(OrchestrationProjectAuthorityErrorCode.HIERARCHY_UNAVAILABLE, 'Canonical orchestra has no durable orchestration hierarchy');
    }
    if (state.graphId !== graph.graphId || state.controlEpoch !== graph.controlEpoch) {
      throw orchestrationProjectAuthorityError(OrchestrationProjectAuthorityErrorCode.HIERARCHY_INCONSISTENT, 'Canonical orchestration hierarchy runtime provenance is inconsistent');
    }
    try {
      validateOrchestrationHierarchyRuntimeV1(graph, state);
    } catch (error) {
      throw orchestrationProjectAuthorityError(
        OrchestrationProjectAuthorityErrorCode.HIERARCHY_INCONSISTENT,
        'Canonical orchestration hierarchy runtime is invalid',
        error,
      );
    }
    return createOrchestrationProjectAuthorityV1({
      orchestraId: match.orchestraId,
      projectId,
      graph,
      subagentPolicy: match.item.subagentPolicy,
    });
  }

  async selectedController() {
    const meta = await this.loadMeta();
    if (!meta.selectedId || !meta.byId[meta.selectedId]) throw new Error('Create or select an orchestra first.');
    return { id: meta.selectedId, item: meta.byId[meta.selectedId], controller: this.controllerFor(meta.selectedId) };
  }

  /**
   * Advisory structural precheck only. Caller supplies intent; owner policy comes
   * from manager metadata and topology comes from the selected orchestra's durable
   * runtime repository. This method never reserves capacity or grants spawn
   * authority. A future child-creation path must atomically re-read/revalidate
   * canonical hierarchy state and the global resource budget at mutation time.
   */
  async previewSelectedSubagentStructureAdmission(intent = {}) {
    const raw = plainIntent(intent, 'Subagent structural precheck intent');
    const { item, controller } = await this.selectedController();
    const runtime = await controller.runtimeRepository.load();
    const graph = runtime?.hierarchy?.graph;
    if (!graph) throw new Error('Configure a durable orchestration hierarchy before subagent precheck.');
    const decision = evaluateSubagentStructureAdmissionV1({
      policy: item.subagentPolicy,
      initiator: raw.initiator,
      graph,
      parentNodeId: raw.parentNodeId,
      requestedChildren: raw.requestedChildren,
    });
    return Object.freeze({
      ...decision,
      advisoryOnly: true,
      spawnAuthority: false,
    });
  }

  async configureHierarchyTemplate(options = {}) {
    return this.runProjectAuthorityExclusive(() => this._configureHierarchyTemplateUnfenced(options));
  }

  async _configureHierarchyTemplateUnfenced(options = {}) {
    const { id, item, controller } = await this.selectedController();
    const { config } = await controller.getStatus();
    if (!config.projectId || !config.targetRepository) {
      throw new Error('Save project ID and target repository before configuring hierarchy.');
    }
    if (config.enabled && item.ownerPaused !== true) {
      throw new Error('Pause or disable the orchestra before configuring hierarchy.');
    }

    const runtime = await controller.runtimeRepository.load();
    const currentGraphId = hierarchyGraphId(runtime);
    const safety = await this.managedCoreSafety(config.projectId, currentGraphId);
    if (safety.managed.length) {
      throw new Error('Hierarchy template can only be configured before the first Start. Create a new orchestra to replace an already-materialized hierarchy.');
    }

    const graph = buildThreeLevelHierarchyTemplate({
      graphId: options.graphId || `${id}-hierarchy`,
      controlEpoch: Number(options.controlEpoch || 1),
      projectId: config.projectId,
      targetRepository: config.targetRepository,
      controlIssueNumber: config.controlIssueNumber || 0,
      domains: options.domains,
      workersPerManager: options.workersPerManager,
      includeIntegrationManager: options.includeIntegrationManager === true,
      includeQaRedTeam: options.includeQaRedTeam === true,
      driveScalarSources: options.driveScalarSources || null,
      driveScalarPollIntervalMs: options.driveScalarPollIntervalMs,
      driveFolderSources: options.driveFolderSources || null,
      driveFolderPollIntervalMs: options.driveFolderPollIntervalMs,
    });
    const configured = await controller.configureHierarchy(graph, { nowMs: this.now() });
    return {
      hierarchy: {
        graphId: configured.graph.graphId,
        controlEpoch: configured.graph.controlEpoch,
        rootCount: configured.graph.rootIds.length,
        nodeCount: configured.graph.nodeOrder.length,
        promptProfileCount: configured.graph.promptProfiles.length,
        managerCount: configured.graph.nodeOrder.filter(nodeId => nodeId.startsWith('manager:')).length,
        workerCount: configured.graph.nodeOrder.filter(nodeId => nodeId.startsWith('worker:')).length,
        driveScalarProviderCount: configured.graph.nodeOrder.filter(
          nodeId => configured.graph.nodesById[nodeId]?.providerBinding?.providerId === 'drive-scalar-v1',
        ).length,
        driveFolderProviderCount: configured.graph.nodeOrder.filter(
          nodeId => configured.graph.nodesById[nodeId]?.providerBinding?.providerId === 'drive-folder-dispatch-v1',
        ).length,
      },
      status: await this.getStatus(id),
    };
  }

  async previewProfile(profile) { return previewOrchestrationProfile(profile); }
  async exportProfile(name = 'Orchestration') {
    const { item, controller } = await this.selectedController();
    const config = await controller.configRepository.load();
    const runtime = await controller.runtimeRepository.load();
    return exportOrchestrationProfile(config, {
      name,
      hierarchy: runtime?.hierarchy?.graph || null,
      subagentPolicy: item.subagentPolicy,
    });
  }
  async importProfile(profile) {
    const importedDocument = importOrchestrationProfileDocument(profile);
    const imported = importedDocument.config;
    let selected;

    // 0.9.7 invariant: importing a profile for an already-known project selects
    // that orchestra instead of mutating/creating a different selected one.
    if (imported.projectId) {
      const meta = await this.loadMeta();
      for (const id of meta.order) {
        const candidate = this.controllerFor(id);
        const candidateConfig = await candidate.configRepository.load();
        if (candidateConfig.projectId === imported.projectId) {
          await this.select(id);
          selected = await this.selectedController();
          break;
        }
      }
    }

    if (!selected) {
      try {
        selected = await this.selectedController();
      } catch {
        await this.create({ name: profile?.name || 'Імпортований оркестр' });
        selected = await this.selectedController();
      }
    }
    let current = await selected.controller.configRepository.load();

    // A profile for a different project is normally a new orchestra, not an
    // in-place mutation of a live/legacy runtime. This is especially important
    // for clean-control migrations: old coordinator leases, control revisions,
    // exact-once indexes and unresolved Send evidence must not leak into the
    // newly imported project. An explicit owner-paused orchestra still permits
    // deliberate in-place identity rebind through the existing safe path.
    if (!selected.item.ownerPaused
        && current.projectId
        && imported.projectId
        && current.projectId !== imported.projectId) {
      await this.create({ name: profile?.name || 'Імпортований оркестр' });
      selected = await this.selectedController();
      current = await selected.controller.configRepository.load();
    }

    if (current.enabled && !selected.item.ownerPaused) {
      throw new Error('Pause the orchestra before importing configuration.');
    }

    // Import is one composite Project-authority mutation: config identity,
    // hierarchy provenance and owner subagent policy must never be observable
    // by Browser Agent binding as three independently committed snapshots.
    // Re-check the live owner state inside the same authority fence and call
    // the unfenced config primitive to avoid promise-chain self-deadlock.
    const importedPolicy = storedSubagentPolicy(importedDocument.subagentPolicy);
    const status = await this.runProjectAuthorityExclusive(async () => {
      const liveMeta = await this.loadMeta();
      const liveItem = liveMeta.byId[selected.id];
      if (!liveItem) throw new Error('Orchestra not found while importing profile.');
      const liveController = this.controllerFor(selected.id);
      const liveCurrent = await liveController.configRepository.load();
      if (liveCurrent.enabled && !liveItem.ownerPaused) {
        throw new Error('Pause the orchestra before importing configuration.');
      }

      const authoritySnapshot = await this.snapshotImportAuthorityState(selected.id, liveItem);
      const oldRuntime = await liveController.runtimeRepository.load();
      const deferredManagedSessionPurge = liveItem.ownerPaused === true
        && Boolean(liveCurrent.projectId)
        && liveCurrent.projectId !== imported.projectId
        ? {
            projectId: liveCurrent.projectId,
            graphId: hierarchyGraphId(oldRuntime),
          }
        : null;
      let mutationStarted = false;
      try {
        mutationStarted = true;
        const nextStatus = await this._updateConfigUnfenced(
          { ...imported, enabled: false },
          selected.id,
          { deferManagedSessionPurge: Boolean(deferredManagedSessionPurge) },
        );
        if (importedDocument.hierarchy) {
          const currentRuntime = await liveController.runtimeRepository.load();
          const currentGraphId = hierarchyGraphId(currentRuntime);
          const safety = await this.managedCoreSafety(nextStatus.config.projectId, currentGraphId);
          if (safety.managed.length) {
            throw new Error('Hierarchy profile can only be imported before the first Start. Create a new orchestra to replace an already-materialized hierarchy.');
          }
          await liveController.configureHierarchy(importedDocument.hierarchy, { nowMs: this.now() });
        }
        await this.updateMeta(meta => {
          const record = meta.byId[selected.id];
          if (!record) throw new Error('Orchestra not found while persisting subagent policy.');
          record.subagentPolicy = importedPolicy;
          record.updatedAt = this.now();
          return meta;
        });
        if (deferredManagedSessionPurge) {
          await this.purgeManagedProjectSessionState(
            deferredManagedSessionPurge.projectId,
            deferredManagedSessionPurge.graphId,
          );
        }
        return nextStatus;
      } catch (error) {
        if (mutationStarted) {
          try {
            await this.restoreImportAuthorityState(authoritySnapshot);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'Profile import failed and canonical Project authority rollback also failed.',
            );
          }
        }
        throw error;
      }
    });

    return {
      config: status.config,
      hierarchy: importedDocument.hierarchy,
      preview: previewOrchestrationProfile(profile),
      status: await this.getStatus(selected.id),
    };
  }
  async testControl(settings = null) { return this.selectedController().then(({ controller }) => controller.testControl(settings)); }

  async cycleSelected() {
    const { id, item, controller } = await this.selectedController();
    if (item.ownerPaused) return { kind: 'OWNER_PAUSED', orchestraId: id };
    return controller.cycle();
  }

  async cycleAll() {
    const meta = await this.loadMeta();
    const results = [];
    for (const id of meta.order) {
      if (meta.byId[id].ownerPaused) { results.push({ id, kind: 'OWNER_PAUSED' }); continue; }
      results.push({ id, result: await this.controllerFor(id).cycle() });
    }
    return { kind: 'MANAGER_CYCLE', results };
  }

  async syncAfterCoreCycle() {
    const meta = await this.loadMeta();
    const results = [];
    for (const id of meta.order) {
      if (meta.byId[id].ownerPaused) { results.push({ id, kind: 'OWNER_PAUSED' }); continue; }
      results.push({ id, result: await this.controllerFor(id).syncAfterCoreCycle() });
    }
    return { kind: 'MANAGER_SYNC', results };
  }

  async reconcileAlarm() {
    const meta = await this.loadMeta();
    const results = [];
    for (const id of meta.order) {
      if (meta.byId[id].ownerPaused) { await this.chrome.alarms?.clear?.(alarmName(id)); results.push({ id, wakeAt: 0 }); continue; }
      results.push({ id, wakeAt: await this.controllerFor(id).reconcileAlarm() });
    }
    return results;
  }

  isAlarm(name) { return typeof name === 'string' && name.startsWith(ORCHESTRATION_V2_ALARM_PREFIX); }
  async cycleAlarm(name) {
    if (!this.isAlarm(name)) return { kind: 'IGNORED' };
    const id = name.slice(ORCHESTRATION_V2_ALARM_PREFIX.length);
    const meta = await this.loadMeta();
    if (!meta.byId[id]) { await this.chrome.alarms?.clear?.(name); return { kind: 'ORPHAN_ALARM' }; }
    if (meta.byId[id].ownerPaused) return { kind: 'OWNER_PAUSED', orchestraId: id };
    return this.controllerFor(id).cycle();
  }

  async emergencyStop(id = '') {
    return this.runProjectAuthorityExclusive(() => this._emergencyStopUnfenced(id));
  }

  async _emergencyStopUnfenced(id = '') {
    const meta = await this.loadMeta();
    const orchestraId = id || meta.selectedId;
    if (!orchestraId || !meta.byId[orchestraId]) throw new Error('Orchestra not found');

    // STOP is a safety boundary and must not depend on successfully normalizing a
    // possibly-corrupt runtime. Revoke future authority in raw durable storage
    // first, then best-effort repair/read status. Preserve every other runtime
    // field so unresolved exact-once Send evidence is never erased by STOP.
    const keys = [configKey(orchestraId), runtimeKey(orchestraId)];
    const raw = await this.chrome.storage.local.get(keys);
    const rawConfig = raw?.[configKey(orchestraId)] && typeof raw[configKey(orchestraId)] === 'object'
      ? clone(raw[configKey(orchestraId)]) : {};
    const disabledConfig = { ...rawConfig, enabled: false };
    const payload = { [configKey(orchestraId)]: disabledConfig };
    const rawRuntime = raw?.[runtimeKey(orchestraId)];
    if (rawRuntime && typeof rawRuntime === 'object') {
      const stoppedRuntime = clone(rawRuntime);
      stoppedRuntime.mode = 'PAUSE';
      stoppedRuntime.desiredActiveWorkers = 0;
      if (stoppedRuntime.coordinator && typeof stoppedRuntime.coordinator === 'object') {
        stoppedRuntime.coordinator.rotationRequested = false;
      }
      const hierarchyNodes = stoppedRuntime.hierarchy?.state?.nodesById;
      if (hierarchyNodes && typeof hierarchyNodes === 'object' && !Array.isArray(hierarchyNodes)) {
        for (const nodeRuntime of Object.values(hierarchyNodes)) {
          if (!nodeRuntime || typeof nodeRuntime !== 'object' || Array.isArray(nodeRuntime)) continue;
          nodeRuntime.scopeState = 'STOPPED';
          nodeRuntime.lifecycle = 'STOPPED';
        }
      }
      payload[runtimeKey(orchestraId)] = stoppedRuntime;
    }
    await this.chrome.storage.local.set(payload);

    const projectId = text(rawConfig.projectId);
    const graphId = text(rawRuntime?.hierarchy?.graph?.graphId);
    if (projectId || graphId) {
      await this.coreRepository.update(state => {
        for (const session of Object.values(state.sessionsById || {})) {
          if (!isManagedSession(session, projectId, graphId)) continue;
          session.enabled = false;
          if (!isUnresolvedOperation(session)) session.runState = RunState.STOPPED;
        }
        return state;
      });
    }
    await this.chrome.alarms?.clear?.(alarmName(orchestraId));

    let status = null;
    try { status = await this.getStatus(orchestraId); } catch (_) { /* safety action already persisted */ }
    return { config: status?.config || disabledConfig, status, emergencyStopped: true };
  }
}
