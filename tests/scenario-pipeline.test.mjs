import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ScenarioWorkMode, ScenarioWorkRunState,
  normalizeScenarioWorkConfig, createScenarioWorkRuntime, startScenarioWork,
  planScenarioWorkActions, applyScenarioLaunch, applyScenarioCompletion, applyScenarioTimeout,
} from '../src/core/scenario-work.js';
import {
  SCENARIO_RESULT_MARKER, SCENARIO_RESULT_END_MARKER,
  AUDITOR_ALLOCATION_MARKER, AUDITOR_ALLOCATION_END_MARKER,
} from '../src/core/scenario-semantic.js';

function config(overrides = {}) {
  return normalizeScenarioWorkConfig({
    id: 'pipe', mode: ScenarioWorkMode.AUDITOR_PIPELINE,
    firstCount: 3, secondCount: 2, roundsPerGeneration: 2,
    barrierPolicy: 'WAIT_ALL_TERMINAL', auditTimeboxMinutes: 30,
    minimumLaunchGapSeconds: 0, firstWorkerPrompt: 'FIRST', secondWorkerPrompt: 'SECOND', auditorPrompt: 'AUDIT',
    ...overrides,
  });
}
function start(c, now = 0) { return startScenarioWork(c, createScenarioWorkRuntime(c, now), now); }
function launchAll(c, runtime, now = 1) {
  const planned = planScenarioWorkActions(c, runtime, now);
  runtime = planned.runtime;
  for (const [n, action] of planned.actions.entries()) runtime = applyScenarioLaunch(runtime, action, { sessionId: `s${n}`, taskId: `core${n}`, now });
  return { runtime, actions: planned.actions };
}
function resultBlock({ round=1, phase='FIRST', slot='FIRST-01', task='T1', key='K1', outcome='DONE' } = {}) {
  const payload = { scenario_id:'pipe', generation:1, round, phase, slot, task_id:task, exclusive_key:key, outcome, slot_consumed:true, evidence_published:true, evidence_refs:['drive:x'], dependencies_consumed:[], retry_required:false };
  return `${SCENARIO_RESULT_MARKER}\n${JSON.stringify(payload)}\n${SCENARIO_RESULT_END_MARKER}`;
}
function allocationBlock({ round=1, secondDeps={}, firstAudit=null } = {}) {
  const reservations=[];
  for (let i=1;i<=2;i++) reservations.push({ generation:1, round, phase:'SECOND', slot:`SECOND-${String(i).padStart(2,'0')}`, task_id:`R${round}S${i}`, exclusive_key:`KS${round}-${i}`, scheduler_dependencies:secondDeps[i]||[], source_ref:`drive:r${round}-s${i}` });
  if (round < 2) for (let i=1;i<=3;i++) reservations.push({ generation:1, round:round+1, phase:'FIRST', slot:`FIRST-${String(i).padStart(2,'0')}`, task_id:`R${round+1}F${i}`, exclusive_key:`KF${round+1}-${i}`, scheduler_dependencies:[], source_ref:`drive:r${round+1}-f${i}` });
  const audit = firstAudit || Array.from({length:3},(_,i)=>({task_id:'',slot:`FIRST-${String(i+1).padStart(2,'0')}`,classification:'IN_PROGRESS',slot_consumed:false,evidence_ref:''}));
  const payload={ scenario_id:'pipe', generation:1, round, allocation_id:`A${round}`, readback_verified:true, allocation_evidence_refs:['drive:allocation'], first_audit:audit, reservations };
  return `${AUDITOR_ALLOCATION_MARKER}\n${JSON.stringify(payload)}\n${AUDITOR_ALLOCATION_END_MARKER}`;
}
function completeWorker(c, runtime, index, text, now=10) {
  return applyScenarioCompletion(c, runtime, `pipeline:g1:r1:first:first-0${index}`, { assistantText:text, chatUrl:`https://chatgpt.com/c/f${index}`, now });
}

test('WAIT_ALL_TERMINAL does not launch auditor when only 2/3 FIRST results are verified', () => {
  const c=config(); let {runtime}=launchAll(c,start(c),1);
  runtime=completeWorker(c,runtime,1,resultBlock({slot:'FIRST-01',task:'F1',key:'KF1'}),10);
  runtime=completeWorker(c,runtime,2,resultBlock({slot:'FIRST-02',task:'F2',key:'KF2'}),11);
  const planned=planScenarioWorkActions(c,runtime,10000000);
  assert.equal(planned.actions.some(a=>a.role==='AUDITOR'),false);
});

test('TIMEBOXED_AUDIT may launch auditor after deadline without pretending unfinished FIRST is complete', () => {
  const c=config({barrierPolicy:'TIMEBOXED_AUDIT',auditTimeboxMinutes:1}); let {runtime}=launchAll(c,start(c),1);
  runtime=completeWorker(c,runtime,1,resultBlock({slot:'FIRST-01',task:'F1',key:'KF1'}),10);
  const planned=planScenarioWorkActions(c,runtime,61000);
  assert.equal(planned.runtime.firstSlots['2'].state,'WAITING');
  assert.equal(planned.actions.length,1);
  assert.equal(planned.actions[0].role,'AUDITOR');
});

test('assistantComplete-equivalent response without strict result does not complete slot and schedules correction', () => {
  const c=config(); let {runtime}=launchAll(c,start(c),1);
  runtime=applyScenarioCompletion(c,runtime,'pipeline:g1:r1:first:first-01',{assistantText:'Done.',chatUrl:'https://chatgpt.com/c/x',now:10});
  assert.equal(runtime.firstSlots['1'].state,'READY');
  assert.equal(runtime.firstSlots['1'].correctionPending,true);
  assert.equal(runtime.totalVerifiedSlots,0);
  const planned=planScenarioWorkActions(c,runtime,11);
  assert.match(planned.actions.find(a=>a.participantKey.includes('first-01')).prompt,/INVALID|машинного|AUTOPILOT_SCENARIO_RESULT/i);
});

test('valid terminal BLOCKED result consumes slot and preserves returned task identity', () => {
  const c=config(); let {runtime}=launchAll(c,start(c),1);
  runtime=completeWorker(c,runtime,1,resultBlock({slot:'FIRST-01',task:'Drive-F1',key:'drive:key',outcome:'BLOCKED'}),10);
  assert.equal(runtime.firstSlots['1'].state,'COMPLETE');
  assert.equal(runtime.firstSlots['1'].taskId,'Drive-F1');
  assert.equal(runtime.firstSlots['1'].result.outcome,'BLOCKED');
});

test('auditor allocation with wrong count triggers correction and does not enter SECOND', () => {
  const c=config({barrierPolicy:'TIMEBOXED_AUDIT',auditTimeboxMinutes:1}); let {runtime}=launchAll(c,start(c),1);
  let planned=planScenarioWorkActions(c,runtime,61000); runtime=planned.runtime;
  const aud=planned.actions[0]; runtime=applyScenarioLaunch(runtime,aud,{sessionId:'aud',taskId:'core-aud',now:61000});
  const bad=JSON.parse(allocationBlock().split('\n')[1]); bad.reservations=bad.reservations.filter(r=>r.slot!=='SECOND-02');
  const body=`${AUDITOR_ALLOCATION_MARKER}\n${JSON.stringify(bad)}\n${AUDITOR_ALLOCATION_END_MARKER}`;
  runtime=applyScenarioCompletion(c,runtime,'pipeline:auditor',{assistantText:body,chatUrl:'https://chatgpt.com/c/a',now:62000});
  assert.equal(runtime.phase,'AUDITOR');
  assert.equal(runtime.auditor.correctionPending,true);
  assert.equal(Object.keys(runtime.secondSlots).length,0);
});

test('valid allocation installs SECOND and blocks dependent SECOND-02 before prerequisite terminal', () => {
  const c=config({barrierPolicy:'TIMEBOXED_AUDIT',auditTimeboxMinutes:1}); let {runtime}=launchAll(c,start(c),1);
  let planned=planScenarioWorkActions(c,runtime,61000); runtime=planned.runtime;
  runtime=applyScenarioLaunch(runtime,planned.actions[0],{sessionId:'aud',taskId:'core-aud',now:61000});
  runtime=applyScenarioCompletion(c,runtime,'pipeline:auditor',{assistantText:allocationBlock({secondDeps:{2:['R1S1']}}),chatUrl:'https://chatgpt.com/c/a',now:62000});
  assert.equal(runtime.phase,'SECOND');
  planned=planScenarioWorkActions(c,runtime,62001); runtime=planned.runtime;
  const ids=planned.actions.map(a=>a.participantKey);
  assert.equal(ids.length,1);
  assert.match(ids[0],/second-01/);
  runtime=applyScenarioLaunch(runtime,planned.actions[0],{sessionId:'s1',taskId:'c1',now:62001});
  runtime=applyScenarioCompletion(c,runtime,planned.actions[0].participantKey,{assistantText:resultBlock({phase:'SECOND',slot:'SECOND-01',task:'R1S1',key:'KS1-1'}),chatUrl:'https://chatgpt.com/c/s1',now:63000});
  planned=planScenarioWorkActions(c,runtime,63001);
  assert.equal(planned.actions.length,1);
  assert.match(planned.actions[0].participantKey,/second-02/);
});

test('auditor lease prevents duplicate auditor launch for same round', () => {
  const c=config({barrierPolicy:'TIMEBOXED_AUDIT',auditTimeboxMinutes:1}); let {runtime}=launchAll(c,start(c),1);
  let planned=planScenarioWorkActions(c,runtime,61000); runtime=planned.runtime;
  runtime=applyScenarioLaunch(runtime,planned.actions[0],{sessionId:'aud',taskId:'core-aud',now:61000});
  planned=planScenarioWorkActions(c,runtime,61001);
  assert.equal(planned.actions.filter(a=>a.role==='AUDITOR').length,0);
});

test('next round is blocked until both current FIRST and SECOND are verified', () => {
  const c=config({barrierPolicy:'TIMEBOXED_AUDIT',auditTimeboxMinutes:1}); let {runtime}=launchAll(c,start(c),1);
  let planned=planScenarioWorkActions(c,runtime,61000); runtime=planned.runtime;
  runtime=applyScenarioLaunch(runtime,planned.actions[0],{sessionId:'aud',taskId:'ca',now:61000});
  runtime=applyScenarioCompletion(c,runtime,'pipeline:auditor',{assistantText:allocationBlock(),chatUrl:'https://chatgpt.com/c/a',now:62000});
  planned=planScenarioWorkActions(c,runtime,62001); runtime=planned.runtime;
  const secondActions=planned.actions.filter(a=>a.stage==='SECOND_WORK');
  for (const action of secondActions) runtime=applyScenarioLaunch(runtime,action,{sessionId:`s-${action.index}`,taskId:`c-${action.index}`,now:62001});
  runtime=applyScenarioCompletion(c,runtime,'pipeline:g1:r1:second:second-01',{assistantText:resultBlock({phase:'SECOND',slot:'SECOND-01',task:'R1S1',key:'KS1-1'}),chatUrl:'https://chatgpt.com/c/s1',now:63000});
  runtime=applyScenarioCompletion(c,runtime,'pipeline:g1:r1:second:second-02',{assistantText:resultBlock({phase:'SECOND',slot:'SECOND-02',task:'R1S2',key:'KS1-2'}),chatUrl:'https://chatgpt.com/c/s2',now:64000});
  planned=planScenarioWorkActions(c,runtime,64001);
  assert.equal(planned.runtime.round,1);
  assert.equal(planned.actions.some(a=>a.stage==='FIRST_WORK'),false, 'existing waiting FIRST chats are not duplicated');
  runtime=completeWorker(c,runtime,1,resultBlock({slot:'FIRST-01',task:'F1',key:'KF1'}),65000);
  runtime=completeWorker(c,runtime,2,resultBlock({slot:'FIRST-02',task:'F2',key:'KF2'}),65001);
  runtime=completeWorker(c,runtime,3,resultBlock({slot:'FIRST-03',task:'F3',key:'KF3'}),65002);
  planned=planScenarioWorkActions(c,runtime,65003);
  assert.equal(planned.runtime.round,2);
});

test('TIMEBOXED allocation does not strand FIRST correction after phase moved to SECOND', () => {
  const c=config({barrierPolicy:'TIMEBOXED_AUDIT',auditTimeboxMinutes:1}); let {runtime}=launchAll(c,start(c),1);
  let planned=planScenarioWorkActions(c,runtime,61000); runtime=planned.runtime;
  runtime=applyScenarioLaunch(runtime,planned.actions[0],{sessionId:'aud',taskId:'ca',now:61000});
  runtime=applyScenarioCompletion(c,runtime,'pipeline:auditor',{assistantText:allocationBlock(),chatUrl:'https://chatgpt.com/c/a',now:62000});
  runtime=applyScenarioCompletion(c,runtime,'pipeline:g1:r1:first:first-01',{assistantText:'Done without contract',chatUrl:'https://chatgpt.com/c/f1',now:62001});
  assert.equal(runtime.phase,'SECOND');
  assert.equal(runtime.firstSlots['1'].correctionPending,true);
  planned=planScenarioWorkActions(c,runtime,62002);
  const repair=planned.actions.find(a=>a.participantKey==='pipeline:g1:r1:first:first-01');
  assert.ok(repair);
  assert.equal(repair.stage,'FIRST_CORRECTION');
  assert.equal(repair.url,'https://chatgpt.com/c/f1');
});

test('correction exhaustion replaces worker with a fresh chat instead of dead TIMED_OUT state', () => {
  const c=config({maxCorrectionAttempts:1}); let {runtime}=launchAll(c,start(c),1);
  const key='pipeline:g1:r1:first:first-01';
  runtime=applyScenarioCompletion(c,runtime,key,{assistantText:'bad-1',chatUrl:'https://chatgpt.com/c/old',now:10});
  let planned=planScenarioWorkActions(c,runtime,11);
  const correction=planned.actions.find(a=>a.participantKey===key);
  runtime=applyScenarioLaunch(planned.runtime,correction,{sessionId:'corr',taskId:'corr-task',now:11});
  runtime=applyScenarioCompletion(c,runtime,key,{assistantText:'bad-2',chatUrl:'https://chatgpt.com/c/old',now:12});
  assert.equal(runtime.firstSlots['1'].state,'READY');
  assert.equal(runtime.firstSlots['1'].replacementPending,true);
  assert.equal(runtime.firstSlots['1'].chatUrl,'');
  assert.equal(runtime.firstSlots['1'].replacementCount,1);
  assert.equal(runtime.firstSlots['1'].correctionCount,0);
  planned=planScenarioWorkActions(c,runtime,13);
  const replacement=planned.actions.find(a=>a.participantKey===key);
  assert.ok(replacement);
  assert.equal(replacement.stage,'FIRST_REPLACEMENT');
  assert.equal(replacement.replaceExistingChat,true);
});

test('auditor first_audit must exactly account for launch snapshot', () => {
  const c=config({barrierPolicy:'TIMEBOXED_AUDIT',auditTimeboxMinutes:1}); let {runtime}=launchAll(c,start(c),1);
  let planned=planScenarioWorkActions(c,runtime,61000); runtime=planned.runtime;
  runtime=applyScenarioLaunch(runtime,planned.actions[0],{sessionId:'aud',taskId:'ca',now:61000});
  const parsed=JSON.parse(allocationBlock().split('\n')[1]);
  parsed.first_audit=parsed.first_audit.slice(0,2);
  const bad=`${AUDITOR_ALLOCATION_MARKER}\n${JSON.stringify(parsed)}\n${AUDITOR_ALLOCATION_END_MARKER}`;
  runtime=applyScenarioCompletion(c,runtime,'pipeline:auditor',{assistantText:bad,chatUrl:'https://chatgpt.com/c/a',now:62000});
  assert.equal(runtime.phase,'AUDITOR');
  assert.equal(runtime.auditor.correctionPending,true);
  assert.ok(runtime.auditor.validationErrors.some(e=>e==='FIRST_AUDIT_COUNT_MISMATCH'));
});


test('auditor correction keeps the exact frozen first_audit snapshot even when a late FIRST completes meanwhile', () => {
  const c=config({barrierPolicy:'TIMEBOXED_AUDIT',auditTimeboxMinutes:1}); let {runtime}=launchAll(c,start(c),1);
  runtime=completeWorker(c,runtime,1,resultBlock({slot:'FIRST-01',task:'F1',key:'KF1'}),10);
  let planned=planScenarioWorkActions(c,runtime,61000); runtime=planned.runtime;
  const firstAuditor=planned.actions.find(a=>a.role==='AUDITOR');
  const frozen=structuredClone(firstAuditor.firstAuditSnapshot);
  runtime=applyScenarioLaunch(runtime,firstAuditor,{sessionId:'aud-1',taskId:'ca-1',now:61000});
  const bad=JSON.parse(allocationBlock().split('\n')[1]);
  bad.reservations=bad.reservations.filter(r=>r.slot!=='SECOND-02');
  runtime=applyScenarioCompletion(c,runtime,'pipeline:auditor',{
    assistantText:`${AUDITOR_ALLOCATION_MARKER}\n${JSON.stringify(bad)}\n${AUDITOR_ALLOCATION_END_MARKER}`,
    chatUrl:'https://chatgpt.com/c/a',now:62000,
  });
  runtime=completeWorker(c,runtime,2,resultBlock({slot:'FIRST-02',task:'F2',key:'KF2'}),62001);
  planned=planScenarioWorkActions(c,runtime,62002);
  const correction=planned.actions.find(a=>a.role==='AUDITOR');
  assert.ok(correction);
  assert.deepEqual(correction.firstAuditSnapshot,frozen,'late FIRST completion must not rewrite the auditor launch snapshot');
  assert.equal(correction.firstAuditSnapshot.find(x=>x.slot==='FIRST-02').slotConsumed,false);
});

test('auditor timeout replacements are bounded and preserve fail-safe stop instead of infinite launch churn', () => {
  const c=config({barrierPolicy:'TIMEBOXED_AUDIT',auditTimeboxMinutes:1,maxCorrectionAttempts:0,maxReplacementAttempts:1});
  let {runtime}=launchAll(c,start(c),1);
  let planned=planScenarioWorkActions(c,runtime,61000); runtime=planned.runtime;
  const initial=planned.actions.find(a=>a.role==='AUDITOR');
  const frozen=structuredClone(initial.firstAuditSnapshot);
  runtime=applyScenarioLaunch(runtime,initial,{sessionId:'aud-1',taskId:'ca-1',now:61000});
  runtime=applyScenarioTimeout(c,runtime,'pipeline:auditor',{now:62000,reason:'AUDITOR_TIMEOUT_TEST'});
  assert.equal(runtime.auditor.replacementPending,true);
  assert.equal(runtime.auditor.replacementCount,1);
  planned=planScenarioWorkActions(c,runtime,62001);
  const replacement=planned.actions.find(a=>a.role==='AUDITOR');
  assert.ok(replacement);
  assert.equal(replacement.stage,'AUDITOR_REPLACEMENT');
  assert.deepEqual(replacement.firstAuditSnapshot,frozen);
  runtime=applyScenarioLaunch(planned.runtime,replacement,{sessionId:'aud-2',taskId:'ca-2',now:62001});
  runtime=applyScenarioTimeout(c,runtime,'pipeline:auditor',{now:63000,reason:'AUDITOR_TIMEOUT_TEST_2'});
  assert.equal(runtime.runState,'STOPPED');
  assert.equal(runtime.auditor.state,'EXHAUSTED');
  assert.match(runtime.lastError,/AUDITOR_TIMEOUT_REPLACEMENT_EXHAUSTED/);
  planned=planScenarioWorkActions(c,runtime,64000);
  assert.equal(planned.actions.length,0,'exhausted auditor must not consume infinite overnight launches');
});

test('worker invalid-result replacements are bounded and stop scenario fail-safe after budget exhaustion', () => {
  const c=config({maxCorrectionAttempts:0,maxReplacementAttempts:1}); let {runtime}=launchAll(c,start(c),1);
  const key='pipeline:g1:r1:first:first-01';
  runtime=applyScenarioCompletion(c,runtime,key,{assistantText:'invalid-first',chatUrl:'https://chatgpt.com/c/w1',now:10});
  assert.equal(runtime.firstSlots['1'].replacementPending,true);
  let planned=planScenarioWorkActions(c,runtime,11);
  const replacement=planned.actions.find(a=>a.participantKey===key);
  assert.ok(replacement);
  runtime=applyScenarioLaunch(planned.runtime,replacement,{sessionId:'rep',taskId:'rep-core',now:11});
  runtime=applyScenarioCompletion(c,runtime,key,{assistantText:'invalid-again',chatUrl:'https://chatgpt.com/c/w2',now:12});
  assert.equal(runtime.runState,'STOPPED');
  assert.equal(runtime.firstSlots['1'].state,'EXHAUSTED');
  assert.match(runtime.lastError,/WORKER_REPLACEMENT_EXHAUSTED/);
  planned=planScenarioWorkActions(c,runtime,13);
  assert.equal(planned.actions.length,0);
});
