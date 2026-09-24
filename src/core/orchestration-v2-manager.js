import { OrchestrationV2Controller, ORCHESTRATION_V2_ALARM } from './orchestration-v2-controller.js';
import {
  ORCHESTRATION_CONFIG_STORAGE_KEY,
  ORCHESTRATION_RUNTIME_STORAGE_KEY,
  OrchestrationConfigRepository,
  OrchestrationRuntimeRepository,
} from './orchestration-v2-storage.js';
import { validateOrchestrationConfig } from './orchestration-v2.js';
import { OperationPhase, RunState } from './schema.js';
import { OrchestrationHierarchyEventType, compactOrchestrationEventId } from './orchestration-hierarchy.js';
import { buildThreeLevelHierarchyTemplate } from './orchestration-role-prompts.js';
import { exportOrchestrationProfile, importOrchestrationProfileDocument, previewOrchestrationProfile } from './orchestration-v2-profile.js';
import { evaluateSubagentStructureAdmissionV1, normalizeSubagentStructurePolicyV1 } from './subagent-structure-policy.js';

export const ORCHESTRATION_V2_MANAGER_STORAGE_KEY = 'autopilotOrchestrationV2Manager';
export const ORCHESTRATION_V2_ALARM_PREFIX = `${ORCHESTRATION_V2_ALARM}:`;
const MANAGER_SCHEMA_VERSION = 1;
const SAFE_TERMINAL_PHASES = new Set([OperationPhase.SENT_VERIFIED, OperationPhase.FAILED_SAFE]);
const LIVE_WORKER_STATES = new Set(['QUEUED', 'LAUNCHING', 'ACTIVE', 'BUSY', 'RATE_LIMITED', 'BLOCKED', 'STALE', 'MANUAL_REVIEW']);
const SUBAGENT_ADMISSION_INTENT_KEYS = new Set(['initiator', 'parentNodeId', 'requestedChildren']);

function clone(value) { return structuredClone(value); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function safeName(value, fallback = 'Оркестр') { return text(value).slice(0, 120) || fallback; }
function plainIntent(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !SUBAGENT_ADMISSION_INTENT_KEYS.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
  }
  return value;
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
        await this.chrome.storage.local.remove?.([configKey(id), runtimeKey(id)]);
        this.controllers.delete(id);
        await this.updateMeta(meta => {
          delete meta.byId[id];
          meta.order = meta.order.filter(value => value !== id);
          if (meta.selectedId === id) meta.selectedId = meta.order[0] || '';
          return meta;
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
        await this.coreRepository.update(state => {
          for (const [sessionId, session] of Object.entries(state.sessionsById || {})) {
            if (!isManagedSession(session, current.projectId, currentGraphId)) continue;
            if (isUnresolvedOperation(session)) throw new Error('Unresolved Send prevents project identity change.');
            purgeManagedSessionState(state, sessionId);
          }
          return state;
        });
      }
      await controller.configRepository.save(next);
      await controller.runtimeRepository.reset();
      await this.chrome.alarms?.clear?.(alarmName(orchestraId));
    } else {
      await controller.updateConfig(next);
    }
    return this.getStatus(orchestraId);
  }

  async start(id = '') {
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

  async selectedController() {
    const meta = await this.loadMeta();
    if (!meta.selectedId || !meta.byId[meta.selectedId]) throw new Error('Create or select an orchestra first.');
    return { id: meta.selectedId, item: meta.byId[meta.selectedId], controller: this.controllerFor(meta.selectedId) };
  }

  /**
   * Executable structural admission. Caller supplies intent only; owner policy
   * comes from manager metadata and topology comes from the selected orchestra's
   * durable runtime repository. Caller-supplied graph/depth/fanout authority is
   * rejected before any decision is evaluated.
   */
  async evaluateSelectedSubagentStructureAdmission(intent = {}) {
    const raw = plainIntent(intent, 'Subagent executable admission intent');
    const { item, controller } = await this.selectedController();
    const runtime = await controller.runtimeRepository.load();
    const graph = runtime?.hierarchy?.graph;
    if (!graph) throw new Error('Configure a durable orchestration hierarchy before subagent admission.');
    return evaluateSubagentStructureAdmissionV1({
      policy: item.subagentPolicy,
      initiator: raw.initiator,
      graph,
      parentNodeId: raw.parentNodeId,
      requestedChildren: raw.requestedChildren,
    });
  }

  async configureHierarchyTemplate(options = {}) {
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
    const status = await this.updateConfig({ ...imported, enabled: false }, selected.id);
    if (importedDocument.hierarchy) {
      const currentRuntime = await selected.controller.runtimeRepository.load();
      const currentGraphId = hierarchyGraphId(currentRuntime);
      const safety = await this.managedCoreSafety(status.config.projectId, currentGraphId);
      if (safety.managed.length) {
        throw new Error('Hierarchy profile can only be imported before the first Start. Create a new orchestra to replace an already-materialized hierarchy.');
      }
      await selected.controller.configureHierarchy(importedDocument.hierarchy, { nowMs: this.now() });
    }
    const importedPolicy = storedSubagentPolicy(importedDocument.subagentPolicy);
    await this.updateMeta(meta => {
      const record = meta.byId[selected.id];
      if (!record) throw new Error('Orchestra not found while persisting subagent policy.');
      record.subagentPolicy = importedPolicy;
      record.updatedAt = this.now();
      return meta;
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
