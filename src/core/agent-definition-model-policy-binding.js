import {
  createAgentModelPolicyBindingV1,
  normalizeAgentModelPolicyBindingV1,
} from './agent-model-policy-binding.js';
import {
  normalizeAgentDefinitionSelectionV1,
  normalizeAgentModelRoutePolicyV1,
} from './agent-definition-registry.js';

export const AGENT_DEFINITION_MODEL_POLICY_BINDING_VERSION = 1;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

const INPUT_KEYS = new Set([
  'materializedAgent',
  'currentDefinitionSelection',
  'currentJobId',
  'currentProjectId',
  'routePool',
  'routePoolRevision',
  'ownerAllowedRouteIds',
  'parentBinding',
]);

const MATERIALIZED_KEYS = new Set([
  'schemaVersion',
  'definitionBinding',
  'config',
  'routerOverride',
  'scope',
  'authority',
  // Forward-compatible with the already-active Specialist delegation lineage.
  // This adapter does not read or grant any authority from that binding.
  'specialistDelegationBinding',
]);

const DEFINITION_BINDING_KEYS = new Set([
  'registryId',
  'registryRevision',
  'agentDefinitionId',
  'definitionRevision',
]);

const ROUTER_OVERRIDE_KEYS = new Set(['routePolicy']);

const MATERIALIZED_AUTHORITY_KEYS = new Set([
  'executionAuthorized',
  'policyAuthorized',
  'schedulingAuthorized',
  'recoveryAuthorized',
  'credentialAuthorized',
  'completionAuthorized',
  'verificationAuthorized',
]);

const DURABLE_KEYS = new Set([
  'schemaVersion',
  'bindingKey',
  'definitionBinding',
  'jobId',
  'projectId',
  'modelPolicyBinding',
  'executionAuthority',
  'providerAuthority',
  'credentialAuthority',
  'policyAuthority',
  'persistenceAuthority',
  'schedulingAuthority',
  'recoveryAuthority',
  'currentRouterRevalidationRequired',
  'currentDefinitionRevalidationRequired',
]);

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
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function dataRecord(value, label) {
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
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an enumerable own data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function own(record, key) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveRevision(value, label) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 1) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactFalse(value, label) {
  if (value !== false) throw new Error(`${label} must be false`);
  return false;
}

function exactTrue(value, label) {
  if (value !== true) throw new Error(`${label} must be true`);
  return true;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeDefinitionBinding(input) {
  const raw = strictRecord(
    input,
    DEFINITION_BINDING_KEYS,
    'AgentDefinitionModelPolicyBindingV1.definitionBinding',
  );
  return deepFreeze({
    registryId: requiredId(own(raw, 'registryId'), 'definitionBinding.registryId'),
    registryRevision: positiveRevision(
      own(raw, 'registryRevision'),
      'definitionBinding.registryRevision',
    ),
    agentDefinitionId: requiredId(
      own(raw, 'agentDefinitionId'),
      'definitionBinding.agentDefinitionId',
    ),
    definitionRevision: positiveRevision(
      own(raw, 'definitionRevision'),
      'definitionBinding.definitionRevision',
    ),
  });
}

function requireMaterializedZeroAuthority(input) {
  const raw = strictRecord(
    input,
    MATERIALIZED_AUTHORITY_KEYS,
    'Materialized Agent authority',
  );
  for (const key of MATERIALIZED_AUTHORITY_KEYS) {
    exactFalse(own(raw, key), `Materialized Agent authority.${key}`);
  }
}

function sameDefinitionBinding(left, right) {
  return left.registryId === right.registryId
    && left.registryRevision === right.registryRevision
    && left.agentDefinitionId === right.agentDefinitionId
    && left.definitionRevision === right.definitionRevision;
}

function canonicalPolicySignature(policy) {
  return JSON.stringify(policy === null ? null : policy);
}

function assertCurrentDefinitionProvenance(
  definitionBinding,
  routerOverride,
  currentSelection,
) {
  const expectedBinding = {
    registryId: currentSelection.registryId,
    registryRevision: currentSelection.registryRevision,
    agentDefinitionId: currentSelection.agentDefinitionId,
    definitionRevision: currentSelection.definitionRevision,
  };
  if (!sameDefinitionBinding(definitionBinding, expectedBinding)) {
    throw new Error('Materialized Agent definition binding drifted from current Agent definition selection');
  }

  const expectedPolicy = currentSelection.definition.modelRoutePolicy;
  const hasOverride = Object.hasOwn(routerOverride, 'routePolicy');
  if (expectedPolicy === null) {
    if (hasOverride) {
      throw new Error('Materialized Agent routerOverride drifted from current Agent definition modelRoutePolicy');
    }
    return;
  }
  if (!hasOverride) {
    throw new Error('Materialized Agent routerOverride is missing current Agent definition modelRoutePolicy');
  }
  const actualPolicy = normalizeAgentModelRoutePolicyV1(routerOverride.routePolicy);
  if (canonicalPolicySignature(actualPolicy) !== canonicalPolicySignature(expectedPolicy)) {
    throw new Error('Materialized Agent routerOverride drifted from current Agent definition modelRoutePolicy');
  }
}

function durableBindingKey(definitionBinding, modelPolicyBinding) {
  return JSON.stringify([
    AGENT_DEFINITION_MODEL_POLICY_BINDING_VERSION,
    definitionBinding.registryId,
    definitionBinding.registryRevision,
    definitionBinding.agentDefinitionId,
    definitionBinding.definitionRevision,
    modelPolicyBinding.bindingKey,
  ]);
}

/**
 * Normalize the durable bridge between a reusable Agent definition and the
 * canonical per-Agent model policy binding.
 *
 * This envelope is configuration evidence only. Runtime callers must still
 * revalidate both the current Agent definition selection and the current
 * route-pool revision/route eligibility immediately before provider I/O.
 */
export function normalizeAgentDefinitionModelPolicyBindingV1(input) {
  const raw = strictRecord(
    input,
    DURABLE_KEYS,
    'AgentDefinitionModelPolicyBindingV1',
  );
  if (own(raw, 'schemaVersion') !== AGENT_DEFINITION_MODEL_POLICY_BINDING_VERSION) {
    throw new Error('Unsupported AgentDefinitionModelPolicyBindingV1 schemaVersion');
  }

  const definitionBinding = normalizeDefinitionBinding(own(raw, 'definitionBinding'));
  const jobId = requiredId(own(raw, 'jobId'), 'jobId');
  const projectId = requiredId(own(raw, 'projectId'), 'projectId');
  const modelPolicyBinding = normalizeAgentModelPolicyBindingV1(
    own(raw, 'modelPolicyBinding'),
  );

  if (modelPolicyBinding.agentId !== jobId) {
    throw new Error('Materialized Agent jobId does not match model policy Agent identity');
  }
  if (modelPolicyBinding.projectId !== projectId) {
    throw new Error('Materialized Agent projectId does not match model policy project identity');
  }
  if (modelPolicyBinding.policyRevision !== definitionBinding.definitionRevision) {
    throw new Error('Agent definition revision does not match model policy revision');
  }

  const expectedKey = durableBindingKey(definitionBinding, modelPolicyBinding);
  if (own(raw, 'bindingKey') !== expectedKey) {
    throw new Error('Agent definition model policy bindingKey is inconsistent');
  }

  return deepFreeze({
    schemaVersion: AGENT_DEFINITION_MODEL_POLICY_BINDING_VERSION,
    bindingKey: expectedKey,
    definitionBinding,
    jobId,
    projectId,
    modelPolicyBinding,
    executionAuthority: exactFalse(own(raw, 'executionAuthority'), 'executionAuthority'),
    providerAuthority: exactFalse(own(raw, 'providerAuthority'), 'providerAuthority'),
    credentialAuthority: exactFalse(own(raw, 'credentialAuthority'), 'credentialAuthority'),
    policyAuthority: exactFalse(own(raw, 'policyAuthority'), 'policyAuthority'),
    persistenceAuthority: exactFalse(own(raw, 'persistenceAuthority'), 'persistenceAuthority'),
    schedulingAuthority: exactFalse(own(raw, 'schedulingAuthority'), 'schedulingAuthority'),
    recoveryAuthority: exactFalse(own(raw, 'recoveryAuthority'), 'recoveryAuthority'),
    currentRouterRevalidationRequired: exactTrue(
      own(raw, 'currentRouterRevalidationRequired'),
      'currentRouterRevalidationRequired',
    ),
    currentDefinitionRevalidationRequired: exactTrue(
      own(raw, 'currentDefinitionRevalidationRequired'),
      'currentDefinitionRevalidationRequired',
    ),
  });
}

/**
 * Bind a materialized durable Agent definition to AgentModelPolicyBindingV1.
 *
 * Identity and policy provenance are current-owner-bound:
 * - materialized config.id/projectId must match the owner's current job/project;
 * - definition identity/revision must match the current AgentDefinitionSelection;
 * - routePolicy must semantically equal that exact current definition policy;
 * - policyRevision is the exact current durable definitionRevision.
 *
 * Owner route authority and the current route pool remain explicit trusted
 * runtime inputs. A parent binding, when present, is revalidated by the
 * canonical AgentModelPolicyBindingV1 contract.
 */
export function createAgentDefinitionModelPolicyBindingV1(input) {
  const raw = strictRecord(
    input,
    INPUT_KEYS,
    'AgentDefinitionModelPolicyBindingRequestV1',
  );
  const materialized = strictRecord(
    own(raw, 'materializedAgent'),
    MATERIALIZED_KEYS,
    'Materialized Agent definition',
  );
  if (own(materialized, 'schemaVersion') !== 1) {
    throw new Error('Materialized Agent definition schemaVersion must be numeric 1');
  }

  const definitionBinding = normalizeDefinitionBinding(
    own(materialized, 'definitionBinding'),
  );
  const currentDefinitionSelection = normalizeAgentDefinitionSelectionV1(
    own(raw, 'currentDefinitionSelection'),
  );
  const config = dataRecord(own(materialized, 'config'), 'Materialized Agent config');
  const jobId = requiredId(own(config, 'id'), 'Materialized Agent config.id');
  const projectId = requiredId(
    own(config, 'projectId'),
    'Materialized Agent config.projectId',
  );
  const currentJobId = requiredId(own(raw, 'currentJobId'), 'currentJobId');
  const currentProjectId = requiredId(own(raw, 'currentProjectId'), 'currentProjectId');
  if (jobId !== currentJobId) {
    throw new Error('Materialized Agent config.id drifted from current job identity');
  }
  if (projectId !== currentProjectId) {
    throw new Error('Materialized Agent config.projectId drifted from current Project identity');
  }

  requireMaterializedZeroAuthority(own(materialized, 'authority'));
  // Scope is not model authority, but require it to cross the same data-only
  // materialization boundary without evaluating accessors.
  dataRecord(own(materialized, 'scope'), 'Materialized Agent scope');

  const routerOverride = strictRecord(
    own(materialized, 'routerOverride'),
    ROUTER_OVERRIDE_KEYS,
    'Materialized Agent routerOverride',
  );
  assertCurrentDefinitionProvenance(
    definitionBinding,
    routerOverride,
    currentDefinitionSelection,
  );

  const modelRequest = {
    projectId,
    agentId: jobId,
    policyRevision: definitionBinding.definitionRevision,
    routePoolRevision: own(raw, 'routePoolRevision'),
    routePool: own(raw, 'routePool'),
    ownerAllowedRouteIds: own(raw, 'ownerAllowedRouteIds'),
  };
  if (Object.hasOwn(routerOverride, 'routePolicy')) {
    modelRequest.routePolicy = own(routerOverride, 'routePolicy');
  }
  if (Object.hasOwn(raw, 'parentBinding') && own(raw, 'parentBinding') != null) {
    modelRequest.parentBinding = own(raw, 'parentBinding');
  }

  const modelPolicyBinding = createAgentModelPolicyBindingV1(modelRequest);
  const bindingKey = durableBindingKey(definitionBinding, modelPolicyBinding);

  return normalizeAgentDefinitionModelPolicyBindingV1({
    schemaVersion: AGENT_DEFINITION_MODEL_POLICY_BINDING_VERSION,
    bindingKey,
    definitionBinding,
    jobId,
    projectId,
    modelPolicyBinding,
    executionAuthority: false,
    providerAuthority: false,
    credentialAuthority: false,
    policyAuthority: false,
    persistenceAuthority: false,
    schedulingAuthority: false,
    recoveryAuthority: false,
    currentRouterRevalidationRequired: true,
    currentDefinitionRevalidationRequired: true,
  });
}
