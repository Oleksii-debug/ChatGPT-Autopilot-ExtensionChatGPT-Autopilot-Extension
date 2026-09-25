import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SemanticRecomputeStatus,
  normalizeSemanticDependencyGraphV1,
  normalizeSemanticDependencyNodeV1,
  planSemanticRecomputeV1,
} from '../src/core/semantic-change-graph.js';

function node(nodeId, nodeKind, overrides = {}) {
  const isSource = overrides.isSource ?? false;
  return {
    schemaVersion:1,
    nodeId,
    nodeKind,
    revisionId:overrides.revisionId ?? 'rev-1',
    isSource,
    recomputePriority:overrides.recomputePriority ?? 100,
    verificationRequired:overrides.verificationRequired ?? !isSource,
    verifierIds:overrides.verifierIds ?? (isSource ? [] : ['verify.default']),
  };
}

function edge(edgeId, fromNodeId, toNodeId, semanticClasses) {
  return { schemaVersion:1, edgeId, fromNodeId, toNodeId, semanticClasses };
}

function baseGraph(overrides = {}) {
  const nodes = [
    node('source.scheduler', 'source.contract', { isSource:true, revisionId:'sched-1' }),
    node('source.readme', 'source.docs', { isSource:true, revisionId:'readme-1' }),
    node('impl.scheduler', 'implementation', { recomputePriority:20, verifierIds:['verify.impl'] }),
    node('test.scheduler', 'test', { recomputePriority:10, verifierIds:['verify.test'] }),
    node('ui.scheduler', 'ui', { recomputePriority:30, verifierIds:['verify.ui'] }),
    node('release.scheduler', 'release-evidence', { recomputePriority:40, verifierIds:['verify.release'] }),
    node('docs.readme', 'documentation', { recomputePriority:5, verificationRequired:false, verifierIds:[] }),
    node('security.unrelated', 'verification', { recomputePriority:1, verifierIds:['verify.security'] }),
  ];
  const edges = [
    edge('e-sched-impl', 'source.scheduler', 'impl.scheduler', ['scheduler.contract']),
    edge('e-impl-test', 'impl.scheduler', 'test.scheduler', ['scheduler.contract']),
    edge('e-impl-ui', 'impl.scheduler', 'ui.scheduler', ['scheduler.contract']),
    edge('e-test-release', 'test.scheduler', 'release.scheduler', ['scheduler.contract']),
    edge('e-ui-release', 'ui.scheduler', 'release.scheduler', ['scheduler.contract']),
    edge('e-readme-docs', 'source.readme', 'docs.readme', ['docs.readme']),
  ];
  return {
    schemaVersion:1,
    graphId:'product.graph',
    revisionId:'graph-1',
    capturedAt:'2026-09-25T05:40:00.000Z',
    nodes,
    edges,
    ...overrides,
  };
}

function change(changeId, sourceNodeId, fromRevisionId, toRevisionId, semanticClasses, overrides = {}) {
  return {
    schemaVersion:1,
    changeId,
    sourceNodeId,
    fromRevisionId,
    toRevisionId,
    semanticClasses,
    observedAt:'2026-09-25T05:41:00.000Z',
    ...overrides,
  };
}

function request(changes, graph = baseGraph(), overrides = {}) {
  return {
    schemaVersion:1,
    graph,
    changes,
    asOf:'2026-09-25T05:42:00.000Z',
    ...overrides,
  };
}

test('scheduler contract change invalidates only the scheduler-dependent subgraph in dependency-safe priority order', () => {
  const result = planSemanticRecomputeV1(request([
    change('chg-scheduler', 'source.scheduler', 'sched-1', 'sched-2', ['scheduler.contract']),
  ]));
  assert.equal(result.status, SemanticRecomputeStatus.READY);
  assert.deepEqual(result.invalidationSet.map(item => item.nodeId), [
    'impl.scheduler',
    'release.scheduler',
    'test.scheduler',
    'ui.scheduler',
  ]);
  assert.deepEqual(result.recomputePlan.map(item => item.nodeId), [
    'impl.scheduler',
    'test.scheduler',
    'ui.scheduler',
    'release.scheduler',
  ]);
  assert.equal(result.invalidationSet.every(item => item.staleDerivedState), true);
  assert.equal(result.recomputePlan.every(item => item.executionAuthorized === false), true);
  assert.equal(result.fullRecomputeRequired, false);
});

test('README-only semantic delta does not wake unrelated implementation, security or release nodes', () => {
  const result = planSemanticRecomputeV1(request([
    change('chg-readme', 'source.readme', 'readme-1', 'readme-2', ['docs.readme']),
  ]));
  assert.deepEqual(result.invalidationSet.map(item => item.nodeId), ['docs.readme']);
  assert.deepEqual(result.recomputePlan.map(item => item.nodeId), ['docs.readme']);
  assert.equal(result.invalidationSet.some(item => item.nodeId === 'security.unrelated'), false);
  assert.equal(result.invalidationSet.some(item => item.nodeId === 'release.scheduler'), false);
});

test('nonmatching semantic classes do not traverse dependency edges', () => {
  const result = planSemanticRecomputeV1(request([
    change('chg-scheduler-doc', 'source.scheduler', 'sched-1', 'sched-2', ['docs.readme']),
  ]));
  assert.deepEqual(result.invalidationSet, []);
  assert.deepEqual(result.recomputePlan, []);
  assert.equal(result.status, SemanticRecomputeStatus.READY);
});

test('multi-change propagation unions semantic classes and causes deterministically', () => {
  const graph = baseGraph({
    nodes:[
      ...baseGraph().nodes,
      node('shared.dashboard', 'artifact', { recomputePriority:50, verifierIds:['verify.dashboard'] }),
    ],
    edges:[
      ...baseGraph().edges,
      edge('e-sched-shared', 'source.scheduler', 'shared.dashboard', ['scheduler.contract']),
      edge('e-readme-shared', 'source.readme', 'shared.dashboard', ['docs.readme']),
    ],
  });
  const first = change('chg-a', 'source.scheduler', 'sched-1', 'sched-2', ['scheduler.contract']);
  const second = change('chg-b', 'source.readme', 'readme-1', 'readme-2', ['docs.readme']);
  const forward = planSemanticRecomputeV1(request([first, second], graph));
  const reverse = planSemanticRecomputeV1(request([second, first], graph));
  assert.deepEqual(reverse, forward);
  const shared = forward.invalidationSet.find(item => item.nodeId === 'shared.dashboard');
  assert.deepEqual(shared.semanticClasses, ['docs.readme', 'scheduler.contract']);
  assert.deepEqual(shared.causeChangeIds, ['chg-a', 'chg-b']);
});

test('required verifier coverage blocks readiness but never authorizes verification itself', () => {
  const graph = baseGraph({
    nodes:baseGraph().nodes.map(item =>
      item.nodeId === 'test.scheduler'
        ? { ...item, verifierIds:[] }
        : item),
  });
  const result = planSemanticRecomputeV1(request([
    change('chg-scheduler', 'source.scheduler', 'sched-1', 'sched-2', ['scheduler.contract']),
  ], graph));
  assert.equal(result.status, SemanticRecomputeStatus.BLOCKED_VERIFIER_COVERAGE);
  assert.deepEqual(result.verificationCoverage.missingVerifierNodeIds, ['test.scheduler']);
  const testStep = result.recomputePlan.find(item => item.nodeId === 'test.scheduler');
  assert.equal(testStep.verificationAuthorized, false);
});

test('source revisions, graph time and change time are causally bound', () => {
  assert.throws(() => planSemanticRecomputeV1(request([
    change('wrong-base', 'source.scheduler', 'sched-old', 'sched-2', ['scheduler.contract']),
  ])), /fromRevisionId does not match/);

  assert.throws(() => planSemanticRecomputeV1(request([
    change('future', 'source.scheduler', 'sched-1', 'sched-2', ['scheduler.contract'], {
      observedAt:'2026-09-25T05:42:00.001Z',
    }),
  ])), /from the future/);

  assert.throws(() => planSemanticRecomputeV1(request([
    change('predates', 'source.scheduler', 'sched-1', 'sched-2', ['scheduler.contract'], {
      observedAt:'2026-09-25T05:39:59.999Z',
    }),
  ])), /predates graph snapshot/);

  assert.throws(() => planSemanticRecomputeV1(request([
    change('same-rev', 'source.scheduler', 'sched-1', 'sched-1', ['scheduler.contract']),
  ])), /must advance revision/);
});

test('changes must originate at source nodes and one batch cannot skip multiple revisions of one source', () => {
  assert.throws(() => planSemanticRecomputeV1(request([
    change('derived', 'impl.scheduler', 'rev-1', 'rev-2', ['scheduler.contract']),
  ])), /must reference a source node/);

  assert.throws(() => planSemanticRecomputeV1(request([
    change('a', 'source.scheduler', 'sched-1', 'sched-2', ['scheduler.contract']),
    change('b', 'source.scheduler', 'sched-1', 'sched-3', ['scheduler.contract']),
  ])), /multiple revisions/);
});

test('graph rejects cycles, dangling edges, source targets and duplicate dependency relations', () => {
  const graph = baseGraph();
  assert.throws(() => normalizeSemanticDependencyGraphV1({
    ...graph,
    edges:[
      ...graph.edges,
      edge('e-cycle-a', 'release.scheduler', 'impl.scheduler', ['scheduler.contract']),
    ],
  }), /acyclic/);

  assert.throws(() => normalizeSemanticDependencyGraphV1({
    ...graph,
    edges:[
      ...graph.edges,
      edge('e-dangling', 'missing.node', 'impl.scheduler', ['scheduler.contract']),
    ],
  }), /unknown node/);

  assert.throws(() => normalizeSemanticDependencyGraphV1({
    ...graph,
    edges:[
      ...graph.edges,
      edge('e-source-target', 'impl.scheduler', 'source.scheduler', ['scheduler.contract']),
    ],
  }), /cannot target a source node/);

  assert.throws(() => normalizeSemanticDependencyGraphV1({
    ...graph,
    edges:[
      ...graph.edges,
      edge('e-duplicate-relation', 'source.scheduler', 'impl.scheduler', ['scheduler.contract']),
    ],
  }), /duplicate dependency relation/);
});

test('semantic edges require explicit classes; no wildcard broad wakeup is synthesized', () => {
  assert.throws(() => normalizeSemanticDependencyGraphV1({
    ...baseGraph(),
    edges:[
      edge('empty', 'source.scheduler', 'impl.scheduler', []),
    ],
  }), /must not be empty/);
});

test('node and identity boundaries reject coercive aliases', () => {
  assert.throws(() => normalizeSemanticDependencyNodeV1(
    node(' impl.scheduler', 'implementation'),
  ), /exact canonical identity/);
  assert.throws(() => normalizeSemanticDependencyGraphV1({
    ...baseGraph(),
    capturedAt:'2026-09-25T05:40:00Z',
  }), /canonical ISO-8601/);
});

test('record and collection boundaries execute zero caller getters', () => {
  let nodeReads = 0;
  const proxiedNode = new Proxy(node('safe.node', 'artifact'), {
    get(target, key, receiver) {
      nodeReads += 1;
      if (key === 'nodeId') return 'forged.node';
      return Reflect.get(target, key, receiver);
    },
  });
  const normalized = normalizeSemanticDependencyNodeV1(proxiedNode);
  assert.equal(nodeReads, 0);
  assert.equal(normalized.nodeId, 'safe.node');

  let arrayReads = 0;
  const nodes = new Proxy(baseGraph().nodes, {
    get(target, key, receiver) {
      arrayReads += 1;
      if (key === 'length') return 999999;
      return Reflect.get(target, key, receiver);
    },
  });
  const graph = normalizeSemanticDependencyGraphV1({ ...baseGraph(), nodes });
  assert.equal(arrayReads, 0);
  assert.equal(graph.nodes.length, baseGraph().nodes.length);

  let itemReads = 0;
  const changes = [];
  Object.defineProperty(changes, 0, {
    enumerable:true,
    configurable:true,
    get() {
      itemReads += 1;
      return change('chg', 'source.scheduler', 'sched-1', 'sched-2', ['scheduler.contract']);
    },
  });
  assert.throws(() => planSemanticRecomputeV1(request(changes)), /enumerable own data properties/);
  assert.equal(itemReads, 0);
});

test('hidden, symbol, sparse and exotic authority is rejected', () => {
  const hidden = node('hidden.node', 'artifact');
  Object.defineProperty(hidden, 'revisionId', {
    enumerable:false,
    configurable:true,
    value:'rev-1',
  });
  assert.throws(() => normalizeSemanticDependencyNodeV1(hidden), /enumerable own data property/);

  const symbolic = node('symbol.node', 'artifact');
  symbolic[Symbol('authority')] = true;
  assert.throws(() => normalizeSemanticDependencyNodeV1(symbolic), /symbol field/);

  const sparse = new Array(1);
  assert.throws(() => normalizeSemanticDependencyGraphV1({
    ...baseGraph(),
    nodes:sparse,
  }), /dense data-only array/);

  const exotic = [...baseGraph().nodes];
  Object.setPrototypeOf(exotic, null);
  assert.throws(() => normalizeSemanticDependencyGraphV1({
    ...baseGraph(),
    nodes:exotic,
  }), /bounded plain array/);
});

test('recompute planning never creates tasks, effects, policy decisions or execution authority', () => {
  const result = planSemanticRecomputeV1(request([
    change('chg-scheduler', 'source.scheduler', 'sched-1', 'sched-2', ['scheduler.contract']),
  ]));
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.recomputePlan.every(step => step.executionAuthorized === false), true);
  assert.equal(result.recomputePlan.every(step => step.verificationAuthorized === false), true);
  assert.equal('taskId' in result, false);
  assert.equal('effectId' in result, false);
  assert.equal('policyDecision' in result, false);
});
