export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GitHubFileWriteMode = Object.freeze({ CREATE: 'create', UPDATE: 'update' });

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const GIT_SHA = /^[a-f0-9]{40,64}$/iu;
const REF = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\.lock(?:\/|$))[A-Za-z0-9._\/-]{1,240}$/u;
const MAX_TEXT = 1_500_000;
const MAX_PATH = 4096;
const MAX_BODY_TEXT = 256_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const MAX_RESPONSE_CHUNKS = 8192;
const SAFE_HTTP_FAILURES = new Set([400, 401, 403, 404, 405, 409, 412, 415, 422, 429]);
const PULL_REQUEST_MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);

function clean(value, max = MAX_PATH) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function githubError(code, message, {
  effectMayHaveOccurred = false,
  safeToRetry = false,
  status = 0,
} = {}) {
  const error = new Error(clean(message, 4000) || 'GitHub request failed');
  error.name = 'GitHubRestClientError';
  error.code = clean(code, 120) || 'GITHUB_REQUEST_FAILED';
  error.effectMayHaveOccurred = Boolean(effectMayHaveOccurred);
  error.safeToRetry = Boolean(safeToRetry);
  error.status = Number.isInteger(status) ? status : 0;
  return error;
}

function repositoryName(value) {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!out || out.length > 300 || !REPOSITORY.test(out) || out.includes('..')) {
    throw githubError('GITHUB_INVALID_REQUEST', 'repositoryFullName is invalid', { safeToRetry: true });
  }
  return out;
}

function sha(value, label = 'sha') {
  const out = clean(value, 80);
  if (!GIT_SHA.test(out)) throw githubError('GITHUB_INVALID_REQUEST', `${label} is invalid`, { safeToRetry: true });
  return out.toLowerCase();
}

function responseSha(value, label = 'sha', { effectMayHaveOccurred = false } = {}) {
  const out = clean(value, 80);
  if (!GIT_SHA.test(out)) {
    throw githubError('GITHUB_RESPONSE_INVALID', `GitHub returned invalid ${label}`, {
      effectMayHaveOccurred,
      safeToRetry: !effectMayHaveOccurred,
    });
  }
  return out.toLowerCase();
}

function refName(value, label = 'ref') {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!out || out.length > 240 || !REF.test(out) || out.endsWith('/') || out.startsWith('.') || out.includes('//')) {
    throw githubError('GITHUB_INVALID_REQUEST', `${label} is invalid`, { safeToRetry: true });
  }
  return out;
}

function repositoryFromApiPath(pathname) {
  if (typeof pathname !== 'string'
    || pathname.length > 8192
    || !pathname.startsWith('/repos/')
    || pathname.includes('://')
    || pathname.includes('\\')
    || pathname.includes('#')) {
    throw githubError('GITHUB_INVALID_REQUEST', 'GitHub path is outside the repository API boundary', { safeToRetry: true });
  }
  const pathOnly = pathname.split('?', 1)[0];
  let parsed;
  try {
    parsed = new URL(`${GITHUB_API_ORIGIN}${pathname}`);
  } catch {
    throw githubError('GITHUB_INVALID_REQUEST', 'GitHub repository path is not a canonical URL path', { safeToRetry: true });
  }
  // WHATWG URL parsing normalizes raw and percent-encoded dot segments before
  // transport. Admission must bind the exact path that fetch will send, not a
  // pre-normalization spelling that could escape the admitted repository.
  if (parsed.origin !== GITHUB_API_ORIGIN || parsed.pathname !== pathOnly) {
    throw githubError('GITHUB_INVALID_REQUEST', 'GitHub repository path is not canonical', { safeToRetry: true });
  }
  const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/u.exec(pathOnly);
  if (!match || match[1].includes('%') || match[2].includes('%')) {
    throw githubError('GITHUB_INVALID_REQUEST', 'GitHub repository path identity is invalid', { safeToRetry: true });
  }
  return repositoryName(`${match[1]}/${match[2]}`);
}

function repositoryPath(value) {
  return repositoryName(value).split('/').map(encodeURIComponent).join('/');
}

function refPath(value) {
  return refName(value).split('/').map(encodeURIComponent).join('/');
}

function filePath(value) {
  if (typeof value !== 'string') throw githubError('GITHUB_INVALID_REQUEST', 'path must be text', { safeToRetry: true });
  const normalized = value.replace(/\\/gu, '/').trim();
  if (!normalized || normalized.length > MAX_PATH || normalized.startsWith('/') || normalized.endsWith('/')) {
    throw githubError('GITHUB_INVALID_REQUEST', 'path is invalid', { safeToRetry: true });
  }
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw githubError('GITHUB_INVALID_REQUEST', 'path contains an invalid segment', { safeToRetry: true });
  }
  return segments.map(encodeURIComponent).join('/');
}

function requiredText(value, label, max = MAX_BODY_TEXT) {
  if (typeof value !== 'string') throw githubError('GITHUB_INVALID_REQUEST', `${label} must be text`, { safeToRetry: true });
  const out = value.trim();
  if (!out || out.length > max) throw githubError('GITHUB_INVALID_REQUEST', `${label} is invalid`, { safeToRetry: true });
  return out;
}

function optionalText(value, label, max = MAX_BODY_TEXT) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) throw githubError('GITHUB_INVALID_REQUEST', `${label} is invalid`, { safeToRetry: true });
  return value;
}

function exactRepositoryName(value) {
  const repository = repositoryName(value);
  if (typeof value !== 'string' || value !== repository) {
    throw githubError('GITHUB_INVALID_REQUEST', 'repositoryFullName must be exact canonical text', { safeToRetry: true });
  }
  return repository;
}

function positiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw githubError('GITHUB_INVALID_REQUEST', `${label} must be a positive safe integer`, { safeToRetry: true });
  }
  return value;
}

function responsePositiveInteger(value, label, { effectMayHaveOccurred = false } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw githubError('GITHUB_RESPONSE_INVALID', `GitHub returned invalid ${label}`, {
      effectMayHaveOccurred,
      safeToRetry: !effectMayHaveOccurred,
    });
  }
  return value;
}

function exactNonBlankText(value, label, max = MAX_BODY_TEXT) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw githubError('GITHUB_INVALID_REQUEST', `${label} is invalid`, { safeToRetry: true });
  }
  return value;
}

function responseText(value, label, max = MAX_BODY_TEXT, { nullable = false, effectMayHaveOccurred = false } = {}) {
  if (nullable && value == null) return '';
  if (typeof value !== 'string' || value.length > max) {
    throw githubError('GITHUB_RESPONSE_INVALID', `GitHub returned invalid ${label}`, {
      effectMayHaveOccurred,
      safeToRetry: !effectMayHaveOccurred,
    });
  }
  return value;
}

function encodeBase64Utf8(value) {
  if (typeof value !== 'string') throw githubError('GITHUB_INVALID_REQUEST', 'contentUtf8 must be text', { safeToRetry: true });
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > 750_000) throw githubError('GITHUB_INVALID_REQUEST', 'contentUtf8 exceeds the bounded GitHub file size', { safeToRetry: true });
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function decodeBase64Utf8(value) {
  const source = String(value || '').replace(/\s+/gu, '');
  if (!source || source.length > 1_400_000 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(source)) {
    throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub returned invalid base64 file content');
  }
  let binary;
  try { binary = atob(source); }
  catch { throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub returned invalid base64 file content'); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub file is not valid UTF-8 text'); }
}

function safeJson(text, {
  effectMayHaveOccurred = false,
  safeToRetry = true,
  status = 0,
} = {}) {
  if (!text) return {};
  if (text.length > MAX_TEXT) {
    throw githubError('GITHUB_RESPONSE_TOO_LARGE', 'GitHub response exceeds the bounded response size', {
      effectMayHaveOccurred,
      safeToRetry,
      status,
    });
  }
  try { return JSON.parse(text); }
  catch {
    throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub returned invalid JSON', {
      effectMayHaveOccurred,
      safeToRetry,
      status,
    });
  }
}

function responseMessage(payload, status) {
  const message = payload && typeof payload === 'object' && !Array.isArray(payload) ? clean(payload.message, 1000) : '';
  return message ? `GitHub HTTP ${status}: ${message}` : `GitHub HTTP ${status}`;
}

function responseReadError(code, message, {
  effectMayHaveOccurred,
  safeToRetry,
  status,
} = {}) {
  return githubError(code, message, { effectMayHaveOccurred, safeToRetry, status });
}

async function readResponseTextBounded(response, {
  controller,
  effectMayHaveOccurred = false,
  safeToRetry = true,
  status = 0,
} = {}) {
  const errorOptions = { effectMayHaveOccurred, safeToRetry, status };
  const timeoutError = () => responseReadError(
    'GITHUB_REQUEST_TIMEOUT',
    'GitHub request timed out while reading the response',
    errorOptions,
  );

  if (controller?.signal?.aborted) throw timeoutError();
  if (!response || typeof response !== 'object') {
    throw responseReadError('GITHUB_RESPONSE_READ_FAILED', 'GitHub response is unavailable', errorOptions);
  }

  let declaredLength = null;
  try {
    const rawLength = response.headers?.get?.('content-length');
    if (typeof rawLength === 'string' && /^\d+$/u.test(rawLength)) {
      const parsed = BigInt(rawLength);
      declaredLength = parsed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(parsed);
    }
  } catch {
    declaredLength = null;
  }

  if (declaredLength != null && declaredLength > MAX_RESPONSE_BYTES) {
    try { await response.body?.cancel?.(); } catch {}
    try { controller?.abort(); } catch {}
    throw responseReadError(
      'GITHUB_RESPONSE_TOO_LARGE',
      'GitHub response exceeds the bounded response size',
      errorOptions,
    );
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    throw responseReadError(
      'GITHUB_RESPONSE_READ_FAILED',
      'GitHub response does not expose a bounded readable byte stream',
      errorOptions,
    );
  }

  let reader;
  try {
    reader = response.body.getReader();
  } catch (error) {
    throw responseReadError(
      'GITHUB_RESPONSE_READ_FAILED',
      error?.message || 'GitHub response stream could not be opened',
      errorOptions,
    );
  }

  const chunks = [];
  let total = 0;
  let chunkCount = 0;
  try {
    for (;;) {
      if (controller?.signal?.aborted) throw timeoutError();
      const next = await reader.read();
      if (controller?.signal?.aborted) throw timeoutError();
      if (next?.done) break;
      if (!(next?.value instanceof Uint8Array)) {
        throw responseReadError(
          'GITHUB_RESPONSE_READ_FAILED',
          'GitHub response stream returned invalid bytes',
          errorOptions,
        );
      }
      chunkCount += 1;
      if (chunkCount > MAX_RESPONSE_CHUNKS) {
        try { await reader.cancel(); } catch {}
        try { controller?.abort(); } catch {}
        throw responseReadError(
          'GITHUB_RESPONSE_TOO_LARGE',
          'GitHub response exceeds the bounded stream chunk count',
          errorOptions,
        );
      }
      if (next.value.byteLength > MAX_RESPONSE_BYTES - total) {
        try { await reader.cancel(); } catch {}
        try { controller?.abort(); } catch {}
        throw responseReadError(
          'GITHUB_RESPONSE_TOO_LARGE',
          'GitHub response exceeds the bounded response size',
          errorOptions,
        );
      }
      total += next.value.byteLength;
      chunks.push(next.value);
    }
  } catch (error) {
    if (error?.name === 'GitHubRestClientError') throw error;
    const timedOut = Boolean(controller?.signal?.aborted) || error?.name === 'AbortError';
    throw timedOut
      ? timeoutError()
      : responseReadError(
        'GITHUB_RESPONSE_READ_FAILED',
        error?.message || 'GitHub response could not be read',
        errorOptions,
      );
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
    throw responseReadError('GITHUB_RESPONSE_INVALID', 'GitHub response is not valid UTF-8', errorOptions);
  }
}

export class GitHubRestClientV1 {
  constructor({
    nativeClient,
    credentialId,
    allowedRepositories = [],
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 30_000,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
  } = {}) {
    if (!nativeClient?.resolveCredential) throw new Error('Native Companion credential resolver is required');
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 300_000) {
      throw new Error('GitHub requestTimeoutMs must be an integer between 1000 and 300000');
    }
    if (typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function') {
      throw new Error('GitHub timeout scheduler is required');
    }
    const id = typeof credentialId === 'string' ? credentialId.trim() : '';
    if (!id || id.length > 128) throw new Error('GitHub credentialId is required');
    if (!Array.isArray(allowedRepositories) || !allowedRepositories.length || allowedRepositories.length > 128) {
      throw new Error('GitHub allowedRepositories must be a non-empty bounded array');
    }
    const normalized = allowedRepositories.map(repositoryName);
    if (new Set(normalized.map(item => item.toLowerCase())).size !== normalized.length) throw new Error('GitHub allowedRepositories contains duplicates');
    this.nativeClient = nativeClient;
    this.credentialId = id;
    this.allowedRepositories = Object.freeze(normalized);
    this.allowedRepositoryKeys = new Set(normalized.map(item => item.toLowerCase()));
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
  }

  assertRepositoryAllowed(repositoryFullName) {
    const repository = repositoryName(repositoryFullName);
    if (!this.allowedRepositoryKeys.has(repository.toLowerCase())) {
      throw githubError('GITHUB_REPOSITORY_NOT_ALLOWED', 'Repository is outside the owner-configured GitHub allowlist', { safeToRetry: true });
    }
    return repository;
  }

  async request(method, pathname, { body = null, effectful = false, expectedStatuses = [200] } = {}) {
    const verb = String(method || '').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(verb)) throw githubError('GITHUB_INVALID_REQUEST', 'Unsupported GitHub HTTP method', { safeToRetry: true });
    const repository = repositoryFromApiPath(pathname);
    if (!this.allowedRepositoryKeys.has(repository.toLowerCase())) {
      throw githubError('GITHUB_REPOSITORY_NOT_ALLOWED', 'Repository is outside the owner-configured GitHub allowlist', { safeToRetry: true });
    }
    let credential;
    try {
      credential = await this.nativeClient.resolveCredential({ credentialId: this.credentialId, targetOrigin: GITHUB_API_ORIGIN });
    } catch (error) {
      throw githubError(error?.code || 'GITHUB_CREDENTIAL_UNAVAILABLE', error?.message || 'GitHub credential is unavailable', { safeToRetry: true });
    }
    let secret = typeof credential?.secret === 'string' ? credential.secret : '';
    if (!secret || secret.length > 100_000) throw githubError('GITHUB_CREDENTIAL_INVALID', 'GitHub credential secret is unavailable', { safeToRetry: true });

    let response;
    const controller = new AbortController();
    const timeout = this.setTimeoutImpl(() => controller.abort(), this.requestTimeoutMs);
    try {
      try {
        response = await this.fetchImpl(`${GITHUB_API_ORIGIN}${pathname}`, {
          method: verb,
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${secret}`,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body == null ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body == null ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        const timedOut = controller.signal.aborted || error?.name === 'AbortError';
        throw githubError(timedOut ? 'GITHUB_REQUEST_TIMEOUT' : 'GITHUB_TRANSPORT_ERROR',
          timedOut ? 'GitHub request timed out' : (error?.message || 'GitHub transport failed'), {
            effectMayHaveOccurred: effectful,
            safeToRetry: !effectful,
          });
      } finally {
        credential = null;
        secret = '';
      }

      const status = Number(response?.status) || 0;
      const accepted = expectedStatuses.includes(status);
      const definitelyRejected = !accepted && SAFE_HTTP_FAILURES.has(status);
      const effectMayHaveOccurred = effectful && !definitelyRejected;
      const safeToRetry = !effectful || definitelyRejected;
      const text = await readResponseTextBounded(response, {
        controller,
        effectMayHaveOccurred,
        safeToRetry,
        status,
      });
      const payload = safeJson(text, { effectMayHaveOccurred, safeToRetry, status });
      if (!accepted) {
        throw githubError(`GITHUB_HTTP_${status || 'ERROR'}`, responseMessage(payload, status || 'ERROR'), {
          effectMayHaveOccurred,
          safeToRetry,
          status,
        });
      }
      return payload;
    } finally {
      credential = null;
      secret = '';
      this.clearTimeoutImpl(timeout);
    }
  }

  async readRepository({ repositoryFullName } = {}) {
    const repository = this.assertRepositoryAllowed(repositoryFullName);
    const payload = await this.request('GET', `/repos/${repositoryPath(repository)}`);
    return Object.freeze({
      repositoryFullName: repository,
      defaultBranch: clean(payload.default_branch, 240),
      private: Boolean(payload.private),
      archived: Boolean(payload.archived),
      disabled: Boolean(payload.disabled),
      pushedAt: clean(payload.pushed_at, 120),
    });
  }

  async readFile({ repositoryFullName, path, ref = '' } = {}) {
    const repository = this.assertRepositoryAllowed(repositoryFullName);
    const encodedPath = filePath(path);
    const sourceRef = ref ? refName(ref) : '';
    const query = sourceRef ? `?ref=${encodeURIComponent(sourceRef)}` : '';
    const payload = await this.request('GET', `/repos/${repositoryPath(repository)}/contents/${encodedPath}${query}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.type !== 'file') {
      throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub contents response is not a file');
    }
    if (payload.encoding !== 'base64') throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub file content is not base64 encoded');
    return Object.freeze({
      repositoryFullName: repository,
      path: clean(payload.path, MAX_PATH),
      sha: responseSha(payload.sha, 'file sha'),
      sizeBytes: Number.isSafeInteger(payload.size) && payload.size >= 0 ? payload.size : 0,
      text: decodeBase64Utf8(payload.content),
    });
  }

  async readTree({ repositoryFullName, treeish, recursive = true } = {}) {
    const repository = this.assertRepositoryAllowed(repositoryFullName);
    const ref = refName(treeish, 'treeish');
    const query = recursive === false ? '' : '?recursive=1';
    const payload = await this.request('GET', `/repos/${repositoryPath(repository)}/git/trees/${encodeURIComponent(ref)}${query}`);
    if (!Array.isArray(payload.tree) || payload.tree.length > 100_000) throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub tree response is invalid or too large');
    return Object.freeze({
      repositoryFullName: repository,
      sha: responseSha(payload.sha, 'tree sha'),
      truncated: Boolean(payload.truncated),
      entries: Object.freeze(payload.tree.map(item => Object.freeze({
        path: clean(item?.path, MAX_PATH),
        mode: clean(item?.mode, 20),
        type: clean(item?.type, 20),
        sha: item?.sha ? responseSha(item.sha, 'tree entry sha') : '',
        sizeBytes: Number.isSafeInteger(item?.size) && item.size >= 0 ? item.size : 0,
      }))),
    });
  }

  async readBranch({ repositoryFullName, branch } = {}) {
    const repository = this.assertRepositoryAllowed(repositoryFullName);
    const branchName = refName(branch, 'branch');
    const payload = await this.request('GET', `/repos/${repositoryPath(repository)}/git/ref/heads/${refPath(branchName)}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.object?.type !== 'commit') {
      throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub branch response is not a commit ref');
    }
    return Object.freeze({
      repositoryFullName: repository,
      branch: branchName,
      ref: clean(payload.ref, 300),
      commitSha: responseSha(payload.object?.sha, 'branch commit sha'),
    });
  }

  async findPullRequests({ repositoryFullName, head, base } = {}) {
    const repository = this.assertRepositoryAllowed(repositoryFullName);
    const [owner] = repository.split('/');
    const headRef = refName(head, 'head');
    const baseRef = refName(base, 'base');
    const query = new URLSearchParams({ state: 'all', head: `${owner}:${headRef}`, base: baseRef, per_page: '10' });
    const payload = await this.request('GET', `/repos/${repositoryPath(repository)}/pulls?${query.toString()}`);
    if (!Array.isArray(payload) || payload.length > 10) {
      throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub pull request reconciliation response is invalid or too large');
    }
    const matches = payload.map(item => {
      const number = Number(item?.number);
      if (!Number.isInteger(number) || number < 1 || !['open', 'closed'].includes(item?.state)) {
        throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub pull request reconciliation item is invalid');
      }
      return Object.freeze({
        number,
        state: item.state,
        title: clean(item?.title, 1000),
        url: clean(item?.html_url, 4096),
        headSha: responseSha(item?.head?.sha, 'pull request head sha'),
        baseSha: responseSha(item?.base?.sha, 'pull request base sha'),
      });
    });
    return Object.freeze({
      repositoryFullName: repository,
      head: headRef,
      base: baseRef,
      matches: Object.freeze(matches),
    });
  }


  async readPullRequest({ repositoryFullName, pullRequestNumber } = {}) {
    const repository = exactRepositoryName(repositoryFullName);
    this.assertRepositoryAllowed(repository);
    const number = positiveInteger(pullRequestNumber, 'pullRequestNumber');
    const payload = await this.request('GET', `/repos/${repositoryPath(repository)}/pulls/${number}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub pull request response is invalid');
    }
    const returnedNumber = responsePositiveInteger(payload.number, 'pull request number');
    if (returnedNumber !== number) throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub pull request identity mismatch');
    if (!['open', 'closed'].includes(payload.state)) throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub pull request state is invalid');
    return Object.freeze({
      repositoryFullName: repository,
      number,
      title: responseText(payload.title, 'pull request title', 1000),
      body: responseText(payload.body, 'pull request body', 100_000, { nullable: true }),
      state: payload.state,
      merged: payload.merged === true,
      headSha: responseSha(payload?.head?.sha, 'pull request head sha'),
      baseSha: responseSha(payload?.base?.sha, 'pull request base sha'),
      mergeCommitSha: payload.merge_commit_sha
        ? responseSha(payload.merge_commit_sha, 'pull request merge commit sha')
        : '',
      url: responseText(payload.html_url, 'pull request URL', 4096),
    });
  }

  async readPullRequestComment({ repositoryFullName, pullRequestNumber, commentId } = {}) {
    const repository = exactRepositoryName(repositoryFullName);
    this.assertRepositoryAllowed(repository);
    const number = positiveInteger(pullRequestNumber, 'pullRequestNumber');
    const id = positiveInteger(commentId, 'commentId');
    await this.readPullRequest({ repositoryFullName: repository, pullRequestNumber: number });
    const payload = await this.request('GET', `/repos/${repositoryPath(repository)}/issues/comments/${id}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub pull request timeline comment response is invalid');
    }
    const returnedId = responsePositiveInteger(payload.id, 'pull request comment id');
    if (returnedId !== id) throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub pull request comment identity mismatch');
    const expectedIssueUrl = `${GITHUB_API_ORIGIN}/repos/${repositoryPath(repository)}/issues/${number}`;
    if (typeof payload.issue_url !== 'string' || payload.issue_url.toLowerCase() !== expectedIssueUrl.toLowerCase()) {
      throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub pull request comment parent identity mismatch');
    }
    return Object.freeze({
      repositoryFullName: repository, pullRequestNumber: number, commentId: id,
      body: responseText(payload.body, 'pull request comment body', 100_000),
      url: responseText(payload.html_url, 'pull request comment URL', 4096),
    });
  }

  async readIssue({ repositoryFullName, issueNumber } = {}) {
    const repository = exactRepositoryName(repositoryFullName);
    this.assertRepositoryAllowed(repository);
    const number = positiveInteger(issueNumber, 'issueNumber');
    const payload = await this.request('GET', `/repos/${repositoryPath(repository)}/issues/${number}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.pull_request) {
      throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub issue response is invalid');
    }
    const returnedNumber = responsePositiveInteger(payload.number, 'issue number');
    if (returnedNumber !== number) throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub issue identity mismatch');
    if (!['open', 'closed'].includes(payload.state)) throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub issue state is invalid');
    return Object.freeze({
      repositoryFullName: repository,
      number,
      title: responseText(payload.title, 'issue title', 1000),
      body: responseText(payload.body, 'issue body', 100_000, { nullable: true }),
      state: payload.state,
      url: responseText(payload.html_url, 'issue URL', 4096),
    });
  }

  async readIssueComment({ repositoryFullName, issueNumber, commentId } = {}) {
    const repository = exactRepositoryName(repositoryFullName);
    this.assertRepositoryAllowed(repository);
    const number = positiveInteger(issueNumber, 'issueNumber');
    const id = positiveInteger(commentId, 'commentId');
    await this.readIssue({ repositoryFullName: repository, issueNumber: number });
    const payload = await this.request('GET', `/repos/${repositoryPath(repository)}/issues/comments/${id}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub issue comment response is invalid');
    }
    const returnedId = responsePositiveInteger(payload.id, 'issue comment id');
    if (returnedId !== id) throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub issue comment identity mismatch');
    const expectedIssueUrl = `${GITHUB_API_ORIGIN}/repos/${repositoryPath(repository)}/issues/${number}`;
    if (typeof payload.issue_url !== 'string'
        || payload.issue_url.toLowerCase() !== expectedIssueUrl.toLowerCase()) {
      throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub issue comment parent identity mismatch');
    }
    return Object.freeze({
      repositoryFullName: repository,
      issueNumber: number,
      commentId: id,
      body: responseText(payload.body, 'issue comment body', 100_000),
      url: responseText(payload.html_url, 'issue comment URL', 4096),
    });
  }

  async createBranch({ repositoryFullName, branch, fromSha } = {}) {
    const repository = this.assertRepositoryAllowed(repositoryFullName);
    const branchName = refName(branch, 'branch');
    const commitSha = sha(fromSha, 'fromSha');
    const payload = await this.request('POST', `/repos/${repositoryPath(repository)}/git/refs`, {
      effectful: true,
      expectedStatuses: [201],
      body: { ref: `refs/heads/${branchName}`, sha: commitSha },
    });
    if (payload?.object?.type !== 'commit') {
      throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub create branch response is not a commit ref', { effectMayHaveOccurred: true });
    }
    return Object.freeze({
      repositoryFullName: repository,
      branch: branchName,
      ref: clean(payload.ref, 300),
      sha: responseSha(payload.object?.sha, 'created branch sha', { effectMayHaveOccurred: true }),
    });
  }

  async putFile({ repositoryFullName, path, branch, message, contentUtf8, mode = GitHubFileWriteMode.CREATE, expectedBlobSha = '' } = {}) {
    const repository = this.assertRepositoryAllowed(repositoryFullName);
    const encodedPath = filePath(path);
    const branchName = refName(branch, 'branch');
    const commitMessage = requiredText(message, 'message', 10_000);
    const normalizedMode = String(mode || '').trim().toLowerCase();
    if (!Object.values(GitHubFileWriteMode).includes(normalizedMode)) throw githubError('GITHUB_INVALID_REQUEST', 'mode must be create or update', { safeToRetry: true });
    const expectedSha = expectedBlobSha ? sha(expectedBlobSha, 'expectedBlobSha') : '';
    if (normalizedMode === GitHubFileWriteMode.UPDATE && !expectedSha) throw githubError('GITHUB_INVALID_REQUEST', 'update mode requires expectedBlobSha', { safeToRetry: true });
    if (normalizedMode === GitHubFileWriteMode.CREATE && expectedSha) throw githubError('GITHUB_INVALID_REQUEST', 'create mode must not include expectedBlobSha', { safeToRetry: true });
    const body = { message: commitMessage, content: encodeBase64Utf8(contentUtf8), branch: branchName, ...(expectedSha ? { sha: expectedSha } : {}) };
    const payload = await this.request('PUT', `/repos/${repositoryPath(repository)}/contents/${encodedPath}`, { body, effectful: true, expectedStatuses: [200, 201] });
    return Object.freeze({
      repositoryFullName: repository,
      path: decodeURIComponent(encodedPath),
      branch: branchName,
      blobSha: responseSha(payload.content?.sha, 'written blob sha', { effectMayHaveOccurred: true }),
      commitSha: responseSha(payload.commit?.sha, 'write commit sha', { effectMayHaveOccurred: true }),
      mode: normalizedMode,
    });
  }

  async deleteFile({ repositoryFullName, path, branch, message, expectedBlobSha } = {}) {
    const repository = this.assertRepositoryAllowed(repositoryFullName);
    const encodedPath = filePath(path);
    const branchName = refName(branch, 'branch');
    const commitMessage = requiredText(message, 'message', 10_000);
    const expectedSha = sha(expectedBlobSha, 'expectedBlobSha');
    const payload = await this.request('DELETE', `/repos/${repositoryPath(repository)}/contents/${encodedPath}`, {
      effectful: true,
      expectedStatuses: [200],
      body: { message: commitMessage, sha: expectedSha, branch: branchName },
    });
    return Object.freeze({
      repositoryFullName: repository,
      path: decodeURIComponent(encodedPath),
      branch: branchName,
      deletedBlobSha: expectedSha,
      commitSha: responseSha(payload.commit?.sha, 'delete commit sha', { effectMayHaveOccurred: true }),
    });
  }

  async createPullRequest({ repositoryFullName, title, body = '', head, base } = {}) {
    const repository = this.assertRepositoryAllowed(repositoryFullName);
    const prTitle = requiredText(title, 'title', 1000);
    const prBody = optionalText(body, 'body', 100_000);
    const headRef = refName(head, 'head');
    const baseRef = refName(base, 'base');
    const payload = await this.request('POST', `/repos/${repositoryPath(repository)}/pulls`, {
      effectful: true,
      expectedStatuses: [201],
      body: { title: prTitle, body: prBody, head: headRef, base: baseRef },
    });
    const number = Number(payload.number);
    if (!Number.isInteger(number) || number < 1) throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub pull request response is invalid', { effectMayHaveOccurred: true });
    return Object.freeze({ repositoryFullName: repository, number, head: headRef, base: baseRef, url: clean(payload.html_url, 4096) });
  }


  async mergePullRequest({
    repositoryFullName,
    pullRequestNumber,
    expectedHeadSha,
    mergeMethod,
  } = {}) {
    const repository = exactRepositoryName(repositoryFullName);
    this.assertRepositoryAllowed(repository);
    const number = positiveInteger(pullRequestNumber, 'pullRequestNumber');
    const expectedHead = sha(expectedHeadSha, 'expectedHeadSha');
    if (typeof mergeMethod !== 'string' || !PULL_REQUEST_MERGE_METHODS.has(mergeMethod)) {
      throw githubError('GITHUB_INVALID_REQUEST', 'mergeMethod must be merge, squash, or rebase', { safeToRetry: true });
    }

    const before = await this.readPullRequest({
      repositoryFullName: repository,
      pullRequestNumber: number,
    });
    if (before.state !== 'open' || before.merged) {
      throw githubError('GITHUB_PULL_REQUEST_NOT_OPEN', 'Pull request is not open for merge', { safeToRetry: true });
    }
    if (before.headSha !== expectedHead) {
      throw githubError('GITHUB_PULL_REQUEST_HEAD_MISMATCH', 'Pull request head changed from expectedHeadSha', { safeToRetry: true });
    }

    const payload = await this.request(
      'PUT',
      `/repos/${repositoryPath(repository)}/pulls/${number}/merge`,
      {
        effectful: true,
        expectedStatuses: [200],
        body: { sha: expectedHead, merge_method: mergeMethod },
      },
    );
    if (payload?.merged !== true) {
      throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub merge response did not confirm a merged pull request', {
        effectMayHaveOccurred: true,
        safeToRetry: false,
      });
    }
    const mergeCommitSha = responseSha(payload?.sha, 'merge commit sha', { effectMayHaveOccurred: true });
    return Object.freeze({
      repositoryFullName: repository,
      pullRequestNumber: number,
      expectedHeadSha: expectedHead,
      mergeMethod,
      merged: true,
      mergeCommitSha,
    });
  }


  async createPullRequestComment({ repositoryFullName, pullRequestNumber, body } = {}) {
    const repository = exactRepositoryName(repositoryFullName);
    this.assertRepositoryAllowed(repository);
    const number = positiveInteger(pullRequestNumber, 'pullRequestNumber');
    const commentBody = exactNonBlankText(body, 'body', 100_000);
    await this.readPullRequest({ repositoryFullName: repository, pullRequestNumber: number });
    const payload = await this.request('POST', `/repos/${repositoryPath(repository)}/issues/${number}/comments`, {
      effectful: true,
      expectedStatuses: [201],
      body: { body: commentBody },
    });
    const commentId = responsePositiveInteger(payload?.id, 'pull request comment id', { effectMayHaveOccurred: true });
    const returnedBody = responseText(payload?.body, 'pull request comment body', 100_000, { effectMayHaveOccurred: true });
    const expectedIssueUrl = `${GITHUB_API_ORIGIN}/repos/${repositoryPath(repository)}/issues/${number}`;
    if (returnedBody !== commentBody
        || typeof payload?.issue_url !== 'string'
        || payload.issue_url.toLowerCase() !== expectedIssueUrl.toLowerCase()) {
      throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub created pull request comment does not match the requested parent/body', { effectMayHaveOccurred: true });
    }
    return Object.freeze({
      repositoryFullName: repository, pullRequestNumber: number, commentId, body: returnedBody,
      url: responseText(payload?.html_url, 'pull request comment URL', 4096, { effectMayHaveOccurred: true }),
    });
  }

  async createIssue({ repositoryFullName, title, body = '' } = {}) {
    const repository = exactRepositoryName(repositoryFullName);
    this.assertRepositoryAllowed(repository);
    const issueTitle = exactNonBlankText(title, 'title', 1000);
    if (issueTitle !== issueTitle.trim()) {
      throw githubError('GITHUB_INVALID_REQUEST', 'title must not contain surrounding whitespace', { safeToRetry: true });
    }
    const issueBody = optionalText(body, 'body', 100_000);
    const payload = await this.request('POST', `/repos/${repositoryPath(repository)}/issues`, {
      effectful: true,
      expectedStatuses: [201],
      body: { title: issueTitle, body: issueBody },
    });
    const number = responsePositiveInteger(payload?.number, 'issue number', { effectMayHaveOccurred: true });
    const returnedTitle = responseText(payload?.title, 'issue title', 1000, { effectMayHaveOccurred: true });
    const returnedBody = responseText(payload?.body, 'issue body', 100_000, { nullable: true, effectMayHaveOccurred: true });
    if (returnedTitle !== issueTitle || returnedBody !== issueBody || payload?.pull_request || payload?.state !== 'open') {
      throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub created issue does not match the requested issue', { effectMayHaveOccurred: true });
    }
    return Object.freeze({
      repositoryFullName: repository,
      number,
      title: returnedTitle,
      body: returnedBody,
      state: 'open',
      url: responseText(payload?.html_url, 'issue URL', 4096, { effectMayHaveOccurred: true }),
    });
  }

  async createIssueComment({ repositoryFullName, issueNumber, body } = {}) {
    const repository = exactRepositoryName(repositoryFullName);
    this.assertRepositoryAllowed(repository);
    const number = positiveInteger(issueNumber, 'issueNumber');
    const commentBody = exactNonBlankText(body, 'body', 100_000);
    await this.readIssue({ repositoryFullName: repository, issueNumber: number });
    const payload = await this.request('POST', `/repos/${repositoryPath(repository)}/issues/${number}/comments`, {
      effectful: true,
      expectedStatuses: [201],
      body: { body: commentBody },
    });
    const commentId = responsePositiveInteger(payload?.id, 'issue comment id', { effectMayHaveOccurred: true });
    const returnedBody = responseText(payload?.body, 'issue comment body', 100_000, { effectMayHaveOccurred: true });
    const expectedIssueUrl = `${GITHUB_API_ORIGIN}/repos/${repositoryPath(repository)}/issues/${number}`;
    if (returnedBody !== commentBody
        || typeof payload?.issue_url !== 'string'
        || payload.issue_url.toLowerCase() !== expectedIssueUrl.toLowerCase()) {
      throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub created issue comment does not match the requested parent/body', { effectMayHaveOccurred: true });
    }
    return Object.freeze({
      repositoryFullName: repository,
      issueNumber: number,
      commentId,
      body: returnedBody,
      url: responseText(payload?.html_url, 'issue comment URL', 4096, { effectMayHaveOccurred: true }),
    });
  }
}
