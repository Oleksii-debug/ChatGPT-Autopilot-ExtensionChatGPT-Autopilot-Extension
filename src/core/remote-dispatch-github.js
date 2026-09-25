import { selectApplicableRemoteDispatch } from './remote-dispatch.js';

export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_COMMENTS_PER_PAGE = 100;
export const GITHUB_MAX_INCREMENTAL_PAGES = 5;
export const GITHUB_INCREMENTAL_OVERLAP_MS = 5 * 60 * 1000;
export const GITHUB_RESPONSE_MAX_BYTES = 4_000_000;
export const GITHUB_RESPONSE_MAX_CHUNKS = 8192;
export const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export class RemoteDispatchGitHubError extends Error {
  constructor(code, message, { status = 0, retryAfterSeconds = 0, rateLimitRemaining = null } = {}) {
    super(`${code}: ${message}`);
    this.name = 'RemoteDispatchGitHubError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.rateLimitRemaining = rateLimitRemaining;
  }
}

function validateConfig(repository, issueNumber) {
  if (typeof repository !== 'string' || !REPOSITORY_RE.test(repository)) throw new RemoteDispatchGitHubError('INVALID_CONFIG', 'Invalid GitHub repository');
  if (!Number.isInteger(issueNumber) || issueNumber < 1 || issueNumber > Number.MAX_SAFE_INTEGER) throw new RemoteDispatchGitHubError('INVALID_CONFIG', 'Invalid GitHub issue number');
}

function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function rateLimitRemaining(response) {
  const raw = response.headers?.get?.('x-ratelimit-remaining');
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function retryAfterSeconds(response) {
  const raw = response.headers?.get?.('retry-after');
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function isGitHubSecondaryRateLimitPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = typeof value.message === 'string' ? value.message.slice(0, 1000) : '';
  const documentationUrl = typeof value.documentation_url === 'string' ? value.documentation_url.slice(0, 1000) : '';
  return /\bsecondary rate limit\b/i.test(message)
    || /\babuse detection mechanism\b/i.test(message)
    || (/rate-limits-for-the-rest-api/i.test(documentationUrl) && /secondary/i.test(`${message} ${documentationUrl}`));
}

function abortError() {
  const error = new Error('GitHub request aborted');
  error.name = 'AbortError';
  return error;
}

function responseContentLength(response) {
  try {
    const raw = response?.headers?.get?.('content-length');
    if (typeof raw !== 'string' || !/^\\d+$/u.test(raw)) return null;
    const parsed = BigInt(raw);
    return parsed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(parsed);
  } catch {
    return null;
  }
}

async function readResponseTextBounded(response, label, controller) {
  const status = Number(response?.status || 0);
  if (controller.signal.aborted) throw abortError();
  const declaredLength = responseContentLength(response);
  if (declaredLength != null && declaredLength > GITHUB_RESPONSE_MAX_BYTES) {
    try { await response?.body?.cancel?.(); } catch {}
    controller.abort();
    throw new RemoteDispatchGitHubError('RESPONSE_TOO_LARGE', `${label} exceeds the bounded response size`, { status });
  }
  if (!response?.body || typeof response.body.getReader !== 'function') {
    throw new RemoteDispatchGitHubError('INVALID_RESPONSE', `${label} does not expose a bounded readable byte stream`, { status });
  }

  let reader;
  try {
    reader = response.body.getReader();
  } catch (error) {
    throw new RemoteDispatchGitHubError('RESPONSE_READ_FAILED', error?.message || `${label} response stream could not be opened`, { status });
  }

  const chunks = [];
  let total = 0;
  let chunkCount = 0;
  try {
    for (;;) {
      if (controller.signal.aborted) throw abortError();
      const next = await reader.read();
      if (controller.signal.aborted) throw abortError();
      if (next?.done) break;
      if (!(next?.value instanceof Uint8Array)) {
        try { await reader.cancel(); } catch {}
        throw new RemoteDispatchGitHubError('INVALID_RESPONSE', `${label} returned invalid response bytes`, { status });
      }
      chunkCount += 1;
      if (chunkCount > GITHUB_RESPONSE_MAX_CHUNKS) {
        try { await reader.cancel(); } catch {}
        controller.abort();
        throw new RemoteDispatchGitHubError('RESPONSE_TOO_LARGE', `${label} exceeds the bounded stream chunk count`, { status });
      }
      if (next.value.byteLength > GITHUB_RESPONSE_MAX_BYTES - total) {
        try { await reader.cancel(); } catch {}
        controller.abort();
        throw new RemoteDispatchGitHubError('RESPONSE_TOO_LARGE', `${label} exceeds the bounded response size`, { status });
      }
      total += next.value.byteLength;
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof RemoteDispatchGitHubError) throw error;
    if (controller.signal.aborted || error?.name === 'AbortError') throw abortError();
    try { await reader.cancel(); } catch {}
    throw new RemoteDispatchGitHubError('RESPONSE_READ_FAILED', error?.message || `${label} response could not be read`, { status });
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RemoteDispatchGitHubError('INVALID_RESPONSE', `${label} returned invalid UTF-8`, { status });
  }
}

async function readJson(response, label, controller) {
  const status = Number(response?.status || 0);
  const remaining = rateLimitRemaining(response);
  const retryAfter = retryAfterSeconds(response);
  const text = await readResponseTextBounded(response, label, controller);
  let payload = null;
  let parsed = true;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    parsed = false;
  }

  if (!response?.ok) {
    const rateLimited = status === 429 || (status === 403 && (remaining === 0 || retryAfter > 0 || (parsed && isGitHubSecondaryRateLimitPayload(payload))));
    const code = rateLimited ? 'RATE_LIMITED' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR';
    throw new RemoteDispatchGitHubError(code, `${label} failed with HTTP ${status || 'unknown'}`, {
      status,
      retryAfterSeconds: retryAfter,
      rateLimitRemaining: remaining,
    });
  }
  if (!parsed) {
    throw new RemoteDispatchGitHubError('INVALID_RESPONSE', `${label} returned invalid JSON`, { status });
  }
  return payload;
}

function validateRequestTimeoutMs(value) {
  if (!Number.isInteger(value) || value < 1 || value > 120_000) {
    throw new RemoteDispatchGitHubError('INVALID_CONFIG', 'Invalid GitHub request timeout');
  }
  return value;
}

function validateAbortSignal(signal) {
  if (signal == null) return null;
  if (typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function') {
    throw new RemoteDispatchGitHubError('INVALID_CONFIG', 'Invalid AbortSignal');
  }
  return signal;
}

async function githubJsonRequest(fetchFn, url, label, {
  signal = null,
  requestTimeoutMs = GITHUB_REQUEST_TIMEOUT_MS,
} = {}) {
  const externalSignal = validateAbortSignal(signal);
  const timeoutMs = validateRequestTimeoutMs(requestTimeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  const relayAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', relayAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let response;
    try {
      response = await fetchFn(url, {
        method: 'GET',
        redirect: 'error',
        headers: githubHeaders(),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) throw new RemoteDispatchGitHubError('REQUEST_TIMEOUT', `${label} timed out`);
      if (externalSignal?.aborted || (controller.signal.aborted && !timedOut)) {
        throw new RemoteDispatchGitHubError('REQUEST_ABORTED', `${label} was aborted`);
      }
      throw new RemoteDispatchGitHubError('NETWORK_ERROR', error?.message || `${label} network request failed`);
    }

    try {
      const json = await readJson(response, label, controller);
      return { response, json };
    } catch (error) {
      if (error instanceof RemoteDispatchGitHubError) {
        if (error.code === 'RESPONSE_TOO_LARGE' || error.code === 'INVALID_RESPONSE' || error.code === 'RESPONSE_READ_FAILED'
            || error.code === 'RATE_LIMITED' || error.code === 'NOT_FOUND' || error.code === 'HTTP_ERROR') throw error;
      }
      if (timedOut) throw new RemoteDispatchGitHubError('REQUEST_TIMEOUT', `${label} timed out`, { status: Number(response?.status || 0) });
      if (externalSignal?.aborted || controller.signal.aborted) {
        throw new RemoteDispatchGitHubError('REQUEST_ABORTED', `${label} was aborted`, { status: Number(response?.status || 0) });
      }
      throw error;
    }
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', relayAbort);
  }
}

function apiUrl(repository, path, params = {}) {
  const [owner, repo] = repository.split('/').map(encodeURIComponent);
  const url = new URL(`${GITHUB_API_ORIGIN}/repos/${owner}/${repo}${path}`);
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  return url.toString();
}

function normalizeComment(comment) {
  if (!comment || typeof comment !== 'object') return null;
  if (!Number.isSafeInteger(comment.id) || comment.id < 1) return null;
  if (typeof comment.body !== 'string') return null;
  return {
    id: String(comment.id),
    body: comment.body,
    createdAt: typeof comment.created_at === 'string' ? comment.created_at : '',
    updatedAt: typeof comment.updated_at === 'string' ? comment.updated_at : '',
    htmlUrl: typeof comment.html_url === 'string' ? comment.html_url : '',
  };
}

async function fetchIssueMetadata(fetchFn, repository, issueNumber, { signal, requestTimeoutMs }) {
  const url = apiUrl(repository, `/issues/${issueNumber}`);
  const { json } = await githubJsonRequest(fetchFn, url, 'GitHub issue metadata', { signal, requestTimeoutMs });
  const comments = Number(json?.comments);
  if (!Number.isInteger(comments) || comments < 0) throw new RemoteDispatchGitHubError('INVALID_RESPONSE', 'GitHub issue metadata has invalid comments count');
  return { comments };
}

async function fetchCommentsPage(fetchFn, repository, issueNumber, { page, since = '', signal, requestTimeoutMs }) {
  const url = apiUrl(repository, `/issues/${issueNumber}/comments`, {
    per_page: GITHUB_COMMENTS_PER_PAGE,
    page,
    since,
  });
  const { response, json } = await githubJsonRequest(fetchFn, url, 'GitHub issue comments', { signal, requestTimeoutMs });
  if (!Array.isArray(json)) throw new RemoteDispatchGitHubError('INVALID_RESPONSE', 'GitHub issue comments response is not an array');
  return {
    comments: json.map(normalizeComment).filter(Boolean),
    rateLimitRemaining: rateLimitRemaining(response),
  };
}

export async function fetchGitHubDispatchComments({
  fetchFn = globalThis.fetch,
  repository,
  issueNumber,
  sinceMs = 0,
  signal,
  maxIncrementalPages = GITHUB_MAX_INCREMENTAL_PAGES,
  requestTimeoutMs = GITHUB_REQUEST_TIMEOUT_MS,
} = {}) {
  validateConfig(repository, issueNumber);
  if (typeof fetchFn !== 'function') throw new RemoteDispatchGitHubError('INVALID_CONFIG', 'fetch is unavailable');
  if (!Number.isFinite(sinceMs) || sinceMs < 0) throw new RemoteDispatchGitHubError('INVALID_CONFIG', 'Invalid sinceMs');
  if (!Number.isInteger(maxIncrementalPages) || maxIncrementalPages < 1 || maxIncrementalPages > 20) throw new RemoteDispatchGitHubError('INVALID_CONFIG', 'Invalid maxIncrementalPages');
  validateAbortSignal(signal);
  validateRequestTimeoutMs(requestTimeoutMs);

  if (sinceMs <= 0) {
    const metadata = await fetchIssueMetadata(fetchFn, repository, issueNumber, { signal, requestTimeoutMs });
    if (metadata.comments === 0) return { comments: [], initial: true, pagesFetched: 0, rateLimitRemaining: null };
    const lastPage = Math.max(1, Math.ceil(metadata.comments / GITHUB_COMMENTS_PER_PAGE));
    const page = await fetchCommentsPage(fetchFn, repository, issueNumber, { page: lastPage, signal, requestTimeoutMs });
    return { comments: page.comments, initial: true, pagesFetched: 1, rateLimitRemaining: page.rateLimitRemaining };
  }

  const overlapSinceMs = Math.max(0, sinceMs - GITHUB_INCREMENTAL_OVERLAP_MS);
  const since = new Date(overlapSinceMs).toISOString();
  const commentsById = new Map();
  let lastRemaining = null;
  let pagesFetched = 0;
  for (let pageNumber = 1; pageNumber <= maxIncrementalPages; pageNumber += 1) {
    const page = await fetchCommentsPage(fetchFn, repository, issueNumber, { page: pageNumber, since, signal, requestTimeoutMs });
    pagesFetched += 1;
    lastRemaining = page.rateLimitRemaining;
    for (const comment of page.comments) commentsById.set(comment.id, comment);
    if (page.comments.length < GITHUB_COMMENTS_PER_PAGE) break;
    if (pageNumber === maxIncrementalPages) throw new RemoteDispatchGitHubError('PAGE_LIMIT', 'GitHub incremental comment burst exceeds bounded page limit');
  }
  return { comments: [...commentsById.values()], initial: false, pagesFetched, rateLimitRemaining: lastRemaining };
}

export async function fetchLatestGitHubRemoteDispatch({
  fetchFn = globalThis.fetch,
  repository,
  issueNumber,
  projectId,
  sinceMs = 0,
  nowMs = Date.now(),
  signal,
  requestTimeoutMs = GITHUB_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof projectId !== 'string' || !projectId) throw new RemoteDispatchGitHubError('INVALID_CONFIG', 'Invalid projectId');
  const fetched = await fetchGitHubDispatchComments({ fetchFn, repository, issueNumber, sinceMs, signal, requestTimeoutMs });
  const selected = selectApplicableRemoteDispatch(fetched.comments.map(comment => ({ id: comment.id, body: comment.body })), { projectId, nowMs });
  const selectedComment = selected.selected ? fetched.comments.find(comment => comment.id === selected.selected.commentId) || null : null;
  return {
    ...fetched,
    selected: selected.selected ? { ...selected.selected, comment: selectedComment } : null,
    diagnostics: selected.diagnostics,
  };
}
