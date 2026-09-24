import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubCodeProvider, GitHubCodeProviderError } from '../src/core/github-code-provider.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('creates a work branch only from the exact observed base revision', async () => {
  const calls = [];
  const provider = new GitHubCodeProvider({
    repository: 'owner/repo',
    getToken: async () => 'secret-token',
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'GET') return jsonResponse({ object: { sha: SHA_A } });
      return jsonResponse({ ref: 'refs/heads/agent/work' }, 201);
    },
  });

  const result = await provider.createWorkBranch({ branch: 'agent/work', base: 'main', expectedBaseSha: SHA_A });
  assert.equal(result.baseSha, SHA_A);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { ref: 'refs/heads/agent/work', sha: SHA_A });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer secret-token');
});

test('fails closed when the base branch moved', async () => {
  let writes = 0;
  const provider = new GitHubCodeProvider({
    repository: 'owner/repo',
    fetchFn: async (_url, options) => {
      if (options.method !== 'GET') writes += 1;
      return jsonResponse({ object: { sha: SHA_B } });
    },
  });

  await assert.rejects(
    provider.createWorkBranch({ branch: 'agent/work', base: 'main', expectedBaseSha: SHA_A }),
    error => error instanceof GitHubCodeProviderError && error.code === 'STALE_BASE',
  );
  assert.equal(writes, 0);
});

test('refuses direct writes to protected branches', async () => {
  let requests = 0;
  const provider = new GitHubCodeProvider({
    repository: 'owner/repo',
    fetchFn: async () => { requests += 1; return jsonResponse({}); },
  });

  await assert.rejects(
    provider.writeFile({ path: 'src/a.js', branch: 'main', content: 'x', message: 'change' }),
    error => error instanceof GitHubCodeProviderError && error.code === 'PROTECTED_BRANCH',
  );
  assert.equal(requests, 0);
});

test('writes UTF-8 content with optimistic file revision and opens a pull request', async () => {
  const calls = [];
  const provider = new GitHubCodeProvider({
    repository: 'owner/repo',
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'PUT') return jsonResponse({ commit: { sha: SHA_B }, content: { sha: SHA_C } });
      if (options.method === 'POST' && url.endsWith('/pulls')) {
        return jsonResponse({ number: 17, html_url: 'https://example.test/pr/17', head: { sha: SHA_B } }, 201);
      }
      throw new Error('unexpected request');
    },
  });

  const written = await provider.writeFile({
    path: 'src/приклад.txt',
    branch: 'agent/work',
    content: 'Привіт, світе!',
    message: 'Оновити приклад',
    expectedSha: SHA_A,
  });
  assert.equal(written.commitSha, SHA_B);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.sha, SHA_A);
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(body.content), c => c.charCodeAt(0))), 'Привіт, світе!');

  const pull = await provider.openPullRequest({ branch: 'agent/work', base: 'main', title: 'Безпечна зміна', body: 'Перевірити.' });
  assert.equal(pull.number, 17);
  const pullBody = JSON.parse(calls[1].options.body);
  assert.deepEqual({ head: pullBody.head, base: pullBody.base, maintainer_can_modify: pullBody.maintainer_can_modify }, {
    head: 'agent/work', base: 'main', maintainer_can_modify: true,
  });
});
