export const DRIVE_SCALAR_PROVIDER_V1 = 'drive-scalar-v1';
export const DRIVE_SCALAR_DEFAULT_POLL_INTERVAL_MS = 3 * 60 * 1000;
export const DRIVE_SCALAR_MIN_POLL_INTERVAL_MS = 60 * 1000;
export const DRIVE_SCALAR_MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);
const MAX_SCALAR_BYTES = 128;
const MAX_REVISION_DIGITS = 128;

export class DriveScalarProviderError extends Error {
  constructor(code, message, { retryable = false, status = 0, details = null } = {}) {
    super(message);
    this.name = 'DriveScalarProviderError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.details = details;
  }
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requireId(value, label) {
  const normalized = clean(String(value ?? ''));
  if (!normalized || normalized.length > 180 || !/^[A-Za-z0-9._:@/+-]+$/u.test(normalized)) {
    throw new DriveScalarProviderError('INVALID_CONFIG', `Invalid ${label}`);
  }
  return normalized;
}

export function normalizeDriveProviderRevision(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/u.test(raw) || raw.length > MAX_REVISION_DIGITS) {
    throw new DriveScalarProviderError('INVALID_VERSION', 'Drive version must be a bounded decimal integer.');
  }
  const canonical = raw.replace(/^0+(?=\d)/u, '');
  return canonical || '0';
}

export function compareDriveProviderRevisions(left, right) {
  const a = normalizeDriveProviderRevision(left);
  const b = normalizeDriveProviderRevision(right);
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function parseDriveScalarContent(value, maxWorkers) {
  const maximum = Number(maxWorkers);
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 1000) {
    throw new DriveScalarProviderError('INVALID_CONFIG', 'Invalid maxWorkers.');
  }
  if (typeof value !== 'string') {
    throw new DriveScalarProviderError('INVALID_SCALAR', 'Drive scalar content must be text.');
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_SCALAR_BYTES) {
    throw new DriveScalarProviderError('INVALID_SCALAR', 'Drive scalar content is too large.');
  }
  const scalar = value.trim();
  if (!/^(?:0|[1-9]\d*)$/u.test(scalar)) {
    throw new DriveScalarProviderError('INVALID_SCALAR', 'Drive scalar must contain exactly one non-negative integer.');
  }
  const requestedSlotCount = Number(scalar);
  if (!Number.isSafeInteger(requestedSlotCount) || requestedSlotCount > maximum) {
    throw new DriveScalarProviderError('OUT_OF_RANGE', `Drive scalar must be in range 0..${maximum}.`);
  }
  return requestedSlotCount;
}

function normalizeMetadata(raw, expectedSourceId = '') {
  const sourceId = clean(raw?.id);
  if (!sourceId || (expectedSourceId && sourceId !== expectedSourceId)) {
    throw new DriveScalarProviderError('FILE_ID_CHANGED', 'Drive file identity is missing or changed during read.');
  }
  return {
    id: sourceId,
    version: normalizeDriveProviderRevision(raw?.version),
    mimeType: clean(raw?.mimeType),
  };
}

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

export class DriveScalarProviderV1 {
  constructor({
    readMetadata,
    readContent,
    maxAttempts = 3,
    retryDelayMs = 250,
    sleepFn = sleep,
  } = {}) {
    if (typeof readMetadata !== 'function' || typeof readContent !== 'function') {
      throw new DriveScalarProviderError('INVALID_READER', 'Drive scalar metadata/content readers are required.');
    }
    this.readMetadata = readMetadata;
    this.readContent = readContent;
    this.maxAttempts = Number.isInteger(maxAttempts) ? Math.max(1, Math.min(maxAttempts, 5)) : 3;
    this.retryDelayMs = Math.max(0, Math.min(Number(retryDelayMs) || 0, 5000));
    this.sleepFn = typeof sleepFn === 'function' ? sleepFn : sleep;
  }

  async read({ groupNodeId, maxWorkers, sourceId } = {}) {
    const group = requireId(groupNodeId, 'groupNodeId');
    const source = requireId(sourceId, 'sourceId');
    const maximum = Number(maxWorkers);
    if (!Number.isInteger(maximum) || maximum < 0 || maximum > 1000) {
      throw new DriveScalarProviderError('INVALID_CONFIG', 'Invalid maxWorkers.');
    }

    let lastBefore = '';
    let lastAfter = '';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const before = normalizeMetadata(await this.readMetadata({ sourceId: source }), source);
      lastBefore = before.version;
      const content = await this.readContent({ sourceId: source, metadata: before });
      const requestedSlotCount = parseDriveScalarContent(content, maximum);
      const after = normalizeMetadata(await this.readMetadata({ sourceId: source }), source);
      lastAfter = after.version;
      if (before.version !== after.version) {
        if (attempt < this.maxAttempts) {
          await this.sleepFn(this.retryDelayMs * attempt);
          continue;
        }
        throw new DriveScalarProviderError(
          'VERSION_RACE',
          `Drive file changed during stable read (${before.version} -> ${after.version}).`,
          { retryable: true, details: { versionBefore: before.version, versionAfter: after.version, attempts: attempt } },
        );
      }
      return {
        providerId: DRIVE_SCALAR_PROVIDER_V1,
        groupNodeId: group,
        sourceId: source,
        providerRevision: after.version,
        requestedSlotCount,
        attempts: attempt,
      };
    }

    throw new DriveScalarProviderError(
      'VERSION_RACE',
      `Drive file did not stabilize (${lastBefore} -> ${lastAfter}).`,
      { retryable: true },
    );
  }
}

function driveApiUrl(path, params = {}) {
  const url = new URL(`${DRIVE_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

async function checkedFetch(fetchFn, url, options = {}) {
  let response;
  try {
    response = await fetchFn(url, options);
  } catch (error) {
    throw new DriveScalarProviderError('NETWORK', 'Google Drive request failed.', { retryable: true, details: error?.message || '' });
  }
  if (response?.ok) return response;
  const status = Number(response?.status || 0);
  const retryable = [408, 429, 500, 502, 503, 504].includes(status);
  const code = status === 401 ? 'AUTH_REQUIRED'
    : status === 403 ? 'ACCESS_DENIED'
      : status === 404 ? 'NOT_FOUND'
        : 'HTTP_ERROR';
  throw new DriveScalarProviderError(code, `Google Drive HTTP ${status || 'error'}.`, { retryable, status });
}

async function bearer(getAccessToken) {
  if (typeof getAccessToken !== 'function') {
    throw new DriveScalarProviderError('AUTH_REQUIRED', 'Google Drive access-token provider is not configured.');
  }
  const token = clean(await getAccessToken());
  if (!token) throw new DriveScalarProviderError('AUTH_REQUIRED', 'Google Drive access token is unavailable.');
  return token;
}

export function extractGoogleDriveScalarSourceId(value) {
  const raw = clean(String(value ?? ''));
  if (/^[A-Za-z0-9_-]{6,256}$/u.test(raw)) return raw;
  let url;
  try { url = new URL(raw); } catch {
    throw new DriveScalarProviderError('INVALID_SOURCE', 'Invalid Google Drive file reference.');
  }
  const host = url.hostname.toLowerCase();
  let id = '';
  if (host === 'docs.google.com') {
    id = url.pathname.match(/^\/document\/d\/([^/]+)/u)?.[1] || '';
  } else if (host === 'drive.google.com') {
    id = url.pathname.match(/^\/file\/d\/([^/]+)/u)?.[1] || url.searchParams.get('id') || '';
  }
  try { id = decodeURIComponent(id); } catch { id = ''; }
  if (!/^[A-Za-z0-9_-]{6,256}$/u.test(id)) {
    throw new DriveScalarProviderError('INVALID_SOURCE', 'Invalid Google Drive file reference.');
  }
  return id;
}

export function createGoogleDriveScalarReader({
  fileId,
  getAccessToken,
  fetchFn = globalThis.fetch,
} = {}) {
  const sourceId = extractGoogleDriveScalarSourceId(fileId);
  if (typeof fetchFn !== 'function') throw new DriveScalarProviderError('INVALID_READER', 'fetch is unavailable.');

  return {
    sourceId,
    async readMetadata() {
      const token = await bearer(getAccessToken);
      const response = await checkedFetch(
        fetchFn,
        driveApiUrl(`/files/${encodeURIComponent(sourceId)}`, { fields: 'id,version,mimeType' }),
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const body = await response.json();
      return normalizeMetadata(body, sourceId);
    },
    async readContent({ metadata } = {}) {
      const token = await bearer(getAccessToken);
      const mimeType = clean(metadata?.mimeType);
      let url;
      if (mimeType === GOOGLE_DOC_MIME) {
        url = driveApiUrl(`/files/${encodeURIComponent(sourceId)}/export`, { mimeType: 'text/plain' });
      } else if (TEXT_MIME_TYPES.has(mimeType)) {
        url = driveApiUrl(`/files/${encodeURIComponent(sourceId)}`, { alt: 'media' });
      } else {
        throw new DriveScalarProviderError('UNSUPPORTED_MIME', `Unsupported Drive scalar MIME type: ${mimeType || 'unknown'}.`);
      }
      const response = await checkedFetch(
        fetchFn,
        url,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const content = await response.text();
      if (new TextEncoder().encode(content).byteLength > MAX_SCALAR_BYTES) {
        throw new DriveScalarProviderError('INVALID_SCALAR', 'Drive scalar content is too large.');
      }
      return content;
    },
  };
}
