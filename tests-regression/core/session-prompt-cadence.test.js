import test from 'node:test';
import assert from 'node:assert/strict';

import { composePromptForSession } from '../../src/core/automatic-executor.js';
import {
  defaultSessionPromptCadence,
  normalizeSessionPromptCadence,
  promptForVerifiedSendOrdinal,
} from '../../src/core/session-prompt-cadence.js';
import { PromptMode, createSession, createTask, validateState, createEmptyState } from '../../src/core/schema.js';

function session({ count = 0, prompt2 = null, prompt3 = null } = {}) {
  const task = createTask({
    id: 't1',
    url: 'https://chatgpt.com/',
    promptOverride: 'unique-primary',
  });
  const value = createSession({
    id: 's1',
    name: 'Session 1',
    tasks: [task],
    promptMode: PromptMode.SHARED,
    sharedPrompt: 'primary',
  });
  value.successfulSendCount = count;
  value.promptCadence = {
    schemaVersion: 1,
    prompt2: prompt2 || { enabled: false, prompt: '', everyN: 10 },
    prompt3: prompt3 || { enabled: false, prompt: '', everyN: 20 },
  };
  return { value, task };
}

test('modern cadence defaults are disabled and preserve primary prompt', () => {
  assert.deepEqual(defaultSessionPromptCadence(), {
    schemaVersion: 1,
    prompt2: { enabled: false, prompt: '', everyN: 10 },
    prompt3: { enabled: false, prompt: '', everyN: 20 },
  });
  const { value } = session();
  assert.equal(promptForVerifiedSendOrdinal(value, value.sharedPrompt), 'primary');
});

test('Prompt 2 is selected on its next verified-send ordinal only', () => {
  const p2 = { enabled: true, prompt: 'prompt-two', everyN: 3 };
  assert.equal(promptForVerifiedSendOrdinal(session({ count: 0, prompt2: p2 }).value, 'primary'), 'primary');
  assert.equal(promptForVerifiedSendOrdinal(session({ count: 1, prompt2: p2 }).value, 'primary'), 'primary');
  assert.equal(promptForVerifiedSendOrdinal(session({ count: 2, prompt2: p2 }).value, 'primary'), 'prompt-two');
  assert.equal(promptForVerifiedSendOrdinal(session({ count: 3, prompt2: p2 }).value, 'primary'), 'primary');
});

test('Prompt 3 deterministically wins when Prompt 2 and Prompt 3 collide', () => {
  const { value } = session({
    count: 11,
    prompt2: { enabled: true, prompt: 'prompt-two', everyN: 3 },
    prompt3: { enabled: true, prompt: 'prompt-three', everyN: 4 },
  });
  assert.equal(promptForVerifiedSendOrdinal(value, 'primary'), 'prompt-three');
});

test('composePromptForSession applies cadence without mutating stored primary prompt', () => {
  const { value, task } = session({
    count: 4,
    prompt2: { enabled: true, prompt: 'prompt-two', everyN: 5 },
  });
  const before = structuredClone(value);
  assert.equal(composePromptForSession(value, task), 'prompt-two');
  assert.deepEqual(value, before);
});

test('unique mode cadence replaces only this physical Send prompt, not task state', () => {
  const { value, task } = session({
    count: 1,
    prompt2: { enabled: true, prompt: 'prompt-two', everyN: 2 },
  });
  value.promptMode = PromptMode.UNIQUE;
  assert.equal(composePromptForSession(value, task), 'prompt-two');
  assert.equal(task.promptOverride, 'unique-primary');
});

test('AI handoff is appended after cadence selection', () => {
  const { value, task } = session({
    count: 1,
    prompt2: { enabled: true, prompt: 'prompt-two', everyN: 2 },
  });
  value.aiCoordinatorHandoff = 'bounded handoff';
  const composed = composePromptForSession(value, task);
  assert.match(composed, /^prompt-two\n\n/u);
  assert.match(composed, /bounded handoff/u);
});

test('cadence config is strict and fail-closed on invalid explicit values or unknown fields', () => {
  assert.throws(
    () => normalizeSessionPromptCadence({
      prompt2: { enabled: true, prompt: 'x', everyN: 1 },
    }),
    /Invalid promptCadence\.prompt2\.everyN/u,
  );
  assert.throws(
    () => normalizeSessionPromptCadence({
      prompt3: { enabled: true, prompt: '', everyN: 20 },
    }),
    /Invalid promptCadence\.prompt3\.prompt/u,
  );
  assert.throws(
    () => normalizeSessionPromptCadence({ hiddenCommand: true }),
    /Invalid promptCadence field/u,
  );
});

test('legacy schema-v2 Session without promptCadence remains valid while new Sessions persist defaults', () => {
  const state = createEmptyState(1000);
  const task = createTask({ id: 't1', url: 'https://chatgpt.com/' });
  const created = createSession({
    id: 's1',
    name: 'Session',
    tasks: [task],
    sharedPrompt: 'primary',
    now: 1000,
  });
  state.sessionsById.s1 = created;
  state.sessionOrder = ['s1'];
  state.logs.s1 = [];
  assert.doesNotThrow(() => validateState(state));
  assert.deepEqual(created.promptCadence, defaultSessionPromptCadence());

  const legacy = structuredClone(state);
  delete legacy.sessionsById.s1.promptCadence;
  assert.doesNotThrow(() => validateState(legacy));
});
