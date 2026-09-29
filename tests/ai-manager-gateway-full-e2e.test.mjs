import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayServer } from '../companion/ai-gateway/gateway.mjs';
import { AiGatewayClient } from '../src/core/ai-gateway-client.js';
import { AiOrchestrator, AiRouterMode } from '../src/core/ai-orchestrator.js';
import { AiAutonomyManager, DEFAULT_AI_MANAGER_SETTINGS } from '../src/core/ai-manager.js';
import { CoreCommandDispatcher } from '../src/core/commands.js';
import { composePromptForSession } from '../src/core/automatic-executor.js';
import { createEmptyState, createSession, createTask, PromptMode, RunMode, RunState, TabStrategy, validateState } from '../src/core/schema.js';
import { CoreCommand } from '../src/shared/protocol.js';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

class MemoryRepo {
  constructor(state) { this.state = structuredClone(state); }
  async load() { return structuredClone(this.state); }
  async update(mutator) {
    const draft = structuredClone(this.state);
    const next = await mutator(draft) || draft;
    next.revision = this.state.revision + 1;
    validateState(next);
    this.state = next;
    return structuredClone(this.state);
  }
}

test('web event -> AI Manager -> real HTTP Gateway -> Ollama escalation -> OpenAI strong -> HANDOFF_NEXT', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'e2e-secret';
  const upstream = [];
  const fetchFn = async (url, init = {}) => {
    upstream.push([String(url), init]);
    if (String(url).endsWith('/api/chat')) {
      return response({ message: { content: '[[ESCALATE]] Local model requests stronger review before acting.' } });
    }
    if (String(url).endsWith('/responses')) {
      return response({
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({
          summary: 'strong review selected next work',
          actions: [{ type: 'HANDOFF_NEXT', sessionId: 's1', text: 'Continue with packaging verification after the AI queue change.' }],
        }) }] }],
      });
    }
    return response({ error: { message: `unexpected ${url}` } }, 404);
  };

  const server = createGatewayServer({ fetchFn });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const gatewayUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const state = createEmptyState(1);
    const task = createTask({ id: 't1', url: 'https://chatgpt.com/' });
    const session = createSession({
      id: 's1', name: 'Worker', tasks: [task], sharedPrompt: 'ORIGINAL WEB WORK',
      promptMode: PromptMode.SHARED, runMode: RunMode.ONE_PASS,
      tabStrategy: TabStrategy.OPEN_CLOSE_PER_TASK, now: 1,
    });
    session.runState = RunState.RUNNING;
    state.sessionsById.s1 = session;
    state.sessionOrder = ['s1'];
    state.profile.aiRouter = {
      ...state.profile.aiRouter,
      enabled: true,
      gatewayUrl,
      mode: AiRouterMode.HYBRID_AUTO,
      primary: { provider: 'ollama', model: 'local-small' },
      strong: { provider: 'openai', model: 'strong-model' },
    };
    state.profile.aiManager = {
      ...DEFAULT_AI_MANAGER_SETTINGS,
      enabled: true,
      triggerEveryNSends: 1,
      triggerEveryMinutes: 0,
      triggerOnComplete: false,
      triggerOnErrors: false,
      triggerOnWebReport: false,
      captureWebReports: false,
    };

    const repo = new MemoryRepo(state);
    const gatewayClient = new AiGatewayClient();
    const orchestrator = new AiOrchestrator({ gatewayClient, now: () => 10_000 });
    const dispatcher = new CoreCommandDispatcher(repo, () => 10_000, { aiGatewayClient: gatewayClient, aiOrchestrator: orchestrator });
    const manager = new AiAutonomyManager({
      repository: repo,
      now: () => 10_000,
      routePrompt: payload => dispatcher.execute(CoreCommand.RUN_AI_ROUTED_PROMPT, payload),
    });

    await manager.capture([{ sessionId: 's1', result: { kind: 'SENT' } }]);
    const decision = await manager.process();
    assert.equal(decision.kind, 'AI_MANAGER_DECISION_APPLIED');
    assert.equal(decision.route, 'strong');
    assert.equal(decision.applied.length, 1);
    assert.equal(decision.applied[0].type, 'HANDOFF_NEXT');

    const live = await repo.load();
    assert.equal(live.profile.aiRouterRuntime.primaryCount, 1);
    assert.equal(live.profile.aiRouterRuntime.strongCount, 1);
    assert.equal(live.profile.aiRouterRuntime.lastRoute, 'strong');
    const nextPrompt = composePromptForSession(live.sessionsById.s1, live.sessionsById.s1.tasksById.t1);
    assert.match(nextPrompt, /^ORIGINAL WEB WORK/);
    assert.match(nextPrompt, /Continue with packaging verification after the AI queue change/);

    assert.equal(upstream.filter(([url]) => url.endsWith('/api/chat')).length, 1);
    assert.equal(upstream.filter(([url]) => url.endsWith('/responses')).length, 1);
    const strongPayload = JSON.parse(upstream.find(([url]) => url.endsWith('/responses'))[1].body);
    assert.match(strongPayload.input, /PRIMARY\/LOCAL WORKER REPORT OR DRAFT/);
    assert.match(strongPayload.input, /Local model requests stronger review/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});
