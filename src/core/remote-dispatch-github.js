import { selectApplicableRemoteDispatch } from './remote-dispatch.js';

export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_COMMENTS_PER_PAGE = 100;
export const GITHUB_MAX_INCREMENTAL_PAGES = 5;
export const GITHUB_INCREMENTAL_OVERLAP_MS = 5 * 60 * 1000;

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

async function readJson(response, label) {
  if (!response?.ok) {
    const status = Number(response?.status || 0);
    const remaining = rateLimitRemaining(response);
    const code = status === 403 && remaining === 0 ? 'RATE_LIMITED' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR';
    throw new RemoteDispatchGitHubError(code, `${label} failed with HTTP ${status || 'unknown'}`, {
      status,
      retryAfterSeconds: retryAfterSeconds(response),
      rateLimitRemaining: remaining,
    });
  }
  try {
    return await response.json();
  } catch {
    throw new RemoteDispatchGitHubError('INVALID_RESPONSE', `${label} returned invalid JSON`, { status: Number(response.status || 0) });
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
  if (!Number.isInteger(comment.id) && typeof comment.id !== 'number') return null;
  if (typeof comment.body !== 'string') return null;
  return {
    id: String(comment.id),
    body: comment.body,
    createdAt: typeof comment.created_at === 'string' ? comment.created_at : '',
    updatedAt: typeof comment.updated_at === 'string' ? comment.updated_at : '',
    htmlUrl: typeof comment.html_url === 'string' ? comment.html_url : '',
  };
}

async function fetchIssueMetadata(fetchFn, repository, issueNumber, signal) {
  const url = apiUrl(repository, `/issues/${issueNumber}`);
  const response = await fetchFn(url, { method: 'GET', headers: githubHeaders(), signal });
  const json = await readJson(response, 'GitHub issue metadata');
  const comments = Number(json?.comments);
  if (!Number.isInteger(comments) || comments < 0) throw new RemoteDispatchGitHubError('INVALID_RESPONSE', 'GitHub issue metadata has invalid comments count');
  return { comments };
}

async function fetchCommentsPage(fetchFn, repository, issueNumber, { page, since = '', signal }) {
  const url = apiUrl(repository, `/issues/${issueNumber}/comments`, {
    per_page: GITHUB_COMMENTS_PER_PAGE,
    page,
    since,
  });
  const response = await fetchFn(url, { method: 'GET', headers: githubHeaders(), signal });
  const json = await readJson(response, 'GitHub issue comments');
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
} = {}) {
  validateConfig(repository, issueNumber);
  if (typeof fetchFn !== 'function') throw new RemoteDispatchGitHubError('INVALID_CONFIG', 'fetch is unavailable');
  if (!Number.isFinite(sinceMs) || sinceMs < 0) throw new RemoteDispatchGitHubError('INVALID_CONFIG', 'Invalid sinceMs');
  if (!Number.isInteger(maxIncrementalPages) || maxIncrementalPages < 1 || maxIncrementalPages > 20) throw new RemoteDispatchGitHubError('INVALID_CONFIG', 'Invalid maxIncrementalPages');

  if (sinceMs <= 0) {
    const metadata = await fetchIssueMetadata(fetchFn, repository, issueNumber, signal);
    if (metadata.comments === 0) return { comments: [], initial: true, pagesFetched: 0, rateLimitRemaining: null };
    const lastPage = Math.max(1, Math.ceil(metadata.comments / GITHUB_COMMENTS_PER_PAGE));
    const page = await fetchCommentsPage(fetchFn, repository, issueNumber, { page: lastPage, signal });
    return { comments: page.comments, initial: true, pagesFetched: 1, rateLimitRemaining: page.rateLimitRemaining };
  }

  const overlapSinceMs = Math.max(0, sinceMs - GITHUB_INCREMENTAL_OVERLAP_MS);
  const since = new Date(overlapSinceMs).toISOString();
  const commentsById = new Map();
  let lastRemaining = null;
  let pagesFetched = 0;
  for (let pageNumber = 1; pageNumber <= maxIncrementalPages; pageNumber += 1) {
    const page = await fetchCommentsPage(fetchFn, repository, issueNumber, { page: pageNumber, since, signal });
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
} = {}) {
  if (typeof projectId !== 'string' || !projectId) throw new RemoteDispatchGitHubError('INVALID_CONFIG', 'Invalid projectId');
  const fetched = await fetchGitHubDispatchComments({ fetchFn, repository, issueNumber, sinceMs, signal });
  const selected = selectApplicableRemoteDispatch(fetched.comments.map(comment => ({ id: comment.id, body: comment.body })), { projectId, nowMs });
  const selectedComment = selected.selected ? fetched.comments.find(comment => comment.id === selected.selected.commentId) || null : null;
  return {
    ...fetched,
    selected: selected.selected ? { ...selected.selected, comment: selectedComment } : null,
    diagnostics: selected.diagnostics,
  };
}
