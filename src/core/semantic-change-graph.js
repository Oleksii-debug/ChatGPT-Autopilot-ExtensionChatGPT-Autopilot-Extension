export const SemanticChangeGraphContractVersion = 1;

export const SemanticRecomputeStatus = Object.freeze({
  READY: 'READY',
  BLOCKED_VERIFIER_COVERAGE: 'BLOCKED_VERIFIER_COVERAGE',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_NODES = 512;
const MAX_EDGES = 4096;
const MAX_LIST = 128;
const MAX_CHANGES = 64;
const MAX_PRIORITY = 10_000;

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(snapshot);
}

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field`);
    }
  }
}

function version(value, label) {
  if (value !== SemanticChangeGraphContractVersion) {
    throw new Error(`Unsupported ${label} schemaVersion`);
  }
  return SemanticChangeGraphContractVersion;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must use exact canonical identity representation`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function dataArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const length = lengthDescriptor.value;
  const out = new Array(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) {
      throw new Error(`${label} contains non-index array data`);
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || String(index) !== key
        || !descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} entries must be enumerable own data properties`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must be a dense data-only array`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function idSet(value, label, max, { allowEmpty = true } = {}) {
  const out = dataArray(value, label, max)
    .map((item, index) => exactId(item, `${label}[${index}]`))
    .sort(asciiCompare);
  if (!allowEmpty && out.length === 0) throw new Error(`${label} must not be empty`);
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return out;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const NODE_KEYS = new Set([
  'schemaVersion',
  'nodeId',
  'nodeKind',
  'revisionId',
  'isSource',
  'recomputePriority',
  'verificationRequired',
  'verifierIds',
]);

export function normalizeSemanticDependencyNodeV1(input) {
  const raw = plain(input, 'SemanticDependencyNodeV1');
  exactKeys(raw, NODE_KEYS, 'SemanticDependencyNodeV1');
  const isSource = bool(raw.isSource, 'isSource');
  const verificationRequired = bool(raw.verificationRequired, 'verificationRequired');
  const verifierIds = idSet(raw.verifierIds, 'verifierIds', MAX_LIST);
  if (isSource && (verificationRequired || verifierIds.length)) {
    throw new Error('source nodes cannot require derived-state verification');
  }
  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'SemanticDependencyNodeV1'),
    nodeId: exactId(raw.nodeId, 'nodeId'),
    nodeKind: exactId(raw.nodeKind, 'nodeKind'),
    revisionId: exactId(raw.revisionId, 'revisionId'),
    isSource,
    recomputePriority: integer(raw.recomputePriority, 'recomputePriority', 0, MAX_PRIORITY),
    verificationRequired,
    verifierIds,
  });
}

const EDGE_KEYS = new Set([
  'schemaVersion',
  'edgeId',
  'fromNodeId',
  'toNodeId',
  'semanticClasses',
]);

export function normalizeSemanticDependencyEdgeV1(input) {
  const raw = plain(input, 'SemanticDependencyEdgeV1');
  exactKeys(raw, EDGE_KEYS, 'SemanticDependencyEdgeV1');
  const fromNodeId = exactId(raw.fromNodeId, 'fromNodeId');
  const toNodeId = exactId(raw.toNodeId, 'toNodeId');
  if (fromNodeId === toNodeId) throw new Error('dependency edge cannot self-reference');
  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'SemanticDependencyEdgeV1'),
    edgeId: exactId(raw.edgeId, 'edgeId'),
    fromNodeId,
    toNodeId,
    semanticClasses: idSet(raw.semanticClasses, 'semanticClasses', MAX_LIST, { allowEmpty:false }),
  });
}

const GRAPH_KEYS = new Set([
  'schemaVersion',
  'graphId',
  'revisionId',
  'capturedAt',
  'nodes',
  'edges',
]);

function topologicalNodeIds(nodes, edges) {
  const indegree = new Map(nodes.map(node => [node.nodeId, 0]));
  const outgoing = new Map(nodes.map(node => [node.nodeId, []]));
  for (const edge of edges) {
    indegree.set(edge.toNodeId, indegree.get(edge.toNodeId) + 1);
    outgoing.get(edge.fromNodeId).push(edge.toNodeId);
  }
  for (const targets of outgoing.values()) targets.sort(asciiCompare);

  const ready = [...nodes]
    .filter(node => indegree.get(node.nodeId) === 0)
    .map(node => node.nodeId)
    .sort(asciiCompare);
  const result = [];
  while (ready.length) {
    const nodeId = ready.shift();
    result.push(nodeId);
    for (const targetId of outgoing.get(nodeId)) {
      const next = indegree.get(targetId) - 1;
      indegree.set(targetId, next);
      if (next === 0) {
        ready.push(targetId);
        ready.sort(asciiCompare);
      }
    }
  }
  if (result.length !== nodes.length) throw new Error('SemanticDependencyGraphV1 must be acyclic');
  return result;
}

export function normalizeSemanticDependencyGraphV1(input) {
  const raw = plain(input, 'SemanticDependencyGraphV1');
  exactKeys(raw, GRAPH_KEYS, 'SemanticDependencyGraphV1');
  const nodes = dataArray(raw.nodes, 'nodes', MAX_NODES)
    .map(normalizeSemanticDependencyNodeV1)
    .sort((a, b) => asciiCompare(a.nodeId, b.nodeId));
  if (nodes.length === 0) throw new Error('nodes must not be empty');
  const nodeMap = new Map();
  for (const node of nodes) {
    if (nodeMap.has(node.nodeId)) throw new Error('nodes contains duplicate nodeId');
    nodeMap.set(node.nodeId, node);
  }

  const edges = dataArray(raw.edges, 'edges', MAX_EDGES)
    .map(normalizeSemanticDependencyEdgeV1)
    .sort((a, b) => asciiCompare(a.edgeId, b.edgeId));
  const edgeIds = new Set();
  const relationIds = new Set();
  for (const edge of edges) {
    if (edgeIds.has(edge.edgeId)) throw new Error('edges contains duplicate edgeId');
    edgeIds.add(edge.edgeId);
    const from = nodeMap.get(edge.fromNodeId);
    const to = nodeMap.get(edge.toNodeId);
    if (!from || !to) throw new Error(`edge ${edge.edgeId} references unknown node`);
    if (to.isSource) throw new Error(`edge ${edge.edgeId} cannot target a source node`);
    const relationId = `${edge.fromNodeId}\u0000${edge.toNodeId}\u0000${edge.semanticClasses.join('\u0001')}`;
    if (relationIds.has(relationId)) throw new Error('edges contains duplicate dependency relation');
    relationIds.add(relationId);
  }
  topologicalNodeIds(nodes, edges);

  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'SemanticDependencyGraphV1'),
    graphId: exactId(raw.graphId, 'graphId'),
    revisionId: exactId(raw.revisionId, 'revisionId'),
    capturedAt: canonicalTimestamp(raw.capturedAt, 'capturedAt'),
    nodes,
    edges,
  });
}

const CHANGE_KEYS = new Set([
  'schemaVersion',
  'changeId',
  'sourceNodeId',
  'fromRevisionId',
  'toRevisionId',
  'semanticClasses',
  'observedAt',
]);

export function normalizeSemanticChangeV1(input) {
  const raw = plain(input, 'SemanticChangeV1');
  exactKeys(raw, CHANGE_KEYS, 'SemanticChangeV1');
  const fromRevisionId = exactId(raw.fromRevisionId, 'fromRevisionId');
  const toRevisionId = exactId(raw.toRevisionId, 'toRevisionId');
  if (fromRevisionId === toRevisionId) throw new Error('SemanticChangeV1 must advance revision');
  return deepFreeze({
    schemaVersion: version(raw.schemaVersion, 'SemanticChangeV1'),
    changeId: exactId(raw.changeId, 'changeId'),
    sourceNodeId: exactId(raw.sourceNodeId, 'sourceNodeId'),
    fromRevisionId,
    toRevisionId,
    semanticClasses: idSet(raw.semanticClasses, 'semanticClasses', MAX_LIST, { allowEmpty:false }),
    observedAt: canonicalTimestamp(raw.observedAt, 'observedAt'),
  });
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter(item => rightSet.has(item));
}

function propagateOneChange(change, graph, outgoingByNode) {
  const classesByNode = new Map([[change.sourceNodeId, new Set(change.semanticClasses)]]);
  const queue = [change.sourceNodeId];
  while (queue.length) {
    const nodeId = queue.shift();
    const activeClasses = [...classesByNode.get(nodeId)].sort(asciiCompare);
    for (const edge of outgoingByNode.get(nodeId) || []) {
      const matched = intersection(activeClasses, edge.semanticClasses);
      if (!matched.length) continue;
      let targetClasses = classesByNode.get(edge.toNodeId);
      if (!targetClasses) {
        targetClasses = new Set();
        classesByNode.set(edge.toNodeId, targetClasses);
      }
      let changed = false;
      for (const semanticClass of matched) {
        if (!targetClasses.has(semanticClass)) {
          targetClasses.add(semanticClass);
          changed = true;
        }
      }
      if (changed) queue.push(edge.toNodeId);
    }
  }
  classesByNode.delete(change.sourceNodeId);
  return classesByNode;
}

function dependencySafePlan(impactedNodes, graph) {
  const impactedSet = new Set(impactedNodes.map(item => item.nodeId));
  const nodeById = new Map(graph.nodes.map(node => [node.nodeId, node]));
  const indegree = new Map(impactedNodes.map(item => [item.nodeId, 0]));
  const outgoing = new Map(impactedNodes.map(item => [item.nodeId, []]));
  for (const edge of graph.edges) {
    if (!impactedSet.has(edge.fromNodeId) || !impactedSet.has(edge.toNodeId)) continue;
    indegree.set(edge.toNodeId, indegree.get(edge.toNodeId) + 1);
    outgoing.get(edge.fromNodeId).push(edge.toNodeId);
  }
  const compareReady = (a, b) =>
    nodeById.get(a).recomputePriority - nodeById.get(b).recomputePriority
      || asciiCompare(a, b);
  const ready = impactedNodes
    .filter(item => indegree.get(item.nodeId) === 0)
    .map(item => item.nodeId)
    .sort(compareReady);
  const ordered = [];
  while (ready.length) {
    const nodeId = ready.shift();
    ordered.push(nodeId);
    for (const targetId of outgoing.get(nodeId)) {
      const next = indegree.get(targetId) - 1;
      indegree.set(targetId, next);
      if (next === 0) {
        ready.push(targetId);
        ready.sort(compareReady);
      }
    }
  }
  if (ordered.length !== impactedNodes.length) throw new Error('impacted dependency graph is cyclic');
  return ordered;
}

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'graph',
  'changes',
  'asOf',
]);

export function planSemanticRecomputeV1(input) {
  const raw = plain(input, 'SemanticRecomputeRequestV1');
  exactKeys(raw, REQUEST_KEYS, 'SemanticRecomputeRequestV1');
  version(raw.schemaVersion, 'SemanticRecomputeRequestV1');
  const graph = normalizeSemanticDependencyGraphV1(raw.graph);
  const asOf = canonicalTimestamp(raw.asOf, 'asOf');
  const asOfMs = Date.parse(asOf);
  const graphCapturedMs = Date.parse(graph.capturedAt);
  if (graphCapturedMs > asOfMs) throw new Error('graph capturedAt cannot be after asOf');

  const changes = dataArray(raw.changes, 'changes', MAX_CHANGES)
    .map(normalizeSemanticChangeV1)
    .sort((a, b) => asciiCompare(a.changeId, b.changeId));
  if (changes.length === 0) throw new Error('changes must not be empty');

  const nodeById = new Map(graph.nodes.map(node => [node.nodeId, node]));
  const changeIds = new Set();
  const changedSourceIds = new Set();
  for (const change of changes) {
    if (changeIds.has(change.changeId)) throw new Error('changes contains duplicate changeId');
    changeIds.add(change.changeId);
    if (changedSourceIds.has(change.sourceNodeId)) {
      throw new Error('changes contains multiple revisions for one sourceNodeId');
    }
    changedSourceIds.add(change.sourceNodeId);
    const sourceNode = nodeById.get(change.sourceNodeId);
    if (!sourceNode || !sourceNode.isSource) {
      throw new Error(`change ${change.changeId} sourceNodeId must reference a source node`);
    }
    if (sourceNode.revisionId !== change.fromRevisionId) {
      throw new Error(`change ${change.changeId} fromRevisionId does not match graph source revision`);
    }
    const observedMs = Date.parse(change.observedAt);
    if (observedMs < graphCapturedMs) {
      throw new Error(`change ${change.changeId} predates graph snapshot`);
    }
    if (observedMs > asOfMs) {
      throw new Error(`change ${change.changeId} is from the future`);
    }
  }

  const outgoingByNode = new Map(graph.nodes.map(node => [node.nodeId, []]));
  for (const edge of graph.edges) outgoingByNode.get(edge.fromNodeId).push(edge);
  for (const edges of outgoingByNode.values()) {
    edges.sort((a, b) => asciiCompare(a.edgeId, b.edgeId));
  }

  const impact = new Map();
  for (const change of changes) {
    const local = propagateOneChange(change, graph, outgoingByNode);
    for (const [nodeId, semanticClasses] of local.entries()) {
      let entry = impact.get(nodeId);
      if (!entry) {
        entry = { classes:new Set(), causes:new Set() };
        impact.set(nodeId, entry);
      }
      for (const semanticClass of semanticClasses) entry.classes.add(semanticClass);
      entry.causes.add(change.changeId);
    }
  }

  const invalidationSet = [...impact.entries()]
    .map(([nodeId, entry]) => {
      const node = nodeById.get(nodeId);
      return deepFreeze({
        nodeId,
        nodeKind: node.nodeKind,
        priorRevisionId: node.revisionId,
        staleDerivedState: true,
        semanticClasses: [...entry.classes].sort(asciiCompare),
        causeChangeIds: [...entry.causes].sort(asciiCompare),
        recomputePriority: node.recomputePriority,
        verificationRequired: node.verificationRequired,
        verifierIds: [...node.verifierIds],
        recomputeAuthorized: false,
      });
    })
    .sort((a, b) => asciiCompare(a.nodeId, b.nodeId));

  const missingVerifierNodeIds = invalidationSet
    .filter(item => item.verificationRequired && item.verifierIds.length === 0)
    .map(item => item.nodeId)
    .sort(asciiCompare);

  const planOrder = dependencySafePlan(invalidationSet, graph);
  const invalidationById = new Map(invalidationSet.map(item => [item.nodeId, item]));
  const recomputePlan = planOrder.map((nodeId, stepIndex) => {
    const item = invalidationById.get(nodeId);
    return deepFreeze({
      stepIndex,
      nodeId,
      nodeKind: item.nodeKind,
      semanticClasses: [...item.semanticClasses],
      causeChangeIds: [...item.causeChangeIds],
      recomputePriority: item.recomputePriority,
      verificationRequired: item.verificationRequired,
      verifierIds: [...item.verifierIds],
      executionAuthorized: false,
      verificationAuthorized: false,
    });
  });

  const changedSources = changes.map(change => deepFreeze({
    changeId: change.changeId,
    sourceNodeId: change.sourceNodeId,
    fromRevisionId: change.fromRevisionId,
    toRevisionId: change.toRevisionId,
    semanticClasses: [...change.semanticClasses],
    observedAt: change.observedAt,
  }));

  return deepFreeze({
    schemaVersion: SemanticChangeGraphContractVersion,
    graphId: graph.graphId,
    graphRevisionId: graph.revisionId,
    asOf,
    status: missingVerifierNodeIds.length
      ? SemanticRecomputeStatus.BLOCKED_VERIFIER_COVERAGE
      : SemanticRecomputeStatus.READY,
    changedSources,
    invalidationSet,
    recomputePlan,
    verificationCoverage: {
      complete: missingVerifierNodeIds.length === 0,
      missingVerifierNodeIds,
    },
    fullRecomputeRequired: false,
    executionAuthorized: false,
  });
}
