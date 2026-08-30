export const MAX_BULK_TASKS = 50;
export const MAX_PORTABLE_FILE_BYTES = 2 * 1024 * 1024;

function normalizeForDedupe(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['chatgpt.com', 'www.chatgpt.com'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('Only https://chatgpt.com URLs are allowed');
  }
  parsed.hostname = 'chatgpt.com';
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString();
}

export function extractChatGptUrls(text) {
  const source = String(text || '');
  const candidates = source.match(/https:\/\/(?:www\.)?chatgpt\.com\/[^\s<>"']+/gi) || [];
  const urls = [];
  const seen = new Set();
  for (let candidate of candidates) {
    candidate = candidate.replace(/[),.;\]}]+$/g, '');
    try {
      const normalized = normalizeForDedupe(candidate);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      urls.push(normalized);
    } catch {
      // Ignore non-ChatGPT or malformed URL fragments; the result summary tells
      // the user how many usable unique URLs were found.
    }
  }
  return urls;
}

export function mergeBulkUrls(existingTasks, urls, {
  replace = false,
  idFactory = () => crypto.randomUUID(),
  maxTasks = MAX_BULK_TASKS,
} = {}) {
  const current = Array.isArray(existingTasks) ? existingTasks : [];
  const normalizedExisting = new Map();
  for (const task of current) {
    try { normalizedExisting.set(normalizeForDedupe(task.url), task); } catch { /* incomplete draft */ }
  }

  const deduped = [];
  const seen = new Set();
  for (const url of urls || []) {
    try {
      const normalized = normalizeForDedupe(url);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      deduped.push(normalized);
    } catch { /* ignored */ }
  }

  let tasks;
  let added = 0;
  if (replace) {
    tasks = deduped.slice(0, maxTasks).map(url => {
      const existing = normalizedExisting.get(url);
      if (existing) return { ...existing, url };
      added += 1;
      return { id: idFactory(), enabled: true, label: '', url, promptOverride: '' };
    });
  } else {
    tasks = current.map(task => ({ ...task }));
    const occupied = new Set(normalizedExisting.keys());
    for (const url of deduped) {
      if (tasks.length >= maxTasks) break;
      if (occupied.has(url)) continue;
      occupied.add(url);
      tasks.push({ id: idFactory(), enabled: true, label: '', url, promptOverride: '' });
      added += 1;
    }
  }

  return {
    tasks,
    added,
    recognized: deduped.length,
    truncated: Math.max(0, (replace ? deduped.length : current.length + deduped.filter(url => !normalizedExisting.has(url)).length) - maxTasks),
  };
}

export function parsePortableJson(text) {
  const raw = String(text || '');
  if (!raw.trim()) throw new Error('Файл порожній.');
  if (new Blob([raw]).size > MAX_PORTABLE_FILE_BYTES) throw new Error('Файл більший за 2 МБ.');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error('Не вдалося прочитати JSON-файл налаштувань.');
  }
}
