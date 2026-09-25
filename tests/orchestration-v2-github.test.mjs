import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGitHubOrchestrationControl, OrchestrationGitHubError } from '../src/core/orchestration-v2-github.js';
import { ORCHESTRATION_CONTROL_MARKER } from '../src/core/orchestration-v2.js';

const NOW = Date.parse('2026-09-11T20:00:00Z');
function payload(revision = 1, project = 'proj', generation = 1) {
  return {
    schema_version: 2,
    project_id: project,
    revision,
    coordinator_generation: generation,
    generated_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 3600000).toISOString(),
    mode: 'RUN',
    actions: [{ type:'NO_ACTION' }],
  };
}
function body(p = payload()) { return `${ORCHESTRATION_CONTROL_MARKER}\n\`\`\`json\n${JSON.stringify(p)}\n\`\`\``; }
function response(json, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { const key = Object.keys(headers).find(k => k.toLowerCase() === String(name).toLowerCase()); return key ? headers[key] : null; } },
    async json(){ return structuredClone(json); },
  };
}

test('pinned canonical comment fetch reads one stable comment and selects newer revision', async () => {
  const seen = [];
  const fetchFn = async url => { seen.push(url); return response({ id:99, body:body(payload(5)), html_url:'https://github/x#99' }, { headers:{'x-ratelimit-remaining':'55'} }); };
  const result = await fetchGitHubOrchestrationControl({ fetchFn, repository:'owner/repo', issueNumber:122, commentId:99, projectId:'proj', coordinatorGeneration:1, lastAppliedRevision:4, nowMs:NOW });
  assert.equal(result.selected.control.revision, 5);
  assert.equal(result.selected.commentId, 99);
  assert.equal(result.rateLimitRemaining, 55);
  assert.match(seen[0], /issues\/comments\/99$/);
});

test('same or older revision is unchanged and never re-applied after restart', async () => {
  const fetchFn = async () => response({ id:99, body:body(payload(5)) });
  const result = await fetchGitHubOrchestrationControl({ fetchFn, repository:'owner/repo', issueNumber:122, commentId:99, projectId:'proj', coordinatorGeneration:1, lastAppliedRevision:5, nowMs:NOW });
  assert.equal(result.selected, null);
  assert.equal(result.unchanged, true);
});

test('wrong project/generation or malformed marked comment fails closed as diagnostic', async () => {
  for (const bad of [body(payload(1,'other',1)), body(payload(1,'proj',2)), `${ORCHESTRATION_CONTROL_MARKER}\n\`\`\`json\n{bad}\n\`\`\``]) {
    const result = await fetchGitHubOrchestrationControl({ fetchFn:async()=>response({id:99,body:bad}), repository:'owner/repo', issueNumber:122, commentId:99, projectId:'proj', coordinatorGeneration:1, nowMs:NOW });
    assert.equal(result.selected, null);
    assert.equal(result.diagnostics[0].code, 'INVALID_CONTROL_COMMENT');
  }
});

test('discovery mode ignores human chatter and picks highest valid revision', async () => {
  const fetchFn = async url => {
    if (/\/issues\/122$/.test(url)) return response({ comments: 3 });
    return response([
      { id:1, body:'human' },
      { id:2, body:body(payload(2)) },
      { id:3, body:body(payload(7)) },
    ]);
  };
  const result = await fetchGitHubOrchestrationControl({ fetchFn, repository:'owner/repo', issueNumber:122, projectId:'proj', coordinatorGeneration:1, lastAppliedRevision:1, nowMs:NOW });
  assert.equal(result.selected.control.revision, 7);
  assert.equal(result.selected.commentId, 3);
});

test('discovery mode starts from newest pages when an issue has more than 100 comments', async () => {
  const seen = [];
  const fetchFn = async url => {
    seen.push(url);
    if (/\/issues\/122$/.test(url)) return response({ comments: 150 });
    if (/page=2$/.test(url)) return response([
      { id:149, body:'human' },
      { id:150, body:body(payload(9)) },
    ]);
    if (/page=1$/.test(url)) return response([{ id:100, body:'older human chatter' }]);
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await fetchGitHubOrchestrationControl({ fetchFn, repository:'owner/repo', issueNumber:122, projectId:'proj', coordinatorGeneration:1, lastAppliedRevision:8, nowMs:NOW });
  assert.equal(result.selected.control.revision, 9);
  assert.equal(result.selected.commentId, 150);
  assert.match(seen[1], /page=2$/);
  assert.equal(seen.some(url => /page=1$/.test(url)), true, 'bootstrap scans the full bounded newest-page window before choosing a revision');
});

test('discovery scans the bounded newest-page window before choosing highest revision', async () => {
  const seen = [];
  const fetchFn = async url => {
    seen.push(url);
    if (/\/issues\/122$/.test(url)) return response({ comments: 250 });
    if (/page=3$/.test(url)) return response([
      { id:249, body:'human' },
      { id:250, body:body(payload(10)) },
    ]);
    if (/page=2$/.test(url)) return response([{ id:150, body:body(payload(12)) }]);
    if (/page=1$/.test(url)) return response([{ id:100, body:body(payload(11)) }]);
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await fetchGitHubOrchestrationControl({ fetchFn, repository:'owner/repo', issueNumber:122, projectId:'proj', coordinatorGeneration:1, lastAppliedRevision:9, nowMs:NOW });
  assert.equal(result.selected.control.revision, 12);
  assert.equal(result.selected.commentId, 150);
  assert.deepEqual(seen.slice(1).map(url => Number(new URL(url).searchParams.get('page'))), [3,2,1]);
});

test('rate limit is typed and exposes durable retry deadline', async () => {
  const reset = Math.floor((NOW + 600000) / 1000);
  const fetchFn = async () => response({message:'limit'}, { status:403, headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(reset)} });
  await assert.rejects(
    () => fetchGitHubOrchestrationControl({ fetchFn, repository:'owner/repo', issueNumber:122, commentId:99, projectId:'proj', coordinatorGeneration:1, nowMs:NOW }),
    error => error instanceof OrchestrationGitHubError && error.code === 'GITHUB_RATE_LIMITED' && error.retryAfterAt === reset * 1000,
  );
});
