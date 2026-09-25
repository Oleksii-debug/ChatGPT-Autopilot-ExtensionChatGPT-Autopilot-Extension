import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OrchestrationHierarchyEventType,
  compactOrchestrationEventId,
  createOrchestrationHierarchyRuntime,
  reduceOrchestrationHierarchyEvent,
  validateOrchestrationHierarchyRuntimeV1,
} from '../src/core/orchestration-hierarchy.js';
import { buildThreeLevelHierarchyTemplate } from '../src/core/orchestration-role-prompts.js';

let now = 1_000_000;
let sequence = 0;
const eventId = (prefix, ...parts) => compactOrchestrationEventId(prefix, ...parts, ++sequence);

function reduce(graph, runtime, event) {
  return reduceOrchestrationHierarchyEvent(
    graph,
    runtime,
    { controlEpoch: runtime.controlEpoch, ...event },
    now++,
  );
}

function effect(graph, runtime, action) {
  return reduce(graph, runtime, {
    type: OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,
    eventId: eventId('fx', action.nodeId, action.activationId),
    nodeId: action.nodeId,
    generation: action.generation,
    activationId: action.activationId,
    effectRef: 'test',
  });
}

function terminal(graph, runtime, action) {
  return reduce(graph, runtime, {
    type: OrchestrationHierarchyEventType.NODE_TERMINAL,
    eventId: eventId('terminal', action.nodeId, action.activationId),
    nodeId: action.nodeId,
    generation: action.generation,
    activationId: action.activationId,
    status: 'COMPLETED',
  });
}

test('continuous hierarchy waits for manager subtree reconciliation and starts the next round', () => {
  const graph = buildThreeLevelHierarchyTemplate({
    graphId: 'continuous-regression',
    projectId: 'continuous-regression',
    targetRepository: 'Oleksii-debug/Accessible-Chess',
    controlIssueNumber: 774,
    domains: [{ id: 'a', scope: 'A' }, { id: 'b', scope: 'B' }],
    workersPerManager: 2,
    loopMode: 'CONTINUOUS',
    maxRounds: 0,
  });
  let runtime = createOrchestrationHierarchyRuntime(graph, now++);
  let result = reduce(graph, runtime, {
    type: OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
    eventId: eventId('start'),
    nodeId: 'director',
    generation: 1,
    activationId: 'root:director:g1:r1',
    purpose: 'DELEGATE',
  });
  runtime = result.runtime;
  const root = result.actions.find(action => action.nodeId === 'director');
  assert.ok(root);

  result = effect(graph, runtime, root); runtime = result.runtime;
  result = terminal(graph, runtime, root); runtime = result.runtime;
  const managers = result.actions.filter(action => action.nodeId.startsWith('manager:'));
  assert.equal(managers.length, 2);

  const workersByManager = {};
  for (const manager of managers) {
    result = effect(graph, runtime, manager); runtime = result.runtime;
    result = terminal(graph, runtime, manager); runtime = result.runtime;
    workersByManager[manager.nodeId] = result.actions.filter(action => action.nodeId.startsWith('worker:'));
    assert.equal(workersByManager[manager.nodeId].length, 2);
  }

  let managerAReconcile;
  for (const worker of workersByManager['manager:a']) {
    result = effect(graph, runtime, worker); runtime = result.runtime;
    result = terminal(graph, runtime, worker); runtime = result.runtime;
    managerAReconcile ||= result.actions.find(action => action.nodeId === 'manager:a' && action.purpose === 'RECONCILE');
  }
  assert.ok(managerAReconcile);
  result = effect(graph, runtime, managerAReconcile); runtime = result.runtime;
  result = terminal(graph, runtime, managerAReconcile); runtime = result.runtime;
  assert.equal(result.actions.some(action => action.nodeId === 'director' && action.purpose === 'RECONCILE'), false);

  let managerBReconcile;
  for (const worker of workersByManager['manager:b']) {
    result = effect(graph, runtime, worker); runtime = result.runtime;
    result = terminal(graph, runtime, worker); runtime = result.runtime;
    managerBReconcile ||= result.actions.find(action => action.nodeId === 'manager:b' && action.purpose === 'RECONCILE');
  }
  assert.ok(managerBReconcile);
  result = effect(graph, runtime, managerBReconcile); runtime = result.runtime;
  result = terminal(graph, runtime, managerBReconcile); runtime = result.runtime;
  const directorReconcile = result.actions.find(action => action.nodeId === 'director' && action.purpose === 'RECONCILE');
  assert.ok(directorReconcile);

  result = effect(graph, runtime, directorReconcile); runtime = result.runtime;
  result = terminal(graph, runtime, directorReconcile); runtime = result.runtime;
  const nextRoot = result.actions.find(action => action.nodeId === 'director' && action.purpose === 'DELEGATE');
  assert.ok(nextRoot);
  assert.equal(runtime.nodesById.director.round, 2);
  assert.match(nextRoot.activationId, /r2$/);
});

test('internal hierarchy event ids stay bounded for long Accessible Chess identities', () => {
  const longActivation = 'root:director:g1:r1:child:manager:windows-accessibility:g1:r1:child:worker:windows-accessibility:01:g1:r1';
  const id = compactOrchestrationEventId(
    'core-hierarchy',
    'accessible-chess-hierarchy-31-continuous-v2',
    'worker:windows-accessibility:01',
    longActivation,
    1,
    1720000000000,
    'sha256:' + 'a'.repeat(64),
  );
  assert.ok(id.length <= 180);
  assert.match(id, /^core-hierarchy:[0-9a-f]{16}$/);
});

test('continuous history stays bounded and restart-deterministic beyond every pruning threshold', () => {
  const graph=buildThreeLevelHierarchyTemplate({
    graphId:'continuous-pruning-proof',projectId:'continuous-pruning-proof',targetRepository:'owner/repo',controlIssueNumber:1,
    domains:[{id:'only',scope:'only'}],workersPerManager:1,loopMode:'CONTINUOUS',maxRounds:0,
  });
  let runtime=createOrchestrationHierarchyRuntime(graph,now++);
  const seenEventIds=new Set();
  const apply=(type,action,status='COMPLETED')=>{
    const id=eventId(type==='NODE_EFFECT_CONFIRMED'?'fx':'terminal',action.nodeId,action.activationId);
    assert.equal(seenEventIds.has(id),false,'generated event identity must never collide');
    seenEventIds.add(id);
    const result=reduce(graph,runtime,{type,eventId:id,nodeId:action.nodeId,generation:action.generation,activationId:action.activationId,effectRef:'stress',status});
    runtime=result.runtime;
    return result.actions;
  };
  const firstEvent={type:OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,eventId:eventId('start-pruning'),nodeId:'director',generation:1,activationId:'root:director:g1:r1',purpose:'DELEGATE'};
  seenEventIds.add(firstEvent.eventId);
  const started=reduce(graph,runtime,firstEvent);
  let root=started.actions[0];
  runtime=started.runtime;

  for(let round=1;round<=510;round+=1){
    let actions=apply(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,root);
    actions=apply(OrchestrationHierarchyEventType.NODE_TERMINAL,root);
    const manager=actions.find(action=>action.nodeId==='manager:only');assert.ok(manager);
    apply(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,manager);
    actions=apply(OrchestrationHierarchyEventType.NODE_TERMINAL,manager);
    const worker=actions.find(action=>action.nodeId==='worker:only:01');assert.ok(worker);
    apply(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,worker);
    actions=apply(OrchestrationHierarchyEventType.NODE_TERMINAL,worker);
    const managerReconcile=actions.find(action=>action.nodeId==='manager:only'&&action.purpose==='RECONCILE');assert.ok(managerReconcile);
    apply(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,managerReconcile);
    actions=apply(OrchestrationHierarchyEventType.NODE_TERMINAL,managerReconcile);
    const directorReconcile=actions.find(action=>action.nodeId==='director'&&action.purpose==='RECONCILE');assert.ok(directorReconcile);
    apply(OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,directorReconcile);
    actions=apply(OrchestrationHierarchyEventType.NODE_TERMINAL,directorReconcile);
    root=actions.find(action=>action.nodeId==='director'&&action.purpose==='DELEGATE');assert.ok(root);
    if(round%17===0)runtime=validateOrchestrationHierarchyRuntimeV1(graph,JSON.parse(JSON.stringify(runtime)));
  }

  assert.equal(runtime.nodesById.director.round,511);
  assert.ok(Object.keys(runtime.processedEventIds).length<=5000);
  for(const nodeId of runtime.nodeOrder){
    assert.ok(Object.keys(runtime.nodesById[nodeId].activationLedger).length<=63);
    assert.ok(Object.keys(runtime.nodesById[nodeId].completedBarrierKeys).length<=64);
  }
  const before=JSON.stringify(runtime);
  const replay=reduce(graph,runtime,{...firstEvent,eventId:firstEvent.eventId});
  assert.equal(replay.reason,'STALE_ROUND');
  assert.deepEqual(replay.actions,[]);
  assert.equal(JSON.stringify(replay.runtime),before,'pruned round replay must not mutate durable state');
});
