export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GitHubFileWriteMode = Object.freeze({ CREATE: 'create', UPDATE: 'update' });

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const GIT_SHA = /^[a-f0-9]{40,64}$/iu;
const REF = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\.lock(?:\/|$))[A-Za-z0-9._\/-]{1,240}$/u;
const MAX_TEXT = 1_000_000;
const MAX_PATH = 4096;
const MAX_BODY_TEXT = 256_000;
const SAFE_HTTP_FAILURES = new Set([400, 401, 403, 404, 405, 409, 412, 415, 422, 429]);

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
  const out = clean(value, 300);
  if (!REPOSITORY.test(out) || out.includes('..')) throw githubError('GITHUB_INVALID_REQUEST', 'repositoryFullName is invalid', { safeToRetry: true });
  return out;
}

function sha(value, label = 'sha') {
  const out = clean(value, 80);
  if (!GIT_SHA.test(out)) throw githubError('GITHUB_INVALID_REQUEST', `${label} is invalid`, { safeToRetry: true });
  return out.toLowerCase();
}

function refName(value, label = 'ref') {
  const out = clean(value, 240);
  if (!REF.test(out) || out.endsWith('/') || out.startsWith('.') || out.includes('//')) {
    throw githubError('GITHUB_INVALID_REQUEST', `${label} is invalid`, { safeToRetry: true });
  }
  return out;
}

function repositoryPath(value) {
  return repositoryName(value).split('/').map(encodeURIComponent).join('/');
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

function safeJson(text) {
  if (!text) return {};
  if (text.length > MAX_TEXT) throw githubError('GITHUB_RESPONSE_TOO_LARGE', 'GitHub response exceeds the bounded response size');
  try { return JSON.parse(text); }
  catch { throw githubError('GITHUB_RESPONSE_INVALID', 'GitHub returned invalid JSON'); }
}

function responseMessage(payload, status) {
  const message = payload && typeof payload === 'object' && !Array.isArray(payload) ? clean(payload.message, 1000) : '';
  return message ? `GitHub HTTP ${status}: ${message}` : `GitHub HTTP ${status}`;
}

export class GitHubRestClientV1 {
  constructor({ nativeClient, credentialId, allowedRepositories = [], fetchImpl = globalThis.fetch } = {}) {
    if (!nativeClient?.resolveCredential) throw new Error('Native Companion credential resolver is required');
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
    const id = clean(credentialId, 128);
    if (!id) throw new Error('GitHub credentialId is required');
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
    if (typeof pathname !== 'string' || !pathname.startsWith('/repos/') || pathname.includes('://')) {
      throw githubError('GITHUB_INVALID_REQUEST', 'GitHub path is outside the repository API boundary', { safeToRetry: true });
    }
    let credential;
    try {
      credential = await this.nativeClient.resolveCredential({ credentialId: this.credentialId, targetOrigin: GITHUB_API_ORIGIN });
    } catch (error) {
      throw githubError(error?.code || 'GITHUB_CREDENTIAL_UNAVAILABLE', error?.message || 'GitHub credential is unavailable', { safeToRetry: true });
    }
    const secret = typeof credential?.secret === 'string' ? credential.secret : '';
    if (!secret || secret.length > 100_000) throw githubError('GITHUB_CREDENTIAL_INVALID', 'GitHub credential secret is unavailable', { safeToRetry: true });

    let response;
    try {
      response = await this.fetchImpl(`${GITHUB_API_ORIGIN}${pathname}`, {
        method: verb,
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${secret}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body == null ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body == null ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw githubError('GITHUB_TRANSPORT_ERROR', error?.message || 'GitHub transport failed', {
        effectMayHaveOccurred: effectful,
        safeToRetry: !effectful,
      });
    } finally {
      credential = null;
    }

    let text;
    try { text = await response.text(); }
    catch (error) {
      throw githubError('GITHUB_RESPONSE_READ_FAILED', error?.message || 'GitHub response could not be read', {
        effectMayHaveOccurred: effectful,
        safeToRetry: !effectful,
        status: Number(response?.status) || 0,
      });
    }
    const payload = safeJson(text);
    const status = Number(response?.status) || 0;
    if (!expectedStatuses.includes(status)) {
      const definitelyRejected = SAFE_HTTP_FAILURES.has(status);
      throw githubError(`GITHUB_HTTP_${status || 'ERROR'}`, responseMessage(payload, status || 'ERROR'), {
        effectMayHaveOccurred: effectful && !definitelyRejected,
        safeToRetry: !effectful || definitelyRejected,
        status,
      });
    }
    return payload;
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
      sha: sha(payload.sha, 'file sha'),
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
      sha: sha(payload.sha, 'tree sha'),
      truncated: Boolean(payload.truncated),
      entries: Object.freeze(payload.tree.map(item => Object.freeze({
        path: clean(item?.path, MAX_PATH),
        mode: clean(item?.mode, 20),
        type: clean(item?.type, 20),
        sha: item?.sha ? sha(item.sha, 'tree entry sha') : '',
        sizeBytes: Number.isSafeInteger(item?.size) && item.size >= 0 ? item.size : 0,
      }))),
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
    return Object.freeze({ repositoryFullName: repository, branch: branchName, ref: clean(payload.ref, 300), sha: sha(payload.object?.sha || commitSha, 'created branch sha') });
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
      blobSha: sha(payload.content?.sha, 'written blob sha'),
      commitSha: sha(payload.commit?.sha, 'write commit sha'),
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
    return Object.freeze({ repositoryFullName: repository, path: decodeURIComponent(encodedPath), branch: branchName, deletedBlobSha: expectedSha, commitSha: sha(payload.commit?.sha, 'delete commit sha') });
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
}
