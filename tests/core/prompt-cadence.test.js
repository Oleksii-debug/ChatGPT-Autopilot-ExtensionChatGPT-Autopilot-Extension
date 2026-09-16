import test from 'node:test';
import assert from 'node:assert/strict';
import { CadencedRepository, getPromptCadenceConfig, projectPromptForSession, setPromptCadenceConfig } from '../../src/core/prompt-cadence.js';

function state() {
  return {
    profile: { promptCadenceBySessionId: {} },
    sessionsById: {
      s1: {
        id: 's1',
        sharedPrompt: 'primary',
        lastSuccessfulSendAt: 0,
        cadenceVerifiedSendCount: 0,
        runState: 'RUNNING',
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
      const result = await mutator(draft);
      stored = clone(result || draft);
      return clone(stored);
    },
    snapshot() { return clone(stored); },
  };
}

test('three prompt rules use prompt 1 normally and selected prompt on its configured send', async () => {
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

  await repo.update(d => { d.sessionsById.s1.lastSuccessfulSendAt = 1; return d; });
  loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.sharedPrompt, 'primary');

  await repo.update(d => { d.sessionsById.s1.lastSuccessfulSendAt = 2; return d; });
  loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.sharedPrompt, 'prompt-2');

  await repo.update(d => { d.sessionsById.s1.lastSuccessfulSendAt = 3; return d; });
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

test('staged flow uses the main prompt once, then continue prompt, then second prompt and stops after configured total', async () => {
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
    await repo.update(d => {
      d.sessionsById.s1.lastSuccessfulSendAt += 1;
      return d;
    });
  }
  const projected = await repo.load();
  assert.equal(projected.sessionsById.s1.sharedPrompt, 'другий');
  await repo.update(d => {
    d.sessionsById.s1.lastSuccessfulSendAt += 1;
    return d;
  });
  assert.equal((await repo.load()).sessionsById.s1.runState, 'STOPPED');
});

test('cadence count increments only when lastSuccessfulSendAt advances', async () => {
  const initial = state();
  setPromptCadenceConfig(initial, 's1', { enabled: true, secondaryPrompt: 'secondary', everyN: 2 });
  const repo = new CadencedRepository(memoryRepo(initial));
  await repo.update(draft => { draft.sessionsById.s1.status = 'BUSY'; return draft; });
  let loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.cadenceVerifiedSendCount, 0);

  await repo.update(draft => { draft.sessionsById.s1.lastSuccessfulSendAt = 1000; return draft; });
  loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.cadenceVerifiedSendCount, 1);
  assert.equal(loaded.sessionsById.s1.sharedPrompt, 'primary');

  await repo.update(draft => { draft.sessionsById.s1.lastSuccessfulSendAt = 1100; return draft; });
  loaded = await repo.load();
  assert.equal(loaded.sessionsById.s1.cadenceVerifiedSendCount, 2);
  assert.equal(loaded.sessionsById.s1.sharedPrompt, 'secondary');
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
      mode: 'same-chat',
      newChatEveryN: 10,
      continuePrompt: 'продовжуй',
      continueCount: 10,
      stage2Prompt: '',
      stage2Count: 10,
    },
  });
});

test('projected prompt selection is deterministic for a chosen send number', () => {
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