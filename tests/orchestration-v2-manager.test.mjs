import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageRepository } from '../src/core/storage.js';
import { OrchestrationV2Manager, ORCHESTRATION_V2_ALARM_PREFIX } from '../src/core/orchestration-v2-manager.js';
import { RunState } from '../src/core/schema.js';
import { exportOrchestrationProfile } from '../src/core/orchestration-v2-profile.js';

function chromeFake() {
  const data = {};
  const alarmCalls = [];
  return {
    data, alarmCalls,
    storage:{local:{
      async get(key){
        if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, structuredClone(data[k])]));
        return { [key]: structuredClone(data[key]) };
      },
      async set(record){ Object.assign(data, structuredClone(record)); },
      async remove(keys){ for(const key of Array.isArray(keys)?keys:[keys]) delete data[key]; },
    }},
    alarms:{
      async create(name, options){ alarmCalls.push(['create', name, structuredClone(options)]); },
      async clear(name){ alarmCalls.push(['clear', name]); return true; },
    },
  };
}
const cfg = (projectId, enabled = false) => ({
  enabled, projectId, targetRepository:`owner/${projectId}`, controlRepository:`owner/${projectId}`,
  controlIssueNumber:1, masterCoordinatorPrompt:'master', defaultDesiredWorkers:1, absoluteMaxWorkers:2,
});
function hierarchyGraph(graphId) {
  return {
    schemaVersion: 1,
    graphId,
    controlEpoch: 1,
    promptProfiles: [
      { id: 'root-v1', role: 'GLOBAL_DIRECTOR', version: 1, prompt: `ROOT ${graphId}` },
    ],
    nodes: [
      {
        id: 'root',
        parentId: null,
        childIds: [],
        promptProfileId: 'root-v1',
        chatMode: 'PERSISTENT_CHAT',
      },
    ],
  };
}

function managerFixture(){
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  let n=0;
  const manager = new OrchestrationV2Manager({ coreRepository:core, chromeApi:chrome, createId:()=>`orch-${++n}`, now:()=>1000 });
  return { chrome, core, manager };
}

test('independent multiple orchestras keep namespaced config/runtime and selection', async()=>{
  const {manager,chrome}=managerFixture();
  const a=await manager.create({name:'Шахи',config:cfg('chess')});
  const b=await manager.create({name:'Nika',config:cfg('nika')});
  assert.equal(b.selectedId,'orch-2');
  await manager.select('orch-1');
  await manager.updateConfig({...cfg('chess'),maxCoordinatorTurns:21});
  const list=await manager.list();
  assert.equal(list.orchestras.length,2);
  assert.equal(list.orchestras.find(x=>x.id==='orch-1').config.maxCoordinatorTurns,21);
  assert.notEqual(list.orchestras.find(x=>x.id==='orch-2').config.maxCoordinatorTurns,21);
  assert.ok(chrome.data['autopilotOrchestrationV2Config:orch-1']);
  assert.ok(chrome.data['autopilotOrchestrationV2Config:orch-2']);
});

test('local pause preserves runtime and resume only restores sessions paused by owner', async()=>{
  const {manager,core}=managerFixture();
  await manager.create({name:'Шахи',config:cfg('chess')});
  await manager.updateConfig(cfg('chess',true),'orch-1');
  const controller=manager.controllerFor('orch-1');
  await controller.cycle({nowMs:1000});
  await controller.runtimeRepository.update(r=>{r.lastAppliedControlRevision=7;return r;});
  const before=await core.load();
  const managed=Object.values(before.sessionsById).find(x=>x.orchestrationCoordinator?.managed);
  assert.ok(managed);
  await manager.pause('orch-1');
  assert.equal((await core.load()).sessionsById[managed.id].runState,RunState.PAUSED);
  assert.equal((await controller.runtimeRepository.load()).lastAppliedControlRevision,7);
  assert.equal((await manager.getStatus('orch-1')).ownerPaused,true);
  await manager.resume('orch-1');
  assert.equal((await core.load()).sessionsById[managed.id].runState,RunState.RECOVERING);
  assert.equal((await controller.runtimeRepository.load()).lastAppliedControlRevision,7);
});

test('hierarchy orchestra Start materializes roots and owner Pause/Resume stays isolated', async()=>{
  const {manager,core}=managerFixture();
  await manager.create({name:'Hierarchy A',config:cfg('hierarchy-a')});
  await manager.create({name:'Hierarchy B',config:cfg('hierarchy-b')});
  await manager.controllerFor('orch-1').configureHierarchy(hierarchyGraph('graph-a'),{nowMs:1000});
  await manager.controllerFor('orch-2').configureHierarchy(hierarchyGraph('graph-b'),{nowMs:1000});

  const startedA=await manager.start('orch-1');
  const startedB=await manager.start('orch-2');
  assert.equal(startedA.hierarchyStart?.kind,'HIERARCHY_STARTED');
  assert.equal(startedA.startCycle?.kind,'HIERARCHY_CYCLE');
  assert.equal(startedB.hierarchyStart?.kind,'HIERARCHY_STARTED');

  let state=await core.load();
  const sessionA=Object.values(state.sessionsById).find(s=>s.orchestrationHierarchy?.graphId==='graph-a');
  const sessionB=Object.values(state.sessionsById).find(s=>s.orchestrationHierarchy?.graphId==='graph-b');
  assert.ok(sessionA); assert.ok(sessionB);
  assert.equal(sessionA.runState,RunState.RUNNING);
  assert.equal(sessionB.runState,RunState.RUNNING);

  await manager.pause('orch-1');
  state=await core.load();
  assert.equal(state.sessionsById[sessionA.id].enabled,false);
  assert.equal(state.sessionsById[sessionA.id].runState,RunState.PAUSED);
  assert.equal(state.sessionsById[sessionA.id].orchestrationHierarchy.scopeState,'PAUSED');
  assert.equal(state.sessionsById[sessionB.id].enabled,true);
  assert.notEqual(state.sessionsById[sessionB.id].runState,RunState.PAUSED);

  const hierarchyPausedA=await manager.controllerFor('orch-1').runtimeRepository.load();
  const hierarchyPausedB=await manager.controllerFor('orch-2').runtimeRepository.load();
  assert.equal(hierarchyPausedA.hierarchy.state.nodesById.root.scopeState,'PAUSED');
  assert.equal(hierarchyPausedB.hierarchy.state.nodesById.root.scopeState,'RUNNING');

  const runtimeBeforeResume=hierarchyPausedA;
  assert.deepEqual(runtimeBeforeResume.pendingCoordinatorEvents,[]);
  await manager.resume('orch-1');

  state=await core.load();
  assert.equal(state.sessionsById[sessionA.id].enabled,true);
  assert.equal(state.sessionsById[sessionA.id].runState,RunState.RECOVERING);
  assert.equal(state.sessionsById[sessionA.id].orchestrationHierarchy.scopeState,'RUNNING');
  assert.notEqual(state.sessionsById[sessionB.id].runState,RunState.PAUSED);
  const runtimeAfterResume=await manager.controllerFor('orch-1').runtimeRepository.load();
  assert.equal(runtimeAfterResume.hierarchy.state.nodesById.root.scopeState,'RUNNING');
  assert.equal(
    (await manager.controllerFor('orch-2').runtimeRepository.load()).hierarchy.state.nodesById.root.scopeState,
    'RUNNING',
  );
  assert.deepEqual(
    runtimeAfterResume.pendingCoordinatorEvents,
    [],
    'hierarchy Resume must not inject legacy Coordinator recovery events',
  );
});

test('hierarchy emergency Stop is sticky in raw runtime and revokes only its Core Sessions', async()=>{
  const {manager,core,chrome}=managerFixture();
  await manager.create({name:'Hierarchy A',config:cfg('stop-a')});
  await manager.create({name:'Hierarchy B',config:cfg('stop-b')});
  await manager.controllerFor('orch-1').configureHierarchy(hierarchyGraph('stop-graph-a'),{nowMs:1000});
  await manager.controllerFor('orch-2').configureHierarchy(hierarchyGraph('stop-graph-b'),{nowMs:1000});
  await manager.start('orch-1');
  await manager.start('orch-2');

  let state=await core.load();
  const sessionA=Object.values(state.sessionsById).find(s=>s.orchestrationHierarchy?.graphId==='stop-graph-a');
  const sessionB=Object.values(state.sessionsById).find(s=>s.orchestrationHierarchy?.graphId==='stop-graph-b');
  assert.ok(sessionA); assert.ok(sessionB);

  const stopped=await manager.emergencyStop('orch-1');
  assert.equal(stopped.emergencyStopped,true);
  assert.equal(chrome.data['autopilotOrchestrationV2Config:orch-1'].enabled,false);

  const rawA=chrome.data['autopilotOrchestrationV2Runtime:orch-1'];
  assert.equal(rawA.hierarchy.state.nodesById.root.scopeState,'STOPPED');
  assert.equal(rawA.hierarchy.state.nodesById.root.lifecycle,'STOPPED');

  state=await core.load();
  assert.equal(state.sessionsById[sessionA.id].enabled,false);
  assert.equal(state.sessionsById[sessionA.id].runState,RunState.STOPPED);
  assert.equal(state.sessionsById[sessionB.id].enabled,true);
  assert.notEqual(state.sessionsById[sessionB.id].runState,RunState.STOPPED);
});

test('delete isolation removes only selected orchestra and preserves the other namespace', async()=>{
  const {manager,chrome}=managerFixture();
  await manager.create({name:'A',config:cfg('a')});
  await manager.create({name:'B',config:cfg('b')});
  await manager.controllerFor('orch-1').runtimeRepository.update(r=>{r.lastAppliedControlRevision=11;return r;});
  await manager.controllerFor('orch-2').runtimeRepository.update(r=>{r.lastAppliedControlRevision=22;return r;});
  await manager.delete('orch-2');
  const list=await manager.list();
  assert.deepEqual(list.orchestras.map(x=>x.id),['orch-1']);
  assert.equal((await manager.controllerFor('orch-1').runtimeRepository.load()).lastAppliedControlRevision,11);
  assert.equal(chrome.data['autopilotOrchestrationV2Config:orch-2'],undefined);
  assert.equal(chrome.data['autopilotOrchestrationV2Runtime:orch-2'],undefined);
});

test('delete last orchestra supports zero state and fresh create', async()=>{
  const {manager}=managerFixture();
  await manager.create({name:'Only',config:cfg('only')});
  await manager.delete('orch-1');
  let status=await manager.getStatus();
  assert.equal(status.selectedId,''); assert.equal(status.orchestras.length,0);
  status=await manager.create({name:'Fresh',config:cfg('fresh')});
  assert.equal(status.selectedId,'orch-2');
});

test('per-orchestra alarm namespace prevents secondary orchestra wake from replacing primary', async()=>{
  const {manager,chrome}=managerFixture();
  await manager.create({name:'A',config:cfg('a')});
  await manager.create({name:'B',config:cfg('b')});
  await manager.updateConfig(cfg('a',true),'orch-1');
  await manager.updateConfig(cfg('b',true),'orch-2');
  await manager.reconcileAlarm();
  const names=chrome.alarmCalls.filter(x=>x[0]==='create').map(x=>x[1]);
  assert.ok(names.includes(`${ORCHESTRATION_V2_ALARM_PREFIX}orch-1`));
  assert.ok(names.includes(`${ORCHESTRATION_V2_ALARM_PREFIX}orch-2`));
  assert.notEqual(names[names.length-1], 'autopilot-orchestration-v2-wake');
});

test('owner-paused safe identity rebind resets only its namespace', async()=>{
  const {manager,chrome}=managerFixture();
  await manager.create({name:'A',config:cfg('a')});
  await manager.create({name:'B',config:cfg('b')});
  await manager.pause('orch-1');
  await manager.updateConfig(cfg('a2'), 'orch-1');
  assert.equal((await manager.getStatus('orch-1')).config.projectId,'a2');
  assert.equal((await manager.getStatus('orch-2')).config.projectId,'b');
  assert.ok(chrome.data['autopilotOrchestrationV2Runtime:orch-1']);
});

test('enabled identity change is rejected until local pause', async()=>{
  const {manager}=managerFixture();
  await manager.create({name:'A',config:cfg('a')});
  await manager.updateConfig(cfg('a',true),'orch-1');
  await assert.rejects(()=>manager.updateConfig(cfg('a2',true),'orch-1'),/Pause the orchestra before changing/);
});




test('zero-state profile preview and import create a disabled selected orchestra', async()=>{
  const {manager}=managerFixture();
  const profile=exportOrchestrationProfile(cfg('zero-import'),{name:'Zero Import'});
  const preview=await manager.previewProfile(profile);
  assert.equal(preview.projectId,'zero-import');
  assert.equal((await manager.list()).orchestras.length,0,'preview must be side-effect free');
  const result=await manager.importProfile(profile);
  assert.equal(result.config.projectId,'zero-import');
  assert.equal(result.config.enabled,false);
  const status=await manager.getStatus();
  assert.equal(status.orchestras.length,1);
  assert.equal(status.orchestra.name,'Zero Import');
  assert.equal(status.selectedId,status.orchestra.id);
});
test('different-project profile import creates a fresh orchestra instead of inheriting legacy runtime', async()=>{
  const {manager}=managerFixture();
  await manager.create({name:'Legacy',config:cfg('legacy-project')});
  await manager.updateConfig(cfg('legacy-project',true),'orch-1');
  const profile=exportOrchestrationProfile(cfg('clean-project'),{name:'Clean Project'});
  const result=await manager.importProfile(profile);
  assert.equal(result.config.projectId,'clean-project');
  assert.equal(result.config.enabled,false);
  const list=await manager.list();
  assert.equal(list.orchestras.length,2);
  assert.equal(list.selectedId,'orch-2');
  assert.equal((await manager.getStatus('orch-1')).config.projectId,'legacy-project');
  assert.equal((await manager.getStatus('orch-2')).runtime.lastAppliedControlRevision,0);
});

test('owner-paused profile import is setup-only and can safely rebind identity', async()=>{
  const {manager}=managerFixture();
  await manager.create({name:'A',config:cfg('a')});
  await manager.updateConfig(cfg('a',true),'orch-1');
  await manager.pause('orch-1');
  const profile=exportOrchestrationProfile(cfg('imported'),{name:'Imported'});
  const result=await manager.importProfile(profile);
  assert.equal(result.config.projectId,'imported');
  assert.equal(result.config.enabled,false,'profile import must never auto-start orchestration');
  assert.equal((await manager.getStatus('orch-1')).ownerPaused,true);
});

test('project identity cannot collide across independent orchestras', async()=>{
  const {manager}=managerFixture();
  await manager.create({name:'A',config:cfg('same')});
  await manager.create({name:'B'});
  await assert.rejects(()=>manager.updateConfig(cfg('same'),'orch-2'),/already used by orchestra/);
  assert.equal((await manager.getStatus('orch-1')).config.projectId,'same');
  assert.equal((await manager.getStatus('orch-2')).config.projectId,'');
});

test('create with a duplicate configured project rolls back the partial orchestra', async()=>{
  const {manager}=managerFixture();
  await manager.create({name:'A',config:cfg('same')});
  await assert.rejects(()=>manager.create({name:'B',config:cfg('same')}),/already used by orchestra/);
  const list=await manager.list();
  assert.deepEqual(list.orchestras.map(item=>item.name),['A']);
});


test('enabled provider or coordinator identity change is rejected until local pause', async()=>{
  const {manager}=managerFixture();
  await manager.create({name:'A',config:cfg('a')});
  await manager.updateConfig(cfg('a',true),'orch-1');
  const current=(await manager.getStatus('orch-1')).config;
  await assert.rejects(
    ()=>manager.updateConfig({...current,targetRepository:'owner/other-target'},'orch-1'),
    /Pause the orchestra before changing/,
  );
  await assert.rejects(
    ()=>manager.updateConfig({...current,coordinatorLaunchUrl:'https:\/\/chatgpt.com\/g\/different'},'orch-1'),
    /Pause the orchestra before changing/,
  );
});

test('emergency STOP revokes authority before corrupt runtime normalization and preserves raw recovery evidence', async()=>{
  const {manager,chrome,core}=managerFixture();
  await manager.create({name:'A',config:cfg('a')});
  await manager.create({name:'B',config:cfg('b')});
  await manager.updateConfig(cfg('a',true),'orch-1');
  await manager.controllerFor('orch-1').cycle({nowMs:1000});
  const managed=Object.values((await core.load()).sessionsById).find(s=>s.orchestrationCoordinator?.projectId==='a');
  assert.ok(managed);
  const runtimeKeyA='autopilotOrchestrationV2Runtime:orch-1';
  const runtimeKeyB='autopilotOrchestrationV2Runtime:orch-2';
  chrome.data[runtimeKeyB]={...(chrome.data[runtimeKeyB]||{}),sentinel:'untouched-b'};
  const corrupt={...structuredClone(chrome.data[runtimeKeyA]), recoveryEvidence:{operationId:'op-keep'}, sentinel:'keep-a'};
  corrupt.workersById={bad:'not-an-object'};
  corrupt.workerOrder=['bad'];
  chrome.data[runtimeKeyA]=corrupt;
  const out=await manager.emergencyStop('orch-1');
  assert.equal(out.emergencyStopped,true);
  assert.equal(chrome.data['autopilotOrchestrationV2Config:orch-1'].enabled,false);
  assert.equal(chrome.data[runtimeKeyA].mode,'PAUSE');
  assert.equal(chrome.data[runtimeKeyA].desiredActiveWorkers,0);
  assert.deepEqual(chrome.data[runtimeKeyA].recoveryEvidence,{operationId:'op-keep'});
  assert.equal(chrome.data[runtimeKeyA].sentinel,'keep-a');
  assert.equal(chrome.data[runtimeKeyB].sentinel,'untouched-b');
  assert.equal((await core.load()).sessionsById[managed.id].enabled,false);
  assert.ok(chrome.alarmCalls.some(call=>call[0]==='clear' && call[1]===`${ORCHESTRATION_V2_ALARM_PREFIX}orch-1`));
});

test('pause -> edit -> cycle others -> resume is isolated to the selected orchestra', async()=>{
  const {manager,core}=managerFixture();
  await manager.create({name:'A',config:cfg('a')});
  await manager.create({name:'B',config:cfg('b')});
  await manager.updateConfig(cfg('a',true),'orch-1');
  await manager.updateConfig(cfg('b',true),'orch-2');
  await manager.controllerFor('orch-1').cycle({nowMs:1000});
  await manager.controllerFor('orch-2').cycle({nowMs:1000});

  const before=await core.load();
  const aSession=Object.values(before.sessionsById).find(s=>s.orchestrationCoordinator?.projectId==='a');
  const bSession=Object.values(before.sessionsById).find(s=>s.orchestrationCoordinator?.projectId==='b');
  assert.ok(aSession); assert.ok(bSession);

  await manager.pause('orch-1');
  const aPaused=await manager.getStatus('orch-1');
  const bWhileAPaused=await manager.getStatus('orch-2');
  assert.equal(aPaused.ownerPaused,true);
  assert.equal(bWhileAPaused.ownerPaused,false);
  assert.equal((await core.load()).sessionsById[aSession.id].runState,RunState.PAUSED);
  assert.notEqual((await core.load()).sessionsById[bSession.id].runState,RunState.PAUSED);

  await manager.updateConfig({...aPaused.config,maxCoordinatorTurns:37},'orch-1');
  assert.equal((await manager.getStatus('orch-1')).config.maxCoordinatorTurns,37);
  assert.equal((await manager.getStatus('orch-2')).config.maxCoordinatorTurns,10);

  const cycled=await manager.cycleAll();
  const aCycle=cycled.results.find(item=>item.id==='orch-1');
  const bCycle=cycled.results.find(item=>item.id==='orch-2');
  assert.equal(aCycle.kind,'OWNER_PAUSED');
  assert.ok(bCycle.result,'second orchestra must continue its own cycle');

  await manager.resume('orch-1');
  assert.equal((await manager.getStatus('orch-1')).ownerPaused,false);
  assert.equal((await core.load()).sessionsById[aSession.id].runState,RunState.RECOVERING);
  assert.notEqual((await core.load()).sessionsById[bSession.id].runState,RunState.PAUSED);
});

test('explicit start enables a disabled orchestra and creates the first coordinator turn immediately', async()=>{
  const {manager,core}=managerFixture();
  await manager.create({name:'Start now',config:cfg('start-now')});
  const before=await manager.getStatus('orch-1');
  assert.equal(before.config.enabled,false);
  assert.equal(Object.values((await core.load()).sessionsById).some(s=>s.orchestrationCoordinator?.projectId==='start-now'),false);
  const started=await manager.start('orch-1');
  assert.equal(started.config.enabled,true);
  assert.equal(started.startCycle?.kind,'CYCLE');
  const coordinator=Object.values((await core.load()).sessionsById).find(s=>s.orchestrationCoordinator?.projectId==='start-now');
  assert.ok(coordinator,'Start must materialize the coordinator Session without waiting for watchdog');
  assert.equal(coordinator.runState,RunState.RUNNING);
});

test('start while owner-paused fails closed and requires Resume semantics', async()=>{
  const {manager}=managerFixture();
  await manager.create({name:'Paused',config:cfg('paused')});
  await manager.pause('orch-1');
  await assert.rejects(()=>manager.start('orch-1'),/Use Resume instead of Start/);
});


test('0.9.7 importing an existing project selects that orchestra instead of mutating selected legacy orchestra', async()=>{
  const {manager}=managerFixture();
  await manager.create({name:'Project A',config:cfg('project-a')});
  await manager.create({name:'Project B',config:cfg('project-b')});
  await manager.select('orch-1');
  const profile=exportOrchestrationProfile(cfg('project-b'),{name:'Project B refreshed'});
  const result=await manager.importProfile(profile);
  assert.equal(result.config.projectId,'project-b');
  const list=await manager.list();
  assert.equal(list.orchestras.length,2);
  assert.equal(list.selectedId,'orch-2');
  assert.equal((await manager.getStatus('orch-1')).config.projectId,'project-a');
  assert.equal((await manager.getStatus('orch-2')).config.projectId,'project-b');
});
