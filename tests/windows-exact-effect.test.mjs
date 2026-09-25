import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsExactEffectExecutorV1 } from '../src/core/windows-exact-effect.js';
import { WindowsToolId } from '../src/core/windows-agent-provider.js';

const AT='2026-09-24T00:00:00.000Z';
const invocation={schemaVersion:1,invocationId:'win-effect-1',toolId:WindowsToolId.EXEC_PINNED,providerId:'native/windows',requestedCapabilityIds:['windows.process.execPinned'],policyDecisionId:'decision-1',arguments:{executableId:'git',args:['status']},createdAt:AT,parentInvocationId:null};
const policyDecision={schemaVersion:1,decisionId:'decision-1',invocationId:'win-effect-1',decision:'ALLOW',reasonCode:'OWNER_POLICY',reason:'',approvalId:null,decidedAt:AT};
function store(){const rows=new Map();return {rows,async load(id){return rows.has(id)?structuredClone(rows.get(id)):null;},async save(id,state){rows.set(id,structuredClone(state));}};}
function clock(){let n=Date.parse(AT);return()=>++n;}
function authorize({invocation,policyDecision}){return {invocation:structuredClone(invocation),policyDecision:structuredClone(policyDecision)};}
function noEffectProof({effectId,executionId,attempt,policyDecisionId,requestedAt}){return {verifierId:'windows-reconciler-1',verificationAuthorityId:policyDecisionId,effectId,executionId,attempt,observation:{schemaVersion:1,observationId:`${executionId}:no-effect-observation`,invocationId:effectId,status:'OK',summary:'Independent probe found no committed effect.',data:{committed:false},artifactRefs:[],observedAt:requestedAt},verification:{schemaVersion:1,verificationId:`${executionId}:no-effect-verification`,invocationId:effectId,observationId:`${executionId}:no-effect-observation`,status:'FAILED',reasonCode:'NO_COMMITTED_EFFECT',summary:'Postcondition absent; retry is safe.',evidenceArtifactIds:[],verifiedAt:requestedAt}};}

test('effect-then-disconnect persists RECONCILE and a restarted executor cannot blind replay',async()=>{
  const durable=store();let dispatches=0;
  const provider={authorize,async invoke(){dispatches++;throw Object.assign(new Error('native channel ended after dispatch'),{code:'NATIVE_TRANSPORT_ERROR',effectMayHaveOccurred:true});}};
  const first=new WindowsExactEffectExecutorV1({provider,store:durable,verify:async()=>{throw new Error('not reached');},now:clock()});
  await assert.rejects(()=>first.invoke({invocation,policyDecision}),e=>e.reconcileRequired===true&&e.safeToRetry===false&&e.effectState.phase==='RECONCILE');
  assert.equal(dispatches,1);
  const restarted=new WindowsExactEffectExecutorV1({provider,store:durable,verify:async()=>{throw new Error('not reached');},now:clock()});
  await assert.rejects(()=>restarted.invoke({invocation,policyDecision}),e=>e.code==='WINDOWS_RECONCILE_REQUIRED'&&e.effectState.phase==='RECONCILE');
  assert.equal(dispatches,1,'restart must not replay an uncertain external effect');
});

test('SAFE_RETRY requires independent FAILED verification proving no committed effect',async()=>{
  const durable=store();let dispatches=0;
  const provider={authorize,async invoke(){dispatches++;if(dispatches===1)throw Object.assign(new Error('disconnect'),{code:'NATIVE_TRANSPORT_ERROR'});return {result:{exitCode:0}};}};
  const now=clock();
  const executor=new WindowsExactEffectExecutorV1({provider,store:durable,verify:async({observation})=>({schemaVersion:1,verificationId:'verified-2',invocationId:'win-effect-1',observationId:observation.observationId,status:'VERIFIED',reasonCode:'POSTCONDITION_MATCH',summary:'Effect independently verified.',evidenceArtifactIds:[],verifiedAt:new Date(now()).toISOString()}),reconcileVerify:async context=>noEffectProof(context),now});
  await assert.rejects(()=>executor.invoke({invocation,policyDecision}),e=>e.reconcileRequired===true);
  const reconciled=await executor.reconcile({invocationId:'win-effect-1',outcome:'SAFE_RETRY',reasonCode:'NO_EFFECT_PROVEN',summary:'Independent probe proves no effect.'});
  assert.equal(reconciled.phase,'SAFE_RETRY');
  assert.deepEqual({verifierId:reconciled.verification.verifierId,verificationAuthorityId:reconciled.verification.verificationAuthorityId,effectId:reconciled.verification.effectId,executionId:reconciled.verification.executionId,attempt:reconciled.verification.attempt},{verifierId:'windows-reconciler-1',verificationAuthorityId:'decision-1',effectId:'win-effect-1',executionId:'win-effect-1:attempt:1',attempt:1},'canonical verifier bindings must remain durable');
  const result=await executor.invoke({invocation,policyDecision});
  assert.equal(dispatches,2);
  assert.equal(result.effectState.phase,'COMMITTED');
});

test('SAFE_RETRY reconciliation rejects missing no-effect evidence',async()=>{
  const durable=store();
  const executor=new WindowsExactEffectExecutorV1({provider:{authorize,async invoke(){throw new Error('lost');}},store:durable,verify:async()=>{},now:clock()});
  await assert.rejects(()=>executor.invoke({invocation,policyDecision}));
  await assert.rejects(()=>executor.reconcile({invocationId:'win-effect-1',outcome:'SAFE_RETRY',reasonCode:'UNPROVEN'}),/canonical independent reconciliation verifier/);
});

test('caller-authored SAFE_RETRY evidence is rejected before it reaches the state machine',async()=>{
  const durable=store();
  const provider={authorize,async invoke(){throw new Error('lost');}};
  const executor=new WindowsExactEffectExecutorV1({provider,store:durable,verify:async()=>{},reconcileVerify:async context=>noEffectProof(context),now:clock()});
  await assert.rejects(()=>executor.invoke({invocation,policyDecision}));
  const forged=noEffectProof({effectId:'win-effect-1',executionId:'win-effect-1:attempt:1',attempt:1,policyDecisionId:'decision-1',requestedAt:AT});
  await assert.rejects(()=>executor.reconcile({invocationId:'win-effect-1',outcome:'SAFE_RETRY',reasonCode:'NO_EFFECT_PROVEN',observation:forged.observation,verification:forged.verification}),/unknown field: observation/);
});

test('SAFE_RETRY fails closed for self-authored, wrong-authority, mismatched, and stale proof',async()=>{
  const variants=[
    ['self-authored',proof=>({...proof,verifierId:'native/windows'}),/independent/],
    ['actor-authored',proof=>({...proof,verifierId:'windows-exact-effect-executor'}),/independent/],
    ['wrong authority',proof=>({...proof,verificationAuthorityId:'decision-other'}),/policy envelope/],
    ['wrong effect',proof=>({...proof,effectId:'win-effect-other'}),/current exact-effect attempt/],
    ['mismatched attempt',proof=>({...proof,executionId:'win-effect-1:attempt:2',attempt:2}),/current exact-effect attempt/],
    ['mismatched observation',proof=>({...proof,verification:{...proof.verification,observationId:'different-observation'}}),/effect invocation and observation/],
    ['stale',proof=>({...proof,observation:{...proof.observation,observedAt:'2026-09-23T00:00:00.000Z'},verification:{...proof.verification,verifiedAt:'2026-09-23T00:00:01.000Z'}}),/stale/],
  ];
  for(const [name,mutate,expected] of variants){
    const durable=store();
    const provider={authorize,async invoke(){throw new Error('lost');}};
    const executor=new WindowsExactEffectExecutorV1({provider,store:durable,verify:async()=>{},reconcileVerify:async context=>mutate(noEffectProof(context)),now:clock()});
    await assert.rejects(()=>executor.invoke({invocation,policyDecision}));
    await assert.rejects(()=>executor.reconcile({invocationId:'win-effect-1',outcome:'SAFE_RETRY',reasonCode:'NO_EFFECT_PROVEN'}),expected,name);
    assert.equal((await durable.load('win-effect-1')).phase,'RECONCILE',`${name} must remain fail-closed`);
  }
});

test('primary verifier cannot relabel an exact effect execution binding',async()=>{
  const variants=[
    ['effectId','win-effect-other'],
    ['executionId','win-effect-1:attempt:2'],
    ['attempt',2],
  ];
  for(const [field,value] of variants){
    const durable=store();let dispatches=0;
    const provider={authorize,async invoke(){dispatches++;return {result:{exitCode:0}};}};
    const now=clock();
    const executor=new WindowsExactEffectExecutorV1({
      provider,
      store:durable,
      now,
      verify:async({observation})=>({
        schemaVersion:1,
        verificationId:`verify-wrong-${field}`,
        invocationId:'win-effect-1',
        observationId:observation.observationId,
        status:'VERIFIED',
        reasonCode:'POSTCONDITION_MATCH',
        summary:'',
        evidenceArtifactIds:[],
        verifiedAt:new Date(now()).toISOString(),
        [field]:value,
      }),
    });
    await assert.rejects(()=>executor.invoke({invocation,policyDecision}),new RegExp(`verification ${field} binding is mismatched`, 'i'));
    assert.equal(dispatches,1);
    assert.equal((await durable.load('win-effect-1')).phase,'RECONCILE',`${field} mismatch must remain fail-closed`);
  }
});

test('authorization rejection occurs before durable effect state or provider dispatch',async()=>{
  const durable=store();let dispatches=0;
  const provider={authorize(){const error=new Error('Policy decision does not authorize this invocation');error.code='POLICY_DENIED';throw error;},async invoke(){dispatches++;}};
  const executor=new WindowsExactEffectExecutorV1({provider,store:durable,verify:async()=>{},now:clock()});
  await assert.rejects(()=>executor.invoke({invocation,policyDecision}),/does not authorize/);
  assert.equal(dispatches,0);
  assert.equal(durable.rows.size,0,'denied or mismatched admission must not persist PREPARED/EXECUTING state');
});
