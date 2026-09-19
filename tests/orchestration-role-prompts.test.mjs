import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OrchestrationRoleTemplate,
  buildOrchestrationRecoveryPrompt,
  buildOrchestrationRolePrompt,
  buildThreeLevelHierarchyTemplate,
} from '../src/core/orchestration-role-prompts.js';
import {
  OrchestrationBarrierMode,
  OrchestrationChatMode,
  validateOrchestrationGraphV1,
} from '../src/core/orchestration-hierarchy.js';

const BASE = {
  graphId: 'autosport-hierarchy',
  projectId: 'autosport',
  targetRepository: 'Oleksii-debug/Autosport',
  controlIssueNumber: 1,
  domains: [
    { id: 'science', scope: 'Scientific model, evidence and validation.' },
    { id: 'runtime', scope: 'Runtime, execution, recovery and reliability.' },
  ],
  workersPerManager: 2,
};

test('role prompt makes semantic reasoning external and forbids manufactured activity', () => {
  const prompt = buildOrchestrationRolePrompt({
    role: OrchestrationRoleTemplate.WORKER,
    nodeId: 'worker:runtime:01',
    parentNodeId: 'manager:runtime',
    projectId: 'autosport',
    targetRepository: 'Oleksii-debug/Autosport',
    controlIssueNumber: 1,
    scope: 'Runtime reliability slice.',
  });
  assert.match(prompt, /Autopilot is only the deterministic orchestration\/runtime authority/);
  assert.match(prompt, /Do not create scheduler #2, recovery #2, executor #2/);
  assert.match(prompt, /do not manufacture activity; finish safely as NO_ACTION/);
  assert.match(prompt, /Take one useful, bounded, currently unowned slice/);
  assert.match(prompt, /STATUS=COMPLETED \| PARTIAL \| BLOCKED \| NO_ACTION/);
});

test('recovery prompt preserves logical role without relying on lost chat transcript', () => {
  const prompt = buildOrchestrationRecoveryPrompt({
    logicalRole: OrchestrationRoleTemplate.DOMAIN_MANAGER,
    nodeId: 'manager:runtime',
    parentNodeId: 'director',
    projectId: 'autosport',
    targetRepository: 'Oleksii-debug/Autosport',
    controlIssueNumber: 1,
    scope: 'Runtime and recovery.',
    childNodeIds: ['worker:runtime:01'],
  });
  assert.match(prompt, /ROLE != CHAT/);
  assert.match(prompt, /DIRECT_CHILDREN=worker:runtime:01/);
  assert.match(prompt, /previous transcript as unavailable and non-authoritative/);
  assert.match(prompt, /stale-generation ownership/);
  assert.match(prompt, /RECOVERED_LOGICAL_ROLE=DOMAIN_MANAGER/);
});

test('three-level template deterministically builds Director -> Managers -> fixed Workers', () => {
  const a = buildThreeLevelHierarchyTemplate(BASE);
  const b = buildThreeLevelHierarchyTemplate({
    ...BASE,
    domains: [...BASE.domains].reverse(),
  });
  assert.deepEqual(a, b);
  assert.deepEqual(a.rootIds, ['director']);
  assert.equal(a.nodeOrder.length, 7);
  assert.equal(a.promptProfiles.length, 14);

  const director = a.nodesById.director;
  assert.equal(director.chatMode, OrchestrationChatMode.PERSISTENT_CHAT);
  assert.deepEqual(director.childIds, ['manager:runtime', 'manager:science']);
  assert.equal(director.barrier.mode, OrchestrationBarrierMode.ALL_DIRECT_CHILDREN);

  for (const managerId of director.childIds) {
    const manager = a.nodesById[managerId];
    assert.equal(manager.chatMode, OrchestrationChatMode.PERSISTENT_CHAT);
    assert.equal(manager.childIds.length, 2);
    assert.equal(manager.barrier.mode, OrchestrationBarrierMode.ALL_DIRECT_CHILDREN);
    for (const workerId of manager.childIds) {
      const worker = a.nodesById[workerId];
      assert.equal(worker.chatMode, OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION);
      assert.deepEqual(worker.childIds, []);
      assert.equal(worker.barrier.mode, OrchestrationBarrierMode.NONE);
    }
  }

  assert.deepEqual(validateOrchestrationGraphV1(a), a, 'template must already be valid durable hierarchy state');
});

test('five managers x five workers stays bounded at 31 logical nodes', () => {
  const domains = Array.from({ length: 5 }, (_, index) => ({
    id: `domain-${index + 1}`,
    scope: `Bounded domain ${index + 1}.`,
  }));
  const graph = buildThreeLevelHierarchyTemplate({
    ...BASE,
    graphId: 'five-by-five',
    domains,
    workersPerManager: 5,
  });
  assert.equal(graph.nodeOrder.length, 31);
  assert.equal(graph.nodeOrder.filter(id => id.startsWith('manager:')).length, 5);
  assert.equal(graph.nodeOrder.filter(id => id.startsWith('worker:')).length, 25);
  assert.equal(graph.nodesById.director.maxActiveChildren, 5);
});

test('optional Integration and QA roles are separate persistent Director children', () => {
  const graph = buildThreeLevelHierarchyTemplate({
    ...BASE,
    includeIntegrationManager: true,
    includeQaRedTeam: true,
  });
  assert.ok(graph.nodesById.director.childIds.includes('integration'));
  assert.ok(graph.nodesById.director.childIds.includes('qa-red-team'));
  assert.equal(graph.nodesById.integration.chatMode, OrchestrationChatMode.PERSISTENT_CHAT);
  assert.equal(graph.nodesById['qa-red-team'].chatMode, OrchestrationChatMode.PERSISTENT_CHAT);
  const integrationProfile = graph.promptProfiles.find(p => p.id === 'integration:prompt-v1');
  const qaProfile = graph.promptProfiles.find(p => p.id === 'qa-red-team:prompt-v1');
  assert.equal(integrationProfile.role, OrchestrationRoleTemplate.INTEGRATION_MANAGER);
  assert.equal(qaProfile.role, OrchestrationRoleTemplate.QA_RED_TEAM);
  assert.match(qaProfile.prompt, /independent QA \/ red team/i);
});

test('template fails closed on duplicate domains, invalid counts and malformed repository', () => {
  assert.throws(() => buildThreeLevelHierarchyTemplate({
    ...BASE,
    domains: [
      { id: 'same', scope: 'A' },
      { id: 'same', scope: 'B' },
    ],
  }), /Duplicate domain id/);
  assert.throws(() => buildThreeLevelHierarchyTemplate({ ...BASE, workersPerManager: 0 }), /workersPerManager/);
  assert.throws(() => buildThreeLevelHierarchyTemplate({ ...BASE, workersPerManager: 41 }), /workersPerManager/);
  assert.throws(() => buildThreeLevelHierarchyTemplate({ ...BASE, targetRepository: 'not-a-repository' }), /targetRepository/);
});
