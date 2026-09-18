import { readStableDriveSnapshot } from './drive-snapshot.js';

export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const MAX_CONTENT_BYTES = 1024 * 1024;
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

export class DriveApiError extends Error {
  constructor(code, message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'DriveApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function extractDriveFileId(urlText) {
  const url = new URL(String(urlText || '').trim());
  const host = url.hostname.toLowerCase();
  if (host === 'docs.google.com') {
    const match = url.pathname.match(/^\/document\/d\/([^/]+)/);
    if (match) return { fileId: decodeURIComponent(match[1]), kind: 'google-doc' };
  }
  if (host === 'drive.google.com') {
    const match = url.pathname.match(/^\/file\/d\/([^/]+)/);
    const id = match?.[1] || url.searchParams.get('id');
    if (id) return { fileId: decodeURIComponent(id), kind: 'drive-file' };
  }
  throw new DriveApiError('INVALID_URL', 'Потрібне посилання на Google Docs або Google Drive файл.');
}

async function readJson(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { body, text };
}

async function checkedFetch(fetchImpl, url, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (error) {
    throw new DriveApiError('NETWORK', 'Не вдалося підключитися до Google Drive.', { retryable: true, cause: error });
  }
  if (response.ok) return response;
  const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
  const { body } = await readJson(response);
  const reason = body?.error?.message || `Google Drive HTTP ${response.status}.`;
  if (response.status === 401) throw new DriveApiError('AUTH_REQUIRED', 'Потрібна авторизація Google Drive.', { status: 401 });
  if (response.status === 403) throw new DriveApiError('ACCESS_DENIED', 'Немає доступу до цього Google Drive файла.', { status: 403 });
  if (response.status === 404) throw new DriveApiError('NOT_FOUND', 'Google Drive файл не знайдено.', { status: 404 });
  throw new DriveApiError('HTTP_ERROR', reason, { status: response.status, retryable });
}

function apiUrl(path, params = {}) {
  const url = new URL(`${DRIVE_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

async function getFileMetadata(fileId, accessToken, fetchImpl = globalThis.fetch) {
  if (!accessToken) throw new DriveApiError('AUTH_REQUIRED', 'Потрібен OAuth access token для Drive API.');
  const response = await checkedFetch(fetchImpl, apiUrl(`/files/${encodeURIComponent(fileId)}`, {
    fields: 'id,version,mimeType,name,modifiedTime,size,webViewLink',
  }), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const { body } = await readJson(response);
  if (!body?.id || body.id !== fileId || body.version === undefined) {
    throw new DriveApiError('INVALID_METADATA', 'Google Drive не повернув необхідні metadata файла.');
  }
  return body;
}

async function readContent(metadata, accessToken, fetchImpl = globalThis.fetch) {
  const mimeType = String(metadata?.mimeType || '');
  let url;
  if (mimeType === GOOGLE_DOC_MIME) {
    url = apiUrl(`/files/${encodeURIComponent(metadata.id)}/export`, { mimeType: 'text/plain' });
  } else if (TEXT_MIME_TYPES.has(mimeType)) {
    url = apiUrl(`/files/${encodeURIComponent(metadata.id)}`, { alt: 'media' });
  } else {
    throw new DriveApiError('UNSUPPORTED_MIME', `Google Drive файл має непідтримуваний тип: ${mimeType || 'невідомий'}.`);
  }
  const response = await checkedFetch(fetchImpl, url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_CONTENT_BYTES) {
    throw new DriveApiError('TOO_LARGE', 'Google Drive файл завеликий для prompt-а (понад 1 МБ).');
  }
  const content = await response.text();
  if (new TextEncoder().encode(content).byteLength > MAX_CONTENT_BYTES) {
    throw new DriveApiError('TOO_LARGE', 'Google Drive файл завеликий для prompt-а (понад 1 МБ).');
  }
  if (!content.trim()) throw new DriveApiError('EMPTY_CONTENT', 'Google Drive файл порожній.');
  return content;
}

export async function readAuthorizedDriveSnapshot({ fileId, accessToken, fetchImpl = globalThis.fetch, hashContent, maxAttempts = 3, retryDelayMs = 250 }) {
  if (!fileId) throw new DriveApiError('INVALID_FILE_ID', 'Потрібен Google Drive fileId.');
  if (!accessToken) throw new DriveApiError('AUTH_REQUIRED', 'Потрібна авторизація Google Drive.');
  return readStableDriveSnapshot({
    readMetadata: () => getFileMetadata(fileId, accessToken, fetchImpl),
    readContent: metadata => readContent(metadata, accessToken, fetchImpl),
    hashContent,
    maxAttempts,
    retryDelayMs,
  });
}

export async function listAuthorizedDriveFiles({ accessToken, fetchImpl = globalThis.fetch, pageSize = 50 } = {}) {
  if (!accessToken) throw new DriveApiError('AUTH_REQUIRED', 'Потрібна авторизація Google Drive.');
  const response = await checkedFetch(fetchImpl, apiUrl('/files', {
    q: 'trashed = false',
    pageSize: Math.min(100, Math.max(1, Number(pageSize) || 50)),
    orderBy: 'modifiedTime desc,name',
    fields: 'files(id,name,mimeType,modifiedTime,version,webViewLink),nextPageToken',
  }), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const { body } = await readJson(response);
  return Array.isArray(body?.files) ? body.files : [];
}
