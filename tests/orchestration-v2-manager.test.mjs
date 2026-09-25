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

function subagentAdmissionGraph(graphId) {
  return {
    schemaVersion: 1,
    graphId,
    controlEpoch: 1,
    promptProfiles: [
      { id: 'root-v1', role: 'GLOBAL_DIRECTOR', version: 1, prompt: `ROOT ${graphId}` },
    ],
    nodes: [
      { id: 'root', parentId: null, childIds: ['manager'], promptProfileId: 'root-v1', chatMode: 'PERSISTENT_CHAT' },
      { id: 'manager', parentId: 'root', childIds: ['worker-a', 'worker-b'], promptProfileId: 'root-v1', chatMode: 'PERSISTENT_CHAT' },
      { id: 'worker-a', parentId: 'manager', childIds: [], promptProfileId: 'root-v1', chatMode: 'PERSISTENT_CHAT' },
      { id: 'worker-b', parentId: 'manager', childIds: [], promptProfileId: 'root-v1', chatMode: 'PERSISTENT_CHAT' },
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

test('owner can configure a fixed Director Manager Worker hierarchy before first Start', async()=>{
  const {manager,core}=managerFixture();
  await manager.create({name:'Template',config:cfg('template-project')});
  const configured=await manager.configureHierarchyTemplate({
    domains:[
      {id:'runtime',scope:'Runtime, recovery and reliability.'},
      {id:'science',scope:'Scientific model and validation.'},
    ],
    workersPerManager:2,
    includeIntegrationManager:true,
    includeQaRedTeam:true,
  });

  assert.equal(configured.hierarchy.rootCount,1);
  assert.equal(configured.hierarchy.managerCount,2);
  assert.equal(configured.hierarchy.workerCount,4);
  assert.equal(configured.hierarchy.nodeCount,9);
  assert.equal(configured.hierarchy.promptProfileCount,18);
  assert.equal(
    Object.values((await core.load()).sessionsById).some(session=>session.orchestrationHierarchy?.managed),
    false,
    'template configuration must remain setup-only',
  );

  const profile=await manager.exportProfile('Template');
  assert.equal(profile.hierarchy.nodes.length,9);
  assert.ok(profile.hierarchy.nodes.some(node=>node.id==='integration'));
  assert.ok(profile.hierarchy.nodes.some(node=>node.id==='qa-red-team'));
  const workerPrompt=profile.hierarchy.promptProfiles.find(item=>item.id==='worker:runtime:01:prompt-v1');
  assert.match(workerPrompt.prompt,/NO_ACTION/);
  assert.match(workerPrompt.prompt,/scheduler #2/);

  const started=await manager.start('orch-1');
  assert.equal(started.hierarchyStart?.kind,'HIERARCHY_STARTED');
  const rootSession=Object.values((await core.load()).sessionsById)
    .find(session=>session.orchestrationHierarchy?.nodeId==='director');
  assert.ok(rootSession);
});

test('hierarchy template replacement fails closed after physical hierarchy Sessions exist', async()=>{
  const {manager}=managerFixture();
  await manager.create({name:'Template',config:cfg('template-replace')});
  await manager.configureHierarchyTemplate({
    domains:[{id:'runtime',scope:'Runtime.'}],
    workersPerManager:1,
  });
  await manager.start('orch-1');
  await manager.pause('orch-1');
  await assert.rejects(
    ()=>manager.configureHierarchyTemplate({
      domains:[{id:'science',scope:'Science.'}],
      workersPerManager:1,
    }),
    /before the first Start/,
  );
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
test('hierarchy profile import persists the graph setup-only, exports it again, and Start uses it', async()=>{
  const {manager,core}=managerFixture();
  const profile=exportOrchestrationProfile(cfg('hierarchy-import'),{
    name:'Hierarchy Import',
    hierarchy:hierarchyGraph('profile-graph'),
  });

  const result=await manager.importProfile(profile);
  assert.equal(result.config.projectId,'hierarchy-import');
  assert.equal(result.config.enabled,false);
  assert.equal(result.hierarchy.graphId,'profile-graph');

  let runtime=await manager.controllerFor(result.status.selectedId).runtimeRepository.load();
  assert.equal(runtime.hierarchy.graph.graphId,'profile-graph');
  assert.deepEqual(runtime.hierarchy.graph.rootIds,['root']);
  assert.equal(
    Object.values((await core.load()).sessionsById).some(session=>session.orchestrationHierarchy?.graphId==='profile-graph'),
    false,
    'profile import must configure hierarchy without starting it',
  );

  const exported=await manager.exportProfile('Hierarchy Export');
  assert.equal(exported.hierarchy.graphId,'profile-graph');
  assert.equal(exported.hierarchy.nodes[0].id,'root');
  assert.equal(exported.hierarchy.promptProfiles[0].prompt,'ROOT profile-graph');

  const started=await manager.start(result.status.selectedId);
  assert.equal(started.hierarchyStart?.kind,'HIERARCHY_STARTED');
  const hierarchySession=Object.values((await core.load()).sessionsById)
    .find(session=>session.orchestrationHierarchy?.graphId==='profile-graph');
  assert.ok(hierarchySession);

  runtime=await manager.controllerFor(result.status.selectedId).runtimeRepository.load();
  assert.equal(runtime.hierarchy.state.nodesById.root.scopeState,'RUNNING');
});

test('subagent structural precheck uses persisted owner policy and durable hierarchy, never caller topology', async()=>{
  const {manager,core,chrome}=managerFixture();
  const ownerPolicy={
    schemaVersion:1,
    allowAgentCreatedChildren:true,
    maxDepth:4,
    maxChildrenPerAgent:2,
  };
  const profile=exportOrchestrationProfile(cfg('subagent-authority'),{
    name:'Subagent Authority',
    hierarchy:subagentAdmissionGraph('subagent-authority-graph'),
    subagentPolicy:ownerPolicy,
  });
  const imported=await manager.importProfile(profile);
  assert.deepEqual(imported.status.orchestra.subagentPolicy,ownerPolicy);

  const denied=await manager.previewSelectedSubagentStructureAdmission({
    initiator:'AGENT',
    parentNodeId:'manager',
    requestedChildren:1,
  });
  assert.equal(denied.decision,'DENY');
  assert.equal(denied.reasonCode,'MAX_FANOUT_EXCEEDED');
  assert.equal(denied.availableDirectChildren,0);
  assert.equal(denied.advisoryOnly,true);
  assert.equal(denied.spawnAuthority,false);

  const spoofedGraph=hierarchyGraph('spoofed-shallow-graph');
  await assert.rejects(
    ()=>manager.previewSelectedSubagentStructureAdmission({
      initiator:'AGENT',
      parentNodeId:'manager',
      requestedChildren:1,
      graph:spoofedGraph,
    }),
    /unknown field: graph/,
  );
  await assert.rejects(
    ()=>manager.previewSelectedSubagentStructureAdmission({
      initiator:'AGENT',
      parentNodeId:'manager',
      requestedChildren:1,
      policy:{schemaVersion:1,allowAgentCreatedChildren:true,maxDepth:64,maxChildrenPerAgent:1000},
    }),
    /unknown field: policy/,
  );

  const afterSpoof=await manager.previewSelectedSubagentStructureAdmission({
    initiator:'AGENT',
    parentNodeId:'manager',
    requestedChildren:1,
  });
  assert.equal(afterSpoof.reasonCode,'MAX_FANOUT_EXCEEDED');

  const restartedCore=new StorageRepository(chrome);
  const restartedManager=new OrchestrationV2Manager({
    coreRepository:restartedCore,
    chromeApi:chrome,
    now:()=>1000,
  });
  const afterRestart=await restartedManager.previewSelectedSubagentStructureAdmission({
    initiator:'AGENT',
    parentNodeId:'manager',
    requestedChildren:1,
  });
  assert.equal(afterRestart.reasonCode,'MAX_FANOUT_EXCEEDED');
  assert.deepEqual((await restartedManager.getStatus()).orchestra.subagentPolicy,ownerPolicy);

  const exported=await restartedManager.exportProfile('Authority Export');
  assert.deepEqual(exported.subagent_policy,{
    allow_agent_created_children:true,
    max_depth:4,
    max_children_per_agent:2,
  });
  assert.equal((await core.load()).sessionsById instanceof Object,true);
});

test('subagent structural precheck rejects accessor-backed intent without executing getters and grants no spawn authority', async()=>{
  const {manager}=managerFixture();
  const ownerPolicy={
    schemaVersion:1,
    allowAgentCreatedChildren:true,
    maxDepth:4,
    maxChildrenPerAgent:4,
  };
  const profile=exportOrchestrationProfile(cfg('subagent-accessor'),{
    name:'Subagent Accessor',
    hierarchy:subagentAdmissionGraph('subagent-accessor-graph'),
    subagentPolicy:ownerPolicy,
  });
  await manager.importProfile(profile);

  let reads=0;
  const intent={initiator:'AGENT',parentNodeId:'root'};
  Object.defineProperty(intent,'requestedChildren',{
    enumerable:true,
    get(){ reads+=1; return 1; },
  });
  await assert.rejects(
    ()=>manager.previewSelectedSubagentStructureAdmission(intent),
    /enumerable own data properties/,
  );
  assert.equal(reads,0,'precheck must reject accessor intent without invoking the getter');

  const hidden={initiator:'AGENT',parentNodeId:'root'};
  Object.defineProperty(hidden,'requestedChildren',{
    enumerable:false,
    value:1,
  });
  await assert.rejects(
    ()=>manager.previewSelectedSubagentStructureAdmission(hidden),
    /enumerable own data properties/,
  );

  const symbolic={initiator:'AGENT',parentNodeId:'root',requestedChildren:1};
  symbolic[Symbol('authority')]=true;
  await assert.rejects(
    ()=>manager.previewSelectedSubagentStructureAdmission(symbolic),
    /unknown field/,
  );

  const exotic=Object.assign(Object.create({ requestedChildren:1 }),{
    initiator:'AGENT',
    parentNodeId:'root',
    requestedChildren:1,
  });
  await assert.rejects(
    ()=>manager.previewSelectedSubagentStructureAdmission(exotic),
    /plain object/,
  );

  const decision=await manager.previewSelectedSubagentStructureAdmission({
    initiator:'AGENT',
    parentNodeId:'root',
    requestedChildren:1,
  });
  assert.equal(decision.advisoryOnly,true);
  assert.equal(decision.spawnAuthority,false);
  assert.equal(Object.isFrozen(decision),true);
});

test('subagent structural precheck defaults to deny and fails closed without durable hierarchy', async()=>{
  const {manager}=managerFixture();
  await manager.create({name:'Default deny',config:cfg('default-deny')});
  await assert.rejects(
    ()=>manager.previewSelectedSubagentStructureAdmission({
      initiator:'AGENT',
      parentNodeId:'root',
      requestedChildren:1,
    }),
    /durable orchestration hierarchy/,
  );

  await manager.controllerFor('orch-1').configureHierarchy(hierarchyGraph('default-deny-graph'),{nowMs:1000});
  const decision=await manager.previewSelectedSubagentStructureAdmission({
    initiator:'AGENT',
    parentNodeId:'root',
    requestedChildren:1,
  });
  assert.equal(decision.decision,'DENY');
  assert.equal(decision.reasonCode,'AGENT_CHILD_CREATION_DISABLED');
});

test('hierarchy profile import fails closed after the first Start even when the orchestra is owner-paused', async()=>{
  const {manager}=managerFixture();
  const original=exportOrchestrationProfile(cfg('hierarchy-reimport'),{
    name:'Hierarchy Reimport',
    hierarchy:hierarchyGraph('original-profile-graph'),
  });
  const imported=await manager.importProfile(original);
  await manager.start(imported.status.selectedId);
  await manager.pause(imported.status.selectedId);

  const replacement=exportOrchestrationProfile(cfg('hierarchy-reimport'),{
    name:'Hierarchy Replacement',
    hierarchy:hierarchyGraph('replacement-profile-graph'),
  });
  await assert.rejects(
    ()=>manager.importProfile(replacement),
    /before the first Start/,
  );

  const runtime=await manager.controllerFor(imported.status.selectedId).runtimeRepository.load();
  assert.equal(runtime.hierarchy.graph.graphId,'original-profile-graph');
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


test('delete purges only its hierarchy session logs and tab hints across a cold restart', async()=>{
  const {manager,core,chrome}=managerFixture();
  await manager.create({name:'Hierarchy cleanup',config:cfg('cleanup')});
  await manager.create({name:'Other hierarchy',config:cfg('other')});
  await manager.controllerFor('orch-2').configureHierarchy(hierarchyGraph('other-graph'),{nowMs:1000});
  await manager.start('orch-2');
  await manager.emergencyStop('orch-2');
  await manager.controllerFor('orch-1').configureHierarchy({
    schemaVersion:1,
    graphId:'cleanup-graph',
    controlEpoch:1,
    promptProfiles:[
      {id:'director-p',role:'GLOBAL_DIRECTOR',version:1,prompt:'Director prompt'},
    ],
    nodes:[
      {
        id:'director',
        parentId:null,
        childIds:[],
        promptProfileId:'director-p',
        chatMode:'PERSISTENT_CHAT',
        maxActiveChildren:0,
        barrier:{mode:'NONE'},
      },
    ],
  },{nowMs:1000});
  await manager.start('orch-1');

  const before=await core.load();
  const session=Object.values(before.sessionsById).find(s=>s.orchestrationHierarchy?.graphId==='cleanup-graph');
  const other=Object.values(before.sessionsById).find(s=>s.orchestrationHierarchy?.graphId==='other-graph');
  assert.ok(session);
  assert.ok(other);
  await core.update(state=>{
    state.logs[session.id]=[{at:1000,level:'info',message:'managed hierarchy log'}];
    state.logs[other.id]=[{at:1000,level:'info',message:'other hierarchy log'}];
    state.tabHintsByTaskId[session.taskOrder[0]]={
      tabId:77,
      sessionId:session.id,
      normalizedUrl:'https://chatgpt.com/',
      kind:'TASK',
      ownedByExtension:true,
      retirePending:false,
      boundAt:1000,
    };
    state.tabHintsByTaskId[other.taskOrder[0]]={
      tabId:79,sessionId:other.id,normalizedUrl:'https://chatgpt.com/',kind:'TASK',
      ownedByExtension:true,retirePending:false,boundAt:1000,
    };
    return state;
  });

  const restartedCore=new StorageRepository(chrome);
  const restartedManager=new OrchestrationV2Manager({coreRepository:restartedCore,chromeApi:chrome,now:()=>1000});
  assert.equal((await restartedCore.load()).logs[session.id][0].message,'managed hierarchy log');
  await restartedManager.emergencyStop('orch-1');
  await restartedManager.delete('orch-1');
  const after=await restartedCore.load();
  assert.equal(after.sessionsById[session.id],undefined);
  assert.equal(after.logs[session.id],undefined);
  assert.ok(after.sessionsById[other.id]);
  assert.equal(after.logs[other.id][0].message,'other hierarchy log');
  assert.equal(after.tabHintsByTaskId[other.taskOrder[0]].sessionId,other.id);
  assert.equal((await restartedManager.getStatus('orch-2')).config.projectId,'other');
  assert.equal(
    Object.values(after.tabHintsByTaskId||{}).some(hint=>hint?.sessionId===session.id),
    false,
  );
});

test('unresolved external Send prevents deletion and identity rebind without discarding its evidence', async()=>{
  const {manager,core,chrome}=managerFixture();
  await manager.create({name:'Unresolved',config:cfg('unresolved')});
  await manager.controllerFor('orch-1').configureHierarchy(hierarchyGraph('unresolved-graph'),{nowMs:1000});
  await manager.start('orch-1');
  await manager.emergencyStop('orch-1');
  const session=Object.values((await core.load()).sessionsById).find(s=>s.orchestrationHierarchy?.graphId==='unresolved-graph');
  assert.ok(session);
  await core.update(state=>{
    const taskId=session.taskOrder[0];
    state.sessionsById[session.id].operation={
      operationId:'unresolved-send',sessionId:session.id,taskId,promptFingerprint:'sha256:test',
      phase:'AMBIGUOUS',targetUrl:state.sessionsById[session.id].tasksById[taskId].normalizedUrl,
      createdAt:1000,updatedAt:1000,preSendDeadline:0,submitStartedAt:1000,verificationDeadline:60000,
    };
    state.logs[session.id]=[{at:1000,level:'warn',message:'external Send uncertain'}];
    return state;
  });
  await assert.rejects(()=>manager.delete('orch-1'),/unresolved Send/);
  await manager.pause('orch-1');
  await assert.rejects(()=>manager.updateConfig(cfg('replacement'),'orch-1'),/unresolved Send/);
  const after=new StorageRepository(chrome);
  assert.equal((await after.load()).sessionsById[session.id].operation.phase,'AMBIGUOUS');
  assert.equal((await after.load()).logs[session.id][0].message,'external Send uncertain');
  assert.equal((await manager.getStatus('orch-1')).config.projectId,'unresolved');
});

test('owner-paused project identity rebind purges managed session logs and tab hints', async()=>{
  const {manager,core}=managerFixture();
  await manager.create({name:'Hierarchy rebind cleanup',config:cfg('rebind-a')});
  await manager.controllerFor('orch-1').configureHierarchy({
    schemaVersion:1,
    graphId:'rebind-cleanup-graph',
    controlEpoch:1,
    promptProfiles:[
      {id:'director-p',role:'GLOBAL_DIRECTOR',version:1,prompt:'Director prompt'},
    ],
    nodes:[
      {
        id:'director',
        parentId:null,
        childIds:[],
        promptProfileId:'director-p',
        chatMode:'PERSISTENT_CHAT',
        maxActiveChildren:0,
        barrier:{mode:'NONE'},
      },
    ],
  },{nowMs:1000});
  await manager.start('orch-1');
  await manager.pause('orch-1');

  const before=await core.load();
  const session=Object.values(before.sessionsById).find(s=>s.orchestrationHierarchy?.graphId==='rebind-cleanup-graph');
  assert.ok(session);
  await core.update(state=>{
    state.logs[session.id]=[{at:1000,level:'info',message:'managed hierarchy log'}];
    state.tabHintsByTaskId[session.taskOrder[0]]={
      tabId:78,
      sessionId:session.id,
      normalizedUrl:'https://chatgpt.com/',
      kind:'TASK',
      ownedByExtension:true,
      retirePending:false,
      boundAt:1000,
    };
    return state;
  });

  await manager.updateConfig(cfg('rebind-b'),'orch-1');

  const after=await core.load();
  assert.equal(after.sessionsById[session.id],undefined);
  assert.equal(after.logs[session.id],undefined);
  assert.equal(
    Object.values(after.tabHintsByTaskId||{}).some(hint=>hint?.sessionId===session.id),
    false,
  );
});
