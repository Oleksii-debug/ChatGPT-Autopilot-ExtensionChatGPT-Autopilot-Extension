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

const HEALTH = new Set(Object.values(ProviderHealthStatus));
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
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a bounded array`);
  return value;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

const PROVIDER_STATE_KEYS = new Set([
  'schemaVersion',
  'providerId',
  'health',
  'installationRequired',
  'installed',
  'authenticationRequired',
  'authenticated',
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
    health,
    installationRequired: bool(raw.installationRequired, 'installationRequired'),
    installed: bool(raw.installed, 'installed'),
    authenticationRequired: bool(raw.authenticationRequired, 'authenticationRequired'),
    authenticated: bool(raw.authenticated, 'authenticated'),
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
  const statesByProviderId = new Map();
  for (const state of normalizedStates) {
    if (statesByProviderId.has(state.providerId)) throw new Error('providerStates contain duplicate providerId');
    statesByProviderId.set(state.providerId, state);
  }

  return { normalizedCapabilities, normalizedTools, statesByProviderId, capabilityIds };
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

function latencyRank(value) {
  return value > 0 ? value : Number.MAX_SAFE_INTEGER;
}

function compareCandidate(a, b) {
  return readinessRank(a.readiness) - readinessRank(b.readiness)
    || b.matchingCapabilityIds.length - a.matchingCapabilityIds.length
    || latencyRank(a.latencyMs) - latencyRank(b.latencyMs)
    || a.providerId.localeCompare(b.providerId)
    || a.toolId.localeCompare(b.toolId);
}

function providerFacts(providerId, statesByProviderId) {
  const state = statesByProviderId.get(providerId);
  if (state) return state;
  return Object.freeze({
    schemaVersion: 1,
    providerId,
    health: ProviderHealthStatus.UNKNOWN,
    installationRequired: false,
    installed: false,
    authenticationRequired: false,
    authenticated: false,
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
      .sort((a, b) => b.uncoveredIds.length - a.uncoveredIds.length || compareCandidate(a.candidate, b.candidate));
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
      const state = providerFacts(tool.providerId, inventory.statesByProviderId);
      return frozen({
        providerId: tool.providerId,
        toolId: tool.toolId,
        matchingCapabilityIds,
        readiness: readinessFor(state),
        health: state.health,
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
