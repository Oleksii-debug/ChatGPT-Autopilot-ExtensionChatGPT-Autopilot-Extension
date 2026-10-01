import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../../src/core/browser-agent-manager.js';

const H='1'.repeat(64);

function storage(){
  const data=Object.create(null);
  return {data,chrome:{storage:{local:{
    async get(key){return {[key]:structuredClone(data[key])};},
    async set(record){for(const [key,value] of Object.entries(record))data[key]=structuredClone(value);},
  }},alarms:{async create(){},async clear(){return true;}}}};
}

function manager(chrome){
  return new BrowserAgentManager({chromeApi:chrome,routePrompt:async()=>({text:'{}'}),now:()=>Date.parse('2026-10-01T13:00:00.000Z')});
}

function plan(planId='plan.repair'){
  return {
    schemaVersion:1,planId,jobId:'job.repair',objective:'repair',successCriteria:['verified'],
    createdAt:'2026-10-01T12:00:00.000Z',updatedAt:'2026-10-01T12:01:00.000Z',revision:3,
    nodes:[{
      nodeId:'target',title:'Target',objective:'target',dependsOn:[],conflictKeys:[],
      ownerId:'actor.1',executionPlane:'LOCAL',acceptanceCriteria:[],
      budget:{maxModelCalls:0,maxRuntimeSeconds:0,maxCostUsdMicros:0},
      state:'FAILED',evidence:'',updatedAt:'2026-10-01T12:01:00.000Z',
    }],
  };
}

function cycle(updatedAt='2026-10-01T12:01:20.000Z'){
  return {
    schemaVersion:1,cycleId:'cycle.1',subjectId:'target',actorId:'actor.1',verifierId:'verifier.1',
    verifierPlanRevisionId:'verifier-plan.r1',baselineRevisionId:'2026-10-01T12:01:00.000Z',
    maxAttempts:3,createdAt:'2026-10-01T12:01:10.000Z',updatedAt,
    attempts:[{
      attemptNumber:1,
      failure:{verifierId:'verifier.1',subjectRevisionId:'2026-10-01T12:01:00.000Z',evidenceSha256:H,completedAt:'2026-10-01T12:01:05.000Z'},
      diagnosis:{diagnosisId:'diagnosis.1',producerId:'actor.1',hypothesisCodes:['output.mismatch'],createdAt:'2026-10-01T12:01:20.000Z'},
      repair:null,retest:null,
    }],
  };
}

async function seed(m){
  await m.create({id:'job.repair',goal:'repair'});
  await m.update(store=>{store.byId['job.repair'].runtime.plan=plan();return store;});
}

test('Core: BrowserAgent self-repair cycle survives restart under the same durable plan identity',async()=>{
  const {chrome}=storage();const m=manager(chrome);await seed(m);
  await m.putSelfRepairCycle('job.repair',{expectedPlanRevision:3,expectedCycleUpdatedAt:null,cycle:cycle()});
  const restarted=manager(chrome);
  const state=await restarted.listSelfRepairCycles('job.repair');
  assert.equal(state.planId,'plan.repair');
  assert.equal(state.cycles.length,1);
  assert.equal(state.cycles[0].planId,'plan.repair');
  assert.equal(state.cycles[0].assessment.state,'READY_FOR_REPAIR');
  assert.equal(state.cycles[0].assessment.executionAuthorized,false);
});

test('Core: stale cycle CAS cannot overwrite durable self-repair evidence',async()=>{
  const {chrome}=storage();const m=manager(chrome);await seed(m);
  const initial=cycle();
  await m.putSelfRepairCycle('job.repair',{expectedPlanRevision:3,expectedCycleUpdatedAt:null,cycle:initial});
  await assert.rejects(
    ()=>m.putSelfRepairCycle('job.repair',{
      expectedPlanRevision:3,
      expectedCycleUpdatedAt:'2026-10-01T12:01:19.000Z',
      cycle:cycle('2026-10-01T12:01:30.000Z'),
    }),
    /cycle revision drifted/,
  );
});

test('Core: replacement AgentPlan cannot inherit prior self-repair evidence',async()=>{
  const {data,chrome}=storage();const m=manager(chrome);await seed(m);
  await m.putSelfRepairCycle('job.repair',{expectedPlanRevision:3,expectedCycleUpdatedAt:null,cycle:cycle()});
  const [key]=Object.keys(data);
  data[key].byId['job.repair'].runtime.plan.planId='plan.replacement';
  const restarted=manager(chrome);
  const state=await restarted.listSelfRepairCycles('job.repair');
  assert.equal(state.planId,'plan.replacement');
  assert.equal(state.cycles.length,0);
  assert.equal(state.quarantinedCount,1);
});


test('Core: future self-repair evidence is rejected by the durable owner clock',async()=>{
  const {chrome}=storage();const m=manager(chrome);await seed(m);
  const future=cycle('2026-10-01T13:00:01.000Z');
  future.attempts[0].diagnosis.createdAt='2026-10-01T13:00:01.000Z';
  await assert.rejects(
    ()=>m.putSelfRepairCycle('job.repair',{expectedPlanRevision:3,expectedCycleUpdatedAt:null,cycle:future}),
    /cannot come from the future/,
  );
});
