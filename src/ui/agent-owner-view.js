// Ephemeral UI ordering only. Core remains the source of job/effect state.
export function createAgentViewFenceV1() {
  let epoch = 0;
  let jobId = '';
  let readSequence = 0;
  const capture = () => Object.freeze({ epoch, jobId });
  const current = ticket => Boolean(ticket && ticket.epoch === epoch && ticket.jobId === jobId);
  return Object.freeze({
    capture,
    current,
    select(id) { jobId = id || ''; epoch += 1; return capture(); },
    beginRead() { return Object.freeze({ ...capture(), sequence: ++readSequence }); },
    currentRead(ticket) { return current(ticket) && ticket.sequence === readSequence; },
  });
}

// A read timeout ends the UI wait, not the underlying Chrome message. Keep
// sharing that message until it actually settles; do not accumulate requests.
export function createAgentJobsReadGateV1(read) {
  let pending = null;
  let revision = 0;
  return Object.freeze({
    invalidate() { revision += 1; },
    current(result) { return result?.revision === revision; },
    read() {
      if (pending) return pending;
      const startedRevision = revision;
      const request = Promise.resolve().then(read).then(data => ({ data, revision: startedRevision }));
      pending = request;
      const release = () => { if (pending === request) pending = null; };
      request.then(release, release);
      return request;
    },
  });
}

export async function readAgentJobsWithDeadlineV1(read, {
  timeoutMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => {
        timer = setTimer(() => reject(new Error('Core не відповів на читання списку Agent за 15 секунд. Виконання завдань не скасовано.')), timeoutMs);
      }),
    ]);
  } finally { clearTimer(timer); }
}

const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 300) : '';
export function describeAgentSpecialistProgressV1(runtime = {}, handoff = {}) {
  const agentId = text(handoff.agentId);
  const ownerships = (Array.isArray(runtime.specialistExecutionOwnerships) ? runtime.specialistExecutionOwnerships : [])
    .filter(item => item?.ownerId === agentId);
  const ownership = ownerships.length === 1 ? ownerships[0] : null;
  const node = (Array.isArray(runtime.plan?.nodes) ? runtime.plan.nodes : []).find(item => item.nodeId === ownership?.nodeId);
  const dispatch = runtime.specialistDispatchByAgentId?.[agentId];
  const automation = runtime.specialistAutomationByAgentId?.[agentId];
  let kind = 'PENDING';
  let label = 'підготовлено; виконання ще не підтверджене';
  if (!agentId || ownerships.length > 1) {
    kind = 'BLOCKED'; label = 'прив’язка результату неоднозначна; потрібне звіряння';
  } else if (['FAILED', 'CANCELLED'].includes(handoff.state)) {
    kind = 'BLOCKED'; label = handoff.state === 'FAILED' ? 'виконання завершилося помилкою' : 'виконання скасовано';
  } else if (ownership?.state === 'MANUAL_REVIEW' || dispatch?.state === 'MANUAL_REVIEW') {
    kind = 'BLOCKED'; label = 'потрібна ручна перевірка; повторне виконання заблоковано';
  } else if (ownership?.state === 'RECONCILE' || dispatch?.state === 'AMBIGUOUS' || automation?.status === 'BLOCKED_RECONCILIATION') {
    kind = 'BLOCKED'; label = 'результат дії невідомий; очікує звіряння без повторного запуску';
  } else if (ownership?.state === 'VERIFIED' && node?.state === 'VERIFIED' && text(node.evidence)) {
    kind = 'VERIFIED'; label = 'результат незалежно перевірено й записано в план';
  } else if (handoff.state === 'COMPLETED' || dispatch?.state === 'PROVIDER_SUCCEEDED') {
    kind = 'VERIFYING'; label = 'результат отримано; незалежне підтвердження ще не записане';
  } else if (automation?.status === 'RETRY_WAIT') {
    kind = 'WAITING'; label = 'очікує повторної перевірки готовності';
  } else if (handoff.state === 'LEASED' || ['PREPARED', 'DISPATCHING'].includes(dispatch?.state)) {
    kind = 'RUNNING'; label = 'виконується';
  }
  const details = [];
  if (automation?.lastErrorCode) details.push(`причина: ${text(automation.lastErrorCode)}`);
  if (Number.isFinite(automation?.nextAttemptAt) && automation.nextAttemptAt > 0) {
    const date = new Date(automation.nextAttemptAt);
    if (Number.isFinite(date.getTime())) details.push(`наступна перевірка: ${date.toLocaleString()}`);
  }
  if (node?.evidence && kind === 'VERIFIED') details.push(`свідчення: ${text(node.evidence)}`);
  return Object.freeze({ kind, label, details: details.join('; ') });
}
