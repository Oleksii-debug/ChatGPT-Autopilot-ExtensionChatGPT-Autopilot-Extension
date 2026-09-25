import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSimplifiedPortableProfile, buildSimplifiedSessionConfig } from '../src/ui/simplified-session-config.js';
import { sessionFromUi } from '../src/core/commands.js';
import { createEmptyState, validateState } from '../src/core/schema.js';
import { applyPortableProfile, exportPortableProfile } from '../src/core/portable-profile.js';

const fields = overrides => ({
  name: 'Autosport', mode: 'shared-shared', url: 'https://chatgpt.com/',
  prompt: 'Продовжуй розробку.', urls: '', prompts: '',
  cycles: '1000000', runMode: 'continuous',
  interval: '2', intervalUnit: 'minutes', delay: '20', busy: '2', retry: '30',
  retryPolicy: 'safe', tabs: 'keep-open', ...overrides,
});
let next = 0;
const id = () => `id-${++next}`;

test('one ChatGPT link and prompt represent one million cycles with a single physical task', () => {
  const config = buildSimplifiedSessionConfig(fields(), null, id);
  const session = sessionFromUi(config, 100);
  assert.equal(session.configuredTaskCount, 1_000_000);
  assert.equal(session.taskOrder.length, 1);
  assert.equal(session.simplifiedSession, true);
  assert.equal(session.runMode, 'CONTINUOUS');
  const state = createEmptyState(100);
  state.sessionOrder.push(session.id);
  state.sessionsById[session.id] = session;
  assert.doesNotThrow(() => validateState(state));
  const exported = exportPortableProfile(state, { sessionIds: [session.id] });
  const reloaded = createEmptyState(200);
  applyPortableProfile(reloaded, exported, { now: 200 });
  assert.equal(reloaded.sessionsById[session.id].simplifiedSession, true);
  assert.equal(reloaded.sessionsById[session.id].configuredTaskCount, 1_000_000);
  assert.equal(reloaded.sessionsById[session.id].taskOrder.length, 1);
});

test('four link and prompt modes bind tasks without generating surplus tasks', () => {
  const cases = [
    ['shared-shared', { cycles: '4' }, 1, 4],
    ['shared-unique', { prompts: 'Перший\n---\nДругий' }, 2, 2],
    ['unique-shared', { urls: 'https://chatgpt.com/c/one\nhttps://chatgpt.com/c/two' }, 2, 2],
    ['unique-unique', { urls: 'https://chatgpt.com/c/one\nhttps://chatgpt.com/c/two', prompts: 'Перший\n---\nДругий' }, 2, 2],
  ];
  for (const [mode, values, physical, logical] of cases) {
    const config = buildSimplifiedSessionConfig(fields({ mode, ...values }), null, id);
    const session = sessionFromUi(config, 100);
    assert.equal(session.taskOrder.length, physical, mode);
    assert.equal(session.configuredTaskCount, logical, mode);
  }
});

test('invalid unequal lists and cycle bounds fail before persistent mutation', () => {
  assert.throws(() => buildSimplifiedSessionConfig(fields({ mode: 'unique-unique',
    urls: 'https://chatgpt.com/c/one\nhttps://chatgpt.com/c/two', prompts: 'Лише один' }), null, id), /Кількість/);
  assert.throws(() => buildSimplifiedSessionConfig(fields({ cycles: '1000001' }), null, id), /Цикли/);
  assert.throws(() => buildSimplifiedSessionConfig(fields({ prompt: '' }), null, id), /промпт/);
});


test('simplified import rejects generic or mixed portable profiles before Core mutation', () => {
  const simplified = { id: 'simplified-1', simplifiedSession: true };
  const profile = { sessions: [simplified] };
  assert.equal(assertSimplifiedPortableProfile(profile), profile);

  assert.throws(
    () => assertSimplifiedPortableProfile({ sessions: [{ id: 'ordinary-1' }] }),
    /явним прапорцем simplifiedSession=true/,
  );
  assert.throws(
    () => assertSimplifiedPortableProfile({
      sessions: [simplified, { id: 'ordinary-2', simplifiedSession: false }],
    }),
    /явним прапорцем simplifiedSession=true/,
  );

  let reads = 0;
  const accessor = { id: 'accessor-1' };
  Object.defineProperty(accessor, 'simplifiedSession', {
    enumerable: true,
    get() { reads += 1; return true; },
  });
  assert.throws(
    () => assertSimplifiedPortableProfile({ sessions: [accessor] }),
    /simplifiedSession=true/,
  );
  assert.equal(reads, 0);
});
