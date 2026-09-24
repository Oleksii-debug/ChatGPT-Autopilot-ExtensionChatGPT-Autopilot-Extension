import test from 'node:test';
import assert from 'node:assert/strict';
import { GITHUB_API_ORIGIN, GitHubFileWriteMode, GitHubRestClientV1 } from '../src/core/github-rest-client.js';

const repo = 'Oleksii-debug/example';
const blobSha = 'a'.repeat(40);
const commitSha = 'b'.repeat(40);

function jsonResponse(status, payload) {
  return { status, text: async () => JSON.stringify(payload) };
}

function nativeCredential(calls, secret = 'token-secret-value') {
  return {
    resolveCredential: async request => {
      calls.push(request);
      return { credentialId: request.credentialId, kind: 'username-password', targetOrigin: request.targetOrigin, username: '', secret };
    },
  };
}

test('readFile is repository-allowlisted, credential-scoped to api.github.com and returns exact blob identity', async () => {
  const credentialCalls = [];
  const fetchCalls = [];
  const client = new GitHubRestClientV1({
    nativeClient: nativeCredential(credentialCalls),
    credentialId: 'github-main',
    allowedRepositories: [repo],
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return jsonResponse(200, {
        type: 'file',
        path: 'src/index.js',
        sha: blobSha,
        size: 6,
        encoding: 'base64',
        content: Buffer.from('привіт', 'utf8').toString('base64'),
      });
    },
  });

  const result = await client.readFile({ repositoryFullName: repo, path: 'src/index.js', ref: 'main' });
  assert.equal(result.sha, blobSha);
  assert.equal(result.text, 'привіт');
  assert.deepEqual(credentialCalls, [{ credentialId: 'github-main', targetOrigin: GITHUB_API_ORIGIN }]);
  assert.equal(fetchCalls[0].url, `${GITHUB_API_ORIGIN}/repos/Oleksii-debug/example/contents/src/index.js?ref=main`);
  assert.equal(fetchCalls[0].options.method, 'GET');
  assert.equal(fetchCalls[0].options.redirect, 'error');
  assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer token-secret-value');
  assert.equal(JSON.stringify(result).includes('token-secret-value'), false);
});

test('repository outside owner allowlist is rejected before credential resolution or network effect', async () => {
  const credentialCalls = [];
  let fetchCount = 0;
  const client = new GitHubRestClientV1({
    nativeClient: nativeCredential(credentialCalls),
    credentialId: 'github-main',
    allowedRepositories: [repo],
    fetchImpl: async () => { fetchCount += 1; return jsonResponse(200, {}); },
  });
  await assert.rejects(
    () => client.readRepository({ repositoryFullName: 'other/secret' }),
    error => error.code === 'GITHUB_REPOSITORY_NOT_ALLOWED' && error.effectMayHaveOccurred === false && error.safeToRetry === true,
  );
  assert.equal(fetchCount, 0);
  assert.deepEqual(credentialCalls, []);
});

test('file update requires exact expected blob SHA and sends it as GitHub precondition', async () => {
  const requests = [];
  const client = new GitHubRestClientV1({
    nativeClient: nativeCredential([]),
    credentialId: 'github-main',
    allowedRepositories: [repo],
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse(200, { content: { sha: blobSha }, commit: { sha: commitSha } });
    },
  });

  await assert.rejects(
    () => client.putFile({ repositoryFullName: repo, path: 'src/a.js', branch: 'work/a', message: 'update', contentUtf8: 'x', mode: GitHubFileWriteMode.UPDATE }),
    error => error.code === 'GITHUB_INVALID_REQUEST' && error.safeToRetry === true,
  );

  const result = await client.putFile({
    repositoryFullName: repo,
    path: 'src/a.js',
    branch: 'work/a',
    message: 'update exact file',
    contentUtf8: 'const value = 1;\n',
    mode: GitHubFileWriteMode.UPDATE,
    expectedBlobSha: 'c'.repeat(40),
  });
  assert.equal(result.commitSha, commitSha);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'PUT');
  assert.equal(requests[0].body.sha, 'c'.repeat(40));
  assert.equal(requests[0].body.branch, 'work/a');
  assert.equal(Buffer.from(requests[0].body.content, 'base64').toString('utf8'), 'const value = 1;\n');
});

test('mutating transport or server uncertainty is ambiguous while deterministic rejection is safe', async () => {
  const transportClient = new GitHubRestClientV1({
    nativeClient: nativeCredential([]), credentialId: 'github-main', allowedRepositories: [repo],
    fetchImpl: async () => { throw new Error('socket closed'); },
  });
  await assert.rejects(
    () => transportClient.createBranch({ repositoryFullName: repo, branch: 'work/new', fromSha: commitSha }),
    error => error.code === 'GITHUB_TRANSPORT_ERROR' && error.effectMayHaveOccurred === true && error.safeToRetry === false,
  );

  const serverClient = new GitHubRestClientV1({
    nativeClient: nativeCredential([]), credentialId: 'github-main', allowedRepositories: [repo],
    fetchImpl: async () => jsonResponse(503, { message: 'unavailable' }),
  });
  await assert.rejects(
    () => serverClient.createBranch({ repositoryFullName: repo, branch: 'work/new', fromSha: commitSha }),
    error => error.code === 'GITHUB_HTTP_503' && error.effectMayHaveOccurred === true && error.safeToRetry === false,
  );

  const rejectedClient = new GitHubRestClientV1({
    nativeClient: nativeCredential([]), credentialId: 'github-main', allowedRepositories: [repo],
    fetchImpl: async () => jsonResponse(422, { message: 'reference already exists' }),
  });
  await assert.rejects(
    () => rejectedClient.createBranch({ repositoryFullName: repo, branch: 'work/new', fromSha: commitSha }),
    error => error.code === 'GITHUB_HTTP_422' && error.effectMayHaveOccurred === false && error.safeToRetry === true,
  );
});

test('read-only transport failure is retry-safe and branch/file inputs fail closed', async () => {
  const client = new GitHubRestClientV1({
    nativeClient: nativeCredential([]), credentialId: 'github-main', allowedRepositories: [repo],
    fetchImpl: async () => { throw new Error('offline'); },
  });
  await assert.rejects(
    () => client.readRepository({ repositoryFullName: repo }),
    error => error.effectMayHaveOccurred === false && error.safeToRetry === true,
  );
  await assert.rejects(
    () => client.readFile({ repositoryFullName: repo, path: '../secret.txt', ref: 'main' }),
    error => error.code === 'GITHUB_INVALID_REQUEST',
  );
  await assert.rejects(
    () => client.createBranch({ repositoryFullName: repo, branch: '../bad', fromSha: commitSha }),
    error => error.code === 'GITHUB_INVALID_REQUEST',
  );
});
