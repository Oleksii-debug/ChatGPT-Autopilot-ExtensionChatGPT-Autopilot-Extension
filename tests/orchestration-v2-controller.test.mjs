import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageRepository } from '../src/core/storage.js';
import { RunState } from '../src/core/schema.js';
import { CoordinatorEventType, WorkerState, ORCHESTRATION_CONTROL_MARKER, acquireCoordinatorLease, applyControlDecision, enqueueCoordinatorEvent } from '../src/core/orchestration-v2.js';
import { OrchestrationV2Controller, ORCHESTRATION_V2_ALARM } from '../src/core/orchestration-v2-controller.js';

const START = Date.parse('2026-09-11T20:00:00Z');
const CONFIG = {
  enabled: true,
  projectId: 'proj',
  targetRepository: 'owner/target',
  controlRepository: 'owner/control',
  controlIssueNumber: 122,
  controlCommentId: 99,
  masterCoordinatorPrompt: 'MASTER COORDINATOR: read live GitHub, maintain rolling worker pool.',
  defaultDesiredWorkers: 1,
  absoluteMaxWorkers: 2,
  watchdogIntervalSeconds: 300,
  maxCoordinatorTurns: 10,
};

function chromeFake() {
  const data = {};
  const alarms = [];
  return {
    data, alarmCalls: alarms,
    storage:{local:{
      async get(key){ return { [key]: structuredClone(data[key]) }; },
      async set(record){ Object.assign(data, structuredClone(record)); },
      async remove(keys){ for(const key of Array.isArray(keys)?keys:[keys]) delete data[key]; },
    }},
    alarms:{
      async create(name, options){ alarms.push(['create', name, structuredClone(options)]); },
      async clear(name){ alarms.push(['clear', name]); return true; },
    },
  };
}

function control(revision, actions, generation = 1) {
  return {
    schema_version:2,
    project_id:'proj',
    revision,
    coordinator_generation:generation,
    generated_at:new Date(START + revision * 1000).toISOString(),
    expires_at:new Date(START + 3600000).toISOString(),
    mode:'RUN',
    actions,
  };
}
function task(id){ return { task_id:id, prompt:`Implement ${id}`, priority:10, dependencies:[], conflict_key:'', generation:1, launch_mode:'FRESH_CHAT', exact_once_key:`${id}@1`, not_before:null, expires_at:null, target_repository:'owner/target' }; }
function body(payload){ return `${ORCHESTRATION_CONTROL_MARKER}\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``; }
function response(payload){ return { ok:true, status:200, headers:{get(){return '50';}}, async json(){ return structuredClone(payload); } }; }

function findCoordinator(state){ return Object.values(state.sessionsById).find(s => s.orchestrationCoordinator?.managed); }
function findWorker(state, taskId){ return Object.values(state.sessionsById).find(s => s.orchestrationWorker?.taskId === taskId); }
function markSent(session, url, at, baseline = 0){
  const taskState = session.tasksById[session.taskOrder[0]];
  taskState.lastVerifiedSendAt = at;
  taskState.lastVerifiedFingerprint = `sha256:${session.id}:${at}`;
  taskState.lastConversationUrl = url;
  taskState.lastAssistantBaselineCount = baseline;
  taskState.lastAssistantBaselineKnown = true;
  session.runState = RunState.STOPPED;
  session.completedAt = at;
  // Controller-layer tests model the clean post-verification persisted state.
  // The core operation has already reached a terminal checkpoint and may be cleared.
  session.operation = null;
}

test('vertical slice: coordinator -> strict control -> fresh worker -> completion -> immediate coordinator -> NO_ACTION survives restart', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  let controlRevision = 1;
  let coordinatorComplete = false;
  let workerComplete = false;
  const controls = {
    1: control(1, [{ type:'ADD_TASKS', tasks:[task('worker-a')] }]),
    2: control(2, [{ type:'NO_ACTION' }]),
  };
  const fetchFn = async url => {
    assert.match(url, /issues\/comments\/99$/);
    return response({ id:99, body:body(controls[controlRevision]), html_url:'https://github/control#99' });
  };
  const collectAssistantReport = async probe => {
    if (String(probe.taskId).startsWith('coordinator:')) {
      return coordinatorComplete
        ? { status:'READY', assistantComplete:true, assistantText:'Control revision published.' }
        : { status:'BUSY', assistantComplete:false };
    }
    if (probe.taskId === 'worker-a') {
      return workerComplete
        ? { status:'READY', assistantComplete:true, assistantText:'Worker finished and pushed changes.' }
        : { status:'BUSY', assistantComplete:false };
    }
    return { status:'TEMPORARY_ERROR', assistantComplete:false };
  };
  const controller = new OrchestrationV2Controller({ coreRepository:core, chromeApi:chrome, fetchFn, collectAssistantReport, now:()=>now });
  await controller.updateConfig(CONFIG);

  // Initial cycle creates only the coordinator Session/lease. No worker exists yet.
  let cycle = await controller.cycle({ nowMs:now });
  let state = await core.load();
  let coordinator = findCoordinator(state);
  assert.ok(coordinator);
  assert.equal(coordinator.runState, RunState.RUNNING);
  assert.equal(Object.values(state.sessionsById).filter(s => s.orchestrationWorker?.managed).length, 0);
  assert.equal(cycle.status.runtime.coordinator.status, 'BUSY');

  // Existing core executor is the only sender; simulate its positively verified coordinator Send.
  now += 5_000;
  await core.update(draft => { markSent(findCoordinator(draft), 'https://chatgpt.com/c/coord-1', now, 1); return draft; });
  await controller.syncAfterCoreCycle({ nowMs:now });
  let status = await controller.getStatus();
  assert.equal(status.runtime.coordinator.chatUrl, 'https://chatgpt.com/c/coord-1');
  assert.equal(status.runtime.coordinator.deliveredTurnId, status.runtime.coordinator.lease.turnId);

  // A BUSY probe for the same coordinator turn must never re-arm the one-pass
  // Core Session and send the same tick twice.
  now += 30_000;
  await controller.cycle({ nowMs:now });
  state = await core.load();
  coordinator = findCoordinator(state);
  assert.equal(coordinator.runState, RunState.STOPPED);
  assert.equal(coordinator.tasksById[coordinator.taskOrder[0]].lastVerifiedSendAt, START + 5_000);

  // Coordinator completes and publishes strict control revision 1 -> exactly one fresh worker Session.
  coordinatorComplete = true;
  now += 1_000;
  cycle = await controller.cycle({ nowMs:now });
  assert.equal(cycle.control.kind, 'CONTROL_APPLIED');
  state = await core.load();
  let workerSession = findWorker(state, 'worker-a');
  assert.ok(workerSession);
  assert.equal(workerSession.tasksById[workerSession.taskOrder[0]].url, 'https://chatgpt.com/');
  assert.equal(workerSession.runState, RunState.RUNNING);
  status = await controller.getStatus();
  assert.equal(status.runtime.lastAppliedControlRevision, 1);
  assert.equal(status.runtime.workerCounts.LAUNCHING, 1);

  // Verified worker prompt delivery activates the orchestration worker, but does not mark it complete.
  now += 5_000;
  await core.update(draft => { markSent(findWorker(draft, 'worker-a'), 'https://chatgpt.com/c/worker-a', now, 2); return draft; });
  await controller.syncAfterCoreCycle({ nowMs:now });
  status = await controller.getStatus();
  assert.equal(status.runtime.workerCounts.ACTIVE, 1);
  assert.equal(status.runtime.workerCounts.COMPLETED, 0);

  // Worker completes. Controller creates terminal event and immediately reuses same coordinator chat for next tick.
  workerComplete = true;
  coordinatorComplete = false;
  controlRevision = 2;
  now += 1_000;
  await controller.cycle({ nowMs:now });
  state = await core.load();
  coordinator = findCoordinator(state);
  assert.equal(coordinator.runState, RunState.RUNNING);
  assert.equal(coordinator.tasksById[coordinator.taskOrder[0]].url, 'https://chatgpt.com/c/coord-1');
  status = await controller.getStatus();
  assert.equal(status.runtime.workerCounts.COMPLETED, 1);
  assert.equal(status.runtime.coordinator.status, 'BUSY');
  assert.equal(status.runtime.coordinator.lastAssistantBaselineKnown, false, 'new turn must not inherit prior assistant baseline');
  assert.equal(coordinator.tasksById[coordinator.taskOrder[0]].lastVerifiedSendAt, 0, 'new turn must clear prior Send evidence before delivery');

  // Second coordinator turn sends to same bounded persistent coordinator chat.
  now += 5_000;
  await core.update(draft => { markSent(findCoordinator(draft), 'https://chatgpt.com/c/coord-1', now, 2); return draft; });
  await controller.syncAfterCoreCycle({ nowMs:now });
  coordinatorComplete = true;
  now += 1_000;
  cycle = await controller.cycle({ nowMs:now });
  assert.equal(cycle.control.kind, 'CONTROL_APPLIED');
  status = await controller.getStatus();
  assert.equal(status.runtime.lastAppliedControlRevision, 2);
  assert.equal(status.runtime.workerCounts.COMPLETED, 1);
  assert.equal(status.runtime.workerCounts.QUEUED, 0);
  assert.equal(status.runtime.coordinator.turnsUsed, 2);

  // Restart controller against the same durable storage: no duplicate task/control is created.
  const restarted = new OrchestrationV2Controller({ coreRepository:core, chromeApi:chrome, fetchFn, collectAssistantReport, now:()=>now });
  const restartedStatus = await restarted.getStatus();
  assert.equal(restartedStatus.runtime.lastAppliedControlRevision, 2);
  assert.equal(restartedStatus.runtime.workerCounts.COMPLETED, 1);
  assert.equal(Object.values((await core.load()).sessionsById).filter(s => s.orchestrationWorker?.managed).length, 1);
});

test('worker completion while coordinator is BUSY is coalesced and does not start a second coordinator turn', async () => {
  const chrome = chromeFake(); const core = new StorageRepository(chrome); let now = START;
  const controller = new OrchestrationV2Controller({ coreRepository:core, chromeApi:chrome, fetchFn:async()=>response({id:99,body:body(control(1,[{type:'NO_ACTION'}]))}), collectAssistantReport:async()=>({status:'BUSY',assistantComplete:false}), now:()=>now });
  await controller.updateConfig(CONFIG);
  await controller.cycle({nowMs:now});
  let runtime = await controller.runtimeRepository.load();
  const turnId = runtime.coordinator.lease.turnId;
  await controller.runtimeRepository.update(draft => {
    draft.workersById.w = { workerId:'w', taskId:'t', state:WorkerState.ACTIVE, chatUrl:'https://chatgpt.com/c/w', assistantBaselineKnown:true, assistantBaselineCount:1, dependencies:[], conflictKey:'', prompt:'x', exactOnceKey:'t@1' };
    draft.workerOrder.push('w');
    return draft;
  });
  controller.collectAssistantReport = async probe => probe.workerId === 'w'
    ? {status:'READY',assistantComplete:true,assistantText:'done'}
    : {status:'BUSY',assistantComplete:false};
  now += 30_000;
  await controller.cycle({nowMs:now});
  runtime = await controller.runtimeRepository.load();
  assert.equal(runtime.coordinator.lease.turnId, turnId);
  assert.equal(runtime.pendingCoordinatorEvents.some(e => e.workerId === 'w'), true);
});

test('watchdog after five minutes produces reconciliation turn but no workers without coordinator ADD_TASKS', async () => {
  const chrome = chromeFake(); const core = new StorageRepository(chrome); let now = START;
  let coordinatorComplete = false;
  let revision = 1;
  const fetchFn = async()=>response({id:99,body:body(control(revision,[{type:'NO_ACTION'}]))});
  const controller = new OrchestrationV2Controller({ coreRepository:core, chromeApi:chrome, fetchFn, collectAssistantReport:async()=>coordinatorComplete?{status:'READY',assistantComplete:true,assistantText:'no action'}:{status:'BUSY',assistantComplete:false}, now:()=>now });
  await controller.updateConfig(CONFIG);
  await controller.cycle({nowMs:now});
  now += 5_000; await core.update(d=>{markSent(findCoordinator(d),'https://chatgpt.com/c/coord',now,1);return d;}); await controller.syncAfterCoreCycle({nowMs:now});
  coordinatorComplete = true; now += 1_000; await controller.cycle({nowMs:now});
  let status = await controller.getStatus();
  assert.equal(status.runtime.lastAppliedControlRevision,1);
  assert.equal(status.runtime.workerCounts.QUEUED,0);

  coordinatorComplete = false;
  now += 299_000;
  await controller.cycle({nowMs:now});
  status = await controller.getStatus();
  assert.equal(status.runtime.coordinator.status,'IDLE');
  assert.equal(status.runtime.workerCounts.QUEUED,0);

  now += 2_000;
  await controller.cycle({nowMs:now});
  status = await controller.getStatus();
  assert.equal(status.runtime.coordinator.status,'BUSY');
  assert.equal(status.runtime.workerCounts.QUEUED,0);
});

test('disabling orchestration revokes future managed work but preserves unresolved send evidence', async () => {
  const chrome = chromeFake(); const core = new StorageRepository(chrome); let now=START;
  const controller = new OrchestrationV2Controller({coreRepository:core,chromeApi:chrome,fetchFn:async()=>response({id:99,body:'human'}),now:()=>now});
  await controller.updateConfig(CONFIG);
  await controller.cycle({nowMs:now});
  await core.update(state => {
    const session = findCoordinator(state);
    const taskId = session.taskOrder[0];
    const taskState = session.tasksById[taskId];
    session.operation = {
      operationId:'op',
      sessionId:session.id,
      taskId,
      promptFingerprint:'sha256:test',
      phase:'AMBIGUOUS',
      targetUrl:taskState.normalizedUrl,
      createdAt:now,
      updatedAt:now,
      preSendDeadline:0,
      submitStartedAt:now,
      verificationDeadline:now + 60_000,
      generation:1,
      promptText:taskState.prompt || 'test',
    };
    session.runState = RunState.RECOVERING;
    return state;
  });
  await controller.updateConfig({...CONFIG, enabled:false});
  const state = await core.load();
  const session = findCoordinator(state);
  assert.equal(session.enabled,false);
  assert.equal(session.runState,RunState.RECOVERING);
  assert.equal(session.operation.phase,'AMBIGUOUS');
  assert.equal(chrome.alarmCalls.at(-1)[1], ORCHESTRATION_V2_ALARM);
});

test('coordinator rate limit preserves the same turn, avoids duplicate delivery, and schedules bounded retry', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  let reportCalls = 0;
  const controller = new OrchestrationV2Controller({
    coreRepository:core,
    chromeApi:chrome,
    fetchFn:async()=>response({id:99,body:body(control(1,[{type:'NO_ACTION'}]))}),
    collectAssistantReport:async probe => {
      if (!String(probe.taskId).startsWith('coordinator:')) return {status:'BUSY'};
      reportCalls += 1;
      return {status:'RATE_LIMITED', retryAfterAt:now + 60_000, assistantComplete:false};
    },
    now:()=>now,
  });
  await controller.updateConfig(CONFIG);
  await controller.cycle({nowMs:now});
  let runtime = await controller.runtimeRepository.load();
  const turnId = runtime.coordinator.lease.turnId;

  now += 5_000;
  await core.update(draft => { markSent(findCoordinator(draft), 'https://chatgpt.com/c/coord-rate', now, 1); return draft; });
  await controller.syncAfterCoreCycle({nowMs:now});

  now += 30_000;
  const limited = await controller.cycle({nowMs:now});
  runtime = await controller.runtimeRepository.load();
  assert.equal(reportCalls,1);
  assert.equal(runtime.coordinator.lease.turnId,turnId);
  assert.ok(runtime.coordinator.retryAfterAt >= now + 30_000);
  assert.equal(limited.coordinatorProbe.applied.rateLimited,true);
  let state = await core.load();
  const coordinator = findCoordinator(state);
  assert.equal(coordinator.runState,RunState.STOPPED,'same coordinator turn must not be re-armed while backpressured');
  assert.ok(coordinator.tasksById[coordinator.taskOrder[0]].lastVerifiedSendAt > 0);

  const retryAt = runtime.coordinator.retryAfterAt;
  let lastAlarm = chrome.alarmCalls.filter(call => call[0] === 'create' && call[1] === ORCHESTRATION_V2_ALARM).at(-1);
  assert.ok(lastAlarm[2].when > now,'rate limit must not create an immediate alarm loop');

  // One earlier watchdog wake is allowed. It must reconcile only and then sleep
  // until the real retry deadline rather than repeatedly probing the coordinator.
  now = Math.min(lastAlarm[2].when, retryAt - 1);
  const watchdogDuringBackoff = await controller.cycle({nowMs:now});
  assert.equal(watchdogDuringBackoff.coordinatorProbe.kind,'COORDINATOR_BACKOFF');
  assert.equal(reportCalls,1);
  runtime = await controller.runtimeRepository.load();
  assert.equal(runtime.coordinator.lease.turnId,turnId);
  lastAlarm = chrome.alarmCalls.filter(call => call[0] === 'create' && call[1] === ORCHESTRATION_V2_ALARM).at(-1);
  assert.ok(lastAlarm[2].when >= retryAt,'after watchdog reconciliation the next wake must honor coordinator backoff');

  now = retryAt + 1;
  controller.collectAssistantReport = async()=>({status:'BUSY',assistantComplete:false});
  await controller.cycle({nowMs:now});
  runtime = await controller.runtimeRepository.load();
  assert.equal(runtime.coordinator.retryAfterAt,0);
  assert.equal(runtime.coordinator.lease.turnId,turnId,'retry continues the original turn rather than creating another');
});

test('read-only GitHub control test works before coordinator lease and mutates no orchestration state', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  const controller = new OrchestrationV2Controller({
    coreRepository:core,
    chromeApi:chrome,
    fetchFn:async url => {
      assert.match(url,/issues\/comments\/99$/);
      return response({id:99,body:body(control(7,[{type:'NO_ACTION'}])),html_url:'https://github/control#99'});
    },
    now:()=>now,
  });

  const before = await controller.runtimeRepository.load();
  assert.equal(before.coordinator.lease,null);
  assert.equal(before.lastAppliedControlRevision,0);
  const result = await controller.testControl({...CONFIG,enabled:false},{nowMs:now + 10_000});
  assert.equal(result.kind,'CONTROL_TEST');
  assert.equal(result.selected.control.revision,7);
  assert.equal(result.selected.control.coordinator_generation,1);
  const after = await controller.runtimeRepository.load();
  assert.equal(after.coordinator.lease,null);
  assert.equal(after.lastAppliedControlRevision,0);
  assert.equal(Object.keys((await core.load()).sessionsById).length,0);
});

test('restart after worker terminal event but before coordinator turn preserves one durable event and resumes reconciliation', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  let coordinatorComplete = false;
  let workerComplete = false;
  const fetchFn = async()=>response({id:99,body:body(control(1,[{type:'ADD_TASKS',tasks:[task('worker-restart')]}]))});
  const collectAssistantReport = async probe => {
    if (String(probe.taskId).startsWith('coordinator:')) return coordinatorComplete ? {status:'READY',assistantComplete:true,assistantText:'published'} : {status:'BUSY',assistantComplete:false};
    if (probe.taskId === 'worker-restart') return workerComplete ? {status:'READY',assistantComplete:true,assistantText:'done'} : {status:'BUSY',assistantComplete:false};
    return {status:'TEMPORARY_ERROR',assistantComplete:false};
  };
  const controller = new OrchestrationV2Controller({coreRepository:core,chromeApi:chrome,fetchFn,collectAssistantReport,now:()=>now});
  await controller.updateConfig(CONFIG);
  await controller.cycle({nowMs:now});
  now += 5_000;
  await core.update(draft=>{ markSent(findCoordinator(draft),'https://chatgpt.com/c/coord-restart',now,1); return draft; });
  await controller.syncAfterCoreCycle({nowMs:now});
  coordinatorComplete = true;
  now += 1_000;
  await controller.cycle({nowMs:now});
  now += 5_000;
  await core.update(draft=>{ markSent(findWorker(draft,'worker-restart'),'https://chatgpt.com/c/worker-restart',now,2); return draft; });
  await controller.syncAfterCoreCycle({nowMs:now});

  workerComplete = true;
  now += 1_000;
  const probed = await controller.probeWorkerCompletions({nowMs:now});
  assert.deepEqual(probed.terminal.length,1);
  let runtime = await controller.runtimeRepository.load();
  assert.equal(runtime.coordinator.lease,null,'crash point is before a new coordinator lease');
  assert.equal(runtime.pendingCoordinatorEvents.filter(e=>e.workerId && e.workerId.includes('worker:proj')).length,1);
  const pendingEventId = runtime.pendingCoordinatorEvents.find(e=>e.workerId)?.id;

  // New controller instance simulates service-worker/extension process restart.
  coordinatorComplete = false;
  const restarted = new OrchestrationV2Controller({coreRepository:core,chromeApi:chrome,fetchFn,collectAssistantReport,now:()=>now});
  now += 1_000;
  await restarted.cycle({nowMs:now});
  runtime = await restarted.runtimeRepository.load();
  assert.ok(runtime.coordinator.lease,'pending terminal event must wake coordinator after restart');
  assert.equal(runtime.coordinator.lease.eventIds.includes(pendingEventId),true);
  assert.equal(runtime.pendingCoordinatorEvents.filter(e=>e.id===pendingEventId).length,1,'event is not duplicated before control consumes it');
  assert.equal(runtime.coordinator.turnsUsed,1,'restart must not manufacture an extra completed coordinator turn');
  const coordinator = findCoordinator(await core.load());
  assert.equal(coordinator.runState,RunState.RUNNING);
  assert.equal(coordinator.tasksById[coordinator.taskOrder[0]].url,'https://chatgpt.com/c/coord-restart','same durable coordinator conversation is reused');
});

test('restart during coordinator rate-limit preserves the same delivered lease and does not resend its tick', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  let calls = 0;
  const fetchFn = async()=>response({id:99,body:body(control(1,[{type:'NO_ACTION'}]))});
  const limitedCollector = async probe => {
    if (!String(probe.taskId).startsWith('coordinator:')) return {status:'BUSY',assistantComplete:false};
    calls += 1;
    return {status:'RATE_LIMITED',retryAfterAt:now+60_000,assistantComplete:false};
  };
  const controller = new OrchestrationV2Controller({coreRepository:core,chromeApi:chrome,fetchFn,collectAssistantReport:limitedCollector,now:()=>now});
  await controller.updateConfig(CONFIG);
  await controller.cycle({nowMs:now});
  let runtime = await controller.runtimeRepository.load();
  const turnId = runtime.coordinator.lease.turnId;
  now += 5_000;
  await core.update(draft=>{ markSent(findCoordinator(draft),'https://chatgpt.com/c/coord-retry-restart',now,1); return draft; });
  await controller.syncAfterCoreCycle({nowMs:now});
  now += 30_000;
  await controller.cycle({nowMs:now});
  runtime = await controller.runtimeRepository.load();
  const retryAt = runtime.coordinator.retryAfterAt;
  assert.ok(retryAt > now);
  assert.equal(runtime.coordinator.lease.turnId,turnId);
  assert.equal(runtime.coordinator.deliveredTurnId,turnId);
  const sentAt = findCoordinator(await core.load()).tasksById[findCoordinator(await core.load()).taskOrder[0]].lastVerifiedSendAt;

  let restartedCalls = 0;
  const restarted = new OrchestrationV2Controller({
    coreRepository:core,chromeApi:chrome,fetchFn,
    collectAssistantReport:async()=>{ restartedCalls += 1; return {status:'BUSY',assistantComplete:false}; },
    now:()=>now,
  });
  now += 1_000;
  const beforeDeadline = await restarted.cycle({nowMs:now});
  assert.equal(beforeDeadline.coordinatorProbe.kind,'COORDINATOR_BACKOFF');
  assert.equal(restartedCalls,0,'restart inside backoff must not probe early');
  runtime = await restarted.runtimeRepository.load();
  assert.equal(runtime.coordinator.lease.turnId,turnId);
  assert.equal(runtime.coordinator.deliveredTurnId,turnId);
  let coordinator = findCoordinator(await core.load());
  assert.equal(coordinator.runState,RunState.STOPPED,'delivered turn remains stopped rather than being resent');
  assert.equal(coordinator.tasksById[coordinator.taskOrder[0]].lastVerifiedSendAt,sentAt);

  now = retryAt + 1;
  await restarted.cycle({nowMs:now});
  assert.equal(restartedCalls,1);
  runtime = await restarted.runtimeRepository.load();
  assert.equal(runtime.coordinator.lease.turnId,turnId,'post-restart retry continues the exact same coordinator turn');
  coordinator = findCoordinator(await core.load());
  assert.equal(coordinator.tasksById[coordinator.taskOrder[0]].lastVerifiedSendAt,sentAt,'retry probe never re-delivers the coordinator prompt');
});


test('multiple rate-limited workers wake at the earliest individual retry deadline', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  const controller = new OrchestrationV2Controller({ coreRepository:core, chromeApi:chrome, now:()=>now });
  await controller.updateConfig(CONFIG);

  const earlyRetryAt = START + 60_000;
  const lateRetryAt = START + 300_000;
  await controller.runtimeRepository.update(runtime => {
    runtime.lastWatchdogAt = START;
    runtime.workersById.early = {
      workerId:'early', taskId:'early-task', state:WorkerState.RATE_LIMITED,
      retryAfterAt:earlyRetryAt, dependencies:[], conflictKey:'', prompt:'x', exactOnceKey:'early@1',
    };
    runtime.workersById.late = {
      workerId:'late', taskId:'late-task', state:WorkerState.RATE_LIMITED,
      retryAfterAt:lateRetryAt, dependencies:[], conflictKey:'', prompt:'y', exactOnceKey:'late@1',
    };
    runtime.workerOrder.push('early','late');
    return runtime;
  });

  const wakeAt = await controller.reconcileAlarm({ nowMs:now });
  assert.equal(wakeAt, earlyRetryAt, 'earliest worker retry must wake even while project backpressure extends later');

  now = earlyRetryAt;
  await controller.cycle({ nowMs:now });
  const runtime = await controller.runtimeRepository.load();
  assert.equal(runtime.workersById.early.state, WorkerState.ACTIVE, 'early retry worker becomes probeable at its own deadline');
  assert.equal(runtime.workersById.late.state, WorkerState.RATE_LIMITED, 'later rate-limited worker keeps its own backoff');
  assert.equal(runtime.workersById.late.retryAfterAt, lateRetryAt);
});

test('worker rate-limit and queued work survive restart without fan-out before retry deadline', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  let coordinatorComplete = false;
  let workerRateLimited = false;
  const controlWithTwo = control(1,[{type:'ADD_TASKS',tasks:[task('worker-rate-a'),task('worker-rate-b')]}]);
  const fetchFn = async()=>response({id:99,body:body(controlWithTwo)});
  const collectAssistantReport = async probe => {
    if (String(probe.taskId).startsWith('coordinator:')) return coordinatorComplete ? {status:'READY',assistantComplete:true,assistantText:'published'} : {status:'BUSY',assistantComplete:false};
    if (probe.taskId === 'worker-rate-a') return workerRateLimited ? {status:'RATE_LIMITED',retryAfterAt:now+60_000,assistantComplete:false} : {status:'BUSY',assistantComplete:false};
    return {status:'BUSY',assistantComplete:false};
  };
  const controller = new OrchestrationV2Controller({coreRepository:core,chromeApi:chrome,fetchFn,collectAssistantReport,now:()=>now});
  await controller.updateConfig({...CONFIG,defaultDesiredWorkers:1});
  await controller.cycle({nowMs:now});
  now += 5_000;
  await core.update(draft=>{ markSent(findCoordinator(draft),'https://chatgpt.com/c/coord-worker-rate',now,1); return draft; });
  await controller.syncAfterCoreCycle({nowMs:now});
  coordinatorComplete = true;
  now += 1_000;
  await controller.cycle({nowMs:now});
  let runtime = await controller.runtimeRepository.load();
  const workers = runtime.workerOrder.map(id=>runtime.workersById[id]);
  assert.equal(workers.filter(w=>w.state===WorkerState.LAUNCHING).length,1);
  assert.equal(workers.filter(w=>w.state===WorkerState.QUEUED).length,1);
  const active = workers.find(w=>w.state===WorkerState.LAUNCHING);
  assert.equal(active.taskId,'worker-rate-a');

  now += 5_000;
  await core.update(draft=>{ markSent(findWorker(draft,'worker-rate-a'),'https://chatgpt.com/c/worker-rate-a',now,2); return draft; });
  await controller.syncAfterCoreCycle({nowMs:now});
  workerRateLimited = true;
  now += 30_000;
  await controller.probeWorkerCompletions({nowMs:now});
  runtime = await controller.runtimeRepository.load();
  const rateWorker = runtime.workerOrder.map(id=>runtime.workersById[id]).find(w=>w.taskId==='worker-rate-a');
  const retryAt = rateWorker.retryAfterAt;
  assert.equal(rateWorker.state,WorkerState.RATE_LIMITED);
  assert.ok(retryAt > now);

  const restarted = new OrchestrationV2Controller({coreRepository:core,chromeApi:chrome,fetchFn,collectAssistantReport:async()=>({status:'BUSY',assistantComplete:false}),now:()=>now});
  now += 1_000;
  const materialized = await restarted.materializeQueuedWorkers({nowMs:now});
  assert.deepEqual(materialized.launched,[],'queued worker must not fan out while any worker holds provider backpressure');
  runtime = await restarted.runtimeRepository.load();
  assert.equal(runtime.workerOrder.map(id=>runtime.workersById[id]).find(w=>w.taskId==='worker-rate-a').state,WorkerState.RATE_LIMITED);
  assert.equal(runtime.workerOrder.map(id=>runtime.workersById[id]).find(w=>w.taskId==='worker-rate-b').state,WorkerState.QUEUED);
  assert.equal(findWorker(await core.load(),'worker-rate-b'),undefined,'queued successor has no ChatGPT session before retry boundary');

  now = retryAt - 1;
  await restarted.cycle({nowMs:now});
  assert.equal(findWorker(await core.load(),'worker-rate-b'),undefined);
});


test('queued worker whose launch authorization expires is terminalized and wakes coordinator without Send', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  const controller = new OrchestrationV2Controller({ coreRepository:core, chromeApi:chrome, now:()=>now });
  await controller.updateConfig(CONFIG);

  const expiringControl = control(1, [{ type:'ADD_TASKS', tasks:[task('expires-before-launch')] }]);
  expiringControl.expires_at = new Date(START + 60_000).toISOString();
  await controller.runtimeRepository.update(runtime => {
    acquireCoordinatorLease(runtime, { nowMs:now, reason:'INITIALIZE' });
    applyControlDecision(runtime, expiringControl, CONFIG, now + 1);
    return runtime;
  });

  now = START + 60_001;
  const materialized = await controller.materializeQueuedWorkers({ nowMs:now });
  assert.deepEqual(materialized.launched, [], 'expired authorization must never materialize a Core Send Session');
  assert.equal(materialized.expired.length, 1);
  assert.equal(findWorker(await core.load(), 'expires-before-launch'), undefined, 'expired queued work must not reach Core');

  const runtime = await controller.runtimeRepository.load();
  const worker = runtime.workerOrder.map(id => runtime.workersById[id]).find(item => item.taskId === 'expires-before-launch');
  assert.equal(worker.state, WorkerState.CANCELLED, 'expired queued work must not remain misleadingly QUEUED forever');
  assert.match(worker.terminalReason, /authorization expired/i);
  const event = runtime.pendingCoordinatorEvents.find(item => item.workerId === worker.workerId);
  assert.equal(event?.type, CoordinatorEventType.WORKER_TERMINAL, 'coordinator must receive durable replanning evidence');
});

test('worker materialization cannot overwrite a concurrent durable coordinator event', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  const controller = new OrchestrationV2Controller({ coreRepository:core, chromeApi:chrome, now:()=>now });
  await controller.updateConfig(CONFIG);

  await controller.runtimeRepository.update(runtime => {
    acquireCoordinatorLease(runtime, { nowMs:now, reason:'INITIALIZE' });
    applyControlDecision(runtime, control(1, [{ type:'ADD_TASKS', tasks:[task('race-worker')] }]), CONFIG, now + 1);
    return runtime;
  });

  const originalCoreUpdate = core.update.bind(core);
  let releaseCoreUpdate;
  let coreUpdateEntered;
  const entered = new Promise(resolve => { coreUpdateEntered = resolve; });
  const release = new Promise(resolve => { releaseCoreUpdate = resolve; });
  core.update = async mutator => {
    coreUpdateEntered();
    await release;
    return originalCoreUpdate(mutator);
  };

  const materializing = controller.materializeQueuedWorkers({ nowMs:now + 2 });
  await entered;
  const concurrentEvent = controller.runtimeRepository.update(runtime => {
    enqueueCoordinatorEvent(runtime, {
      type:CoordinatorEventType.WATCHDOG_RECONCILE,
      detail:'concurrent durable event during worker Core materialization',
    }, now + 3);
    return runtime;
  });

  releaseCoreUpdate();
  const materialized = await materializing;
  await concurrentEvent;
  assert.equal(materialized.launched.length, 1);

  const runtime = await controller.runtimeRepository.load();
  assert.equal(runtime.pendingCoordinatorEvents.length, 1, 'concurrent event must survive materialization checkpoint');
  assert.equal(runtime.pendingCoordinatorEvents[0].type, CoordinatorEventType.WATCHDOG_RECONCILE);
  assert.equal(runtime.workerOrder.map(id => runtime.workersById[id]).find(w => w.taskId === 'race-worker').state, WorkerState.LAUNCHING);
});

test('lost tab hints after restart preserve durable coordinator and worker conversation URLs without duplicate sends', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  let coordinatorComplete = false;
  const probes = [];
  const fetchFn = async()=>response({id:99,body:body(control(1,[{type:'ADD_TASKS',tasks:[task('worker-tab-loss')]}]))});
  const collector = async probe => { probes.push(structuredClone(probe)); return {status:'BUSY',assistantComplete:false}; };
  const controller = new OrchestrationV2Controller({coreRepository:core,chromeApi:chrome,fetchFn,collectAssistantReport:collector,now:()=>now});
  await controller.updateConfig(CONFIG);
  await controller.cycle({nowMs:now});
  now += 5_000;
  await core.update(draft=>{ markSent(findCoordinator(draft),'https://chatgpt.com/c/coord-tab-loss',now,1); return draft; });
  await controller.syncAfterCoreCycle({nowMs:now});
  coordinatorComplete = true;
  controller.collectAssistantReport = async probe => String(probe.taskId).startsWith('coordinator:') ? {status:'READY',assistantComplete:true,assistantText:'published'} : {status:'BUSY',assistantComplete:false};
  now += 1_000;
  await controller.cycle({nowMs:now});
  now += 5_000;
  await core.update(draft=>{ markSent(findWorker(draft,'worker-tab-loss'),'https://chatgpt.com/c/worker-tab-loss',now,2); return draft; });
  await controller.syncAfterCoreCycle({nowMs:now});

  // Simulate Chrome closing all owned tabs: tab hints disappear, durable URLs remain.
  await core.update(draft=>{ draft.tabHintsByTaskId = {}; return draft; });
  const stateBefore = await core.load();
  const coordBefore = findCoordinator(stateBefore);
  const coordSentAt = coordBefore.tasksById[coordBefore.taskOrder[0]].lastVerifiedSendAt;
  const workerBefore = findWorker(stateBefore,'worker-tab-loss');
  const workerSentAt = workerBefore.tasksById[workerBefore.taskOrder[0]].lastVerifiedSendAt;

  probes.length = 0;
  const restarted = new OrchestrationV2Controller({coreRepository:core,chromeApi:chrome,fetchFn,collectAssistantReport:collector,now:()=>now});
  now += 30_000;
  await restarted.cycle({nowMs:now});
  const runtime = await restarted.runtimeRepository.load();
  assert.equal(runtime.coordinator.chatUrl,'https://chatgpt.com/c/coord-tab-loss');
  assert.equal(runtime.workerOrder.map(id=>runtime.workersById[id]).find(w=>w.taskId==='worker-tab-loss').chatUrl,'https://chatgpt.com/c/worker-tab-loss');
  assert.equal(probes.some(p=>p.conversationUrl==='https://chatgpt.com/c/worker-tab-loss'),true,'worker completion probe uses durable URL, not tab hint');
  const stateAfter = await core.load();
  const coordAfter = findCoordinator(stateAfter);
  const workerAfter = findWorker(stateAfter,'worker-tab-loss');
  assert.equal(coordAfter.tasksById[coordAfter.taskOrder[0]].lastVerifiedSendAt,coordSentAt);
  assert.equal(workerAfter.tasksById[workerAfter.taskOrder[0]].lastVerifiedSendAt,workerSentAt);
  assert.equal(Object.values(stateAfter.sessionsById).filter(s=>s.orchestrationWorker?.taskId==='worker-tab-loss').length,1,'tab loss must not create a duplicate worker Session');
});

test('worker completion probing reaches a 100-worker active pool in one reconciliation cycle', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  const probed = [];
  const controller = new OrchestrationV2Controller({
    coreRepository:core,
    chromeApi:chrome,
    fetchFn:async()=>response({}),
    collectAssistantReport:async probe => { probed.push(probe.workerId); return { status:'BUSY', assistantComplete:false }; },
    now:()=>now,
  });
  const config = { ...CONFIG, defaultDesiredWorkers:100, absoluteMaxWorkers:100 };
  await controller.updateConfig(config);
  await controller.runtimeRepository.update(runtime => {
    acquireCoordinatorLease(runtime, { nowMs:now, reason:'INITIALIZE' });
    const tasks = Array.from({ length:100 }, (_, i) => ({
      task_id:`pool-${i + 1}`,
      prompt:`Work ${i + 1}`,
      priority:0,
      dependencies:[],
      conflict_key:'',
      generation:1,
      launch_mode:'FRESH_CHAT',
      exact_once_key:`pool-${i + 1}@1`,
      not_before:null,
      expires_at:null,
      target_repository:'owner/target',
    }));
    applyControlDecision(runtime, control(1, [{ type:'ADD_TASKS', tasks }]), config, now + 1);
    for (const workerId of runtime.workerOrder) {
      const worker = runtime.workersById[workerId];
      worker.state = WorkerState.ACTIVE;
      worker.chatUrl = `https://chatgpt.com/c/${worker.taskId}`;
      worker.sentAt = now + 2;
      worker.assistantBaselineCount = 1;
      worker.assistantBaselineKnown = true;
      worker.lastSuccessfulProbeAt = now + 2;
    }
    return runtime;
  });
  now += 60_000;
  const result = await controller.probeWorkerCompletions({ nowMs:now });
  assert.equal(result.probed, 100);
  assert.equal(probed.length, 100);
  assert.equal(new Set(probed).size, 100);
});

test('owner-policy role play: coordinator backlog -> paced workers -> one completion -> immediate replan -> refill only when owner window opens', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  let controlRevision = 1;
  let coordinatorComplete = false;
  const completedWorkers = new Set();
  const roleConfig = {
    ...CONFIG,
    defaultDesiredWorkers: 5,
    absoluteMaxWorkers: 5,
    maxLaunchesPerWindow: 2,
    launchWindowSeconds: 300,
    minimumWorkerLaunchIntervalMs: 0,
  };
  const controls = {
    1: control(1, [
      { type:'SET_DESIRED_CONCURRENCY', value:5 },
      { type:'ADD_TASKS', tasks:['w1','w2','w3','w4','w5'].map(task) },
    ]),
    2: control(2, [{ type:'ADD_TASKS', tasks:[task('w6')] }]),
  };
  const fetchFn = async () => response({ id:99, body:body(controls[controlRevision]), html_url:'https://github/control#99' });
  const collectAssistantReport = async probe => {
    if (String(probe.taskId).startsWith('coordinator:')) {
      return coordinatorComplete
        ? { status:'READY', assistantComplete:true, assistantText:`Published control revision ${controlRevision}.` }
        : { status:'BUSY', assistantComplete:false };
    }
    return completedWorkers.has(probe.taskId)
      ? { status:'READY', assistantComplete:true, assistantText:`${probe.taskId} completed.` }
      : { status:'BUSY', assistantComplete:false };
  };
  const controller = new OrchestrationV2Controller({ coreRepository:core, chromeApi:chrome, fetchFn, collectAssistantReport, now:()=>now });
  await controller.updateConfig(roleConfig);

  // Turn 1: coordinator is the only runnable managed Session until its prompt is positively delivered.
  await controller.cycle({ nowMs:now });
  now += 5_000;
  await core.update(draft => { markSent(findCoordinator(draft), 'https://chatgpt.com/c/coord-roleplay', now, 1); return draft; });
  await controller.syncAfterCoreCycle({ nowMs:now });

  // Coordinator publishes five tasks, but owner policy allows only two launches inside this five-minute window.
  coordinatorComplete = true;
  now += 1_000;
  await controller.cycle({ nowMs:now });
  let state = await core.load();
  assert.ok(findWorker(state, 'w1'));
  assert.ok(findWorker(state, 'w2'));
  assert.equal(Boolean(findWorker(state, 'w3')), false);
  let status = await controller.getStatus();
  assert.equal(status.runtime.workerCounts.LAUNCHING, 2);
  assert.equal(status.runtime.workerCounts.QUEUED, 3);
  assert.equal(status.runtime.desiredActiveWorkers, 5);

  // Core remains the sole sender; verified deliveries activate both managed workers.
  now += 5_000;
  await core.update(draft => {
    markSent(findWorker(draft, 'w1'), 'https://chatgpt.com/c/role-w1', now, 1);
    markSent(findWorker(draft, 'w2'), 'https://chatgpt.com/c/role-w2', now, 1);
    return draft;
  });
  await controller.syncAfterCoreCycle({ nowMs:now });
  status = await controller.getStatus();
  assert.equal(status.runtime.workerCounts.ACTIVE, 2);

  // Only w1 completes. Autopilot must wake the persistent coordinator immediately instead of waiting for w2.
  completedWorkers.add('w1');
  coordinatorComplete = false;
  controlRevision = 2;
  now += 1_000;
  await controller.cycle({ nowMs:now });
  state = await core.load();
  const coordinatorTurn2 = findCoordinator(state);
  assert.equal(coordinatorTurn2.runState, RunState.RUNNING);
  assert.equal(coordinatorTurn2.tasksById[coordinatorTurn2.taskOrder[0]].url, 'https://chatgpt.com/c/coord-roleplay');
  status = await controller.getStatus();
  assert.equal(status.runtime.workerCounts.COMPLETED, 1);
  assert.equal((status.runtime.workerCounts.ACTIVE || 0) + (status.runtime.workerCounts.BUSY || 0), 1, 'unfinished w2 still reserves exactly one worker slot');
  assert.equal(status.runtime.coordinator.status, 'BUSY');

  // Coordinator reacts with another task, yet the still-closed owner launch window prevents immediate fan-out.
  now += 5_000;
  await core.update(draft => { markSent(findCoordinator(draft), 'https://chatgpt.com/c/coord-roleplay', now, 2); return draft; });
  await controller.syncAfterCoreCycle({ nowMs:now });
  coordinatorComplete = true;
  now += 1_000;
  await controller.cycle({ nowMs:now });
  status = await controller.getStatus();
  assert.equal(status.runtime.lastAppliedControlRevision, 2);
  assert.equal(status.runtime.workerCounts.QUEUED, 4, 'w3-w6 remain queued while owner rate window is closed');
  assert.equal(status.runtime.workerCounts.LAUNCHING ?? 0, 0);

  // Once the five-minute owner window opens, exactly two queued workers may refill; no coordinator override can exceed it.
  now += 301_000;
  await controller.cycle({ nowMs:now });
  status = await controller.getStatus();
  assert.equal(status.runtime.workerCounts.LAUNCHING, 2);
  assert.equal(status.runtime.workerCounts.QUEUED, 2);
  state = await core.load();
  const launchedAfterWindow = ['w3','w4','w5','w6'].filter(id => Boolean(findWorker(state, id)));
  assert.equal(launchedAfterWindow.length, 2);
});

test('lost managed worker tab hint still retires safe Core Session after orchestration authority is revoked', async () => {
  const chrome = chromeFake();
  delete chrome.tabs;
  const core = new StorageRepository(chrome);
  const controller = new OrchestrationV2Controller({ coreRepository:core, chromeApi:chrome, now:()=>START });
  await controller.updateConfig(CONFIG);

  await controller.runtimeRepository.update(runtime => {
    acquireCoordinatorLease(runtime, { nowMs:START, reason:'INITIALIZE' });
    applyControlDecision(runtime, control(1, [{ type:'ADD_TASKS', tasks:[task('lost-hint-before-cleanup')] }]), CONFIG, START + 1);
    return runtime;
  });
  await controller.materializeQueuedWorkers({ nowMs:START + 2 });

  let workerId;
  await controller.runtimeRepository.update(runtime => {
    workerId = runtime.workerOrder.map(id => runtime.workersById[id]).find(worker => worker.taskId === 'lost-hint-before-cleanup').workerId;
    runtime.workersById[workerId].state = WorkerState.SUPERSEDED;
    runtime.workersById[workerId].terminalReason = 'Coordinator superseded after tab ownership metadata was lost.';
    return runtime;
  });
  await core.update(state => {
    const session = findWorker(state, 'lost-hint-before-cleanup');
    assert.ok(session);
    assert.equal(session.runState, RunState.RUNNING);
    delete state.tabHintsByTaskId[session.taskOrder[0]];
    return state;
  });

  await controller.closeManagedWorkerTabs([workerId]);
  const state = await core.load();
  const session = findWorker(state, 'lost-hint-before-cleanup');
  assert.equal(session.enabled, false, 'revoked safe managed Session must be disabled even with no durable tab hint');
  assert.equal(session.runState, RunState.STOPPED, 'lost tab ownership metadata must not leave revoked work runnable');
});

test('closed managed worker tab still retires safe Core Session after orchestration authority is revoked', async () => {
  const chrome = chromeFake();
  chrome.tabs = { async remove(){ throw new Error('No tab with id: 4242'); } };
  const core = new StorageRepository(chrome);
  const controller = new OrchestrationV2Controller({ coreRepository:core, chromeApi:chrome, now:()=>START });
  await controller.updateConfig(CONFIG);

  await controller.runtimeRepository.update(runtime => {
    acquireCoordinatorLease(runtime, { nowMs:START, reason:'INITIALIZE' });
    applyControlDecision(runtime, control(1, [{ type:'ADD_TASKS', tasks:[task('closed-before-cleanup')] }]), CONFIG, START + 1);
    return runtime;
  });
  await controller.materializeQueuedWorkers({ nowMs:START + 2 });

  let workerId;
  await controller.runtimeRepository.update(runtime => {
    workerId = runtime.workerOrder.map(id => runtime.workersById[id]).find(worker => worker.taskId === 'closed-before-cleanup').workerId;
    runtime.workersById[workerId].state = WorkerState.SUPERSEDED;
    runtime.workersById[workerId].terminalReason = 'Coordinator superseded before Send.';
    return runtime;
  });
  await core.update(state => {
    const session = findWorker(state, 'closed-before-cleanup');
    assert.ok(session);
    assert.equal(session.runState, RunState.RUNNING);
    state.tabHintsByTaskId[session.taskOrder[0]] = { sessionId:session.id, kind:'TASK', tabId:4242, normalizedUrl:'https://chatgpt.com/' };
    return state;
  });

  await controller.closeManagedWorkerTabs([workerId]);
  const state = await core.load();
  const session = findWorker(state, 'closed-before-cleanup');
  assert.equal(session.enabled, false, 'revoked safe managed Session must be disabled even when tab is already gone');
  assert.equal(session.runState, RunState.STOPPED, 'revoked safe managed Session must not remain runnable');
  assert.equal(state.tabHintsByTaskId[session.taskOrder[0]], undefined, 'dead owned-tab hint must be cleared');
});

test('queued worker authorization expiry wakes before a later owner launch-window reopening', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  const config = {
    ...CONFIG,
    defaultDesiredWorkers: 2,
    absoluteMaxWorkers: 2,
    maxLaunchesPerWindow: 1,
    launchWindowSeconds: 300,
    minimumWorkerLaunchIntervalMs: 0,
  };
  const controller = new OrchestrationV2Controller({ coreRepository:core, chromeApi:chrome, now:()=>START });
  await controller.updateConfig(config);

  await controller.runtimeRepository.update(runtime => {
    acquireCoordinatorLease(runtime, { nowMs:START, reason:'INITIALIZE' });
    applyControlDecision(runtime, control(1, [{ type:'ADD_TASKS', tasks:[task('expiry-first'), task('expiry-second')] }]), config, START + 1);
    return runtime;
  });
  await controller.materializeQueuedWorkers({ nowMs:START + 2 });

  const expiresAt = START + 60_000;
  await controller.runtimeRepository.update(runtime => {
    const queued = runtime.workerOrder.map(id => runtime.workersById[id]).find(worker => worker.state === WorkerState.QUEUED);
    assert.ok(queued, 'one worker must remain queued behind the one-launch owner window');
    queued.expiresAt = expiresAt;
    return runtime;
  });

  chrome.alarmCalls.length = 0;
  const wakeAt = await controller.reconcileAlarm({ nowMs:START + 3_000 });
  assert.equal(wakeAt, expiresAt, 'authorization expiry must wake before the later launch-window/watchdog deadline');

  await controller.cycle({ nowMs:expiresAt });
  const runtime = await controller.runtimeRepository.load();
  const expired = runtime.workerOrder.map(id => runtime.workersById[id]).find(worker => worker.taskId === 'expiry-second');
  assert.equal(expired.state, WorkerState.CANCELLED);
  assert.equal(runtime.pendingCoordinatorEvents.some(event => event.workerId === expired.workerId && event.type === CoordinatorEventType.WORKER_TERMINAL), true,
    'expiry wake must create durable terminal evidence for immediate coordinator replanning');
});

test('coordinator rotation cannot advance generation while managed Core Send recovery is unresolved', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  const controller = new OrchestrationV2Controller({
    coreRepository: core,
    chromeApi: chrome,
    fetchFn: async () => response({ id: 99, body: body(control(1, [{ type:'NO_ACTION' }])) }),
    now: () => now,
  });
  await controller.updateConfig({ ...CONFIG, maxCoordinatorTurns: 1 });

  await core.update(state => {
    const session = {
      id: 'coord-session', name: 'Coordinator', enabled: true, runState: RunState.RECOVERING,
      promptMode: 'UNIQUE', sharedPrompt: '', runMode: 'ONE_PASS',
      taskOrder: ['coord-task'], tasksById: {
        'coord-task': {
          id:'coord-task', enabled:true, label:'Coordinator', url:'https://chatgpt.com/', normalizedUrl:'https://chatgpt.com/', promptOverride:'tick',
          status:'SUBMISSION_UNCERTAIN', lastCheckedAt:0, lastVerifiedSendAt:0, lastVerifiedFingerprint:'', retryAfterAt:0, manualReviewReason:'',
          lastConversationUrl:'', lastAssistantReport:'', lastAssistantReportAt:0, lastAssistantBaselineCount:0, lastAssistantBaselineKnown:false,
        },
      },
      currentTaskIndex:0, minimumSendIntervalMs:0, preSendDelayMs:1000, busyCheckDelayMs:1000, retryBackoffMs:5000,
      tabStrategy:'KEEP_TASK_TABS_OPEN', nextAllowedSendAt:0,
      operation:{
        operationId:'op', sessionId:'coord-session', taskId:'coord-task', promptFingerprint:'sha256:test', phase:'AMBIGUOUS',
        targetUrl:'https://chatgpt.com/', createdAt:now, updatedAt:now, preSendDeadline:0, submitStartedAt:now, verificationDeadline:now+30000,
      },
      lastActionAt:now, lastSuccessfulSendAt:0, successfulSendCount:0, completedAt:0, lastError:'', onePassCompletedTaskIds:[], createdAt:now, updatedAt:now,
      orchestrationCoordinator:{ managed:true, projectId:'proj', generation:1, agentProviderId:'chatgpt-browser' },
    };
    state.sessionsById[session.id] = session;
    state.sessionOrder.push(session.id);
    return state;
  });
  await controller.runtimeRepository.update(runtime => {
    runtime.coordinator.generation = 1;
    runtime.coordinator.turnsUsed = 1;
    runtime.coordinator.maxTurns = 1;
    runtime.coordinator.status = 'ROTATION_REQUIRED';
    runtime.coordinator.lease = null;
    enqueueCoordinatorEvent(runtime, { type:CoordinatorEventType.RECOVERY_RECONCILE, key:'rotate' }, now);
    return runtime;
  });

  const blocked = await controller.beginCoordinatorTurn({ reason:'RECONCILE', nowMs:now });
  assert.equal(blocked.kind, 'ROTATION_BLOCKED_UNRESOLVED_SEND');
  assert.equal((await controller.runtimeRepository.load()).coordinator.generation, 1);

  await core.update(state => {
    state.sessionsById['coord-session'].operation.phase = 'FAILED_SAFE';
    state.sessionsById['coord-session'].runState = RunState.STOPPED;
    return state;
  });
  now += 1;
  const resumed = await controller.beginCoordinatorTurn({ reason:'RECONCILE', nowMs:now });
  assert.equal(resumed.kind, 'COORDINATOR_TURN_STARTED');
  assert.equal((await controller.runtimeRepository.load()).coordinator.generation, 2);
});


test('0.9.7 direct Chat control is applied before GitHub fallback and exposes source', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  let coordinatorComplete = false;
  let githubReads = 0;
  const directControl = control(1, [{ type:'ADD_TASKS', tasks:[task('direct-worker')] }]);
  const fetchFn = async () => { githubReads += 1; throw new Error('GitHub fallback must not be read when direct control is valid'); };
  const collectAssistantReport = async probe => {
    if (!String(probe.taskId).startsWith('coordinator:')) return { status:'BUSY', assistantComplete:false };
    if (!coordinatorComplete) return { status:'BUSY', assistantComplete:false };
    return {
      status:'READY', assistantComplete:true,
      assistantText:`Готово.\n\n${ORCHESTRATION_CONTROL_MARKER}\n\`\`\`json\n${JSON.stringify(directControl)}\n\`\`\``
    };
  };
  const controller = new OrchestrationV2Controller({ coreRepository:core, chromeApi:chrome, fetchFn, collectAssistantReport, now:()=>now });
  await controller.updateConfig(CONFIG);
  await controller.cycle({ nowMs:now });
  now += 5_000;
  await core.update(draft => { markSent(findCoordinator(draft), 'https://chatgpt.com/c/direct-coord', now, 1); return draft; });
  await controller.syncAfterCoreCycle({ nowMs:now });
  coordinatorComplete = true;
  now += 1_000;
  const cycle = await controller.cycle({ nowMs:now });
  assert.equal(cycle.control.kind, 'CONTROL_APPLIED');
  assert.equal(cycle.control.source, 'DIRECT_CHAT');
  assert.equal(githubReads, 0);
  const status = await controller.getStatus();
  assert.equal(status.runtime.lastAppliedControlRevision, 1);
  assert.equal(status.runtime.lastAppliedControlSource, 'DIRECT_CHAT');
  assert.ok(findWorker(await core.load(), 'direct-worker'));
});

test('0.9.7 bootstrap pinned control materializes workers before first coordinator reasoning', async () => {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let now = START;
  let reads = 0;
  const bootstrap = control(1, [{ type:'ADD_TASKS', tasks:[task('bootstrap-worker')] }]);
  const fetchFn = async url => {
    reads += 1;
    assert.match(url, /issues\/comments\/99$/);
    return response({ id:99, body:body(bootstrap), html_url:'https://github/control#99' });
  };
  const controller = new OrchestrationV2Controller({ coreRepository:core, chromeApi:chrome, fetchFn, collectAssistantReport:async()=>({status:'BUSY',assistantComplete:false}), now:()=>now });
  await controller.updateConfig({ ...CONFIG, bootstrapPinnedControlFirst:true });
  const cycle = await controller.cycle({ nowMs:now });
  assert.equal(cycle.bootstrap.kind, 'BOOTSTRAP_APPLIED');
  assert.equal(reads, 1);
  const state = await core.load();
  assert.ok(findWorker(state, 'bootstrap-worker'), 'bootstrap worker must exist in Core during first cycle');
  assert.ok(findCoordinator(state), 'first coordinator turn still starts after bootstrap');
  const status = await controller.getStatus();
  assert.equal(status.runtime.lastAppliedControlRevision, 1);
  assert.equal(status.runtime.lastAppliedControlSource, 'GITHUB_BOOTSTRAP');
  assert.equal(status.runtime.coordinator.status, 'BUSY');
});
