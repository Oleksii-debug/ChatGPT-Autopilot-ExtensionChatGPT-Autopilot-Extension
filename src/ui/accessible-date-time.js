function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseDateTimeParts(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  let match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})[ T](\d{1,2}):(\d{2})$/u.exec(value);
  let year;
  let month;
  let day;
  let hour;
  let minute;
  if (match) {
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
    hour = Number(match[4]);
    minute = Number(match[5]);
  } else {
    match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/u.exec(value);
    if (!match) {
      throw new Error('Використайте формат ДД.ММ.РРРР ГГ:ХХ, наприклад 25.09.2026 04:00.');
    }
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
    hour = Number(match[4]);
    minute = Number(match[5]);
  }

  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31
      || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('Некоректна дата або час.');
  }

  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (date.getFullYear() !== year
      || date.getMonth() !== month - 1
      || date.getDate() !== day
      || date.getHours() !== hour
      || date.getMinutes() !== minute) {
    throw new Error('Некоректна або неіснуюча локальна дата/час.');
  }
  return { year, month, day, hour, minute, epochMs: date.getTime() };
}

export function parseAccessibleLocalDateTime(raw, { optional = true } = {}) {
  const value = String(raw || '').trim();
  if (!value) {
    if (optional) return 0;
    throw new Error('Вкажіть дату й час.');
  }
  return parseDateTimeParts(value).epochMs;
}

export function formatAccessibleLocalDateTime(value) {
  const epochMs = Number(value || 0);
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '';
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime())) return '';
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function normalizeAccessibleClockTime(raw, { optional = true } = {}) {
  const value = String(raw || '').trim();
  if (!value) {
    if (optional) return '';
    throw new Error('Вкажіть час.');
  }
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error('Використайте формат ГГ:ХХ, наприклад 09:15.');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error('Некоректний час.');
  return `${pad2(hour)}:${pad2(minute)}`;
}


export function normalizeAccessibleCalendarDate(raw, { optional = false } = {}) {
  const value = String(raw || '').trim();
  if (!value) {
    if (optional) return '';
    throw new Error('Вкажіть дату.');
  }
  let match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/u.exec(value);
  let year;
  let month;
  let day;
  if (match) {
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  } else {
    match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(value);
    if (!match) throw new Error('Використайте формат ДД.ММ.РРРР, наприклад 25.09.2026.');
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  }
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error('Некоректна дата.');
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error('Некоректна дата.');
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function formatAccessibleCalendarDate(value) {
  const iso = normalizeAccessibleCalendarDate(value, { optional: true });
  if (!iso) return '';
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

export function parseAccessibleOccurrenceLine(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('Порожній рядок запуску.');
  const match = /^(.+?)\s+(\d{1,2}:\d{2}(?::\d{2})?)$/u.exec(value);
  if (!match) {
    throw new Error('Використайте формат ДД.ММ.РРРР ГГ:ХХ, наприклад 25.09.2026 09:15.');
  }
  const date = normalizeAccessibleCalendarDate(match[1]);
  const timeParts = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(match[2]);
  if (!timeParts) throw new Error('Некоректний час.');
  const hour = Number(timeParts[1]);
  const minute = Number(timeParts[2]);
  const second = Number(timeParts[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) throw new Error('Некоректний час.');
  const time = timeParts[3] === undefined
    ? `${pad2(hour)}:${pad2(minute)}`
    : `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
  return { date, time };
}
