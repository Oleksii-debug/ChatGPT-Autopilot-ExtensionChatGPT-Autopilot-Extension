import {
  ObservationStatus,
  normalizeObservationV1,
} from './universal-agent-contracts.js';
import {
  projectAgentSelfRepairProviderReceiptV1,
} from './agent-self-repair-provider-receipt.js';

const REQUEST_KEYS = new Set([
  'invocationRequest',
  'trustedProviderReservation',
  'observationId',
  'modelResult',
  'observedAt',
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

function normalizeUsage(value) {
  const raw = strictRecord(value, USAGE_KEYS, 'Agent self-repair model usage');
  const inputTokens = safeCounter(raw.inputTokens, 'model usage inputTokens');
  const outputTokens = safeCounter(raw.outputTokens, 'model usage outputTokens');
  const totalTokens = safeCounter(raw.totalTokens, 'model usage totalTokens');
  const modelCalls = safeCounter(raw.modelCalls, 'model usage modelCalls');
  if (modelCalls !== 1) {
    throw new Error('Agent self-repair observation requires exactly one admitted model call');
  }
  if (totalTokens < inputTokens || totalTokens < outputTokens) {
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
 * This function deliberately cannot mint an invocation identity, verify the
 * model output, complete work, persist evidence, or create artifacts. The
 * caller must supply the exact durable provider-budget reservation returned by
 * the existing BrowserAgent lifecycle. Its reservationId becomes the
 * non-authorizing invocation identity only after strict owner/epoch/route/budget
 * binding. Large model output is not copied into ObservationV1; downstream
 * code must materialize it through the canonical ArtifactRef path if needed.
 */
export function projectAgentSelfRepairModelObservationV1(input) {
  const raw = strictRecord(
    input,
    REQUEST_KEYS,
    'Agent self-repair model observation request',
  );

  const providerReceipt = projectAgentSelfRepairProviderReceiptV1({
    invocationRequest: raw.invocationRequest,
    trustedReservation: raw.trustedProviderReservation,
  });
  const prepared = providerReceipt;
  const observationId = exactText(
    raw.observationId,
    'observationId',
    { maxLength: 180 },
  );
  const observedAt = exactCanonicalTimestamp(
    raw.observedAt,
    'observedAt',
  );
  if (observedAt.milliseconds < prepared.preparedAt) {
    throw new Error('Agent self-repair model observation predates invocation preparation');
  }

  const modelResult = normalizeSuccessfulModelResult(
    raw.modelResult,
    prepared.internal.agentModelOrchestratorEnvelope,
  );
  const summary = modelResult.text.slice(0, MAX_OBSERVATION_SUMMARY);
  const outputTruncated = modelResult.text.length > summary.length;

  return normalizeObservationV1({
    schemaVersion: 1,
    observationId,
    invocationId: providerReceipt.invocationId,
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
