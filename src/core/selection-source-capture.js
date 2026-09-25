import {
  SelectionActionContractVersion,
  SelectionActionSourceKind,
  normalizeSelectionActionSourceV1,
} from './selection-action.js';

const MAX_CAPTURE_TEXT = 100_000;
const MAX_TAB_TITLE = 500;
const REQUEST_KEYS = new Set(['tabId', 'kind']);

function snapshotRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${String(key)} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function requireTabId(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('tabId must be a positive safe integer');
  }
  return value;
}

function requireKind(value) {
  if (![SelectionActionSourceKind.SELECTION, SelectionActionSourceKind.CURRENT_PAGE].includes(value)) {
    throw new Error('source kind must be SELECTION or CURRENT_PAGE');
  }
  return value;
}

function httpUrl(value, label = 'tab URL') {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`${label} must be an exact HTTP(S) URL`);
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be an exact HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.href !== value) {
    throw new Error(`${label} must be an exact HTTP(S) URL`);
  }
  return parsed.href;
}

function originPattern(url) {
  return `${new URL(url).origin}/*`;
}

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_TAB_TITLE);
}

function snapshotCaptureResult(value) {
  const raw = snapshotRecord(value, new Set(['url', 'text', 'tooLarge', 'length']), 'captured page source');
  const url = httpUrl(raw.url, 'captured page URL');
  if (raw.tooLarge === true) {
    if (!Number.isSafeInteger(raw.length) || raw.length <= MAX_CAPTURE_TEXT) {
      throw new Error('captured page returned invalid oversized-text evidence');
    }
    return Object.freeze({ url, text: '', tooLarge: true, length: raw.length });
  }
  if (raw.tooLarge !== false) throw new Error('captured page tooLarge flag is invalid');
  if (typeof raw.text !== 'string' || !raw.text.trim()) throw new Error('captured source text is empty');
  if (raw.text.length > MAX_CAPTURE_TEXT) throw new Error('captured source text exceeds the 100000 character limit');
  if (raw.length !== raw.text.length) throw new Error('captured source length does not match content');
  return Object.freeze({ url, text: raw.text, tooLarge: false, length: raw.length });
}

/**
 * This function is serialized into the selected page by chrome.scripting.
 * It is deliberately self-contained and read-only.
 */
export function captureSelectionSourceInPage(kind) {
  const max = 100000;
  const source = kind === 'SELECTION'
    ? String(globalThis.getSelection?.()?.toString?.() || '')
    : String(document.body?.innerText || document.documentElement?.innerText || '');
  const url = String(globalThis.location?.href || '');
  if (source.length > max) return { url, text: '', tooLarge: true, length: source.length };
  return { url, text: source, tooLarge: false, length: source.length };
}

export class SelectionSourceCaptureV1 {
  constructor({ chromeApi, now = () => Date.now() } = {}) {
    if (!chromeApi?.tabs?.query || !chromeApi?.tabs?.get || !chromeApi?.scripting?.executeScript || !chromeApi?.permissions?.contains) {
      throw new Error('Selection source capture requires tabs, scripting, and permissions APIs');
    }
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.chrome = chromeApi;
    this.now = now;
  }

  async hasOriginPermission(url) {
    try {
      return await this.chrome.permissions.contains({ origins: [originPattern(url)] }) === true;
    } catch {
      return false;
    }
  }

  async listTabs() {
    const tabs = await this.chrome.tabs.query({});
    const candidates = [];
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      if (!Number.isSafeInteger(tab?.id) || tab.id <= 0) continue;
      let url;
      try { url = httpUrl(tab.url); } catch { continue; }
      candidates.push(Object.freeze({
        tabId: tab.id,
        title: cleanTitle(tab.title),
        url,
        active: tab.active === true,
        captureAllowed: await this.hasOriginPermission(url),
      }));
    }
    candidates.sort((left, right) => (
      Number(right.active) - Number(left.active)
      || left.title.localeCompare(right.title)
      || left.url.localeCompare(right.url)
      || left.tabId - right.tabId
    ));
    return Object.freeze({ tabs: Object.freeze(candidates) });
  }

  async capture(input = {}) {
    const raw = snapshotRecord(input, REQUEST_KEYS, 'Selection source capture request');
    const tabId = requireTabId(raw.tabId);
    const kind = requireKind(raw.kind);

    const before = await this.chrome.tabs.get(tabId);
    const beforeUrl = httpUrl(before?.url);
    if (!(await this.hasOriginPermission(beforeUrl))) {
      throw new Error('Site permission must already be granted before capturing page content');
    }

    const results = await this.chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: captureSelectionSourceInPage,
      args: [kind],
    });
    const top = (Array.isArray(results) ? results : []).find(item => item?.frameId === 0) || null;
    if (!top || !Object.prototype.hasOwnProperty.call(top, 'result')) {
      throw new Error('Could not capture the selected page');
    }
    const captured = snapshotCaptureResult(top.result);
    if (captured.tooLarge) {
      throw new Error('Captured source exceeds 100000 characters; select a smaller portion of the page');
    }

    const after = await this.chrome.tabs.get(tabId);
    const afterUrl = httpUrl(after?.url);
    if (afterUrl !== captured.url || afterUrl !== beforeUrl) {
      throw new Error('Selected tab navigated while source content was being captured');
    }
    if (!(await this.hasOriginPermission(afterUrl))) {
      throw new Error('Site permission changed while source content was being captured');
    }

    const capturedAtMs = this.now();
    if (typeof capturedAtMs !== 'number' || !Number.isFinite(capturedAtMs)) throw new Error('capture clock is invalid');
    const capturedAt = new Date(capturedAtMs).toISOString();
    const source = normalizeSelectionActionSourceV1({
      schemaVersion: SelectionActionContractVersion,
      sourceId: `browser-source:${tabId}:${capturedAtMs}`,
      kind,
      capturedAt,
      text: captured.text,
      uri: captured.url,
      artifactId: null,
      contentSha256: '',
    });
    return Object.freeze({
      source,
      tab: Object.freeze({
        tabId,
        title: cleanTitle(after?.title),
        url: afterUrl,
      }),
    });
  }
}
