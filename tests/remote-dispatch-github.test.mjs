import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_INCREMENTAL_OVERLAP_MS,
  RemoteDispatchGitHubError,
  fetchGitHubDispatchComments,
  fetchLatestGitHubRemoteDispatch,
} from '../src/core/remote-dispatch-github.js';
import { REMOTE_DISPATCH_MARKER } from '../src/core/remote-dispatch.js';

function response(json, { status = 200, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return lower[String(name).toLowerCase()] ?? null; } },
    async json() { return structuredClone(json); },
  };
}

function dispatchBody({ id = 'd1', revision = 1, projectId = 'project-a' } = {}) {
  const raw = {
    schema_version: 1,
    dispatch_id: id,
    strategy_revision: revision,
    generated_at: '2026-09-11T18:00:00Z',
    expires_at: '2026-09-11T20:00:00Z',
    project_id: projectId,
    target_repository: 'owner/repo',
    supersedes_dispatch_ids: [],
    policy: { poll_interval_seconds: 180, fallback_after_seconds: 900, fallback_enabled: true, max_active_sessions: 1 },
    sessions: [{
      session_key: 's1', name: 'S1', order: 1, enabled: true,
      run_mode: 'ONE_PASS', tab_strategy: 'OPEN_CLOSE_PER_TASK',
      minimum_send_interval_seconds: 60, pre_send_delay_seconds: 1, busy_check_delay_seconds: 1, retry_backoff_seconds: 5,
      not_before: null, expires_at: null,
      tasks: [{ task_id: 't1', order: 1, enabled: true, url: 'https://chatgpt.com/', prompt: 'test', not_before: null, expires_at: null, max_launches: 1, supersedes_task_ids: [] }],
    }],
  };
  return `${REMOTE_DISPATCH_MARKER}\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``;
}

test('initial fetch reads issue metadata then only the latest comments page', async () => {
  const calls = [];
  const fetchFn = async url => {
    calls.push(url);
    if (!url.includes('/comments')) return response({ comments: 245 });
    return response([{ id: 201, body: 'a' }, { id: 245, body: 'b' }], { headers: { 'x-ratelimit-remaining': '57' } });
  };
  const result = await fetchGitHubDispatchComments({ fetchFn, repository: 'owner/repo', issueNumber: 121 });
  assert.equal(result.initial, true);
  assert.equal(result.pagesFetched, 1);
  assert.deepEqual(result.comments.map(x => x.id), ['201', '245']);
  assert.equal(result.rateLimitRemaining, 57);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /[?&]page=3(?:&|$)/);
});

test('empty issue returns without a comments request', async () => {
  let calls = 0;
  const result = await fetchGitHubDispatchComments({
    fetchFn: async () => { calls += 1; return response({ comments: 0 }); },
    repository: 'owner/repo', issueNumber: 121,
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.comments, []);
  assert.equal(result.pagesFetched, 0);
});

test('incremental fetch uses a five-minute overlap and deduplicates repeated comment ids', async () => {
  const urls = [];
  let page = 0;
  const fetchFn = async url => {
    urls.push(url); page += 1;
    if (page === 1) return response(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `p1-${i}` })));
    return response([{ id: 100, body: 'newer-copy' }, { id: 101, body: 'new' }]);
  };
  const sinceMs = Date.parse('2026-09-11T18:30:00Z');
  const result = await fetchGitHubDispatchComments({ fetchFn, repository: 'owner/repo', issueNumber: 121, sinceMs });
  assert.equal(result.initial, false);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.comments.length, 101);
  const since = new URL(urls[0]).searchParams.get('since');
  assert.equal(Date.parse(since), sinceMs - GITHUB_INCREMENTAL_OVERLAP_MS);
});

test('incremental burst fails closed at bounded page limit', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'x' }));
  await assert.rejects(() => fetchGitHubDispatchComments({
    fetchFn: async () => response(full), repository: 'owner/repo', issueNumber: 121,
    sinceMs: Date.parse('2026-09-11T18:30:00Z'), maxIncrementalPages: 2,
  }), error => error instanceof RemoteDispatchGitHubError && error.code === 'PAGE_LIMIT');
});

test('403 with exhausted GitHub rate limit becomes typed RATE_LIMITED error', async () => {
  await assert.rejects(() => fetchGitHubDispatchComments({
    fetchFn: async () => response({}, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '120' } }),
    repository: 'owner/repo', issueNumber: 121,
  }), error => error.code === 'RATE_LIMITED' && error.retryAfterSeconds === 120 && error.rateLimitRemaining === 0);
});

test('invalid repository and issue configuration fail before network call', async () => {
  let called = false;
  const fetchFn = async () => { called = true; return response({}); };
  await assert.rejects(() => fetchGitHubDispatchComments({ fetchFn, repository: '../bad', issueNumber: 0 }), /INVALID_CONFIG/);
  assert.equal(called, false);
});

test('provider selects latest matching dispatch and preserves source comment metadata', async () => {
  const fetchFn = async url => {
    if (!url.includes('/comments')) return response({ comments: 3 });
    return response([
      { id: 1, body: 'human', html_url: 'https://github.com/x#1' },
      { id: 2, body: dispatchBody({ id: 'old', revision: 1 }), html_url: 'https://github.com/x#2' },
      { id: 3, body: dispatchBody({ id: 'new', revision: 2 }), html_url: 'https://github.com/x#3' },
    ]);
  };
  const result = await fetchLatestGitHubRemoteDispatch({
    fetchFn, repository: 'owner/repo', issueNumber: 121, projectId: 'project-a', nowMs: Date.parse('2026-09-11T18:30:00Z'),
  });
  assert.equal(result.selected.dispatch.dispatch_id, 'new');
  assert.equal(result.selected.comment.id, '3');
  assert.equal(result.selected.comment.htmlUrl, 'https://github.com/x#3');
});

test('wrong-project dispatch is diagnostic only and never selected', async () => {
  const fetchFn = async url => url.includes('/comments')
    ? response([{ id: 9, body: dispatchBody({ projectId: 'other' }) }])
    : response({ comments: 1 });
  const result = await fetchLatestGitHubRemoteDispatch({ fetchFn, repository: 'owner/repo', issueNumber: 121, projectId: 'project-a', nowMs: Date.parse('2026-09-11T18:30:00Z') });
  assert.equal(result.selected, null);
  assert.equal(result.diagnostics[0].reason, 'WRONG_PROJECT');
});
