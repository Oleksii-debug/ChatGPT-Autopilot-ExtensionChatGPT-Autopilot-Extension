import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBoundAgentModelOrchestratorEnvelopeV1,
} from '../src/core/agent-model-orchestrator-envelope.js';
import {
  AGENT_MODEL_ROUTE_DISPATCH_INTENT_AUTHORITY,
} from '../src/core/agent-model-route-dispatch-intent.js';

function route(routeId, provider='openai', model='m-'+routeId) {
  return {
    schemaVersion:1, routeId, provider, model, endpointId:'', displayName:routeId,
    systemPrompt:'', workerPrompt:'', roles:['planner','verifier'], capabilityIds:['cap.reason'],
    priority:10, enabled:true, locality:'remote', costClass:'paid',
    inputPricePerMillionUsd:1, outputPricePerMillionUsd:2, supportsVision:false, maxWorkers:4,
  };
}
function settings() {
  return {
    enabled:true,
    gatewayUrl:'http://127.0.0.1:3210',
    timeoutSeconds:180,
    mode:'primary',
    primary:{provider:'ollama',model:'legacy'},
    strong:{provider:'openai',model:'strong'},
    routes:[route('route.a'),route('route.b'),route('route.c')],
    routePolicy:{
      autoSwitch:true,pinnedRouteId:'',orderedRouteIds:['route.b','route.a','route.c'],
      allowRouteIds:['route.a','route.b','route.c'],denyRouteIds:[],freeOnly:false,locality:'remote',
      maxInputPricePerMillionUsd:4,maxOutputPricePerMillionUsd:5,
    },
  };
}
function intent(overrides={}) {
  return {
    schemaVersion:1, jobId:'agent.runtime.001', projectId:'project.alpha',
    registryId:'agents:project.alpha', registryRevision:6, agentDefinitionId:'agent.research',
    definitionRevision:4, definitionModelPolicyBindingKey:'binding.outer',
    modelPolicyBindingKey:'binding.inner', routePoolRevision:9, role:'planner',
    requiresVision:false, routeId:'route.b',
    route:{routeId:'route.b',provider:'openai',model:'m-route.b',endpointId:''},
    eligibleRouteIds:['route.b','route.a'],availableRouteIds:['route.b','route.a'],
    retryAt:0,authority:AGENT_MODEL_ROUTE_DISPATCH_INTENT_AUTHORITY,...overrides,
  };
}
function request(overrides={}) {
  return {
    dispatchIntent:intent(),
    currentDefinitionModelPolicyBindingKey:'binding.outer',
    currentJobId:'agent.runtime.001',
    currentProjectId:'project.alpha',
    currentRoutePoolRevision:9,
    currentRouterSettings:settings(),
    currentRouterRuntime:{
      requestCount:3,routeStates:{
        'route.a':{backoffUntil:100},
        'route.b':{backoffUntil:0},
        'route.c':{circuitOpenUntil:200},
      },
      lastRouteId:'route.c',
      lastFailoverChain:[
        {routeId:'route.c',outcome:'error',code:'x',category:'retryable'},
        {routeId:'route.b',outcome:'ok',code:'',category:''},
      ],
    },
    ...overrides,
  };
}

test('scopes canonical AiOrchestrator settings to exact bound route', () => {
  const result=createBoundAgentModelOrchestratorEnvelopeV1(request());
  assert.equal(result.routeId,'route.b');
  assert.deepEqual(result.settings.routes.map(x=>x.routeId),['route.b']);
  assert.deepEqual(result.settings.routePolicy.allowRouteIds,['route.b']);
  assert.deepEqual(result.settings.routePolicy.orderedRouteIds,['route.b']);
  assert.equal(result.settings.routePolicy.pinnedRouteId,'route.b');
  assert.equal(result.settings.routePolicy.autoSwitch,false);
  assert.deepEqual(Object.keys(result.runtime.routeStates),['route.b']);
  assert.equal(result.runtime.lastRouteId,'');
  assert.deepEqual(result.runtime.lastFailoverChain.map(x=>x.routeId),['route.b']);
});

test('fails closed on owner, job, Project or route-pool drift', () => {
  assert.throws(()=>createBoundAgentModelOrchestratorEnvelopeV1(request({currentDefinitionModelPolicyBindingKey:'other'})),/owner binding is stale/u);
  assert.throws(()=>createBoundAgentModelOrchestratorEnvelopeV1(request({currentJobId:'other'})),/job identity is stale/u);
  assert.throws(()=>createBoundAgentModelOrchestratorEnvelopeV1(request({currentProjectId:'other'})),/Project identity is stale/u);
  assert.throws(()=>createBoundAgentModelOrchestratorEnvelopeV1(request({currentRoutePoolRevision:10})),/route-pool revision is stale/u);
});

test('fails closed when current Router provider identity drifted', () => {
  const changed=settings();
  changed.routes=changed.routes.map(x=>x.routeId==='route.b'?{...x,model:'changed'}:x);
  assert.throws(()=>createBoundAgentModelOrchestratorEnvelopeV1(request({currentRouterSettings:changed})),/provider identity drifted/u);
});

test('dispatch intent authority widening is rejected', () => {
  assert.throws(()=>createBoundAgentModelOrchestratorEnvelopeV1(request({
    dispatchIntent:intent({authority:{...AGENT_MODEL_ROUTE_DISPATCH_INTENT_AUTHORITY,providerCallAuthorized:true}}),
  })),/authority is invalid/u);
});

test('out-of-scope routes disappear from both settings and runtime', () => {
  const result=createBoundAgentModelOrchestratorEnvelopeV1(request());
  assert.equal(result.settings.routes.some(x=>x.routeId==='route.c'),false);
  assert.equal(Object.hasOwn(result.runtime.routeStates,'route.c'),false);
});

test('caller cannot inject prompt, credentials or invocation authority', () => {
  for (const extra of [
    {prompt:'forged'}, {apiKey:'secret'}, {orchestratorInvocationAuthorized:true},
  ]) {
    assert.throws(()=>createBoundAgentModelOrchestratorEnvelopeV1({...request(),...extra}),/contains unknown field/u);
  }
});

test('hostile top-level accessor is rejected without execution', () => {
  let reads=0;
  const hostile=request();
  Object.defineProperty(hostile,'currentJobId',{enumerable:true,get(){reads+=1;return 'agent.runtime.001';}});
  assert.throws(()=>createBoundAgentModelOrchestratorEnvelopeV1(hostile),/must be an enumerable own data property/u);
  assert.equal(reads,0);
});

test('envelope grants no orchestrator invocation or provider-call authority', () => {
  const result=createBoundAgentModelOrchestratorEnvelopeV1(request());
  assert.equal(result.authority.orchestratorInvocationAuthorized,false);
  assert.equal(result.authority.providerCallAuthorized,false);
  assert.equal(result.authority.credentialAccessAuthorized,false);
  assert.equal(result.authority.executionAuthorized,false);
  assert.equal(result.authority.requiresCanonicalAiOrchestrator,true);
  assert.equal(result.authority.requiresProviderCallLifecycleRevalidation,true);
  assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result.settings),true);
});
