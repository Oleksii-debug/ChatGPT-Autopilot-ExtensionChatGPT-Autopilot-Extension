import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentRunTimelineV1 } from '../src/core/agent-run-timeline.js';

function fixture() {
  return {
    id: 'job-1',
    config: { secret: 'PRIVATE_TOKEN_DO_NOT_EXPORT' },
    runtime: {
      plan: {
        planId: 'plan-1',
        revision: 3,
        nodes: [
          { nodeId: 'node-a', state: 'RUNNING', executionPlane: 'LOCAL', objective: 'PRIVATE_NODE_A' },
          { nodeId: 'node-b', state: 'VERIFIED', executionPlane: 'CLOUD', objective: 'PRIVATE_NODE_B' },
          { nodeId: 'node-c', state: 'READY', executionPlane: 'BROWSER' },
        ],
      },
      history: [{ at: 123, type: 'specialist-handoff-prepared', message: 'PRIVATE_PROMPT' }],
      specialistHandoffs: [
        { agentId: 'specialist:plan-1:node-a', parentAgentId: 'browser-agent:job-1',
          jobId: 'job-1', state: 'LEASED', purpose: 'PRIVATE_CHILD_A' },
        { agentId: 'specialist:plan-1:node-b', parentAgentId: 'browser-agent:job-1',
          jobId: 'job-1', state: 'COMPLETED', purpose: 'PRIVATE_CHILD_B' },
      ],
    },
  };
}

test('S1 durable Specialist plan links are structural metadata, not execution receipts', () => {
  const input = fixture();
  const before = structuredClone(input);
  const view = buildAgentRunTimelineV1(input);
  const links = view.evidenceMap.specialistPlanLinks;
  assert.equal(links.recordPresent, true);
  assert.equal(links.inspectedHandoffs, 2);
  assert.equal(links.structurallyLinkedChildren, 2);
  assert.equal(links.agentTreeEdgesVerified, false);
  assert.equal(links.externalEffectVerified, false);
  assert.equal(view.evidenceMap.externalEffectVerified, false);
  assert.equal(view.evidenceOnly, true);
  assert.equal(view.mayReplayExternalEffect, false);
  assert.deepEqual(input, before);
  assert.deepEqual(view, buildAgentRunTimelineV1(JSON.parse(JSON.stringify(input))));
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_|specialist:plan-1:node|browser-agent:job-1/u);
});

test('S1 canonical plan link mismatch fails closed without promoting child authority', () => {
  const invalid = [
    ['wrong parent', item => { item.runtime.specialistHandoffs[0].parentAgentId = 'browser-agent:someone-else'; }],
    ['wrong job', item => { item.runtime.specialistHandoffs[0].jobId = 'someone-else'; }],
    ['wrong plan', item => { item.runtime.specialistHandoffs[0].agentId = 'specialist:plan-else:node-a'; }],
    ['wrong node', item => { item.runtime.specialistHandoffs[0].agentId = 'specialist:plan-1:missing-node'; }],
    ['browser-only node', item => { item.runtime.specialistHandoffs[0].agentId = 'specialist:plan-1:node-c'; }],
    ['duplicate child', item => { item.runtime.specialistHandoffs[1].agentId = 'specialist:plan-1:node-a'; }],
    ['invalid state', item => { item.runtime.specialistHandoffs[0].state = 'VERIFIED'; }],
    ['no plan', item => { delete item.runtime.plan; }],
    ['no nodes', item => { delete item.runtime.plan.nodes; }],
    ['corrupt array', item => { item.runtime.specialistHandoffs = [item.runtime.specialistHandoffs[0], , item.runtime.specialistHandoffs[1]]; }],
  ];
  for (const [name, mutate] of invalid) {
    const input = fixture();
    mutate(input);
    assert.throws(() => buildAgentRunTimelineV1(input), /Agent specialist|Agent plan/u, name);
  }
});

test('S1 hidden and getter-backed linkage does not become durable recorded evidence', () => {
  for (const key of ['agentId', 'parentAgentId', 'jobId', 'state']) {
    const input = fixture();
    const child = input.runtime.specialistHandoffs[0];
    Object.defineProperty(child, key, { value: child[key], enumerable: false });
    assert.throws(() => buildAgentRunTimelineV1(input), /Agent specialist|enumerable data field/u);
  }
  let called = 0;
  const input = fixture();
  Object.defineProperty(input.runtime.specialistHandoffs[0], 'agentId', {
    enumerable: true,
    get() { called++; throw Error('PRIVATE_GETTER_TRAP'); },
  });
  assert.throws(() => buildAgentRunTimelineV1(input), error =>
    error instanceof Error && !error.message.includes('PRIVATE_GETTER_TRAP'));
  assert.equal(called, 0);
  const trap = fixture();
  trap.runtime.specialistHandoffs[0] = new Proxy(trap.runtime.specialistHandoffs[0], {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'agentId') throw Error('PRIVATE_PROXY_TRAP');
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.throws(() => buildAgentRunTimelineV1(trap), error =>
    error instanceof Error && !error.message.includes('PRIVATE_PROXY_TRAP'));
});

test('S1 absent legacy/empty handoffs preserve conservative restart reporting', () => {
  const missing = fixture();
  delete missing.runtime.specialistHandoffs;
  const absent = buildAgentRunTimelineV1(missing).evidenceMap.specialistPlanLinks;
  assert.equal(absent.recordPresent, false);
  assert.equal(absent.structurallyLinkedChildren, 0);
  const empty = fixture();
  empty.runtime.specialistHandoffs = [];
  const result = buildAgentRunTimelineV1(JSON.parse(JSON.stringify(empty)));
  assert.equal(result.evidenceMap.specialistPlanLinks.recordPresent, true);
  assert.equal(result.evidenceMap.specialistPlanLinks.structurallyLinkedChildren, 0);
  assert.equal(result.evidenceMap.specialistPlanLinks.agentTreeEdgesVerified, false);
  assert.equal(result.mayReplayExternalEffect, false);
});
