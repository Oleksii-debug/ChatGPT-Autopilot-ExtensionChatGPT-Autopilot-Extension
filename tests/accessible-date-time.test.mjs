import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAccessibleLocalDateTime,
  formatAccessibleLocalDateTime,
  normalizeAccessibleClockTime,
  normalizeAccessibleCalendarDate,
  formatAccessibleCalendarDate,
  parseAccessibleOccurrenceLine,
} from '../src/ui/accessible-date-time.js';

test('accessible local date-time accepts owner-friendly dotted format', () => {
  const epoch = parseAccessibleLocalDateTime('25.09.2026 04:00');
  const date = new Date(epoch);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 8);
  assert.equal(date.getDate(), 25);
  assert.equal(date.getHours(), 4);
  assert.equal(date.getMinutes(), 0);
  assert.equal(formatAccessibleLocalDateTime(epoch), '25.09.2026 04:00');
});

test('accessible local date-time preserves ISO text compatibility', () => {
  const dotted = parseAccessibleLocalDateTime('25.09.2026 09:15');
  const isoSpace = parseAccessibleLocalDateTime('2026-09-25 09:15');
  const isoT = parseAccessibleLocalDateTime('2026-09-25T09:15');
  assert.equal(isoSpace, dotted);
  assert.equal(isoT, dotted);
});

test('accessible local date-time rejects invalid calendar values', () => {
  assert.throws(() => parseAccessibleLocalDateTime('31.02.2026 04:00'), /Некоректна/);
  assert.throws(() => parseAccessibleLocalDateTime('25.09.2026 24:00'), /Некоректна/);
  assert.throws(() => parseAccessibleLocalDateTime('25-09-2026 04:00'), /формат/);
});

test('clock input is canonicalized without picker dependency', () => {
  assert.equal(normalizeAccessibleClockTime('9:15'), '09:15');
  assert.equal(normalizeAccessibleClockTime('23:59'), '23:59');
  assert.equal(normalizeAccessibleClockTime('4:00:07'), '04:00:07');
  assert.equal(normalizeAccessibleClockTime(''), '');
  assert.throws(() => normalizeAccessibleClockTime('24:00'), /Некоректний/);
});


test('Session calendar dates accept dotted owner format and normalize to canonical ISO', () => {
  assert.equal(normalizeAccessibleCalendarDate('25.09.2026'), '2026-09-25');
  assert.equal(normalizeAccessibleCalendarDate('2026-09-25'), '2026-09-25');
  assert.equal(formatAccessibleCalendarDate('2026-09-25'), '25.09.2026');
  assert.throws(() => normalizeAccessibleCalendarDate('31.02.2026'), /Некоректна/);
});

test('explicit occurrence lines accept dotted and legacy ISO forms', () => {
  assert.deepEqual(parseAccessibleOccurrenceLine('25.09.2026 09:15'), { date: '2026-09-25', time: '09:15' });
  assert.deepEqual(parseAccessibleOccurrenceLine('2026-09-25 9:15'), { date: '2026-09-25', time: '09:15' });
  assert.deepEqual(parseAccessibleOccurrenceLine('25.09.2026 09:15:30'), { date: '2026-09-25', time: '09:15:30' });
});
