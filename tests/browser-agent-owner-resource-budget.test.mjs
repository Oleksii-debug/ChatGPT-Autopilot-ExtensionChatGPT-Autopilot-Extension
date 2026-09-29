import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';

const T0 = Date.parse('2026-09-29T04:50:00.000Z');

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
      alarms: { async create() {}, async clear() { return true; } },
    },
  };
}

function managerFor(chrome) {
  return new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    now: () => T0,
  });
}

function budget(maxConcurrentAgents, overrides = {}) {
  return {
    maxConcurrentAgents,
    maxChildAgents: 8,
    maxModelCalls: 100,
    maxModelInputTokens: 100000,
    maxModelOutputTokens: 100000,
    maxRuntimeSeconds: 3600,
    maxCostUsdMicros: 5000000,
    ...overrides,
  };
}

test('owner resource budget is fail-closed by default and persists in the existing BrowserAgent store', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);

  const initial = await manager.getOwnerResourceBudget();
  assert.equal(initial.revision, 0);
  assert.equal(initial.quarantined, false);
  assert.equal(initial.budget.maxConcurrentAgents, 0);

  const blocked = await manager.claimSpecialistHandoffsAcrossJobs({ maxConcurrentHandoffs: 256 });
  assert.equal(blocked.ownerMaxConcurrentAgents, 0);
  assert.equal(blocked.maxConcurrentHandoffs, 0);
  assert.equal(blocked.claimed.length, 0);

  const committed = await manager.setOwnerResourceBudget({
    expectedRevision: 0,
    budget: budget(3),
  });
  assert.equal(committed.revision, 1);
  assert.equal(committed.budget.maxConcurrentAgents, 3);
  assert.deepEqual(Object.keys(data), ['autopilotBrowserAgentV1']);

  const restarted = managerFor(chrome);
  const loaded = await restarted.getOwnerResourceBudget();
  assert.equal(loaded.revision, 1);
  assert.equal(loaded.quarantined, false);
  assert.equal(loaded.budget.maxConcurrentAgents, 3);
});

test('cross-job claim uses the durable owner concurrency ceiling and caller input can only narrow it', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.setOwnerResourceBudget({ expectedRevision: 0, budget: budget(4) });

  const omittedCallerLimit = await manager.claimSpecialistHandoffsAcrossJobs({});
  assert.equal(omittedCallerLimit.requestedMaxConcurrentHandoffs, 256);
  assert.equal(omittedCallerLimit.ownerMaxConcurrentAgents, 4);
  assert.equal(omittedCallerLimit.maxConcurrentHandoffs, 4);
  assert.equal(omittedCallerLimit.ownerResourceBudgetRevision, 1);

  const ownerWins = await manager.claimSpecialistHandoffsAcrossJobs({ maxConcurrentHandoffs: 200 });
  assert.equal(ownerWins.maxConcurrentHandoffs, 4);

  const callerNarrows = await manager.claimSpecialistHandoffsAcrossJobs({ maxConcurrentHandoffs: 2 });
  assert.equal(callerNarrows.maxConcurrentHandoffs, 2);
  assert.equal(callerNarrows.ownerMaxConcurrentAgents, 4);
});

test('owner resource budget CAS is serialized so same-revision concurrent writes cannot both commit', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.setOwnerResourceBudget({ expectedRevision: 0, budget: budget(2) });

  const results = await Promise.allSettled([
    manager.setOwnerResourceBudget({ expectedRevision: 1, budget: budget(3) }),
    manager.setOwnerResourceBudget({ expectedRevision: 1, budget: budget(4) }),
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  assert.match(String(results.find(item => item.status === 'rejected').reason), /revision drifted/);

  const state = await manager.getOwnerResourceBudget();
  assert.equal(state.revision, 2);
  assert.ok([3, 4].includes(state.budget.maxConcurrentAgents));
});

test('nested owner budget is canonicalized before asynchronous storage access', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const mutable = budget(2);
  const pending = manager.setOwnerResourceBudget({ expectedRevision: 0, budget: mutable });
  mutable.maxConcurrentAgents = 99;
  mutable.maxChildAgents = 99;

  const committed = await pending;
  assert.equal(committed.budget.maxConcurrentAgents, 2);
  assert.equal(committed.budget.maxChildAgents, 8);
});

test('owner budget rejects accessors without executing getters', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  let reads = 0;
  const hostile = budget(2);
  Object.defineProperty(hostile, 'maxConcurrentAgents', {
    enumerable: true,
    get() {
      reads += 1;
      return 99;
    },
  });

  await assert.rejects(
    () => manager.setOwnerResourceBudget({ expectedRevision: 0, budget: hostile }),
    /data propert/,
  );
  assert.equal(reads, 0);
  assert.equal((await manager.getOwnerResourceBudget()).revision, 0);
});

test('corrupt persisted owner budget is quarantined, survives normalization and grants zero new capacity', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.setOwnerResourceBudget({ expectedRevision: 0, budget: budget(5) });

  data.autopilotBrowserAgentV1.ownerResourceBudget.maxConcurrentAgents = 'broken';
  const restarted = managerFor(chrome);
  const state = await restarted.getOwnerResourceBudget();
  assert.equal(state.revision, 1);
  assert.equal(state.quarantined, true);
  assert.equal(state.budget.maxConcurrentAgents, 0);

  const claim = await restarted.claimSpecialistHandoffsAcrossJobs({ maxConcurrentHandoffs: 256 });
  assert.equal(claim.maxConcurrentHandoffs, 0);
  assert.equal(claim.ownerResourceBudgetQuarantined, true);

  await assert.rejects(
    () => restarted.setOwnerResourceBudget({ expectedRevision: 1, budget: budget(1) }),
    /quarantined as corrupt/,
  );

  await restarted.update(store => store);
  assert.equal(data.autopilotBrowserAgentV1.ownerResourceBudgetQuarantined, true);
  assert.equal(data.autopilotBrowserAgentV1.ownerResourceBudgetRevision, 1);
});

test('partial persisted owner budget authority is quarantined instead of minting revision-zero capacity', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.setOwnerResourceBudget({ expectedRevision: 0, budget: budget(5) });

  delete data.autopilotBrowserAgentV1.ownerResourceBudgetRevision;
  const restarted = managerFor(chrome);
  const state = await restarted.getOwnerResourceBudget();
  assert.equal(state.revision, 0);
  assert.equal(state.quarantined, true);

  const claim = await restarted.claimSpecialistHandoffsAcrossJobs({ maxConcurrentHandoffs: 256 });
  assert.equal(claim.ownerMaxConcurrentAgents, 0);
  assert.equal(claim.maxConcurrentHandoffs, 0);
  assert.equal(claim.ownerResourceBudgetQuarantined, true);

  await assert.rejects(
    () => restarted.setOwnerResourceBudget({ expectedRevision: 0, budget: budget(1) }),
    /quarantined as corrupt/,
  );
});

test('malformed persisted owner budget quarantine marker fails closed', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.setOwnerResourceBudget({ expectedRevision: 0, budget: budget(5) });

  data.autopilotBrowserAgentV1.ownerResourceBudgetQuarantined = 'false';
  const restarted = managerFor(chrome);
  const state = await restarted.getOwnerResourceBudget();
  assert.equal(state.revision, 1);
  assert.equal(state.quarantined, true);

  const claim = await restarted.claimSpecialistHandoffsAcrossJobs({ maxConcurrentHandoffs: 256 });
  assert.equal(claim.ownerMaxConcurrentAgents, 0);
  assert.equal(claim.maxConcurrentHandoffs, 0);
  assert.equal(claim.ownerResourceBudgetQuarantined, true);
});

test('invalid caller concurrency cannot exploit coercion, signed zero or values above the Specialist cap', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.setOwnerResourceBudget({ expectedRevision: 0, budget: budget(4) });

  await assert.rejects(
    () => manager.claimSpecialistHandoffsAcrossJobs({ maxConcurrentHandoffs: '4' }),
    /integer from 0 to 256/,
  );
  await assert.rejects(
    () => manager.claimSpecialistHandoffsAcrossJobs({ maxConcurrentHandoffs: -0 }),
    /integer from 0 to 256/,
  );
  await assert.rejects(
    () => manager.claimSpecialistHandoffsAcrossJobs({ maxConcurrentHandoffs: 257 }),
    /integer from 0 to 256/,
  );
});
