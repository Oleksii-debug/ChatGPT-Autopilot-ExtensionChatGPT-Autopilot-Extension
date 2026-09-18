export const SchedulingClass = Object.freeze({
  ORDINARY: 'ORDINARY',
  MANAGED: 'MANAGED',
});

export function sessionSchedulingClass(session) {
  return (
    session?.scenarioWork?.managed === true
    || session?.orchestrationWorker?.managed === true
    || session?.orchestrationCoordinator?.managed === true
    || session?.remoteDispatch?.managed === true
  ) ? SchedulingClass.MANAGED : SchedulingClass.ORDINARY;
}

function stableSessionIds(state) {
  const seen = new Set();
  const ids = [];
  for (const id of state?.sessionOrder || []) {
    if (!seen.has(id) && state.sessionsById?.[id]) {
      ids.push(id);
      seen.add(id);
    }
  }
  for (const id of Object.keys(state?.sessionsById || {})) {
    if (!seen.has(id)) ids.push(id);
  }
  return ids;
}

function rotateAfter(ids, id) {
  const index = id ? ids.indexOf(id) : -1;
  return index < 0 ? ids : [...ids.slice(index + 1), ...ids.slice(0, index + 1)];
}

function interleaveByClass(primary, secondary) {
  const ordered = [];
  const max = Math.max(primary.length, secondary.length);
  for (let index = 0; index < max; index += 1) {
    if (index < primary.length) ordered.push(primary[index]);
    if (index < secondary.length) ordered.push(secondary[index]);
  }
  return ordered;
}

export function orderedSessionIdsForFairness(state) {
  const stable = stableSessionIds(state);
  if (stable.length < 2) return stable;

  const arbiter = state?.sendArbiter || {};
  const rotated = rotateAfter(stable, arbiter.lastSentSessionId || '');
  const ordinary = rotated.filter(id => sessionSchedulingClass(state.sessionsById?.[id]) === SchedulingClass.ORDINARY);
  const managed = rotated.filter(id => sessionSchedulingClass(state.sessionsById?.[id]) === SchedulingClass.MANAGED);
  if (!ordinary.length || !managed.length) return rotated;

  let lastClass = arbiter.lastSentSchedulingClass;
  if (!Object.values(SchedulingClass).includes(lastClass)) {
    const last = state.sessionsById?.[arbiter.lastSentSessionId];
    lastClass = last ? sessionSchedulingClass(last) : '';
  }

  // Two independent scheduling classes must both receive bounded runtime starts even
  // when the active-session count exceeds the profile concurrency limit. A class
  // block (all ordinary followed by all managed, or vice versa) can still starve the
  // other class if the first N lanes stall. Interleaving makes the bound explicit:
  // with concurrency >= 2, both classes enter every mixed batch.
  let preferred = '';
  if (lastClass === SchedulingClass.MANAGED) preferred = SchedulingClass.ORDINARY;
  else if (lastClass === SchedulingClass.ORDINARY) preferred = SchedulingClass.MANAGED;
  else preferred = sessionSchedulingClass(state.sessionsById?.[rotated[0]]);

  return preferred === SchedulingClass.ORDINARY
    ? interleaveByClass(ordinary, managed)
    : interleaveByClass(managed, ordinary);
}
