import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);

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
    now: () => Date.parse('2026-10-01T13:00:00.000Z'),
  });
}

function budget() {
  return { maxModelCalls: 0, maxRuntimeSeconds: 0, maxCostUsdMicros: 0 };
}

function plan(overrides = {}) {
  return {
    schemaVersion: 1,
    planId: 'plan.repair',
    jobId: 'job.repair',
    objective: 'Produce a verified result',
    successCriteria: ['Result verified'],
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:01:00.000Z',
    revision: 3,
    nodes: [
      {
        nodeId: 'prepare',
        title: 'Prepare',
        objective: 'Prepare inputs',
        dependsOn: [],
        conflictKeys: [],
        ownerId: 'actor.1',
        executionPlane: 'LOCAL',
        acceptanceCriteria: [],
        budget: budget(),
        state: 'VERIFIED',
        evidence: 'ready',
        updatedAt: '2026-10-01T12:00:30.000Z',
      },
      {
        nodeId: 'target',
        title: 'Target',
        objective: 'Produce target',
        dependsOn: ['prepare'],
        conflictKeys: ['artifact.target'],
        ownerId: 'actor.1',
        executionPlane: 'LOCAL',
        acceptanceCriteria: ['Target correct'],
        budget: budget(),
        state: 'FAILED',
        evidence: '',
        updatedAt: '2026-10-01T12:01:00.000Z',
      },
    ],
    ...overrides,
  };
}

function cycle(overrides = {}) {
  return {
    schemaVersion: 1,
    cycleId: 'cycle.1',
    subjectId: 'target',
    actorId: 'actor.1',
    verifierId: 'verifier.1',
    verifierPlanRevisionId: 'verifier-plan.r1',
    baselineRevisionId: '2026-10-01T12:01:00.000Z',
    maxAttempts: 3,
    createdAt: '2026-10-01T12:01:10.000Z',
    updatedAt: '2026-10-01T12:01:20.000Z',
    attempts: [{
      attemptNumber: 1,
      failure: {
        verifierId: 'verifier.1',
        subjectRevisionId: '2026-10-01T12:01:00.000Z',
        evidenceSha256: H1,
        completedAt: '2026-10-01T12:01:05.000Z',
      },
      diagnosis: {
        diagnosisId: 'diagnosis.1',
        producerId: 'actor.1',
        hypothesisCodes: ['output.mismatch'],
        createdAt: '2026-10-01T12:01:20.000Z',
      },
      repair: null,
      retest: null,
    }],
    ...overrides,
  };
}

function repairedCycle(overrides = {}) {
  return cycle({
    updatedAt: '2026-10-01T12:02:00.000Z',
    attempts: [{
      attemptNumber: 1,
      failure: {
        verifierId: 'verifier.1',
        subjectRevisionId: '2026-10-01T12:01:00.000Z',
        evidenceSha256: H1,
        completedAt: '2026-10-01T12:01:05.000Z',
      },
      diagnosis: {
        diagnosisId: 'diagnosis.1',
        producerId: 'actor.1',
        hypothesisCodes: ['output.mismatch'],
        createdAt: '2026-10-01T12:01:20.000Z',
      },
      repair: {
        repairId: 'repair.1',
        producerId: 'actor.1',
        fromRevisionId: '2026-10-01T12:01:00.000Z',
        toRevisionId: 'subject.r2',
        changeArtifactId: 'artifact.change.1',
        changeArtifactSha256: H2,
        appliedAt: '2026-10-01T12:02:00.000Z',
      },
      retest: null,
    }],
    ...overrides,
  });
}

async function seedJob(manager) {
  await manager.create({ id: 'job.repair', goal: 'Repair failed work' });
  await manager.update(store => {
    store.byId['job.repair'].runtime.plan = plan();
    return store;
  });
}

test('BrowserAgent owns durable self-repair cycle evidence across restart', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedJob(manager);

  const created = await manager.putSelfRepairCycle('job.repair', {
    expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
    expectedCycleUpdatedAt: null,
    cycle: cycle(),
  });
  assert.equal(created.reused, false);
  assert.equal(created.assessment.state, 'READY_FOR_REPAIR');

  const restarted = managerFor(chrome);
  const listed = await restarted.listSelfRepairCycles('job.repair');
  assert.equal(listed.jobId, 'job.repair');
  assert.equal(listed.planId, 'plan.repair');
  assert.equal(listed.quarantinedCount, 0);
  assert.equal(listed.cycles.length, 1);
  assert.equal(listed.cycles[0].planId, 'plan.repair');
  assert.equal(listed.cycles[0].cycle.cycleId, 'cycle.1');
  assert.equal(listed.cycles[0].assessment.state, 'READY_FOR_REPAIR');
});

test('self-repair persistence is exact-CAS and exact replay is idempotent', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedJob(manager);
  const initial = cycle();
  await manager.putSelfRepairCycle('job.repair', {
    expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
    expectedCycleUpdatedAt: null,
    cycle: initial,
  });

  const replay = await manager.putSelfRepairCycle('job.repair', {
    expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
    expectedCycleUpdatedAt: initial.updatedAt,
    cycle: initial,
  });
  assert.equal(replay.reused, true);

  const advanced = repairedCycle();
  const updated = await manager.putSelfRepairCycle('job.repair', {
    expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
    expectedCycleUpdatedAt: initial.updatedAt,
    cycle: advanced,
  });
  assert.equal(updated.reused, false);
  assert.equal(updated.assessment.state, 'READY_FOR_RETEST');

  await assert.rejects(
    () => manager.putSelfRepairCycle('job.repair', {
      expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
      expectedCycleUpdatedAt: initial.updatedAt,
      cycle: repairedCycle({ updatedAt: '2026-10-01T12:03:00.000Z' }),
    }),
    /cycle revision drifted/,
  );
});

test('self-repair updates cannot rewrite historical evidence or cycle authority', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedJob(manager);
  const initial = cycle();
  await manager.putSelfRepairCycle('job.repair', {
    expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
    expectedCycleUpdatedAt: null,
    cycle: initial,
  });

  const rewrittenFailure = cycle({
    updatedAt: '2026-10-01T12:02:00.000Z',
    attempts: [{
      ...cycle().attempts[0],
      failure: {
        ...cycle().attempts[0].failure,
        evidenceSha256: H3,
      },
    }],
  });
  await assert.rejects(
    () => manager.putSelfRepairCycle('job.repair', {
      expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
      expectedCycleUpdatedAt: initial.updatedAt,
      cycle: rewrittenFailure,
    }),
    /cannot rewrite failure or diagnosis evidence/,
  );

  await assert.rejects(
    () => manager.putSelfRepairCycle('job.repair', {
      expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
      expectedCycleUpdatedAt: initial.updatedAt,
      cycle: cycle({
        maxAttempts: 4,
        updatedAt: '2026-10-01T12:02:00.000Z',
      }),
    }),
    /cannot rewrite maxAttempts/,
  );
});

test('self-repair cycle binds exact current plan revision and failed-node baseline', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedJob(manager);

  await assert.rejects(
    () => manager.putSelfRepairCycle('job.repair', {
      expectedPlanId: 'plan.repair',
      expectedPlanRevision: 2,
      expectedCycleUpdatedAt: null,
      cycle: cycle(),
    }),
    /AgentPlan revision drifted/,
  );
  await assert.rejects(
    () => manager.putSelfRepairCycle('job.repair', {
      expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
      expectedCycleUpdatedAt: null,
      cycle: cycle({
        baselineRevisionId: '2026-10-01T12:00:59.000Z',
        attempts: [{
          ...cycle().attempts[0],
          failure: {
            ...cycle().attempts[0].failure,
            subjectRevisionId: '2026-10-01T12:00:59.000Z',
          },
        }],
      }),
    }),
    /baselineRevisionId does not match/,
  );
});

test('cycle cannot bind a non-failed or missing AgentPlan subject', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedJob(manager);
  await manager.update(store => {
    const p = structuredClone(store.byId['job.repair'].runtime.plan);
    p.nodes[1].state = 'BLOCKED';
    store.byId['job.repair'].runtime.plan = p;
    return store;
  });

  await assert.rejects(
    () => manager.putSelfRepairCycle('job.repair', {
      expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
      expectedCycleUpdatedAt: null,
      cycle: cycle(),
    }),
    /subject must remain FAILED/,
  );
});

test('corrupt persisted cycle is quarantined locally without poisoning its BrowserAgent job', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedJob(manager);
  await manager.putSelfRepairCycle('job.repair', {
    expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
    expectedCycleUpdatedAt: null,
    cycle: cycle(),
  });

  const [storageKey] = Object.keys(data);
  data[storageKey].byId['job.repair'].runtime.selfRepairCycles.push({
    planId: 'plan.repair',
    cycle: {
      ...cycle({ cycleId: 'cycle.corrupt' }),
      baselineRevisionId: 'stale.revision',
    },
  });

  const restarted = managerFor(chrome);
  const loaded = await restarted.get('job.repair');
  assert.ok(loaded.job, 'cycle corruption must not quarantine the whole BrowserAgent job');
  const listed = await restarted.listSelfRepairCycles('job.repair');
  assert.equal(listed.cycles.length, 1);
  assert.equal(listed.cycles[0].cycle.cycleId, 'cycle.1');
  assert.equal(listed.quarantinedCount, 1);
});

test('failed-node drift after persistence quarantines only the stale cycle on restart', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedJob(manager);
  await manager.putSelfRepairCycle('job.repair', {
    expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
    expectedCycleUpdatedAt: null,
    cycle: cycle(),
  });

  const [storageKey] = Object.keys(data);
  data[storageKey].byId['job.repair'].runtime.plan.nodes[1].updatedAt = '2026-10-01T12:01:01.000Z';

  const restarted = managerFor(chrome);
  const loaded = await restarted.get('job.repair');
  assert.ok(loaded.job);
  const listed = await restarted.listSelfRepairCycles('job.repair');
  assert.equal(listed.cycles.length, 0);
  assert.equal(listed.quarantinedCount, 1);
});

test('plan replacement cannot silently rebind persisted self-repair evidence', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedJob(manager);
  await manager.putSelfRepairCycle('job.repair', {
    expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
    expectedCycleUpdatedAt: null,
    cycle: cycle(),
  });

  const [storageKey] = Object.keys(data);
  data[storageKey].byId['job.repair'].runtime.plan.planId = 'plan.replacement';

  const restarted = managerFor(chrome);
  const loaded = await restarted.get('job.repair');
  assert.ok(loaded.job, 'plan replacement must not poison the BrowserAgent job');
  const listed = await restarted.listSelfRepairCycles('job.repair');
  assert.equal(listed.planId, 'plan.replacement');
  assert.equal(listed.cycles.length, 0);
  assert.equal(listed.quarantinedCount, 1, 'old cycle must not acquire authority over a replacement plan');
});

test('durable owner rejects self-repair evidence from the future', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedJob(manager);
  await assert.rejects(
    () => manager.putSelfRepairCycle('job.repair', {
      expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
      expectedCycleUpdatedAt: null,
      cycle: cycle({
        updatedAt: '2026-10-01T13:00:01.000Z',
        attempts: [{
          ...cycle().attempts[0],
          diagnosis: {
            ...cycle().attempts[0].diagnosis,
            createdAt: '2026-10-01T13:00:01.000Z',
          },
        }],
      }),
    }),
    /cannot come from the future/,
  );
});

test('self-repair request and nested cycle accessors fail without getter execution', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedJob(manager);

  let requestReads = 0;
  const request = {
    expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
    expectedCycleUpdatedAt: null,
  };
  Object.defineProperty(request, 'cycle', {
    enumerable: true,
    get() {
      requestReads += 1;
      return cycle();
    },
  });
  await assert.rejects(
    () => manager.putSelfRepairCycle('job.repair', request),
    /enumerable own data property/,
  );
  assert.equal(requestReads, 0);

  let cycleReads = 0;
  const hostileCycle = cycle();
  Object.defineProperty(hostileCycle, 'actorId', {
    enumerable: true,
    get() {
      cycleReads += 1;
      return 'actor.1';
    },
  });
  await assert.rejects(
    () => manager.putSelfRepairCycle('job.repair', {
      expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
      expectedCycleUpdatedAt: null,
      cycle: hostileCycle,
    }),
    /enumerable own data properties only/,
  );
  assert.equal(cycleReads, 0);
});

test('self-repair persistence remains non-authorizing and does not execute the model route', async () => {
  const { chrome } = makeChromeStorage();
  let modelCalls = 0;
  const manager = new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => {
      modelCalls += 1;
      return { text: '{}' };
    },
    now: () => Date.parse('2026-10-01T13:00:00.000Z'),
  });
  await seedJob(manager);
  const persisted = await manager.putSelfRepairCycle('job.repair', {
    expectedPlanId: 'plan.repair',
    expectedPlanRevision: 3,
    expectedCycleUpdatedAt: null,
    cycle: cycle(),
  });
  assert.equal(persisted.assessment.executionAuthorized, false);
  assert.equal(persisted.assessment.mutationAuthorized, false);
  assert.equal(persisted.assessment.verificationAuthorized, false);
  assert.equal(persisted.assessment.completionAuthorized, false);
  assert.equal(modelCalls, 0);
});


test('self-repair write rejects replacement AgentPlan with same revision', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedJob(manager);
  await manager.update(store => {
    store.byId['job.repair'].runtime.plan = plan({ planId: 'plan.replacement' });
    return store;
  });

  await assert.rejects(
    () => manager.putSelfRepairCycle('job.repair', {
      expectedPlanId: 'plan.repair',
      expectedPlanRevision: 3,
      expectedCycleUpdatedAt: null,
      cycle: cycle(),
    }),
    /AgentPlan identity drifted/,
  );
});
