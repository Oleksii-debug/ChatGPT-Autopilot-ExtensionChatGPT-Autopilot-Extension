import { CoreCommand } from '../shared/protocol.js';
import {
  AgentSelfRepairWorkKind,
  normalizeAgentSelfRepairModelIntentV1,
} from './agent-self-repair-model-binding.js';
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
  'orchestratorEnvelope',
  'providerCallBudgetContext',
  'prompt',
  'systemPrompt',
  'imageDataUrl',
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

function boundedText(value, label, maxLength, { optional = false } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(label + ' is invalid');
  }
  if (!optional && !value.trim()) {
    throw new Error(label + ' must not be empty');
  }
  return value;
}

function exactImageDataUrl(value, requiresVision) {
  const imageDataUrl = value === undefined ? '' : value;
  if (typeof imageDataUrl !== 'string' || imageDataUrl !== imageDataUrl.trim()) {
    throw new Error('Agent self-repair invocation imageDataUrl must already be canonical text');
  }
  const hasImage = imageDataUrl.length > 0;
  if (hasImage !== requiresVision) {
    throw new Error('Agent self-repair image input does not match durable requiresVision intent');
  }
  return imageDataUrl;
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
  if (envelope.jobId !== intent.ownerId) {
    throw new Error('Agent self-repair orchestrator envelope owner drifted from current work owner');
  }
  if (envelope.role !== intent.routeIntent.role
      || envelope.requiresVision !== intent.routeIntent.requiresVision
      || !sameCanonicalIds(envelope.capabilityIds, intent.routeIntent.capabilityIds)) {
    throw new Error('Agent self-repair orchestrator envelope drifted from durable route intent');
  }

  const currentNow = exactTimestamp(raw.currentNow, 'currentNow');
  if (currentNow < envelope.revalidatedAt) {
    throw new Error('Agent self-repair invocation cannot precede Router revalidation');
  }

  const providerCallBudgetContext = normalizeExistingProviderBudgetContext(
    raw.providerCallBudgetContext,
    intent.ownerId,
  );
  const prompt = boundedText(raw.prompt, 'Agent self-repair invocation prompt', 100_000);
  const systemPrompt = boundedText(
    raw.systemPrompt,
    'Agent self-repair invocation systemPrompt',
    50_000,
    { optional: true },
  );
  const imageDataUrl = exactImageDataUrl(raw.imageDataUrl, envelope.requiresVision);
  const maxOutputTokens = exactPositiveInteger(
    raw.maxOutputTokens,
    'Agent self-repair invocation maxOutputTokens',
  );

  return freezeDeep({
    schemaVersion: AGENT_SELF_REPAIR_MODEL_INVOCATION_VERSION,
    selfRepairModelBindingKey: intent.bindingKey,
    planId: intent.planId,
    jobId: intent.jobId,
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
      ...(imageDataUrl ? { imageDataUrl } : {}),
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