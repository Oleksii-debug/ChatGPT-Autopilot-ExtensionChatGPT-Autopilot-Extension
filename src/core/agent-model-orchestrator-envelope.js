import {
  normalizeAiRouterRuntime,
  normalizeAiRouterSettings,
} from './ai-orchestrator.js';
import { selectAiRouteCandidates } from './ai-route-pool.js';
import {
  AGENT_MODEL_ROUTE_DISPATCH_INTENT_AUTHORITY,
} from './agent-model-route-dispatch-intent.js';

export const AGENT_MODEL_ORCHESTRATOR_ENVELOPE_VERSION = 1;

export const AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY = Object.freeze({
  advisoryOnly: true,
  orchestratorInvocationAuthorized: false,
  providerCallAuthorized: false,
  credentialAccessAuthorized: false,
  executionAuthorized: false,
  persistenceAuthorized: false,
  schedulingAuthorized: false,
  recoveryAuthorized: false,
  requiresCanonicalAiOrchestrator: true,
  requiresProviderCallLifecycleRevalidation: true,
});

const INTENT_KEYS = new Set([
  'schemaVersion','jobId','projectId','registryId','registryRevision',
  'agentDefinitionId','definitionRevision','definitionModelPolicyBindingKey',
  'modelPolicyBindingKey','parentModelPolicyBindingKey','routePoolRevision','role',
  'capabilityIds','requiresVision','preparedAt','routeId','route',
  'eligibleRouteIds','availableRouteIds','retryAt','authority',
]);
const ROUTE_KEYS = new Set(['routeId','provider','model','endpointId']);
const AUTH_KEYS = new Set(Object.keys(AGENT_MODEL_ROUTE_DISPATCH_INTENT_AUTHORITY));
const INPUT_KEYS = new Set([
  'dispatchIntent','currentDefinitionModelPolicyBindingKey','currentJobId',
  'currentProjectId','currentParentModelPolicyBindingKey','currentRoutePoolRevision','currentRouterSettings',
  'currentRouterRuntime','currentNow',
]);

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be a plain data object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(label + ' must be a plain data object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error(label + ' contains unknown field: ' + String(key));
    const d = descriptors[key];
    if (!d || d.enumerable !== true || !Object.hasOwn(d, 'value')) throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    out[key] = d.value;
  }
  return out;
}

function exactInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value,-0) || value < 1) throw new Error(label + ' is invalid');
  return value;
}

function exactString(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) throw new Error(label + ' is invalid');
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 0) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function exactCapabilityIds(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) {
    throw new Error('dispatch intent capabilityIds must be a bounded array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !expected.has(key))) {
    throw new Error('dispatch intent capabilityIds must be a dense data-only array');
  }
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    const item = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    if (!descriptor || descriptor.enumerable !== true
        || typeof item !== 'string' || item !== item.trim()
        || !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u.test(item)) {
      throw new Error('dispatch intent capabilityIds contains an invalid value');
    }
    out.push(item);
  }
  if (new Set(out).size !== out.length) throw new Error('dispatch intent capabilityIds contains duplicates');
  return Object.freeze(out);
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function normalizeIntent(value) {
  const raw = strictRecord(value, INTENT_KEYS, 'Agent model route dispatch intent');
  const route = strictRecord(raw.route, ROUTE_KEYS, 'Agent model route dispatch intent route');
  const authority = strictRecord(raw.authority, AUTH_KEYS, 'Agent model route dispatch intent authority');
  for (const [key, expected] of Object.entries(AGENT_MODEL_ROUTE_DISPATCH_INTENT_AUTHORITY)) {
    if (authority[key] !== expected) throw new Error('Agent model route dispatch intent authority is invalid');
  }
  if (raw.schemaVersion !== 1) throw new Error('Unsupported Agent model route dispatch intent schemaVersion');
  const routeId = exactString(raw.routeId, 'dispatch intent routeId');
  if (route.routeId !== routeId) throw new Error('Agent model route dispatch intent route identity mismatch');
  const capabilityIds = exactCapabilityIds(raw.capabilityIds);
  const preparedAt = exactTimestamp(raw.preparedAt, 'dispatch intent preparedAt');
  const parentModelPolicyBindingKey = raw.parentModelPolicyBindingKey === undefined
    ? null
    : exactString(raw.parentModelPolicyBindingKey, 'dispatch intent parentModelPolicyBindingKey');
  return {
    ...raw,
    ...(parentModelPolicyBindingKey ? { parentModelPolicyBindingKey } : {}),
    capabilityIds,
    preparedAt,
    routeId,
    route: {
      routeId,
      provider: exactString(route.provider, 'dispatch intent provider'),
      model: exactString(route.model, 'dispatch intent model'),
      endpointId: typeof route.endpointId === 'string' ? route.endpointId : '',
    },
  };
}

export function createBoundAgentModelOrchestratorEnvelopeV1(input) {
  const raw = strictRecord(input, INPUT_KEYS, 'Bound Agent model orchestrator envelope request');
  const intent = normalizeIntent(raw.dispatchIntent);
  const currentBindingKey = exactString(raw.currentDefinitionModelPolicyBindingKey, 'currentDefinitionModelPolicyBindingKey');
  const currentJobId = exactString(raw.currentJobId, 'currentJobId');
  const currentProjectId = exactString(raw.currentProjectId, 'currentProjectId');
  const currentRoutePoolRevision = exactInteger(raw.currentRoutePoolRevision, 'currentRoutePoolRevision');
  const currentNow = exactTimestamp(raw.currentNow, 'currentNow');
  if (currentNow < intent.preparedAt) {
    throw new Error('currentNow cannot precede dispatch intent preparedAt');
  }

  if (intent.definitionModelPolicyBindingKey !== currentBindingKey) throw new Error('Dispatch intent owner binding is stale');
  if (intent.jobId !== currentJobId) throw new Error('Dispatch intent job identity is stale');
  if (intent.projectId !== currentProjectId) throw new Error('Dispatch intent Project identity is stale');
  if (intent.routePoolRevision !== currentRoutePoolRevision) throw new Error('Dispatch intent route-pool revision is stale');

  if (intent.parentModelPolicyBindingKey) {
    const currentParentBindingKey = exactString(
      raw.currentParentModelPolicyBindingKey,
      'currentParentModelPolicyBindingKey',
    );
    if (intent.parentModelPolicyBindingKey !== currentParentBindingKey) {
      throw new Error('Dispatch intent parent model-policy binding is stale');
    }
  } else if (Object.hasOwn(raw, 'currentParentModelPolicyBindingKey')) {
    throw new Error('Root dispatch intent must not supply current parent model-policy provenance');
  }

  const settings = normalizeAiRouterSettings(raw.currentRouterSettings);
  if (settings.enabled !== true) throw new Error('Canonical AI Router is disabled');
  const runtime = normalizeAiRouterRuntime(raw.currentRouterRuntime);
  const route = settings.routes.find(item => item.routeId === intent.routeId);
  if (!route) throw new Error('Dispatch intent route is missing from current canonical Router settings');
  if (route.provider !== intent.route.provider
      || route.model !== intent.route.model
      || route.endpointId !== intent.route.endpointId) {
    throw new Error('Dispatch intent provider identity drifted from current canonical Router settings');
  }

  const currentSelection = selectAiRouteCandidates({
    routes: settings.routes,
    policy: settings.routePolicy,
    routeStates: runtime.routeStates,
    role: intent.role,
    capabilityIds: intent.capabilityIds,
    requiresVision: intent.requiresVision,
    now: currentNow,
  });
  if (!currentSelection.candidates.some(candidate => candidate.routeId === route.routeId)) {
    throw new Error('Dispatch intent route is not currently authorized by canonical Router policy/state');
  }

  const routeWorkerCount = settings.workerPolicy.manualRouteWorkers?.[route.routeId];
  const scopedWorkerPolicy = {
    ...settings.workerPolicy,
    manualRouteWorkers: routeWorkerCount === undefined
      ? {}
      : { [route.routeId]: routeWorkerCount },
  };
  const scopedSettings = normalizeAiRouterSettings({
    ...settings,
    routes: [route],
    workerPolicy: scopedWorkerPolicy,
    routePolicy: {
      ...settings.routePolicy,
      autoSwitch: false,
      pinnedRouteId: route.routeId,
      orderedRouteIds: [route.routeId],
      allowRouteIds: [route.routeId],
      denyRouteIds: [],
    },
  });

  const routeState = runtime.routeStates?.[route.routeId];
  const scopedRuntime = {
    ...runtime,
    routeStates: routeState ? { [route.routeId]: routeState } : {},
    lastRouteId: runtime.lastRouteId === route.routeId ? route.routeId : '',
    lastFailoverChain: (runtime.lastFailoverChain || []).filter(item => item.routeId === route.routeId),
  };

  return freezeDeep({
    schemaVersion: AGENT_MODEL_ORCHESTRATOR_ENVELOPE_VERSION,
    jobId: intent.jobId,
    projectId: intent.projectId,
    definitionModelPolicyBindingKey: intent.definitionModelPolicyBindingKey,
    modelPolicyBindingKey: intent.modelPolicyBindingKey,
    ...(intent.parentModelPolicyBindingKey ? {
      parentModelPolicyBindingKey: intent.parentModelPolicyBindingKey,
    } : {}),
    routePoolRevision: intent.routePoolRevision,
    role: intent.role,
    capabilityIds: [...intent.capabilityIds],
    requiresVision: intent.requiresVision,
    preparedAt: intent.preparedAt,
    revalidatedAt: currentNow,
    routeId: route.routeId,
    settings: scopedSettings,
    runtime: scopedRuntime,
    authority: AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
  });
}


const FINAL_ENVELOPE_KEYS = new Set([
  'schemaVersion','jobId','projectId','definitionModelPolicyBindingKey',
  'modelPolicyBindingKey','parentModelPolicyBindingKey','routePoolRevision',
  'role','capabilityIds','requiresVision','preparedAt','revalidatedAt',
  'routeId','settings','runtime','authority',
]);
const FINAL_AUTHORITY_KEYS = new Set(
  Object.keys(AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY),
);

/**
 * Re-validate a previously prepared envelope at an internal invocation
 * boundary. This validates structure and least-authority invariants only; it
 * does not grant permission to invoke the orchestrator.
 */
export function normalizeBoundAgentModelOrchestratorEnvelopeV1(value) {
  const raw = strictRecord(
    value,
    FINAL_ENVELOPE_KEYS,
    'Bound Agent model orchestrator envelope',
  );
  if (raw.schemaVersion !== AGENT_MODEL_ORCHESTRATOR_ENVELOPE_VERSION) {
    throw new Error('Unsupported bound Agent model orchestrator envelope schemaVersion');
  }
  const authority = strictRecord(
    raw.authority,
    FINAL_AUTHORITY_KEYS,
    'Bound Agent model orchestrator envelope authority',
  );
  for (const [key, expected] of Object.entries(AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY)) {
    if (authority[key] !== expected) {
      throw new Error('Bound Agent model orchestrator envelope authority is invalid');
    }
  }

  const jobId = exactString(raw.jobId, 'orchestrator envelope jobId');
  const projectId = exactString(raw.projectId, 'orchestrator envelope projectId');
  const definitionModelPolicyBindingKey = exactString(
    raw.definitionModelPolicyBindingKey,
    'orchestrator envelope definitionModelPolicyBindingKey',
  );
  const modelPolicyBindingKey = exactString(
    raw.modelPolicyBindingKey,
    'orchestrator envelope modelPolicyBindingKey',
  );
  const parentModelPolicyBindingKey = raw.parentModelPolicyBindingKey === undefined
    ? null
    : exactString(
      raw.parentModelPolicyBindingKey,
      'orchestrator envelope parentModelPolicyBindingKey',
    );
  const routePoolRevision = exactInteger(
    raw.routePoolRevision,
    'orchestrator envelope routePoolRevision',
  );
  const role = exactString(raw.role, 'orchestrator envelope role');
  const capabilityIds = exactCapabilityIds(raw.capabilityIds);
  if (typeof raw.requiresVision !== 'boolean') {
    throw new Error('orchestrator envelope requiresVision is invalid');
  }
  const preparedAt = exactTimestamp(raw.preparedAt, 'orchestrator envelope preparedAt');
  const revalidatedAt = exactTimestamp(
    raw.revalidatedAt,
    'orchestrator envelope revalidatedAt',
  );
  if (revalidatedAt < preparedAt) {
    throw new Error('orchestrator envelope revalidatedAt precedes preparedAt');
  }
  const routeId = exactString(raw.routeId, 'orchestrator envelope routeId');
  const settings = normalizeAiRouterSettings(raw.settings);
  const runtime = normalizeAiRouterRuntime(raw.runtime);
  if (settings.enabled !== true || settings.routes.length !== 1) {
    throw new Error('orchestrator envelope must contain exactly one enabled Router route');
  }
  const route = settings.routes[0];
  if (route.routeId !== routeId
      || settings.routePolicy.pinnedRouteId !== routeId
      || settings.routePolicy.autoSwitch !== false
      || settings.routePolicy.allowRouteIds.length !== 1
      || settings.routePolicy.allowRouteIds[0] !== routeId
      || settings.routePolicy.denyRouteIds.includes(routeId)) {
    throw new Error('orchestrator envelope route scope is invalid');
  }
  for (const runtimeRouteId of Object.keys(runtime.routeStates || {})) {
    if (runtimeRouteId !== routeId) {
      throw new Error('orchestrator envelope runtime leaks another route');
    }
  }

  return freezeDeep({
    schemaVersion: AGENT_MODEL_ORCHESTRATOR_ENVELOPE_VERSION,
    jobId,
    projectId,
    definitionModelPolicyBindingKey,
    modelPolicyBindingKey,
    ...(parentModelPolicyBindingKey ? { parentModelPolicyBindingKey } : {}),
    routePoolRevision,
    role,
    capabilityIds: [...capabilityIds],
    requiresVision: raw.requiresVision,
    preparedAt,
    revalidatedAt,
    routeId,
    settings,
    runtime,
    authority: AGENT_MODEL_ORCHESTRATOR_ENVELOPE_AUTHORITY,
  });
}
