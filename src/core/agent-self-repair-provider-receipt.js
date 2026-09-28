import {
  prepareBoundAgentSelfRepairModelInvocationV1,
} from './agent-self-repair-model-invocation.js';

export const AGENT_SELF_REPAIR_PROVIDER_RECEIPT_VERSION = 1;

export const AGENT_SELF_REPAIR_PROVIDER_RECEIPT_AUTHORITY = Object.freeze({
  advisoryOnly: true,
  providerCallAuthorized: false,
  modelDispatchAuthorized: false,
  persistenceAuthorized: false,
  completionAuthorized: false,
  verificationAuthorized: false,
  requiresExistingProviderBudgetLifecycle: true,
  requiresTrustedReservationInput: true,
});

const INPUT_KEYS = new Set([
  'invocationRequest',
  'trustedReservation',
]);

const RESERVATION_KEYS = new Set([
  'reservationId',
  'controlEpoch',
  'modelCalls',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'estimatedCostUsd',
  'createdAt',
  'routeId',
  'provider',
  'model',
  'callNumber',
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

function exactText(value, label, maxLength) {
  if (typeof value !== 'string'
      || value.length < 1
      || value.length > maxLength
      || value !== value.trim()) {
    throw new Error(label + ' must already be canonical text');
  }
  return value;
}

function exactSafeInteger(value, label, { min = 0 } = {}) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min) {
    throw new Error(label + ' must be a canonical safe integer');
  }
  return value;
}

function exactNonNegativeFinite(value, label) {
  if (typeof value !== 'number'
      || !Number.isFinite(value)
      || Object.is(value, -0)
      || value < 0) {
    throw new Error(label + ' must be a canonical non-negative finite number');
  }
  return value;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

/**
 * Bind one trusted durable BrowserAgent provider-budget reservation to the
 * already-prepared self-repair model invocation.
 *
 * This does not establish trust in arbitrary caller data. The caller must pass
 * the exact reservation returned by the existing BrowserAgent
 * reserveProviderModelBudget lifecycle. The result grants no execution,
 * persistence, completion or verification authority.
 */
export function projectAgentSelfRepairProviderReceiptV1(input) {
  const raw = strictRecord(
    input,
    INPUT_KEYS,
    'Agent self-repair provider receipt request',
  );
  const prepared = prepareBoundAgentSelfRepairModelInvocationV1(
    raw.invocationRequest,
  );
  const reservation = strictRecord(
    raw.trustedReservation,
    RESERVATION_KEYS,
    'Trusted provider budget reservation',
  );

  const reservationId = exactText(
    reservation.reservationId,
    'trusted reservationId',
    240,
  );
  const controlEpoch = exactSafeInteger(
    reservation.controlEpoch,
    'trusted reservation controlEpoch',
    { min: 1 },
  );
  const modelCalls = exactSafeInteger(
    reservation.modelCalls,
    'trusted reservation modelCalls',
    { min: 1 },
  );
  const inputTokens = exactSafeInteger(
    reservation.inputTokens,
    'trusted reservation inputTokens',
  );
  const outputTokens = exactSafeInteger(
    reservation.outputTokens,
    'trusted reservation outputTokens',
    { min: 1 },
  );
  const totalTokens = exactSafeInteger(
    reservation.totalTokens,
    'trusted reservation totalTokens',
    { min: 1 },
  );
  const estimatedCostUsd = exactNonNegativeFinite(
    reservation.estimatedCostUsd,
    'trusted reservation estimatedCostUsd',
  );
  const createdAt = exactSafeInteger(
    reservation.createdAt,
    'trusted reservation createdAt',
  );
  const routeId = exactText(reservation.routeId, 'trusted reservation routeId', 180);
  const provider = exactText(reservation.provider, 'trusted reservation provider', 80);
  const model = exactText(reservation.model, 'trusted reservation model', 300);
  const callNumber = exactSafeInteger(
    reservation.callNumber,
    'trusted reservation callNumber',
    { min: 1 },
  );

  if (controlEpoch !== prepared.internal.providerCallBudgetContext.controlEpoch) {
    throw new Error('Trusted provider reservation controlEpoch drifted from current owner authority');
  }
  if (modelCalls !== 1 || callNumber !== 1) {
    throw new Error('Agent self-repair provider receipt requires exactly one admitted model call');
  }
  if (outputTokens !== prepared.payload.maxOutputTokens) {
    throw new Error('Trusted provider reservation output-token bound drifted from invocation');
  }
  if (totalTokens !== inputTokens + outputTokens) {
    throw new Error('Trusted provider reservation token counters are inconsistent');
  }
  if (createdAt < prepared.preparedAt) {
    throw new Error('Trusted provider reservation predates invocation preparation');
  }

  const route = prepared.internal.agentModelOrchestratorEnvelope.settings.routes[0];
  if (routeId !== prepared.internal.agentModelOrchestratorEnvelope.routeId
      || provider !== route.provider
      || model !== route.model) {
    throw new Error('Trusted provider reservation route identity drifted from admitted envelope');
  }

  const expectedReservationPrefix = prepared.jobId + ':model-budget:';
  if (!reservationId.startsWith(expectedReservationPrefix)
      || reservationId.length === expectedReservationPrefix.length) {
    throw new Error('Trusted provider reservation is not owned by current self-repair work');
  }

  return freezeDeep({
    schemaVersion: AGENT_SELF_REPAIR_PROVIDER_RECEIPT_VERSION,
    invocationId: reservationId,
    planId: prepared.planId,
    rootJobId: prepared.rootJobId,
    jobId: prepared.jobId,
    cycleId: prepared.cycleId,
    workKind: prepared.workKind,
    activeAttemptNumber: prepared.activeAttemptNumber,
    nodeId: prepared.nodeId,
    ownerId: prepared.ownerId,
    controlEpoch,
    route: {
      routeId,
      provider,
      model,
    },
    reservation: {
      modelCalls,
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCostUsd,
      createdAt,
      callNumber,
    },
    authority: AGENT_SELF_REPAIR_PROVIDER_RECEIPT_AUTHORITY,
  });
}
