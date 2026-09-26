import { createSession, createTask, PromptMode, RunMode, RunState, TabStrategy, OperationPhase, isExclusiveConversationUrl } from './schema.js';
import {
  ScenarioWorkMode,
  ScenarioWorkRunState,
  ScenarioParticipantState,
  normalizeScenarioWorkConfig,
  createScenarioWorkRuntime,
  startScenarioWork,
  pauseScenarioWork,
  resumeScenarioWork,
  stopScenarioWork,
  planScenarioWorkActions,
  applyScenarioLaunch,
  applyScenarioCompletion,
  applyScenarioTimeout,
  scenarioWorkParticipants,
} from './scenario-work.js';

export const SCENARIO_WORK_STORAGE_KEY = 'autopilotScenarioWorkV1';
export const SCENARIO_WORK_ALARM = 'autopilot-scenario-work-wake';
const STORAGE_SCHEMA_VERSION = 1;
const MAX_PERSISTED_ARRAY_LENGTH = 10000;
const MAX_PERSISTED_OBJECT_KEYS = 10000;
const MAX_PERSISTED_GRAPH_NODES = 50000;
const MAX_PERSISTED_DEPTH = 64;
const SAFE_OPERATION_PHASES = new Set([OperationPhase.SENT_VERIFIED, OperationPhase.FAILED_SAFE]);

function clone(value) { return structuredClone(value); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function safeName(value, fallback = 'Сценарна робота') { return text(value).slice(0, 120) || fallback; }
function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function enumerableDataValue(record, key) {
  if (!plainRecord(record)) return { ok: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
    return { ok: false, value: undefined };
  }
  return { ok: true, value: descriptor.value };
}
function snapshotDenseDataArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return { ok: false, value: [] };
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor
    || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > MAX_PERSISTED_ARRAY_LENGTH
  ) return { ok: false, value: [] };
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(descriptors);
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  if (
    ownKeys.length !== expected.size
    || ownKeys.some(key => typeof key !== 'string' || !expected.has(key))
  ) return { ok: false, value: [] };
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      return { ok: false, value: [] };
    }
    out[index] = descriptor.value;
  }
  return { ok: true, value: out };
}

function snapshotPersistedData(value, ancestors = new Set(), memo = new Map(), budget = { nodes: 0 }, depth = 0) {
  if (value === null) return { ok: true, value: null };
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'undefined') {
    return { ok: true, value };
  }
  if (type !== 'object' || ancestors.has(value) || depth > MAX_PERSISTED_DEPTH) {
    return { ok: false, value: undefined };
  }
  if (memo.has(value)) return { ok: true, value: memo.get(value) };
  budget.nodes += 1;
  if (budget.nodes > MAX_PERSISTED_GRAPH_NODES) return { ok: false, value: undefined };

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return { ok: false, value: undefined };
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const lengthDescriptor = descriptors.length;
      if (
        !lengthDescriptor
        || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || lengthDescriptor.value > MAX_PERSISTED_ARRAY_LENGTH
      ) return { ok: false, value: undefined };
      const length = lengthDescriptor.value;
      const ownKeys = Reflect.ownKeys(descriptors);
      const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
      if (
        ownKeys.length !== expected.size
        || ownKeys.some(key => typeof key !== 'string' || !expected.has(key))
      ) return { ok: false, value: undefined };

      const out = new Array(length);
      memo.set(value, out);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
          return { ok: false, value: undefined };
        }
        const child = snapshotPersistedData(descriptor.value, ancestors, memo, budget, depth + 1);
        if (!child.ok) return { ok: false, value: undefined };
        out[index] = child.value;
      }
      return { ok: true, value: out };
    }

    if (!plainRecord(value)) return { ok: false, value: undefined };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > MAX_PERSISTED_OBJECT_KEYS) return { ok: false, value: undefined };
    const out = Object.create(null);
    memo.set(value, out);
    for (const key of keys) {
      if (typeof key !== 'string') return { ok: false, value: undefined };
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        return { ok: false, value: undefined };
      }
      const child = snapshotPersistedData(descriptor.value, ancestors, memo, budget, depth + 1);
      if (!child.ok) return { ok: false, value: undefined };
      Object.defineProperty(out, key, {
        value: child.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return { ok: true, value: out };
  } finally {
    ancestors.delete(value);
  }
}
function samePersistedData(actual, canonical, depth = 0) {
  if (Object.is(actual, canonical)) return true;
  if (depth > MAX_PERSISTED_DEPTH || typeof actual !== typeof canonical || actual === null || canonical === null) return false;
  if (Array.isArray(actual) || Array.isArray(canonical)) {
    if (!Array.isArray(actual) || !Array.isArray(canonical) || actual.length !== canonical.length) return false;
    for (let index = 0; index < actual.length; index += 1) {
      if (!samePersistedData(actual[index], canonical[index], depth + 1)) return false;
    }
    return true;
  }
  if (!plainRecord(actual) || !plainRecord(canonical)) return false;
  const actualKeys = Object.keys(actual);
  const canonicalKeys = Object.keys(canonical);
  if (actualKeys.length !== canonicalKeys.length) return false;
  for (const key of canonicalKeys) {
    if (!Object.hasOwn(actual, key) || !samePersistedData(actual[key], canonical[key], depth + 1)) return false;
  }
  return true;
}
function compatiblePersistedConfig(persisted, canonical) {
  if (samePersistedData(persisted, canonical)) return true;
  const legacyCanonical = clone(canonical);
  let migrated = false;
  for (const [key, defaultValue] of [
    ['schemaVersion', 1],
    ['timeoutPolicy', 'REPLACE_MEMBER'],
  ]) {
    if (!Object.hasOwn(persisted, key) && Object.is(legacyCanonical[key], defaultValue)) {
      delete legacyCanonical[key];
      migrated = true;
    }
  }
  return migrated && samePersistedData(persisted, legacyCanonical);
}
function freshStore() { return { schemaVersion: STORAGE_SCHEMA_VERSION, selectedId: '', order: [], byId: {} }; }
function poolSummary(store, poolId) {
  const members = store.order.map(id => store.byId[id]).filter(item => item?.pool?.id === poolId);
  const budget = members[0]?.pool?.replacementBudget || 0;
  return { id: poolId, slots: members.length, replacementBudget: budget,
    replacementsUsed: members.reduce((sum, item) => sum + Number(item.runtime.poolReplacementsUsed || 0), 0),
    active: members.filter(item => item.runtime.runState === ScenarioWorkRunState.RUNNING).length };
}
function initialPoolLaunchGate(store, item) {
  if (!item?.pool || item.config?.mode !== ScenarioWorkMode.CHAT_CYCLE
      || Number(item.runtime?.totalLaunches || 0) > 0) return 0;
  const seconds = Number(item.runtime?.initialStaggerSeconds || 0);
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 60) return 0;
  const latest = Object.values(store.byId || {}).reduce((at, sibling) =>
    sibling.pool?.id === item.pool.id
      ? Math.max(at, Number(sibling.runtime?.firstLaunchAt || 0)) : at, 0);
  return latest ? latest + seconds * 1000 : 0;
}
function verifiedSendProjection(item, coreState) {
  const runtime = item.runtime || {};
  const sessionId = runtime.chat?.sessionId;
  const session = sessionId ? coreState.sessionsById?.[sessionId] : null;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const activeVerified = count(session?.successfulSendCount);
  const retiredInGeneration = count(runtime.generationRetiredVerifiedSends);
  const retiredTotal = count(runtime.retiredVerifiedSends);
  return {
    confirmedInThisChat: activeVerified || retiredInGeneration,
    confirmedOverall: runtime.verifiedSendHistoryComplete === true ? retiredTotal + activeVerified : null,
  };
}
function managedSessionId(scenarioId, participantKey, ordinal) {
  const safe = `${scenarioId}:${participantKey}`.replace(/[^A-Za-z0-9._:-]+/gu, '-').slice(0, 120);
  return `scenario-work:${safe}:${ordinal}`;
}
function managedTaskId(sessionId) { return `${sessionId}:task`; }
function isSafeToRemoveSession(session) {
  if (!session?.operation) return true;
  return SAFE_OPERATION_PHASES.has(session.operation.phase);
}
function ensureManagerRuntimeFields(runtime) {
  const out = clone(runtime);
  out.ownerEpoch = Math.max(0, Number(out.ownerEpoch || 0));
  // A legacy store cannot reconstruct verified sends from already retired
  // timed-out chats. Keep that uncertainty visible to the read projection.
  out.verifiedSendHistoryComplete = out.verifiedSendHistoryComplete === true;
  out.retiredVerifiedSends = Math.max(0, Number(out.retiredVerifiedSends || 0));
  out.generationRetiredVerifiedSends = Math.max(0, Number(out.generationRetiredVerifiedSends || 0));
  out.nextLaunchAt = Math.max(0, Number(out.nextLaunchAt || 0));
  if (!Number.isFinite(out.nextLaunchAt)) out.nextLaunchAt = 0;
  out.initialStartAt = Number.isFinite(Number(out.initialStartAt))
    ? Math.max(0, Math.floor(Number(out.initialStartAt))) : 0;
  out.initialStaggerSeconds = Number.isInteger(Number(out.initialStaggerSeconds))
    ? Math.max(0, Math.min(60, Number(out.initialStaggerSeconds))) : 0;
  out.cleanupPendingSessionIds = [...new Set((Array.isArray(out.cleanupPendingSessionIds) ? out.cleanupPendingSessionIds : []).filter(value => typeof value === 'string' && value))];
  out.deletePending = out.deletePending === true;
  out.poolReplacementsUsed = Math.max(0, Math.floor(Number(out.poolReplacementsUsed || 0)));
  return out;
}
function scenarioDesiredCoreRunState(runtime) {
  if (runtime?.runState === ScenarioWorkRunState.RUNNING) return RunState.RUNNING;
  if (runtime?.runState === ScenarioWorkRunState.PAUSED) return RunState.PAUSED;
  return RunState.STOPPED;
}
function isTabAlreadyGoneError(error) {
  return /no tab with id|invalid tab id|tab not found/i.test(String(error?.message || error || ''));
}
function normalizeStore(raw, now = Date.now()) {
  if (!plainRecord(raw)) return freshStore();
  const schemaVersion = enumerableDataValue(raw, 'schemaVersion');
  const selectedId = enumerableDataValue(raw, 'selectedId');
  const order = enumerableDataValue(raw, 'order');
  const byId = enumerableDataValue(raw, 'byId');
  const orderSnapshot = order.ok
    ? snapshotDenseDataArray(order.value)
    : { ok: false, value: [] };
  if (
    !schemaVersion.ok || schemaVersion.value !== STORAGE_SCHEMA_VERSION
    || !selectedId.ok || typeof selectedId.value !== 'string'
    || !orderSnapshot.ok
    || !byId.ok || !plainRecord(byId.value)
  ) return freshStore();

  const out = freshStore();
  const recoveryBudget = { nodes: 0 };
  for (const id of orderSnapshot.value) {
    if (typeof id !== 'string' || Object.hasOwn(out.byId, id)) continue;
    const itemDescriptor = Object.getOwnPropertyDescriptor(byId.value, id);
    if (
      !itemDescriptor
      || itemDescriptor.enumerable !== true
      || !Object.hasOwn(itemDescriptor, 'value')
      || !plainRecord(itemDescriptor.value)
    ) continue;
    const itemSnapshot = snapshotPersistedData(itemDescriptor.value, new Set(), new Map(), recoveryBudget, 0);
    if (!itemSnapshot.ok) continue;
    try {
      const item = itemSnapshot.value;
      if (!plainRecord(item.config) || item.config.id !== id) continue;
      const config = normalizeScenarioWorkConfig(item.config);
      // Persistence recovery is not the interactive create/update boundary. A
      // malformed stored config must never gain executable defaults/coercions
      // after restart. Current-schema persisted bytes must already equal the
      // canonical config that this version itself writes.
      if (!compatiblePersistedConfig(item.config, config)) continue;
      const pool = plainRecord(item.pool) && typeof item.pool.id === 'string'
        && /^[A-Za-z0-9._:-]{1,120}$/u.test(item.pool.id)
        && Number.isInteger(item.pool.replacementBudget)
        && item.pool.replacementBudget >= 0 && item.pool.replacementBudget <= 100000
        ? { id: item.pool.id, replacementBudget: item.pool.replacementBudget } : null;
      // CHAT_CYCLE pools have one unambiguous contract: one physical chat runs
      // the configured prompt sequence exactly once. Replacement generations
      // are governed only by the shared pool replacement budget.
      if (pool && config.mode === ScenarioWorkMode.CHAT_CYCLE) {
        config.roundsPerGeneration = 1;
        config.maxGenerations = 0;
      }
      const runtime = ensureManagerRuntimeFields(item.runtime && item.runtime.mode === config.mode
        ? clone(item.runtime)
        : createScenarioWorkRuntime(config, now));
      Object.defineProperty(out.byId, id, {
        value: {
          id,
          name: safeName(item.name || config.name),
          config,
          runtime,
          pool,
          createdAt: Math.max(0, Number(item.createdAt || now)),
          updatedAt: Math.max(0, Number(item.updatedAt || now)),
        },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      out.order.push(id);
    } catch {
      // Corrupt individual scenarios are omitted rather than poisoning all others.
    }
  }
  out.selectedId = Object.hasOwn(out.byId, selectedId.value)
    ? selectedId.value
    : (out.order[0] || '');
  return out;
}

export class ScenarioWorkManager {
  constructor({ coreRepository, chromeApi, collectAssistantReport, now = () => Date.now(), createId = null } = {}) {
    if (!coreRepository || !chromeApi?.storage?.local) throw new Error('Scenario work manager dependencies are required');
    if (typeof collectAssistantReport !== 'function') throw new Error('Scenario work assistant report collector is required');
    this.coreRepository = coreRepository;
    this.chrome = chromeApi;
    this.collectAssistantReport = collectAssistantReport;
    this.now = now;
    this.createId = createId || (() => `scenario-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`);
    this.updateChain = Promise.resolve();
    this.cycleInFlight = null;
  }

  async load() {
    const result = await this.chrome.storage.local.get(SCENARIO_WORK_STORAGE_KEY);
    return normalizeStore(result?.[SCENARIO_WORK_STORAGE_KEY], this.now());
  }

  async save(store) {
    const normalized = normalizeStore(store, this.now());
    await this.chrome.storage.local.set({ [SCENARIO_WORK_STORAGE_KEY]: normalized });
    return normalized;
  }

  update(mutator) {
    const operation = this.updateChain.then(async () => {
      const store = await this.load();
      const next = await mutator(store) || store;
      return this.save(next);
    });
    this.updateChain = operation.catch(() => undefined);
    return operation;
  }

  async checkpointRuntime(id, runtime, expectedOwnerEpoch, now = this.now()) {
    let applied = false;
    let liveRuntime = null;
    await this.update(store => {
      const item = store.byId[id];
      if (!item) return store;
      if (Number(item.runtime.ownerEpoch || 0) !== Number(expectedOwnerEpoch)) {
        liveRuntime = clone(item.runtime);
        return store;
      }
      // A background cycle may never resurrect owner Pause/Stop. COMPLETED is
      // allowed only when the live owner state was still RUNNING at checkpoint.
      if (item.runtime.runState !== ScenarioWorkRunState.RUNNING) {
        liveRuntime = clone(item.runtime);
        return store;
      }
      const next = ensureManagerRuntimeFields(runtime);
      const replacingChat = item.pool && item.config.mode === ScenarioWorkMode.CHAT_CYCLE
        && item.runtime.chat?.state === ScenarioParticipantState.WAITING
        && next.chat?.state === ScenarioParticipantState.NEW
        && !next.chat?.sessionId;
      if (replacingChat) {
        const summary = poolSummary(store, item.pool.id);
        if (summary.replacementsUsed >= summary.replacementBudget) {
          next.runState = ScenarioWorkRunState.COMPLETED;
          next.phase = 'COMPLETE';
          next.generation = item.runtime.generation;
          next.chat.state = ScenarioParticipantState.RETIRED;
          next.chat.chatUrl = '';
        } else {
          next.poolReplacementsUsed = item.runtime.poolReplacementsUsed + 1;
        }
      }
      next.ownerEpoch = Number(expectedOwnerEpoch || 0);
      item.runtime = next;
      item.updatedAt = now;
      liveRuntime = clone(next);
      applied = true;
      return store;
    });
    return { applied, runtime: liveRuntime };
  }

  async syncManagedCoreRunState(scenarioId, runtime) {
    if (!scenarioId || !runtime) return;
    const desired = scenarioDesiredCoreRunState(runtime);
    const cleanupPending = new Set(runtime.cleanupPendingSessionIds || []);
    await this.coreRepository.update(state => {
      for (const session of Object.values(state.sessionsById || {})) {
        if (!session?.scenarioWork?.managed || session.scenarioWork.scenarioId !== scenarioId) continue;
        if (cleanupPending.has(session.id)) {
          session.enabled = false;
          session.runState = RunState.STOPPED;
          continue;
        }
        if (desired === RunState.RUNNING) {
          session.enabled = true;
          if ([RunState.PAUSED, RunState.STOPPED].includes(session.runState)) session.runState = RunState.RUNNING;
        } else if (desired === RunState.PAUSED) {
          if (session.runState === RunState.RUNNING) session.runState = RunState.PAUSED;
        } else {
          session.enabled = false;
          session.runState = RunState.STOPPED;
        }
      }
      return state;
    });
  }

  async addCleanupObligation(id, sessionId, expectedOwnerEpoch, runtimeOverride = null, now = this.now()) {
    if (!sessionId) return { applied: true, runtime: runtimeOverride };
    if (runtimeOverride) {
      const next = ensureManagerRuntimeFields(runtimeOverride);
      next.cleanupPendingSessionIds = [...new Set([...(next.cleanupPendingSessionIds || []), sessionId])];
      return this.checkpointRuntime(id, next, expectedOwnerEpoch, now);
    }
    let applied = false;
    let liveRuntime = null;
    await this.update(store => {
      const item = store.byId[id];
      if (!item || Number(item.runtime.ownerEpoch || 0) !== Number(expectedOwnerEpoch)) {
        liveRuntime = item ? clone(item.runtime) : null;
        return store;
      }
      item.runtime.cleanupPendingSessionIds = [...new Set([...(item.runtime.cleanupPendingSessionIds || []), sessionId])];
      item.updatedAt = now;
      liveRuntime = clone(item.runtime);
      applied = true;
      return store;
    });
    return { applied, runtime: liveRuntime };
  }

  async clearCleanupObligation(id, sessionId) {
    if (!sessionId) return;
    await this.update(store => {
      const item = store.byId[id];
      if (!item) return store;
      item.runtime.cleanupPendingSessionIds = (item.runtime.cleanupPendingSessionIds || []).filter(value => value !== sessionId);
      item.updatedAt = this.now();
      return store;
    });
  }

  async list() {
    const store = await this.load();
    const core = await this.coreRepository.load();
    return {
      selectedId: store.selectedId,
      pools: [...new Set(store.order.map(id => store.byId[id]?.pool?.id).filter(Boolean))].map(id => poolSummary(store, id)),
      scenarios: store.order.map(id => {
        const item = store.byId[id];
        return { id, name: item.name, config: clone(item.config), runtime: clone(item.runtime), pool: item.pool ? clone(item.pool) : null, selected: id === store.selectedId,
          verifiedSends: verifiedSendProjection(item, core) };
      }),
    };
  }

  async get(id = '') {
    const store = await this.load();
    const target = id || store.selectedId;
    const item = target ? store.byId[target] : null;
    if (!item) return { selectedId: target || '', scenario: null };
    const core = await this.coreRepository.load();
    return { selectedId: target || '', scenario: { ...clone(item), verifiedSends: verifiedSendProjection(item, core) } };
  }

  async create({ name = 'Сценарна робота', mode = ScenarioWorkMode.CHAT_CYCLE, config = {} } = {}) {
    const id = this.createId();
    const now = this.now();
    await this.update(store => {
      if (store.byId[id]) throw new Error('Сценарій з таким ідентифікатором уже існує.');
      const cycleContract = mode === ScenarioWorkMode.CHAT_CYCLE
        ? { roundsPerGeneration: 1, maxGenerations: 1 }
        : {};
      const normalizedConfig = normalizeScenarioWorkConfig({ ...config, ...cycleContract, id, name, mode });
      const runtime = ensureManagerRuntimeFields(createScenarioWorkRuntime(normalizedConfig, now));
      runtime.verifiedSendHistoryComplete = true;
      store.byId[id] = { id, name: safeName(name), config: normalizedConfig, runtime, createdAt: now, updatedAt: now };
      store.order.push(id);
      store.selectedId = id;
      return store;
    });
    await this.reconcileAlarm();
    return this.get(id);
  }

  async createChatPool({ name = 'Пул чатів', count, replacementBudget, staggerSeconds = 0, autoStart = false, config = {} } = {}) {
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('Кількість одночасних чатів: від 1 до 20.');
    if (!Number.isInteger(replacementBudget) || replacementBudget < 0 || replacementBudget > 100000) {
      throw new Error('Кількість нових чатів після початкових: від 0 до 100000.');
    }
    if (!Number.isInteger(staggerSeconds) || staggerSeconds < 0 || staggerSeconds > 60) {
      throw new Error('Пауза між початковими чатами: від 0 до 60 секунд.');
    }
    const poolId = this.createId();
    const ids = Array.from({ length: count }, () => this.createId());
    if (new Set([poolId, ...ids]).size !== count + 1) throw new Error('Повторний ідентифікатор пулу.');
    const now = this.now();
    await this.update(store => {
      if (ids.some(id => store.byId[id])) throw new Error('Пул містить зайнятий ідентифікатор.');
      for (const [index, id] of ids.entries()) {
        const slotName = `${safeName(name).slice(0, 100)} — чат ${index + 1}`;
        const normalized = normalizeScenarioWorkConfig({ ...config, id, name: slotName,
          mode: ScenarioWorkMode.CHAT_CYCLE, roundsPerGeneration: 1, maxGenerations: 0 });
        const runtime = ensureManagerRuntimeFields(createScenarioWorkRuntime(normalized, now));
        runtime.initialStartAt = now + index * staggerSeconds * 1000;
        runtime.initialStaggerSeconds = staggerSeconds;
        if (autoStart === true) runtime.runState = ScenarioWorkRunState.RUNNING;
        runtime.verifiedSendHistoryComplete = true;
        store.byId[id] = { id, name: slotName, config: normalized, runtime,
          pool: { id: poolId, replacementBudget }, createdAt: now, updatedAt: now };
        store.order.push(id);
      }
      store.selectedId = ids[0];
      return store;
    });
    await this.reconcileAlarm();
    if (autoStart === true) await this.cycleAll();
    return { pool: { id: poolId, slots: count, replacementBudget,
      replacementsUsed: 0, active: autoStart === true ? count : 0 }, ids };
  }

  async select(id) {
    await this.update(store => {
      if (!store.byId[id]) throw new Error('Сценарій не знайдено.');
      store.selectedId = id;
      return store;
    });
    return this.get(id);
  }

  async updateConfig(id, rawConfig) {
    const now = this.now();
    await this.update(store => {
      const item = store.byId[id];
      if (!item) throw new Error('Сценарій не знайдено.');
      if (item.pool) throw new Error('Налаштування створеного пулу не змінюються по одному чату. Створіть новий пул.');
      if ([ScenarioWorkRunState.RUNNING, ScenarioWorkRunState.PAUSED].includes(item.runtime.runState)) {
        throw new Error('Перед зміною налаштувань зупиніть сценарій.');
      }
      const config = normalizeScenarioWorkConfig({ ...rawConfig, id, name: rawConfig?.name || item.name });
      const modeChanged = item.config.mode !== config.mode;
      item.name = safeName(config.name, item.name);
      item.config = config;
      if (modeChanged) {
        item.runtime = ensureManagerRuntimeFields(createScenarioWorkRuntime(config, now));
        item.runtime.verifiedSendHistoryComplete = true;
      }
      item.updatedAt = now;
      return store;
    });
    return this.get(id);
  }

  async start(id) {
    const now = this.now();
    let runtime = null;
    await this.update(store => {
      const item = store.byId[id];
      if (!item) throw new Error('Сценарій не знайдено.');
      if (item.pool && item.runtime.runState === ScenarioWorkRunState.COMPLETED) {
        throw new Error('Ліміт чатів пулу вичерпано. Створіть новий пул.');
      }
      let next = item.runtime;
      if (next.runState === ScenarioWorkRunState.COMPLETED) {
        next = ensureManagerRuntimeFields(createScenarioWorkRuntime(item.config, now));
        next.verifiedSendHistoryComplete = true;
      }
      next = startScenarioWork(item.config, next, now);
      next.ownerEpoch = Math.max(0, Number(item.runtime.ownerEpoch || 0)) + 1;
      item.runtime = ensureManagerRuntimeFields(next);
      runtime = clone(item.runtime);
      item.updatedAt = now;
      return store;
    });
    await this.syncManagedCoreRunState(id, runtime);
    const result = await this.cycleOne(id);
    await this.reconcileAlarm();
    return { ...(await this.get(id)), cycle: result };
  }

  async pause(id) {
    const now = this.now();
    let runtime = null;
    await this.update(store => {
      const item = store.byId[id];
      if (!item) throw new Error('Сценарій не знайдено.');
      const next = pauseScenarioWork(item.runtime, now);
      next.ownerEpoch = Math.max(0, Number(item.runtime.ownerEpoch || 0)) + 1;
      item.runtime = ensureManagerRuntimeFields(next);
      runtime = clone(item.runtime);
      item.updatedAt = now;
      return store;
    });
    await this.syncManagedCoreRunState(id, runtime);
    await this.reconcileAlarm();
    return this.get(id);
  }

  async resume(id) {
    const now = this.now();
    let runtime = null;
    await this.update(store => {
      const item = store.byId[id];
      if (!item) throw new Error('Сценарій не знайдено.');
      const next = resumeScenarioWork(item.runtime, now);
      next.ownerEpoch = Math.max(0, Number(item.runtime.ownerEpoch || 0)) + 1;
      item.runtime = ensureManagerRuntimeFields(next);
      runtime = clone(item.runtime);
      item.updatedAt = now;
      return store;
    });
    await this.syncManagedCoreRunState(id, runtime);
    const result = await this.cycleOne(id);
    await this.reconcileAlarm();
    return { ...(await this.get(id)), cycle: result };
  }

  async stop(id) {
    const now = this.now();
    let runtime = null;
    await this.update(store => {
      const item = store.byId[id];
      if (!item) throw new Error('Сценарій не знайдено.');
      const next = stopScenarioWork(item.runtime, now);
      next.ownerEpoch = Math.max(0, Number(item.runtime.ownerEpoch || 0)) + 1;
      item.runtime = ensureManagerRuntimeFields(next);
      runtime = clone(item.runtime);
      item.updatedAt = now;
      return store;
    });
    await this.syncManagedCoreRunState(id, runtime);
    await this.reconcileAlarm();
    return this.get(id);
  }

  async delete(id, { allowPoolDelete = false } = {}) {
    const target = await this.get(id);
    if (!target.scenario) return {};
    if (target.scenario.pool && !allowPoolDelete) throw new Error('Чат належить пулу. Видаляйте весь пул після зупинки.');
    if (target.scenario.runtime.runState === ScenarioWorkRunState.RUNNING) throw new Error('Спочатку зупиніть сценарій.');
    const sessionIds = [...new Set([
      ...scenarioWorkParticipants(target.scenario.runtime).map(item => item.sessionId).filter(Boolean),
      ...(target.scenario.runtime.cleanupPendingSessionIds || []),
    ])];
    let runtime = null;
    await this.update(store => {
      const item = store.byId[id];
      if (!item) return store;
      item.runtime.ownerEpoch = Math.max(0, Number(item.runtime.ownerEpoch || 0)) + 1;
      item.runtime.deletePending = true;
      item.runtime.cleanupPendingSessionIds = [...new Set([...(item.runtime.cleanupPendingSessionIds || []), ...sessionIds])];
      item.runtime.runState = ScenarioWorkRunState.STOPPED;
      item.runtime.updatedAt = this.now();
      runtime = clone(item.runtime);
      return store;
    });
    await this.syncManagedCoreRunState(id, runtime);
    const cleanup = await this.drainCleanupPending(id, { forceSafe: true });
    if (cleanup.pending.length) {
      await this.reconcileAlarm();
      return this.get(id);
    }
    await this.finalizeDelete(id);
    await this.reconcileAlarm();
    return {};
  }

  async deleteChatPool(poolId) {
    const store = await this.load();
    const ids = store.order.filter(id => store.byId[id]?.pool?.id === poolId);
    if (!ids.length) throw new Error('Пул не знайдено.');
    if (ids.some(id => [ScenarioWorkRunState.RUNNING, ScenarioWorkRunState.WAITING_SCHEDULE]
      .includes(store.byId[id].runtime.runState))) throw new Error('Спочатку зупиніть усі чати пулу.');
    for (const id of ids) await this.delete(id, { allowPoolDelete: true });
    return { id: poolId, removed: ids.length };
  }

  async finalizeDelete(id) {
    await this.update(store => {
      const item = store.byId[id];
      if (!item || (item.runtime.cleanupPendingSessionIds || []).length) return store;
      delete store.byId[id];
      store.order = store.order.filter(value => value !== id);
      if (store.selectedId === id) store.selectedId = store.order[0] || '';
      return store;
    });
  }

  async cleanupManagedSession(sessionId, { forceSafe = false } = {}) {
    if (!sessionId) return { removed: false, pending: false, reason: 'EMPTY' };
    const before = await this.coreRepository.load();
    const session = before.sessionsById?.[sessionId];
    if (!session?.scenarioWork?.managed) return { removed: true, pending: false, reason: 'ALREADY_GONE' };

    const ownedHints = Object.entries(before.tabHintsByTaskId || {})
      .filter(([, hint]) => hint?.sessionId === sessionId && Number.isInteger(hint?.tabId) && hint?.ownedByExtension === true)
      .map(([key, hint]) => ({ key, tabId: hint.tabId }));

    for (const target of ownedHints) {
      let gone = false;
      if (!this.chrome.tabs?.remove) {
        await this.coreRepository.update(state => {
          const hint = state.tabHintsByTaskId?.[target.key];
          if (hint?.sessionId === sessionId && hint?.tabId === target.tabId) hint.retirePending = true;
          const live = state.sessionsById?.[sessionId];
          if (live) { live.enabled = false; live.runState = RunState.STOPPED; }
          return state;
        });
        return { removed: false, pending: true, reason: 'TAB_API_UNAVAILABLE' };
      }
      try {
        await this.chrome.tabs.remove(target.tabId);
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
      if (!gone) {
        await this.coreRepository.update(state => {
          const hint = state.tabHintsByTaskId?.[target.key];
          if (hint?.sessionId === sessionId && hint?.tabId === target.tabId) {
            hint.ownedByExtension = true;
            hint.retirePending = true;
          }
          const live = state.sessionsById?.[sessionId];
          if (live) { live.enabled = false; live.runState = RunState.STOPPED; }
          return state;
        });
        return { removed: false, pending: true, reason: 'TAB_RETIRE_PENDING' };
      }
    }

    let removed = false;
    let unresolved = false;
    await this.coreRepository.update(state => {
      const live = state.sessionsById?.[sessionId];
      if (!live?.scenarioWork?.managed) { removed = true; return state; }
      if (!isSafeToRemoveSession(live)) {
        unresolved = true;
        live.runState = RunState.STOPPED;
        live.enabled = false;
        return state;
      }
      delete state.sessionsById[sessionId];
      state.sessionOrder = (state.sessionOrder || []).filter(id => id !== sessionId);
      delete state.logs?.[sessionId];
      for (const [key, hint] of Object.entries(state.tabHintsByTaskId || {})) {
        if (hint?.sessionId === sessionId) delete state.tabHintsByTaskId[key];
      }
      removed = true;
      return state;
    });
    return { removed, pending: !removed, reason: unresolved ? 'UNRESOLVED_OPERATION' : (removed ? 'REMOVED' : 'PENDING') };
  }

  async cleanupAllManagedSessions(scenario, options = {}) {
    const ids = new Set([
      ...scenarioWorkParticipants(scenario.runtime).map(item => item.sessionId).filter(Boolean),
      ...(scenario.runtime.cleanupPendingSessionIds || []),
    ]);
    const pending = [];
    for (const sessionId of ids) {
      const result = await this.cleanupManagedSession(sessionId, options);
      if (!result.removed) pending.push(sessionId);
    }
    return { pending };
  }

  // A completed generation can start its replacement while a failed tab
  // close is retried, provided the retired Core Session is durably stopped.
  async retiredCleanupCanRunInBackground(scenario) {
    if (scenario?.config?.mode !== ScenarioWorkMode.CHAT_CYCLE
        || scenario.runtime.runState !== ScenarioWorkRunState.RUNNING) return false;
    const pending = scenario.runtime.cleanupPendingSessionIds || [];
    if (!pending.length) return false;
    const core = await this.coreRepository.load();
    return pending.every(id => {
      const session = core.sessionsById?.[id];
      return !session || (session.scenarioWork?.managed === true
        && session.scenarioWork.scenarioId === scenario.id
        && Number(session.scenarioWork.generation) < scenario.runtime.generation
        && session.enabled === false && session.runState === RunState.STOPPED
        && isSafeToRemoveSession(session));
    });
  }

  async drainCleanupPending(id, { forceSafe = false } = {}) {
    const current = await this.get(id);
    if (!current.scenario) return { pending: [], removed: [] };
    const ids = [...new Set(current.scenario.runtime.cleanupPendingSessionIds || [])];
    const removed = [];
    const pending = [];
    for (const sessionId of ids) {
      const result = await this.cleanupManagedSession(sessionId, { forceSafe });
      if (result.removed) removed.push(sessionId); else pending.push(sessionId);
    }
    if (removed.length) {
      await this.update(store => {
        const item = store.byId[id];
        if (!item) return store;
        item.runtime.cleanupPendingSessionIds = (item.runtime.cleanupPendingSessionIds || []).filter(value => !removed.includes(value));
        item.updatedAt = this.now();
        return store;
      });
    }
    return { pending, removed };
  }

  async materializeLaunch(scenario, action, now) {
    const ordinal = scenario.runtime.totalLaunches + 1;
    // A CHAT_CYCLE generation owns one durable Core Session and one Task/tab
    // identity. Other scenario modes retain their existing per-turn lifecycle.
    const persistentChat = scenario.config.mode === ScenarioWorkMode.CHAT_CYCLE;
    const sessionId = managedSessionId(scenario.id, action.participantKey,
      persistentChat ? `generation-${action.generation}` : ordinal);
    const taskId = managedTaskId(sessionId);
    const task = createTask({ id: taskId, url: action.url, promptOverride: action.prompt, enabled: true, label: `${scenario.name}: ${action.participantKey}` });
    const session = createSession({
      id: sessionId,
      name: `${scenario.name} — ${action.participantKey}`,
      tasks: [task],
      promptMode: PromptMode.UNIQUE,
      sharedPrompt: '',
      runMode: RunMode.ONE_PASS,
      minimumSendIntervalMs: 0,
      preSendDelayMs: scenario.config.preSendDelaySeconds * 1000,
      busyCheckDelayMs: scenario.config.busyCheckDelaySeconds * 1000,
      retryBackoffMs: scenario.config.retryBackoffSeconds * 1000,
      tabStrategy: TabStrategy.KEEP_TASK_TABS_OPEN,
      now,
    });
    session.runState = RunState.RUNNING;
    session.scenarioWork = {
      managed: true,
      scenarioId: scenario.id,
      participantKey: action.participantKey,
      generation: action.generation,
      stage: action.stage,
    };
    await this.coreRepository.update(state => {
      const existing = state.sessionsById[sessionId];
      if (existing) {
        const existingTask = existing.tasksById?.[taskId];
        const sameGeneration = existing?.scenarioWork?.managed === true
          && existing.scenarioWork.scenarioId === scenario.id
          && existing.scenarioWork.participantKey === action.participantKey
          && Number(existing.scenarioWork.generation) === Number(action.generation);
        const sameTurn = sameGeneration && existing.scenarioWork.stage === action.stage
          && existingTask?.normalizedUrl === task.normalizedUrl
          && existingTask?.promptOverride === task.promptOverride;
        if (!sameTurn && !(persistentChat && sameGeneration && existingTask
            && scenario.runtime.chat?.state === ScenarioParticipantState.READY
            && isExclusiveConversationUrl(action.url)
            && existingTask.lastConversationUrl === task.normalizedUrl
            && existingTask.lastVerifiedSendAt > 0
            && existing.successfulSendCount > 0
            && existing.onePassCompletedCount === 1
            && isSafeToRemoveSession(existing))) {
          throw new Error(`SCENARIO_MANAGED_SESSION_IDENTITY_COLLISION:${sessionId}`);
        }
        if (!sameTurn) {
          // The previous assistant turn was checkpointed before this mutation.
          // Clear its send evidence so a restart cannot observe the old answer
          // as the completion of the newly armed prompt. Retain cumulative
          // successfulSendCount and the exact Task/tab identity.
          existingTask.url = task.normalizedUrl;
          existingTask.normalizedUrl = task.normalizedUrl;
          existingTask.promptOverride = task.promptOverride;
          existingTask.status = 'IDLE';
          existingTask.lastVerifiedSendAt = 0;
          existingTask.lastVerifiedFingerprint = '';
          existingTask.lastAssistantBaselineCount = 0;
          existingTask.lastAssistantBaselineKnown = false;
          existingTask.lastAssistantReport = '';
          existingTask.lastAssistantReportAt = 0;
          existingTask.retryAfterAt = 0;
          existing.onePassCompletedTaskIds = [];
          existing.onePassCompletedCount = 0;
          existing.completedAt = 0;
          existing.operation = null;
          existing.scenarioWork.stage = action.stage;
          const hint = state.tabHintsByTaskId?.[taskId];
          if (hint?.sessionId === sessionId && hint.ownedByExtension === true) {
            hint.normalizedUrl = task.normalizedUrl;
          }
        }
        // Deterministic replay after service-worker crash: same identity is the
        // same launch, not a new Send. Re-enable only while owner still RUNNING.
        existing.enabled = true;
        if (sameTurn && existing.successfulSendCount > 0 && existingTask.lastVerifiedSendAt > 0
            && existing.onePassCompletedCount === 1) {
          // A replayed launch already produced a verified effect. The manager
          // must observe its response, never re-arm or send it a second time.
          return state;
        }
        if ([RunState.PAUSED, RunState.STOPPED, RunState.COMPLETED].includes(existing.runState)) existing.runState = RunState.RUNNING;
        return state;
      }
      state.sessionsById[sessionId] = session;
      if (!state.sessionOrder.includes(sessionId)) state.sessionOrder.push(sessionId);
      return state;
    });
    return { sessionId, taskId };
  }

  async observeCompletedTurns(scenario, now, expectedOwnerEpoch) {
    let runtime = ensureManagerRuntimeFields(scenario.runtime);
    const core = await this.coreRepository.load();
    for (const participant of scenarioWorkParticipants(runtime)) {
      if (participant.state !== ScenarioParticipantState.WAITING || !participant.sessionId) continue;
      const session = core.sessionsById?.[participant.sessionId];
      const participantTaskId = participant.taskIdCore || participant.taskId;
      const task = session?.tasksById?.[participantTaskId];
      if (!session || !task || !task.lastVerifiedSendAt || !task.lastConversationUrl) continue;
      let report;
      try {
        report = await this.collectAssistantReport({
          id: `scenario-work:${scenario.id}:${participant.key}`,
          taskId: participantTaskId,
          conversationUrl: task.lastConversationUrl,
          assistantBaselineCount: Number(task.lastAssistantBaselineCount || 0),
          assistantBaselineKnown: task.lastAssistantBaselineKnown === true,
        });
      } catch {
        continue;
      }
      if (report?.status !== 'READY' || report.assistantComplete !== true) continue;
      const completedSessionId = participant.sessionId;
      const completedGeneration = participant.generation;
      let next = applyScenarioCompletion(scenario.config, runtime, participant.key, {
        chatUrl: task.lastConversationUrl,
        assistantText: report.assistantText || report.text || '',
        now,
      });
      next = ensureManagerRuntimeFields(next);
      const preserveChat = scenario.config.mode === ScenarioWorkMode.CHAT_CYCLE
        && next.runState === ScenarioWorkRunState.RUNNING
        && next.generation === completedGeneration;
      if (!preserveChat) {
        const confirmed = Math.max(0, Number(session.successfulSendCount || 0));
        next.retiredVerifiedSends += confirmed;
        next.generationRetiredVerifiedSends = next.generation === completedGeneration
          ? next.generationRetiredVerifiedSends + confirmed : 0;
        next.cleanupPendingSessionIds = [...new Set([...(next.cleanupPendingSessionIds || []), completedSessionId])];
      }
      const checkpoint = await this.checkpointRuntime(scenario.id, next, expectedOwnerEpoch, now);
      if (!checkpoint.applied) return { runtime: checkpoint.runtime || runtime, ownerChanged: true };
      runtime = checkpoint.runtime;
      if (preserveChat) continue;
      const cleanup = await this.cleanupManagedSession(completedSessionId);
      if (cleanup.removed) {
        await this.clearCleanupObligation(scenario.id, completedSessionId);
        runtime.cleanupPendingSessionIds = (runtime.cleanupPendingSessionIds || []).filter(value => value !== completedSessionId);
      }
    }
    return { runtime, ownerChanged: false };
  }

  async cycleOne(id) {
    const now = this.now();
    let current = await this.get(id);
    if (!current.scenario) return { kind: 'NOT_FOUND' };
    if (current.scenario.runtime.runState !== ScenarioWorkRunState.RUNNING) return { kind: 'IDLE' };
    const expectedOwnerEpoch = Math.max(0, Number(current.scenario.runtime.ownerEpoch || 0));

    const cleanupBefore = await this.drainCleanupPending(id);
    if (cleanupBefore.pending.length && !(await this.retiredCleanupCanRunInBackground(current.scenario))) {
      await this.reconcileAlarm();
      return { kind: 'CLEANUP_PENDING', pending: cleanupBefore.pending };
    }
    // drainCleanupPending mutates durable runtime; never plan from the stale
    // pre-drain snapshot or a cleared obligation can block one extra cycle.
    current = await this.get(id);
    if (!current.scenario || current.scenario.runtime.runState !== ScenarioWorkRunState.RUNNING
        || Number(current.scenario.runtime.ownerEpoch || 0) !== expectedOwnerEpoch) {
      if (current.scenario) await this.syncManagedCoreRunState(id, current.scenario.runtime);
      return { kind: 'CANCELLED_BY_OWNER' };
    }

    const observed = await this.observeCompletedTurns(current.scenario, now, expectedOwnerEpoch);
    if (observed.ownerChanged) {
      const live = await this.get(id);
      if (live.scenario) await this.syncManagedCoreRunState(id, live.scenario.runtime);
      return { kind: 'CANCELLED_BY_OWNER' };
    }
    let runtime = ensureManagerRuntimeFields(observed.runtime);
    let scenario = { ...current.scenario, runtime };
    if (runtime.runState !== ScenarioWorkRunState.RUNNING) {
      await this.reconcileAlarm();
      return { kind: runtime.runState === ScenarioWorkRunState.COMPLETED ? 'COMPLETED' : 'IDLE', launched: [], runtime: clone(runtime) };
    }
    if ((runtime.cleanupPendingSessionIds || []).length
        && !(await this.retiredCleanupCanRunInBackground(scenario))) {
      await this.reconcileAlarm();
      return { kind: 'CLEANUP_PENDING', pending: [...runtime.cleanupPendingSessionIds], runtime: clone(runtime) };
    }

    const poolStartGate = initialPoolLaunchGate(await this.load(), scenario);
    if (poolStartGate > now) {
      await this.reconcileAlarm();
      return { kind: 'INITIAL_START_PENDING', nextAt: poolStartGate, runtime: clone(runtime) };
    }
    let planned = planScenarioWorkActions(scenario.config, runtime, now);
    runtime = ensureManagerRuntimeFields(planned.runtime);
    scenario = { ...scenario, runtime };

    // Timeout semantic transition is checkpointed BEFORE old managed Session
    // cleanup. The durable cleanup obligation blocks replacement launch until
    // physical/core retirement is proven.
    for (const action of planned.actions.filter(item => item.type === 'TIMEOUT')) {
      const participant = scenarioWorkParticipants(runtime).find(item => item.key === action.participantKey);
      const staleSessionId = participant?.sessionId || '';
      let next = ensureManagerRuntimeFields(applyScenarioTimeout(scenario.config, runtime, action.participantKey, { now }));
      if (staleSessionId) {
        const staleSession = (await this.coreRepository.load()).sessionsById?.[staleSessionId];
        const confirmed = Math.max(0, Number(staleSession?.successfulSendCount || 0));
        next.retiredVerifiedSends += confirmed;
        next.generationRetiredVerifiedSends += confirmed;
        next.cleanupPendingSessionIds = [...new Set([...(next.cleanupPendingSessionIds || []), staleSessionId])];
      }
      const checkpoint = await this.checkpointRuntime(id, next, expectedOwnerEpoch, now);
      if (!checkpoint.applied) {
        const live = await this.get(id);
        if (live.scenario) await this.syncManagedCoreRunState(id, live.scenario.runtime);
        return { kind: 'CANCELLED_BY_OWNER' };
      }
      runtime = checkpoint.runtime;
      scenario = { ...scenario, runtime };
      if (staleSessionId) {
        const cleanup = await this.cleanupManagedSession(staleSessionId, { forceSafe: true });
        if (cleanup.removed) {
          await this.clearCleanupObligation(id, staleSessionId);
          runtime.cleanupPendingSessionIds = (runtime.cleanupPendingSessionIds || []).filter(value => value !== staleSessionId);
        } else {
          await this.reconcileAlarm();
          return { kind: 'CLEANUP_PENDING', pending: [staleSessionId], runtime: clone(runtime) };
        }
      }
    }
    if (planned.actions.some(item => item.type === 'TIMEOUT')) {
      scenario = { ...scenario, runtime };
      planned = planScenarioWorkActions(scenario.config, runtime, now);
      runtime = ensureManagerRuntimeFields(planned.runtime);
      scenario = { ...scenario, runtime };
    }

    const launched = [];
    for (const action of planned.actions.filter(item => item.type === 'LAUNCH')) {
      const authority = await this.get(id);
      if (!authority.scenario
          || authority.scenario.runtime.runState !== ScenarioWorkRunState.RUNNING
          || Number(authority.scenario.runtime.ownerEpoch || 0) !== expectedOwnerEpoch) {
        if (authority.scenario) await this.syncManagedCoreRunState(id, authority.scenario.runtime);
        return { kind: 'CANCELLED_BY_OWNER', launched };
      }
      const ids = await this.materializeLaunch(scenario, action, now);
      const next = ensureManagerRuntimeFields(applyScenarioLaunch(runtime, action, { ...ids, now }));
      const checkpoint = await this.checkpointRuntime(id, next, expectedOwnerEpoch, now);
      if (!checkpoint.applied) {
        const live = await this.get(id);
        if (live.scenario) await this.syncManagedCoreRunState(id, live.scenario.runtime);
        return { kind: 'CANCELLED_BY_OWNER', launched };
      }
      runtime = checkpoint.runtime;
      launched.push({ participantKey: action.participantKey, ...ids, stage: action.stage });
      scenario = { ...scenario, runtime };
      if (scenario.config.minimumLaunchGapSeconds > 0) break;
    }

    // Persist planning-only transitions with the same owner-epoch guard. Launch
    // checkpoints above already wrote their post-launch runtime.
    if (!launched.length) {
      const checkpoint = await this.checkpointRuntime(id, runtime, expectedOwnerEpoch, now);
      if (!checkpoint.applied) {
        const live = await this.get(id);
        if (live.scenario) await this.syncManagedCoreRunState(id, live.scenario.runtime);
        return { kind: 'CANCELLED_BY_OWNER' };
      }
      runtime = checkpoint.runtime;
    }
    await this.reconcileAlarm();
    return { kind: 'CYCLED', launched, runtime: clone(runtime) };
  }

  cycleAll() {
    if (this.cycleInFlight) return this.cycleInFlight;
    const cycle = (async () => {
      const store = await this.load();
      const results = [];
      for (const id of store.order) {
        let live = await this.get(id);
        if (!live.scenario) continue;
        if ((live.scenario.runtime.cleanupPendingSessionIds || []).length) {
          const cleanup = await this.drainCleanupPending(id, { forceSafe: live.scenario.runtime.deletePending === true });
          results.push({ id, cleanup });
          live = await this.get(id);
          if (!live.scenario) continue;
          if (live.scenario.runtime.deletePending && !cleanup.pending.length) {
            await this.finalizeDelete(id);
            continue;
          }
          if (cleanup.pending.length && !(await this.retiredCleanupCanRunInBackground(live.scenario))) continue;
        }
        if (live.scenario.runtime.runState !== ScenarioWorkRunState.RUNNING) continue;
        results.push({ id, result: await this.cycleOne(id) });
      }
      await this.reconcileAlarm();
      return { kind: results.length ? 'CYCLED' : 'IDLE', results };
    })();
    this.cycleInFlight = cycle.finally(() => { this.cycleInFlight = null; });
    return this.cycleInFlight;
  }

  async syncAfterCoreCycle() {
    return this.cycleAll();
  }

  async nextWakeAt() {
    const store = await this.load();
    const now = this.now();
    let next = Infinity;
    for (const id of store.order) {
      const item = store.byId[id];
      if ((item.runtime.cleanupPendingSessionIds || []).length) {
        next = Math.min(next, now + Math.min(5_000, item.config.pollSeconds * 1000));
      }
      if (item.runtime.runState !== ScenarioWorkRunState.RUNNING) continue;
      const participants = scenarioWorkParticipants(item.runtime);
      const waiting = participants.filter(participant => participant.state === ScenarioParticipantState.WAITING);
      for (const participant of waiting) {
        if (participant.deadlineAt > now) next = Math.min(next, participant.deadlineAt);
      }

      const launchSpacingAt = item.config.minimumLaunchGapSeconds > 0 && item.runtime.lastLaunchAt
        ? item.runtime.lastLaunchAt + item.config.minimumLaunchGapSeconds * 1000
        : 0;
      const completionSpacingAt = item.config.minimumLaunchGapSeconds > 0
        ? Number(item.runtime.nextLaunchAt || 0)
        : 0;
      const initialStartAt = item.config.mode === ScenarioWorkMode.CHAT_CYCLE
        && !item.runtime.totalLaunches ? Number(item.runtime.initialStartAt || 0) : 0;
      const launchGateAt = Math.max(launchSpacingAt, completionSpacingAt,
        initialStartAt, initialPoolLaunchGate(store, item));

      if (waiting.length) {
        // Assistant completion is observed by polling; keep the existing
        // bounded poll while a physical chat is actually in flight.
        next = Math.min(next, now + item.config.pollSeconds * 1000);
      } else if (launchGateAt > now) {
        // Once the assistant really completed, do not wake every poll interval
        // merely to rediscover the same completion-relative delay.
        next = Math.min(next, launchGateAt);
      } else {
        next = Math.min(next, now + item.config.pollSeconds * 1000);
      }
    }
    return next < Infinity ? Math.max(now + 250, next) : 0;
  }

  async reconcileAlarm() {
    const wakeAt = await this.nextWakeAt();
    if (!wakeAt) {
      try { await this.chrome.alarms.clear(SCENARIO_WORK_ALARM); } catch (_) {}
      return 0;
    }
    await this.chrome.alarms.create(SCENARIO_WORK_ALARM, { when: wakeAt });
    return wakeAt;
  }

  isAlarm(name) { return name === SCENARIO_WORK_ALARM; }
}
