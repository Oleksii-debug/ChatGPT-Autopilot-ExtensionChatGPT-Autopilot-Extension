const GITHUB_API_ORIGIN = 'https://api.github.com';
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const BRANCH_RE = /^(?!\/)(?!.*\.\.)(?!.*[~^:?*\[\\])(?!.*\/\/)(?!.*\.$)[^\s]+$/u;

export class GitHubCodeProviderError extends Error {
  constructor(code, message, { status = 0, details = null } = {}) {
    super(`${code}: ${message}`);
    this.name = 'GitHubCodeProviderError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function assertRepository(repository) {
  if (typeof repository !== 'string' || !REPOSITORY_RE.test(repository)) {
    throw new GitHubCodeProviderError('INVALID_REPOSITORY', 'Invalid repository');
  }
}

function assertBranch(branch) {
  if (typeof branch !== 'string' || branch.length > 255 || !BRANCH_RE.test(branch)) {
    throw new GitHubCodeProviderError('INVALID_BRANCH', 'Invalid branch');
  }
}

function assertPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('..') || path.includes('\\') || path.length > 1024) {
    throw new GitHubCodeProviderError('INVALID_PATH', 'Invalid repository path');
  }
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function apiUrl(repository, suffix) {
  const [owner, repo] = repository.split('/').map(encodeURIComponent);
  return `${GITHUB_API_ORIGIN}/repos/${owner}/${repo}${suffix}`;
}

function utf8Base64(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  if (typeof btoa !== 'function') throw new GitHubCodeProviderError('BASE64_UNAVAILABLE', 'Base64 encoder is unavailable');
  return btoa(binary);
}

function decodeBase64Utf8(value) {
  if (typeof atob !== 'function') throw new GitHubCodeProviderError('BASE64_UNAVAILABLE', 'Base64 decoder is unavailable');
  const binary = atob(String(value || '').replace(/\s+/gu, ''));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function headers(token, hasBody = false) {
  const result = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) result.Authorization = `Bearer ${token}`;
  if (hasBody) result['Content-Type'] = 'application/json';
  return result;
}

async function readPayload(response) {
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response?.ok) {
    const status = Number(response?.status || 0);
    const code = status === 401 ? 'UNAUTHORIZED'
      : status === 403 ? 'FORBIDDEN'
        : status === 404 ? 'NOT_FOUND'
          : status === 409 ? 'CONFLICT'
            : status === 422 ? 'VALIDATION_FAILED'
              : 'HTTP_ERROR';
    throw new GitHubCodeProviderError(code, payload?.message || `GitHub HTTP ${status || 0}`, { status, details: payload });
  }
  return payload;
}

export class GitHubCodeProvider {
  constructor({ repository, fetchFn = globalThis.fetch, getToken = null, protectedBranches = ['main', 'master'] } = {}) {
    assertRepository(repository);
    if (typeof fetchFn !== 'function') throw new GitHubCodeProviderError('INVALID_FETCH', 'fetch is unavailable');
    if (getToken !== null && typeof getToken !== 'function') throw new GitHubCodeProviderError('INVALID_TOKEN_PROVIDER', 'getToken must be a function');
    this.repository = repository;
    this.fetchFn = fetchFn;
    this.getToken = getToken;
    this.protectedBranches = new Set((Array.isArray(protectedBranches) ? protectedBranches : []).map(String));
  }

  async #token() {
    if (!this.getToken) return '';
    const token = await this.getToken();
    if (typeof token !== 'string' || !token.trim()) throw new GitHubCodeProviderError('MISSING_TOKEN', 'GitHub credential is unavailable');
    return token.trim();
  }

  async #request(method, suffix, body = null) {
    const token = await this.#token();
    let response;
    try {
      response = await this.fetchFn(apiUrl(this.repository, suffix), {
        method,
        headers: headers(token, body !== null),
        ...(body !== null ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new GitHubCodeProviderError('NETWORK_ERROR', error?.message || 'GitHub network failure');
    }
    return readPayload(response);
  }

  async readBranch(branch = 'main') {
    assertBranch(branch);
    const payload = await this.#request('GET', `/git/ref/heads/${encodeURIComponent(branch)}`);
    const sha = String(payload?.object?.sha || '');
    if (!/^[0-9a-f]{40}$/u.test(sha)) throw new GitHubCodeProviderError('INVALID_RESPONSE', 'Branch response has no commit SHA');
    return { branch, sha };
  }

  async createWorkBranch({ branch, base = 'main', expectedBaseSha = '' } = {}) {
    assertBranch(branch);
    assertBranch(base);
    if (this.protectedBranches.has(branch)) throw new GitHubCodeProviderError('PROTECTED_BRANCH', 'Direct work on a protected branch is not allowed');
    const baseState = await this.readBranch(base);
    if (expectedBaseSha && baseState.sha !== expectedBaseSha) {
      throw new GitHubCodeProviderError('STALE_BASE', 'Base branch moved before work branch creation', { details: { expectedBaseSha, actualBaseSha: baseState.sha } });
    }
    const payload = await this.#request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: baseState.sha });
    return { branch, base, baseSha: baseState.sha, ref: String(payload?.ref || '') };
  }

  async readFile({ path, ref = 'main' } = {}) {
    assertPath(path);
    assertBranch(ref);
    const payload = await this.#request('GET', `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
    if (payload?.type !== 'file' || typeof payload?.sha !== 'string') throw new GitHubCodeProviderError('INVALID_RESPONSE', 'Content response is not a file');
    return {
      path,
      ref,
      sha: payload.sha,
      content: payload.encoding === 'base64' ? decodeBase64Utf8(payload.content) : String(payload.content || ''),
    };
  }

  async writeFile({ path, branch, content, message, expectedSha = null } = {}) {
    assertPath(path);
    assertBranch(branch);
    if (this.protectedBranches.has(branch)) throw new GitHubCodeProviderError('PROTECTED_BRANCH', 'Direct write to a protected branch is not allowed');
    if (typeof content !== 'string') throw new GitHubCodeProviderError('INVALID_CONTENT', 'File content must be text');
    if (typeof message !== 'string' || !message.trim()) throw new GitHubCodeProviderError('INVALID_MESSAGE', 'Commit message is required');
    if (expectedSha !== null && !/^[0-9a-f]{40}$/u.test(String(expectedSha))) throw new GitHubCodeProviderError('INVALID_SHA', 'Expected file SHA is invalid');
    const payload = await this.#request('PUT', `/contents/${encodePath(path)}`, {
      message: message.trim(),
      content: utf8Base64(content),
      branch,
      ...(expectedSha ? { sha: expectedSha } : {}),
    });
    const commitSha = String(payload?.commit?.sha || '');
    const contentSha = String(payload?.content?.sha || '');
    if (!/^[0-9a-f]{40}$/u.test(commitSha) || !/^[0-9a-f]{40}$/u.test(contentSha)) {
      throw new GitHubCodeProviderError('INVALID_RESPONSE', 'Write response has invalid commit or content SHA');
    }
    return { path, branch, commitSha, contentSha };
  }

  async openPullRequest({ branch, base = 'main', title, body = '' } = {}) {
    assertBranch(branch);
    assertBranch(base);
    if (branch === base) throw new GitHubCodeProviderError('INVALID_BRANCH_PAIR', 'Head and base branches must differ');
    if (typeof title !== 'string' || !title.trim()) throw new GitHubCodeProviderError('INVALID_TITLE', 'Pull request title is required');
    const payload = await this.#request('POST', '/pulls', {
      head: branch,
      base,
      title: title.trim(),
      body: typeof body === 'string' ? body : '',
      maintainer_can_modify: true,
    });
    const number = Number(payload?.number || 0);
    if (!Number.isInteger(number) || number < 1) throw new GitHubCodeProviderError('INVALID_RESPONSE', 'Pull request response has invalid number');
    return { number, url: String(payload?.html_url || ''), headSha: String(payload?.head?.sha || '') };
  }
}
