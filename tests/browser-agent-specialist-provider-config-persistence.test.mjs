import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import {
  OPENHANDS_AGENT_SERVER_VERSION,
  OPENHANDS_CODING_PROVIDER_ID,
} from '../src/core/coding-specialist-provider.js';
import { SpecialistProviderConfigKind } from '../src/core/specialist-provider-config.js';

const T0 = Date.parse('2026-09-27T14:20:00.000Z');

function makeChromeStorage() {
  const data = Object.create(null);
  return {
    data,
    chrome: {
      storage: {
        local: {
          async get(key) { return { [key]: structuredClone(data[key]) }; },
          async set(record) {
            for (const [key, value] of Object.entries(record)) data[key] = structuredClone(value);
          },
        },
      },
      alarms: {
        async create() {},
        async clear() { return true; },
      },
    },
  };
}

function managerFor(chrome, now = () => T0) {
  return new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now,
  });
}

function config(overrides = {}) {
  return {
    schemaVersion: 1,
    serverUrl: 'http://127.0.0.1:3000',
    agentServerVersion: OPENHANDS_AGENT_SERVER_VERSION,
    agentProfileId: '11111111-1111-4111-8111-111111111111',
    agentProfileRevision: 2,
    workspacePath: 'C:\\Autopilot\\workspace',
    qualifiedCapabilityIds: ['code.write'],
    requestTimeoutSeconds: 10,
    maxExecutionSeconds: 600,
    pollIntervalMs: 500,
    maxIterations: 30,
    maxResponseBytes: 65536,
    authMode: 'LOCAL_UNAUTHENTICATED',
    ...overrides,
  };
}

function setRequest(expectedRevision, overrides = {}) {
  return {
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    expectedRevision,
    kind: SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER,
    config: config(),
    ...overrides,
  };
}

test('provider config persists in the existing Browser Agent storage key across restart', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const created = await manager.setSpecialistProviderConfig(setRequest(0));

  assert.equal(created.config.revision, 1);
  assert.equal(created.config.providerId, OPENHANDS_CODING_PROVIDER_ID);
  assert.deepEqual(Object.keys(data), ['autopilotBrowserAgentV1']);

  const restarted = managerFor(chrome);
  const loaded = await restarted.getSpecialistProviderConfig(OPENHANDS_CODING_PROVIDER_ID);
  assert.equal(loaded.quarantined, false);
  assert.equal(loaded.config.revision, 1);
  assert.equal(loaded.config.config.workspacePath, 'C:\\Autopilot\\workspace');

  const listed = await restarted.listSpecialistProviderConfigs();
  assert.deepEqual(listed.configs.map(item => item.providerId), [OPENHANDS_CODING_PROVIDER_ID]);
  assert.deepEqual(listed.quarantinedProviderIds, []);
});

test('provider config CAS is enforced at the serialized write boundary', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.setSpecialistProviderConfig(setRequest(0));

  const first = manager.setSpecialistProviderConfig(setRequest(1, {
    config: config({ agentProfileRevision: 3 }),
  }));
  const second = manager.setSpecialistProviderConfig(setRequest(1, {
    config: config({ agentProfileRevision: 4 }),
  }));
  const results = await Promise.allSettled([first, second]);

  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  assert.match(
    String(results.find(item => item.status === 'rejected').reason),
    /revision drifted/,
  );
  assert.equal(
    (await manager.getSpecialistProviderConfig(OPENHANDS_CODING_PROVIDER_ID)).config.revision,
    2,
  );
});

test('nested provider config is descriptor-snapshotted before serialized enqueue', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const mutable = config();
  const pending = manager.setSpecialistProviderConfig(setRequest(0, { config: mutable }));

  mutable.workspacePath = 'C:\\Mutated';
  mutable.qualifiedCapabilityIds[0] = 'scope.amplified';

  const committed = await pending;
  assert.equal(committed.config.config.workspacePath, 'C:\\Autopilot\\workspace');
  assert.deepEqual(committed.config.config.qualifiedCapabilityIds, ['code.write']);
});

test('provider config rejects nested accessors without getter execution', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  let reads = 0;
  const hostile = config();
  Object.defineProperty(hostile, 'workspacePath', {
    enumerable: true,
    get() {
      reads += 1;
      return 'C:\\Hostile';
    },
  });

  await assert.rejects(
    () => manager.setSpecialistProviderConfig(setRequest(0, { config: hostile })),
    /data property/,
  );
  assert.equal(reads, 0);
});

test('corrupt persisted provider config is quarantined and cannot silently become runtime authority', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.setSpecialistProviderConfig(setRequest(0));
  data.autopilotBrowserAgentV1.specialistProviderConfigsById[OPENHANDS_CODING_PROVIDER_ID].revision = 'broken';

  const restarted = managerFor(chrome);
  const state = await restarted.getSpecialistProviderConfig(OPENHANDS_CODING_PROVIDER_ID);
  assert.equal(state.config, null);
  assert.equal(state.quarantined, true);
  assert.deepEqual(
    (await restarted.listSpecialistProviderConfigs()).quarantinedProviderIds,
    [OPENHANDS_CODING_PROVIDER_ID],
  );
  await assert.rejects(
    () => restarted.setSpecialistProviderConfig(setRequest(0)),
    /quarantined as corrupt/,
  );

  await restarted.updateExecutionPolicy({ maxConcurrentAgents: 2 });
  assert.ok(
    data.autopilotBrowserAgentV1.specialistProviderConfigQuarantineById[OPENHANDS_CODING_PROVIDER_ID],
  );
});

test('clear is revision-fenced and restart durable', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.setSpecialistProviderConfig(setRequest(0));

  await assert.rejects(
    () => manager.clearSpecialistProviderConfig({
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      expectedRevision: 2,
    }),
    /revision drifted/,
  );
  const cleared = await manager.clearSpecialistProviderConfig({
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    expectedRevision: 1,
  });
  assert.equal(cleared.cleared, true);
  assert.equal(
    (await managerFor(chrome).getSpecialistProviderConfig(OPENHANDS_CODING_PROVIDER_ID)).config,
    null,
  );
});
