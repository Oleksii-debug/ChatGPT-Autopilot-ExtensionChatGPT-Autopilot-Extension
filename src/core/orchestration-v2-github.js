import { ORCHESTRATION_CONTROL_MARKER, parseControlComment } from './orchestration-v2.js';

export class OrchestrationGitHubError extends Error {
  constructor(code, message, { status = 0, retryAfterAt = 0, rateLimitRemaining = null } = {}) {
    super(message);
    this.name = 'OrchestrationGitHubError';
    this.code = code;
    this.status = status;
    this.retryAfterAt = retryAfterAt;
    this.rateLimitRemaining = rateLimitRemaining;
  }
}

function parseRepository(repository) {
  const value = String(repository || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) throw new Error('Invalid GitHub repository');
  const [owner, repo] = value.split('/');
  return { owner, repo };
}

function headerNumber(response, name) {
  const raw = response?.headers?.get?.(name);
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function retryAfterFromResponse(response, nowMs) {
  const retrySeconds = headerNumber(response, 'retry-after');
  if (retrySeconds != null && retrySeconds >= 0) return nowMs + retrySeconds * 1000;
  const resetSeconds = headerNumber(response, 'x-ratelimit-reset');
  if (resetSeconds != null && resetSeconds > 0) return resetSeconds * 1000;
  return 0;
}

async function githubJson(fetchFn, url, nowMs) {
  let response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (error) {
    throw new OrchestrationGitHubError('GITHUB_NETWORK_ERROR', error?.message || 'GitHub network failure');
  }
  const remaining = headerNumber(response, 'x-ratelimit-remaining');
  if (!response?.ok) {
    const retryAfterAt = retryAfterFromResponse(response, nowMs);
    if (response?.status === 403 || response?.status === 429) {
      throw new OrchestrationGitHubError('GITHUB_RATE_LIMITED', 'GitHub control provider is rate-limited', {
        status: response.status,
        retryAfterAt,
        rateLimitRemaining: remaining,
      });
    }
    if (response?.status === 404) throw new OrchestrationGitHubError('GITHUB_CONTROL_NOT_FOUND', 'GitHub control location was not found', { status: 404, rateLimitRemaining: remaining });
    throw new OrchestrationGitHubError('GITHUB_HTTP_ERROR', `GitHub control HTTP ${response?.status || 0}`, { status: response?.status || 0, retryAfterAt, rateLimitRemaining: remaining });
  }
  let payload;
  try { payload = await response.json(); } catch { throw new OrchestrationGitHubError('GITHUB_INVALID_JSON', 'GitHub returned invalid JSON', { status: response.status, rateLimitRemaining: remaining }); }
  return { payload, rateLimitRemaining: remaining };
}

function parseCandidate(comment, options) {
  const body = typeof comment?.body === 'string' ? comment.body : '';
  if (!body.startsWith(ORCHESTRATION_CONTROL_MARKER)) return null;
  try {
    const parsed = parseControlComment(body, options);
    if (!parsed.executable) return null;
    return {
      commentId: Number(comment.id || 0),
      commentUrl: String(comment.html_url || comment.url || ''),
      updatedAt: String(comment.updated_at || ''),
      control: parsed.control,
    };
  } catch (error) {
    return { invalid: true, commentId: Number(comment.id || 0), error: error?.message || String(error) };
  }
}

export async function fetchGitHubOrchestrationControl({
  fetchFn = globalThis.fetch,
  repository,
  issueNumber,
  commentId = 0,
  projectId,
  coordinatorGeneration,
  lastAppliedRevision = 0,
  nowMs = Date.now(),
} = {}) {
  if (typeof fetchFn !== 'function') throw new Error('fetchFn required');
  const { owner, repo } = parseRepository(repository);
  const issue = Number(issueNumber);
  if (!Number.isInteger(issue) || issue < 1) throw new Error('Invalid GitHub issue number');
  const options = { projectId, coordinatorGeneration, nowMs };
  const diagnostics = [];
  let candidates = [];
  let remaining = null;

  if (Number(commentId) > 0) {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${Number(commentId)}`;
    const result = await githubJson(fetchFn, url, nowMs);
    remaining = result.rateLimitRemaining;
    const candidate = parseCandidate(result.payload, options);
    if (candidate?.invalid) diagnostics.push({ code: 'INVALID_CONTROL_COMMENT', commentId: candidate.commentId, message: candidate.error });
    else if (candidate) candidates.push(candidate);
  } else {
    // Discovery is a bounded bootstrap path only. Read issue metadata to locate
    // the newest comment pages instead of page 1 (which is the oldest history).
    // Once a canonical control comment is discovered, the controller persists
    // its id and all later polls use the direct comment endpoint.
    const issueUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue}`;
    const issueResult = await githubJson(fetchFn, issueUrl, nowMs);
    remaining = issueResult.rateLimitRemaining;
    const commentCount = Math.max(0, Number(issueResult.payload?.comments || 0));
    const lastPage = Math.max(1, Math.ceil(commentCount / 100));
    const firstPage = Math.max(1, lastPage - 2); // at most 300 newest comments during bootstrap
    for (let page = lastPage; page >= firstPage; page -= 1) {
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue}/comments?per_page=100&page=${page}`;
      const result = await githubJson(fetchFn, url, nowMs);
      if (result.rateLimitRemaining != null) remaining = result.rateLimitRemaining;
      if (!Array.isArray(result.payload)) throw new OrchestrationGitHubError('GITHUB_INVALID_COMMENTS', 'GitHub comments response is not an array');
      for (const comment of result.payload) {
        const candidate = parseCandidate(comment, options);
        if (candidate?.invalid) diagnostics.push({ code: 'INVALID_CONTROL_COMMENT', commentId: candidate.commentId, message: candidate.error });
        else if (candidate) candidates.push(candidate);
      }
    }
  }

  candidates = candidates
    .filter(item => item.control.revision > Number(lastAppliedRevision || 0))
    .sort((a, b) => b.control.revision - a.control.revision || b.commentId - a.commentId);

  return {
    selected: candidates[0] || null,
    unchanged: candidates.length === 0,
    diagnostics,
    rateLimitRemaining: remaining,
  };
}
