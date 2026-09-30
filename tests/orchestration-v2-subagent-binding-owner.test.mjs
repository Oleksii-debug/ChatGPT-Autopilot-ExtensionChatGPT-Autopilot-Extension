import test from 'node:test';
import assert from 'node:assert/strict';

import { StorageRepository } from '../src/core/storage.js';
import { OrchestrationV2Manager } from '../src/core/orchestration-v2-manager.js';
import {
  AgentExecutionPlane,
  AgentPlanNodeState,
  normalizeAgentPlanV1,
} from '../src/core/agent-plan.js';
import { createOutcomeContractV1 } from '../src/core/outcome-contract.js';
import {
  OrchestrationActivationPurpose,
  OrchestrationBarrierMode,
  OrchestrationChatMode,
  OrchestrationHierarchyEventType,
  createOrchestrationHierarchyRuntime,
  reduceOrchestrationHierarchyEvent,
  validateOrchestrationGraphV1,
} from '../src/core/orchestration-hierarchy.js';
import {
  createSubagentTaskEnvelopeV1,
  deriveSubagentTaskDispatchIdentityV1,
} from '../src/core/subagent-task-envelope.js';
import { deriveSubagentAuthorityEnvelopeIdentityV1 } from '../src/core/subagent-authority-envelope.js';
import { createSubagentResultEnvelopeV1 } from '../src/core/subagent-result-envelope.js';
import {
  ObservationStatus,
  VerificationStatus,
} from '../src/core/universal-agent-contracts.js';

const T0='2026-09-29T04:00:00.000Z';
const T1='2026-09-29T04:01:00.000Z';
const T2='2026-09-29T04:02:00.000Z';
const T3='2026-09-29T04:03:00.000Z';
const T4='2026-09-29T04:04:00.000Z';
const T5='2026-09-29T04:05:00.000Z';
const T6='2026-09-29T04:06:00.000Z';

function chromeFake(){
  const data={};
  return {
    data,
    storage:{local:{
      async get(key){
        if(Array.isArray(key)) return Object.fromEntries(key.map(k=>[k,structuredClone(data[k])]));
        return { [key]:structuredClone(data[key]) };
      },
      async set(record){ Object.assign(data,structuredClone(record)); },
      async remove(keys){ for(const key of Array.isArray(keys)?keys:[keys]) delete data[key]; },
    }},
    alarms:{async create(){},async clear(){return true;}},
  };
}
function config(projectId='project-1'){
  return {
    enabled:false,projectId,targetRepository:'owner/repo',controlRepository:'owner/repo',
    controlIssueNumber:1,masterCoordinatorPrompt:'master',defaultDesiredWorkers:1,absoluteMaxWorkers:2,
  };
}
function graph(){
  return validateOrchestrationGraphV1({
    schemaVersion:1,graphId:'binding-owner-graph',controlEpoch:7,
    loopPolicy:{mode:'ONE_SHOT',maxRounds:0},
    promptProfiles:[
      {id:'parent-profile',role:'PARENT',version:1,prompt:'parent'},
      {id:'child-profile',role:'CHILD',version:1,prompt:'child'},
    ],
    nodes:[
      {
        id:'parent-1',parentId:null,childIds:['child-1'],promptProfileId:'parent-profile',
        chatMode:OrchestrationChatMode.PERSISTENT_CHAT,maxActiveChildren:1,
        barrier:{mode:OrchestrationBarrierMode.ALL_DIRECT_CHILDREN,childIds:['child-1']},
      },
      {
        id:'child-1',parentId:'parent-1',childIds:[],promptProfileId:'child-profile',
        chatMode:OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,maxActiveChildren:0,
        barrier:{mode:OrchestrationBarrierMode.NONE,childIds:[]},
      },
    ],
  });
}
function authorityEnvelope(projectId='project-1'){
  return {
    schemaVersion:1,decision:'ALLOW',reasonCode:'LEAST_AUTHORITY_DERIVED',
    projectId,parentAgentId:'parent-1',childAgentId:'child-1',taskId:'task-1',
    providerId:'provider.main',capabilityIds:[],sourceIds:[],artifactIds:[],
    toolIds:[],toolDescriptors:[],executionAuthority:false,credentialAuthority:false,policyAuthority:false,
  };
}
function contract(projectId='project-1'){
  return createOutcomeContractV1({
    contractId:'outcome-1',projectId,desiredResult:'Return one verified result.',
    completionCriteria:[{
      criterionId:'criterion-1',description:'Result complete.',observable:'Artifact exists.',
      requiredEvidenceKinds:['ARTIFACT'],
    }],
    constraints:[],sourceTruth:[{
      sourceId:'source-main',location:'github://owner/repo/main',revisionId:'main-exact',
      purpose:'Canonical implementation truth.',
    }],allowedAuthority:[],
    budgetBoundaries:{
      maxModelCalls:2,maxRuntimeSeconds:60,maxCostUsdMicros:100,maxConcurrency:1,
      enforcementAuthority:'NONE',
    },
    deliverables:[{
      deliverableId:'deliverable-1',kind:'ARTIFACT',description:'Result.',criterionIds:['criterion-1'],
    }],
    verifierPlan:{
      planId:'verify-plan-1',actorId:'child-1',verifierId:'verifier-1',
      criterionIds:['criterion-1'],requiredEvidenceArtifactCount:1,independent:true,
      verificationAuthority:'EXTERNAL_REQUIRED',
    },
    triggerRefs:[],createdAt:T0,
  });
}
function taskEnvelope(projectId='project-1'){
  const plan=normalizeAgentPlanV1({
    schemaVersion:1,planId:'plan-1',jobId:'job-1',objective:'Parent objective.',
    successCriteria:['Done'],
    nodes:[{
      nodeId:'task-1',title:'Child task',objective:'Produce result.',dependsOn:[],
      conflictKeys:['artifact:result'],ownerId:'child-1',executionPlane:AgentExecutionPlane.CLOUD,
      acceptanceCriteria:['Done'],budget:{maxModelCalls:2,maxRuntimeSeconds:60,maxCostUsdMicros:100},
      state:AgentPlanNodeState.READY,evidence:'',updatedAt:T1,
    }],
    createdAt:T0,updatedAt:T1,revision:3,
  });
  return createSubagentTaskEnvelopeV1({
    envelopeId:'envelope-1',projectId,parentAgentId:'parent-1',childAgentId:'child-1',
    authorityEnvelopeIdentity:deriveSubagentAuthorityEnvelopeIdentityV1(authorityEnvelope(projectId)),
    plan,nodeId:'task-1',inputSourceIds:[],inputArtifactRefs:[],
    outcomeContract:contract(projectId),createdAt:T1,
  });
}
function resultArtifact(artifactId, {
  sha256='a'.repeat(64),
  createdAt=T3,
  producerInvocationId='invocation-child-1',
  kind='ARTIFACT',
}={}){
  return {
    schemaVersion:1,artifactId,kind,uri:'artifact://'+artifactId,mediaType:'text/plain',
    sha256,sizeBytes:12,createdAt,producerInvocationId,sensitive:false,
  };
}
function terminalResult(task=taskEnvelope()){
  const verification={
    schemaVersion:1,verificationId:'verification-1',invocationId:'invocation-child-1',
    observationId:'observation-1',status:VerificationStatus.VERIFIED,
    reasonCode:'INDEPENDENT_CHECK_PASS',summary:'Independent verifier confirmed result.',
    evidenceArtifactIds:['evidence-1'],verifiedAt:T4,verifierId:'verifier-1',
    verificationAuthorityId:'verification-authority-1',effectId:null,executionId:null,attempt:1,
  };
  const evidence=resultArtifact('evidence-1',{
    sha256:'3'.repeat(64),createdAt:T4,producerInvocationId:'invocation-verifier-1',
  });
  const result=createSubagentResultEnvelopeV1({
    resultId:'result-1',taskEnvelope:task,
    observation:{
      schemaVersion:1,observationId:'observation-1',invocationId:'invocation-child-1',
      status:ObservationStatus.OK,summary:'Child produced result.',data:{},
      artifactRefs:[resultArtifact('result-1',{sha256:'2'.repeat(64)})],observedAt:T3,
    },
    verification,evidenceArtifactRefs:[evidence],completedAt:T5,
  });
  const outcomeContract=contract();
  const criterion=outcomeContract.completionCriteria[0];
  const trustedRecord={
    schemaVersion:1,recordId:'trusted-record-1',contractId:outcomeContract.contractId,
    contractRevision:outcomeContract.revision,verifierPlanId:outcomeContract.verifierPlan.planId,
    criterion:{
      criterionId:criterion.criterionId,description:criterion.description,
      observable:criterion.observable,requiredEvidenceKinds:[...criterion.requiredEvidenceKinds],
    },
    verifierId:'verifier-1',verificationAuthorityId:'verification-authority-1',
    verification,evidenceArtifacts:[evidence],recordedAt:T5,
    validThrough:'2026-09-29T05:00:00.000Z',
  };
  return {result,outcomeContract,trustedRecord,verification};
}
async function fixture({
  resolveTrustedOutcomeContract=null,
  resolveTrustedVerificationRecord=null,
}={}){
  const chrome=chromeFake();
  const core=new StorageRepository(chrome);
  let nowMs=Date.parse(T2);
  const manager=new OrchestrationV2Manager({
    coreRepository:core,chromeApi:chrome,createId:()=> 'orch-1',now:()=>nowMs,
    resolveTrustedOutcomeContract,
    resolveTrustedVerificationRecord,
  });
  await manager.create({name:'Bindings',config:config()});
  const g=graph();
  const canonicalTaskEnvelope=taskEnvelope();
  const initial=createOrchestrationHierarchyRuntime(g,Date.parse(T0));
  const prepared=reduceOrchestrationHierarchyEvent(
    g,initial,{
      type:OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
      eventId:'activate-child',controlEpoch:7,nodeId:'child-1',generation:1,
      activationId:'child-activation-1',purpose:OrchestrationActivationPurpose.WORK,
      providerDispatchIdentity:deriveSubagentTaskDispatchIdentityV1(canonicalTaskEnvelope),
    },Date.parse(T1),
  );
  await manager.controllerFor('orch-1').runtimeRepository.update(runtime=>{
    runtime.hierarchy={schemaVersion:1,graph:g,state:prepared.runtime};
    return runtime;
  });
  return {chrome,core,manager,g,prepared,canonicalTaskEnvelope,setNow:value=>{nowMs=value;}};
}

test('orchestration owner derives and persists activation binding from latest durable hierarchy',async()=>{
  const {chrome,core,manager,prepared,canonicalTaskEnvelope,setNow}=await fixture();
  const request={
    taskEnvelope:canonicalTaskEnvelope,activationAction:prepared.actions[0],invocationId:'invocation-child-1',authorityEnvelope:authorityEnvelope(),
  };
  const first=await manager.registerSubagentTaskActivationBinding(request,'orch-1');
  assert.equal(first.revision,1);
  assert.equal(first.binding.projectId,'project-1');
  assert.equal(first.binding.childAgentId,'child-1');
  assert.equal(first.binding.activationId,'child-activation-1');
  assert.equal(first.binding.boundAt,T2);
  assert.equal(
    chrome.data['autopilotOrchestrationV2Runtime:orch-1']
      .subagentTaskActivationBindingRegistry.records[0].registeredAt,
    T2,
  );

  setNow(Date.parse(T2)+60_000);
  const replay=await manager.registerSubagentTaskActivationBinding(structuredClone(request),'orch-1');
  assert.equal(replay.revision,1);
  assert.equal(replay.binding.boundAt,T2);

  const restarted=new OrchestrationV2Manager({
    coreRepository:core,chromeApi:chrome,createId:()=> 'unused',now:()=>Date.parse(T2)+120_000,
  });
  assert.deepEqual(
    await restarted.resolveSubagentTaskActivationBinding({bindingId:first.binding.bindingId},'orch-1'),
    first.binding,
  );

  const substituted=structuredClone(canonicalTaskEnvelope);
  substituted.objective += ' restart substitution';
  await assert.rejects(
    ()=>restarted.registerSubagentTaskActivationBinding({
      ...request,
      taskEnvelope:substituted,
    },'orch-1'),
    /dispatch identity does not match task envelope/u,
  );
  assert.equal(
    chrome.data['autopilotOrchestrationV2Runtime:orch-1']
      .subagentTaskActivationBindingRegistry.revision,
    1,
  );
});

test('recovery binding inherits exact durable WORK task identity and rejects caller task drift',async()=>{
  const {chrome,manager,g,prepared,canonicalTaskEnvelope,setNow}=await fixture();
  const workRequest={
    taskEnvelope:canonicalTaskEnvelope,
    activationAction:prepared.actions[0],
    invocationId:'invocation-child-1',authorityEnvelope:authorityEnvelope(),
  };
  const work=await manager.registerSubagentTaskActivationBinding(workRequest,'orch-1');
  assert.equal(work.revision,1);

  const confirmed=reduceOrchestrationHierarchyEvent(
    g,prepared.runtime,{
      type:OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,
      eventId:'confirm-child-before-recovery',controlEpoch:7,nodeId:'child-1',generation:1,
      activationId:'child-activation-1',effectRef:'effect://child-1',
    },Date.parse(T2)+1,
  );
  const recovered=reduceOrchestrationHierarchyEvent(
    g,confirmed.runtime,{
      type:OrchestrationHierarchyEventType.GENERATION_RECOVERY_REQUESTED,
      eventId:'recover-child',controlEpoch:7,nodeId:'child-1',generation:1,newGeneration:2,
      activationId:'child-recovery-2',
    },Date.parse(T2)+2,
  );
  const recoveryAction=recovered.actions.find(action => (
    action.activationId==='child-recovery-2'
    && action.purpose===OrchestrationActivationPurpose.RECOVERY
  ));
  assert.ok(recoveryAction);
  assert.equal(recoveryAction.providerDispatchIdentity,'');
  await manager.controllerFor('orch-1').runtimeRepository.update(runtime=>{
    runtime.hierarchy={schemaVersion:1,graph:g,state:recovered.runtime};
    return runtime;
  });
  setNow(Date.parse(T2)+3);

  const substituted=structuredClone(canonicalTaskEnvelope);
  substituted.objective += ' recovery drift';
  await assert.rejects(
    ()=>manager.registerSubagentTaskActivationBinding({
      taskEnvelope:substituted,
      activationAction:recoveryAction,
      invocationId:'invocation-recovery-2',authorityEnvelope:authorityEnvelope(),
    },'orch-1'),
    /requires prior durable WORK task dispatch identity/u,
  );
  assert.equal(
    chrome.data['autopilotOrchestrationV2Runtime:orch-1']
      .subagentTaskActivationBindingRegistry.revision,
    1,
  );

  const recovery=await manager.registerSubagentTaskActivationBinding({
    taskEnvelope:canonicalTaskEnvelope,
    activationAction:recoveryAction,
    invocationId:'invocation-recovery-2',authorityEnvelope:authorityEnvelope(),
  },'orch-1');
  assert.equal(recovery.revision,2);
  assert.equal(recovery.binding.activationPurpose,OrchestrationActivationPurpose.RECOVERY);
  assert.equal(recovery.binding.taskDispatchIdentity,work.binding.taskDispatchIdentity);
});

test('binding owner rejects forged activation, cross-project task and caller authority fields without mutation',async()=>{
  const {chrome,manager,prepared}=await fixture();
  const base={
    taskEnvelope:taskEnvelope(),activationAction:prepared.actions[0],invocationId:'invocation-child-1',authorityEnvelope:authorityEnvelope(),
  };
  const before=structuredClone(chrome.data['autopilotOrchestrationV2Runtime:orch-1']);

  await assert.rejects(
    ()=>manager.registerSubagentTaskActivationBinding({
      ...base,activationAction:{...prepared.actions[0],activationId:'forged'},
    },'orch-1'),
    /not the current canonical activation/u,
  );
  assert.deepEqual(chrome.data['autopilotOrchestrationV2Runtime:orch-1'],before);

  await assert.rejects(
    ()=>manager.registerSubagentTaskActivationBinding({...base,taskEnvelope:taskEnvelope('other-project')},'orch-1'),
    /authority envelope does not match task identity|dispatch identity does not match task envelope|project does not match orchestra owner project/u,
  );
  const substituted=structuredClone(taskEnvelope());
  substituted.objective += ' Caller semantic substitution.';
  await assert.rejects(
    ()=>manager.registerSubagentTaskActivationBinding({...base,taskEnvelope:substituted},'orch-1'),
    /dispatch identity does not match task envelope/u,
  );
  await assert.rejects(
    ()=>manager.registerSubagentTaskActivationBinding({...base,graph:graph()},'orch-1'),
    /unknown field: graph/u,
  );
  await assert.rejects(
    ()=>manager.registerSubagentTaskActivationBinding({...base,boundAt:T0},'orch-1'),
    /unknown field: boundAt/u,
  );

  let reads=0;
  const malicious=structuredClone(base);
  Object.defineProperty(malicious.activationAction,'activationId',{
    enumerable:true,get(){reads+=1;return 'child-activation-1';},
  });
  await assert.rejects(
    ()=>manager.registerSubagentTaskActivationBinding(malicious,'orch-1'),
    /enumerable own data property/u,
  );
  assert.equal(reads,0);
  assert.deepEqual(chrome.data['autopilotOrchestrationV2Runtime:orch-1'],before);
});


test('orchestration owner refuses activation bindings without an authority-bound task fingerprint', async () => {
  const { manager, prepared, canonicalTaskEnvelope } = await fixture();
  const unbound = structuredClone(canonicalTaskEnvelope);
  delete unbound.authorityEnvelopeIdentity;
  await assert.rejects(
    () => manager.registerSubagentTaskActivationBinding({
      taskEnvelope: unbound,
      activationAction: prepared.actions[0],
      invocationId: 'invocation-unbound',
      authorityEnvelope: authorityEnvelope(),
    }, 'orch-1'),
    /requires task-bound authority envelope identity/u,
  );
});


test('registration requires durable authority provenance before owner-state mutation', async () => {
  const { chrome, manager, prepared, canonicalTaskEnvelope } = await fixture();
  const before = structuredClone(chrome.data['autopilotOrchestrationV2Runtime:orch-1']);
  await assert.rejects(
    () => manager.registerSubagentTaskActivationBinding({
      taskEnvelope: canonicalTaskEnvelope,
      activationAction: prepared.actions[0],
      invocationId: 'invocation-no-authority',
    }, 'orch-1'),
    /missing field: authorityEnvelope/u,
  );
  assert.deepEqual(chrome.data['autopilotOrchestrationV2Runtime:orch-1'], before);
});

test('registration rejects authority-envelope identity substitution before owner-state mutation', async () => {
  const { chrome, manager, prepared, canonicalTaskEnvelope } = await fixture();
  const before = structuredClone(chrome.data['autopilotOrchestrationV2Runtime:orch-1']);
  const substituted = authorityEnvelope();
  substituted.providerId = 'provider.other';
  await assert.rejects(
    () => manager.registerSubagentTaskActivationBinding({
      taskEnvelope: canonicalTaskEnvelope,
      activationAction: prepared.actions[0],
      invocationId: 'invocation-provider-substitution',
      authorityEnvelope: substituted,
    }, 'orch-1'),
    /authority envelope does not match task identity/u,
  );
  assert.deepEqual(chrome.data['autopilotOrchestrationV2Runtime:orch-1'], before);
});


test('owner reconciliation commits trusted child result through canonical reducer and survives manager restart', async () => {
  const preparedResult=terminalResult();
  const resolveTrustedOutcomeContract=async lookup=>(
    lookup.contractId===preparedResult.outcomeContract.contractId
    && lookup.contractRevision===preparedResult.outcomeContract.revision
      ? preparedResult.outcomeContract:null
  );
  const resolveTrustedVerificationRecord=async lookup=>(
    lookup.verificationId===preparedResult.verification.verificationId
      ? preparedResult.trustedRecord:null
  );
  const {chrome,core,manager,g,prepared,canonicalTaskEnvelope,setNow}=await fixture({
    resolveTrustedOutcomeContract,resolveTrustedVerificationRecord,
  });
  const registration=await manager.registerSubagentTaskActivationBinding({
    taskEnvelope:canonicalTaskEnvelope,activationAction:prepared.actions[0],
    invocationId:'invocation-child-1',authorityEnvelope:authorityEnvelope(),
  },'orch-1');

  const confirmed=reduceOrchestrationHierarchyEvent(
    g,prepared.runtime,{
      type:OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,
      eventId:'confirm-child-result',controlEpoch:7,nodeId:'child-1',generation:1,
      activationId:'child-activation-1',effectRef:'effect://child-result',
    },Date.parse(T2)+1,
  );
  await manager.controllerFor('orch-1').runtimeRepository.update(runtime=>{
    runtime.hierarchy={schemaVersion:1,graph:g,state:confirmed.runtime};
    return runtime;
  });
  setNow(Date.parse(T6));

  const restarted=new OrchestrationV2Manager({
    coreRepository:core,chromeApi:chrome,createId:()=> 'unused',now:()=>Date.parse(T6),
    resolveTrustedOutcomeContract,resolveTrustedVerificationRecord,
  });
  const committed=await restarted.reconcileDurableSubagentResult({
    resultEnvelope:preparedResult.result,
    outcomeContract:preparedResult.outcomeContract,
    criterionVerifications:[{criterionId:'criterion-1',verificationId:'verification-1'}],
    taskActivationBindingId:registration.binding.bindingId,
  },'orch-1');

  assert.equal(committed.committed,true);
  assert.equal(committed.terminalStatus,'COMPLETED');
  assert.equal(committed.reconciliation.decision,'ADMIT_TERMINAL');
  assert.equal(
    committed.dispatch.actions.some(action=>(
      action.type==='SEND_RECONCILIATION_PROMPT'&&action.nodeId==='parent-1'
    )),
    true,
  );
  const durable=chrome.data['autopilotOrchestrationV2Runtime:orch-1'];
  assert.equal(
    durable.hierarchy.state.nodesById['child-1'].activationLedger['child-activation-1'].phase,
    'TERMINAL',
  );
  assert.equal(
    durable.hierarchy.state.nodesById['child-1'].activationLedger['child-activation-1'].terminalStatus,
    'COMPLETED',
  );
});

test('owner reconciliation WAIT never dispatches or mutates a prepared child activation', async () => {
  const preparedResult=terminalResult();
  const {chrome,manager,prepared,canonicalTaskEnvelope,setNow}=await fixture({
    resolveTrustedOutcomeContract:async()=>preparedResult.outcomeContract,
    resolveTrustedVerificationRecord:async()=>preparedResult.trustedRecord,
  });
  const registration=await manager.registerSubagentTaskActivationBinding({
    taskEnvelope:canonicalTaskEnvelope,activationAction:prepared.actions[0],
    invocationId:'invocation-child-1',authorityEnvelope:authorityEnvelope(),
  },'orch-1');
  setNow(Date.parse(T6));
  const before=structuredClone(chrome.data['autopilotOrchestrationV2Runtime:orch-1']);

  const value=await manager.reconcileDurableSubagentResult({
    resultEnvelope:preparedResult.result,
    outcomeContract:preparedResult.outcomeContract,
    criterionVerifications:[{criterionId:'criterion-1',verificationId:'verification-1'}],
    taskActivationBindingId:registration.binding.bindingId,
  },'orch-1');

  assert.equal(value.committed,false);
  assert.equal(value.reconciliation.decision,'WAIT');
  assert.equal(value.dispatch,null);
  assert.deepEqual(chrome.data['autopilotOrchestrationV2Runtime:orch-1'],before);
});

test('owner reconciliation rejects caller authority aliases before durable reads', async () => {
  const preparedResult=terminalResult();
  const {chrome,manager}=await fixture({
    resolveTrustedOutcomeContract:async()=>preparedResult.outcomeContract,
    resolveTrustedVerificationRecord:async()=>preparedResult.trustedRecord,
  });
  const before=structuredClone(chrome.data);
  await assert.rejects(
    ()=>manager.reconcileDurableSubagentResult({
      resultEnvelope:preparedResult.result,
      outcomeContract:preparedResult.outcomeContract,
      criterionVerifications:[{criterionId:'criterion-1',verificationId:'verification-1'}],
      taskActivationBindingId:'binding-forged',
      graph:graph(),
    },'orch-1'),
    /unknown field: graph/u,
  );
  await assert.rejects(
    ()=>manager.reconcileDurableSubagentResult({
      resultEnvelope:preparedResult.result,
      outcomeContract:preparedResult.outcomeContract,
      criterionVerifications:[{criterionId:'criterion-1',verificationId:'verification-1'}],
      taskActivationBindingId:'binding-forged',
      evaluatedAt:T6,
    },'orch-1'),
    /unknown field: evaluatedAt/u,
  );
  assert.deepEqual(chrome.data,before);
});

test('concurrent recovery cannot be misreported as a committed stale child result', async () => {
  const preparedResult=terminalResult();
  const {manager,g,prepared,canonicalTaskEnvelope,setNow}=await fixture({
    resolveTrustedOutcomeContract:async()=>preparedResult.outcomeContract,
    resolveTrustedVerificationRecord:async()=>preparedResult.trustedRecord,
  });
  const registration=await manager.registerSubagentTaskActivationBinding({
    taskEnvelope:canonicalTaskEnvelope,activationAction:prepared.actions[0],
    invocationId:'invocation-child-1',authorityEnvelope:authorityEnvelope(),
  },'orch-1');
  const confirmed=reduceOrchestrationHierarchyEvent(
    g,prepared.runtime,{
      type:OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,
      eventId:'confirm-before-race',controlEpoch:7,nodeId:'child-1',generation:1,
      activationId:'child-activation-1',effectRef:'effect://before-race',
    },Date.parse(T2)+1,
  );
  const controller=manager.controllerFor('orch-1');
  await controller.runtimeRepository.update(runtime=>{
    runtime.hierarchy={schemaVersion:1,graph:g,state:confirmed.runtime};
    return runtime;
  });
  setNow(Date.parse(T6));

  const canonicalDispatch=controller.dispatchHierarchyEvent.bind(controller);
  let raced=false;
  controller.dispatchHierarchyEvent=async(event,options)=>{
    if(!raced&&event.type===OrchestrationHierarchyEventType.NODE_TERMINAL){
      raced=true;
      await canonicalDispatch({
        type:OrchestrationHierarchyEventType.GENERATION_RECOVERY_REQUESTED,
        eventId:'race-recovery',controlEpoch:7,nodeId:'child-1',generation:1,
        newGeneration:2,activationId:'child-recovery-race',
      },options);
    }
    return canonicalDispatch(event,options);
  };

  await assert.rejects(
    ()=>manager.reconcileDurableSubagentResult({
      resultEnvelope:preparedResult.result,
      outcomeContract:preparedResult.outcomeContract,
      criterionVerifications:[{criterionId:'criterion-1',verificationId:'verification-1'}],
      taskActivationBindingId:registration.binding.bindingId,
    },'orch-1'),
    /not durably committed|generation|activation|stale|current/iu,
  );
  const latest=await controller.runtimeRepository.load();
  assert.equal(latest.hierarchy.state.nodesById['child-1'].generation,2);
  assert.notEqual(
    latest.hierarchy.state.nodesById['child-1'].activationLedger['child-activation-1'].phase,
    'TERMINAL',
  );
});
