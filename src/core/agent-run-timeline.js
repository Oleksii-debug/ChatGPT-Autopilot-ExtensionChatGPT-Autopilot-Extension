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
  let prototype;
  try { prototype = Object.getPrototypeOf(value); }
  catch { throw new Error(name + ' cannot be safely inspected'); }
  if (prototype !== Object.prototype && prototype !== null) throw new Error(name + ' must be a plain record');
  return value;
}
function own(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
  catch { throw new Error('Agent timeline field cannot be safely inspected'); }
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw new Error('Agent timeline refuses accessor-backed ' + String(key));
  return descriptor.value;
}
// Durable JSON-backed evidence must be an enumerable own data field.
// A hidden property can be visible before restart and silently disappear
// after serialization, falsifying the timeline's counter or plan evidence.
// Inspect one descriptor only; never invoke a getter or expose trap text.
function persistedField(value, key) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
  catch { throw new Error('Agent timeline persisted field cannot be safely inspected'); }
  if (!descriptor) return { present: false, value: undefined };
  // Preserve the existing fixed-field accessor refusal diagnostic for
  // compatibility with prior error classification; do not echo values.
  if (!Object.hasOwn(descriptor, 'value')) {
    throw new Error('Agent timeline refuses accessor-backed ' + key);
  }
  if (!descriptor.enumerable) {
    throw new Error('Agent timeline persisted field must be an enumerable data field');
  }
  return { present: true, value: descriptor.value };
}
function safeOwnKeys(value) {
  try { return Reflect.ownKeys(value); }
  catch { throw new Error('Agent timeline options cannot be safely inspected'); }
}
function safeHasOwn(value, key) {
  try { return Object.hasOwn(value, key); }
  catch { throw new Error('Agent timeline field presence cannot be safely inspected'); }
}
function plainArray(value) {
  try { return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype; }
  catch { throw new Error('Agent timeline array cannot be safely inspected'); }
}
function integer(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : 0;
}
// Recorded counters are evidence, not defaults. A truly absent legacy field
// projects zero; a present corrupt value must not become a plausible zero in
// the accessible timeline or its exported JSON after storage/restart.
function recordedCounter(recordValue, field) {
  const fieldValue = persistedField(recordValue, field);
  if (!fieldValue.present) return 0;
  const observed = fieldValue.value;
  if (!Number.isSafeInteger(observed) || Object.is(observed, -0) || observed < 0) {
    // All field names are fixed code-owned literals. Never emit hostile values.
    throw new Error('Agent timeline persisted counter is invalid');
  }
  return observed;
}
function boundedJobId(value) {
  // Durable BrowserAgentManager identities are bounded text, not trusted
  // display/HTML content. Never export corrupt oversized/control-char IDs.
  // A persisted Agent must have a real identity; never export an orphan
  // timeline under an empty identifier after corrupted storage or restart.
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error('Agent timeline job identity is invalid');
  }
  return value;
}
function storedEventTime(value, present) {
  // Absent legacy timestamps remain compatible but are explicitly identified
  // as missing evidence. A recorded epoch-zero is not "unknown" time.
  // A present undefined/fractional/noncanonical timestamp is corrupt.
  if (!present) return 0;
  if (!Number.isSafeInteger(value) || Object.is(value, -0) ||
      value < 0 || value > 8_640_000_000_000_000) {
    throw new Error('Agent history entry timestamp is invalid');
  }
  return value;
}
function safeHistory(history, present) {
  // Missing history is supported for old persisted snapshots, but an
  // explicitly persisted null is corruption, not evidence of zero events.
  if (history === undefined) {
    if (present) throw new Error('Agent history must be a dense array');
    return { items: [], total: 0 };
  }
  if (!plainArray(history)) {
    throw new Error('Agent history must be a dense array');
  }
  const total = own(history, 'length');
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_HISTORY_LENGTH) {
    throw new Error('Agent history length is invalid');
  }
  // A retained event count must describe an actual dense canonical array,
  // not a sparse/hidden/extra-key history whose holes were outside the last-N
  // scan. Verify structure without property get traps and without exporting
  // arbitrary keys or stored event payloads.
  const keys = safeOwnKeys(history);
  if (keys.length !== total + 1 || !keys.includes('length') ||
      keys.some(key => key !== 'length' &&
        (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= total))) {
    throw new Error('Agent history must be a canonical dense array');
  }
  const start = Math.max(0, total - MAX_HISTORY_SCAN);
  const items = [];
  for (let i = 0; i < total; i += 1) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(history, String(i)); }
    catch { throw new Error('Agent history cannot be safely inspected'); }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('Agent history must be a canonical dense array');
    }
    if (i >= start) {
      const entry = descriptor.value;
      if (entry === undefined) throw new Error('Agent history must be dense');
      items.push({ ordinal: i, entry });
    }
  }
  return { items, total };
}
// Only count persisted evidence from an ordinary, enumerable, dense array.
// This checks fixed numeric descriptors without running getters or leaking
// attacker-controlled Proxy exceptions. Read every element just once.
function canonicalEvidenceElements(value, length, label) {
  const keys = safeOwnKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length') ||
      keys.some(key => key !== 'length' &&
        (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length))) {
    throw new Error(label + ' must be a canonical dense array');
  }
  const elements = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); }
    catch { throw new Error(label + ' cannot be safely inspected'); }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + ' must be a canonical dense array');
    }
    elements.push(descriptor.value);
  }
  return elements;
}
function freeze(value) {
  if (Array.isArray(value)) { value.forEach(freeze); return Object.freeze(value); }
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); return Object.freeze(value); }
  return value;
}
function planSummary(plan) {
  if (plan == null) return freeze({ revision: 0, nodeCount: 0, stateCounts: {} });
  record(plan, 'Agent plan');
  // One descriptor is both presence and value: a hostile persisted Proxy
  // cannot show one plan shape at validation and another in the projection.
  const { present: nodesPresent, value: nodes } = persistedField(plan, 'nodes');
  const stateCounts = {};
  let nodeCount = 0;
  // An explicitly persisted malformed plan must not be presented as an
  // empty plan after restart. Only a genuinely absent optional nodes field
  // preserves the legacy zero-node projection.
  if (nodesPresent && !plainArray(nodes)) {
    throw new Error('Agent plan nodes must be a plain array');
  }
  if (Array.isArray(nodes)) {
    // Proxy get traps must not read array length or throw private exceptions.
    const nodeLength = own(nodes, 'length');
    if (!Number.isSafeInteger(nodeLength) || nodeLength < 0 || nodeLength > 4096) {
      throw new Error('Agent plan nodes length is invalid');
    }
    for (const node of canonicalEvidenceElements(nodes, nodeLength, 'Agent plan nodes')) {
      record(node, 'Agent plan node');
      const state = persistedField(node, 'state').value;
      const safeState = PLAN_STATES.has(state) ? state : 'UNKNOWN';
      stateCounts[safeState] = (stateCounts[safeState] || 0) + 1;
      nodeCount += 1;
    }
  }
  return freeze({ revision: recordedCounter(plan, 'revision'), nodeCount, stateCounts });
}
function recordedOutcomeSummary(value) {
  // The persisted outcome record is observable Core state, not an external
  // receipt or a grant of execution/owner authority. Never export check text.
  if (value == null) return freeze({
    source: 'CANONICAL_AGENT_RUNTIME_RECORDED_ONLY',
    recordPresent: false,
    criteriaRecorded: 0,
    recordedAt: null,
    externalEffectVerified: false,
  });
  record(value, 'Agent recorded outcome');
  // Only a genuinely absent legacy field can mean "not recorded". An
  // explicit null/undefined after restart is corrupt evidence, not zero checks.
  // Read once, preserving the enumerable JSON-persisted evidence boundary.
  // Two independent reads would permit a hostile descriptor to switch the
  // outcome proof between validation and export.
  const { present: checksPresent, value: checks } = persistedField(value, 'checks');
  let count = 0;
  if (checksPresent) {
    if (!plainArray(checks)) {
      throw new Error('Agent recorded outcome checks must be a bounded dense array');
    }
    const checksLength = own(checks, 'length');
    if (!Number.isSafeInteger(checksLength) || checksLength < 0 || checksLength > 20) {
      throw new Error('Agent recorded outcome checks length is invalid (must be a bounded dense array)');
    }
    for (const item of canonicalEvidenceElements(checks, checksLength, 'Agent recorded outcome checks')) {
      if (item === undefined) throw new Error('Agent recorded outcome checks must be dense');
      record(item, 'Agent recorded outcome check');
    }
    count = checksLength;
  }
  const { present: timePresent, value: rawAt } = persistedField(value, 'verifiedAt');
  if (timePresent && (!Number.isSafeInteger(rawAt) || Object.is(rawAt, -0) ||
      rawAt < 0 || rawAt > 8_640_000_000_000_000)) {
    throw new Error('Agent recorded outcome verifiedAt is invalid');
  }
  // 0 is the canonical unverified placeholder; do not fabricate an observed
  // timestamp or external-effect receipt from it. Missing legacy time is null.
  const at = timePresent ? rawAt : null;
  return freeze({
    source: 'CANONICAL_AGENT_RUNTIME_RECORDED_ONLY',
    recordPresent: true,
    criteriaRecorded: count,
    recordedAt: at === 0 ? null : at,
    externalEffectVerified: false,
  });
}
const SPECIALIST_DISPATCH_STATES = new Set([
  'DISPATCHING', 'FAILED_SAFE', 'AMBIGUOUS', 'PROVIDER_SUCCEEDED',
]);

function recordedSpecialistDispatchEvidence(runtime) {
  // Project only already-durable BrowserAgentManager dispatch records. These
  // counts do not prove execution, provider delivery, artifact provenance,
  // agent-tree linkage or the entire lifetime history.
  const { present, value: dispatchRecord } = persistedField(runtime, 'specialistDispatchByAgentId');
  if (!present) return freeze({
    source: 'CANONICAL_AGENT_RUNTIME_DISPATCH_METADATA_ONLY',
    recordPresent: false,
    inspectedAttempts: 0,
    statusCounts: { DISPATCHING: 0, FAILED_SAFE: 0, AMBIGUOUS: 0, PROVIDER_SUCCEEDED: 0 },
    receiptIdsRecorded: 0,
    artifactReferencesRecorded: 0,
    externalEffectVerified: false,
    artifactProvenanceVerified: false,
  });
  const dispatches = record(dispatchRecord, 'Agent specialist dispatch map');
  const keys = safeOwnKeys(dispatches);
  // The map keys are durable Agent identities, not arbitrary provider text.
  // Reject forged/control-character identities before counting any attempt.
  // Reuse the canonical ownership ID grammar; do not expose IDs in export.
  if (keys.length > 128 || keys.some(key => typeof key !== 'string' || !RECORDED_OWNERSHIP_ID.test(key))) {
    throw new Error('Agent specialist dispatch map exceeds the bounded record schema');
  }
  const statusCounts = { DISPATCHING: 0, FAILED_SAFE: 0, AMBIGUOUS: 0, PROVIDER_SUCCEEDED: 0 };
  let receiptIdsRecorded = 0;
  let artifactReferencesRecorded = 0;
  // One receipt identity cannot prove multiple independently recorded
  // provider attempts. This remains metadata, not trusted external proof.
  const seenReceiptIds = new Set();
  for (const key of keys) {
    // Durable JSON serialization omits hidden and accessor-backed map keys.
    // Counting either as evidence would change the audit trail after restart.
    // Snapshot each own descriptor once; do not invoke untrusted getters or
    // expose Proxy trap messages in diagnostics.
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(dispatches, key); }
    catch { throw new Error('Agent specialist dispatch record cannot be safely inspected'); }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('Agent specialist dispatch record must be an enumerable data field');
    }
    // Persisted evidence must survive JSON cold restart. Hidden scalar fields
    // are not durable receipts/identities and must fail before counting.
    const attempt = record(descriptor.value, 'Agent specialist dispatch attempt');
    const state = persistedField(attempt, 'state').value;
    if (!SPECIALIST_DISPATCH_STATES.has(state)) {
      throw new Error('Agent specialist dispatch state is invalid');
    }
    statusCounts[state] += 1;
    const receiptId = persistedField(attempt, 'providerReceiptId').value;
    if (receiptId !== undefined && receiptId !== null && receiptId !== '') {
      // Refuse corrupt/spoofed persisted IDs instead of silently dropping
      // them or counting the same external receipt twice after restart.
      if (typeof receiptId !== 'string' || receiptId.length > 240 ||
          /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(receiptId) ||
          seenReceiptIds.has(receiptId)) {
        throw new Error('Agent specialist dispatch receipt identity is invalid or duplicated');
      }
      seenReceiptIds.add(receiptId);
      receiptIdsRecorded += 1;
    }
    const { present: referencesPresent, value: refs } = persistedField(attempt, 'resultArtifactRefs');
    if (!referencesPresent) continue;
    if (!plainArray(refs)) throw new Error('Agent specialist artifact references must be a bounded dense array');
    const length = own(refs, 'length');
    if (!Number.isSafeInteger(length) || length < 0 || length > 128) {
      throw new Error('Agent specialist artifact reference count is invalid');
    }
    for (const ref of canonicalEvidenceElements(refs, length, 'Agent specialist artifact references')) {
      record(ref, 'Agent specialist artifact reference');
      // A recorded artifact reference must carry a durable, canonical ID.
      // Counting {} or a hidden/accessor-backed ID creates false evidence:
      // it is visible before JSON cold restart but vanishes afterward. This
      // remains metadata only; it never attests provenance or effect success.
      const { present: artifactIdPresent, value: artifactId } = persistedField(ref, 'artifactId');
      if (!artifactIdPresent || typeof artifactId !== 'string' ||
          !RECORDED_OWNERSHIP_ID.test(artifactId)) {
        throw new Error('Agent specialist artifact reference identity is invalid');
      }
      artifactReferencesRecorded += 1;
    }
  }
  return freeze({
    source: 'CANONICAL_AGENT_RUNTIME_DISPATCH_METADATA_ONLY',
    recordPresent: true,
    inspectedAttempts: keys.length,
    statusCounts,
    receiptIdsRecorded,
    artifactReferencesRecorded,
    externalEffectVerified: false,
    artifactProvenanceVerified: false,
  });
}

// Read-only projection of the EXISTING durable ExecutionOwnershipV1 records.
// State and structural link counts are NOT Agent-tree ancestry, execution
// receipts, independent verification or permission to resume/replay effects.
const RECORDED_OWNERSHIP_STATES = new Set([
  'AVAILABLE', 'OWNED', 'HANDOFF_PENDING', 'RECONCILE', 'VERIFIED', 'MANUAL_REVIEW',
]);
const RECORDED_OWNERSHIP_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
function recordedExecutionOwnershipEvidence(runtime) {
  const empty = () => freeze({
    source: 'CANONICAL_AGENT_RUNTIME_OWNERSHIP_METADATA_ONLY',
    recordPresent: false,
    inspectedRecords: 0,
    stateCounts: { AVAILABLE: 0, OWNED: 0, HANDOFF_PENDING: 0, RECONCILE: 0, VERIFIED: 0, MANUAL_REVIEW: 0 },
    structurallyBoundNodeRecords: 0,
    agentTreeEdgesVerified: false,
    externalEffectVerified: false,
  });
  const { present, value: records } = persistedField(runtime, 'specialistExecutionOwnerships');
  if (!present) return empty();
  if (!plainArray(records)) throw new Error('Agent execution ownership records must be a bounded dense array');
  const count = own(records, 'length');
  if (!Number.isSafeInteger(count) || count < 0 || count > 128) {
    throw new Error('Agent execution ownership length is invalid');
  }
  // Reuse the canonical descriptor-only array inspection. A non-enumerable
  // element is observable here but disappears from JSON storage/restart:
  // it must not be counted as durable evidence. Never invoke its getter.
  const elements = canonicalEvidenceElements(records, count, 'Agent execution ownership records');
  const stateCounts = { AVAILABLE: 0, OWNED: 0, HANDOFF_PENDING: 0, RECONCILE: 0, VERIFIED: 0, MANUAL_REVIEW: 0 };
  const seenNodes = new Set();
  const seenEffects = new Set();
  for (const element of elements) {
    // A non-enumerable state/node/effect identity vanishes after restart:
    // never export its pre-restart value as durable evidence.
    const item = record(element, 'Agent execution ownership record');
    const state = persistedField(item, 'state').value;
    const nodeId = persistedField(item, 'nodeId').value;
    const effectId = persistedField(item, 'effectId').value;
    if (!RECORDED_OWNERSHIP_STATES.has(state) ||
        typeof nodeId !== 'string' || !RECORDED_OWNERSHIP_ID.test(nodeId) ||
        typeof effectId !== 'string' || !RECORDED_OWNERSHIP_ID.test(effectId) ||
        seenNodes.has(nodeId) || seenEffects.has(effectId)) {
      throw new Error('Agent execution ownership record has invalid or duplicate identity/state');
    }
    seenNodes.add(nodeId);
    seenEffects.add(effectId);
    stateCounts[state] += 1;
  }
  return freeze({
    source: 'CANONICAL_AGENT_RUNTIME_OWNERSHIP_METADATA_ONLY',
    recordPresent: true,
    inspectedRecords: count,
    stateCounts,
    structurallyBoundNodeRecords: seenNodes.size,
    agentTreeEdgesVerified: false,
    externalEffectVerified: false,
  });
}

export function buildAgentRunTimelineV1(job, options = {}) {
  record(job, 'Agent timeline job');
  record(options, 'Agent timeline options');
  const keys = safeOwnKeys(options);
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
  const runtime = record(persistedField(job, 'runtime').value, 'Agent timeline runtime');
  // One persisted descriptor is the sole authority for both presence and value.
  // Separate reads permit hostile storage Proxies to change the apparent
  // snapshot between validation and projection, or hide it from JSON restart.
  const { present: historyPresent, value: storedHistory } = persistedField(runtime, 'history');
  const history = safeHistory(storedHistory, historyPresent);
  const all = history.items.map(({ ordinal, entry }) => {
    record(entry, 'Agent history entry');
    // Timeline data is persisted JSON evidence: a hidden event field may be
    // visible before restart but disappear afterward. Snapshot each fixed
    // descriptor exactly once without invoking getters/Proxy get traps.
    const { present: typePresent, value: rawType } = persistedField(entry, 'type');
    if (typePresent && rawType === undefined) {
      throw new Error('Agent history event type is invalid');
    }
    const known = typeof rawType === 'string' && Object.hasOwn(EVENT_LABELS, rawType);
    const spec = known ? EVENT_LABELS[rawType] : ['RECOVERY', 'Подію невідомого типу зареєстровано.'];
    const { present: hasRecordedTime, value: recordedTime } = persistedField(entry, 'at');
    const rawAction = persistedField(entry, 'action').value;
    let actionType = '';
    if (known && ACTION_DETAIL_EVENTS.has(rawType) && rawAction && typeof rawAction === 'object' && !Array.isArray(rawAction)) {
      const candidate = persistedField(rawAction, 'type').value;
      if (typeof candidate === 'string' && ACTION_TYPES.has(candidate)) actionType = candidate;
    }
    return {
      entryId: 'agent-history:' + ordinal,
      at: storedEventTime(recordedTime, hasRecordedTime),
      timeEvidence: hasRecordedTime ? 'RECORDED' : 'MISSING_LEGACY',
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
  // A genuinely missing legacy outcome means "not recorded". A canonical
  // fresh BrowserAgentRuntime sets verifiedOutcome: null until verification;
  // neither null nor omission establishes an external effect receipt. An
  // explicitly persisted undefined is invalid evidence after restart.
  const { present: outcomePresent, value: rawOutcome } = persistedField(runtime, 'verifiedOutcome');
  if (outcomePresent && rawOutcome === undefined) {
    throw new Error('Agent persisted outcome is invalid');
  }
  const recordedOutcome = recordedOutcomeSummary(rawOutcome);
  const evidenceMap = {
    scope: 'INSPECTED_CANONICAL_HISTORY_ONLY',
    // BrowserAgentManager also caps its persisted history. Even reading all
    // provided entries cannot prove the *lifetime* run history is complete.
    allRetainedHistoryInspected: history.total === all.length,
    completeLifetimeHistoryKnown: false,
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
    recordedOutcome,
    specialistProviderDispatch: recordedSpecialistDispatchEvidence(runtime),
    specialistExecutionOwnership: recordedExecutionOwnershipEvidence(runtime),
  };
  // Preserve a single observation of this persisted accounting field. A
  // hostile storage Proxy may return a new descriptor on each inspection:
  // repeated reads could mix evidence from distinct snapshots or coerce
  // attacker-controlled objects while preparing an accessible export.
  const rawEstimatedCostUsd = persistedField(runtime, 'estimatedCostUsd').value;
  const estimatedCostUsd = typeof rawEstimatedCostUsd === 'number' &&
    Number.isFinite(rawEstimatedCostUsd) &&
    rawEstimatedCostUsd >= 0 && rawEstimatedCostUsd <= 1000000
      ? Math.round(rawEstimatedCostUsd * 1000000) / 1000000 : null;
  const result = {
    schemaVersion: AGENT_RUN_TIMELINE_VERSION,
    jobId: boundedJobId(persistedField(job, 'id').value),
    entryIdentityScope: 'RETAINED_HISTORY_ORDINAL_NOT_DURABLE',
    filter,
    totalRecorded: history.total,
    inspectedEntries: all.length,
    matchedEntries: matching.length,
    returnedEntries: visible.length,
    truncated: history.total > all.length || matching.length > visible.length,
    evidenceOnly: true,
    mayReplayExternalEffect: false,
    includesPrivatePrompts: false,
    plan: planSummary(persistedField(runtime, 'plan').value),
    evidenceMap,
    counters: {
      steps: recordedCounter(runtime, 'stepCount'),
      cycles: recordedCounter(runtime, 'completedCycles'),
      modelCalls: recordedCounter(runtime, 'modelCalls'),
      totalTokens: recordedCounter(runtime, 'totalTokens'),
      estimatedCostUsd,
      verifiedChecks: recordedOutcome.criteriaRecorded,
      ownerEvents: all.filter(entry => entry.category === 'OWNER').length,
    },
    entries: visible,
  };
  return freeze(result);
}
