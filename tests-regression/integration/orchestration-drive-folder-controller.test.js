import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyState, RunState } from '../../src/core/schema.js';
import {
  createOrchestrationRuntime,
  normalizeOrchestrationRuntime,
  validateOrchestrationConfig,
} from '../../src/core/orchestration-v2.js';
import { OrchestrationV2Controller } from '../../src/core/orchestration-v2-controller.js';
import { OrchestrationChatMode } from '../../src/core/orchestration-hierarchy.js';
import { hierarchyCoreSessionId, hierarchyCoreTaskId } from '../../src/core/orchestration-hierarchy-core.js';
import {
  DRIVE_FOLDER_DISPATCH_PROVIDER_V1,
  DriveFolderDispatchError,
} from '../../src/core/orchestration-drive-folder-provider.js';

const START = Date.parse('2026-09-19T00:00:00Z');
const SOURCE_ID = 'folder_dispatch_root';
const SNAPSHOT_41 = 'a'.repeat(64);
const DISPATCH_1 = '1'.repeat(64);
const DISPATCH_2 = '2'.repeat(64);

function config() {
  return validateOrchestrationConfig({
    enabled: true,
    projectId: 'l3-controller',
    targetRepository: 'owner/repo',
    controlRepository: 'owner/repo',
    controlIssueNumber: 1,
    masterCoordinatorPrompt: 'unused hierarchy control prompt',
    defaultDesiredWorkers: 0,
    absoluteMaxWorkers: 8,
    workerProbeIntervalSeconds: 30,
    watchdogIntervalSeconds: 300,
  });
}

function graph() {
  return {
    schemaVersion: 1,
    graphId: 'l3-controller',
    controlEpoch: 1,
    promptProfiles: [
      { id: 'manager-v1', role: 'DOMAIN_MANAGER', version: 1, prompt: 'MANAGER' },
      { id: 'worker-v1', role: 'WORKER', version: 1, prompt: 'LOCAL WORKER' },
    ],
    nodes: [
      {
        id: 'manager',
        parentId: null,
        childIds: ['worker-1', 'worker-2', 'worker-3'],
        promptProfileId: 'manager-v1',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        maxActiveChildren: 3,
        barrier: { mode: 'ALL_DIRECT_CHILDREN' },
        providerBinding: {
          providerId: DRIVE_FOLDER_DISPATCH_PROVIDER_V1,
          groupNodeId: 'manager',
          maxSlots: 3,
          sourceId: SOURCE_ID,
          pollIntervalMs: 60000,
        },
      },
      ...['worker-1', 'worker-2', 'worker-3'].map(id => ({
        id,
        parentId: 'manager',
        childIds: [],
        promptProfileId: 'worker-v1',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
      })),
    ],
  };
}

class ConfigRepo {
  constructor(value) { this.value = structuredClone(value); }
  async load() { return structuredClone(this.value); }
  async save(value) { this.value = structuredClone(value); return this.load(); }
}
class RuntimeRepo {
  constructor(value, cfg, now) { this.value=structuredClone(value); this.cfg=cfg; this.now=now; this.chain=Promise.resolve(); }
  async load() { return normalizeOrchestrationRuntime(this.value, await this.cfg.load(), this.now()); }
  update(mutator) {
    const op=this.chain.then(async()=>{
      const current=await this.load();
      const next=await mutator(current,await this.cfg.load())||current;
      this.value=normalizeOrchestrationRuntime(next,await this.cfg.load(),this.now());
      return structuredClone(this.value);
    });
    this.chain=op.catch(()=>undefined);
    return op;
  }
}
class CoreRepo {
  constructor(value) { this.value=structuredClone(value); this.chain=Promise.resolve(); }
  async load() { return structuredClone(this.value); }
  update(mutator) {
    const op=this.chain.then(async()=>{
      const draft=structuredClone(this.value);
      this.value=structuredClone(await mutator(draft)||draft);
      return this.load();
    });
    this.chain=op.catch(()=>undefined);
    return op;
  }
}

function harness(provider) {
  let now=START;
  const cfgValue=config();
  const cfg=new ConfigRepo(cfgValue);
  const runtime=new RuntimeRepo(createOrchestrationRuntime(cfgValue,now),cfg,()=>now);
  const core=new CoreRepo(createEmptyState(now));
  const alarmCalls=[];
  const chromeApi={
    alarms:{
      async create(name,details){alarmCalls.push(['create',name,details]);},
      async clear(name){alarmCalls.push(['clear',name]);return true;},
    },
  };
  const makeController=()=>new OrchestrationV2Controller({
    coreRepository:core,
    chromeApi,
    configRepository:cfg,
    runtimeRepository:runtime,
    collectAssistantReport:async probe=>({
      status:'READY',
      assistantComplete:true,
      assistantText:`${probe.nodeId} done`,
    }),
    resolveHierarchyProvider:async ({binding})=>
      binding.providerId===DRIVE_FOLDER_DISPATCH_PROVIDER_V1?provider:null,
    now:()=>now,
  });
  return {cfg,runtime,core,alarmCalls,makeController,now:()=>now,advance(ms){now+=ms;return now;}};
}

async function confirmManagerSend(h) {
  const at=h.advance(1000);
  await h.core.update(state=>{
    const sid=hierarchyCoreSessionId('l3-controller','manager');
    const tid=hierarchyCoreTaskId('l3-controller','manager');
    const session=state.sessionsById[sid];
    const task=session.tasksById[tid];
    task.lastVerifiedSendAt=at;
    task.lastConversationUrl='https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
    task.lastVerifiedFingerprint='fp-manager';
    task.lastAssistantBaselineCount=1;
    task.lastAssistantBaselineKnown=true;
    session.runState=RunState.STOPPED;
    session.completedAt=at;
    session.operation=null;
    return state;
  });
}

function readySnapshot() {
  return {
    kind:'READY',
    providerId:DRIVE_FOLDER_DISPATCH_PROVIDER_V1,
    groupNodeId:'manager',
    sourceId:SOURCE_ID,
    providerRevision:'41',
    generationFolderId:'generation_folder_41',
    snapshotHash:SNAPSHOT_41,
    dispatches:[
      {
        fileId:'file_a',
        fileVersion:'7',
        dispatchIdentity:DISPATCH_1,
        targetChildId:'worker-1',
        promptPayload:'REMOTE ONE',
        promptProfileId:'',
        order:1,
      },
      {
        fileId:'file_b',
        fileVersion:'8',
        dispatchIdentity:DISPATCH_2,
        targetChildId:'worker-2',
        promptPayload:'',
        promptProfileId:'worker-v1',
        order:2,
      },
    ],
  };
}

test('L3 controller polls READY generation on existing wake, materializes exact children, and restart cannot replay batch', async()=>{
  let reads=0;
  const provider={
    async read({groupNodeId,maxWorkers,sourceId,childNodeIds,childPromptProfileIds}){
      reads+=1;
      assert.equal(groupNodeId,'manager');
      assert.equal(maxWorkers,3);
      assert.equal(sourceId,SOURCE_ID);
      assert.deepEqual(childNodeIds,['worker-1','worker-2','worker-3']);
      assert.deepEqual(childPromptProfileIds,{
        'worker-1':['worker-v1'],
        'worker-2':['worker-v1'],
        'worker-3':['worker-v1'],
      });
      return readySnapshot();
    },
  };
  const h=harness(provider);
  let controller=h.makeController();
  await controller.configureHierarchy(graph(),{nowMs:h.now()});
  await controller.startHierarchy({nowMs:h.advance(1)});
  await confirmManagerSend(h);

  let cycle=await controller.cycle({nowMs:h.advance(1)});
  assert.deepEqual(cycle.hierarchyProbe.terminal.map(item=>item.nodeId),['manager']);
  assert.equal(cycle.hierarchyProviders.checked,1);
  assert.equal(cycle.hierarchyProviders.results[0].kind,'PROVIDER_REVISION_ACCEPTED');
  assert.equal(cycle.hierarchyProviders.results[0].requestedSlotCount,2);
  assert.equal(reads,1);

  let core=await h.core.load();
  const w1=core.sessionsById[hierarchyCoreSessionId('l3-controller','worker-1')];
  const w2=core.sessionsById[hierarchyCoreSessionId('l3-controller','worker-2')];
  assert.ok(w1);
  assert.ok(w2);
  assert.equal(core.sessionsById[hierarchyCoreSessionId('l3-controller','worker-3')],undefined);
  assert.equal(w1.tasksById[hierarchyCoreTaskId('l3-controller','worker-1')].promptOverride,'REMOTE ONE');
  assert.equal(w2.tasksById[hierarchyCoreTaskId('l3-controller','worker-2')].promptOverride,'LOCAL WORKER');
  assert.equal(core.sessionOrder.length,3);

  let runtime=await h.runtime.load();
  assert.equal(runtime.hierarchy.state.nodesById.manager.providerState.lastAcceptedRevision,'41');
  assert.equal(runtime.hierarchy.state.nodesById.manager.providerState.lastAcceptedDispatchFingerprint,SNAPSHOT_41);

  controller=h.makeController();
  cycle=await controller.cycle({nowMs:h.advance(1000)});
  assert.equal(cycle.hierarchyProviders.checked,0);
  assert.equal(reads,1);

  h.advance(60000);
  controller=h.makeController();
  cycle=await controller.cycle({nowMs:h.now()});
  assert.equal(cycle.hierarchyProviders.checked,1);
  assert.equal(cycle.hierarchyProviders.results[0].kind,'DUPLICATE_EVENT');
  assert.equal(reads,2);

  core=await h.core.load();
  assert.equal(core.sessionOrder.length,3);
  runtime=await h.runtime.load();
  assert.equal(runtime.hierarchy.state.nodesById.manager.providerState.lastErrorCode,'');
  assert.equal(Object.keys(runtime.hierarchy.state.nodesById['worker-1'].activationLedger).length,1);
  assert.equal(Object.keys(runtime.hierarchy.state.nodesById['worker-2'].activationLedger).length,1);
});

test('L3 NOT_READY is a healthy wait and creates no children', async()=>{
  const provider={
    async read(){
      return {
        kind:'NOT_READY',
        providerId:DRIVE_FOLDER_DISPATCH_PROVIDER_V1,
        groupNodeId:'manager',
        sourceId:SOURCE_ID,
        providerRevision:'41',
      };
    },
  };
  const h=harness(provider);
  const controller=h.makeController();
  await controller.configureHierarchy(graph(),{nowMs:h.now()});
  await controller.startHierarchy({nowMs:h.advance(1)});
  await confirmManagerSend(h);
  const cycle=await controller.cycle({nowMs:h.advance(1)});

  assert.equal(cycle.hierarchyProviders.results[0].kind,'NOT_READY');
  const core=await h.core.load();
  assert.equal(core.sessionOrder.length,1);
  const runtime=await h.runtime.load();
  assert.equal(runtime.hierarchy.state.nodesById.manager.providerState.lastAcceptedRevision,'');
  assert.equal(runtime.hierarchy.state.nodesById.manager.providerState.lastErrorCode,'');
  assert.equal(runtime.hierarchy.state.nodesById.manager.providerState.nextCheckAt,h.now()+60000);
});

test('L3 provider read failure fails closed and reuses existing orchestration alarm', async()=>{
  const provider={
    async read(){
      throw new DriveFolderDispatchError('UNSTABLE_GENERATION','Changed after READY');
    },
  };
  const h=harness(provider);
  const controller=h.makeController();
  await controller.configureHierarchy(graph(),{nowMs:h.now()});
  await controller.startHierarchy({nowMs:h.advance(1)});
  await confirmManagerSend(h);
  const cycle=await controller.cycle({nowMs:h.advance(1)});

  assert.equal(cycle.hierarchyProviders.results[0].kind,'PROVIDER_READ_FAILED');
  assert.equal(cycle.hierarchyProviders.results[0].error,'UNSTABLE_GENERATION');
  const core=await h.core.load();
  assert.equal(core.sessionOrder.length,1);
  const runtime=await h.runtime.load();
  assert.equal(runtime.hierarchy.state.nodesById.manager.providerState.lastAcceptedRevision,'');
  assert.equal(runtime.hierarchy.state.nodesById.manager.providerState.lastErrorCode,'UNSTABLE_GENERATION');
  assert.equal(
    h.alarmCalls.some(call=>call[0]==='create'&&call[1]==='autopilot-orchestration-v2-wake'),
    true,
  );
});
