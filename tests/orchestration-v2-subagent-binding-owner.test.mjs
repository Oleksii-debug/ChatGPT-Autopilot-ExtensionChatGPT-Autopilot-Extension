import test from 'node:test';
import assert from 'node:assert/strict';

import { StorageRepository } from '../src/core/storage.js';
import {
  ProjectWorkspaceRepository,
  addProjectSnapshot,
} from '../src/core/project-workspace.js';
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

const T0='2026-09-29T04:00:00.000Z';
const T1='2026-09-29T04:01:00.000Z';
const T2='2026-09-29T04:02:00.000Z';

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
function contract(projectId='project-1'){
  return createOutcomeContractV1({
    contractId:'outcome-1',projectId,desiredResult:'Return one verified result.',
    completionCriteria:[{
      criterionId:'criterion-1',description:'Result complete.',observable:'Artifact exists.',
      requiredEvidenceKinds:['ARTIFACT'],
    }],
    constraints:[],sourceTruth:[],allowedAuthority:[],
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
    plan,nodeId:'task-1',inputSourceIds:[],inputArtifactRefs:[],
    outcomeContract:contract(projectId),createdAt:T1,
  });
}

function projectSnapshot(revisionId='project-revision-1'){
  return {
    schemaVersion:1,
    projectId:'project-1',
    revisionId,
    title:'Parent project metadata must not cross child boundary.',
    sourceRefs:[],
    artifactRefs:[],
    createdAt:T1,
  };
}
function authorityEnvelope(overrides={}){
  return {
    schemaVersion:1,
    decision:'ALLOW',
    reasonCode:'LEAST_AUTHORITY_DERIVED',
    projectId:'project-1',
    parentAgentId:'parent-1',
    childAgentId:'child-1',
    taskId:'task-1',
    providerId:'provider-main',
    capabilityIds:[],
    sourceIds:[],
    artifactIds:[],
    toolIds:[],
    toolDescriptors:[],
    executionAuthority:false,
    credentialAuthority:false,
    policyAuthority:false,
    ...overrides,
  };
}
async function seedProjectWorkspace(chrome){
  const repository=new ProjectWorkspaceRepository(chrome);
  await repository.update(workspace=>{
    addProjectSnapshot(workspace,projectSnapshot(),{nowMs:Date.parse(T2)});
    return workspace;
  },{nowMs:Date.parse(T2)});
  return repository;
}

async function fixture(){
  const chrome=chromeFake();
  const core=new StorageRepository(chrome);
  let nowMs=Date.parse(T2);
  const manager=new OrchestrationV2Manager({
    coreRepository:core,chromeApi:chrome,createId:()=> 'orch-1',now:()=>nowMs,
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
    taskEnvelope:canonicalTaskEnvelope,activationAction:prepared.actions[0],invocationId:'invocation-child-1',
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
    invocationId:'invocation-child-1',
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
      invocationId:'invocation-recovery-2',
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
    invocationId:'invocation-recovery-2',
  },'orch-1');
  assert.equal(recovery.revision,2);
  assert.equal(recovery.binding.activationPurpose,OrchestrationActivationPurpose.RECOVERY);
  assert.equal(recovery.binding.taskDispatchIdentity,work.binding.taskDispatchIdentity);
});

test('binding owner rejects forged activation, cross-project task and caller authority fields without mutation',async()=>{
  const {chrome,manager,prepared}=await fixture();
  const base={
    taskEnvelope:taskEnvelope(),activationAction:prepared.actions[0],invocationId:'invocation-child-1',
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
    /dispatch identity does not match task envelope|project does not match orchestra owner project/u,
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


test('resolveBoundSubagentTaskContext returns only durable revision-fenced child context',async()=>{
  const {chrome,core,manager,prepared,canonicalTaskEnvelope}=await fixture();
  await seedProjectWorkspace(chrome);

  const registered=await manager.registerSubagentTaskActivationBinding({
    taskEnvelope:canonicalTaskEnvelope,
    activationAction:prepared.actions[0],
    invocationId:'invocation-context-1',
  },'orch-1');

  const resolved=await manager.resolveBoundSubagentTaskContext({
    bindingId:registered.binding.bindingId,
    authorityEnvelope:authorityEnvelope(),
    taskEnvelope:canonicalTaskEnvelope,
    expectedProjectRevisionId:'project-revision-1',
  },'orch-1');

  assert.equal(resolved.orchestraId,'orch-1');
  assert.equal(resolved.bindingId,registered.binding.bindingId);
  assert.equal(resolved.taskDispatchIdentity,registered.binding.taskDispatchIdentity);
  assert.equal(resolved.context.ownerStateSource,'DURABLE_PROJECT_WORKSPACE');
  assert.equal(resolved.context.parentProjectRevisionId,'project-revision-1');
  assert.equal(resolved.context.sourceAuthorityAuthenticated,false);
  assert.equal(
    resolved.context.sourceTrust,
    'DURABLE_OWNER_STATE_SOURCE_AUTHORITY_NOT_AUTHENTICATED',
  );
  assert.deepEqual(resolved.context.projectedSnapshot.sourceRefs,[]);
  assert.deepEqual(resolved.context.projectedSnapshot.artifactRefs,[]);
  assert.equal(
    JSON.stringify(resolved).includes('Parent project metadata must not cross'),
    false,
  );
  assert.equal(resolved.retrievalAuthorized,false);
  assert.equal(resolved.executionAuthorized,false);
  assert.equal(resolved.mutationAuthorized,false);
  assert.equal(resolved.credentialAuthority,false);
  assert.equal(resolved.policyAuthority,false);
  assert.equal(resolved.schedulingAuthority,false);
  assert.equal(resolved.verificationAuthority,false);
  assert.equal(resolved.completionAuthority,false);

  const restarted=new OrchestrationV2Manager({
    coreRepository:core,
    chromeApi:chrome,
    createId:()=> 'unused',
    now:()=>Date.parse(T2)+120_000,
  });
  const afterRestart=await restarted.resolveBoundSubagentTaskContext({
    bindingId:registered.binding.bindingId,
    authorityEnvelope:authorityEnvelope(),
    taskEnvelope:structuredClone(canonicalTaskEnvelope),
    expectedProjectRevisionId:'project-revision-1',
  },'orch-1');
  assert.deepEqual(afterRestart,resolved);
});

test('resolveBoundSubagentTaskContext rejects semantic task substitution despite matching public ids',async()=>{
  const {chrome,manager,prepared,canonicalTaskEnvelope}=await fixture();
  await seedProjectWorkspace(chrome);
  const registered=await manager.registerSubagentTaskActivationBinding({
    taskEnvelope:canonicalTaskEnvelope,
    activationAction:prepared.actions[0],
    invocationId:'invocation-context-2',
  },'orch-1');

  const substituted=structuredClone(canonicalTaskEnvelope);
  substituted.objective += ' semantic substitution';

  await assert.rejects(
    manager.resolveBoundSubagentTaskContext({
      bindingId:registered.binding.bindingId,
      authorityEnvelope:authorityEnvelope(),
      taskEnvelope:substituted,
      expectedProjectRevisionId:'project-revision-1',
    },'orch-1'),
    /task does not match durable activation binding: taskDispatchIdentity/u,
  );
});

test('resolveBoundSubagentTaskContext fails closed on authority identity or Project revision drift',async()=>{
  const {chrome,manager,prepared,canonicalTaskEnvelope}=await fixture();
  await seedProjectWorkspace(chrome);
  const registered=await manager.registerSubagentTaskActivationBinding({
    taskEnvelope:canonicalTaskEnvelope,
    activationAction:prepared.actions[0],
    invocationId:'invocation-context-3',
  },'orch-1');

  await assert.rejects(
    manager.resolveBoundSubagentTaskContext({
      bindingId:registered.binding.bindingId,
      authorityEnvelope:authorityEnvelope({childAgentId:'child-forged'}),
      taskEnvelope:canonicalTaskEnvelope,
      expectedProjectRevisionId:'project-revision-1',
    },'orch-1'),
    /task childAgentId binding mismatch/u,
  );

  await assert.rejects(
    manager.resolveBoundSubagentTaskContext({
      bindingId:registered.binding.bindingId,
      authorityEnvelope:authorityEnvelope(),
      taskEnvelope:canonicalTaskEnvelope,
      expectedProjectRevisionId:'project-revision-stale',
    },'orch-1'),
    /snapshot revision binding mismatch/u,
  );
});

test('resolveBoundSubagentTaskContext snapshots data-only input before owner-state awaits',async()=>{
  const {chrome,manager,prepared,canonicalTaskEnvelope}=await fixture();
  await seedProjectWorkspace(chrome);
  const registered=await manager.registerSubagentTaskActivationBinding({
    taskEnvelope:canonicalTaskEnvelope,
    activationAction:prepared.actions[0],
    invocationId:'invocation-context-4',
  },'orch-1');

  let getterCalls=0;
  const malicious={
    bindingId:registered.binding.bindingId,
    authorityEnvelope:authorityEnvelope(),
    taskEnvelope:structuredClone(canonicalTaskEnvelope),
    expectedProjectRevisionId:'project-revision-1',
  };
  Object.defineProperty(malicious.authorityEnvelope,'projectId',{
    enumerable:true,
    configurable:true,
    get(){
      getterCalls+=1;
      return 'project-1';
    },
  });

  await assert.rejects(
    manager.resolveBoundSubagentTaskContext(malicious,'orch-1'),
    /enumerable own data property/u,
  );
  assert.equal(getterCalls,0);

  await assert.rejects(
    manager.resolveBoundSubagentTaskContext({
      bindingId:registered.binding.bindingId,
      authorityEnvelope:authorityEnvelope(),
      taskEnvelope:canonicalTaskEnvelope,
      expectedProjectRevisionId:'project-revision-1',
      executionAuthority:true,
    },'orch-1'),
    /unknown field: executionAuthority/u,
  );
});
