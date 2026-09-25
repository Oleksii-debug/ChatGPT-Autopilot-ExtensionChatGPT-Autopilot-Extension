import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, RunState } from '../src/core/schema.js';
import { normalizeRemoteDispatch } from '../src/core/remote-dispatch.js';
import { createRemoteDispatchLedger, recordVerifiedRemoteSend } from '../src/core/remote-dispatch-ledger.js';
import { reconcileRemoteDispatchIntoState, remoteLocalSessionId, remoteLocalTaskId } from '../src/core/remote-dispatch-import.js';
import { applyRemoteDispatchGovernance, computeRemoteDispatchDeadline, syncVerifiedRemoteSendsIntoLedger } from '../src/core/remote-dispatch-runtime.js';

function raw() { return { schema_version:1, dispatch_id:'d1', strategy_revision:1, generated_at:'2026-09-11T18:00:00Z', expires_at:'2026-09-11T20:00:00Z', project_id:'p', target_repository:'o/r', supersedes_dispatch_ids:[], policy:{poll_interval_seconds:180,fallback_after_seconds:900,fallback_enabled:true,max_active_sessions:1}, sessions:[{session_key:'s',name:'S',order:1,enabled:true,run_mode:'CONTINUOUS',tab_strategy:'OPEN_CLOSE_PER_TASK',minimum_send_interval_seconds:60,pre_send_delay_seconds:1,busy_check_delay_seconds:1,retry_backoff_seconds:5,not_before:null,expires_at:null,tasks:[{task_id:'t1',order:1,enabled:true,url:'https://chatgpt.com/',prompt:'P1',not_before:null,expires_at:null,max_launches:1,supersedes_task_ids:[]},{task_id:'t2',order:2,enabled:true,url:'https://chatgpt.com/',prompt:'P2',not_before:'2026-09-11T18:40:00Z',expires_at:null,max_launches:1,supersedes_task_ids:[]}]}]}; }
const NOW=Date.parse('2026-09-11T18:30:00Z');

test('governance auto-starts eligible stopped remote Session but honors future task not_before',()=>{ const d=normalizeRemoteDispatch(raw()); const ledger=createRemoteDispatchLedger('p',1); let state=reconcileRemoteDispatchIntoState(createEmptyState(1),d,{nowMs:NOW}).state; const r=applyRemoteDispatchGovernance(state,d,ledger,{nowMs:NOW,autoStart:true}); const sid=remoteLocalSessionId('p','s'); assert.equal(r.state.sessionsById[sid].runState,RunState.RUNNING); assert.equal(r.state.sessionsById[sid].tasksById[remoteLocalTaskId('p','s','t1')].enabled,true); assert.equal(r.state.sessionsById[sid].tasksById[remoteLocalTaskId('p','s','t2')].enabled,false); });

test('master pause and manual PAUSED session are authoritative',()=>{ const d=normalizeRemoteDispatch(raw()); const ledger=createRemoteDispatchLedger('p',1); let state=reconcileRemoteDispatchIntoState(createEmptyState(1),d,{nowMs:NOW}).state; state.profile.masterPaused=true; let r=applyRemoteDispatchGovernance(state,d,ledger,{nowMs:NOW,autoStart:true}); const sid=remoteLocalSessionId('p','s'); assert.equal(r.state.sessionsById[sid].runState,RunState.STOPPED); r.state.profile.masterPaused=false; r.state.sessionsById[sid].runState=RunState.PAUSED; r=applyRemoteDispatchGovernance(r.state,d,ledger,{nowMs:NOW,autoStart:true}); assert.equal(r.state.sessionsById[sid].runState,RunState.PAUSED); });

test('max_launches disables task after verified fingerprint is counted',()=>{ const d=normalizeRemoteDispatch(raw()); const ledger=createRemoteDispatchLedger('p',1); let state=reconcileRemoteDispatchIntoState(createEmptyState(1),d,{nowMs:NOW}).state; const sid=remoteLocalSessionId('p','s'); const tid=remoteLocalTaskId('p','s','t1'); state.sessionsById[sid].tasksById[tid].lastVerifiedFingerprint='sha256:x'; const counted=syncVerifiedRemoteSendsIntoLedger(state,ledger,{nowMs:NOW}); assert.equal(counted.length,1); applyRemoteDispatchGovernance(state,d,ledger,{nowMs:NOW,autoStart:true}); assert.equal(state.sessionsById[sid].tasksById[tid].enabled,false); });

test('verified-send sync is idempotent',()=>{ const d=normalizeRemoteDispatch(raw()); const ledger=createRemoteDispatchLedger('p',1); const state=reconcileRemoteDispatchIntoState(createEmptyState(1),d,{nowMs:NOW}).state; const sid=remoteLocalSessionId('p','s'); const tid=remoteLocalTaskId('p','s','t1'); state.sessionsById[sid].tasksById[tid].lastVerifiedFingerprint='sha256:x'; assert.equal(syncVerifiedRemoteSendsIntoLedger(state,ledger,{nowMs:NOW}).length,1); assert.equal(syncVerifiedRemoteSendsIntoLedger(state,ledger,{nowMs:NOW+1}).length,0); });

test('next remote deadline includes future task not_before',()=>{ const d=normalizeRemoteDispatch(raw()); const ledger=createRemoteDispatchLedger('p',1); assert.equal(computeRemoteDispatchDeadline(d,ledger,NOW),Date.parse('2026-09-11T18:40:00Z')); });


test('top-level dispatch expiry removes launch authority from cached remote Session',()=>{
  const r=raw(); r.expires_at='2026-09-11T18:20:00Z'; r.generated_at='2026-09-11T17:00:00Z';
  const d=normalizeRemoteDispatch(r); const ledger=createRemoteDispatchLedger('p',1);
  let state=reconcileRemoteDispatchIntoState(createEmptyState(1),d,{nowMs:NOW}).state;
  const sid=remoteLocalSessionId('p','s'); state.sessionsById[sid].runState=RunState.RUNNING;
  applyRemoteDispatchGovernance(state,d,ledger,{nowMs:NOW,autoStart:true});
  assert.equal(state.sessionsById[sid].runState,RunState.STOPPED);
  assert.equal(state.sessionsById[sid].tasksById[remoteLocalTaskId('p','s','t1')].enabled,false);
});
