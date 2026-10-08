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
      || row.decisionAuthorized === true) {
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
    || advisory.recommendationAuthorized === true || advisory.telemetryEmitted === true) {
    throw new Error('ROI advisory is invalid or attempts to grant authority');
  }
  const rows = snapshotRows(advisory.opportunities);
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
  const status = element('p', advisory.statusText);
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
      tr.appendChild(element('td', row.workflowClassId));
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
