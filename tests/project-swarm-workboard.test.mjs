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
  assert.equal(publish.needsAttention, true);

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

test('workboard does not disclose raw task evidence, objectives, budgets, conflict keys or review evidence IDs', () => {
  const board = buildProjectSwarmWorkboardV1(validInput());
  const serialized = JSON.stringify(board);
  assert.equal(serialized.includes('SUPER_SECRET_RESULT'), false);
  assert.equal(serialized.includes('private-resource'), false);
  assert.equal(serialized.includes('review-evidence-1'), false);
  assert.equal(serialized.includes('Objective a-source'), false);
  assert.equal(serialized.includes('maxCostUsdMicros'), false);
  assert.equal(Object.hasOwn(board.entries[0], 'evidence'), false);
  assert.equal(Object.hasOwn(board.entries[0], 'conflictKeys'), false);
  assert.equal(Object.hasOwn(board.entries[0], 'objective'), false);
  assert.equal(Object.hasOwn(board.entries[0], 'budget'), false);
});

test('verified work remains in review until an approved or merged review observation exists', () => {
  const input = validInput();
  input.reviews = [review('plan-a', 'a-source', {
    state: WorkboardReviewState.CHANGES_REQUESTED,
    evidenceIds: ['change-request-1'],
  })];
  let board = buildProjectSwarmWorkboardV1(input);
  assert.equal(entry(board, 'plan-a', 'a-source').lane, WorkboardLane.REVIEW);
  assert.equal(entry(board, 'plan-a', 'a-source').needsAttention, true);

  input.reviews = [review('plan-a', 'a-source', {
    state: WorkboardReviewState.REQUESTED,
    evidenceIds: [],
  })];
  board = buildProjectSwarmWorkboardV1(input);
  assert.equal(entry(board, 'plan-a', 'a-source').lane, WorkboardLane.REVIEW);

  input.reviews = [];
  board = buildProjectSwarmWorkboardV1(input);
  assert.equal(entry(board, 'plan-a', 'a-source').reviewState, 'UNREVIEWED');
  assert.equal(entry(board, 'plan-a', 'a-source').lane, WorkboardLane.REVIEW);
});

test('review observations fail closed unless they resolve to verified work with causal evidence', () => {
  const nonVerified = validInput();
  nonVerified.reviews = [review('plan-a', 'b-publish')];
  assert.throws(() => buildProjectSwarmWorkboardV1(nonVerified), /review requires VERIFIED task/);

  const missingEvidence = validInput();
  missingEvidence.reviews = [review('plan-a', 'a-source', { evidenceIds: [] })];
  assert.throws(() => buildProjectSwarmWorkboardV1(missingEvidence), /evidenceIds is required/);

  const predatesTask = validInput();
  predatesTask.reviews = [review('plan-a', 'a-source', { updatedAt: '2026-09-25T03:59:59.000Z' })];
  assert.throws(() => buildProjectSwarmWorkboardV1(predatesTask), /predates task verification/);

  const future = validInput();
  future.reviews = [review('plan-a', 'a-source', { updatedAt: '2026-09-25T07:00:00.001Z' })];
  assert.throws(() => buildProjectSwarmWorkboardV1(future), /postdates generatedAt/);

  const unknown = validInput();
  unknown.reviews = [review('plan-a', 'missing')];
  assert.throws(() => buildProjectSwarmWorkboardV1(unknown), /unknown task/);
});

test('duplicate plans, jobs and review subjects are rejected', () => {
  const duplicatePlan = validInput();
  duplicatePlan.planSnapshots.push(structuredClone(duplicatePlan.planSnapshots[1]));
  assert.throws(() => buildProjectSwarmWorkboardV1(duplicatePlan), /duplicate planId/);

  const duplicateJob = validInput();
  duplicateJob.planSnapshots[0].plan.jobId = 'job-a';
  assert.throws(() => buildProjectSwarmWorkboardV1(duplicateJob), /duplicate current jobId/);

  const duplicateReview = validInput();
  duplicateReview.reviews.push(structuredClone(duplicateReview.reviews[0]));
  assert.throws(() => buildProjectSwarmWorkboardV1(duplicateReview), /duplicate review subject/);
});

test('Project revision binding is exact and board rejects future plan state', () => {
  const wrongProject = validInput();
  wrongProject.planSnapshots[0].projectId = 'project-b';
  assert.throws(() => buildProjectSwarmWorkboardV1(wrongProject), /not bound to the workboard Project revision/);

  const wrongRevision = validInput();
  wrongRevision.planSnapshots[0].projectRevisionId = 'project-r8';
  assert.throws(() => buildProjectSwarmWorkboardV1(wrongRevision), /not bound to the workboard Project revision/);

  const futurePlan = validInput();
  futurePlan.planSnapshots[0].plan.updatedAt = '2026-09-25T07:00:00.001Z';
  futurePlan.planSnapshots[0].plan.nodes[0].updatedAt = '2026-09-25T06:30:00.000Z';
  futurePlan.planSnapshots[0].plan.nodes[1].updatedAt = '2026-09-25T06:30:00.000Z';
  assert.throws(() => buildProjectSwarmWorkboardV1(futurePlan), /postdates generatedAt/);
});

test('exact timestamp representation is required at board, plan, node and review boundaries', () => {
  const boardAlias = validInput();
  boardAlias.generatedAt = '2026-09-25T07:00:00Z';
  assert.throws(() => buildProjectSwarmWorkboardV1(boardAlias), /canonical ISO-8601/);

  const planAlias = validInput();
  planAlias.planSnapshots[0].plan.updatedAt = '2026-09-25T06:00:00Z';
  assert.throws(() => buildProjectSwarmWorkboardV1(planAlias), /canonical ISO-8601/);

  const nodeAlias = validInput();
  nodeAlias.planSnapshots[0].plan.nodes[0].updatedAt = '2026-09-25T05:30:00Z';
  assert.throws(() => buildProjectSwarmWorkboardV1(nodeAlias), /canonical ISO-8601/);

  const reviewAlias = validInput();
  reviewAlias.reviews[0].updatedAt = '2026-09-25T06:30:00Z';
  assert.throws(() => buildProjectSwarmWorkboardV1(reviewAlias), /canonical ISO-8601/);
});

test('READY/RUNNING state cannot contradict unresolved same-plan dependencies', () => {
  for (const state of ['READY', 'RUNNING']) {
    const input = validInput();
    input.planSnapshots[1].plan.nodes[0].state = 'RUNNING';
    input.planSnapshots[1].plan.nodes[0].evidence = '';
    input.planSnapshots[1].plan.nodes[1].state = state;
    input.reviews = [];
    assert.throws(() => buildProjectSwarmWorkboardV1(input), /with unmet dependencies/);
  }
});

test('top-level and review accessors fail without executing getters', () => {
  let reads = 0;
  const input = validInput();
  Object.defineProperty(input, 'projectId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return PROJECT_ID;
    },
  });
  assert.throws(() => buildProjectSwarmWorkboardV1(input), /enumerable own data properties/);
  assert.equal(reads, 0);

  const reviewInput = validInput();
  Object.defineProperty(reviewInput.reviews[0], 'state', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return WorkboardReviewState.APPROVED;
    },
  });
  assert.throws(() => buildProjectSwarmWorkboardV1(reviewInput), /enumerable own data properties/);
  assert.equal(reads, 0);
});

test('workboard arrays are descriptor-snapshotted without ordinary Proxy reads', () => {
  let reads = 0;
  const wrap = value => new Proxy(value, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const input = validInput();
  input.planSnapshots[0].plan.nodes = wrap(input.planSnapshots[0].plan.nodes);
  input.planSnapshots = wrap(input.planSnapshots);
  input.reviews = wrap(input.reviews);
  const board = buildProjectSwarmWorkboardV1(input);
  assert.equal(board.taskCount, 4);
  assert.equal(reads, 0);
});

test('hidden, symbol, unknown and exotic request/review fields fail closed', () => {
  const hidden = validInput();
  Object.defineProperty(hidden, 'projectId', { value: PROJECT_ID, enumerable: false, configurable: true });
  assert.throws(() => buildProjectSwarmWorkboardV1(hidden), /enumerable own data properties/);

  const unknown = validInput();
  unknown.executionAuthorized = true;
  assert.throws(() => buildProjectSwarmWorkboardV1(unknown), /unknown field/);

  const symbol = validInput();
  symbol.reviews[0][Symbol('authority')] = 'ALLOW';
  assert.throws(() => buildProjectSwarmWorkboardV1(symbol), /unknown field/);

  const exotic = validInput();
  exotic.reviews[0] = Object.assign(Object.create({ state: WorkboardReviewState.APPROVED }), exotic.reviews[0]);
  assert.throws(() => buildProjectSwarmWorkboardV1(exotic), /plain data object/);
});

test('null-prototype request and review records remain valid data-only inputs', () => {
  const input = validInput();
  input.reviews[0] = Object.assign(Object.create(null), input.reviews[0]);
  const request = Object.assign(Object.create(null), input);
  const board = buildProjectSwarmWorkboardV1(request);
  assert.equal(board.taskCount, 4);
  assert.equal(entry(board, 'plan-a', 'a-source').lane, WorkboardLane.DONE);
});
