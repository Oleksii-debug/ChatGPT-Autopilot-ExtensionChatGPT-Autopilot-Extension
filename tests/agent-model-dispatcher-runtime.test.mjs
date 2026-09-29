import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreCommandDispatcher } from '../src/core/commands.js';
import { createEmptyState, validateState } from '../src/core/schema.js';
import {
  AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
} from '../src/core/agent-model-orchestrator-envelope.js';

class MemoryRepo {
  constructor(state = createEmptyState(1000)) {
    this.state = structuredClone(state);
  }

  async load() {
    return structuredClone(this.state);
  }

  async update(mutator) {
    const draft = structuredClone(this.state);
    this.state = await mutator(draft) || draft;
    this.state.revision += 1;
    validateState(this.state);
    return structuredClone(this.state);
  }
}

class DelayedLoadRepo extends MemoryRepo {
  constructor(state) {
    super(state);
    this.releaseLoad = null;
  }

  async load() {
    await new Promise(resolve => {
      this.releaseLoad = resolve;
    });
    return structuredClone(this.state);
  }
}

function internalAgentEnvelope(overrides = {}) {
  const route = {
    schemaVersion: 1,
    routeId: 'route.agent',
    provider: 'openai',
    model: 'agent-model',
    endpointId: '',
    displayName: 'Agent model',
    systemPrompt: '',
    workerPrompt: '',
    roles: ['coder'],
    capabilityIds: ['cap.reason'],
    priority: 20,
    enabled: true,
    locality: 'remote',
    costClass: 'paid',
    inputPricePerMillionUsd: 1,
    outputPricePerMillionUsd: 2,
    supportsVision: false,
    maxWorkers: 1,
  };
  return {
    schemaVersion: 1,
    jobId: 'agent.job.1',
    projectId: 'project.alpha',
    definitionModelPolicyBindingKey: 'definition.binding',
    modelPolicyBindingKey: 'model.binding',
    routePoolRevision: 9,
    role: 'coder',
    capabilityIds: ['cap.reason'],
    requiresVision: false,
    preparedAt: 1_000,
    revalidatedAt: 1_500,
    routeId: 'route.agent',
    settings: {
      enabled: true,
      gatewayUrl: 'http://127.0.0.1:3210',
      timeoutSeconds: 180,
      mode: 'primary',
      primary: { provider: 'openai', model: 'agent-model' },
      strong: { provider: 'openai', model: 'agent-model' },
      strongEveryNRequests: 0,
      strongEveryMinutes: 0,
      strongMinGapMinutes: 0,
      strongMaxPerHour: 0,
      carryStrongResultToPrimary: false,
      fallbackToStrongOnPrimaryError: false,
      keepPrimaryIfStrongFails: true,
      routes: [route],
      routePolicy: {
        autoSwitch: false,
        pinnedRouteId: 'route.agent',
        orderedRouteIds: ['route.agent'],
        allowRouteIds: ['route.agent'],
        denyRouteIds: [],
        freeOnly: false,
        locality: 'remote',
        maxInputPricePerMillionUsd: 4,
        maxOutputPricePerMillionUsd: 5,
      },
    },
    runtime: {
      requestCount: 7,
      routeStates: {
        'route.agent': {
          consecutiveFailures: 0,
          successes: 2,
          failures: 0,
          backoffUntil: 0,
          circuitOpenUntil: 0,
          lastErrorCode: '',
          lastErrorCategory: '',
          lastErrorAt: 0,
          lastSuccessAt: 1_400,
          lastLatencyMs: 12,
        },
      },
      lastRouteId: 'route.agent',
      lastFailoverChain: [],
    },
    authority: AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
    ...overrides,
  };
}

function budgetContext(overrides = {}) {
  return {
    kind: 'browser-agent',
    jobId: 'agent.job.1',
    controlEpoch: 7,
    ...overrides,
  };
}

function stateForEnvelope(envelope) {
  const state = createEmptyState(1000);
  state.profile.aiRouter = structuredClone(envelope.settings);
  state.profile.aiRouterRuntime = structuredClone(envelope.runtime);
  return state;
}

function internal(envelope, context = budgetContext()) {
  return {
    agentModelOrchestratorEnvelope: envelope,
    providerCallBudgetContext: context,
  };
}

function successfulResult(runtime) {
  return {
    text: 'ok',
    route: 'primary',
    trigger: 'primary-only',
    primary: { provider: 'openai', model: 'agent-model', text: 'ok' },
    strong: null,
    runtime: { ...runtime, requestCount: Number(runtime.requestCount || 0) + 1 },
  };
}

test('bound Agent envelope reaches AiOrchestrator with exact snapped inputs and isolated runtime', async () => {
  const envelope = internalAgentEnvelope();
  const repo = new MemoryRepo(stateForEnvelope(envelope));
  const before = structuredClone(repo.state);
  const seen = [];
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: {
      async run(settings, runtime, prompt, options) {
        seen.push({
          settings: structuredClone(settings),
          runtime: structuredClone(runtime),
          prompt,
          options: structuredClone(options),
        });
        return successfulResult(runtime);
      },
    },
  });

  const result = await dispatcher.execute(
    'RUN_AI_ROUTED_PROMPT',
    {
      prompt: 'exact prompt',
      systemPrompt: 'exact system',
      maxOutputTokens: 128,
      maxModelCallsForRequest: 1,
    },
    internal(envelope),
  );

  assert.equal(result.result.text, 'ok');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].prompt, 'exact prompt');
  assert.equal(seen[0].options.systemPrompt, 'exact system');
  assert.equal(seen[0].options.maxOutputTokens, 128);
  assert.equal(seen[0].options.maxModelCallsForRequest, 1);
  assert.equal(seen[0].options.taskRole, 'coder');
  assert.equal(seen[0].options.strongTaskRole, 'coder');
  assert.deepEqual(seen[0].options.capabilityIds, ['cap.reason']);
  assert.deepEqual(seen[0].options.providerCallBudgetContext, budgetContext());
  assert.deepEqual(seen[0].settings.routes.map(route => route.routeId), ['route.agent']);
  assert.deepEqual(repo.state, before, 'bound Agent invocation must not mutate global Router state');
});

test('bound Agent envelope is internal-only and cannot be mixed with public Router aliases', async () => {
  const envelope = internalAgentEnvelope();
  let calls = 0;
  const dispatcher = new CoreCommandDispatcher(
    new MemoryRepo(stateForEnvelope(envelope)),
    () => 2_000,
    { aiOrchestrator: { async run() { calls += 1; return {}; } } },
  );

  await assert.rejects(
    dispatcher.execute('RUN_AI_ROUTED_PROMPT', {
      prompt: 'x',
      maxOutputTokens: 32,
      agentModelOrchestratorEnvelope: envelope,
    }),
    /internal-only/u,
  );

  for (const alias of [
    { routerOverride: {} },
    { settings: envelope.settings },
    { isolatedRuntime: true },
    { taskRole: 'planner' },
    { capabilityIds: ['forged'] },
  ]) {
    await assert.rejects(
      dispatcher.execute(
        'RUN_AI_ROUTED_PROMPT',
        { prompt: 'x', maxOutputTokens: 32, ...alias },
        internal(envelope),
      ),
      /cannot be mixed with payload Router aliases/u,
    );
  }
  assert.equal(calls, 0);
});

test('bound Agent invocation requires exact durable BrowserAgent budget owner provenance', async () => {
  const envelope = internalAgentEnvelope();
  let calls = 0;
  const dispatcher = new CoreCommandDispatcher(
    new MemoryRepo(stateForEnvelope(envelope)),
    () => 2_000,
    { aiOrchestrator: { async run() { calls += 1; return {}; } } },
  );

  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'x', maxOutputTokens: 32 },
      internal(envelope, budgetContext({ jobId: 'other.job' })),
    ),
    /budget owner does not match envelope job identity/u,
  );
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'x', maxOutputTokens: 32 },
      internal(envelope, budgetContext({ controlEpoch: 0 })),
    ),
    /budget controlEpoch is invalid/u,
  );

  let reads = 0;
  const hostile = { agentModelOrchestratorEnvelope: envelope };
  Object.defineProperty(hostile, 'providerCallBudgetContext', {
    enumerable: true,
    get() {
      reads += 1;
      return budgetContext();
    },
  });
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'x', maxOutputTokens: 32 },
      hostile,
    ),
    /provider budget context must be an enumerable own data property/u,
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('final provider boundary revalidates current Router identity and owner policy', async () => {
  const envelope = internalAgentEnvelope();
  let calls = 0;

  const changedIdentity = stateForEnvelope(envelope);
  changedIdentity.profile.aiRouter.routes[0].model = 'changed-model';
  const identityDispatcher = new CoreCommandDispatcher(
    new MemoryRepo(changedIdentity),
    () => 2_000,
    { aiOrchestrator: { async run() { calls += 1; return {}; } } },
  );
  await assert.rejects(
    identityDispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'x', maxOutputTokens: 32 },
      internal(envelope),
    ),
    /route identity drifted before provider invocation/u,
  );

  const denied = stateForEnvelope(envelope);
  denied.profile.aiRouter.routePolicy.denyRouteIds = ['route.agent'];
  const denyDispatcher = new CoreCommandDispatcher(
    new MemoryRepo(denied),
    () => 2_000,
    { aiOrchestrator: { async run() { calls += 1; return {}; } } },
  );
  await assert.rejects(
    denyDispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'x', maxOutputTokens: 32 },
      internal(envelope),
    ),
    /no longer authorized by current canonical Router/u,
  );
  assert.equal(calls, 0);
});

test('Agent model prompt and bounds are snapshotted before asynchronous Router reload', async () => {
  const envelope = internalAgentEnvelope();
  const repo = new DelayedLoadRepo(stateForEnvelope(envelope));
  const seen = [];
  const dispatcher = new CoreCommandDispatcher(repo, () => 2_000, {
    aiOrchestrator: {
      async run(settings, runtime, prompt, options) {
        seen.push({ prompt, options: structuredClone(options) });
        return successfulResult(runtime);
      },
    },
  });

  const payload = {
    prompt: 'before',
    systemPrompt: 'system-before',
    maxOutputTokens: 64,
    maxModelCallsForRequest: 1,
  };
  const pending = dispatcher.execute(
    'RUN_AI_ROUTED_PROMPT',
    payload,
    internal(envelope),
  );

  payload.prompt = 'after';
  payload.systemPrompt = 'system-after';
  payload.maxOutputTokens = 999;
  payload.maxModelCallsForRequest = 9;
  assert.equal(typeof repo.releaseLoad, 'function');
  repo.releaseLoad();

  await pending;
  assert.equal(seen[0].prompt, 'before');
  assert.equal(seen[0].options.systemPrompt, 'system-before');
  assert.equal(seen[0].options.maxOutputTokens, 64);
  assert.equal(seen[0].options.maxModelCallsForRequest, 1);
});

test('durable vision intent and actual image input must agree before provider use', async () => {
  let calls = 0;
  const nonVision = internalAgentEnvelope();
  const nonVisionDispatcher = new CoreCommandDispatcher(
    new MemoryRepo(stateForEnvelope(nonVision)),
    () => 2_000,
    { aiOrchestrator: { async run() { calls += 1; return {}; } } },
  );
  await assert.rejects(
    nonVisionDispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      {
        prompt: 'x',
        maxOutputTokens: 32,
        imageDataUrl: 'data:image/png;base64,AAAA',
      },
      internal(nonVision),
    ),
    /image input does not match durable requiresVision intent/u,
  );

  const vision = internalAgentEnvelope({ requiresVision: true });
  vision.settings.routes[0].supportsVision = true;
  const visionDispatcher = new CoreCommandDispatcher(
    new MemoryRepo(stateForEnvelope(vision)),
    () => 2_000,
    { aiOrchestrator: { async run() { calls += 1; return {}; } } },
  );
  await assert.rejects(
    visionDispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'x', maxOutputTokens: 32 },
      internal(vision),
    ),
    /image input does not match durable requiresVision intent/u,
  );
  assert.equal(calls, 0);
});

test('bound Agent provider inputs reject accessors and coercive output limits before I/O', async () => {
  const envelope = internalAgentEnvelope();
  let calls = 0;
  let reads = 0;
  const dispatcher = new CoreCommandDispatcher(
    new MemoryRepo(stateForEnvelope(envelope)),
    () => 2_000,
    { aiOrchestrator: { async run() { calls += 1; return {}; } } },
  );

  const hostilePayload = { maxOutputTokens: 32 };
  Object.defineProperty(hostilePayload, 'prompt', {
    enumerable: true,
    get() {
      reads += 1;
      return 'x';
    },
  });
  await assert.rejects(
    dispatcher.execute('RUN_AI_ROUTED_PROMPT', hostilePayload, internal(envelope)),
    /prompt must be an enumerable own text data property/u,
  );

  for (const maxOutputTokens of ['32', true, 32.5, -0]) {
    await assert.rejects(
      dispatcher.execute(
        'RUN_AI_ROUTED_PROMPT',
        { prompt: 'x', maxOutputTokens },
        internal(envelope),
      ),
      /requires canonical bounded maxOutputTokens/u,
    );
  }
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('invocation clock cannot move behind provider-fence revalidation time', async () => {
  const envelope = internalAgentEnvelope();
  let calls = 0;
  const dispatcher = new CoreCommandDispatcher(
    new MemoryRepo(stateForEnvelope(envelope)),
    () => 1_499,
    { aiOrchestrator: { async run() { calls += 1; return {}; } } },
  );
  await assert.rejects(
    dispatcher.execute(
      'RUN_AI_ROUTED_PROMPT',
      { prompt: 'x', maxOutputTokens: 32 },
      internal(envelope),
    ),
    /invocation time is stale or invalid/u,
  );
  assert.equal(calls, 0);
});
