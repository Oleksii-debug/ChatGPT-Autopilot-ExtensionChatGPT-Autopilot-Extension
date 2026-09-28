import {
  ObservationStatus,
  normalizeObservationV1,
} from './universal-agent-contracts.js';
import {
  prepareBoundAgentSelfRepairModelInvocationV1,
} from './agent-self-repair-model-invocation.js';

const REQUEST_KEYS = new Set([
  'invocationRequest',
  'providerReservation',
  'observationId',
  'modelResult',
  'observedAt',
]);

const PROVIDER_RESERVATION_KEYS = new Set([
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

const MODEL_RESULT_KEYS = new Set([
  'ok',
  'text',
  'usage',
  'route',
  'trigger',
  'primary',
  'strong',
  'primaryError',
  'strongError',
  'routing',
  'runtime',
]);

const ROUTING_KEYS = new Set([
  'selectedRouteId',
  'reason',
  'failoverChain',
]);

const LEG_KEYS = new Set([
  'provider',
  'model',
  'routeId',
  'text',
  'usage',
]);

const USAGE_KEYS = new Set([
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'modelCalls',
]);

const MAX_MODEL_OUTPUT_TEXT = 100_000;
const MAX_OBSERVATION_SUMMARY = 8_000;

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

function exactText(value, label, { allowEmpty = false, maxLength = 16_000 } = {}) {
  if (typeof value !== 'string'
      || value.length > maxLength
      || value !== value.trim()) {
    throw new Error(label + ' must already be canonical text');
  }
  if (!allowEmpty && value.length < 1) {
    throw new Error(label + ' must not be empty');
  }
  return value;
}

function modelOutputText(value) {
  if (typeof value !== 'string' || value.length > MAX_MODEL_OUTPUT_TEXT) {
    throw new Error('Agent self-repair model output text is invalid or too large');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Agent self-repair model output text must not be empty');
  }
  return trimmed;
}

function safeCounter(value, label) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < 0) {
    throw new Error(label + ' must be a non-negative safe integer');
  }
  return value;
}

function positiveCounter(value, label) {
  const normalized = safeCounter(value, label);
  if (normalized < 1) throw new Error(label + ' must be positive');
  return normalized;
}

function exactCanonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new Error(label + ' must be an exact canonical timestamp');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)
      || new Date(milliseconds).toISOString() !== value) {
    throw new Error(label + ' must be an exact canonical timestamp');
  }
  return { value, milliseconds };
}

function normalizeProviderReservation(value, prepared) {
  const raw = strictRecord(
    value,
    PROVIDER_RESERVATION_KEYS,
    'Agent self-repair provider reservation',
  );
  const reservationId = exactText(
    raw.reservationId,
    'provider reservationId',
    { maxLength: 180 },
  );
  const expectedPrefix = prepared.jobId + ':model-budget:';
  if (!reservationId.startsWith(expectedPrefix)) {
    throw new Error('Provider reservation identity does not belong to the current self-repair owner');
  }
  const sequenceText = reservationId.slice(expectedPrefix.length);
  if (!/^[1-9]\d*$/u.test(sequenceText)
      || !Number.isSafeInteger(Number(sequenceText))) {
    throw new Error('Provider reservation identity sequence is invalid');
  }

  const controlEpoch = positiveCounter(raw.controlEpoch, 'provider reservation controlEpoch');
  if (controlEpoch !== prepared.internal.providerCallBudgetContext.controlEpoch) {
    throw new Error('Provider reservation controlEpoch drifted from the admitted budget owner');
  }
  const modelCalls = positiveCounter(raw.modelCalls, 'provider reservation modelCalls');
  if (modelCalls !== 1) {
    throw new Error('Provider reservation must authorize exactly one model call');
  }
  const inputTokens = safeCounter(raw.inputTokens, 'provider reservation inputTokens');
  const outputTokens = safeCounter(raw.outputTokens, 'provider reservation outputTokens');
  if (outputTokens !== prepared.payload.maxOutputTokens) {
    throw new Error('Provider reservation output-token bound drifted from the prepared invocation');
  }
  const totalTokens = safeCounter(raw.totalTokens, 'provider reservation totalTokens');
  if (totalTokens < inputTokens + outputTokens) {
    throw new Error('Provider reservation totalTokens is inconsistent');
  }
  if (typeof raw.estimatedCostUsd !== 'number'
      || !Number.isFinite(raw.estimatedCostUsd)
      || Object.is(raw.estimatedCostUsd, -0)
      || raw.estimatedCostUsd < 0) {
    throw new Error('Provider reservation estimatedCostUsd is invalid');
  }
  const createdAt = safeCounter(raw.createdAt, 'provider reservation createdAt');
  if (createdAt < prepared.preparedAt) {
    throw new Error('Provider reservation predates invocation preparation');
  }
  const routeId = exactText(raw.routeId, 'provider reservation routeId', { maxLength: 180 });
  const provider = exactText(raw.provider, 'provider reservation provider', { maxLength: 80 });
  const model = exactText(raw.model, 'provider reservation model', { maxLength: 300 });
  const callNumber = positiveCounter(raw.callNumber, 'provider reservation callNumber');
  if (callNumber !== 1) {
    throw new Error('Provider reservation callNumber exceeds the one-call invocation ceiling');
  }

  const envelope = prepared.internal.agentModelOrchestratorEnvelope;
  const envelopeRoute = envelope.settings.routes[0];
  if (routeId !== envelope.routeId
      || provider !== envelopeRoute.provider
      || model !== envelopeRoute.model) {
    throw new Error('Provider reservation route identity drifted from the admitted envelope');
  }

  return Object.freeze({
    reservationId,
    controlEpoch,
    modelCalls,
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd: raw.estimatedCostUsd,
    createdAt,
    routeId,
    provider,
    model,
    callNumber,
  });
}

function normalizeUsage(value) {
  const raw = strictRecord(value, USAGE_KEYS, 'Agent self-repair model usage');
  const inputTokens = safeCounter(raw.inputTokens, 'model usage inputTokens');
  const outputTokens = safeCounter(raw.outputTokens, 'model usage outputTokens');
  const totalTokens = safeCounter(raw.totalTokens, 'model usage totalTokens');
  const modelCalls = safeCounter(raw.modelCalls, 'model usage modelCalls');
  if (modelCalls !== 1) {
    throw new Error('Agent self-repair observation requires exactly one admitted model call');
  }
  if (totalTokens < inputTokens + outputTokens) {
    throw new Error('Agent self-repair model usage totalTokens is inconsistent');
  }
  return Object.freeze({ inputTokens, outputTokens, totalTokens, modelCalls });
}

function normalizeResultLeg(value, label) {
  if (value === null) return null;
  const raw = strictRecord(value, LEG_KEYS, label);
  return Object.freeze({
    provider: exactText(raw.provider, label + '.provider', { maxLength: 180 }),
    model: exactText(raw.model, label + '.model', { maxLength: 500 }),
    routeId: exactText(raw.routeId, label + '.routeId', { maxLength: 180 }),
    text: modelOutputText(raw.text),
  });
}

function normalizeSuccessfulModelResult(value, envelope) {
  const raw = strictRecord(
    value,
    MODEL_RESULT_KEYS,
    'Agent self-repair model result',
  );
  if (raw.ok !== true) {
    throw new Error('Agent self-repair observation requires a successful model result');
  }

  const text = modelOutputText(raw.text);
  const usage = normalizeUsage(raw.usage);
  const routeClass = exactText(raw.route, 'model result route class', { maxLength: 32 });
  if (routeClass !== 'primary' && routeClass !== 'strong') {
    throw new Error('Agent self-repair model result route class is invalid');
  }

  const routing = strictRecord(
    raw.routing,
    ROUTING_KEYS,
    'Agent self-repair model routing result',
  );
  const selectedRouteId = exactText(
    routing.selectedRouteId,
    'model result selectedRouteId',
    { maxLength: 180 },
  );
  if (selectedRouteId !== envelope.routeId) {
    throw new Error('Agent self-repair model result route drifted from the admitted envelope');
  }

  const primary = normalizeResultLeg(raw.primary, 'model result primary');
  const strong = normalizeResultLeg(raw.strong, 'model result strong');
  const selectedLeg = routeClass === 'primary' ? primary : strong;
  const otherLeg = routeClass === 'primary' ? strong : primary;
  if (!selectedLeg || otherLeg !== null) {
    throw new Error('Agent self-repair one-route result contains an unexpected model leg');
  }

  const envelopeRoute = envelope.settings.routes[0];
  if (selectedLeg.routeId !== envelope.routeId
      || selectedLeg.provider !== envelopeRoute.provider
      || selectedLeg.model !== envelopeRoute.model) {
    throw new Error('Agent self-repair model result provider identity drifted from the admitted envelope');
  }
  if (selectedLeg.text !== text) {
    throw new Error('Agent self-repair model result text disagrees with the selected route result');
  }

  return Object.freeze({
    text,
    usage,
    routeId: selectedRouteId,
    provider: selectedLeg.provider,
    model: selectedLeg.model,
  });
}

/**
 * Project one successfully admitted self-repair model call into the existing
 * canonical ObservationV1 evidence contract.
 *
 * The Observation invocationId is the exact durable BrowserAgent provider
 * reservation identity returned by the existing pre-dispatch budget lifecycle.
 * This function cannot mint another invocation identity, verify model output,
 * complete work, persist evidence, or create artifacts. Large model output is
 * not copied into ObservationV1; downstream code must materialize it through
 * the canonical ArtifactRef path if needed.
 */
export function projectAgentSelfRepairModelObservationV1(input) {
  const raw = strictRecord(
    input,
    REQUEST_KEYS,
    'Agent self-repair model observation request',
  );

  const prepared = prepareBoundAgentSelfRepairModelInvocationV1(
    raw.invocationRequest,
  );
  const providerReservation = normalizeProviderReservation(
    raw.providerReservation,
    prepared,
  );
  const observationId = exactText(
    raw.observationId,
    'observationId',
    { maxLength: 180 },
  );
  const observedAt = exactCanonicalTimestamp(
    raw.observedAt,
    'observedAt',
  );
  if (observedAt.milliseconds < providerReservation.createdAt) {
    throw new Error('Agent self-repair model observation predates durable provider admission');
  }

  const modelResult = normalizeSuccessfulModelResult(
    raw.modelResult,
    prepared.internal.agentModelOrchestratorEnvelope,
  );
  if (modelResult.usage.outputTokens > providerReservation.outputTokens) {
    throw new Error('Agent self-repair model usage exceeds the durable provider output-token reservation');
  }
  const summary = modelResult.text.slice(0, MAX_OBSERVATION_SUMMARY);
  const outputTruncated = modelResult.text.length > summary.length;

  return normalizeObservationV1({
    schemaVersion: 1,
    observationId,
    invocationId: providerReservation.reservationId,
    status: ObservationStatus.OK,
    summary,
    data: {
      sourceKind: 'AGENT_SELF_REPAIR_MODEL_OUTPUT',
      sourceTrust: 'UNVERIFIED_INPUT',
      planId: prepared.planId,
      rootJobId: prepared.rootJobId,
      jobId: prepared.jobId,
      cycleId: prepared.cycleId,
      workKind: prepared.workKind,
      activeAttemptNumber: prepared.activeAttemptNumber,
      nodeId: prepared.nodeId,
      ownerId: prepared.ownerId,
      providerAdmission: {
        controlEpoch: providerReservation.controlEpoch,
        callNumber: providerReservation.callNumber,
        createdAt: providerReservation.createdAt,
      },
      route: {
        routeId: modelResult.routeId,
        provider: modelResult.provider,
        model: modelResult.model,
      },
      usage: modelResult.usage,
      outputTruncated,
      fullOutputArtifactRequired: outputTruncated,
    },
    artifactRefs: [],
    observedAt: observedAt.value,
  });
}
