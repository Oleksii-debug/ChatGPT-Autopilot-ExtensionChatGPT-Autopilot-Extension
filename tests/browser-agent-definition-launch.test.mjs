import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { BrowserAgentManager } from '../src/core/browser-agent-manager.js';
import { AgentDefinitionRegistryMutationKind } from '../src/core/agent-definition-registry.js';

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

function managerFor(chrome, createId = () => 'job.generated') {
  return new BrowserAgentManager({
    chromeApi: chrome,
    routePrompt: async () => ({ text: '{}' }),
    createId,
  });
}

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    agentDefinitionId: 'agent.research',
    label: 'Research Agent',
    description: 'Evidence-bound research worker',
    instructions: 'Research the owner task and preserve explicit source evidence.',
    capabilityIds: ['browser', 'research'],
    toolIds: ['browser.read', 'files.read'],
    tags: ['research'],
    acceptanceCriteria: [],
    configDefaults: {
      maxSteps: 50,
      maxModelCalls: 8,
      maxInputTokens: 6000,
      maxOutputTokens: 3000,
      maxTotalTokens: 9000,
      maxOutputTokensPerCall: 1000,
      maxRuntimeMinutes: 20,
      aiPinnedRouteId: 'route.research',
    },
    modelRoutePolicy: {
      autoSwitch: false,
      allowRouteIds: ['route.research'],
      freeOnly: true,
      locality: 'local',
      retryBackoffSeconds: 120,
      circuitBreakerFailures: 1,
      circuitBreakerSeconds: 600,
    },
    enabled: true,
    definitionRevision: 1,
    ...overrides,
  };
}

function ownerBudget(overrides = {}) {
  return {
    maxSteps: 200,
    maxModelCalls: 20,
    maxInputTokens: 20000,
    maxOutputTokens: 10000,
    maxTotalTokens: 30000,
    maxOutputTokensPerCall: 2000,
    maxRuntimeMinutes: 60,
    maxCostUsd: 2,
    inputPricePerMillionUsd: 1,
    outputPricePerMillionUsd: 2,
    ...overrides,
  };
}

async function seedRegistry(manager, def = definition()) {
  await manager.createAgentDefinitionRegistry({ registryId: 'agents:project-1' });
  await manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 1,
    kind: AgentDefinitionRegistryMutationKind.CREATE,
    definition: def,
  });
}

function launchRequest(overrides = {}) {
  return {
    registryId: 'agents:project-1',
    expectedRegistryRevision: 2,
    agentDefinitionId: 'agent.research',
    expectedDefinitionRevision: 1,
    jobId: 'job.research-1',
    goal: 'Compare the current evidence and produce a verified result.',
    projectId: 'project-1',
    ownerBudget: ownerBudget(),
    ownerCapabilityIds: ['browser', 'research'],
    ownerToolIds: ['browser.read', 'files.read'],
    requestedCapabilityIds: ['research'],
    requestedToolIds: ['browser.read'],
    ...overrides,
  };
}

test('persisted Agent definition launches atomically into the canonical Browser Agent store', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);

  const created = await manager.createFromAgentDefinition(launchRequest());
  assert.equal(created.job.id, 'job.research-1');
  assert.equal(created.job.config.name, 'Research Agent');
  assert.equal(created.job.config.projectId, 'project-1');
  assert.equal(created.job.config.maxSteps, 50, 'definition ceiling must narrow owner ceiling');
  assert.equal(created.job.config.maxModelCalls, 8);
  assert.equal(created.job.config.aiPinnedRouteId, 'route.research');
  assert.match(created.job.config.goal, /^Reusable Agent definition instructions:/);
  assert.match(created.job.config.goal, /Owner task:\nCompare the current evidence/);

  assert.equal(created.job.definitionSelection.registryId, 'agents:project-1');
  assert.equal(created.job.definitionSelection.registryRevision, 2);
  assert.equal(created.job.definitionSelection.agentDefinitionId, 'agent.research');
  assert.equal(created.job.definitionSelection.definitionRevision, 1);
  assert.deepEqual(created.job.definitionScope, {
    capabilityIds: ['research'],
    toolIds: ['browser.read'],
  });
  assert.deepEqual(created.job.definitionRouterOverride.routePolicy.allowRouteIds, ['route.research']);
  assert.equal(created.job.definitionRouterOverride.routePolicy.autoSwitch, false);
  assert.equal(created.job.definitionRouterOverride.routePolicy.freeOnly, true);
  assert.equal(created.job.definitionRouterOverride.routePolicy.retryBackoffSeconds, 120);
  assert.equal(created.job.definitionRouterOverride.routePolicy.circuitBreakerFailures, 1);
  assert.equal(created.job.definitionRouterOverride.routePolicy.circuitBreakerSeconds, 600);
  assert.deepEqual(Object.keys(data), ['autopilotBrowserAgentV1'], 'launch must reuse the one Browser Agent storage key');
});

test('definition launch provenance and narrowed scope survive service-worker restart', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);
  await manager.createFromAgentDefinition(launchRequest());

  const restarted = managerFor(chrome);
  const loaded = await restarted.get('job.research-1');
  assert.equal(loaded.job.definitionSelection.registryRevision, 2);
  assert.equal(loaded.job.definitionSelection.definitionRevision, 1);
  assert.deepEqual(loaded.job.definitionScope.capabilityIds, ['research']);
  assert.deepEqual(loaded.job.definitionScope.toolIds, ['browser.read']);
  assert.deepEqual(loaded.job.definitionRouterOverride.routePolicy.allowRouteIds, ['route.research']);
  assert.equal(loaded.job.definitionRouterOverride.routePolicy.locality, 'local');
  assert.equal(loaded.job.definitionRouterOverride.routePolicy.retryBackoffSeconds, 120);
  assert.equal(loaded.job.definitionRouterOverride.routePolicy.circuitBreakerFailures, 1);
  assert.equal(loaded.job.definitionRouterOverride.routePolicy.circuitBreakerSeconds, 600);
  assert.equal(loaded.job.config.aiPinnedRouteId, 'route.research');
});

test('restart rejects a selected definition when its persisted model route policy binding is missing', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);
  await manager.createFromAgentDefinition(launchRequest());

  const [storageKey] = Object.keys(data);
  delete data[storageKey].byId['job.research-1'].definitionRouterOverride;

  const restarted = managerFor(chrome);
  const loaded = await restarted.get('job.research-1');
  assert.equal(loaded.job, null, 'a durable Agent must not reload after its exact route-policy binding disappears');
});

test('launch requires exact live registry and definition revisions at the serialized write boundary', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);

  await manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 2,
    kind: AgentDefinitionRegistryMutationKind.UPDATE,
    agentDefinitionId: 'agent.research',
    expectedDefinitionRevision: 1,
    definition: definition({
      label: 'Research Agent v2',
      definitionRevision: 2,
    }),
  });

  await assert.rejects(
    () => manager.createFromAgentDefinition(launchRequest()),
    /registry revision drifted before launch/,
  );
  await assert.rejects(
    () => manager.createFromAgentDefinition(launchRequest({
      expectedRegistryRevision: 3,
      expectedDefinitionRevision: 1,
    })),
    /definition revision drifted before launch/,
  );

  const current = await manager.createFromAgentDefinition(launchRequest({
    expectedRegistryRevision: 3,
    expectedDefinitionRevision: 2,
    jobId: 'job.research-v2',
  }));
  assert.equal(current.job.config.name, 'Research Agent v2');
  assert.equal(current.job.definitionSelection.definitionRevision, 2);
});

test('a registry mutation queued before launch cannot be bypassed by stale launch expectations', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);

  const mutation = manager.mutateAgentDefinitionRegistry({
    registryId: 'agents:project-1',
    expectedRegistryRevision: 2,
    kind: AgentDefinitionRegistryMutationKind.UPDATE,
    agentDefinitionId: 'agent.research',
    expectedDefinitionRevision: 1,
    definition: definition({ label: 'Research Agent changed', definitionRevision: 2 }),
  });
  const launch = manager.createFromAgentDefinition(launchRequest({ jobId: 'job.stale' }));

  await mutation;
  await assert.rejects(() => launch, /registry revision drifted before launch/);
  assert.equal((await manager.get('job.stale')).job, null);
});

test('definition launch preserves owner and definition capability/tool intersection', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);

  await assert.rejects(
    () => manager.createFromAgentDefinition(launchRequest({
      requestedCapabilityIds: ['browser', 'research'],
      ownerCapabilityIds: ['research'],
      jobId: 'job.owner-capability-excess',
    })),
    /Requested Agent capabilities exceeds allowed authority/,
  );

  await assert.rejects(
    () => manager.createFromAgentDefinition(launchRequest({
      requestedToolIds: ['browser.read', 'files.read'],
      ownerToolIds: ['browser.read'],
      jobId: 'job.owner-tool-excess',
    })),
    /Requested Agent tools exceeds allowed authority/,
  );
});

test('disabled definitions and duplicate job identity fail closed', async () => {
  const firstStore = makeChromeStorage();
  const disabledManager = managerFor(firstStore.chrome);
  await seedRegistry(disabledManager, definition({ enabled: false }));
  await assert.rejects(
    () => disabledManager.createFromAgentDefinition(launchRequest()),
    /missing or disabled/,
  );

  const secondStore = makeChromeStorage();
  const manager = managerFor(secondStore.chrome);
  await seedRegistry(manager);
  await manager.createFromAgentDefinition(launchRequest());
  await assert.rejects(
    () => manager.createFromAgentDefinition(launchRequest()),
    /job already exists/,
  );
});

test('definition launch request boundary is exact-shape, data-only and zero-getter', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);

  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'registryId', {
    enumerable: true,
    get() {
      reads += 1;
      return 'agents:project-1';
    },
  });
  await assert.rejects(
    () => manager.createFromAgentDefinition(hostile),
    /enumerable data property/,
  );
  assert.equal(reads, 0);

  await assert.rejects(
    () => manager.createFromAgentDefinition({
      ...launchRequest({ jobId: 'job.unknown-field' }),
      executionAuthorized: true,
    }),
    /unknown field/,
  );
});

test('launch snapshots nested owner authority before queued persistence', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);

  const request = launchRequest({ jobId: 'job.snapshot' });
  const pending = manager.createFromAgentDefinition(request);
  request.ownerBudget.maxSteps = 1;
  request.requestedCapabilityIds[0] = 'browser';
  request.requestedToolIds[0] = 'files.read';

  const created = await pending;
  assert.equal(created.job.config.maxSteps, 50, 'post-call budget mutation must not alter materialization');
  assert.deepEqual(created.job.definitionScope.capabilityIds, ['research']);
  assert.deepEqual(created.job.definitionScope.toolIds, ['browser.read']);
});

test('nested launch authority rejects accessors without executing them', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);

  let reads = 0;
  const budget = ownerBudget();
  Object.defineProperty(budget, 'maxSteps', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 200;
    },
  });

  await assert.rejects(
    () => manager.createFromAgentDefinition(launchRequest({
      jobId: 'job.nested-getter',
      ownerBudget: budget,
    })),
    /enumerable data property/,
  );
  assert.equal(reads, 0);
});

test('standard Browser Agent creation carries no reusable-definition provenance', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const created = await manager.create({
    id: 'job.manual',
    goal: 'Owner-created Browser Agent',
  });
  assert.equal(created.job.definitionSelection, null);
  assert.equal(created.job.definitionScope, null);

  const restarted = managerFor(chrome);
  const loaded = await restarted.get('job.manual');
  assert.equal(loaded.job.definitionSelection, null);
  assert.equal(loaded.job.definitionScope, null);
});

test('Core exposes definition launch only through the canonical BrowserAgentManager', async () => {
  const source = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /'CREATE_BROWSER_AGENT_JOB_FROM_DEFINITION'/);
  assert.match(source, /browserAgent\.createFromAgentDefinition\(message\.payload \|\| \{\}\)/);
  assert.doesNotMatch(source, /chrome\.storage\.local[^\n]+CREATE_BROWSER_AGENT_JOB_FROM_DEFINITION/);
});


test('Plan-1: direct and reusable-definition intake share one durable Agent Job constructor across restart', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const direct = await manager.create({ id: 'job.direct', projectId: 'project-1', goal: 'Collect independently verifiable sources.' });
  assert.equal(direct.job.id, 'job.direct');
  await seedRegistry(manager);
  const viaDefinition = await manager.createFromAgentDefinition(launchRequest({ jobId: 'job.defined' }));
  assert.equal(viaDefinition.job.definitionSelection.agentDefinitionId, 'agent.research');
  assert.deepEqual(Object.keys(data), ['autopilotBrowserAgentV1']);
  const restarted = managerFor(chrome);
  assert.equal((await restarted.get('job.direct')).job.config.goal, 'Collect independently verifiable sources.');
  const loadedDefined = (await restarted.get('job.defined')).job;
  assert.equal(loadedDefined.definitionSelection.definitionRevision, 1);
  assert.deepEqual(loadedDefined.definitionScope.toolIds, ['browser.read']);
  await assert.rejects(() => restarted.create({ id: 'job.direct', goal: 'Must not overwrite existing identity.' }), /already exists/);
  await assert.rejects(() => restarted.createFromAgentDefinition(launchRequest({ jobId: 'job.defined' })), /already exists/);
  assert.deepEqual(data.autopilotBrowserAgentV1.order, ['job.direct', 'job.defined']);
});

test('Plan-1: unknown persisted job-store schema fails closed across restart without rewriting original effects', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);
  await manager.createFromAgentDefinition(launchRequest());
  const [key] = Object.keys(data);
  const original = structuredClone(data[key]);

  data[key].schemaVersion = original.schemaVersion + 1;
  const incompatible = structuredClone(data[key]);
  const restarted = managerFor(chrome);
  await assert.rejects(() => restarted.get('job.research-1'), /schemaVersion is unsupported/);
  await assert.rejects(
    () => restarted.createFromAgentDefinition(launchRequest({ jobId: 'job.after-upgrade' })),
    /schemaVersion is unsupported/,
  );
  assert.deepEqual(data[key], incompatible, 'failed intake must leave the incompatible store untouched');
  assert.equal(data[key].byId['job.research-1'].id, 'job.research-1');
  assert.equal(data[key].byId['job.after-upgrade'], undefined);
});

test('Plan-1: malformed existing store fails closed instead of silently replacing durable identities', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);
  await manager.createFromAgentDefinition(launchRequest());
  const [key] = Object.keys(data);
  data[key].order = {};
  const corrupted = structuredClone(data[key]);
  const restarted = managerFor(chrome);
  await assert.rejects(() => restarted.get('job.research-1'), /structure is invalid/);
  await assert.rejects(() => restarted.createFromAgentDefinition(launchRequest({
    jobId: 'job.fail-closed',
  })), /structure is invalid/);
  assert.deepEqual(data[key], corrupted, 'invalid persisted state must remain intact for explicit recovery');
});

test('Plan-1: direct prompt-first intake rejects getter-backed policy and goal fields without invocation', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  let invoked = 0;
  const hostile = { id: 'job.direct-getter' };
  Object.defineProperty(hostile, 'goal', {
    enumerable: true,
    get() { invoked += 1; throw new Error('side-effect-secret'); },
  });
  await assert.rejects(() => manager.create(hostile), /enumerable data property/);
  assert.equal(invoked, 0);
  assert.equal((await manager.get('job.direct-getter')).job, null);

  const poisoned = { id: 'job.direct-symbol', goal: 'Safe task' };
  poisoned[Symbol('executionAuthorized')] = true;
  await assert.rejects(() => manager.create(poisoned), /symbol field/);
  assert.equal((await manager.get('job.direct-symbol')).job, null);
});


test('Plan-1: quarantined invalid definition job cannot be lost by unrelated writes or reused', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);
  await manager.createFromAgentDefinition(launchRequest());
  const key = 'autopilotBrowserAgentV1';
  delete data[key].byId['job.research-1'].definitionRouterOverride;
  const corrupted = structuredClone(data[key]);
  const restarted = managerFor(chrome);
  assert.equal((await restarted.get('job.research-1')).job, null,
    'corrupt row remains withheld from executable job projections');
  await assert.rejects(() => restarted.create({
    id: 'job.safe-new', goal: 'A different task must not delete unreconciled job authority.',
  }), /durable job identity is quarantined/);
  await assert.rejects(() => restarted.createFromAgentDefinition(
    launchRequest({ jobId: 'job.research-1' }),
  ), /durable job identity is quarantined/);
  assert.deepEqual(data[key], corrupted, 'rejected writes must preserve exact original durable store');
});

test('Plan-1: orphaned byId record and duplicate order identity stop all mutation', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.create({ id: 'job.1', goal: 'Prepare evidence.' });
  const key = 'autopilotBrowserAgentV1';
  data[key].byId['job.orphan'] = structuredClone(data[key].byId['job.1']);
  const orphaned = structuredClone(data[key]);
  await assert.rejects(() => manager.create({ id: 'job.2', goal: 'Not yet.' }), /durable job identity is quarantined/);
  assert.deepEqual(data[key], orphaned);
  delete data[key].byId['job.orphan'];
  data[key].order.push('job.1');
  const duplicated = structuredClone(data[key]);
  await assert.rejects(() => manager.create({ id: 'job.2', goal: 'Still not yet.' }), /durable job identity is quarantined/);
  assert.deepEqual(data[key], duplicated);
});


test('Plan-1: every intake path rejects non-canonical IDs without creating or replacing jobs', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);
  for (const invalid of ['  job.truncated', 'job.with trailing ', '  ', 'job;unsafe', 42]) {
    await assert.rejects(() => manager.create({ id: invalid, goal: 'Evidence gathering.' }),
      /exact bounded durable ID/);
    await assert.rejects(() => manager.createFromAgentDefinition(launchRequest({ jobId: invalid })),
      /exact bounded durable ID/);
  }
  assert.deepEqual(data.autopilotBrowserAgentV1.order, []);
  const brokenGenerator = managerFor(chrome, () => ' job.generated');
  await assert.rejects(() => brokenGenerator.create({ goal: 'Must not accept coerced generated identity.' }),
    /exact bounded durable ID/);
  assert.deepEqual(data.autopilotBrowserAgentV1.order, []);
  const generated = await manager.create({ id: '', goal: 'Owner did not set a job id.' });
  assert.equal(generated.job.id, 'job.generated', 'legacy empty-id launch must generate a canonical job');
  const spaced = await manager.create({ id: 'manual job 2', goal: 'Preserve legitimate internal-space IDs.' });
  assert.equal(spaced.job.id, 'manual job 2');
  assert.equal((await managerFor(chrome).get('manual job 2')).job.id, 'manual job 2');
  const valid = await manager.create({ id: 'job:exact/path@v1', goal: 'Preserve explicit identity.' });
  assert.equal(valid.job.id, 'job:exact/path@v1');
  const resumed = managerFor(chrome);
  assert.equal((await resumed.get('job:exact/path@v1')).job.id, 'job:exact/path@v1');
});


test('Plan-1: outcome criteria are dense bounded text with no nested getter or coercion side effects', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await manager.create({ id: 'job.valid', goal: 'Produce evidence.', acceptanceCriteria: ['Evidence file exists'] });
  const baseline = structuredClone(data.autopilotBrowserAgentV1);
  let invoked = 0;
  const evil = { toString() { invoked += 1; throw new Error('leaked-token'); } };
  const accessor = ['one'];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { invoked += 1; throw new Error('leaked-token'); } });
  const sparse = []; sparse.length = 2; sparse[0] = 'one';
  const extra = ['one']; extra.authorized = true;
  const bad = [[evil], accessor, sparse, extra, ['x'.repeat(1001)], [17]];
  for (const criteria of bad) {
    await assert.rejects(() => manager.create({
      id: 'job.reject', goal: 'Cannot claim outcome.', acceptanceCriteria: criteria,
    }), /acceptanceCriteria|acceptance criterion/);
  }
  assert.equal(invoked, 0, 'criteria validation must not call hostile accessors or coercion');
  assert.deepEqual(data.autopilotBrowserAgentV1, baseline, 'failed intake must not persist authority');
  const restarted = managerFor(chrome);
  assert.deepEqual((await restarted.get('job.valid')).job.config.acceptanceCriteria, ['Evidence file exists']);
});

test('Plan-1: direct site-policy intake snapshots nested owner rules and rejects hostile getters', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  let invoked = 0;
  const accessorRule = { pattern: 'example.com' };
  Object.defineProperty(accessorRule, 'defaultDecision', {
    enumerable: true,
    get() { invoked += 1; throw new Error('secret-owner-token'); },
  });
  await assert.rejects(() => manager.create({
    id: 'job.site-getter', goal: 'Should not read owner policy getter.',
    siteRules: [accessorRule],
  }), /enumerable data property/);

  const decisions = {};
  Object.defineProperty(decisions, 'credentials', {
    enumerable: true,
    get() { invoked += 1; throw new Error('secret-owner-token'); },
  });
  await assert.rejects(() => manager.create({
    id: 'job.decision-getter', goal: 'Should not invoke nested decision getter.',
    siteRules: [{ pattern: 'example.com', actionDecisions: decisions }],
  }), /enumerable data property/);
  assert.equal(invoked, 0, 'nested policy accessors must never run');
  assert.equal((await manager.get('job.site-getter')).job, null);
  assert.equal((await manager.get('job.decision-getter')).job, null);

  const sparse = new Array(2);
  sparse[0] = { pattern: 'example.com' };
  await assert.rejects(() => manager.create({
    id: 'job.sparse-site', goal: 'Do not accept partially hidden owner rules.',
    siteRules: sparse,
  }), /dense bounded array|own data properties/);

  const mutableRules = [{
    pattern: 'example.com',
    defaultDecision: 'DENY',
    actionDecisions: { credentials: 'ASK' },
  }];
  const pending = manager.create({
    id: 'job.site-snapshot', goal: 'Bound to exact owner policy.',
    siteRules: mutableRules,
  });
  mutableRules[0].pattern = 'evil.example.org';
  mutableRules[0].defaultDecision = 'ALLOW';
  mutableRules[0].actionDecisions.credentials = 'ALLOW';
  const created = await pending;
  assert.equal(created.job.config.siteRules[0].pattern, 'example.com');
  assert.equal(created.job.config.siteRules[0].defaultDecision, 'DENY');
  assert.equal(created.job.config.siteRules[0].actionDecisions.credentials, 'ASK');
  assert.deepEqual(data.autopilotBrowserAgentV1.order, ['job.site-snapshot']);
  const resumed = managerFor(chrome);
  const loaded = (await resumed.get('job.site-snapshot')).job;
  assert.deepEqual(loaded.config.siteRules, created.job.config.siteRules, 'restart retains the original policy snapshot');
});


test('Plan-1: direct Agent intake fails closed on hostile scalar coercion before persistence', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  let coercions = 0;
  const secret = 'private-owner-intake-data';
  const hostile = {
    toString() { coercions += 1; throw new Error(secret); },
    valueOf() { coercions += 1; throw new Error(secret); },
  };

  for (const field of ['goal', 'name', 'projectId', 'startUrl', 'credentialDecision', 'approvalMode', 'maxCostUsd', 'maxSteps', 'aiPinnedRouteId', 'repeatMode']) {
    let error;
    try {
      await manager.create({ id: 'job.hostile-' + field, goal: 'safe task', [field]: hostile });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, field + ' must fail closed');
    assert.match(error.message, /must be a finite scalar data value/);
    assert.doesNotMatch(error.message, /private-owner-intake-data/);
  }
  await assert.rejects(
    () => manager.create({ id: 'job.symbol', goal: Symbol('hostile') }),
    /must be a finite scalar data value/,
  );
  for (const invalidNumber of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await assert.rejects(
      () => manager.create({ id: 'job.nonfinite', goal: 'safe task', maxCostUsd: invalidNumber }),
      /must be a finite scalar data value/,
    );
  }
  assert.equal(coercions, 0, 'validation may not invoke untrusted conversion hooks');
  assert.deepEqual(Object.keys(data), [], 'invalid direct intake cannot persist a partial job');

  const accepted = await manager.create({
    id: 'job.scalar-ok',
    goal: 'Read and verify the requested source.',
    acceptanceCriteria: ['Source inspected'],
    siteRules: [],
    maxSteps: 5,
  });
  assert.equal(accepted.job.id, 'job.scalar-ok');
  const restarted = managerFor(chrome);
  assert.equal((await restarted.get('job.scalar-ok')).job.config.goal, 'Read and verify the requested source.');
  assert.deepEqual(data.autopilotBrowserAgentV1.order, ['job.scalar-ok']);
});

test('Plan-1: direct job intake rejects unknown authority-bearing fields without partial durable state', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  for (const [id, injected] of [
    ['job.permission', { permissionGranted: true }],
    ['job.effect', { effectAuthorized: true }],
    ['job.outcome', { outcomeVerified: true }],
    ['job.owner', { ownerOverride: 'ADMIN' }],
    ['job.checkpoint', { restoreWithoutReconciliation: true }],
  ]) {
    await assert.rejects(
      () => manager.create({ id, goal: 'Observe a source safely.', ...injected }),
      /unknown field/,
      id + ' should fail closed',
    );
  }
  let reads = 0;
  const getter = { id: 'job.getter', goal: 'Safe goal' };
  Object.defineProperty(getter, 'permissionGranted', {
    enumerable: true,
    get() { reads += 1; throw new Error('owner-secret-data'); },
  });
  await assert.rejects(
    () => manager.create(getter),
    /enumerable data property/,
  );
  assert.equal(reads, 0);
  assert.deepEqual(Object.keys(data), [], 'no denied request may mutate durable storage');
  const created = await manager.create({
    id: 'job.boundary-ok',
    goal: 'Observe the exact source.',
    maxSteps: 3,
    acceptanceCriteria: ['Source observed'],
  });
  assert.equal(created.job.id, 'job.boundary-ok');
  const restarted = managerFor(chrome);
  assert.equal((await restarted.get('job.boundary-ok')).job.config.goal, 'Observe the exact source.');
  assert.deepEqual(data.autopilotBrowserAgentV1.order, ['job.boundary-ok']);
});


test('Plan-1: explicit persisted null is not an absent legacy store and never permits a new job', async () => {
  const { data, chrome } = makeChromeStorage();
  data.autopilotBrowserAgentV1 = null;
  const manager = managerFor(chrome);
  await assert.rejects(
    () => manager.create({ id: 'job.must-not-resurrect', goal: 'No duplicate consequential effects' }),
    /schemaVersion is unsupported; migration\/reconciliation required/,
  );
  assert.equal(data.autopilotBrowserAgentV1, null, 'corrupt durable evidence must not be overwritten');

  // Missing (undefined) legacy storage remains a valid genuinely fresh installation.
  delete data.autopilotBrowserAgentV1;
  const created = await manager.create({ id: 'job.new-install', goal: 'Observe the current source' });
  assert.equal(created.job.id, 'job.new-install');
  assert.deepEqual(data.autopilotBrowserAgentV1.order, ['job.new-install']);
});


function plan1OutcomeContract(desiredResult, projectId = '', overrides = {}) {
  return {
    schemaVersion: 1,
    contractId: 'outcome.bound-1',
    projectId,
    desiredResult,
    completionCriteria: [{
      criterionId: 'proof-1',
      description: 'Observed source must support the owner goal.',
      observable: 'Readback of a canonical source and independent verification.',
      requiredEvidenceKinds: ['test-report'],
    }],
    constraints: ['No duplicate effect or owner authority.'],
    sourceTruth: [{
      sourceId: 'source-1',
      location: 'https://example.org/verified-source',
      revisionId: 'rev-1',
      purpose: 'Exact source evidence.',
    }],
    allowedAuthority: [],
    budgetBoundaries: {
      maxModelCalls: 5,
      maxRuntimeSeconds: 600,
      maxCostUsdMicros: 0,
      maxConcurrency: 1,
    },
    deliverables: [{
      deliverableId: 'deliverable-1',
      kind: 'report',
      description: 'Verifiable evidence-bound output.',
      criterionIds: ['proof-1'],
    }],
    verifierPlan: {
      planId: 'verify-1',
      actorId: 'actor-1',
      verifierId: 'independent-1',
      criterionIds: ['proof-1'],
      requiredEvidenceArtifactCount: 1,
      independent: true,
    },
    triggerRefs: [],
    createdAt: '2026-10-08T10:00:00.000Z',
    revision: 1,
    advisoryOnly: true,
    ownerAccepted: false,
    executionAuthorized: false,
    ...overrides,
  };
}

test('Plan-1: direct Outcome Contract is advisory, exact-goal-bound and survives cold restart', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const goal = 'Read the canonical evidence and independently verify the source.';
  const contract = plan1OutcomeContract(goal, 'project-1');
  const pending = manager.create({
    id: 'job.outcome-direct', goal, projectId: 'project-1', outcomeContract: contract,
  });
  contract.desiredResult = 'An attacker changed the owner goal after admission.';
  contract.completionCriteria[0].criterionId = 'attacker-criterion';
  const created = await pending;
  assert.equal(created.job.outcomeContract.desiredResult, goal);
  assert.equal(created.job.outcomeContract.completionCriteria[0].criterionId, 'proof-1');
  assert.equal(created.job.outcomeContract.advisoryOnly, true);
  assert.equal(created.job.outcomeContract.executionAuthorized, false);
  assert.equal(created.job.outcomeContract.ownerAccepted, false);
  assert.equal(created.job.outcomeContract.verifierPlan.verificationAuthority, 'EXTERNAL_REQUIRED');
  assert.deepEqual(Object.keys(data), ['autopilotBrowserAgentV1']);

  const restarted = managerFor(chrome);
  const loaded = (await restarted.get('job.outcome-direct')).job;
  assert.deepEqual(loaded.outcomeContract, created.job.outcomeContract);
  const safeEdit = await restarted.updateConfig('job.outcome-direct', { maxSteps: 9 });
  assert.equal(safeEdit.job.config.maxSteps, 9);
  assert.equal(safeEdit.job.outcomeContract.desiredResult, goal);
  await assert.rejects(
    () => restarted.updateConfig('job.outcome-direct', { goal: 'Different outcome' }),
    /desiredResult does not match/,
  );
  await assert.rejects(
    () => restarted.updateConfig('job.outcome-direct', { acceptanceCriteria: ['Changed proof gate'] }),
    /bound Outcome Contract criteria cannot change/,
  );
  await assert.rejects(
    () => restarted.updateConfig('job.outcome-direct', { outcomeContract: null }),
    /outcome contract is immutable/,
  );
  assert.equal((await restarted.get('job.outcome-direct')).job.config.goal, goal);
});

test('Plan-1: hostile Outcome Contract admission fails closed before any durable write', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const goal = 'Inspect only the admitted goal.';
  let getterCalls = 0;
  const contract = plan1OutcomeContract(goal);
  Object.defineProperty(contract.completionCriteria[0], 'description', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('private-intake-secret'); },
  });
  await assert.rejects(
    () => manager.create({ id: 'job.contract-getter', goal, outcomeContract: contract }),
    /enumerable data property/,
  );
  assert.equal(getterCalls, 0, 'untrusted getters must never be evaluated');

  for (const [suffix, outcome] of [
    ['goal', plan1OutcomeContract('Contradictory desired result')],
    ['project', plan1OutcomeContract(goal, 'other-project')],
    ['unknown', plan1OutcomeContract(goal, '', { schemaVersion: 2 })],
    ['authority', plan1OutcomeContract(goal, '', { executionAuthorized: true })],
  ]) {
    await assert.rejects(
      () => manager.create({ id: 'job.contract-' + suffix, goal, outcomeContract: outcome }),
    );
  }
  assert.deepEqual(Object.keys(data), [], 'all denied outcomes must leave the store untouched');
});

test('Plan-1: corrupt persisted outcome is quarantined without loss or effect replay', async () => {
  const { data, chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  const goal = 'Bind evidence to exact canonical state.';
  await manager.create({
    id: 'job.outcome-corrupt', goal, outcomeContract: plan1OutcomeContract(goal),
  });
  data.autopilotBrowserAgentV1.byId['job.outcome-corrupt'].outcomeContract.desiredResult = 'Forged after restart';
  const evidenceBefore = structuredClone(data.autopilotBrowserAgentV1);
  const restarted = managerFor(chrome);
  assert.equal((await restarted.get('job.outcome-corrupt')).job, null);
  await assert.rejects(
    () => restarted.create({ id: 'job.new', goal: 'Do not erase quarantined effect history' }),
    /quarantined; mutation requires explicit recovery/,
  );
  assert.deepEqual(data.autopilotBrowserAgentV1, evidenceBefore);
});

test('Plan-1: reusable Definition Outcome Contract binds the true owner task, not its instruction prefix', async () => {
  const { chrome } = makeChromeStorage();
  const manager = managerFor(chrome);
  await seedRegistry(manager);
  const request = launchRequest({ outcomeContract: plan1OutcomeContract(
    'Compare the current evidence and produce a verified result.', 'project-1',
  ) });
  const accepted = await manager.createFromAgentDefinition(request);
  assert.equal(accepted.job.outcomeContract.desiredResult, request.goal);
  assert.equal(accepted.job.outcomeContract.verifierPlan.verificationAuthority, 'EXTERNAL_REQUIRED');
  assert.match(accepted.job.config.goal, /Reusable Agent definition instructions:/);
  const resumed = managerFor(chrome);
  assert.equal((await resumed.get('job.research-1')).job.outcomeContract.desiredResult, request.goal);

  await assert.rejects(
    () => manager.createFromAgentDefinition(launchRequest({
      jobId: 'job.definition-mismatch',
      outcomeContract: plan1OutcomeContract('A different owner task.', 'project-1'),
    })),
    /desiredResult does not match/,
  );
  assert.equal((await resumed.get('job.definition-mismatch')).job, null);
});
