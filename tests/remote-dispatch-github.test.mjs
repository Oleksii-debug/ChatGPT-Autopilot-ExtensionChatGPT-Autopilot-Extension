import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_INCREMENTAL_OVERLAP_MS,
  GITHUB_REQUEST_TIMEOUT_MS,
  GITHUB_RESPONSE_MAX_BYTES,
  RemoteDispatchGitHubError,
  fetchGitHubDispatchComments,
  fetchLatestGitHubRemoteDispatch,
} from '../src/core/remote-dispatch-github.js';
import { REMOTE_DISPATCH_MARKER } from '../src/core/remote-dispatch.js';

const encoder = new TextEncoder();

function rawResponse(text, {
  status = 200,
  headers = {},
  chunks = null,
  state = null,
} = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const streamState = state || { reads: 0, cancelled: false, released: false, bodyCancelled: false };
  const streamChunks = chunks || [encoder.encode(text)];
  let index = 0;
  const body = {
    async cancel() {
      streamState.bodyCancelled = true;
    },
    getReader() {
      return {
        async read() {
          streamState.reads += 1;
          if (index >= streamChunks.length) return { done: true, value: undefined };
          const value = streamChunks[index];
          index += 1;
          return { done: false, value };
        },
        async cancel() {
          streamState.cancelled = true;
        },
        releaseLock() {
          streamState.released = true;
        },
      };
    },
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return lower[String(name).toLowerCase()] ?? null; } },
    body,
  };
}

function response(json, options = {}) {
  return rawResponse(JSON.stringify(json), options);
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
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    if (!url.includes('/comments')) return response({ comments: 245 });
    return response([{ id: 201, body: 'a' }, { id: 245, body: 'b' }], { headers: { 'x-ratelimit-remaining': '57' } });
  };
  const result = await fetchGitHubDispatchComments({ fetchFn, repository: 'owner/repo', issueNumber: 121 });
  assert.equal(result.initial, true);
  assert.equal(result.pagesFetched, 1);
  assert.deepEqual(result.comments.map(x => x.id), ['201', '245']);
  assert.equal(result.rateLimitRemaining, 57);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /[?&]page=3(?:&|$)/);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
  assert.equal(calls[0].options.signal.aborted, false);
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

test('429 becomes typed RATE_LIMITED even when remaining header is absent', async () => {
  await assert.rejects(() => fetchGitHubDispatchComments({
    fetchFn: async () => response({}, { status: 429, headers: { 'retry-after': '90' } }),
    repository: 'owner/repo', issueNumber: 121,
  }), error => error.code === 'RATE_LIMITED' && error.status === 429 && error.retryAfterSeconds === 90);
});

test('secondary 403 with Retry-After becomes typed RATE_LIMITED before primary quota is exhausted', async () => {
  await assert.rejects(() => fetchGitHubDispatchComments({
    fetchFn: async () => response({}, { status: 403, headers: { 'x-ratelimit-remaining': '42', 'retry-after': '60' } }),
    repository: 'owner/repo', issueNumber: 121,
  }), error => error.code === 'RATE_LIMITED' && error.status === 403 && error.retryAfterSeconds === 60 && error.rateLimitRemaining === 42);
});

test('documented secondary-limit 403 payload is RATE_LIMITED when primary remaining is nonzero and Retry-After is absent', async () => {
  await assert.rejects(() => fetchGitHubDispatchComments({
    fetchFn: async () => response({
      message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
      documentation_url: 'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits',
    }, { status:403, headers:{ 'x-ratelimit-remaining':'42' } }),
    repository:'owner/repo', issueNumber:121,
  }), error => error.code === 'RATE_LIMITED' && error.status === 403 && error.retryAfterSeconds === 0 && error.rateLimitRemaining === 42);
});

test('ordinary permission 403 remains fail-closed HTTP_ERROR and is not misclassified as throttling', async () => {
  await assert.rejects(() => fetchGitHubDispatchComments({
    fetchFn: async () => response({
      message: 'Resource not accessible by integration',
      documentation_url: 'https://docs.github.com/rest/issues/comments',
    }, { status:403, headers:{ 'x-ratelimit-remaining':'42' } }),
    repository:'owner/repo', issueNumber:121,
  }), error => error.code === 'HTTP_ERROR' && error.status === 403 && error.rateLimitRemaining === 42);
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


test('Remote Dispatch response admits the exact byte ceiling and rejects declared overflow before reading', async () => {
  const prefix = '[{"id":1,"body":"';
  const suffix = '"}]';
  const overhead = encoder.encode(prefix + suffix).byteLength;
  const remaining = GITHUB_RESPONSE_MAX_BYTES - overhead;
  const wideCount = Math.floor(remaining / 3);
  const tail = 'a'.repeat(remaining - (wideCount * 3));
  const exactText = prefix + '界'.repeat(wideCount) + tail + suffix;
  assert.equal(encoder.encode(exactText).byteLength, GITHUB_RESPONSE_MAX_BYTES);

  let call = 0;
  const exact = await fetchGitHubDispatchComments({
    fetchFn: async url => {
      call += 1;
      if (!url.includes('/comments')) return response({ comments: 1 });
      return rawResponse(exactText);
    },
    repository: 'owner/repo',
    issueNumber: 121,
  });
  assert.equal(exact.comments.length, 1);
  assert.equal(exact.comments[0].id, '1');

  const state = { reads: 0, cancelled: false, released: false, bodyCancelled: false };
  await assert.rejects(
    () => fetchGitHubDispatchComments({
      fetchFn: async () => response({ comments: 1 }, {
        headers: { 'content-length': String(GITHUB_RESPONSE_MAX_BYTES + 1) },
        state,
      }),
      repository: 'owner/repo',
      issueNumber: 121,
    }),
    error => error.code === 'RESPONSE_TOO_LARGE',
  );
  assert.equal(state.reads, 0);
  assert.equal(state.bodyCancelled, true);
});

test('chunked Remote Dispatch overflow cancels before unbounded JSON materialization', async () => {
  const state = { reads: 0, cancelled: false, released: false, bodyCancelled: false };
  await assert.rejects(
    () => fetchGitHubDispatchComments({
      fetchFn: async () => rawResponse('', {
        chunks: [new Uint8Array(2_000_000), new Uint8Array(2_000_001)],
        state,
      }),
      repository: 'owner/repo',
      issueNumber: 121,
    }),
    error => error.code === 'RESPONSE_TOO_LARGE',
  );
  assert.equal(state.reads, 2);
  assert.equal(state.cancelled, true);
  assert.equal(state.released, true);
});

test('Remote Dispatch owns a bounded request+body timeout even when controller supplies no AbortSignal', async () => {
  const fetchFn = async (_url, options) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            return await new Promise((resolve, reject) => {
              if (options.signal.aborted) {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
                return;
              }
              options.signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              }, { once: true });
            });
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  });

  await assert.rejects(
    () => fetchGitHubDispatchComments({
      fetchFn,
      repository: 'owner/repo',
      issueNumber: 121,
      requestTimeoutMs: 5,
    }),
    error => error.code === 'REQUEST_TIMEOUT',
  );
  assert.equal(GITHUB_REQUEST_TIMEOUT_MS, 30_000);
});

test('caller abort remains distinct from the internal Remote Dispatch timeout', async () => {
  const controller = new AbortController();
  controller.abort();
  let fetchCount = 0;
  await assert.rejects(
    () => fetchGitHubDispatchComments({
      fetchFn: async (_url, options) => {
        fetchCount += 1;
        assert.equal(options.signal.aborted, true);
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
      repository: 'owner/repo',
      issueNumber: 121,
      signal: controller.signal,
    }),
    error => error.code === 'REQUEST_ABORTED',
  );
  assert.equal(fetchCount, 1);
});

test('fractional, non-finite and unsafe GitHub comment ids never enter Remote Dispatch identity', async () => {
  const result = await fetchGitHubDispatchComments({
    fetchFn: async url => url.includes('/comments')
      ? response([
        { id: 1.5, body: 'fractional' },
        { id: Number.NaN, body: 'nan' },
        { id: Number.MAX_SAFE_INTEGER + 1, body: 'unsafe' },
        { id: 2, body: 'valid' },
      ])
      : response({ comments: 4 }),
    repository: 'owner/repo',
    issueNumber: 121,
  });
  assert.deepEqual(result.comments.map(item => item.id), ['2']);
});

test('invalid trusted timeout override fails before Remote Dispatch network activity', async () => {
  let called = false;
  await assert.rejects(
    () => fetchGitHubDispatchComments({
      fetchFn: async () => {
        called = true;
        return response({ comments: 0 });
      },
      repository: 'owner/repo',
      issueNumber: 121,
      requestTimeoutMs: 0,
    }),
    error => error.code === 'INVALID_CONFIG',
  );
  assert.equal(called, false);
});
