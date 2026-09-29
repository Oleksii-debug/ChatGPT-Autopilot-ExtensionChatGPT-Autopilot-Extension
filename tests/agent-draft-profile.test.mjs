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
      /канонічним числом/,
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


test('Agent draft rejects unknown or non-canonical enum aliases instead of silently falling back', () => {
  const base = {
    format: 'chatgpt-autopilot-agent-draft',
    version: 1,
    goal: 'Перевірити enum admission',
  };
  const invalid = [
    ['repeatMode', 'sometimes'],
    ['approvalMode', 'allow_all'],
    ['credentialDecision', 'ask'],
    ['aiRoutingMode', 'PRIMARY'],
    ['aiPrimaryProvider', 'other-provider'],
    ['aiStrongProvider', 'OPENAI'],
  ];
  for (const [key, value] of invalid) {
    assert.throws(
      () => parseAgentDraftProfile({ ...base, policy: { [key]: value } }),
      /непідтримуване значення/,
      key,
    );
  }

  const valid = parseAgentDraftProfile({
    ...base,
    policy: {
      repeatMode: 'INTERVAL',
      intervalSeconds: 60,
      approvalMode: 'CONSEQUENTIAL',
      credentialDecision: 'ASK',
      aiRoutingMode: 'primary',
      aiPrimaryProvider: 'openai-compatible',
      aiPrimaryModel: 'model-a',
      aiStrongProvider: 'inherit',
    },
  });
  assert.equal(valid.policy.repeatMode, 'INTERVAL');
  assert.equal(valid.policy.credentialDecision, 'ASK');
  assert.equal(valid.policy.aiRoutingMode, 'primary');
  assert.equal(valid.policy.aiPrimaryProvider, 'openai-compatible');
});

test('Agent draft rejects non-canonical nested site policy decisions before fallback normalization', () => {
  const base = {
    format: 'chatgpt-autopilot-agent-draft',
    version: 1,
    goal: 'Перевірити site policy',
  };
  assert.throws(
    () => parseAgentDraftProfile({
      ...base,
      policy: {
        siteRules: [{
          pattern: 'example.com',
          defaultDecision: 'ask',
          actionDecisions: {},
        }],
      },
    }),
    /непідтримуване значення/,
  );
  assert.throws(
    () => parseAgentDraftProfile({
      ...base,
      policy: {
        siteRules: [{
          pattern: 'example.com',
          defaultDecision: 'ASK',
          actionDecisions: { credentials: 'allow' },
        }],
      },
    }),
    /непідтримуване значення/,
  );

  const draft = parseAgentDraftProfile({
    ...base,
    policy: {
      siteRules: [{
        pattern: 'example.com',
        defaultDecision: 'ASK',
        actionDecisions: { credentials: 'DENY' },
      }],
    },
  });
  assert.equal(draft.policy.siteRules[0].defaultDecision, 'ASK');
  assert.equal(draft.policy.siteRules[0].actionDecisions.credentials, 'DENY');
});


test('Agent draft rejects numeric fallback, rounding and out-of-range aliases', () => {
  const base = {
    format: 'chatgpt-autopilot-agent-draft',
    version: 1,
    goal: 'Перевірити числові межі',
  };
  const invalid = [
    ['maxSteps', 0],
    ['maxSteps', 10001],
    ['maxSteps', 3.5],
    ['stepDelayMs', 60001],
    ['intervalSeconds', 0],
    ['intervalSeconds', 604801],
    ['maxModelCalls', 1000001],
    ['maxInputTokens', 2000000001],
    ['maxOutputTokensPerCall', 127],
    ['maxOutputTokensPerCall', 200001],
    ['maxRuntimeMinutes', 525601],
    ['maxCostUsd', -1],
    ['inputPricePerMillionUsd', 1000001],
    ['scheduleStartAt', 1.5],
    ['scheduleEndAt', -1],
  ];
  for (const [key, value] of invalid) {
    assert.throws(
      () => parseAgentDraftProfile({ ...base, policy: { [key]: value } }),
      /(межі|timestamp)/,
      `${key}=${value}`,
    );
  }
});

test('Agent draft rejects silent string truncation at provider and route identities', () => {
  const base = {
    format: 'chatgpt-autopilot-agent-draft',
    version: 1,
    goal: 'Перевірити текстові межі',
  };
  assert.throws(
    () => parseAgentDraftProfile({ ...base, policy: { aiPrimaryModel: `m${'x'.repeat(300)}` } }),
    /model ID/,
  );
  assert.throws(
    () => parseAgentDraftProfile({ ...base, policy: { aiPrimaryModel: ' model-a' } }),
    /model ID/,
  );
  assert.throws(
    () => parseAgentDraftProfile({ ...base, policy: { aiPinnedRouteId: `r${'x'.repeat(180)}` } }),
    /route ID/,
  );
  assert.throws(
    () => parseAgentDraftProfile({ ...base, policy: { aiPinnedRouteId: ' route-a' } }),
    /route ID/,
  );
  assert.throws(
    () => parseAgentDraftProfile({ ...base, policy: { startUrl: `https://example.com/${'x'.repeat(4096)}` } }),
    /4096/,
  );
});

test('Agent draft rejects nested site-rule unknown fields and lossy text bounds', () => {
  const base = {
    format: 'chatgpt-autopilot-agent-draft',
    version: 1,
    goal: 'Перевірити вкладені межі',
  };
  assert.throws(
    () => parseAgentDraftProfile({
      ...base,
      policy: {
        siteRules: [{
          pattern: 'example.com',
          defaultDecision: 'ASK',
          actionDecisions: {},
          credentialToken: 'secret',
        }],
      },
    }),
    /невідоме поле/,
  );
  assert.throws(
    () => parseAgentDraftProfile({
      ...base,
      policy: {
        siteRules: [{
          pattern: `${'a'.repeat(490)}.example.com`,
          defaultDecision: 'ASK',
          actionDecisions: {},
        }],
      },
    }),
    /500 символів/,
  );
  assert.throws(
    () => parseAgentDraftProfile({
      ...base,
      policy: { acceptanceCriteria: ['x'.repeat(1001)] },
    }),
    /1000 символів/,
  );
});

test('Agent draft rejects schedule chronology inversion before normalization', () => {
  assert.throws(
    () => parseAgentDraftProfile({
      format: 'chatgpt-autopilot-agent-draft',
      version: 1,
      goal: 'Перевірити календар',
      policy: { scheduleStartAt: 2000, scheduleEndAt: 1000 },
    }),
    /пізніше scheduleStartAt/,
  );
});


test('Agent draft rejects startUrl secrets and lossy URL aliases', () => {
  const base = {
    format: 'chatgpt-autopilot-agent-draft',
    version: 1,
    goal: 'Перевірити URL',
  };
  const invalid = [
    [' https://example.com/', /канонічним URL/],
    ['https://user:secret@example.com/', /credentials/],
    ['https://example.com/page#secret-state', /fragment/],
    ['file:///tmp/private', /HTTP\(S\)/],
    ['not a url', /валідним HTTP\(S\) URL/],
  ];
  for (const [startUrl, pattern] of invalid) {
    assert.throws(
      () => parseAgentDraftProfile({ ...base, policy: { startUrl } }),
      pattern,
      startUrl,
    );
  }
  const draft = parseAgentDraftProfile({ ...base, policy: { startUrl: 'https://example.com/path' } });
  assert.equal(draft.policy.startUrl, 'https://example.com/path');
});

test('Agent draft requires exact and complete active-window identities', () => {
  const base = {
    format: 'chatgpt-autopilot-agent-draft',
    version: 1,
    goal: 'Перевірити вікно',
  };
  assert.throws(
    () => parseAgentDraftProfile({ ...base, policy: { activeWindowStart: ' 09:00', activeWindowEnd: '17:00' } }),
    /HH:MM/,
  );
  assert.throws(
    () => parseAgentDraftProfile({ ...base, policy: { activeWindowStart: '09:00' } }),
    /start, і end/,
  );
  const draft = parseAgentDraftProfile({
    ...base,
    policy: { activeWindowStart: '09:00', activeWindowEnd: '17:00' },
  });
  assert.equal(draft.policy.activeWindowStart, '09:00');
  assert.equal(draft.policy.activeWindowEnd, '17:00');
});


test('Agent draft requires canonical hostname-only site patterns', () => {
  const base = {
    format: 'chatgpt-autopilot-agent-draft',
    version: 1,
    goal: 'Перевірити site identity',
  };
  for (const pattern of [
    'HTTPS://EXAMPLE.COM/path',
    'https://user:secret@example.com/',
    'Example.com',
    ' example.com',
    'localhost',
    '*.example.*',
  ]) {
    assert.throws(
      () => parseAgentDraftProfile({
        ...base,
        policy: {
          siteRules: [{
            pattern,
            defaultDecision: 'ASK',
            actionDecisions: {},
          }],
        },
      }),
      /(hostname|канонічним hostname)/,
      pattern,
    );
  }

  const exact = parseAgentDraftProfile({
    ...base,
    policy: {
      siteRules: [{
        pattern: '*.example.com',
        defaultDecision: 'ASK',
        actionDecisions: {},
      }],
    },
  });
  assert.equal(exact.policy.siteRules[0].pattern, '*.example.com');
});

test('Agent draft rejects acceptance-criterion whitespace aliases rather than silently trimming them', () => {
  assert.throws(
    () => parseAgentDraftProfile({
      format: 'chatgpt-autopilot-agent-draft',
      version: 1,
      goal: 'Перевірити criteria identity',
      policy: { acceptanceCriteria: [' Готово'] },
    }),
    /канонічним непорожнім рядком/,
  );
});
