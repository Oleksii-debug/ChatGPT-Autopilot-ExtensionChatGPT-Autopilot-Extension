/**
 * Pure view projection for the Plan 7 owner ROI advisory.
 * No input collection, runtime control, telemetry or licensing side effects.
 * Consumers inject an advisory computed from trusted canonical run evidence.
 */
export function renderRoiOwnerViewV1(container, advisory) {
  if (!container || typeof container.id !== 'string'
    || !/^[a-z][a-z0-9-]{0,79}$/u.test(container.id)
    || !container.ownerDocument || typeof container.replaceChildren !== 'function') {
    throw new Error('ROI view requires a stable, named semantic container');
  }
  if (!advisory || advisory.schemaVersion !== 1
    || !['OFFLINE','INSUFFICIENT_EVIDENCE','PARTIAL_EVIDENCE','EVIDENCE_BACKED'].includes(advisory.status)
    || typeof advisory.statusText !== 'string' || advisory.statusText.length > 300
    || !Array.isArray(advisory.opportunities) || advisory.opportunities.length > 256
    || advisory.deploymentAuthorized !== false) {
    throw new Error('ROI advisory is invalid or attempts to grant authority');
  }
  const document = container.ownerDocument;
  const element = (tag, text = '') => {
    const item = document.createElement(tag);
    item.textContent = text;
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
  const explanation = element('p',
    'Показники обчислено з перевірених записів. Оцінки не гарантують економії; ' +
    'жодна рекомендація не запускає автоматизацію, не змінює політики або бюджет.');
  section.appendChild(explanation);
  if (advisory.status === 'OFFLINE' || advisory.status === 'INSUFFICIENT_EVIDENCE') {
    container.replaceChildren(section);
    return section;
  }
  const metrics = element('dl');
  const addMetric = (name, value) => {
    metrics.appendChild(element('dt', name));
    metrics.appendChild(element('dd', value === null ? 'Немає підтверджених даних' : String(value)));
  };
  addMetric('Перевірені результати', advisory.verifiedOutcomeCount);
  addMetric('Час уваги власника, секунд', advisory.observedOwnerAttentionSeconds);
  addMetric('Спостережена економія часу, секунд', advisory.observedOwnerTimeAvoidedSeconds);
  addMetric('Нижня межа чистої економії, секунд', advisory.netOwnerTimeLowerSeconds);
  addMetric('Верхня межа чистої економії, секунд', advisory.netOwnerTimeUpperSeconds);
  addMetric('Витрати на API, мікродоларів США', advisory.machineSpendUsdMicros);
  section.appendChild(metrics);
  if (advisory.opportunities.length) {
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
    for (const opportunity of advisory.opportunities) {
      if (!opportunity || typeof opportunity.workflowClassId !== 'string'
        || opportunity.workflowClassId.length > 180
        || !Number.isSafeInteger(opportunity.verifiedManualOccurrenceCount)
        || opportunity.verifiedManualOccurrenceCount < 0
        || opportunity.policyOrExecutionAuthorized !== false) {
        throw new Error('Untrusted ROI opportunity rejected');
      }
      const row = element('tr');
      row.appendChild(element('td', opportunity.workflowClassId));
      row.appendChild(element('td', String(opportunity.verifiedManualOccurrenceCount)));
      row.appendChild(element('td', 'Лише оцінка Recipe або інструмента. Запуску немає.'));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    section.appendChild(table);
  }
  container.replaceChildren(section);
  return section;
}
