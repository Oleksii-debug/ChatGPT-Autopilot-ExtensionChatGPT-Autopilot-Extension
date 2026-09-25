import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageRepository } from '../src/core/storage.js';
import { REMOTE_DISPATCH_CONFIG_STORAGE_KEY } from '../src/core/remote-dispatch-config.js';
import { RemoteDispatchController } from '../src/core/remote-dispatch-controller.js';
import { remoteLocalSessionId } from '../src/core/remote-dispatch-import.js';

const NOW = Date.parse('2026-09-11T18:30:00Z');
function fakeChrome(projectId) {
  const data = {
    [REMOTE_DISPATCH_CONFIG_STORAGE_KEY]: {
      enabled: true, projectId, repository: 'o/r', issueNumber: 121,
      minimumPollIntervalSeconds: 180, fallbackEnabled: false,
      fallbackAfterSeconds: 900, fallbackSessionId: '', autoStart: true,
    },
  };
  return {
    data,
    storage: { local: {
      async get(key) { return { [key]: data[key] }; },
      async set(record) { Object.assign(data, structuredClone(record)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    } },
    alarms: { async create() {}, async clear() { return true; } },
  };
}
function marked({ projectId, dispatchId, sessionKey, taskId, prompt, revision }) {
  const d = {
    schema_version: 1, dispatch_id: dispatchId, strategy_revision: revision,
    generated_at: '2026-09-11T18:00:00Z', expires_at: '2026-09-11T20:00:00Z',
    project_id: projectId, target_repository: 'o/r', supersedes_dispatch_ids: [],
    policy: { poll_interval_seconds: 180, fallback_after_seconds: 900, fallback_enabled: true, max_active_sessions: 1 },
    sessions: [{
      session_key: sessionKey, name: sessionKey, order: 1, enabled: true,
      run_mode: 'ONE_PASS', tab_strategy: 'OPEN_CLOSE_PER_TASK', minimum_send_interval_seconds: 60,
      pre_send_delay_seconds: 1, busy_check_delay_seconds: 1, retry_backoff_seconds: 5,
      not_before: null, expires_at: null,
      tasks: [{ task_id: taskId, order: 1, enabled: true, url: 'https://chatgpt.com/', prompt, not_before: null, expires_at: null, max_launches: 1, supersedes_task_ids: [] }],
    }],
  };
  return `<!-- CHATGPT_AUTOPILOT_DISPATCH_V1 -->\n\`\`\`json\n${JSON.stringify(d)}\n\`\`\``;
}
function response(json) { return { ok:true, status:200, headers:{ get(){ return '50'; } }, async json(){ return structuredClone(json); } }; }

test('two Chrome profiles consume only their own project_id from the same GitHub Issue', async () => {
  const comments = [
    { id: 101, body: marked({ projectId:'nika', dispatchId:'nika-r1', sessionKey:'nika-build', taskId:'nika-1', prompt:'Nika work', revision:1 }) },
    { id: 102, body: marked({ projectId:'chess', dispatchId:'chess-r7', sessionKey:'chess-a11y', taskId:'chess-1', prompt:'Chess work', revision:7 }) },
  ];
  const fetchFn = async url => url.includes('/comments') ? response(comments) : response({ comments:comments.length });
  const nikaChrome = fakeChrome('nika');
  const chessChrome = fakeChrome('chess');
  const nikaRepo = new StorageRepository(nikaChrome);
  const chessRepo = new StorageRepository(chessChrome);
  const nika = new RemoteDispatchController({ coreRepository:nikaRepo, chromeApi:nikaChrome, fetchFn, now:()=>NOW });
  const chess = new RemoteDispatchController({ coreRepository:chessRepo, chromeApi:chessChrome, fetchFn, now:()=>NOW });

  const [nikaResult, chessResult] = await Promise.all([nika.poll(), chess.poll()]);
  assert.equal(nikaResult.dispatch.dispatch_id, 'nika-r1');
  assert.equal(chessResult.dispatch.dispatch_id, 'chess-r7');

  const nikaState = await nikaRepo.load();
  const chessState = await chessRepo.load();
  assert.ok(nikaState.sessionsById[remoteLocalSessionId('nika','nika-build')]);
  assert.equal(nikaState.sessionsById[remoteLocalSessionId('chess','chess-a11y')], undefined);
  assert.ok(chessState.sessionsById[remoteLocalSessionId('chess','chess-a11y')]);
  assert.equal(chessState.sessionsById[remoteLocalSessionId('nika','nika-build')], undefined);
});

test('profile with no matching project dispatch stays empty and does not execute another project', async () => {
  const comments = [{ id:101, body:marked({ projectId:'nika', dispatchId:'nika-r1', sessionKey:'nika-build', taskId:'nika-1', prompt:'Nika work', revision:1 }) }];
  const fetchFn = async url => url.includes('/comments') ? response(comments) : response({ comments:1 });
  const chrome = fakeChrome('ai-12-6');
  const repo = new StorageRepository(chrome);
  const controller = new RemoteDispatchController({ coreRepository:repo, chromeApi:chrome, fetchFn, now:()=>NOW });
  const result = await controller.poll();
  assert.equal(result.kind, 'NO_DISPATCH');
  const state = await repo.load();
  assert.deepEqual(state.sessionOrder, []);
});
