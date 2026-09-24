import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsExactEffectExecutorV1 } from '../src/core/windows-exact-effect.js';
import { WindowsToolId } from '../src/core/windows-agent-provider.js';

const AT='2026-09-24T00:00:00.000Z';
const invocation={schemaVersion:1,invocationId:'win-effect-1',toolId:WindowsToolId.EXEC_PINNED,providerId:'native/windows',requestedCapabilityIds:['windows.process.execPinned'],policyDecisionId:'decision-1',arguments:{executableId:'git',args:['status']},createdAt:AT,parentInvocationId:null};
const policyDecision={schemaVersion:1,decisionId:'decision-1',invocationId:'win-effect-1',decision:'ALLOW',reasonCode:'OWNER_POLICY',reason:'',approvalId:null,decidedAt:AT};
function store(){const rows=new Map();return {rows,async load(id){return rows.has(id)?structuredClone(rows.get(id)):null;},async save(id,state){rows.set(id,structuredClone(state));}};}
function clock(){let n=Date.parse(AT);return()=>++n;}

test('effect-then-disconnect persists RECONCILE and a restarted executor cannot blind replay',async()=>{
  const durable=store();let dispatches=0;
  const provider={async invoke(){dispatches++;throw Object.assign(new Error('native channel ended after dispatch'),{code:'NATIVE_TRANSPORT_ERROR',effectMayHaveOccurred:true});}};
  const first=new WindowsExactEffectExecutorV1({provider,store:durable,verify:async()=>{throw new Error('not reached');},now:clock()});
  await assert.rejects(()=>first.invoke({invocation,policyDecision}),e=>e.reconcileRequired===true&&e.safeToRetry===false&&e.effectState.phase==='RECONCILE');
  assert.equal(dispatches,1);
  const restarted=new WindowsExactEffectExecutorV1({provider,store:durable,verify:async()=>{throw new Error('not reached');},now:clock()});
  await assert.rejects(()=>restarted.invoke({invocation,policyDecision}),e=>e.code==='WINDOWS_RECONCILE_REQUIRED'&&e.effectState.phase==='RECONCILE');
  assert.equal(dispatches,1,'restart must not replay an uncertain external effect');
});

test('SAFE_RETRY requires independent FAILED verification proving no committed effect',async()=>{
  const durable=store();let dispatches=0;
  const provider={async invoke(){dispatches++;if(dispatches===1)throw Object.assign(new Error('disconnect'),{code:'NATIVE_TRANSPORT_ERROR'});return {result:{exitCode:0}};}};
  const now=clock();
  const executor=new WindowsExactEffectExecutorV1({provider,store:durable,verify:async({observation})=>({schemaVersion:1,verificationId:'verified-2',invocationId:'win-effect-1',observationId:observation.observationId,status:'VERIFIED',reasonCode:'POSTCONDITION_MATCH',summary:'Effect independently verified.',evidenceArtifactIds:[],verifiedAt:new Date(now()).toISOString()}),now});
  await assert.rejects(()=>executor.invoke({invocation,policyDecision}),e=>e.reconcileRequired===true);
  const obs={schemaVersion:1,observationId:'no-effect-obs',invocationId:'win-effect-1',status:'OK',summary:'Independent probe found no committed effect.',data:{committed:false},artifactRefs:[],observedAt:new Date(now()).toISOString()};
  const proof={schemaVersion:1,verificationId:'no-effect-proof',invocationId:'win-effect-1',observationId:'no-effect-obs',status:'FAILED',reasonCode:'NO_COMMITTED_EFFECT',summary:'Postcondition absent; retry is safe.',evidenceArtifactIds:[],verifiedAt:new Date(now()).toISOString()};
  const reconciled=await executor.reconcile({invocationId:'win-effect-1',outcome:'SAFE_RETRY',observation:obs,verification:proof,reasonCode:'NO_EFFECT_PROVEN',summary:'Independent probe proves no effect.'});
  assert.equal(reconciled.phase,'SAFE_RETRY');
  const result=await executor.invoke({invocation,policyDecision});
  assert.equal(dispatches,2);
  assert.equal(result.effectState.phase,'COMMITTED');
});

test('SAFE_RETRY reconciliation rejects missing no-effect evidence',async()=>{
  const durable=store();
  const executor=new WindowsExactEffectExecutorV1({provider:{async invoke(){throw new Error('lost');}},store:durable,verify:async()=>{},now:clock()});
  await assert.rejects(()=>executor.invoke({invocation,policyDecision}));
  await assert.rejects(()=>executor.reconcile({invocationId:'win-effect-1',outcome:'SAFE_RETRY',reasonCode:'UNPROVEN'}),/requires observation and failed verification evidence/);
});
