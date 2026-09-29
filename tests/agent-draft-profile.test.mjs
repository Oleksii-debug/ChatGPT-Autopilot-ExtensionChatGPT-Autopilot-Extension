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

test('Agent draft keeps the selected route but rejects an invalid route identifier', () => {
  const draft = makeAgentDraftProfile('Виконати завдання', { aiPinnedRouteId:'mistral-agent' });
  assert.equal(parseAgentDraftProfile(draft).policy.aiPinnedRouteId, 'mistral-agent');
  assert.throws(() => makeAgentDraftProfile('Виконати завдання', { aiPinnedRouteId:'bad route' }), /route ID/);
});

test('Agent draft rejects unknown and secret fields instead of importing them', () => {
  const draft = makeAgentDraftProfile('Зробити завдання', {});
  assert.throws(() => parseAgentDraftProfile({ ...draft, runtime: { runState: 'RUNNING' } }), /формат/);
  assert.throws(() => parseAgentDraftProfile({ ...draft, policy: { ...draft.policy, apiKey: 'secret' } }), /credentials/);
  assert.throws(() => parseAgentDraftProfile({ ...draft, version: 2 }), /формат/);
  assert.throws(() => parseAgentDraftProfile({ ...draft, goal: '' }), /Завдання/);
});


test('Agent draft rejects accessor-backed top-level and policy fields without executing getters', () => {
  let reads = 0;
  const top = {
    format: 'chatgpt-autopilot-agent-draft',
    version: 1,
    policy: {},
  };
  Object.defineProperty(top, 'goal', {
    enumerable: true,
    get() {
      reads += 1;
      return 'Не виконувати getter';
    },
  });
  assert.throws(() => parseAgentDraftProfile(top), /без getter\/setter/);
  assert.equal(reads, 0);

  const policy = {};
  Object.defineProperty(policy, 'maxSteps', {
    enumerable: true,
    get() {
      reads += 1;
      return 50;
    },
  });
  assert.throws(
    () => parseAgentDraftProfile({
      format: 'chatgpt-autopilot-agent-draft',
      version: 1,
      goal: 'Безпечне завдання',
      policy,
    }),
    /без getter\/setter/,
  );
  assert.equal(reads, 0);
});

test('Agent draft rejects symbol, inherited, sparse and decorated JSON shapes', () => {
  const base = {
    format: 'chatgpt-autopilot-agent-draft',
    version: 1,
    goal: 'Перевірити структуру',
    policy: {},
  };

  const symbolDraft = { ...base };
  symbolDraft[Symbol('runtime')] = true;
  assert.throws(() => parseAgentDraftProfile(symbolDraft), /невідоме поле/);

  const inheritedPolicy = Object.create({ apiKey: 'secret' });
  assert.throws(
    () => parseAgentDraftProfile({ ...base, policy: inheritedPolicy }),
    /звичайним JSON-об’єктом/,
  );

  const acceptanceCriteria = new Array(2);
  acceptanceCriteria[0] = 'Перший критерій';
  assert.throws(
    () => parseAgentDraftProfile({
      ...base,
      policy: { acceptanceCriteria },
    }),
    /щільним масивом/,
  );

  const decorated = ['Критерій'];
  decorated.extra = 'runtime';
  assert.throws(
    () => parseAgentDraftProfile({
      ...base,
      policy: { acceptanceCriteria: decorated },
    }),
    /невідоме поле/,
  );
});

test('Agent draft rejects non-JSON and non-canonical numeric values before Browser Agent normalization', () => {
  const base = {
    format: 'chatgpt-autopilot-agent-draft',
    version: 1,
    goal: 'Перевірити числа',
  };
  for (const value of [NaN, Infinity, -Infinity, -0]) {
    assert.throws(
      () => parseAgentDraftProfile({ ...base, policy: { maxSteps: value } }),
      /неканонічне число/,
    );
  }
  assert.throws(
    () => parseAgentDraftProfile({ ...base, policy: { maxSteps: undefined } }),
    /лише JSON-значення/,
  );
  assert.throws(
    () => parseAgentDraftProfile({ ...base, policy: { maxSteps: () => 10 } }),
    /лише JSON-значення/,
  );
});

test('Agent draft snapshots nested JSON data and canonicalizes goal whitespace', () => {
  const draft = parseAgentDraftProfile({
    format: 'chatgpt-autopilot-agent-draft',
    version: 1,
    goal: '  Перевірити сторінку  ',
    policy: {
      acceptanceCriteria: ['Готово'],
      siteRules: [{
        pattern: 'example.com',
        defaultDecision: 'ASK',
        actionDecisions: {},
      }],
    },
  });
  assert.equal(draft.goal, 'Перевірити сторінку');
  assert.deepEqual(draft.policy.acceptanceCriteria, ['Готово']);
  assert.equal(draft.policy.siteRules[0].pattern, 'example.com');
});


test('Agent draft rejects coercive scalar aliases instead of relying on Browser Agent coercion', () => {
  const base = {
    format: 'chatgpt-autopilot-agent-draft',
    version: 1,
    goal: 'Перевірити точні типи',
  };
  assert.throws(
    () => parseAgentDraftProfile({ ...base, policy: { maxSteps: '300' } }),
    /канонічним числом/,
  );
  assert.throws(
    () => parseAgentDraftProfile({ ...base, policy: { startFromActiveTab: 1 } }),
    /boolean/,
  );
  assert.throws(
    () => parseAgentDraftProfile({ ...base, policy: { aiPinnedRouteId: 123 } }),
    /рядком/,
  );
  assert.throws(
    () => parseAgentDraftProfile({ ...base, policy: { acceptanceCriteria: 'Готово' } }),
    /масивом/,
  );
});

test('Agent draft applies one bounded complexity budget across the whole imported policy', () => {
  const policy = {
    acceptanceCriteria: Array.from({ length: 6000 }, (_, index) => `Критерій ${index}`),
    siteRules: Array.from({ length: 6000 }, (_, index) => ({
      pattern: `sub${index}.example.com`,
      defaultDecision: 'ASK',
      actionDecisions: {},
    })),
  };
  assert.throws(
    () => parseAgentDraftProfile({
      format: 'chatgpt-autopilot-agent-draft',
      version: 1,
      goal: 'Перевірити bounded import',
      policy,
    }),
    /допустимий розмір/,
  );
});
