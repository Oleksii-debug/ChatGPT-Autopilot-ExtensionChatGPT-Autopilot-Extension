import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';

const H='1'.repeat(64);

function storage(){
  const data=Object.create(null);
  return {data,chrome:{storage:{local:{
    async get(key){return {[key]:structuredClone(data[key])};},
    async set(record){for(const [key,value] of Object.entries(record))data[key]=structuredClone(value);},
  }},alarms:{async create(){},async clear(){return true;}}}};
}

function manager(chrome,{onRoute=()=>{}}={}){
  return new BrowserAgentManager({
    chromeApi:chrome,
    routePrompt:async()=>{onRoute();return {text:'{}'};},
    now:()=>Date.parse('2026-10-01T13:00:00.000Z'),
  });
}

function budget(overrides={}){
  return {maxModelCalls:0,maxRuntimeSeconds:0,maxCostUsdMicros:0,...overrides};
}

function plan(overrides={}){
  return {
    schemaVersion:1,
    planId:'plan.repair',
    jobId:'job.repair',
    objective:'Produce verified result',
    successCriteria:['verified'],
    createdAt:'2026-10-01T12:00:00.000Z',
    updatedAt:'2026-10-01T12:01:00.000Z',
    revision:3,
    nodes:[{
      nodeId:'target',title:'Target',objective:'Produce target',dependsOn:[],conflictKeys:['artifact.target'],
      ownerId:'actor.1',executionPlane:'LOCAL',acceptanceCriteria:['correct'],budget:budget(),
      state:'FAILED',evidence:'',updatedAt:'2026-10-01T12:01:00.000Z',
    }],
    ...overrides,
  };
}

function cycle(){
  return {
    schemaVersion:1,cycleId:'cycle.1',subjectId:'target',actorId:'actor.1',verifierId:'verifier.1',
    verifierPlanRevisionId:'verifier-plan.r1',baselineRevisionId:'2026-10-01T12:01:00.000Z',
    maxAttempts:3,createdAt:'2026-10-01T12:01:10.000Z',updatedAt:'2026-10-01T12:01:20.000Z',
    attempts:[{
      attemptNumber:1,
      failure:{verifierId:'verifier.1',subjectRevisionId:'2026-10-01T12:01:00.000Z',evidenceSha256:H,completedAt:'2026-10-01T12:01:05.000Z'},
      diagnosis:{diagnosisId:'diagnosis.1',producerId:'actor.1',hypothesisCodes:['output.mismatch'],createdAt:'2026-10-01T12:01:20.000Z'},
      repair:null,retest:null,
    }],
  };
}

function workNode(){
  return {
    nodeId:'repair.1',
    title:'Repair failed output',
    objective:'Repair failed output',
    conflictKeys:['repair'],
    executionPlane:'LOCAL',
    acceptanceCriteria:['repair materialized'],
    budget:budget({maxModelCalls:1,maxRuntimeSeconds:10,maxCostUsdMicros:100}),
  };
}

async function seed(m){
  await m.create({id:'job.repair',goal:'repair'});
  await m.update(store=>{store.byId['job.repair'].runtime.plan=plan();return store;});
  await m.setOwnerResourceBudget({
    expectedRevision:0,
    budget:{maxModelCalls:10,maxRuntimeSeconds:100,maxCostUsdMicros:1000},
  });
  await m.putSelfRepairCycle('job.repair',{
    expectedPlanId:'plan.repair',
    expectedPlanRevision:3,
    expectedCycleUpdatedAt:null,
    cycle:cycle(),
  });
}

function request(overrides={}){
  return {
    cycleId:'cycle.1',
    expectedPlanId:'plan.repair',
    expectedPlanRevision:3,
    expectedCycleUpdatedAt:'2026-10-01T12:01:20.000Z',
    workNode:workNode(),
    predecessorNodeId:null,
    ...overrides,
  };
}

test('durable BrowserAgent materializes canonical self-repair work without mutation or model I/O',async()=>{
  const {data,chrome}=storage();let routes=0;
  const m=manager(chrome,{onRoute:()=>{routes+=1;}});
  await seed(m);
  const [key]=Object.keys(data);
  const before=structuredClone(data[key]);

  const result=await m.proposeSelfRepairWork('job.repair',request());
  assert.equal(result.ownerResourceBudgetRevision,1);
  assert.equal(result.budgetReserved,false);
  assert.equal(result.requiresCanonicalBudgetReservation,true);
  assert.deepEqual(result.resourceEnvelope,{maxModelCalls:10,maxRuntimeSeconds:100,maxCostUsdMicros:1000});
  assert.equal(result.planRevision,3);
  assert.equal(result.cycleUpdatedAt,'2026-10-01T12:01:20.000Z');
  assert.equal(result.proposal.workKind,'REPAIR');
  assert.equal(result.proposal.originPlanRevision,3);
  assert.equal(result.proposal.currentPlanRevision,3);
  assert.equal(result.proposal.extensionNode.ownerId,'actor.1');
  assert.equal(result.proposal.executionAuthorized,false);
  assert.equal(result.proposal.mutationAuthorized,false);
  assert.equal(result.proposal.verificationAuthorized,false);
  assert.equal(result.proposal.completionAuthorized,false);
  assert.equal(result.proposal.proposedPlan.revision,4);
  assert.equal(routes,0);
  assert.deepEqual(data[key],before,'read-only proposal must not persist proposed plan or any other storage change');
});

test('proposal survives restart and preserves original plan provenance after unrelated plan growth',async()=>{
  const {chrome}=storage();const m=manager(chrome);await seed(m);
  await m.update(store=>{
    const current=structuredClone(store.byId['job.repair'].runtime.plan);
    current.revision=4;
    current.updatedAt='2026-10-01T12:02:00.000Z';
    current.nodes.push({
      nodeId:'unrelated',title:'Unrelated',objective:'Continue unrelated work',dependsOn:[],conflictKeys:[],
      ownerId:'actor.2',executionPlane:'LOCAL',acceptanceCriteria:[],budget:budget(),
      state:'READY',evidence:'',updatedAt:'2026-10-01T12:02:00.000Z',
    });
    store.byId['job.repair'].runtime.plan=current;
    return store;
  });

  const restarted=manager(chrome);
  const result=await restarted.proposeSelfRepairWork('job.repair',request({expectedPlanRevision:4}));
  assert.equal(result.proposal.originPlanRevision,3);
  assert.equal(result.proposal.currentPlanRevision,4);
  assert.equal(result.proposal.proposedPlan.revision,5);
});

test('proposal fails closed on stale plan identity, revision or cycle revision',async()=>{
  const {chrome}=storage();const m=manager(chrome);await seed(m);
  await assert.rejects(
    ()=>m.proposeSelfRepairWork('job.repair',request({expectedPlanId:'plan.stale'})),
    /AgentPlan identity drifted/,
  );
  await assert.rejects(
    ()=>m.proposeSelfRepairWork('job.repair',request({expectedPlanRevision:2})),
    /AgentPlan revision drifted/,
  );
  await assert.rejects(
    ()=>m.proposeSelfRepairWork('job.repair',request({expectedCycleUpdatedAt:'2026-10-01T12:01:19.000Z'})),
    /cycle revision drifted/,
  );
});

test('proposal is bounded only by current canonical owner ResourceBudget',async()=>{
  const {chrome}=storage();const m=manager(chrome);await seed(m);
  await m.setOwnerResourceBudget({
    expectedRevision:1,
    budget:{maxModelCalls:0,maxRuntimeSeconds:0,maxCostUsdMicros:0},
  });
  await assert.rejects(
    ()=>m.proposeSelfRepairWork('job.repair',request()),
    /exceeds resourceEnvelope maxModelCalls/,
  );
});

test('quarantined owner ResourceBudget cannot bound a self-repair proposal',async()=>{
  const {data,chrome}=storage();const m=manager(chrome);await seed(m);
  const [key]=Object.keys(data);
  data[key].ownerResourceBudgetQuarantined=true;
  await assert.rejects(
    ()=>manager(chrome).proposeSelfRepairWork('job.repair',request()),
    /resource budget is quarantined/,
  );
});

test('proposal request accessors fail without getter execution',async()=>{
  const {chrome}=storage();const m=manager(chrome);await seed(m);
  let reads=0;
  const hostile=request();
  Object.defineProperty(hostile,'workNode',{
    enumerable:true,
    get(){reads+=1;return workNode();},
  });
  await assert.rejects(
    ()=>m.proposeSelfRepairWork('job.repair',hostile),
    /enumerable data property/,
  );
  assert.equal(reads,0);
});
