import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REMOTE_DISPATCH_MARKER,
  RemoteDispatchValidationError,
  getDispatchApplicability,
  normalizeRemoteDispatch,
  parseRemoteDispatchComment,
  selectApplicableRemoteDispatch,
} from '../src/core/remote-dispatch.js';
import { RunMode, TabStrategy } from '../src/core/schema.js';

const NOW = Date.parse('2026-09-11T18:30:00Z');

function rawDispatch(overrides = {}) {
  return {
    schema_version: 1,
    dispatch_id: 'project-20260911-r1',
    strategy_revision: 1,
    generated_at: '2026-09-11T18:00:00Z',
    expires_at: '2026-09-11T20:00:00Z',
    project_id: 'project-a',
    target_repository: 'owner/repo',
    supersedes_dispatch_ids: [],
    policy: {
      poll_interval_seconds: 180,
      fallback_after_seconds: 900,
      fallback_enabled: true,
      max_active_sessions: 3,
    },
    sessions: [
      {
        session_key: 'later', name: 'Later', order: 20, enabled: true,
        run_mode: RunMode.CONTINUOUS,
        tab_strategy: TabStrategy.ONE_WORKER_TAB_PER_SESSION,
        minimum_send_interval_seconds: 180,
        pre_send_delay_seconds: 8,
        busy_check_delay_seconds: 2,
        retry_backoff_seconds: 60,
        not_before: null,
        expires_at: null,
        tasks: [
          { task_id: 'task-b', order: 20, enabled: true, url: 'https://chatgpt.com/', prompt: 'B', not_before: null, expires_at: null, max_launches: 1, supersedes_task_ids: [] },
          { task_id: 'task-a', order: 10, enabled: true, url: 'https://chatgpt.com/', prompt: 'A', not_before: null, expires_at: null, max_launches: 2, supersedes_task_ids: [] },
        ],
      },
      {
        session_key: 'first', name: 'First', order: 10, enabled: true,
        run_mode: RunMode.ONE_PASS,
        tab_strategy: TabStrategy.OPEN_CLOSE_PER_TASK,
        minimum_send_interval_seconds: 60,
        pre_send_delay_seconds: 1,
        busy_check_delay_seconds: 1,
        retry_backoff_seconds: 5,
        not_before: null,
        expires_at: null,
        tasks: [{ task_id: 'task-z', order: 10, enabled: true, url: 'https://chatgpt.com/', prompt: 'Z', not_before: null, expires_at: null, max_launches: 1, supersedes_task_ids: [] }],
      },
    ],
    ...overrides,
  };
}

function marked(raw = rawDispatch()) {
  return `${REMOTE_DISPATCH_MARKER}\n\n\`\`\`json\n${JSON.stringify(raw, null, 2)}\n\`\`\``;
}

test('valid marked dispatch parses and normalizes deterministic session/task order', () => {
  const { marked: isMarked, dispatch } = parseRemoteDispatchComment(marked());
  assert.equal(isMarked, true);
  assert.deepEqual(dispatch.sessions.map(x => x.session_key), ['first', 'later']);
  assert.deepEqual(dispatch.sessions[1].tasks.map(x => x.task_id), ['task-a', 'task-b']);
  assert.equal(dispatch.sessions[0].run_mode, RunMode.ONE_PASS);
});

test('unmarked human comment is ignored', () => {
  assert.deepEqual(parseRemoteDispatchComment('human checkpoint only'), { marked: false, dispatch: null });
});

test('malformed JSON fails closed with typed error', () => {
  assert.throws(() => parseRemoteDispatchComment(`${REMOTE_DISPATCH_MARKER}\n\`\`\`json\n{bad}\n\`\`\``), error => error instanceof RemoteDispatchValidationError && error.code === 'INVALID_JSON');
});

test('exactly one JSON fence is required', () => {
  const body = `${marked()}\n\n\`\`\`json\n{}\n\`\`\``;
  assert.throws(() => parseRemoteDispatchComment(body), /INVALID_ENVELOPE/);
});

test('wrong schema is rejected', () => {
  assert.throws(() => normalizeRemoteDispatch(rawDispatch({ schema_version: 2 })), error => error.code === 'UNSUPPORTED_SCHEMA');
});

test('wrong project, future and expired dispatches are not applicable', () => {
  const dispatch = normalizeRemoteDispatch(rawDispatch());
  assert.deepEqual(getDispatchApplicability(dispatch, { projectId: 'other', nowMs: NOW }), { applicable: false, reason: 'WRONG_PROJECT' });
  assert.equal(getDispatchApplicability(dispatch, { projectId: 'project-a', nowMs: Date.parse('2026-09-11T17:59:59Z') }).reason, 'NOT_YET_GENERATED');
  assert.equal(getDispatchApplicability(dispatch, { projectId: 'project-a', nowMs: Date.parse('2026-09-11T20:00:00Z') }).reason, 'EXPIRED');
});

test('duplicate session and task identities are rejected', () => {
  const d1 = rawDispatch();
  d1.sessions[1].session_key = d1.sessions[0].session_key;
  assert.throws(() => normalizeRemoteDispatch(d1), error => error.code === 'DUPLICATE_ID');

  const d2 = rawDispatch();
  d2.sessions[0].tasks[1].task_id = d2.sessions[0].tasks[0].task_id;
  assert.throws(() => normalizeRemoteDispatch(d2), error => error.code === 'DUPLICATE_ID');
});

test('task_id is globally unique across all sessions in one dispatch', () => {
  const raw = rawDispatch();
  raw.sessions[1].tasks[0].task_id = raw.sessions[0].tasks[0].task_id;
  assert.throws(
    () => normalizeRemoteDispatch(raw),
    error => error.code === 'DUPLICATE_ID' && error.path === 'sessions[].tasks',
  );
});

test('unsafe timing requests are rejected at local bounds', () => {
  const invalids = [
    ['minimum_send_interval_seconds', 59],
    ['pre_send_delay_seconds', 31],
    ['busy_check_delay_seconds', 0],
    ['retry_backoff_seconds', 4],
  ];
  for (const [field, value] of invalids) {
    const raw = rawDispatch();
    raw.sessions[0][field] = value;
    assert.throws(() => normalizeRemoteDispatch(raw), error => error.code === 'INVALID_INTEGER', field);
  }
});

test('poll/fallback policy is bounded and fallback cannot be shorter than poll cadence', () => {
  const raw = rawDispatch();
  raw.policy.poll_interval_seconds = 300;
  raw.policy.fallback_after_seconds = 120;
  assert.throws(() => normalizeRemoteDispatch(raw), error => error.code === 'INVALID_POLICY');
});

test('not_before must precede expires_at for both session and task', () => {
  const sessionBad = rawDispatch();
  sessionBad.sessions[0].not_before = '2026-09-11T19:00:00Z';
  sessionBad.sessions[0].expires_at = '2026-09-11T18:59:00Z';
  assert.throws(() => normalizeRemoteDispatch(sessionBad), error => error.code === 'INVALID_TIME_WINDOW');

  const taskBad = rawDispatch();
  taskBad.sessions[0].tasks[0].not_before = '2026-09-11T19:00:00Z';
  taskBad.sessions[0].tasks[0].expires_at = '2026-09-11T19:00:00Z';
  assert.throws(() => normalizeRemoteDispatch(taskBad), error => error.code === 'INVALID_TIME_WINDOW');
});

test('selection ignores human/wrong-project/expired comments and chooses newest valid strategy revision', () => {
  const old = rawDispatch({ dispatch_id: 'old', strategy_revision: 1 });
  const newer = rawDispatch({ dispatch_id: 'newer', strategy_revision: 3, generated_at: '2026-09-11T18:20:00Z' });
  const wrong = rawDispatch({ dispatch_id: 'wrong', strategy_revision: 99, project_id: 'other' });
  const expired = rawDispatch({ dispatch_id: 'expired', strategy_revision: 100, generated_at: '2026-09-11T16:00:00Z', expires_at: '2026-09-11T17:00:00Z' });
  const result = selectApplicableRemoteDispatch([
    { id: 1, body: 'human' },
    { id: 2, body: marked(old) },
    { id: 3, body: marked(wrong) },
    { id: 4, body: marked(expired) },
    { id: 5, body: marked(newer) },
  ], { projectId: 'project-a', nowMs: NOW });
  assert.equal(result.selected.commentId, '5');
  assert.equal(result.selected.dispatch.dispatch_id, 'newer');
  assert.deepEqual(result.diagnostics.map(x => x.reason).sort(), ['EXPIRED', 'WRONG_PROJECT']);
});

test('normalization does not mutate caller input', () => {
  const raw = rawDispatch();
  const before = structuredClone(raw);
  normalizeRemoteDispatch(raw);
  assert.deepEqual(raw, before);
});

test('prompt and identifier limits reject oversized/untrusted inputs', () => {
  const badId = rawDispatch({ dispatch_id: '../bad id' });
  assert.throws(() => normalizeRemoteDispatch(badId), error => error.code === 'INVALID_STRING');
  const longPrompt = rawDispatch();
  longPrompt.sessions[0].tasks[0].prompt = 'x'.repeat(250_001);
  assert.throws(() => normalizeRemoteDispatch(longPrompt), error => error.code === 'INVALID_STRING');
});


test('GitHub poll cadence is clamped by schema to at least three minutes', () => {
  const raw = rawDispatch();
  raw.policy.poll_interval_seconds = 179;
  assert.throws(() => normalizeRemoteDispatch(raw), error => error.code === 'INVALID_INTEGER');
});

test('remote tasks require an allowed ChatGPT launch URL', () => {
  const missing = rawDispatch();
  delete missing.sessions[0].tasks[0].url;
  assert.throws(() => normalizeRemoteDispatch(missing), error => error.code === 'INVALID_URL');
  const hostile = rawDispatch();
  hostile.sessions[0].tasks[0].url = 'https://example.com/';
  assert.throws(() => normalizeRemoteDispatch(hostile), error => error.code === 'INVALID_URL');
  const normalized = rawDispatch();
  normalized.sessions[0].tasks[0].url = 'https://www.chatgpt.com/#fragment';
  assert.equal(normalizeRemoteDispatch(normalized).sessions[1].tasks[1].url, 'https://chatgpt.com/');
});
