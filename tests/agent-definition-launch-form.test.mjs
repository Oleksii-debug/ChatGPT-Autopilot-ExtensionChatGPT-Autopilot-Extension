import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_DEFINITION_OWNER_BUDGET_KEYS,
  agentDefinitionLaunchScopeTextV1,
  agentDefinitionOwnerBudgetFromPolicyV1,
  buildAgentDefinitionLaunchRequestV1,
} from '../src/ui/agent-definition-launch-form.js';

function registry(overrides = {}) {
  return {
    registryId: 'agents:project-1',
    revision: 7,
    definitions: [],
    ...overrides,
  };
}

function definition(overrides = {}) {
  return {
    agentDefinitionId: 'agent.research',
    definitionRevision: 3,
    enabled: true,
    capabilityIds: ['browser', 'research'],
    toolIds: ['browser.read', 'files.read'],
    label: 'Research Agent',
    ...overrides,
  };
}

function ownerPolicy(overrides = {}) {
  return {
    maxSteps: 100,
    maxModelCalls: 10,
    maxInputTokens: 20000,
    maxOutputTokens: 10000,
    maxTotalTokens: 30000,
    maxOutputTokensPerCall: 2000,
    maxRuntimeMinutes: 60,
    maxCostUsd: 2.5,
    inputPricePerMillionUsd: 1.25,
    outputPricePerMillionUsd: 3.5,
    ...overrides,
  };
}

function form(overrides = {}) {
  return {
    goal: 'Compare evidence and return a verified result.',
    projectId: 'project-1',
    jobId: '',
    ownerCapabilityIdsText: 'research\nbrowser',
    ownerToolIdsText: 'files.read\nbrowser.read',
    requestedCapabilityIdsText: 'research',
    requestedToolIdsText: 'browser.read',
    ...overrides,
  };
}

test('launch builder binds exact live definition revisions and explicit least-authority narrowing', () => {
  const request = buildAgentDefinitionLaunchRequestV1(form(), {
    registry: registry(),
    definition: definition(),
    ownerPolicy: ownerPolicy(),
  });

  assert.deepEqual({ ...request }, {
    registryId: 'agents:project-1',
    expectedRegistryRevision: 7,
    agentDefinitionId: 'agent.research',
    expectedDefinitionRevision: 3,
    goal: 'Compare evidence and return a verified result.',
    projectId: 'project-1',
    ownerBudget: request.ownerBudget,
    ownerCapabilityIds: ['browser', 'research'],
    ownerToolIds: ['browser.read', 'files.read'],
    requestedCapabilityIds: ['research'],
    requestedToolIds: ['browser.read'],
  });
  assert.deepEqual(Object.keys(request.ownerBudget), AGENT_DEFINITION_OWNER_BUDGET_KEYS);
  assert.equal(Object.hasOwn(request, 'jobId'), false);
});

test('optional explicit job identity is preserved and surrounding whitespace is removed', () => {
  const request = buildAgentDefinitionLaunchRequestV1(form({
    goal: '  Owner task  ',
    projectId: '  project-1  ',
    jobId: '  manual research job 1  ',
  }), {
    registry: registry(),
    definition: definition(),
    ownerPolicy: ownerPolicy(),
  });

  assert.equal(request.goal, 'Owner task');
  assert.equal(request.projectId, 'project-1');
  assert.equal(request.jobId, 'manual research job 1');
});

test('scope defaults expose the selected definition authority without inventing grants', () => {
  const scope = agentDefinitionLaunchScopeTextV1(definition());
  assert.deepEqual({ ...scope }, {
    ownerCapabilityIdsText: 'browser\nresearch',
    ownerToolIdsText: 'browser.read\nfiles.read',
    requestedCapabilityIdsText: 'browser\nresearch',
    requestedToolIdsText: 'browser.read\nfiles.read',
  });
});

test('owner budget copies only the canonical budget authority fields', () => {
  const budget = agentDefinitionOwnerBudgetFromPolicyV1({
    ...ownerPolicy(),
    startUrl: 'https://example.com/',
    approvalMode: 'ALLOW_ALL',
    trustedScriptEnabled: true,
  });
  assert.deepEqual(Object.keys(budget), AGENT_DEFINITION_OWNER_BUDGET_KEYS);
  assert.equal(Object.hasOwn(budget, 'approvalMode'), false);
  assert.equal(Object.hasOwn(budget, 'startUrl'), false);
});

test('launch fails closed when owner grants or requested narrowing exceed authority', () => {
  assert.throws(() => buildAgentDefinitionLaunchRequestV1(form({
    ownerCapabilityIdsText: 'research\nadmin',
  }), {
    registry: registry(),
    definition: definition(),
    ownerPolicy: ownerPolicy(),
  }), /Owner capability grants exceeds the selected Agent definition authority/u);

  assert.throws(() => buildAgentDefinitionLaunchRequestV1(form({
    ownerCapabilityIdsText: 'research',
    requestedCapabilityIdsText: 'browser',
  }), {
    registry: registry(),
    definition: definition(),
    ownerPolicy: ownerPolicy(),
  }), /Requested capability narrowing exceeds the selected Agent definition authority/u);

  assert.throws(() => buildAgentDefinitionLaunchRequestV1(form({
    ownerToolIdsText: 'browser.read',
    requestedToolIdsText: 'files.read',
  }), {
    registry: registry(),
    definition: definition(),
    ownerPolicy: ownerPolicy(),
  }), /Requested tool narrowing exceeds the selected Agent definition authority/u);
});

test('disabled, stale-representation and duplicate inputs fail before command construction', () => {
  assert.throws(() => buildAgentDefinitionLaunchRequestV1(form(), {
    registry: registry(),
    definition: definition({ enabled: false }),
    ownerPolicy: ownerPolicy(),
  }), /disabled/u);

  assert.throws(() => buildAgentDefinitionLaunchRequestV1(form(), {
    registry: registry({ revision: -0 }),
    definition: definition(),
    ownerPolicy: ownerPolicy(),
  }), /positive safe integer/u);

  assert.throws(() => buildAgentDefinitionLaunchRequestV1(form({
    requestedToolIdsText: 'browser.read\nbrowser.read',
  }), {
    registry: registry(),
    definition: definition(),
    ownerPolicy: ownerPolicy(),
  }), /duplicate identity/u);

  assert.throws(() => agentDefinitionOwnerBudgetFromPolicyV1(ownerPolicy({ maxCostUsd: -0 })),
    /canonical non-negative number/u);
});

test('hostile form accessors are rejected without execution', () => {
  let reads = 0;
  const hostile = form();
  Object.defineProperty(hostile, 'goal', {
    enumerable: true,
    get() {
      reads += 1;
      return 'must not execute';
    },
  });

  assert.throws(() => buildAgentDefinitionLaunchRequestV1(hostile, {
    registry: registry(),
    definition: definition(),
    ownerPolicy: ownerPolicy(),
  }), /enumerable own data property/u);
  assert.equal(reads, 0);
});
