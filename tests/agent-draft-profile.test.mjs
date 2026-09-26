import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgentDraftProfile, parseAgentDraftProfile } from '../src/ui/agent-draft-profile.js';

test('Agent draft round trips a multi-step goal and policy without runtime state or API credentials', () => {
  const draft = makeAgentDraftProfile('Перевірити сторінку й надіслати звіт', {
    startUrl: 'https://chatgpt.com/', maxSteps: 300, repeatMode: 'INTERVAL',
    intervalSeconds: 120, aiPrimaryProvider: 'openai-compatible', aiPrimaryModel: 'mistral-small-latest',
    credentialDecision: 'ASK', approvalMode: 'CONSEQUENTIAL', acceptanceCriteria: ['Звіт підтверджено'],
  });
  const restored = parseAgentDraftProfile(JSON.parse(JSON.stringify(draft)));
  assert.deepEqual(restored, draft);
  assert.equal(restored.policy.aiPrimaryModel, 'mistral-small-latest');
  assert.equal(JSON.stringify(restored).includes('apiKey'), false);
  assert.equal(JSON.stringify(restored).includes('runState'), false);
});

test('Agent draft rejects unknown and secret fields instead of importing them', () => {
  const draft = makeAgentDraftProfile('Зробити завдання', {});
  assert.throws(() => parseAgentDraftProfile({ ...draft, runtime: { runState: 'RUNNING' } }), /формат/);
  assert.throws(() => parseAgentDraftProfile({ ...draft, policy: { ...draft.policy, apiKey: 'secret' } }), /credentials/);
  assert.throws(() => parseAgentDraftProfile({ ...draft, version: 2 }), /формат/);
  assert.throws(() => parseAgentDraftProfile({ ...draft, goal: '' }), /Завдання/);
});
