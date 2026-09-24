import {
  normalizeCapabilityV1,
  normalizeToolDescriptorV1,
} from './universal-agent-contracts.js';

export const ProviderHealthStatus = Object.freeze({
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
});

export const CapabilityPathReadiness = Object.freeze({
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  NEEDS_AUTH: 'NEEDS_AUTH',
  NEEDS_INSTALL: 'NEEDS_INSTALL',
  NEEDS_HEALTH_CHECK: 'NEEDS_HEALTH_CHECK',
  UNAVAILABLE: 'UNAVAILABLE',
});

export const CapabilityPathKind = Object.freeze({
  API: 'API',
  CLI: 'CLI',
  SEMANTIC_BROWSER: 'SEMANTIC_BROWSER',
  UIA: 'UIA',
  VISUAL: 'VISUAL',
  OCR: 'OCR',
});

const HEALTH = new Set(Object.values(ProviderHealthStatus));
const PATH_KINDS = new Set(Object.values(CapabilityPathKind));
const EXECUTABLE = new Set([CapabilityPathReadiness.READY, CapabilityPathReadiness.DEGRADED]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_CAPABILITIES = 512;
const MAX_TOOLS = 2048;
const MAX_PROVIDER_STATES = 512;
const MAX_REQUESTED_CAPABILITIES = 64;
const MAX_LATENCY_MS = 10 * 60_000;

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be own data properties`);
    }
    if (!descriptor.enumerable) throw new Error(`${label} contains non-enumerable field: ${key}`);
  }
  return value;
}

function exact(raw, allowed, label) {
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error(`${label} contains unknown field`);
  }
}

function id(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const out = value.trim();
  if (!ID.test(out)) throw new Error(`${label} is invalid`);
  return out;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function optionalInteger(value, label, max) {
  if (value == null) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`${label} is invalid`);
  return value;
}

function boundedArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains non-index array data`);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
      throw new Error(`${label} contains an invalid array index`);
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
  }
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must not be sparse`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

const PROVIDER_STATE_KEYS = new Set([
  'schemaVersion',
  'providerId',
  'toolId',
  'health',
  'installationRequired',
  'installed',
  'authenticationRequired',
  'authenticated',
  'pathKind',
  'latencyMs',
  'reasonCode',
]);

export function normalizeProviderReadinessV1(input) {
  const raw = plain(input, 'ProviderReadinessV1');
  exact(raw, PROVIDER_STATE_KEYS, 'ProviderReadinessV1');
  if (raw.schemaVersion !== 1) throw new Error('ProviderReadinessV1 schemaVersion is invalid');
  const health = id(raw.health, 'health').toUpperCase();
  if (!HEALTH.has(health)) throw new Error('health is invalid');
  return frozen({
    schemaVersion: 1,
    providerId: id(raw.providerId, 'providerId'),
    toolId: raw.toolId == null || raw.toolId === '' ? '' : id(raw.toolId, 'toolId'),
    health,
    installationRequired: bool(raw.installationRequired, 'installationRequired'),
    installed: bool(raw.installed, 'installed'),
    authenticationRequired: bool(raw.authenticationRequired, 'authenticationRequired'),
    authenticated: bool(raw.authenticated, 'authenticated'),
    pathKind: (() => {
      const value = id(raw.pathKind, 'pathKind').toUpperCase();
      if (!PATH_KINDS.has(value)) throw new Error('pathKind is invalid');
      return value;
    })(),
    latencyMs: optionalInteger(raw.latencyMs, 'latencyMs', MAX_LATENCY_MS),
    reasonCode: raw.reasonCode == null || raw.reasonCode === '' ? '' : id(raw.reasonCode, 'reasonCode'),
  });
}

function readinessFor(state) {
  if (!state) return CapabilityPathReadiness.NEEDS_HEALTH_CHECK;
  if (state.health === ProviderHealthStatus.UNAVAILABLE) return CapabilityPathReadiness.UNAVAILABLE;
  if (state.installationRequired && !state.installed) return CapabilityPathReadiness.NEEDS_INSTALL;
  if (state.authenticationRequired && !state.authenticated) return CapabilityPathReadiness.NEEDS_AUTH;
  if (state.health === ProviderHealthStatus.UNKNOWN) return CapabilityPathReadiness.NEEDS_HEALTH_CHECK;
  if (state.health === ProviderHealthStatus.DEGRADED) return CapabilityPathReadiness.DEGRADED;
  return CapabilityPathReadiness.READY;
}

function normalizeInventory({ capabilities, tools, providerStates }) {
  const normalizedCapabilities = boundedArray(capabilities, 'capabilities', MAX_CAPABILITIES).map(normalizeCapabilityV1);
  const capabilityIds = new Set(normalizedCapabilities.map(item => item.capabilityId));
  if (capabilityIds.size !== normalizedCapabilities.length) throw new Error('capabilities contain duplicate capabilityId');

  const normalizedTools = boundedArray(tools, 'tools', MAX_TOOLS).map(normalizeToolDescriptorV1);
  const toolIds = new Set(normalizedTools.map(item => item.toolId));
  if (toolIds.size !== normalizedTools.length) throw new Error('tools contain duplicate toolId');
  for (const tool of normalizedTools) {
    for (const capabilityId of tool.capabilityIds) {
      if (!capabilityIds.has(capabilityId)) {
        throw new Error(`tool ${tool.toolId} references unknown capability ${capabilityId}`);
      }
    }
  }

  const normalizedStates = boundedArray(providerStates, 'providerStates', MAX_PROVIDER_STATES).map(normalizeProviderReadinessV1);
  const toolsById = new Map(normalizedTools.map(tool => [tool.toolId, tool]));
  const statesByProviderTool = new Map();
  for (const state of normalizedStates) {
    if (state.toolId) {
      const tool = toolsById.get(state.toolId);
      if (!tool) throw new Error(`providerStates references unknown toolId: ${state.toolId}`);
      if (tool.providerId !== state.providerId) {
        throw new Error(`providerStates toolId ${state.toolId} does not belong to providerId ${state.providerId}`);
      }
    }
    const key = `${state.providerId}\u0000${state.toolId}`;
    if (statesByProviderTool.has(key)) throw new Error('providerStates contain duplicate provider/tool readiness identity');
    statesByProviderTool.set(key, state);
  }

  return { normalizedCapabilities, normalizedTools, statesByProviderTool, capabilityIds };
}

function requestedIds(value) {
  const raw = boundedArray(value, 'requestedCapabilityIds', MAX_REQUESTED_CAPABILITIES);
  const out = raw.map((item, index) => id(item, `requestedCapabilityIds[${index}]`));
  if (new Set(out).size !== out.length) throw new Error('requestedCapabilityIds contains duplicates');
  return out.sort();
}

function readinessRank(value) {
  return {
    [CapabilityPathReadiness.READY]: 0,
    [CapabilityPathReadiness.DEGRADED]: 1,
    [CapabilityPathReadiness.NEEDS_AUTH]: 2,
    [CapabilityPathReadiness.NEEDS_INSTALL]: 3,
    [CapabilityPathReadiness.NEEDS_HEALTH_CHECK]: 4,
    [CapabilityPathReadiness.UNAVAILABLE]: 5,
  }[value] ?? 99;
}

function pathRank(value) {
  return {
    [CapabilityPathKind.API]: 0,
    [CapabilityPathKind.CLI]: 1,
    [CapabilityPathKind.SEMANTIC_BROWSER]: 2,
    [CapabilityPathKind.UIA]: 3,
    [CapabilityPathKind.VISUAL]: 4,
    [CapabilityPathKind.OCR]: 5,
  }[value] ?? 99;
}

function latencyRank(value) {
  return value > 0 ? value : Number.MAX_SAFE_INTEGER;
}

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCandidate(a, b) {
  return readinessRank(a.readiness) - readinessRank(b.readiness)
    || pathRank(a.pathKind) - pathRank(b.pathKind)
    || b.matchingCapabilityIds.length - a.matchingCapabilityIds.length
    || latencyRank(a.latencyMs) - latencyRank(b.latencyMs)
    || asciiCompare(a.providerId, b.providerId)
    || asciiCompare(a.toolId, b.toolId);
}

function comparePlanCandidate(a, b) {
  return readinessRank(a.candidate.readiness) - readinessRank(b.candidate.readiness)
    || pathRank(a.candidate.pathKind) - pathRank(b.candidate.pathKind)
    || b.uncoveredIds.length - a.uncoveredIds.length
    || latencyRank(a.candidate.latencyMs) - latencyRank(b.candidate.latencyMs)
    || asciiCompare(a.candidate.providerId, b.candidate.providerId)
    || asciiCompare(a.candidate.toolId, b.candidate.toolId);
}

function providerFacts(providerId, toolId, statesByProviderTool) {
  const toolSpecific = statesByProviderTool.get(`${providerId}\u0000${toolId}`);
  if (toolSpecific) return toolSpecific;
  const providerWide = statesByProviderTool.get(`${providerId}\u0000`);
  if (providerWide) return providerWide;
  return Object.freeze({
    schemaVersion: 1,
    providerId,
    toolId,
    health: ProviderHealthStatus.UNKNOWN,
    installationRequired: false,
    installed: false,
    authenticationRequired: false,
    authenticated: false,
    pathKind: CapabilityPathKind.OCR,
    latencyMs: 0,
    reasonCode: 'PROVIDER_STATE_MISSING',
  });
}

function buildPlan(candidates, knownRequestedIds) {
  const uncovered = new Set(knownRequestedIds);
  const steps = [];
  while (uncovered.size) {
    const eligible = candidates
      .filter(candidate => EXECUTABLE.has(candidate.readiness))
      .map(candidate => ({
        candidate,
        uncoveredIds: candidate.matchingCapabilityIds.filter(capabilityId => uncovered.has(capabilityId)),
      }))
      .filter(item => item.uncoveredIds.length)
      .sort(comparePlanCandidate);
    if (!eligible.length) break;
    const selected = eligible[0];
    const capabilityIds = [...selected.uncoveredIds].sort();
    for (const capabilityId of capabilityIds) uncovered.delete(capabilityId);
    steps.push(frozen({
      stepIndex: steps.length,
      providerId: selected.candidate.providerId,
      toolId: selected.candidate.toolId,
      capabilityIds,
      readiness: selected.candidate.readiness,
      pathKind: selected.candidate.pathKind,
      requiresPolicyDecision: true,
      permissionGranted: false,
    }));
  }
  return { steps: frozen(steps), uncovered };
}

export function discoverCapabilityPathsV1({
  capabilities = [],
  tools = [],
  providerStates = [],
  requestedCapabilityIds = [],
} = {}) {
  const inventory = normalizeInventory({ capabilities, tools, providerStates });
  const requested = requestedIds(requestedCapabilityIds);
  const requestedSet = new Set(requested);
  const knownRequestedIds = requested.filter(capabilityId => inventory.capabilityIds.has(capabilityId));

  const candidates = inventory.normalizedTools
    .map(tool => {
      const matchingCapabilityIds = tool.capabilityIds.filter(capabilityId => requestedSet.has(capabilityId)).sort();
      if (!matchingCapabilityIds.length) return null;
      const state = providerFacts(tool.providerId, tool.toolId, inventory.statesByProviderTool);
      return frozen({
        providerId: tool.providerId,
        toolId: tool.toolId,
        matchingCapabilityIds,
        readiness: readinessFor(state),
        health: state.health,
        pathKind: state.pathKind,
        readOnly: tool.readOnly,
        latencyMs: state.latencyMs,
        reasonCode: state.reasonCode,
        requiresPolicyDecision: true,
        permissionGranted: false,
      });
    })
    .filter(Boolean)
    .sort(compareCandidate);

  const { steps, uncovered } = buildPlan(candidates, knownRequestedIds);
  const unresolved = new Set(requested.filter(capabilityId => !inventory.capabilityIds.has(capabilityId)));
  for (const capabilityId of uncovered) unresolved.add(capabilityId);

  return frozen({
    schemaVersion: 1,
    requestedCapabilityIds: [...requested],
    candidates,
    plan: steps,
    unresolvedCapabilityIds: [...unresolved].sort(),
  });
}
