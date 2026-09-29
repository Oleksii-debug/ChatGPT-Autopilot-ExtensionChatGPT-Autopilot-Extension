import { CoreCommand } from '../shared/protocol.js';
import {
  normalizeAgentSelfRepairModelIntentV1,
} from './agent-self-repair-model-binding.js';
import {
  AgentSelfRepairWorkKind,
} from './agent-self-repair-bridge.js';
import {
  normalizeBoundAgentModelOrchestratorEnvelopeV1,
} from './agent-model-orchestrator-envelope.js';

export const AGENT_SELF_REPAIR_MODEL_INVOCATION_VERSION = 1;

export const AGENT_SELF_REPAIR_MODEL_INVOCATION_AUTHORITY = Object.freeze({
  advisoryOnly: true,
  dispatcherInvocationAuthorized: false,
  providerCallAuthorized: false,
  credentialAccessAuthorized: false,
  modelDispatchAuthorized: false,
  executionAuthorized: false,
  persistenceAuthorized: false,
  schedulingAuthorized: false,
  recoveryAuthorized: false,
  completionAuthorized: false,
  verificationAuthorized: false,
  requiresCanonicalCoreCommandDispatcher: true,
  requiresCurrentSelfRepairBinding: true,
  requiresCurrentRouterRevalidation: true,
  requiresExistingProviderBudgetLifecycle: true,
});

const INPUT_KEYS = new Set([
  'selfRepairModelIntent',
  'currentSelfRepairModelBindingKey',
  'currentProjectId',
  'currentDefinitionModelPolicyBindingKey',
  'currentModelPolicyBindingKey',
  'currentParentModelPolicyBindingKey',
  'currentRoutePoolRevision',
  'currentSelfRepairDispatchRouteId',
  'orchestratorEnvelope',
  'providerCallBudgetContext',
  'maxOutputTokens',
  'currentNow',
]);

const BUDGET_CONTEXT_KEYS = new Set(['kind', 'jobId', 'controlEpoch']);
const ACTIVE_WORK_KINDS = new Set([
  AgentSelfRepairWorkKind.REPAIR,
  AgentSelfRepairWorkKind.RETEST,
]);

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactBindingKey(value, label) {
  if (typeof value !== 'string'
      || value.length < 1
      || value.length > 100_000
      || value !== value.trim()) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function exactId(value, label) {
  if (typeof value !== 'string'
      || value !== value.trim()
      || !value
      || value.length > 180) {
    throw new Error(label + ' is invalid');
  }
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

function exactPositiveInteger(value, label) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 1) {
    throw new Error(label + ' must be a positive safe integer');
  }
  return value;
}

function canonicalSelfRepairPrompt(intent) {
  const criteria = intent.workAcceptanceCriteria.length
    ? '\nAcceptance criteria:\n' + intent.workAcceptanceCriteria
      .map((criterion, index) => String(index + 1) + '. ' + criterion)
      .join('\n')
    : '';
  return [
    'Self-repair work: ' + intent.workTitle,
    'Objective: ' + intent.workObjective,
    'Bound plan: ' + intent.planId,
    'Bound cycle: ' + intent.cycleId,
    'Bound failed node: ' + intent.failedNodeId,
    'Bound work node: ' + intent.nodeId,
    criteria,
  ].filter(Boolean).join('\n');
}

function canonicalSelfRepairSystemPrompt(intent) {
  return [
    'Execute only the canonical self-repair work bound to this invocation.',
    'Do not broaden the task, change owner authority, or invent additional work.',
    intent.workKind === AgentSelfRepairWorkKind.RETEST
      ? 'Act only as the independent verifier for the bound RETEST work.'
      : 'Act only as the bound repair actor for the REPAIR work.',
  ].join(' ');
}

function sameCanonicalIds(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function normalizeExistingProviderBudgetContext(value, expectedJobId) {
  const raw = strictRecord(
    value,
    BUDGET_CONTEXT_KEYS,
    'Agent self-repair provider budget context',
  );
  if (raw.kind !== 'browser-agent') {
    throw new Error('Agent self-repair invocation requires the existing BrowserAgent provider budget lifecycle');
  }
  if (typeof raw.jobId !== 'string' || raw.jobId !== expectedJobId) {
    throw new Error('Agent self-repair provider budget owner does not match current work owner');
  }
  const controlEpoch = exactPositiveInteger(
    raw.controlEpoch,
    'Agent self-repair provider budget controlEpoch',
  );
  return Object.freeze({
    kind: 'browser-agent',
    jobId: raw.jobId,
    controlEpoch,
  });
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

/**
 * Bind current REPAIR/RETEST model intent to the already-prepared canonical
 * Agent model orchestrator envelope and to the existing durable BrowserAgent
 * provider-budget lifecycle. The result is only an internal dispatcher request
 * description; CoreCommandDispatcher remains the authority that re-observes
 * current Router state and AiOrchestrator remains the provider-I/O path.
 */
export function prepareBoundAgentSelfRepairModelInvocationV1(input) {
  const raw = strictRecord(
    input,
    INPUT_KEYS,
    'Bound Agent self-repair model invocation request',
  );
  const intent = normalizeAgentSelfRepairModelIntentV1(raw.selfRepairModelIntent);
  const currentBindingKey = exactBindingKey(
    raw.currentSelfRepairModelBindingKey,
    'currentSelfRepairModelBindingKey',
  );
  if (intent.bindingKey !== currentBindingKey) {
    throw new Error('Agent self-repair model binding is not the current owner binding');
  }
  if (!ACTIVE_WORK_KINDS.has(intent.workKind)
      || intent.routeIntent === null
      || intent.ownerId === null
      || intent.workBudget === null) {
    throw new Error('Terminal Agent self-repair state cannot prepare model invocation');
  }
  if (intent.workBudget.maxModelCalls < 1) {
    throw new Error('Agent self-repair work budget does not permit a model invocation');
  }

  const envelope = normalizeBoundAgentModelOrchestratorEnvelopeV1(
    raw.orchestratorEnvelope,
  );
  const currentProjectId = exactId(raw.currentProjectId, 'currentProjectId');
  const currentDefinitionModelPolicyBindingKey = exactBindingKey(
    raw.currentDefinitionModelPolicyBindingKey,
    'currentDefinitionModelPolicyBindingKey',
  );
  const currentModelPolicyBindingKey = exactBindingKey(
    raw.currentModelPolicyBindingKey,
    'currentModelPolicyBindingKey',
  );
  const currentRoutePoolRevision = exactPositiveInteger(
    raw.currentRoutePoolRevision,
    'currentRoutePoolRevision',
  );
  const currentSelfRepairDispatchRouteId = exactId(
    raw.currentSelfRepairDispatchRouteId,
    'currentSelfRepairDispatchRouteId',
  );
  const currentParentModelPolicyBindingKey = Object.hasOwn(
    raw,
    'currentParentModelPolicyBindingKey',
  )
    ? exactBindingKey(
      raw.currentParentModelPolicyBindingKey,
      'currentParentModelPolicyBindingKey',
    )
    : null;

  if (envelope.jobId !== intent.ownerId) {
    throw new Error('Agent self-repair orchestrator envelope owner drifted from current work owner');
  }
  if (envelope.role !== intent.routeIntent.role
      || envelope.requiresVision !== intent.routeIntent.requiresVision
      || !sameCanonicalIds(envelope.capabilityIds, intent.routeIntent.capabilityIds)) {
    throw new Error('Agent self-repair orchestrator envelope drifted from durable route intent');
  }
  if (envelope.projectId !== currentProjectId) {
    throw new Error('Agent self-repair orchestrator envelope Project identity is stale');
  }
  if (envelope.definitionModelPolicyBindingKey !== currentDefinitionModelPolicyBindingKey
      || envelope.modelPolicyBindingKey !== currentModelPolicyBindingKey) {
    throw new Error('Agent self-repair orchestrator envelope model-policy provenance is stale');
  }
  if (envelope.routePoolRevision !== currentRoutePoolRevision) {
    throw new Error('Agent self-repair orchestrator envelope route-pool revision is stale');
  }
  if (envelope.routeId !== currentSelfRepairDispatchRouteId) {
    throw new Error('Agent self-repair orchestrator envelope route drifted from current dispatch');
  }
  if ((envelope.parentModelPolicyBindingKey ?? null) !== currentParentModelPolicyBindingKey) {
    throw new Error('Agent self-repair orchestrator envelope parent policy provenance is stale');
  }

  const currentNow = exactTimestamp(raw.currentNow, 'currentNow');
  if (currentNow < envelope.revalidatedAt) {
    throw new Error('Agent self-repair invocation cannot precede Router revalidation');
  }

  const providerCallBudgetContext = normalizeExistingProviderBudgetContext(
    raw.providerCallBudgetContext,
    intent.ownerId,
  );
  const prompt = canonicalSelfRepairPrompt(intent);
  const systemPrompt = canonicalSelfRepairSystemPrompt(intent);
  const maxOutputTokens = exactPositiveInteger(
    raw.maxOutputTokens,
    'Agent self-repair invocation maxOutputTokens',
  );

  return freezeDeep({
    schemaVersion: AGENT_SELF_REPAIR_MODEL_INVOCATION_VERSION,
    selfRepairModelBindingKey: intent.bindingKey,
    planId: intent.planId,
    rootJobId: intent.jobId,
    jobId: intent.ownerId,
    cycleId: intent.cycleId,
    workKind: intent.workKind,
    activeAttemptNumber: intent.activeAttemptNumber,
    nodeId: intent.nodeId,
    ownerId: intent.ownerId,
    executionPlane: intent.executionPlane,
    routeIntent: intent.routeIntent,
    envelopeRevalidatedAt: envelope.revalidatedAt,
    preparedAt: currentNow,
    command: CoreCommand.RUN_AI_ROUTED_PROMPT,
    payload: {
      prompt,
      systemPrompt,
      maxOutputTokens,
      maxModelCallsForRequest: 1,
    },
    internal: {
      agentModelOrchestratorEnvelope: envelope,
      providerCallBudgetContext,
    },
    authority: AGENT_SELF_REPAIR_MODEL_INVOCATION_AUTHORITY,
  });
}
