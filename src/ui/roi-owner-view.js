/**
 * Read-only semantic Plan 7 owner ROI projection.
 * Data-descriptor snapshots prevent accessor-backed evidence from executing
 * during rendering. All validation completes before changing the live DOM.
 * This module has no execution, policy, network, telemetry or storage role.
 */
const ADVISORY_FIELDS = new Set([
  'schemaVersion', 'status', 'statusText', 'reportId', 'observedRunCount',
  'verifiedOutcomeCount', 'observedOwnerTimeAvoidedSeconds',
  'estimatedOwnerTimeAvoidedSeconds', 'observedOwnerAttentionSeconds',
  'netOwnerTimeLowerSeconds', 'netOwnerTimeUpperSeconds',
  'machineSpendUsdMicros', 'runtimeMs', 'opportunities',
  'noComparableModelEvidence', 'recommendationAuthorized',
  'deploymentAuthorized', 'telemetryEmitted',
]);
const OPPORTUNITY_FIELDS = new Set([
  'workflowClassId', 'verifiedManualOccurrenceCount',
  'recurringOwnerAttentionSeconds', 'advisoryPath', 'shorterModelPath',
  'supportingRunCount', 'decisionAuthorized', 'policyOrExecutionAuthorized',
]);
const STATUSES = new Set([
  'OFFLINE', 'INSUFFICIENT_EVIDENCE', 'PARTIAL_EVIDENCE', 'EVIDENCE_BACKED',
]);
// Owner-facing text is derived from the vetted enum, not from a transport
// supplied statusText that may falsely claim deployment or verified effects.
const STATUS_TEXT = Object.freeze({
  OFFLINE: 'Немає зв’язку з локальними доказами. Оцінку економії не оновлено.',
  INSUFFICIENT_EVIDENCE: 'Доказів недостатньо для рекомендації автоматизації.',
  PARTIAL_EVIDENCE: 'Часткові докази. Оцінена економія показана як інтервал.',
  EVIDENCE_BACKED: 'Доступні підтверджені локальні показники. Рекомендації лише дорадчі.',
});

const METRICS = [
  ['Перевірені результати', 'verifiedOutcomeCount', false],
  ['Час уваги власника, секунд', 'observedOwnerAttentionSeconds', false],
  ['Спостережена економія часу, секунд', 'observedOwnerTimeAvoidedSeconds', false],
  ['Нижня межа чистої економії, секунд', 'netOwnerTimeLowerSeconds', true],
  ['Верхня межа чистої економії, секунд', 'netOwnerTimeUpperSeconds', true],
  ['Витрати на API, мікродоларів США', 'machineSpendUsdMicros', false],
];

function snapshotData(input, fields, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(label + ' must be a plain object');
  }
  let prototype, descriptors;
  try {
    prototype = Object.getPrototypeOf(input);
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    throw new Error(label + ' descriptors are not trustworthy');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain object');
  }
  const copy = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !fields.has(key)) {
      throw new Error(label + ' contains an unknown field');
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + ' contains an unsafe accessor');
    }
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}

function snapshotRows(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('ROI opportunities must be a plain array');
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { throw new Error('ROI opportunities descriptors are not trustworthy'); }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 256) {
    throw new Error('ROI opportunities exceed the bounded limit');
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1) throw new Error('ROI opportunities contain unexpected array fields');
  const rows = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('ROI opportunities are sparse or accessor-backed');
    }
    const row = snapshotData(descriptor.value, OPPORTUNITY_FIELDS, 'ROI opportunity');
    if (typeof row.workflowClassId !== 'string'
      || row.workflowClassId.length < 1 || row.workflowClassId.length > 180
      || !Number.isSafeInteger(row.verifiedManualOccurrenceCount)
      || row.verifiedManualOccurrenceCount < 0
      || row.policyOrExecutionAuthorized !== false
      || (row.decisionAuthorized !== undefined && row.decisionAuthorized !== false)
      || (row.advisoryPath !== undefined && row.advisoryPath !== 'EVALUATE_DETERMINISTIC_RECIPE_OR_TOOL')
      || (row.shorterModelPath !== undefined && row.shorterModelPath !== 'NOT_EVALUATED')
      || (row.recurringOwnerAttentionSeconds !== undefined
        && (!Number.isSafeInteger(row.recurringOwnerAttentionSeconds) || row.recurringOwnerAttentionSeconds < 0))
      || (row.supportingRunCount !== undefined
        && (!Number.isSafeInteger(row.supportingRunCount) || row.supportingRunCount < 0))) {
      throw new Error('Untrusted ROI opportunity rejected');
    }
    rows.push(row);
  }
  return Object.freeze(rows);
}

function snapshotAdvisory(input) {
  const advisory = snapshotData(input, ADVISORY_FIELDS, 'ROI advisory');
  if (advisory.schemaVersion !== 1 || !STATUSES.has(advisory.status)
    || typeof advisory.statusText !== 'string' || advisory.statusText.length > 300
    || advisory.deploymentAuthorized !== false
    || (advisory.recommendationAuthorized !== undefined && advisory.recommendationAuthorized !== false)
    || (advisory.telemetryEmitted !== undefined && advisory.telemetryEmitted !== false)) {
    throw new Error('ROI advisory is invalid or attempts to grant authority');
  }
  // A forged advisory must not report more independently verified outcomes
  // than the bounded canonical run population, even if the status label is valid.
  if (!Number.isSafeInteger(advisory.observedRunCount)
    || advisory.observedRunCount < 0 || advisory.observedRunCount > 256
    || !Number.isSafeInteger(advisory.verifiedOutcomeCount)
    || advisory.verifiedOutcomeCount < 0
    || advisory.verifiedOutcomeCount > advisory.observedRunCount) {
    throw new Error('ROI outcome counters contradict canonical run evidence');
  }

  // Status is an evidence claim, not a cosmetic string. Core never produces
  // EVIDENCE_BACKED/PARTIAL for an empty run set and always attaches a stable
  // report ID when it did evaluate evidence. OFFLINE is a fresh absence of
  // evaluation, not permission to replay a previous success as current.
  const offline = advisory.status === 'OFFLINE';
  const reportIsCanonical = typeof advisory.reportId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u.test(advisory.reportId);
  if ((!offline && !reportIsCanonical)
    || (offline && (advisory.reportId !== null
      || advisory.observedRunCount !== 0
      || advisory.verifiedOutcomeCount !== 0))
    || ((advisory.status === 'PARTIAL_EVIDENCE'
      || advisory.status === 'EVIDENCE_BACKED')
      && advisory.observedRunCount === 0)) {
    throw new Error('ROI status contradicts canonical report identity or run evidence');
  }
  if (offline && [
    advisory.observedOwnerTimeAvoidedSeconds,
    advisory.estimatedOwnerTimeAvoidedSeconds,
    advisory.observedOwnerAttentionSeconds,
    advisory.netOwnerTimeLowerSeconds,
    advisory.netOwnerTimeUpperSeconds,
    advisory.machineSpendUsdMicros,
    advisory.runtimeMs,
  ].some(value => value != null)) {
    throw new Error('ROI offline evidence cannot retain current savings or spend');
  }

  const rows = snapshotRows(advisory.opportunities);
  // Per-workflow numbers are subsets of the bounded observed run population.
  // A single forged advisory must never display more supporting/verified
  // occurrences than there are canonical runs in the same report.
  // Each canonical run belongs to exactly one workflow class. Individual
  // per-row bounds are insufficient: duplicate rows or several individually
  // plausible rows could sum to more runs than the entire report contains.
  // Reject the entire forged snapshot before mutating the NVDA-facing DOM.
  const workflowClasses = new Set();
  let manualOccurrenceTotal = 0, supportingRunTotal = 0;
  for (const row of rows) {
    if (workflowClasses.has(row.workflowClassId)) {
      throw new Error('ROI report duplicates workflow evidence');
    }
    workflowClasses.add(row.workflowClassId);
    if (row.verifiedManualOccurrenceCount > advisory.observedRunCount
      || (row.supportingRunCount !== undefined
        && (row.supportingRunCount > advisory.observedRunCount
          || row.verifiedManualOccurrenceCount > row.supportingRunCount))) {
      throw new Error('ROI opportunity counts exceed observed evidence');
    }
    manualOccurrenceTotal += row.verifiedManualOccurrenceCount;
    supportingRunTotal += row.supportingRunCount ?? 0;
    if (manualOccurrenceTotal > advisory.observedRunCount
      || supportingRunTotal > advisory.observedRunCount) {
      throw new Error('ROI report double-counts canonical runs');
    }
  }
  // Estimated bounds are an evidence interval, never a coerced string,
  // getter-backed object or reversed savings claim.
  if (advisory.estimatedOwnerTimeAvoidedSeconds != null) {
    const interval = snapshotData(
      advisory.estimatedOwnerTimeAvoidedSeconds,
      new Set(['lower', 'upper']),
      'ROI estimated owner time interval',
    );
    if (!Number.isSafeInteger(interval.lower)
      || !Number.isSafeInteger(interval.upper)
      || Object.is(interval.lower, -0) || Object.is(interval.upper, -0)
      || interval.lower < 0 || interval.upper < interval.lower) {
      throw new Error('ROI estimated owner time bounds are invalid');
    }
  }
  if (advisory.netOwnerTimeLowerSeconds != null
    && advisory.netOwnerTimeUpperSeconds != null
    && advisory.netOwnerTimeLowerSeconds > advisory.netOwnerTimeUpperSeconds) {
    throw new Error('ROI net owner time interval is inverted');
  }
  if (advisory.noComparableModelEvidence !== undefined
    && advisory.noComparableModelEvidence !== true) {
    throw new Error('ROI cannot invent comparable model evidence');
  }
  if (advisory.status === 'OFFLINE' || advisory.status === 'INSUFFICIENT_EVIDENCE') {
    if (rows.length !== 0) throw new Error('Unavailable evidence cannot list opportunities');
  }
  for (const [, key, allowNegative] of METRICS) {
    const number = advisory[key];
    if (number != null && (!Number.isSafeInteger(number)
      || Object.is(number, -0) || (!allowNegative && number < 0))) {
      throw new Error('ROI advisory contains invalid metric units');
    }
  }
  return Object.freeze({ advisory, rows });
}

export function renderRoiOwnerViewV1(container, rawAdvisory) {
  if (!container || typeof container.id !== 'string'
    || !/^[a-z][a-z0-9-]{0,79}$/u.test(container.id)
    || !container.ownerDocument || typeof container.replaceChildren !== 'function') {
    throw new Error('ROI view requires a stable, named semantic container');
  }
  const { advisory, rows } = snapshotAdvisory(rawAdvisory);
  const document = container.ownerDocument;
  const element = (tag, value = '') => {
    const item = document.createElement(tag);
    item.textContent = value;
    return item;
  };
  const section = element('section');
  const heading = element('h2', 'Економія часу та можливості автоматизації');
  heading.id = container.id + '-heading';
  section.setAttribute('aria-labelledby', heading.id);
  section.appendChild(heading);
  const status = element('p', STATUS_TEXT[advisory.status]);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  section.appendChild(status);
  section.appendChild(element('p',
    'Показники обчислено з перевірених записів. Оцінки не гарантують економії; ' +
    'жодна рекомендація не запускає автоматизацію, не змінює політики або бюджет.'));
  if (advisory.status === 'OFFLINE' || advisory.status === 'INSUFFICIENT_EVIDENCE') {
    container.replaceChildren(section);
    return section;
  }
  const metrics = element('dl');
  for (const [name, key] of METRICS) {
    const value = advisory[key];
    metrics.appendChild(element('dt', name));
    metrics.appendChild(element('dd', value == null ? 'Немає підтверджених даних' : String(value)));
  }
  section.appendChild(metrics);
  if (rows.length > 0) {
    const table = element('table');
    table.appendChild(element('caption', 'Дорадчі можливості за робочим процесом'));
    const thead = element('thead');
    const tr = element('tr');
    for (const name of ['Робочий процес', 'Перевірені ручні випадки', 'Рішення']) {
      const th = element('th', name);
      th.setAttribute('scope', 'col');
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
    const tbody = element('tbody');
    for (const row of rows) {
      const tr = element('tr');
      const rowHeading = element('th', row.workflowClassId);
      rowHeading.setAttribute('scope', 'row');
      tr.appendChild(rowHeading);
      tr.appendChild(element('td', String(row.verifiedManualOccurrenceCount)));
      tr.appendChild(element('td', 'Лише оцінка Recipe або інструмента. Запуску немає.'));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
  }
  container.replaceChildren(section);
  return section;
}
