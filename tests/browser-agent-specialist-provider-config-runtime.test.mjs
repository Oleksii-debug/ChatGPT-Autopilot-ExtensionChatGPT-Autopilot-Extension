import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import {
  OPENHANDS_AGENT_SERVER_VERSION,
  OPENHANDS_CODING_PROVIDER_ID,
} from '../src/core/coding-specialist-provider.js';
import {
  SpecialistProviderConfigKind,
  createSpecialistProviderConfigV1,
} from '../src/core/specialist-provider-config.js';

const T0 = '2026-09-29T04:30:00.000Z';
const T1 = '2026-09-29T04:31:00.000Z';

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

function managerFor(chrome) {
  return new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
  });
}

function providerConfig(revision = 1, updatedAt = T0, overrides = {}) {
  return createSpecialistProviderConfigV1({
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    kind: SpecialistProviderConfigKind.OPENHANDS_AGENT_SERVER,
    revision,
    updatedAt,
    config: {
      schemaVersion: 1,
      serverUrl: 'http://127.0.0.1:3000',
      agentServerVersion: OPENHANDS_AGENT_SERVER_VERSION,
      agentProfileId: '11111111-1111-4111-8111-111111111111',
      agentProfileRevision: revision,
      workspacePath: 'C:\\Autopilot\\workspace',
      qualifiedCapabilityIds: ['code.write'],
      requestTimeoutSeconds: 10,
      maxExecutionSeconds: 600,
      pollIntervalMs: 500,
      maxIterations: 30,
      maxResponseBytes: 65536,
      authMode: 'LOCAL_UNAUTHENTICATED',
      ...overrides,
    },
  });
}

test('Specialist provider config persists in the canonical BrowserAgent store and survives restart', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const first = providerConfig();

  const committed = await manager.putSpecialistProviderConfig({
    providerConfig: first,
    expectedRevision: 0,
  });
  assert.deepEqual(committed.providerConfig, first);

  const restarted = managerFor(chrome);
  const fetched = await restarted.getSpecialistProviderConfig(OPENHANDS_CODING_PROVIDER_ID);
  assert.deepEqual(fetched.providerConfig, first);
  assert.equal(fetched.quarantined, false);

  const listed = await restarted.listSpecialistProviderConfigs();
  assert.deepEqual(listed.configs, [first]);
  assert.deepEqual(listed.quarantinedProviderIds, []);
});

test('Specialist provider config uses exact compare-and-swap revision and monotonic time', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.putSpecialistProviderConfig({
    providerConfig: providerConfig(),
    expectedRevision: 0,
  });

  await assert.rejects(
    () => manager.putSpecialistProviderConfig({
      providerConfig: providerConfig(2, T1),
      expectedRevision: 0,
    }),
    /revision drifted/,
  );

  await assert.rejects(
    () => manager.putSpecialistProviderConfig({
      providerConfig: providerConfig(3, T1),
      expectedRevision: 1,
    }),
    /increment revision exactly once/,
  );

  await assert.rejects(
    () => manager.putSpecialistProviderConfig({
      providerConfig: providerConfig(2, '2026-09-29T04:29:00.000Z'),
      expectedRevision: 1,
    }),
    /cannot move backwards/,
  );

  const second = providerConfig(2, T1);
  const committed = await manager.putSpecialistProviderConfig({
    providerConfig: second,
    expectedRevision: 1,
  });
  assert.deepEqual(committed.providerConfig, second);
});

test('corrupt Specialist provider config is quarantined and cannot be silently overwritten', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.putSpecialistProviderConfig({
    providerConfig: providerConfig(),
    expectedRevision: 0,
  });

  data.autopilotBrowserAgentV1.specialistProviderConfigsById[OPENHANDS_CODING_PROVIDER_ID].revision = 0;

  const restarted = managerFor(chrome);
  const fetched = await restarted.getSpecialistProviderConfig(OPENHANDS_CODING_PROVIDER_ID);
  assert.equal(fetched.providerConfig, null);
  assert.equal(fetched.quarantined, true);

  const listed = await restarted.listSpecialistProviderConfigs();
  assert.deepEqual(listed.configs, []);
  assert.deepEqual(listed.quarantinedProviderIds, [OPENHANDS_CODING_PROVIDER_ID]);

  await assert.rejects(
    () => restarted.putSpecialistProviderConfig({
      providerConfig: providerConfig(),
      expectedRevision: 0,
    }),
    /quarantined/,
  );
});

test('Specialist provider config admission rejects accessor-backed authority without invoking getters', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  let reads = 0;
  const request = {
    providerConfig: providerConfig(),
    expectedRevision: 0,
  };
  Object.defineProperty(request, 'expectedRevision', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 0;
    },
  });

  await assert.rejects(
    () => manager.putSpecialistProviderConfig(request),
    /enumerable data property/,
  );
  assert.equal(reads, 0);

  const fetched = await manager.getSpecialistProviderConfig(OPENHANDS_CODING_PROVIDER_ID);
  assert.equal(fetched.providerConfig, null);
  assert.equal(fetched.quarantined, false);
});

test('Specialist provider config input is snapshotted before asynchronous storage reads', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const input = providerConfig();

  const pending = manager.putSpecialistProviderConfig({
    providerConfig: input,
    expectedRevision: 0,
  });

  const committed = await pending;
  assert.equal(committed.providerConfig.config.workspacePath, 'C:\\Autopilot\\workspace');
  assert.equal(committed.providerConfig.revision, 1);
});


test('provider config clear preserves a durable revision tombstone and blocks ABA recreation', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.putSpecialistProviderConfig({
    providerConfig: providerConfig(),
    expectedRevision: 0,
  });

  const cleared = await manager.clearSpecialistProviderConfig({
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    expectedRevision: 1,
  });
  assert.deepEqual(cleared, {
    providerId: OPENHANDS_CODING_PROVIDER_ID,
    cleared: true,
    revision: 2,
  });

  const restarted = managerFor(chrome);
  const empty = await restarted.getSpecialistProviderConfig(OPENHANDS_CODING_PROVIDER_ID);
  assert.equal(empty.providerConfig, null);
  assert.equal(empty.revision, 2);
  assert.equal(empty.quarantined, false);

  await assert.rejects(
    () => restarted.putSpecialistProviderConfig({
      providerConfig: providerConfig(1, T1),
      expectedRevision: 0,
    }),
    /revision drifted/,
  );

  const recreated = providerConfig(3, T1);
  const committed = await restarted.putSpecialistProviderConfig({
    providerConfig: recreated,
    expectedRevision: 2,
  });
  assert.equal(committed.revision, 3);
  assert.deepEqual(committed.providerConfig, recreated);
});

test('provider config clear is exact-revision fenced and leaves active config unchanged on stale request', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const current = providerConfig();
  await manager.putSpecialistProviderConfig({
    providerConfig: current,
    expectedRevision: 0,
  });

  await assert.rejects(
    () => manager.clearSpecialistProviderConfig({
      providerId: OPENHANDS_CODING_PROVIDER_ID,
      expectedRevision: 2,
    }),
    /revision drifted/,
  );

  const fetched = await manager.getSpecialistProviderConfig(OPENHANDS_CODING_PROVIDER_ID);
  assert.deepEqual(fetched.providerConfig, current);
  assert.equal(fetched.revision, 1);
});
