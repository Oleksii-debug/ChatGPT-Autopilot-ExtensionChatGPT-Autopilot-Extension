const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REVISION_CURSORS = 32;
const MAX_RECURRENCE_OCCURRENCES = 1_000_000;

export const CalendarScheduleKind = Object.freeze({ ONE_TIME: 'ONE_TIME', DAILY: 'DAILY', WEEKLY: 'WEEKLY', EXPLICIT: 'EXPLICIT' });
export const CalendarCatchUp = Object.freeze({ OFF: 'OFF', ON: 'ON' });

function requireRecord(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`); }
function requireTimeZone(timeZone) { const value = String(timeZone || '').trim(); if (!value) throw new Error('Calendar schedule timeZone required'); try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); } catch { throw new Error('Invalid calendar schedule timeZone'); } return value; }
function parseDate(value, label = 'date') { const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value || '')); if (!match) throw new Error(`Invalid calendar schedule ${label}`); const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]); const probe = new Date(Date.UTC(year, month - 1, day)); if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) throw new Error(`Invalid calendar schedule ${label}`); return { year, month, day, key: `${match[1]}-${match[2]}-${match[3]}` }; }
function parseTime(value, label = 'time') { const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(String(value || '')); if (!match) throw new Error(`Invalid calendar schedule ${label}`); const hour = Number(match[1]); const minute = Number(match[2]); const second = Number(match[3] || 0); if (hour > 23 || minute > 59 || second > 59) throw new Error(`Invalid calendar schedule ${label}`); return { hour, minute, second, key: `${match[1]}:${match[2]}:${String(second).padStart(2, '0')}` }; }
const WEEKDAY_ALIASES = Object.freeze({
  MO: 1, MON: 1, MONDAY: 1,
  TU: 2, TUE: 2, TUESDAY: 2,
  WE: 3, WED: 3, WEDNESDAY: 3,
  TH: 4, THU: 4, THURSDAY: 4,
  FR: 5, FRI: 5, FRIDAY: 5,
  SA: 6, SAT: 6, SATURDAY: 6,
  SU: 7, SUN: 7, SUNDAY: 7,
});
function parseWeekday(value) { if (Number.isInteger(value) && value >= 1 && value <= 7) return value; if (typeof value === 'string') { const normalized = WEEKDAY_ALIASES[value.trim().toUpperCase()]; if (normalized) return normalized; } throw new Error('Invalid calendar schedule weekday'); }
function normalizeWeekdays(values) { if (!Array.isArray(values)) throw new Error('Calendar WEEKLY schedule weekdays required'); const weekdays = [...new Set(values.map(parseWeekday))].sort((a, b) => a - b); if (!weekdays.length || weekdays.length > 7) throw new Error('Calendar WEEKLY schedule requires 1-7 unique weekdays'); return weekdays; }
function normalizeMaxOccurrences(value) { if (value == null || value === '') return null; if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RECURRENCE_OCCURRENCES) throw new Error(`Calendar recurrence maxOccurrences must be 1-${MAX_RECURRENCE_OCCURRENCES}`); return value; }
function normalizeRecurrenceBounds(input, startDate) { const bounds = {}; if (input.endDate != null && input.endDate !== '') { const endDate = parseDate(input.endDate, 'endDate').key; if (endDate < startDate) throw new Error('Calendar recurrence endDate precedes startDate'); bounds.endDate = endDate; } const maxOccurrences = normalizeMaxOccurrences(input.maxOccurrences); if (maxOccurrences != null) bounds.maxOccurrences = maxOccurrences; return bounds; }
function isoWeekday(date) { const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay(); return day === 0 ? 7 : day; }
function daysBetween(start, end) { return Math.trunc((Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) / DAY_MS); }
function localPartsAt(epochMs, timeZone) { const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(epochMs)); const get = type => Number(parts.find(part => part.type === type)?.value); return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }; }
function localScalar(parts) { return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0); }
function offsetAt(epochMs, timeZone) { return localScalar(localPartsAt(epochMs, timeZone)) - epochMs; }
export function zonedDateTimeToEpochMs({ date, time, timeZone }) { const d = typeof date === 'string' ? parseDate(date) : date; const t = typeof time === 'string' ? parseTime(time) : time; const zone = requireTimeZone(timeZone); const wanted = { ...d, ...t }; const wantedScalar = localScalar(wanted); let guess = wantedScalar; for (let i = 0; i < 6; i += 1) { const actual = localPartsAt(guess, zone); const delta = wantedScalar - localScalar(actual); if (delta === 0) break; guess += delta; } const resolved = localPartsAt(guess, zone); if (localScalar(resolved) !== wantedScalar) throw new Error('Calendar wall time does not exist in configured timezone'); const offsets = new Set([offsetAt(guess - DAY_MS, zone), offsetAt(guess, zone), offsetAt(guess + DAY_MS, zone)]); const matches = [...offsets].map(offset => wantedScalar - offset).filter(epochMs => localScalar(localPartsAt(epochMs, zone)) === wantedScalar); if (new Set(matches).size !== 1) throw new Error('Calendar wall time is ambiguous in configured timezone'); return matches[0]; }
function addLocalDays(date, days) { const probe = new Date(Date.UTC(date.year, date.month - 1, date.day + days)); return { year: probe.getUTCFullYear(), month: probe.getUTCMonth() + 1, day: probe.getUTCDate(), key: probe.toISOString().slice(0, 10) }; }
function normalizeExplicitOccurrence(item, timeZone) { requireRecord(item, 'calendar occurrence'); const date = parseDate(item.date, 'occurrence date'); const time = parseTime(item.time, 'occurrence time'); const scheduledAt = zonedDateTimeToEpochMs({ date, time, timeZone }); return { date: date.key, time: time.key, scheduledAt }; }

export function normalizeCalendarSchedule(input) {
  requireRecord(input, 'calendar schedule'); const kind = String(input.kind || '').toUpperCase(); if (!Object.values(CalendarScheduleKind).includes(kind)) throw new Error('Invalid calendar schedule kind'); const timeZone = requireTimeZone(input.timeZone); const catchUp = String(input.catchUp || CalendarCatchUp.OFF).toUpperCase(); if (!Object.values(CalendarCatchUp).includes(catchUp)) throw new Error('Invalid calendar schedule catchUp'); const schedule = { kind, timeZone, catchUp };
  if (kind === CalendarScheduleKind.ONE_TIME) { const occurrence = normalizeExplicitOccurrence({ date: input.date, time: input.time }, timeZone); return { ...schedule, date: occurrence.date, time: occurrence.time }; }
  if (kind === CalendarScheduleKind.DAILY || kind === CalendarScheduleKind.WEEKLY) {
    const startDate = parseDate(input.startDate, 'startDate').key;
    const times = [...new Set((input.times || []).map(value => parseTime(value).key))].sort();
    if (!times.length || times.length > 48) throw new Error(`Calendar ${kind} schedule requires 1-48 unique times`);
    const recurrence = { ...schedule, startDate };
    if (kind === CalendarScheduleKind.WEEKLY) recurrence.weekdays = normalizeWeekdays(input.weekdays);
    recurrence.times = times;
    return { ...recurrence, ...normalizeRecurrenceBounds(input, startDate) };
  }
  const occurrences = (input.occurrences || []).map(item => normalizeExplicitOccurrence(item, timeZone)).sort((a, b) => a.scheduledAt - b.scheduledAt); if (!occurrences.length || occurrences.length > 10000) throw new Error('Calendar EXPLICIT schedule requires 1-10000 occurrences'); const seen = new Set(); for (const item of occurrences) { const key = `${item.date}T${item.time}`; if (seen.has(key)) throw new Error('Calendar EXPLICIT schedule contains duplicate occurrence'); seen.add(key); } return { ...schedule, occurrences: occurrences.map(({ date, time }) => ({ date, time })) };
}

function hash32function hash32(value, seed) { let hash = seed >>> 0; for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, '0'); }
function legacyRevisionForNormalized(schedule) { return `v1-${hash32(JSON.stringify(schedule), 2166136261)}`; }
export function calendarScheduleRevision(rawSchedule) { const schedule = normalizeCalendarSchedule(rawSchedule); const value = JSON.stringify(schedule); return `v2-${hash32(value, 2166136261)}${hash32(value, 3339675911)}${hash32(value, 668265263)}${hash32(value, 374761393)}`; }
export function occurrenceId(sessionId, scheduledAt, revision = 'legacy') { if (!sessionId) throw new Error('Calendar occurrence sessionId required'); return `${sessionId}@${revision}@${new Date(scheduledAt).toISOString()}`; }
function candidate(sessionId, schedule, revision, date, time) { const scheduledAt = zonedDateTimeToEpochMs({ date, time, timeZone: schedule.timeZone }); return { id: occurrenceId(sessionId, scheduledAt, revision), revision, scheduledAt, localDate: date.key, localTime: time.key }; }
function recurrenceAllowed(schedule, date, ordinal) {
  if (schedule.endDate && date.key > schedule.endDate) return false;
  if (schedule.maxOccurrences != null && ordinal > schedule.maxOccurrences) return false;
  return true;
}
function floorLocalDate(epochMs, timeZone) { const local = localPartsAt(epochMs, timeZone); return { year: local.year, month: local.month, day: local.day, key: `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}` }; }
function laterLocalDate(first, second) { return localScalar(first) >= localScalar(second) ? first : second; }
function selectedDatesBefore(startDate, date, weekdays) {
  const delta = daysBetween(startDate, date);
  if (delta <= 0) return 0;
  const fullWeeks = Math.floor(delta / 7);
  let count = fullWeeks * weekdays.length;
  const remainder = delta % 7;
  for (let offset = 0; offset < remainder; offset += 1) {
    if (weekdays.includes(isoWeekday(addLocalDays(startDate, fullWeeks * 7 + offset)))) count += 1;
  }
  return count;
}
function firstDailyCandidateOnOrAfter(sessionId, schedule, revision, searchDate, minEpoch) {
  const startDate = parseDate(schedule.startDate);
  let date = searchDate;
  for (;;) {
    if (schedule.endDate && date.key > schedule.endDate) return null;
    const dayIndex = daysBetween(startDate, date);
    for (let index = 0; index < schedule.times.length; index += 1) {
      const ordinal = dayIndex * schedule.times.length + index + 1;
      if (!recurrenceAllowed(schedule, date, ordinal)) return null;
      const item = candidate(sessionId, schedule, revision, date, parseTime(schedule.times[index]));
      if (item.scheduledAt >= minEpoch) return item;
    }
    date = addLocalDays(date, 1);
  }
}
function firstWeeklyCandidateOnOrAfter(sessionId, schedule, revision, searchDate, minEpoch) {
  const startDate = parseDate(schedule.startDate);
  let date = searchDate;
  for (;;) {
    if (schedule.endDate && date.key > schedule.endDate) return null;
    if (schedule.weekdays.includes(isoWeekday(date))) {
      const selectedBefore = selectedDatesBefore(startDate, date, schedule.weekdays);
      for (let index = 0; index < schedule.times.length; index += 1) {
        const ordinal = selectedBefore * schedule.times.length + index + 1;
        if (!recurrenceAllowed(schedule, date, ordinal)) return null;
        const item = candidate(sessionId, schedule, revision, date, parseTime(schedule.times[index]));
        if (item.scheduledAt >= minEpoch) return item;
      }
    }
    date = addLocalDays(date, 1);
  }
}
function revisionCursor(runtime, revision, schedule) { const cursors = runtime.reconciledThroughByRevision; if (cursors && Number.isFinite(cursors[revision])) return cursors[revision]; const legacy = legacyRevisionForNormalized(schedule); if (runtime.recurrenceRevision === legacy) { if (cursors && Number.isFinite(cursors[legacy])) return cursors[legacy]; if (Number.isFinite(runtime.reconciledThrough)) return runtime.reconciledThrough; } if (runtime.recurrenceRevision === revision && Number.isFinite(runtime.reconciledThrough)) return runtime.reconciledThrough; return null; }
function nextRecurring(sessionId, schedule, revision, runtime, now, finder) {
  const startDate = parseDate(schedule.startDate);
  const cursor = revisionCursor(runtime, revision, schedule);
  let floor;
  let searchDate;
  if (schedule.catchUp === CalendarCatchUp.OFF) {
    floor = Math.max(now, cursor == null ? -Infinity : cursor + 1);
    searchDate = laterLocalDate(startDate, floorLocalDate(floor, schedule.timeZone));
  } else if (cursor == null) {
    floor = -Infinity;
    searchDate = startDate;
  } else {
    floor = cursor + 1;
    searchDate = laterLocalDate(startDate, floorLocalDate(floor, schedule.timeZone));
  }
  const item = finder(sessionId, schedule, revision, searchDate, floor);
  if (!item) return null;
  return { ...item, due: item.scheduledAt <= now, catchUp: schedule.catchUp === CalendarCatchUp.ON && item.scheduledAt < now };
}
function nextDaily(sessionId, schedule, revision, runtime, now) { return nextRecurring(sessionId, schedule, revision, runtime, now, firstDailyCandidateOnOrAfter); }
function nextWeekly(sessionId, schedule, revision, runtime, now) { return nextRecurring(sessionId, schedule, revision, runtime, now, firstWeeklyCandidateOnOrAfter); }

export function nextCalendarOccurrenceexport function nextCalendarOccurrence({ sessionId, schedule: rawSchedule, runtime = {}, now = Date.now() }) {
  const schedule = normalizeCalendarSchedule(rawSchedule); const revision = calendarScheduleRevision(schedule);
  if (schedule.kind === CalendarScheduleKind.DAILY) return nextDaily(sessionId, schedule, revision, runtime, now);
  if (schedule.kind === CalendarScheduleKind.WEEKLY) return nextWeekly(sessionId, schedule, revision, runtime, now);
  const committed = new Set(Array.isArray(runtime.committedOccurrenceIds) ? runtime.committedOccurrenceIds : []); const cursor = revisionCursor(runtime, revision, schedule);
  const candidates = (schedule.kind === CalendarScheduleKind.ONE_TIME ? [candidate(sessionId, schedule, revision, parseDate(schedule.date), parseTime(schedule.time))] : schedule.occurrences.map(item => candidate(sessionId, schedule, revision, parseDate(item.date), parseTime(item.time)))).filter(item => !committed.has(item.id) && (cursor == null || item.scheduledAt > cursor));
  if (!candidates.length) return null; if (schedule.catchUp === CalendarCatchUp.ON) { const due = candidates.filter(item => item.scheduledAt <= now); if (due.length) return { ...due[0], due: true, catchUp: due[0].scheduledAt < now }; } const future = candidates.find(item => item.scheduledAt >= now); if (!future) return null; return { ...future, due: future.scheduledAt <= now, catchUp: false };
}

function boundedRevisionCursors(cursors, activeRevision, protectedRevisions, maxRevisionCursors) { const protectedSet = new Set([activeRevision, ...protectedRevisions]); const entries = Object.entries(cursors).sort((a, b) => b[1] - a[1]); const kept = entries.filter(([revision]) => protectedSet.has(revision)); for (const entry of entries) { if (kept.some(([revision]) => revision === entry[0])) continue; if (kept.length >= maxRevisionCursors) break; kept.push(entry); } return Object.fromEntries(kept); }
export function commitCalendarOccurrence(runtime = {}, occurrence, { maxHistory = 512, maxRevisionCursors = MAX_REVISION_CURSORS, protectedRevisions = runtime.unresolvedOccurrenceRevisions || [] } = {}) {
  if (!occurrence?.id || !occurrence?.revision) throw new Error('Calendar occurrence id/revision required'); const history = Array.isArray(runtime.committedOccurrenceIds) ? runtime.committedOccurrenceIds.filter(Boolean) : []; if (!history.includes(occurrence.id)) history.push(occurrence.id); const cursors = { ...(runtime.reconciledThroughByRevision || {}) }; cursors[occurrence.revision] = Math.max(Number.isFinite(cursors[occurrence.revision]) ? cursors[occurrence.revision] : -Infinity, occurrence.scheduledAt); const bounded = boundedRevisionCursors(cursors, occurrence.revision, Array.isArray(protectedRevisions) ? protectedRevisions : [], Math.max(1, maxRevisionCursors)); return { ...runtime, committedOccurrenceIds: history.slice(-Math.max(1, maxHistory)), lastCommittedOccurrenceId: occurrence.id, lastCommittedAt: occurrence.scheduledAt, recurrenceRevision: occurrence.revision, reconciledThrough: bounded[occurrence.revision], reconciledThroughByRevision: bounded };
}
