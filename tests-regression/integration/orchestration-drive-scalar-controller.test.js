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
  DRIVE_SCALAR_PROVIDER_V1,
  DriveScalarProviderError,
} from '../../src/core/orchestration-drive-scalar-provider.js';

const START = Date.parse('2026-09-19T00:00:00Z');
const SOURCE_ID = 'file_abcdef';

function config() {
  return validateOrchestrationConfig({
    enabled: true,
    projectId: 'l2-controller',
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
    graphId: 'l2-controller',
    controlEpoch: 1,
    promptProfiles: [
      { id: 'manager-v1', role: 'DOMAIN_MANAGER', version: 1, prompt: 'MANAGER' },
      { id: 'worker-v1', role: 'WORKER', version: 1, prompt: 'WORKER' },
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
          providerId: DRIVE_SCALAR_PROVIDER_V1,
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
  const cfg=new ConfigRepo(config());
  const runtime=new RuntimeRepo(createOrchestrationRuntime(config(),now),cfg,()=>now);
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
      binding.providerId===DRIVE_SCALAR_PROVIDER_V1?provider:null,
    now:()=>now,
  });
  return {cfg,runtime,core,alarmCalls,makeController,now:()=>now,advance(ms){now+=ms;return now;}};
}

async function confirmManagerSend(h) {
  const at=h.advance(1000);
  await h.core.update(state=>{
    const sid=hierarchyCoreSessionId('l2-controller','manager');
    const tid=hierarchyCoreTaskId('l2-controller','manager');
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

test('L2-A controller polls on existing wake, materializes exact slot count, and restart cannot replay same revision', async()=>{
  let reads=0;
  let revision='41';
  let count=2;
  const provider={
    async read({groupNodeId,maxWorkers,sourceId}){
      reads+=1;
      assert.equal(groupNodeId,'manager');
      assert.equal(maxWorkers,3);
      assert.equal(sourceId,SOURCE_ID);
      return {
        providerId:DRIVE_SCALAR_PROVIDER_V1,
        groupNodeId,
        sourceId,
        providerRevision:revision,
        requestedSlotCount:count,
      };
    },
  };
  const h=harness(provider);
  let controller=h.makeController();
  await controller.configureHierarchy(graph(),{nowMs:h.now()});
  await controller.startHierarchy({nowMs:h.advance(1)});
  await confirmManagerSend(h);

  let cycle=await controller.cycle({nowMs:h.advance(1)});
  assert.equal(cycle.hierarchyProviders.checked,0,'provider must not run before Manager terminal');
  assert.deepEqual(cycle.hierarchyProbe.terminal.map(item=>item.nodeId),['manager']);

  controller=h.makeController();
  cycle=await controller.cycle({nowMs:h.advance(1)});
  assert.equal(cycle.hierarchyProviders.checked,1);
  assert.equal(cycle.hierarchyProviders.results[0].kind,'PROVIDER_REVISION_ACCEPTED');
  assert.equal(reads,1);

  let core=await h.core.load();
  assert.ok(core.sessionsById[hierarchyCoreSessionId('l2-controller','worker-1')]);
  assert.ok(core.sessionsById[hierarchyCoreSessionId('l2-controller','worker-2')]);
  assert.equal(core.sessionsById[hierarchyCoreSessionId('l2-controller','worker-3')],undefined);
  assert.equal(core.sessionOrder.length,3);

  let runtime=await h.runtime.load();
  assert.equal(runtime.hierarchy.state.nodesById.manager.providerState.lastAcceptedRevision,'41');
  assert.equal(runtime.hierarchy.state.nodesById.manager.providerState.nextCheckAt,h.now()+60000);

  controller=h.makeController();
  cycle=await controller.cycle({nowMs:h.advance(1000)});
  assert.equal(cycle.hierarchyProviders.checked,0);
  assert.equal(reads,1,'ordinary hierarchy wake before provider deadline must not read Drive');

  h.advance(60000);
  controller=h.makeController();
  cycle=await controller.cycle({nowMs:h.now()});
  assert.equal(cycle.hierarchyProviders.checked,1);
  assert.equal(cycle.hierarchyProviders.results[0].kind,'DUPLICATE_PROVIDER_REVISION');
  assert.equal(reads,2);

  core=await h.core.load();
  assert.equal(core.sessionOrder.length,3,'same Drive revision after service-worker reconstruction must not duplicate slots');
  runtime=await h.runtime.load();
  assert.equal(Object.keys(runtime.hierarchy.state.nodesById['worker-1'].activationLedger).length,1);
  assert.equal(Object.keys(runtime.hierarchy.state.nodesById['worker-2'].activationLedger).length,1);

  revision='42';
  count=2;
  h.advance(60000);
  controller=h.makeController();
  cycle=await controller.cycle({nowMs:h.now()});
  assert.equal(cycle.hierarchyProviders.results[0].kind,'PROVIDER_SLOTS_BUSY');
  runtime=await h.runtime.load();
  assert.equal(runtime.hierarchy.state.nodesById.manager.providerState.lastAcceptedRevision,'41','busy slots must not consume revision 42');
});

test('L2-A provider auth/read failure fails closed, records backoff on same alarm authority, and creates zero workers', async()=>{
  let reads=0;
  const provider={
    async read(){
      reads+=1;
      throw new DriveScalarProviderError('AUTH_REQUIRED','No token');
    },
  };
  const h=harness(provider);
  let controller=h.makeController();
  await controller.configureHierarchy(graph(),{nowMs:h.now()});
  await controller.startHierarchy({nowMs:h.advance(1)});
  await confirmManagerSend(h);
  await controller.cycle({nowMs:h.advance(1)});

  controller=h.makeController();
  const cycle=await controller.cycle({nowMs:h.advance(1)});
  assert.equal(cycle.hierarchyProviders.checked,1);
  assert.equal(cycle.hierarchyProviders.results[0].kind,'PROVIDER_READ_FAILED');
  assert.equal(cycle.hierarchyProviders.results[0].error,'AUTH_REQUIRED');
  assert.equal(reads,1);

  const core=await h.core.load();
  assert.equal(core.sessionOrder.length,1);
  const runtime=await h.runtime.load();
  assert.equal(runtime.hierarchy.state.nodesById.manager.providerState.lastAcceptedRevision,'');
  assert.equal(runtime.hierarchy.state.nodesById.manager.providerState.lastErrorCode,'AUTH_REQUIRED');
  assert.equal(runtime.hierarchy.state.nodesById.manager.providerState.nextCheckAt,h.now()+60000);
  assert.equal(
    h.alarmCalls.some(call=>call[0]==='create' && call[1]==='autopilot-orchestration-v2-wake'),
    true,
    'provider must reuse the existing orchestration alarm instead of creating a second scheduler',
  );
});
