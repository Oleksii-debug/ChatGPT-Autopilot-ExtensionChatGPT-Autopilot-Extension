import { validateOrchestrationGraphV1 } from './orchestration-hierarchy.js';
import { normalizeSubagentStructurePolicyV1 } from './subagent-structure-policy.js';

export const BROWSER_AGENT_ORCHESTRATION_BINDING_VERSION = 1;

export const BrowserAgentOrchestrationBindingStatus = Object.freeze({
  CURRENT: 'CURRENT',
  PROJECT_AUTHORITY_DRIFTED: 'PROJECT_AUTHORITY_DRIFTED',
  GRAPH_DRIFTED: 'GRAPH_DRIFTED',
  CONTROL_EPOCH_DRIFTED: 'CONTROL_EPOCH_DRIFTED',
  NODE_MISSING: 'NODE_MISSING',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const AUTHORITY_KEYS = new Set([
  'schemaVersion', 'orchestraId', 'projectId', 'graphId', 'controlEpoch',
  'graph', 'subagentPolicy',
]);
const BINDING_KEYS = new Set([
  'schemaVersion', 'jobId', 'projectId', 'orchestraId', 'graphId',
  'controlEpoch', 'nodeId', 'boundAt',
]);
const REQUEST_KEYS = new Set(['nodeId', 'expectedGraphId', 'expectedControlEpoch']);
const CREATE_AUTHORITY_KEYS = new Set(['orchestraId', 'projectId', 'graph', 'subagentPolicy']);
const CREATE_BINDING_KEYS = new Set([
  'jobId', 'projectId', 'boundAt', 'authority', 'request', 'currentBinding',
]);
const INSPECT_BINDING_KEYS = new Set(['binding', 'authority']);

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${String(key)} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function id(value, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function browserAgentJobId(value, label) {
  if (typeof value !== 'string'
      || value !== value.trim()
      || !value
      || value.length > 128) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function browserAgentJobId(value) {
  if (typeof value !== 'string'
      || value !== value.trim()
      || !value
      || value.length > 128) {
    throw new Error('binding jobId is invalid');
  }
  return value;
}

function positiveInteger(value, label, { optional = false } = {}) {
  if (optional && value === undefined) return null;
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 1) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

export function normalizeBrowserAgentOrchestrationBindingRequestV1(input) {
  const raw = strictRecord(input, REQUEST_KEYS, 'BrowserAgentOrchestrationBindingRequestV1');
  const expectedGraphId = id(raw.expectedGraphId, 'expectedGraphId', { optional: true });
  const expectedControlEpoch = positiveInteger(
    raw.expectedControlEpoch,
    'expectedControlEpoch',
    { optional: true },
  );
  return frozen({
    nodeId: id(raw.nodeId, 'nodeId'),
    expectedGraphId,
    expectedControlEpoch,
  });
}

export function createOrchestrationProjectAuthorityV1(input = {}) {
  const raw = strictRecord(
    input,
    CREATE_AUTHORITY_KEYS,
    'OrchestrationProjectAuthorityCreateRequestV1',
  );
  const canonicalGraph = validateOrchestrationGraphV1(raw.graph);
  return normalizeOrchestrationProjectAuthorityV1({
    schemaVersion: BROWSER_AGENT_ORCHESTRATION_BINDING_VERSION,
    orchestraId: raw.orchestraId,
    projectId: raw.projectId,
    graphId: canonicalGraph.graphId,
    controlEpoch: canonicalGraph.controlEpoch,
    graph: canonicalGraph,
    subagentPolicy: raw.subagentPolicy,
  });
}

export function normalizeOrchestrationProjectAuthorityV1(input) {
  const raw = strictRecord(input, AUTHORITY_KEYS, 'OrchestrationProjectAuthorityV1');
  if (raw.schemaVersion !== BROWSER_AGENT_ORCHESTRATION_BINDING_VERSION) {
    throw new Error('Unsupported OrchestrationProjectAuthorityV1 schemaVersion');
  }
  const graph = validateOrchestrationGraphV1(raw.graph);
  const graphId = id(raw.graphId, 'authority graphId');
  const controlEpoch = positiveInteger(raw.controlEpoch, 'authority controlEpoch');
  if (graph.graphId !== graphId || graph.controlEpoch !== controlEpoch) {
    throw new Error('Orchestration project authority graph provenance mismatch');
  }
  return frozen({
    schemaVersion: BROWSER_AGENT_ORCHESTRATION_BINDING_VERSION,
    orchestraId: id(raw.orchestraId, 'authority orchestraId'),
    projectId: id(raw.projectId, 'authority projectId'),
    graphId,
    controlEpoch,
    graph,
    subagentPolicy: normalizeSubagentStructurePolicyV1(raw.subagentPolicy),
  });
}

export function createBrowserAgentOrchestrationNodeBindingV1(input = {}) {
  const raw = strictRecord(
    input,
    CREATE_BINDING_KEYS,
    'BrowserAgentOrchestrationNodeBindingCreateRequestV1',
  );
  const canonicalAuthority = normalizeOrchestrationProjectAuthorityV1(raw.authority);
  const canonicalRequest = normalizeBrowserAgentOrchestrationBindingRequestV1(raw.request);
  const canonicalJobId = browserAgentJobId(raw.jobId);
  const canonicalProjectId = id(raw.projectId, 'binding projectId');
  if (canonicalAuthority.projectId !== canonicalProjectId) {
    throw new Error('Orchestration project authority does not match Browser Agent project');
  }
  if (canonicalRequest.expectedGraphId && canonicalRequest.expectedGraphId !== canonicalAuthority.graphId) {
    throw new Error('Orchestration graph changed before Browser Agent binding');
  }
  if (canonicalRequest.expectedControlEpoch !== null
      && canonicalRequest.expectedControlEpoch !== canonicalAuthority.controlEpoch) {
    throw new Error('Orchestration control epoch changed before Browser Agent binding');
  }
  if (!Object.hasOwn(canonicalAuthority.graph.nodesById, canonicalRequest.nodeId)) {
    throw new Error('Browser Agent orchestration node is not present in canonical hierarchy');
  }

  const candidate = normalizeBrowserAgentOrchestrationNodeBindingV1({
    schemaVersion: BROWSER_AGENT_ORCHESTRATION_BINDING_VERSION,
    jobId: canonicalJobId,
    projectId: canonicalProjectId,
    orchestraId: canonicalAuthority.orchestraId,
    graphId: canonicalAuthority.graphId,
    controlEpoch: canonicalAuthority.controlEpoch,
    nodeId: canonicalRequest.nodeId,
    boundAt: nonNegativeInteger(raw.boundAt, 'binding boundAt'),
  });

  if (raw.currentBinding == null) return candidate;
  const current = normalizeBrowserAgentOrchestrationNodeBindingV1(raw.currentBinding);
  const same = current.jobId === candidate.jobId
    && current.projectId === candidate.projectId
    && current.orchestraId === candidate.orchestraId
    && current.graphId === candidate.graphId
    && current.controlEpoch === candidate.controlEpoch
    && current.nodeId === candidate.nodeId;
  if (!same) {
    throw new Error('Browser Agent is already bound to a different orchestration node authority');
  }
  return current;
}

export function normalizeBrowserAgentOrchestrationNodeBindingV1(input) {
  const raw = strictRecord(input, BINDING_KEYS, 'BrowserAgentOrchestrationNodeBindingV1');
  if (raw.schemaVersion !== BROWSER_AGENT_ORCHESTRATION_BINDING_VERSION) {
    throw new Error('Unsupported BrowserAgentOrchestrationNodeBindingV1 schemaVersion');
  }
  return frozen({
    schemaVersion: BROWSER_AGENT_ORCHESTRATION_BINDING_VERSION,
    jobId: browserAgentJobId(raw.jobId),
    projectId: id(raw.projectId, 'binding projectId'),
    orchestraId: id(raw.orchestraId, 'binding orchestraId'),
    graphId: id(raw.graphId, 'binding graphId'),
    controlEpoch: positiveInteger(raw.controlEpoch, 'binding controlEpoch'),
    nodeId: id(raw.nodeId, 'binding nodeId'),
    boundAt: nonNegativeInteger(raw.boundAt, 'binding boundAt'),
  });
}

export function inspectBrowserAgentOrchestrationNodeBindingV1(input = {}) {
  const raw = strictRecord(
    input,
    INSPECT_BINDING_KEYS,
    'BrowserAgentOrchestrationNodeBindingInspectionRequestV1',
  );
  const canonicalBinding = normalizeBrowserAgentOrchestrationNodeBindingV1(raw.binding);
  const canonicalAuthority = normalizeOrchestrationProjectAuthorityV1(raw.authority);
  let status = BrowserAgentOrchestrationBindingStatus.CURRENT;
  if (canonicalAuthority.projectId !== canonicalBinding.projectId
      || canonicalAuthority.orchestraId !== canonicalBinding.orchestraId) {
    status = BrowserAgentOrchestrationBindingStatus.PROJECT_AUTHORITY_DRIFTED;
  } else if (canonicalAuthority.graphId !== canonicalBinding.graphId) {
    status = BrowserAgentOrchestrationBindingStatus.GRAPH_DRIFTED;
  } else if (canonicalAuthority.controlEpoch !== canonicalBinding.controlEpoch) {
    status = BrowserAgentOrchestrationBindingStatus.CONTROL_EPOCH_DRIFTED;
  } else if (!Object.hasOwn(canonicalAuthority.graph.nodesById, canonicalBinding.nodeId)) {
    status = BrowserAgentOrchestrationBindingStatus.NODE_MISSING;
  }
  return frozen({
    binding: canonicalBinding,
    status,
    current: status === BrowserAgentOrchestrationBindingStatus.CURRENT,
    currentAuthority: {
      orchestraId: canonicalAuthority.orchestraId,
      projectId: canonicalAuthority.projectId,
      graphId: canonicalAuthority.graphId,
      controlEpoch: canonicalAuthority.controlEpoch,
      subagentPolicy: canonicalAuthority.subagentPolicy,
    },
  });
}
