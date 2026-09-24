import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubRestClientV1 } from '../src/core/github-rest-client.js';

const repo = 'Oleksii-debug/example';
const commitSha = 'b'.repeat(40);

function jsonResponse(status, payload) {
  return { status, text: async () => JSON.stringify(payload) };
}

function nativeCredential() {
  return {
    resolveCredential: async request => ({
      credentialId: request.credentialId,
      kind: 'username-password',
      targetOrigin: request.targetOrigin,
      username: '',
      secret: 'token-secret-value',
    }),
  };
}

function client(fetchImpl) {
  return new GitHubRestClientV1({
    nativeClient: nativeCredential(),
    credentialId: 'github-main',
    allowedRepositories: [repo],
    fetchImpl,
  });
}

test('malformed commit SHA after successful branch creation remains ambiguous and non-retryable', async () => {
  const subject = client(async () => jsonResponse(201, {
    ref: 'refs/heads/work/new',
    object: { type: 'commit', sha: 'not-a-sha' },
  }));

  await assert.rejects(
    () => subject.createBranch({ repositoryFullName: repo, branch: 'work/new', fromSha: commitSha }),
    error => error.code === 'GITHUB_RESPONSE_INVALID'
      && error.effectMayHaveOccurred === true
      && error.safeToRetry === false,
  );
});

test('malformed identities after successful file mutation remain ambiguous and non-retryable', async () => {
  const subject = client(async () => jsonResponse(200, {
    content: { sha: 'not-a-sha' },
    commit: { sha: commitSha },
  }));

  await assert.rejects(
    () => subject.putFile({
      repositoryFullName: repo,
      path: 'src/a.js',
      branch: 'work/new',
      message: 'update exact file',
      contentUtf8: 'const value = 2;\n',
      mode: 'update',
      expectedBlobSha: 'a'.repeat(40),
    }),
    error => error.code === 'GITHUB_RESPONSE_INVALID'
      && error.effectMayHaveOccurred === true
      && error.safeToRetry === false,
  );
});

test('malformed identity in read-only response is retry-safe and cannot be confused with caller input failure', async () => {
  const subject = client(async () => jsonResponse(200, {
    type: 'file',
    path: 'README.md',
    sha: 'not-a-sha',
    size: 2,
    encoding: 'base64',
    content: Buffer.from('ok', 'utf8').toString('base64'),
  }));

  await assert.rejects(
    () => subject.readFile({ repositoryFullName: repo, path: 'README.md', ref: 'main' }),
    error => error.code === 'GITHUB_RESPONSE_INVALID'
      && error.effectMayHaveOccurred === false
      && error.safeToRetry === true,
  );
});
