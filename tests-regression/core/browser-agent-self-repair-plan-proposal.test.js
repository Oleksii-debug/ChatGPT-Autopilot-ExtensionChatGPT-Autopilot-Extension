import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../../src/core/browser-agent-manager.js';

const H='1'.repeat(64);
const storage=()=>{
  const data=Object.create(null);
  return {data,chrome:{storage:{local:{
    async get(key){return {[key]:structuredClone(data[key])};},
    async set(record){for(const [key,value] of Object.entries(record))data[key]=structuredClone(value);},
  }},alarms:{async create(){},async clear(){return true;}}}};
};
const manager=chrome=>new BrowserAgentManager({
  chromeApi:chrome,routePrompt:async()=>{throw new Error('proposal must not route a model');},
  now:()=>Date.parse('2026-10-01T13:00:00.000Z'),
});
const zero=()=>({maxModelCalls:0,maxRuntimeSeconds:0,maxCostUsdMicros:0});
const plan=()=>({
  schemaVersion:1,planId:'plan.repair',jobId:'job.repair',objective:'repair',successCriteria:['verified'],
  createdAt:'2026-10-01T12:00:00.000Z',updatedAt:'2026-10-01T12:01:00.000Z',revision:3,
  nodes:[{nodeId:'target',title:'Target',objective:'Target',dependsOn:[],conflictKeys:['target'],
    ownerId:'actor.1',executionPlane:'LOCAL',acceptanceCriteria:['correct'],budget:zero(),
    state:'FAILED',evidence:'',updatedAt:'2026-10-01T12:01:00.000Z'}],
});
const cycle=()=>({
  schemaVersion:1,cycleId:'cycle.1',subjectId:'target',actorId:'actor.1',verifierId:'verifier.1',
  verifierPlanRevisionId:'verifier-plan.r1',baselineRevisionId:'2026-10-01T12:01:00.000Z',
  maxAttempts:3,createdAt:'2026-10-01T12:01:10.000Z',updatedAt:'2026-10-01T12:01:20.000Z',
  attempts:[{attemptNumber:1,
    failure:{verifierId:'verifier.1',subjectRevisionId:'2026-10-01T12:01:00.000Z',evidenceSha256:H,completedAt:'2026-10-01T12:01:05.000Z'},
    diagnosis:{diagnosisId:'diagnosis.1',producerId:'actor.1',hypothesisCodes:['output.mismatch'],createdAt:'2026-10-01T12:01:20.000Z'},
    repair:null,retest:null}],
});
async function seed(m){
  await m.create({id:'job.repair',goal:'repair'});
  await m.update(store=>{store.byId['job.repair'].runtime.plan=plan();return store;});
  await m.setOwnerResourceBudget({expectedRevision:0,budget:{maxModelCalls:5,maxRuntimeSeconds:60,maxCostUsdMicros:500}});
  await m.putSelfRepairCycle('job.repair',{expectedPlanId:'plan.repair',expectedPlanRevision:3,expectedCycleUpdatedAt:null,cycle:cycle()});
}
const request=()=>({
  cycleId:'cycle.1',expectedPlanId:'plan.repair',expectedPlanRevision:3,
  expectedCycleUpdatedAt:'2026-10-01T12:01:20.000Z',predecessorNodeId:null,
  workNode:{nodeId:'repair.1',title:'Repair',objective:'Repair',conflictKeys:[],executionPlane:'LOCAL',
    acceptanceCriteria:['fixed'],budget:{maxModelCalls:1,maxRuntimeSeconds:10,maxCostUsdMicros:100}},
});

test('Core: self-repair proposal is canonical and storage read-only',async()=>{
  const {data,chrome}=storage();const m=manager(chrome);await seed(m);
  const [key]=Object.keys(data);const before=structuredClone(data[key]);
  const result=await m.proposeSelfRepairWork('job.repair',request());
  assert.equal(result.proposal.workKind,'REPAIR');
  assert.equal(result.proposal.originPlanRevision,3);
  assert.equal(result.proposal.proposedPlan.revision,4);
  assert.equal(result.ownerResourceBudgetRevision,1);
  assert.equal(result.proposal.mutationAuthorized,false);
  assert.deepEqual(data[key],before);
});

test('Core: zero owner budget denies self-repair work proposal',async()=>{
  const {chrome}=storage();const m=manager(chrome);await seed(m);
  await m.setOwnerResourceBudget({expectedRevision:1,budget:{}});
  await assert.rejects(()=>m.proposeSelfRepairWork('job.repair',request()),/exceeds resourceEnvelope maxModelCalls/);
});

test('Core: stale self-repair proposal fences current plan and cycle revisions',async()=>{
  const {chrome}=storage();const m=manager(chrome);await seed(m);
  await assert.rejects(
    ()=>m.proposeSelfRepairWork('job.repair',{...request(),expectedPlanRevision:2}),
    /AgentPlan revision drifted/,
  );
  await assert.rejects(
    ()=>m.proposeSelfRepairWork('job.repair',{...request(),expectedCycleUpdatedAt:'2026-10-01T12:01:19.000Z'}),
    /cycle revision drifted/,
  );
});
