import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WorkboardLane,
  WorkboardReviewState,
  buildProjectSwarmWorkboardV1,
} from '../src/core/project-swarm-workboard.js';

const PROJECT_ID = 'project-a';
const PROJECT_REVISION = 'project-r7';
const GENERATED_AT = '2026-09-25T07:00:00.000Z';

function node(nodeId, {
  state = 'PENDING',
  dependsOn = [],
  conflictKeys = [],
  ownerId = '',
  updatedAt = '2026-09-25T05:00:00.000Z',
  evidence = '',
} = {}) {
  return {
    nodeId,
    title: `Task ${nodeId}`,
    objective: `Objective ${nodeId}`,
    dependsOn,
    conflictKeys,
    ownerId,
    executionPlane: 'LOCAL',
    acceptanceCriteria: [`Verify ${nodeId}`],
    budget: { maxModelCalls: 0, maxRuntimeSeconds: 0, maxCostUsdMicros: 0 },
    state,
    evidence,
    updatedAt,
  };
}

function plan(planId, jobId, nodes) {
  return {
    schemaVersion: 1,
    planId,
    jobId,
    objective: `Plan ${planId}`,
    successCriteria: ['All tasks complete'],
    nodes,
    createdAt: '2026-09-25T03:00:00.000Z',
    updatedAt: '2026-09-25T06:00:00.000Z',
    revision: 4,
  };
}

function snapshot(planValue) {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    projectRevisionId: PROJECT_REVISION,
    plan: planValue,
  };
}

function review(planId, nodeId, {
  state = WorkboardReviewState.APPROVED,
  reviewerId = 'reviewer-1',
  evidenceIds = ['review-evidence-1'],
  updatedAt = '2026-09-25T06:30:00.000Z',
} = {}) {
  return {
    schemaVersion: 1,
    planId,
    nodeId,
    state,
    reviewerId,
    evidenceIds,
    updatedAt,
  };
}

function validInput() {
  const planA = plan('plan-a', 'job-a', [
    node('a-source', {
      state: 'VERIFIED',
      updatedAt: '2026-09-25T04:00:00.000Z',
      evidence: 'SUPER_SECRET_RESULT',
    }),
    node('b-publish', {
      state: 'READY',
      dependsOn: ['a-source'],
      conflictKeys: ['private-resource'],
      ownerId: 'worker-a',
    }),
  ]);
  const planB = plan('plan-b', 'job-b', [
    node('a-audit', {
      state: 'RUNNING',
      conflictKeys: ['private-resource'],
      ownerId: 'worker-b',
      updatedAt: '2026-09-25T05:30:00.000Z',
    }),
    node('b-follow', {
      state: 'PENDING',
      dependsOn: ['a-audit'],
      updatedAt: '2026-09-25T05:30:00.000Z',
    }),
  ]);
  return {
    schemaVersion: 1,
    boardId: 'board-1',
    projectId: PROJECT_ID,
    projectRevisionId: PROJECT_REVISION,
    generatedAt: GENERATED_AT,
    planSnapshots: [snapshot(planB), snapshot(planA)],
    reviews: [review('plan-a', 'a-source')],
  };
}

function entry(board, planId, nodeId) {
  return board.entries.find(item => item.taskRef.planId === planId && item.taskRef.nodeId === nodeId);
}

test('workboard derives deterministic keyboard order, visual lanes, dependencies, conflicts and review state', () => {
  const board = buildProjectSwarmWorkboardV1(validInput());
  assert.equal(board.projectId, PROJECT_ID);
  assert.equal(board.planCount, 2);
  assert.equal(board.taskCount, 4);
  assert.equal(board.reviewCount, 1);
  assert.equal(board.keyboardModel, 'LINEAR_TASK_ORDER');
  assert.equal(board.semanticTwinComplete, true);
  assert.equal(board.coordinateNavigationRequired, false);
  assert.equal(board.advisoryOnly, true);
  assert.equal(board.executionAuthorized, false);
  assert.equal(board.mutationAuthorized, false);
  assert.equal(board.reviewDecisionAuthorized, false);

  assert.deepEqual(
    board.entries.map(item => [item.focusOrdinal, item.taskRef.planId, item.taskRef.nodeId]),
    [
      [1, 'plan-a', 'a-source'],
      [2, 'plan-a', 'b-publish'],
      [3, 'plan-b', 'a-audit'],
      [4, 'plan-b', 'b-follow'],
    ],
  );

  const source = entry(board, 'plan-a', 'a-source');
  assert.equal(source.lane, WorkboardLane.DONE);
  assert.equal(source.reviewState, WorkboardReviewState.APPROVED);
  assert.equal(source.reviewEvidenceCount, 1);

  const publish = entry(board, 'plan-a', 'b-publish');
  assert.equal(publish.lane, WorkboardLane.READY);
  assert.deepEqual(publish.dependencyTaskRefs, [{ planId: 'plan-a', nodeId: 'a-source' }]);
  assert.deepEqual(publish.unmetDependencyTaskRefs, []);
  assert.deepEqual(publish.activeConflictTaskRefs, [{ planId: 'plan-b', nodeId: 'a-audit' }]);

  const audit = entry(board, 'plan-b', 'a-audit');
  assert.equal(audit.lane, WorkboardLane.ACTIVE);
  assert.deepEqual(audit.activeConflictTaskRefs, []);

  const follow = entry(board, 'plan-b', 'b-follow');
  assert.equal(follow.lane, WorkboardLane.WAITING);
  assert.deepEqual(follow.unmetDependencyTaskRefs, [{ planId: 'plan-b', nodeId: 'a-audit' }]);

  assert.equal(board.lanes.find(lane => lane.lane === WorkboardLane.READY).taskRefs.length, 1);
  assert.equal(board.entries.every(item => item.keyboardReachable), true);
  assert.equal(Object.isFrozen(board), true);
  assert.equal(Object.isFrozen(board.entries), true);
  assert.equal(Object.isFrozen(board.entries[0].taskRef), true);
});

test('workboard does not disclose raw task ev