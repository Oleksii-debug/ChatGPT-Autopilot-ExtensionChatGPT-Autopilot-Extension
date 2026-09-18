import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CadencedRepository,
  getPromptCadenceConfig,
  projectPromptForSession,
  setPromptCadenceConfig,
} from '../../src/core/prompt-cadence.js';
import {
  createDefaultSessionFunctions,
  setSessionFunctionEnabled,
  SessionFunctionId,
} from '../../src/core/session-functions.js';

function state() {
  let activeFunctions = createDefaultSessionFunctions();
  activeFunctions = setSessionFunctionEnabled(activeFunctions, SessionFunctionId.PROMPT_CADENCE, true);
  return {
    profile: { promptCadenceBySessionId: {} },
    sessionsById: {
      s1: {
        id: 's1',
        sharedPrompt: 'primary',
        lastSuccessfulSendAt: 0,
        cadenceVerifiedSendCount: 0,
        runState: 'RUNNING',
        activeFunctions,
        tasksById: { t1: { id: 't1', promptOverride: '' } },
      },
    },
  };
}

function clone(value) { return structuredClone(value); }
function memoryRepo(initial) {
  let stored = clone(initial);
  return {
    async load() { return clone(stored); },
    async update(mutator) {
      const draft = clone(stored);
      stored = clone(await mutator(draft) || draft);
      return clone(stored);
    },
    snapshot() { return clone(stored); },
  };
}
async function recordVerified(repo) {
  await repo.update(draft => {
    draft.sessionsById.s1.cadenceVerifiedSendCount += 1;
    return draft;
  });
}

test('three prompt rules use prompt 1 normally and selected prompt on its configured verified-send ordinal', async () => {
  const initial = state();
  setPromptCadenceConfig(initial, 's1', {
    prompts: [
      { enabled: false, prompt: '', everyN: 10 },
      { enabled: true, prompt: 'prompt-2', everyN: 3 },
      { enabled: true, prompt: 'prompt-3', everyN: 4 },
    ],
  });
  const repo = new CadencedRepository(memoryRepo(initial));

  let loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.sharedPrompt, 'primary');

  await recordVerified(repo);
  loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.sharedPrompt, 'primary');

  await recordVerified(repo);
  loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.sharedPrompt, 'prompt-2');

  await recordVerified(repo);
  loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.sharedPrompt, 'prompt-3');
});

test('when prompt 2 and prompt 3 coincide, prompt 3 wins without changing the saved primary prompt', async () => {
  const initial = state();
  initial.sessionsById.s1.cadenceVerifiedSendCount = 3;
  setPromptCadenceConfig(initial, 's1', {
    prompts: [
      { enabled: false, prompt: '', everyN: 10 },
      { enabled: true, prompt: 'prompt-2', everyN: 2 },
      { enabled: true, prompt: 'prompt-3', everyN: 4 },
    ],
  });
  const base = memoryRepo(initial);
  const repo = new CadencedRepository(base);
  const projected = await repo.load();
  assert.equal(projected.sessionsById.s1.sharedPrompt, 'prompt-3');
  assert.equal(base.snapshot().sessionsById.s1.sharedPrompt, 'primary');
});

test('legacy staged flow consumes the exact verified counter and stops after configured total', async () => {
  const initial = state();
  setPromptCadenceConfig(initial, 's1', {
    prompts: [],
    chatFlow: {
      mode: 'staged',
      continuePrompt: 'продовжуй',
      continueCount: 2,
      stage2Prompt: 'другий',
      stage2Count: 2,
    },
  });
  const repo = new CadencedRepository(memoryRepo(initial));
  for (const expected of ['primary', 'продовжуй', 'продовжуй', 'другий']) {
    const projected = await repo.load();
    assert.equal(projected.sessionsById.s1.sharedPrompt, expected);
    await recordVerified(repo);
  }
  assert.equal((await repo.load()).sessionsById.s1.sharedPrompt, 'другий');
  await recordVerified(repo);
  assert.equal((await repo.load()).sessionsById.s1.runState, 'STOPPED');
});

test('timestamp changes alone never advance cadence verified-send count', async () => {
  const initial = state();
  setPromptCadenceConfig(initial, 's1', { enabled: true, secondaryPrompt: 'secondary', everyN: 2 });
  const repo = new CadencedRepository(memoryRepo(initial));

  await repo.update(draft => {
    draft.sessionsById.s1.lastSuccessfulSendAt = 1000;
    return draft;
  });
  let loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.cadenceVerifiedSendCount, 0);
  assert.equal(loaded.sessionsById.s1.sharedPrompt, 'primary');

  await recordVerified(repo);
  loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.cadenceVerifiedSendCount, 1);
  assert.equal(loaded.sessionsById.s1.sharedPrompt, 'secondary');
});

test('disabled cadence module does not project an alternate prompt but preserves the durable verified counter', async () => {
  const initial = state();
  initial.sessionsById.s1.activeFunctions = setSessionFunctionEnabled(
    initial.sessionsById.s1.activeFunctions,
    SessionFunctionId.PROMPT_CADENCE,
    false,
  );
  initial.sessionsById.s1.cadenceVerifiedSendCount = 7;
  setPromptCadenceConfig(initial, 's1', { enabled: true, secondaryPrompt: 'secondary', everyN: 2 });
  const repo = new CadencedRepository(memoryRepo(initial));
  const loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.cadenceVerifiedSendCount, 7);
  assert.equal(loaded.sessionsById.s1.sharedPrompt, 'primary');
});

test('normalization preserves legacy settings and adds three-rule/chat-flow defaults', () => {
  const s = state();
  assert.deepEqual(getPromptCadenceConfig(s, 's1'), {
    enabled: false,
    prompts: [
      { enabled: false, prompt: '', everyN: 10 },
      { enabled: false, prompt: '', everyN: 10 },
      { enabled: false, prompt: '', everyN: 20 },
    ],
    chatFlow: {
      enabled: false,
      mode: 'same-chat',
      newChatEveryN: 10,
      continuePrompt: 'продовжуй',
      continueCount: 10,
      stage2Prompt: '',
      stage2Count: 10,
    },
  });
});

test('projected prompt selection is deterministic for a chosen next send number', () => {
  const s = state();
  setPromptCadenceConfig(s, 's1', {
    prompts: [
      { enabled: false, prompt: '', everyN: 10 },
      { enabled: true, prompt: 'second', everyN: 5 },
      { enabled: true, prompt: 'third', everyN: 8 },
    ],
  });
  s.sessionsById.s1.cadenceVerifiedSendCount = 7;
  assert.equal(projectPromptForSession(s, s.sessionsById.s1).sharedPrompt, 'third');
});
