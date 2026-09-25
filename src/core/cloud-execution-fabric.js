import { AgentExecutionPlane } from './agent-plan.js';
import {
  ExecutionOwnershipState,
  normalizeExecutionOwnershipV1,
} from './execution-plane-ownership.js';
import { normalizeCloudWorkspaceBindingV1 } from './cloud-workspace-contract.js';
import {
  ProviderHealthStatus,
  normalizeProviderReadinessV1,
} from './capability-discovery.js';
import {
  ResourceBudgetDecisionKind,
  evaluateResourceBudgetV1,
} from './resource-budget-governor.js';

export const CLOUD_EXECUTION_FABRIC_VERSION = 1;

export const CloudFabricAffinity = Object.freeze({
  AUTO: 'AUTO',
  LOCAL_ONLY: 'LOCAL_ONLY',
  CLOUD_PREFERRED: 'CLOUD_PREFERRED',
  CLOUD_REQUIRED: 'CLOUD_REQUIRED',
});

export const CloudFabricDisposition = Object.freeze({
  LOCAL: 'LOCAL',
  CLOUD: 'CLOUD',
  BLOCKED: 'BLOCKED',
  RECONCILE_REQUIRED: 'RECONCILE_REQUIRED',
});

export const CloudFabricCapability = Object.freeze({
  BROWSER: 'BROWSER',
  TERMINAL: 'TERMINAL',
  FILESYSTEM: 'FILESYSTEM',
});

export const CloudSlotTemperature = Object.freeze({
  WARM: 'WARM',
  COLD: 'COLD',
});

export const CloudSlotHealth = Object.freeze({
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
});

const AFFINITIES = new Set(Object.values(CloudFabricAffinity));
const CAPABILITIES = new Set(Object.values(CloudFabricCapability));
const SLOT_TEMPERATURES = new Set(Object.values(CloudSlotTemperature));
const SLOT_HEALTH = new Set(Object.values(CloudSlotHealth));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SLOTS = 128;
const MAX_CAPABILITIES = 3;
const MAX_PROVIDER_STATES = 128;
const MAX_WORKSPACE_BINDINGS = 128;
const MAX_UNITS = 100_000;
const MAX_RATE = 1_000_000_000;
const MAX_STARTUP_MS = 24 * 60 * 60 * 1000;
const MAX_COST_USD_MICROS = Number.MAX_SAFE_INTEGER;

const SLOT_KEYS = new Set([
  'schemaVersion',
  'slotId',
  'providerId',
  'workspaceId',
  'temperature',
  'health',
  'capabilities',
  'availableUnits',
  'rateLimitRemaining',
  'estimatedStartupMs',
  'estimatedCostUsdMicros',
  'checkpointResumeSupported',
  'artifactSyncSupported',
  'secureScrubSupported',
  'evidenceRetentionSupported',
  'observedAt',
  'expiresAt',
]);

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'projectId',
  'agentId',
  'affinity',
  'requiredCapabilities',
  'localCapabilities',
  'requiresCheckpointResume',
  'checkpointArtifactId',
  'checkpointSha256',
  'executionOwnership',
  'cloudSlots',
  'providerStates',
  'workspaceBindings',
  'resourceBudget',
  'resourceUsage',
  'cloudResourceRequest',
  'assessedAt',
]);

function snapshotRecord(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol field`);
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
    Object.defineProperty(out, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(out);
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
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const length = lengthDescriptor.value;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains non-index data`);
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
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must be dense`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactSha256(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactEnum(value, allowed, label) {
  if (typeof value !== 'string' || value !== value.trim() || !allowed.has(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a timestamp`);
  const canonical = new Date(ms).toISOString();
  if (value !== canonical) throw new Error(`${label} must use canonical ISO-8601 UTC representation`);
  return value;
}

function strictInteger(value, label, max) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 0
      || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function codeUnitCompare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function normalizeCapabilityList(value, label) {
  const items = dataArray(value, label, MAX_CAPABILITIES)
    .map((item, index) => exactEnum(item, CAPABILITIES, `${label}[${index}]`));
  const unique = new Set(items);
  if (unique.size !== items.length) throw new Error(`${label} contains duplicate capability`);
  return Object.freeze([...unique].sort(codeUnitCompare));
}

export function normalizeCloudExecutionSlotV1(input) {
  const raw = snapshotRecord(input, 'CloudExecutionSlotV1', SLOT_KEYS);
  if (raw.schemaVersion !== CLOUD_EXECUTION_FABRIC_VERSION) {
    throw new Error('Unsupported CloudExecutionSlotV1 schemaVersion');
  }
  const observedAt = exactTimestamp(raw.observedAt, 'CloudExecutionSlotV1.observedAt');
  const expiresAt = exactTimestamp(raw.expiresAt, 'CloudExecutionSlotV1.expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new Error('CloudExecutionSlotV1 expiresAt must follow observedAt');
  }
  return frozen({
    schemaVersion: CLOUD_EXECUTION_FABRIC_VERSION,
    slotId: exactId(raw.slotId, 'CloudExecutionSlotV1.slotId'),
    providerId: exactId(raw.providerId, 'CloudExecutionSlotV1.providerId'),
    workspaceId: exactId(raw.workspaceId, 'CloudExecutionSlotV1.workspaceId', { optional: true }),
    temperature: exactEnum(raw.temperature, SLOT_TEMPERATURES, 'CloudExecutionSlotV1.temperature'),
    health: exactEnum(raw.health, SLOT_HEALTH, 'CloudExecutionSlotV1.health'),
    capabilities: normalizeCapabilityList(raw.capabilities, 'CloudExecutionSlotV1.capabilities'),
    availableUnits: strictInteger(raw.availableUnits, 'CloudExecutionSlotV1.availableUnits', MAX_UNITS),
    rateLimitRemaining: strictInteger(raw.rateLimitRemaining, 'CloudExecutionSlotV1.rateLimitRemaining', MAX_RATE),
    estimatedStartupMs: strictInteger(raw.estimatedStartupMs, 'CloudExecutionSlotV1.estimatedStartupMs', MAX_STARTUP_MS),
    estimatedCostUsdMicros: strictInteger(
      raw.estimatedCostUsdMicros,
      'CloudExecutionSlotV1.estimatedCostUsdMicros',
      MAX_COST_USD_MICROS,
    ),
    checkpointResumeSupported: exactBoolean(
      raw.checkpointResumeSupported,
      'CloudExecutionSlotV1.checkpointResumeSupported',
    ),
    artifactSyncSupported: exactBoolean(
      raw.artifactSyncSupported,
      'CloudExecutionSlotV1.artifactSyncSupported',
    ),
    secureScrubSupported: exactBoolean(
      raw.secureScrubSupported,
      'CloudExecutionSlotV1.secureScrubSupported',
    ),
    evidenceRetentionSupported: exactBoolean(
      raw.evidenceRetentionSupported,
      'CloudExecutionSlotV1.evidenceRetentionSupported',
    ),
    observedAt,
    expiresAt,
  });
}

function normalizeProviderStates(value) {
  const inputs = dataArray(value, 'CloudFabricRequestV1.providerStates', MAX_PROVIDER_STATES);
  const states = inputs.map((item, index) => {
    try {
      return normalizeProviderReadinessV1(item);
    } catch (error) {
      throw new Error(`CloudFabricRequestV1.providerStates[${index}]: ${error.message}`);
    }
  });
  const seen = new Set();
  for (const state of states) {
    if (state.toolId !== '') {
      throw new Error('CloudFabricRequestV1 provider readiness must be provider-level');
    }
    if (seen.has(state.providerId)) {
      throw new Error(`CloudFabricRequestV1 contains duplicate provider readiness: ${state.providerId}`);
    }
    seen.add(state.providerId);
  }
  return states;
}

function normalizeWorkspaceBindings(value) {
  const inputs = dataArray(value, 'CloudFabricRequestV1.workspaceBindings', MAX_WORKSPACE_BINDINGS);
  const bindings = inputs.map((item, index) => {
    try {
      return normalizeCloudWorkspaceBindingV1(item);
    } catch (error) {
      throw new Error(`CloudFabricRequestV1.workspaceBindings[${index}]: ${error.message}`);
    }
  });
  const seen = new Set();
  for (const binding of bindings) {
    if (seen.has(binding.workspaceId)) {
      throw new Error(`CloudFabricRequestV1 contains duplicate workspace binding: ${binding.workspaceId}`);
    }
    seen.add(binding.workspaceId);
  }
  return bindings;
}

function providerExecutable(state) {
  if (!state) return false;
  if (![ProviderHealthStatus.READY, ProviderHealthStatus.DEGRADED].includes(state.health)) return false;
  if (state.installationRequired && !state.installed) return false;
  if (state.authenticationRequired && !state.authenticated) return false;
  return true;
}

function capabilitySubset(required, available) {
  const have = new Set(available);
  return required.every(capability => have.has(capability));
}

function ownershipMatchesBinding(ownership, binding) {
  return binding.taskId === ownership.taskId
    && binding.planId === ownership.planId
    && binding.nodeId === ownership.nodeId
    && binding.effectId === ownership.effectId
    && binding.policyEnvelopeId === ownership.policyEnvelopeId
    && binding.executionOwnerId === ownership.ownerId
    && binding.executionLeaseId === ownership.leaseId
    && binding.executionOwnershipRevision === ownership.revision;
}

function transitionFor(ownership, plane) {
  if (plane === AgentExecutionPlane.LOCAL) {
    if (ownership.state === ExecutionOwnershipState.AVAILABLE) return 'CLAIM_LOCAL';
    if (ownership.state === ExecutionOwnershipState.OWNED
        && ownership.ownerPlane === AgentExecutionPlane.LOCAL) return 'NONE';
    return 'HANDOFF_TO_LOCAL';
  }
  if (ownership.state === ExecutionOwnershipState.AVAILABLE) return 'CLAIM_CLOUD';
  if (ownership.state === ExecutionOwnershipState.OWNED
      && ownership.ownerPlane === AgentExecutionPlane.CLOUD) return 'NONE';
  return 'HANDOFF_TO_CLOUD';
}

function candidateOrder(providerById) {
  return (left, right) => {
    const leftProvider = providerById.get(left.providerId);
    const rightProvider = providerById.get(right.providerId);
    const leftProviderRank = leftProvider?.health === ProviderHealthStatus.READY ? 0 : 1;
    const rightProviderRank = rightProvider?.health === ProviderHealthStatus.READY ? 0 : 1;
    if (leftProviderRank !== rightProviderRank) return leftProviderRank - rightProviderRank;
    const leftWarm = left.temperature === CloudSlotTemperature.WARM ? 0 : 1;
    const rightWarm = right.temperature === CloudSlotTemperature.WARM ? 0 : 1;
    if (leftWarm !== rightWarm) return leftWarm - rightWarm;
    if (left.estimatedCostUsdMicros !== right.estimatedCostUsdMicros) {
      return left.estimatedCostUsdMicros - right.estimatedCostUsdMicros;
    }
    if (left.estimatedStartupMs !== right.estimatedStartupMs) {
      return left.estimatedStartupMs - right.estimatedStartupMs;
    }
    const providerOrder = codeUnitCompare(left.providerId, right.providerId);
    if (providerOrder !== 0) return providerOrder;
    return codeUnitCompare(left.slotId, right.slotId);
  };
}

function resultBase({
  request,
  ownership,
  budget,
  candidateAssessments,
  disposition,
  reasonCode,
  recommendedPlane = '',
  selectedSlot = null,
  existingBinding = null,
}) {
  const transition = recommendedPlane ? transitionFor(ownership, recommendedPlane) : '';
  const leavingCloud = ownership.state === ExecutionOwnershipState.OWNED
    && ownership.ownerPlane === AgentExecutionPlane.CLOUD
    && recommendedPlane === AgentExecutionPlane.LOCAL;
  const provisioningRequired = recommendedPlane === AgentExecutionPlane.CLOUD
    && (!selectedSlot?.workspaceId || !existingBinding);
  const checkpointTransferRequired = request.requiresCheckpointResume
    && (provisioningRequired || leavingCloud);
  return frozen({
    schemaVersion: CLOUD_EXECUTION_FABRIC_VERSION,
    projectId: request.projectId,
    agentId: request.agentId,
    taskId: ownership.taskId,
    planId: ownership.planId,
    nodeId: ownership.nodeId,
    effectId: ownership.effectId,
    policyEnvelopeId: ownership.policyEnvelopeId,
    affinity: request.affinity,
    disposition,
    reasonCode,
    recommendedPlane,
    selectedSlotId: selectedSlot?.slotId ?? '',
    selectedProviderId: selectedSlot?.providerId ?? '',
    selectedWorkspaceId: selectedSlot?.workspaceId ?? '',
    requiredExecutionTransition: transition,
    requiredCapabilities: request.requiredCapabilities,
    budgetDecision: budget.decision,
    candidateAssessments,
    checkpointArtifactId: request.checkpointArtifactId,
    checkpointSha256: request.checkpointSha256,
    workspaceProvisioningRequired: provisioningRequired,
    workspaceContinuityBindingRequired: recommendedPlane === AgentExecutionPlane.CLOUD,
    workspaceContinuityVerified: false,
    checkpointVerificationRequired: request.requiresCheckpointResume,
    checkpointTransferRequired,
    artifactSyncRequired: recommendedPlane === AgentExecutionPlane.CLOUD || leavingCloud,
    teardownScrubVerificationRequired: recommendedPlane === AgentExecutionPlane.CLOUD || leavingCloud,
    evidenceRetentionRequired: recommendedPlane === AgentExecutionPlane.CLOUD || leavingCloud,
    requiresCanonicalScheduler: true,
    requiresCanonicalRecovery: true,
    requiresFreshPolicy: true,
    requiresExactEffectAuthority: true,
    capacityAuthority: 'UNVERIFIED_INPUT',
    providerReadinessAuthority: 'UNVERIFIED_INPUT',
    isolationIdentityAuthority: 'UNVERIFIED_INPUT',
    advisoryOnly: true,
    dispatchAuthorized: false,
    executionAuthorized: false,
    provisioningAuthorized: false,
    resumeAuthorized: false,
    teardownAuthorized: false,
    credentialUseAuthorized: false,
    policyDecisionGranted: false,
    assessedAt: request.assessedAt,
  });
}

function blocked(args, reasonCode, disposition = CloudFabricDisposition.BLOCKED) {
  return resultBase({
    ...args,
    disposition,
    reasonCode,
  });
}

export function assessCloudExecutionFabricV1(input) {
  const raw = snapshotRecord(input, 'CloudFabricRequestV1', REQUEST_KEYS);
  if (raw.schemaVersion !== CLOUD_EXECUTION_FABRIC_VERSION) {
    throw new Error('Unsupported CloudFabricRequestV1 schemaVersion');
  }
  const request = frozen({
    schemaVersion: CLOUD_EXECUTION_FABRIC_VERSION,
    projectId: exactId(raw.projectId, 'CloudFabricRequestV1.projectId'),
    agentId: exactId(raw.agentId, 'CloudFabricRequestV1.agentId'),
    affinity: exactEnum(raw.affinity, AFFINITIES, 'CloudFabricRequestV1.affinity'),
    requiredCapabilities: normalizeCapabilityList(
      raw.requiredCapabilities,
      'CloudFabricRequestV1.requiredCapabilities',
    ),
    localCapabilities: normalizeCapabilityList(
      raw.localCapabilities,
      'CloudFabricRequestV1.localCapabilities',
    ),
    requiresCheckpointResume: exactBoolean(
      raw.requiresCheckpointResume,
      'CloudFabricRequestV1.requiresCheckpointResume',
    ),
    checkpointArtifactId: exactId(
      raw.checkpointArtifactId,
      'CloudFabricRequestV1.checkpointArtifactId',
      { optional: true },
    ),
    checkpointSha256: exactSha256(
      raw.checkpointSha256,
      'CloudFabricRequestV1.checkpointSha256',
      { optional: true },
    ),
    assessedAt: exactTimestamp(raw.assessedAt, 'CloudFabricRequestV1.assessedAt'),
  });
  if (request.requiresCheckpointResume
      && (!request.checkpointArtifactId || !request.checkpointSha256)) {
    throw new Error('CloudFabricRequestV1 checkpoint resume requires exact artifact identity');
  }
  if (!request.requiresCheckpointResume
      && Boolean(request.checkpointArtifactId) !== Boolean(request.checkpointSha256)) {
    throw new Error('CloudFabricRequestV1 checkpoint identity must be complete');
  }

  const ownership = normalizeExecutionOwnershipV1(raw.executionOwnership);
  const slots = dataArray(raw.cloudSlots, 'CloudFabricRequestV1.cloudSlots', MAX_SLOTS)
    .map((item, index) => {
      try {
        return normalizeCloudExecutionSlotV1(item);
      } catch (error) {
        throw new Error(`CloudFabricRequestV1.cloudSlots[${index}]: ${error.message}`);
      }
    });
  const slotIds = new Set();
  for (const slot of slots) {
    if (slotIds.has(slot.slotId)) {
      throw new Error(`CloudFabricRequestV1 contains duplicate slot: ${slot.slotId}`);
    }
    slotIds.add(slot.slotId);
  }
  const providerStates = normalizeProviderStates(raw.providerStates);
  const providerById = new Map(providerStates.map(state => [state.providerId, state]));
  const workspaceBindings = normalizeWorkspaceBindings(raw.workspaceBindings);
  const budget = evaluateResourceBudgetV1({
    budget: raw.resourceBudget,
    usage: raw.resourceUsage,
    request: raw.cloudResourceRequest,
  });

  const baseArgs = {
    request,
    ownership,
    budget,
    candidateAssessments: [],
  };

  if (ownership.state === ExecutionOwnershipState.RECONCILE
      || ownership.state === ExecutionOwnershipState.MANUAL_REVIEW) {
    return blocked(baseArgs, 'EXECUTION_RECONCILIATION_REQUIRED', CloudFabricDisposition.RECONCILE_REQUIRED);
  }
  if (ownership.state === ExecutionOwnershipState.HANDOFF_PENDING) {
    return blocked(baseArgs, 'EXECUTION_HANDOFF_ALREADY_PENDING');
  }
  if (ownership.state === ExecutionOwnershipState.VERIFIED) {
    return blocked(baseArgs, 'EXECUTION_ALREADY_VERIFIED');
  }
  if (ownership.state === ExecutionOwnershipState.OWNED
      && Date.parse(request.assessedAt) > Date.parse(ownership.leaseUntil)) {
    return blocked(
      baseArgs,
      'EXECUTION_LEASE_EXPIRED',
      CloudFabricDisposition.RECONCILE_REQUIRED,
    );
  }

  let existingBinding = null;
  if (ownership.state === ExecutionOwnershipState.OWNED
      && ownership.ownerPlane === AgentExecutionPlane.CLOUD) {
    existingBinding = workspaceBindings.find(binding => ownershipMatchesBinding(ownership, binding)) ?? null;
    if (!existingBinding) {
      return blocked(
        baseArgs,
        'CLOUD_WORKSPACE_BINDING_REQUIRED',
        CloudFabricDisposition.RECONCILE_REQUIRED,
      );
    }
  }

  const localEligible = capabilitySubset(request.requiredCapabilities, request.localCapabilities);
  const candidateAssessments = [];
  const eligible = [];
  for (const slot of slots) {
    let reasonCode = 'ELIGIBLE';
    const provider = providerById.get(slot.providerId);
    if (Date.parse(slot.observedAt) > Date.parse(request.assessedAt)
        || Date.parse(request.assessedAt) >= Date.parse(slot.expiresAt)) {
      reasonCode = 'STALE_SLOT_OBSERVATION';
    } else if (slot.health === CloudSlotHealth.UNAVAILABLE) {
      reasonCode = 'SLOT_UNAVAILABLE';
    } else if (!providerExecutable(provider)) {
      reasonCode = 'PROVIDER_NOT_READY';
    } else if (!capabilitySubset(request.requiredCapabilities, slot.capabilities)) {
      reasonCode = 'CAPABILITY_MISMATCH';
    } else if (slot.availableUnits < 1) {
      reasonCode = 'NO_CAPACITY';
    } else if (slot.rateLimitRemaining < 1) {
      reasonCode = 'RATE_LIMIT_EXHAUSTED';
    } else if (!slot.artifactSyncSupported) {
      reasonCode = 'ARTIFACT_SYNC_UNAVAILABLE';
    } else if (!slot.secureScrubSupported) {
      reasonCode = 'SECURE_SCRUB_UNAVAILABLE';
    } else if (!slot.evidenceRetentionSupported) {
      reasonCode = 'EVIDENCE_RETENTION_UNAVAILABLE';
    } else if (request.requiresCheckpointResume && !slot.checkpointResumeSupported) {
      reasonCode = 'CHECKPOINT_RESUME_UNAVAILABLE';
    } else if (budget.decision !== ResourceBudgetDecisionKind.ALLOW) {
      reasonCode = 'RESOURCE_BUDGET_DENIED';
    } else if (slot.estimatedCostUsdMicros > budget.request.costUsdMicros) {
      reasonCode = 'COST_ESTIMATE_EXCEEDS_REQUEST';
    } else if (existingBinding
        && (slot.workspaceId !== existingBinding.workspaceId
          || slot.providerId !== existingBinding.providerId)) {
      reasonCode = 'CURRENT_CLOUD_WORKSPACE_MISMATCH';
    }
    const eligibleSlot = reasonCode === 'ELIGIBLE';
    candidateAssessments.push(frozen({
      slotId: slot.slotId,
      providerId: slot.providerId,
      eligible: eligibleSlot,
      reasonCode,
    }));
    if (eligibleSlot) eligible.push(slot);
  }
  candidateAssessments.sort((a, b) => {
    const providerOrder = codeUnitCompare(a.providerId, b.providerId);
    if (providerOrder !== 0) return providerOrder;
    return codeUnitCompare(a.slotId, b.slotId);
  });
  const args = {
    request,
    ownership,
    budget,
    candidateAssessments: Object.freeze(candidateAssessments),
  };

  const selectedCloud = eligible.sort(candidateOrder(providerById))[0] ?? null;

  if (request.affinity === CloudFabricAffinity.LOCAL_ONLY) {
    if (!localEligible) return blocked(args, 'LOCAL_CAPABILITY_MISMATCH');
    return resultBase({
      ...args,
      disposition: CloudFabricDisposition.LOCAL,
      reasonCode: 'LOCAL_ONLY_AFFINITY',
      recommendedPlane: AgentExecutionPlane.LOCAL,
      existingBinding,
    });
  }

  if (request.affinity === CloudFabricAffinity.CLOUD_REQUIRED) {
    if (budget.decision !== ResourceBudgetDecisionKind.ALLOW) {
      return blocked(args, 'CLOUD_RESOURCE_BUDGET_DENIED');
    }
    if (!selectedCloud) return blocked(args, 'NO_ELIGIBLE_CLOUD_SLOT');
    return resultBase({
      ...args,
      disposition: CloudFabricDisposition.CLOUD,
      reasonCode: 'CLOUD_REQUIRED_AFFINITY',
      recommendedPlane: AgentExecutionPlane.CLOUD,
      selectedSlot: selectedCloud,
      existingBinding,
    });
  }

  if (request.affinity === CloudFabricAffinity.CLOUD_PREFERRED && selectedCloud) {
    return resultBase({
      ...args,
      disposition: CloudFabricDisposition.CLOUD,
      reasonCode: 'CLOUD_PREFERRED_AVAILABLE',
      recommendedPlane: AgentExecutionPlane.CLOUD,
      selectedSlot: selectedCloud,
      existingBinding,
    });
  }

  if (localEligible) {
    return resultBase({
      ...args,
      disposition: CloudFabricDisposition.LOCAL,
      reasonCode: request.affinity === CloudFabricAffinity.AUTO
        ? 'AUTO_LOCAL_CAPABLE'
        : 'CLOUD_UNAVAILABLE_LOCAL_FALLBACK',
      recommendedPlane: AgentExecutionPlane.LOCAL,
      existingBinding,
    });
  }

  if (selectedCloud) {
    return resultBase({
      ...args,
      disposition: CloudFabricDisposition.CLOUD,
      reasonCode: 'AUTO_CLOUD_REQUIRED_BY_CAPABILITY',
      recommendedPlane: AgentExecutionPlane.CLOUD,
      selectedSlot: selectedCloud,
      existingBinding,
    });
  }

  return blocked(args, budget.decision === ResourceBudgetDecisionKind.ALLOW
    ? 'NO_EXECUTION_PATH_AVAILABLE'
    : 'CLOUD_RESOURCE_BUDGET_DENIED');
}
