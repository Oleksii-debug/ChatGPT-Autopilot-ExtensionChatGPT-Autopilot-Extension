import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreCommandDispatcher } from '../src/core/commands.js';
import { createEmptyState, validateState } from '../src/core/schema.js';

class MemoryRepo {
  constructor(state = createEmptyState(1000)) { this.state = structuredClone(state); }
  async load() { return structuredClone(this.state); }
  async update(mutator) {
    const draft = structuredClone(this.state);
    const next = await mutator(draft) || draft;
    next.revision = this.state.revision + 1;
    validateState(next);
    this.state = next;
    return structuredClone(next);
  }
}

test('old schema-v2 states without AI Manager fields remain valid', () => {
  const old = createEmptyState(1000);
  delete old.profile.aiManager;
  delete old.profile.aiManagerRuntime;
  assert.doesNotThrow(() => validateState(old));
});

test('AI Manager settings persist through core commands', async () => {
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);
  const settings = {
    enabled: true,
    autoApplySafeActions: true,
    triggerEveryNSends: 7,
    triggerEveryMinutes: 90,
    triggerOnComplete: true,
    triggerOnErrors: true,
    errorThreshold: 4,
    appendHandoffToNextPrompt: true,
    allowSessionTuning: true,
    handoffMaxChars: 9000,
    contextMaxChars: 30000,
    maxPendingEvents: 250,
    captureWebReports: true,
    triggerOnWebReport: true,
    webReportPollSeconds: 20,
    webReportMaxWaitMinutes: 45,
    webReportMaxChars: 25000,
  };
  await dispatcher.execute('UPDATE_AI_MANAGER_SETTINGS', { settings });
  const loaded = await dispatcher.execute('GET_AI_MANAGER_SETTINGS');
  assert.equal(loaded.settings.triggerEveryNSends, 7);
  assert.equal(loaded.settings.webReportPollSeconds, 20);
  assert.equal(loaded.settings.captureWebReports, true);
  assert.equal(loaded.settings.allowSessionTuning, true);
});
