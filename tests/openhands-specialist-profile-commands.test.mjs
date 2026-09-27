import test from 'node:test';
import assert from 'node:assert/strict';

import { CoreCommandDispatcher } from '../src/core/commands.js';
import { createEmptyState, validateState } from '../src/core/schema.js';
import { OPENHANDS_AGENT_SERVER_VERSION } from '../src/core/coding-specialist-provider.js';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

function config(overrides = {}) {
  return {
    schemaVersion: 1,
    serverUrl: 'http://127.0.0.1:8000',
    agentServerVersion: OPENHANDS_AGENT_SERVER_VERSION,
    agentProfileId: PROFILE_ID,
    agentProfileRevision: 7,
    workspacePath: 'C:\\Autopilot Work\\coding-001',
    qualifiedCapabilityIds: ['coding.workspace'],
    requestTimeoutSeconds: 5,
    maxExecutionSeconds: 2,
    pollIntervalMs: 100,
    maxIterations: 50,
    maxResponseBytes: 100_000,
    authMode: 'LOCAL_UNAUTHENTICATED',
    ...overrides,
  };
}

class MemoryRepo {
  constructor(state = createEmptyState(1000)) {
    this.state = structuredClone(state);
    this.updateCalls = 0;
  }
  async load() {
    return structuredClone(this.state);
  }
  async update(mutator) {
    this.updateCalls += 1;
    const draft = structuredClone(this.state);
    const next = await mutator(draft) || draft;
    next.revision = this.state.revision + 1;
    validateState(next);
    this.state = next;
    return structuredClone(this.state);
  }
}

test('OpenHands specialist profile is explicitly unconfigured and remains schema-v2 backwards compatible', () => {
  const state = createEmptyState(1000);
  assert.equal(state.profile.openHandsCodingSpecialist, null);
  assert.doesNotThrow(() => validateState(state));

  const legacy = structuredClone(state);
  delete legacy.profile.openHandsCodingSpecialist;
  assert.doesNotThrow(() => validateState(legacy));
});

test('owner-qualified OpenHands specialist profile round-trips through the canonical profile store', async () => {
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);
  const saved = await dispatcher.execute('UPDATE_OPENHANDS_SPECIALIST_PROFILE', {
    config: config({ qualifiedCapabilityIds: ['git.write', 'coding.workspace'] }),
  });

  assert.deepEqual(saved.config.qualifiedCapabilityIds, ['coding.workspace', 'git.write']);
  assert.equal(saved.config.serverUrl, 'http://127.0.0.1:8000');
  assert.equal(repo.updateCalls, 1);

  saved.config.workspacePath = 'C:\\mutated-return-only';
  saved.config.qualifiedCapabilityIds.push('mutated.return');

  const loaded = await dispatcher.execute('GET_OPENHANDS_SPECIALIST_PROFILE');
  assert.equal(loaded.config.workspacePath, 'C:\\Autopilot Work\\coding-001');
  assert.deepEqual(loaded.config.qualifiedCapabilityIds, ['coding.workspace', 'git.write']);
  assert.deepEqual(repo.state.profile.openHandsCodingSpecialist, loaded.config);
});

test('OpenHands specialist profile can be explicitly cleared without inventing fallback authority', async () => {
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);
  await dispatcher.execute('UPDATE_OPENHANDS_SPECIALIST_PROFILE', { config: config() });
  const cleared = await dispatcher.execute('UPDATE_OPENHANDS_SPECIALIST_PROFILE', { config: null });
  assert.deepEqual(cleared, { config: null });
  assert.equal(repo.state.profile.openHandsCodingSpecialist, null);
  assert.deepEqual(await dispatcher.execute('GET_OPENHANDS_SPECIALIST_PROFILE'), { config: null });
});

test('invalid OpenHands owner profile fails before durable mutation', async () => {
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);

  const invalid = [
    config({ serverUrl: 'https://example.com:8000' }),
    config({ agentServerVersion: '1.49.4' }),
    config({ workspacePath: 'relative\\repo' }),
    config({ qualifiedCapabilityIds: ['coding.workspace', 'coding.workspace'] }),
  ];
  for (const raw of invalid) {
    const before = structuredClone(repo.state);
    const updates = repo.updateCalls;
    await assert.rejects(
      () => dispatcher.execute('UPDATE_OPENHANDS_SPECIALIST_PROFILE', { config: raw }),
    );
    assert.equal(repo.updateCalls, updates);
    assert.deepEqual(repo.state, before);
  }
});

test('OpenHands profile command and config boundaries reject accessors without invoking them', async () => {
  const repo = new MemoryRepo();
  const dispatcher = new CoreCommandDispatcher(repo, () => 2000);

  let payloadGetterInvoked = false;
  const hostilePayload = {};
  Object.defineProperty(hostilePayload, 'config', {
    enumerable: true,
    get() {
      payloadGetterInvoked = true;
      return config();
    },
  });
  await assert.rejects(
    () => dispatcher.execute('UPDATE_OPENHANDS_SPECIALIST_PROFILE', hostilePayload),
    /own data property/,
  );
  assert.equal(payloadGetterInvoked, false);
  assert.equal(repo.updateCalls, 0);

  let configGetterInvoked = false;
  const hostileConfig = config();
  Object.defineProperty(hostileConfig, 'serverUrl', {
    enumerable: true,
    get() {
      configGetterInvoked = true;
      return 'http://127.0.0.1:8000';
    },
  });
  await assert.rejects(
    () => dispatcher.execute('UPDATE_OPENHANDS_SPECIALIST_PROFILE', { config: hostileConfig }),
    /data property/,
  );
  assert.equal(configGetterInvoked, false);
  assert.equal(repo.updateCalls, 0);
});

test('persisted corrupt OpenHands profile is rejected by canonical state validation', () => {
  const state = createEmptyState(1000);
  state.profile.openHandsCodingSpecialist = config({ serverUrl: 'https://remote.example:8000' });
  assert.throws(() => validateState(state), /local http|localhost/);
});
