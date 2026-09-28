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
    capabilityIds:['cap.reason'], requiresVision:false, preparedAt:1790620000000,
    routeId:'route.b',
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
    currentNow:1790620000100,
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
  assert.deepEqual(result.capabilityIds,['cap.reason']);
  assert.equal(result.preparedAt,1790620000000);
  assert.equal(result.revalidatedAt,1790620000100);
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


test('current global Router deny cannot be cleared by single-route scoping', () => {
  const current=settings();
  current.routePolicy={...current.routePolicy,denyRouteIds:['route.b']};
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(request({currentRouterSettings:current})),
    /not currently authorized by canonical Router policy\/state/u,
  );
});

test('current global Router pin outside Agent route cannot be bypassed', () => {
  const current=settings();
  current.routePolicy={...current.routePolicy,pinnedRouteId:'route.c'};
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(request({currentRouterSettings:current})),
    /not currently authorized by canonical Router policy\/state/u,
  );
});

test('current no-auto-switch ordering remains authoritative', () => {
  const current=settings();
  current.routePolicy={
    ...current.routePolicy,
    autoSwitch:false,
    orderedRouteIds:['route.c','route.b','route.a'],
  };
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(request({currentRouterSettings:current})),
    /not currently authorized by canonical Router policy\/state/u,
  );
});

test('current Router cost/locality policy cannot be widened by envelope', () => {
  const freeOnly=settings();
  freeOnly.routePolicy={...freeOnly.routePolicy,freeOnly:true};
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(request({currentRouterSettings:freeOnly})),
    /not currently authorized by canonical Router policy\/state/u,
  );

  const localOnly=settings();
  localOnly.routePolicy={...localOnly.routePolicy,locality:'local'};
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(request({currentRouterSettings:localOnly})),
    /not currently authorized by canonical Router policy\/state/u,
  );
});

test('current durable backoff is re-observed before orchestrator scoping', () => {
  const now=1790620000100;
  const runtime=request().currentRouterRuntime;
  runtime.routeStates['route.b']={backoffUntil:now+5000};
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(request({
      currentRouterRuntime:runtime,
      currentNow:now,
    })),
    /not currently authorized by canonical Router policy\/state/u,
  );
});

test('capability requirements from dispatch intent are rechecked against current route', () => {
  const current=settings();
  current.routes=current.routes.map(item=>item.routeId==='route.b'
    ? {...item,capabilityIds:[]}
    : item);
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(request({currentRouterSettings:current})),
    /not currently authorized by canonical Router policy\/state/u,
  );
});

test('disabled canonical Router cannot be re-enabled by Agent envelope', () => {
  const current=settings();
  current.enabled=false;
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(request({currentRouterSettings:current})),
    /Canonical AI Router is disabled/u,
  );
});

test('orchestrator revalidation time is explicit and monotonic from dispatch preparation', () => {
  const missing=request();
  delete missing.currentNow;
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(missing),
    /currentNow is invalid/u,
  );
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(request({currentNow:1790619999999})),
    /cannot precede dispatch intent preparedAt/u,
  );

  let reads=0;
  const hostile=request();
  Object.defineProperty(hostile,'currentNow',{
    enumerable:true,
    configurable:true,
    get(){reads+=1;return 1790620000100;},
  });
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(hostile),
    /must be an enumerable own data property/u,
  );
  assert.equal(reads,0);
});

test('parent model-policy provenance is revalidated at orchestrator boundary', () => {
  const childIntent=intent({parentModelPolicyBindingKey:'parent.binding'});
  const result=createBoundAgentModelOrchestratorEnvelopeV1(request({
    dispatchIntent:childIntent,
    currentParentModelPolicyBindingKey:'parent.binding',
  }));
  assert.equal(result.parentModelPolicyBindingKey,'parent.binding');

  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(request({
      dispatchIntent:childIntent,
    })),
    /currentParentModelPolicyBindingKey is invalid/u,
  );
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(request({
      dispatchIntent:childIntent,
      currentParentModelPolicyBindingKey:'parent.other',
    })),
    /parent model-policy binding is stale/u,
  );
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(request({
      currentParentModelPolicyBindingKey:'forged.parent',
    })),
    /Root dispatch intent must not supply current parent model-policy provenance/u,
  );
});

test('dispatch capability envelope rejects accessor and duplicate provenance', () => {
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(request({
      dispatchIntent:intent({capabilityIds:['cap.reason','cap.reason']}),
    })),
    /contains duplicates/u,
  );

  let reads=0;
  const ids=['cap.reason'];
  Object.defineProperty(ids,'0',{
    enumerable:true,
    configurable:true,
    get(){reads+=1;return 'cap.reason';},
  });
  assert.throws(
    ()=>createBoundAgentModelOrchestratorEnvelopeV1(request({
      dispatchIntent:intent({capabilityIds:ids}),
    })),
    /contains an invalid value/u,
  );
  assert.equal(reads,0);
});


test('single-route envelope projects manual worker policy without leaking other routes', () => {
  const current=settings();
  current.workerPolicy={
    allocationMode:'manual',
    minWorkers:1,
    maxParallelWorkers:4,
    manualRouteWorkers:{
      'route.a':2,
      'route.b':1,
      'route.c':1,
    },
  };
  const result=createBoundAgentModelOrchestratorEnvelopeV1(request({
    currentRouterSettings:current,
  }));
  assert.equal(result.settings.workerPolicy.allocationMode,'manual');
  assert.deepEqual(result.settings.workerPolicy.manualRouteWorkers,{'route.b':1});
});
