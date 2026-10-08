/**
 * Plan 6 / Section 1. Read-only, redacted view over the existing durable
 * BrowserAgentManager job snapshot. No new log, scheduler or effect authority.
 * A timeline is evidence of recorded state, never a replay instruction.
 */
export const AGENT_RUN_TIMELINE_VERSION = 1;
export const MAX_AGENT_TIMELINE_ENTRIES = 200;
const MAX_HISTORY_SCAN = 2048;
const MAX_HISTORY_LENGTH = 100000;
const EVENT_LABELS = Object.freeze({
  action: ['ACTION', 'Дію зареєстровано.'],
  'trusted-script-executed': ['ACTION', 'Виконання Trusted Script зареєстровано.'],
  'effect-not-observed': ['RECOVERY', 'Наслідок дії не підтверджено.'],
  'native-fallback': ['RECOVERY', 'Застосовано резервний спосіб взаємодії.'],
  'approval-requested': ['OWNER', 'Підтвердження власника запитано.'],
  'approval-approved': ['OWNER', 'Власник підтвердив дію.'],
  'approval-rejected': ['OWNER', 'Власник відхилив дію.'],
  'approval-stale': ['OWNER', 'Підтвердження втратило актуальність.'],
  'approval-superseded': ['OWNER', 'Підтвердження було замінено.'],
  owner: ['OWNER', 'Дію власника зареєстровано.'],
  'owner-instruction': ['OWNER', 'Уточнення власника зареєстровано.'],
  plan: ['PLAN', 'Зміну плану зареєстровано.'],
  'plan-node-running': ['PLAN', 'Вузол плану розпочав виконання.'],
  'plan-node-verified': ['PLAN', 'Перевірку вузла плану зареєстровано.'],
  'specialist-handoff-auto-prepared': ['PLAN', 'Автоматичну передачу Specialist підготовлено.'],
  'specialist-handoff-admitted': ['PLAN', 'Передачу Specialist допущено до виконання.'],
  'specialist-handoff-prepared': ['PLAN', 'Підготовлено передачу Specialist.'],
  'specialist-handoff-claimed': ['PLAN', 'Передачу Specialist прийнято.'],
  'specialist-handoff-completed': ['PLAN', 'Передача Specialist завершила виконання.'],
  'specialist-handoff-verified': ['PLAN', 'Результат Specialist перевірено.'],
  'specialist-handoff-reconcile': ['RECOVERY', 'Передачу Specialist звірено після переривання.'],
  'specialist-handoff-safe-retry-authorized': ['RECOVERY', 'Незалежна перевірка дозволила повторний допуск Specialist без автоматичного повтору дії.'],
  'specialist-automation-blocked': ['RECOVERY', 'Автоматичне продовження Specialist заблоковано.'],
  'specialist-automation-retry-wait': ['RECOVERY', 'Specialist очікує дозволеного моменту повторної спроби.'],
  'specialist-provider-failed': ['RECOVERY', 'Помилку Specialist provider зареєстровано.'],
  'specialist-provider-succeeded': ['PLAN', 'Результат Specialist provider зареєстровано.'],
  'specialist-required': ['PLAN', 'Потрібен Specialist.'],
  'page-watch-started': ['RECOVERY', 'Почато спостереження сторінки.'],
  'page-watch-ended': ['RECOVERY', 'Спостереження сторінки завершено.'],
  'page-watch-timeout': ['RECOVERY', 'Час спостереження сторінки вичерпано.'],
  'page-change-detected': ['RECOVERY', 'Спостереження виявило зміну сторінки.'],
  'page-watch-interrupted': ['RECOVERY', 'Спостереження сторінки перервано.'],
  'vision-requested': ['ACTION', 'Запитано візуальне спостереження.'],
  'vision-stale': ['RECOVERY', 'Застаріле візуальне спостереження відхилено.'],
  'vision-error': ['RECOVERY', 'Помилку візуального спостереження зареєстровано.'],
  'download-started': ['ACTION', 'Завантаження почалося.'],
  'download-complete': ['ACTION', 'Завантаження завершилося.'],
  'download-ended': ['ACTION', 'Завантаження закінчилося.'],
  'download-wait-interrupted': ['RECOVERY', 'Очікування завантаження перервано.'],
  'tab-retire-pending': ['RECOVERY', 'Закриття вкладки очікує звірки.'],
  tab: ['ACTION', 'Подію вкладки зареєстровано.'],
  permission: ['OWNER', 'Запит дозволу зареєстровано.'],
  capability: ['OWNER', 'Запит можливості зареєстровано.'],
  'model-budget-reserved': ['RECOVERY', 'Ресурс моделі зарезервовано до виклику провайдера.'],
  'model-budget-settled': ['RECOVERY', 'Резерв моделі звірено після виклику провайдера.'],
  'model-budget-conservative-settlement': ['RECOVERY', 'Невизначений виклик моделі консервативно враховано.'],
  'model-budget-recovered-after-restart': ['RECOVERY', 'Незакритий резерв моделі збережено після перезапуску.'],
  budget: ['RECOVERY', 'Ліміт ресурсів досягнуто.'],
  error: ['RECOVERY', 'Помилку виконання зареєстровано.'],
  schedule: ['RECOVERY', 'Подію розкладу зареєстровано.'],
  'cycle-done': ['CHECKPOINT', 'Цикл виконання завершено.'],
  done: ['CHECKPOINT', 'Завдання завершено.'],
});
const FILTERS = new Set(['ALL', 'ACTION', 'OWNER', 'PLAN', 'RECOVERY', 'CHECKPOINT']);
const PLAN_STATES = new Set(['PENDING', 'READY', 'RUNNING', 'VERIFIED', 'FAILED', 'BLOCKED', 'SKIPPED', 'CANCELLED', 'COMPLETED']);
const ACTION_TYPES = new Set(['click', 'type', 'navigate', 'scroll', 'wait', 'new_tab', 'close_tab', 'download', 'trusted_script', 'click_at', 'type_at', 'drag_at', 'batch']);
const ACTION_DETAIL_EVENTS = new Set(['action', 'trusted-script-executed', 'effect-not-observed', 'approval-requested', 'approval-approved', 'approval-stale']);

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + ' must be a plain record');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(name + ' must be a plain record');
  return value;
}
function own(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw new Error('Agent timeline refuses accessor-backed ' + String(key));
  return descriptor.value;
}
function integer(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : 0;
}
function safeTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : 0;
}
function safeHistory(history) {
  if (history == null) return { items: [], total: 0 };
  if (!Array.isArray(history) || Object.getPrototypeOf(history) !== Array.prototype) {
    throw new Error('Agent history must be a dense array');
  }
  const total = own(history, 'length');
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_HISTORY_LENGTH) {
    throw new Error('Agent history length is invalid');
  }
  const start = Math.max(0, total - MAX_HISTORY_SCAN);
  const items = [];
  for (let i = start; i < total; i += 1) {
    const entry = own(history, String(i));
    if (entry === undefined) throw new Error('Agent history must be dense');
    items.push({ ordinal: i, entry });
  }
  return { items, total };
}
function freeze(value) {
  if (Array.isArray(value)) { value.forEach(freeze); return Object.freeze(value); }
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); return Object.freeze(value); }
  return value;
}
function planSummary(plan) {
  if (plan == null) return freeze({ revision: 0, nodeCount: 0, stateCounts: {} });
  record(plan, 'Agent plan');
  const nodes = own(plan, 'nodes');
  const stateCounts = {};
  let nodeCount = 0;
  if (Array.isArray(nodes)) {
    if (nodes.length > 4096) throw new Error('Agent plan is too large');
    for (let i = 0; i < nodes.length; i += 1) {
      const node = own(nodes, String(i));
      record(node, 'Agent plan node');
      const state = own(node, 'state');
      const safeState = PLAN_STATES.has(state) ? state : 'UNKNOWN';
      stateCounts[safeState] = (stateCounts[safeState] || 0) + 1;
      nodeCount += 1;
    }
  }
  return freeze({ revision: integer(own(plan, 'revision')), nodeCount, stateCounts });
}
export function buildAgentRunTimelineV1(job, options = {}) {
  record(job, 'Agent timeline job');
  record(options, 'Agent timeline options');
  const keys = Reflect.ownKeys(options);
  if (keys.some(key => typeof key !== 'string' || !['limit', 'filter'].includes(key))) {
    throw new Error('Agent timeline options contains unknown fields');
  }
  const limitValue = own(options, 'limit');
  const limit = limitValue === undefined ? MAX_AGENT_TIMELINE_ENTRIES : limitValue;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AGENT_TIMELINE_ENTRIES) {
    throw new Error('Agent timeline limit is invalid');
  }
  const filterValue = own(options, 'filter');
  const filter = filterValue === undefined ? 'ALL' : filterValue;
  if (!FILTERS.has(filter)) throw new Error('Agent timeline filter is invalid');
  const runtime = record(own(job, 'runtime'), 'Agent timeline runtime');
  const history = safeHistory(own(runtime, 'history'));
  const all = history.items.map(({ ordinal, entry }) => {
    record(entry, 'Agent history entry');
    const rawType = own(entry, 'type');
    const known = typeof rawType === 'string' && Object.hasOwn(EVENT_LABELS, rawType);
    const spec = known ? EVENT_LABELS[rawType] : ['RECOVERY', 'Подію невідомого типу зареєстровано.'];
    const rawAction = own(entry, 'action');
    let actionType = '';
    if (known && ACTION_DETAIL_EVENTS.has(rawType) && rawAction && typeof rawAction === 'object' && !Array.isArray(rawAction)) {
      const candidate = own(rawAction, 'type');
      if (typeof candidate === 'string' && ACTION_TYPES.has(candidate)) actionType = candidate;
    }
    return {
      entryId: 'agent-history:' + ordinal,
      at: safeTime(own(entry, 'at')),
      category: spec[0],
      event: known ? rawType : 'OTHER',
      description: spec[1],
      actionType,
      source: 'CANONICAL_AGENT_HISTORY',
    };
  });
  const matching = filter === 'ALL' ? all : all.filter(entry => entry.category === filter);
  const visible = matching.slice(-limit);
  // These are presence counts within the bounded canonical history, not proof
  // that an external operation committed or that missing evidence never existed.
  // Do not infer receipts, artifacts or before/after snapshots from free text.
  const evidenceMap = {
    scope: 'INSPECTED_CANONICAL_HISTORY_ONLY',
    completeHistoryInspected: history.total === all.length,
    observed: {
      planRevisionEvents: all.filter(entry => entry.event === 'plan').length,
      ownerInterventionEvents: all.filter(entry => entry.category === 'OWNER').length,
      actionRecordedEvents: all.filter(entry => entry.category === 'ACTION').length,
      recoveryRecordedEvents: all.filter(entry => entry.category === 'RECOVERY' && entry.event !== 'OTHER').length,
      checkpointRecordedEvents: all.filter(entry => entry.category === 'CHECKPOINT').length,
      specialistProviderEvents: all.filter(entry =>
        entry.event === 'specialist-provider-failed' || entry.event === 'specialist-provider-succeeded').length,
    },
    notEstablishedByThisProjection: [
      'BEFORE_AFTER_SNAPSHOTS',
      'EXTERNAL_EFFECT_RECEIPTS',
      'TOOL_EXECUTION_RECEIPTS',
      'ARTIFACT_PROVENANCE',
      'AGENT_TREE_EDGES',
    ],
    externalEffectVerified: false,
  };
  const verification = own(runtime, 'verifiedOutcome');
  const checks = verification && typeof verification === 'object' ? own(verification, 'checks') : undefined;
  const result = {
    schemaVersion: AGENT_RUN_TIMELINE_VERSION,
    jobId: typeof own(job, 'id') === 'string' ? own(job, 'id') : '',
    filter,
    totalRecorded: history.total,
    inspectedEntries: all.length,
    matchedEntries: matching.length,
    returnedEntries: visible.length,
    truncated: history.total > all.length || matching.length > visible.length,
    evidenceOnly: true,
    mayReplayExternalEffect: false,
    includesPrivatePrompts: false,
    plan: planSummary(own(runtime, 'plan')),
    evidenceMap,
    counters: {
      steps: integer(own(runtime, 'stepCount')),
      cycles: integer(own(runtime, 'completedCycles')),
      modelCalls: integer(own(runtime, 'modelCalls')),
      totalTokens: integer(own(runtime, 'totalTokens')),
      estimatedCostUsd: typeof own(runtime, 'estimatedCostUsd') === 'number' &&
        Number.isFinite(own(runtime, 'estimatedCostUsd')) &&
        own(runtime, 'estimatedCostUsd') >= 0 &&
        own(runtime, 'estimatedCostUsd') <= 1000000
          ? Math.round(own(runtime, 'estimatedCostUsd') * 1000000) / 1000000 : null,
      verifiedChecks: Array.isArray(checks) ? integer(checks.length, { max: 4096 }) : 0,
      ownerEvents: all.filter(entry => entry.category === 'OWNER').length,
    },
    entries: visible,
  };
  return freeze(result);
}
