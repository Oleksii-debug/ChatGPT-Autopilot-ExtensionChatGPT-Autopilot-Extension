import { DEFAULT_GATEWAY_URL, normalizeGatewayUrl } from './ai-gateway-client.js';
import { rankAiRouteCandidatesByEvidenceV1 } from './ai-route-quality-governor.js';
import {
  AiRouteRole,
  DEFAULT_AI_ROUTE_POLICY,
  DEFAULT_AI_WORKER_POLICY,
  classifyAiRouteError,
  createAiRoutePoolExhaustedError,
  normalizeAiRoutePolicy,
  normalizeAiRoutePool,
  normalizeAiRouteStates,
  normalizeAiWorkerPolicy,
  recordAiRouteOutcome,
  selectAiRouteCandidates,
} from './ai-route-pool.js';

export const AiRouterMode = Object.freeze({
  PRIMARY: 'primary',
  STRONG: 'strong',
  HYBRID_AUTO: 'hybrid-auto',
  HYBRID_RULES: 'hybrid-rules',
});

export const AiProvider = Object.freeze({
  OLLAMA: 'ollama',
  OPENAI: 'openai',
  OPENAI_COMPATIBLE: 'openai-compatible',
});

const MODES = new Set(Object.values(AiRouterMode));
const PROVIDERS = new Set(Object.values(AiProvider));
const ESCALATION_MARKER = '[[ESCALATE]]';
const MAX_HANDOFF_CHARS = 50_000;

export const DEFAULT_AI_ROUTER_SETTINGS = Object.freeze({
  enabled: false,
  gatewayUrl: DEFAULT_GATEWAY_URL,
  timeoutSeconds: 180,
  mode: AiRouterMode.PRIMARY,
  primary: Object.freeze({ provider: AiProvider.OLLAMA, model: '' }),
  strong: Object.freeze({ provider: AiProvider.OPENAI, model: '' }),
  strongEveryNRequests: 10,
  strongEveryMinutes: 120,
  strongMinGapMinutes: 0,
  strongMaxPerHour: 0,
  carryStrongResultToPrimary: true,
  handoffMaxChars: 12_000,
  fallbackToStrongOnPrimaryError: true,
  keepPrimaryIfStrongFails: true,
  routes: Object.freeze([]),
  routePolicy: DEFAULT_AI_ROUTE_POLICY,
  workerPolicy: DEFAULT_AI_WORKER_POLICY,
});

export const DEFAULT_AI_ROUTER_RUNTIME = Object.freeze({
  requestCount: 0,
  primaryCount: 0,
  startedAt: 0,
  strongCount: 0,
  lastStrongAt: 0,
  lastRoute: '',
  lastStrongResult: '',
  strongHistoryAt: Object.freeze([]),
  routeStates: Object.freeze({}),
  lastRouteId: '',
  lastProvider: '',
  lastModel: '',
  lastEndpointId: '',
  lastFailoverChain: Object.freeze([]),
});

const clean = value => typeof value === 'string' ? value.trim() : '';

// Reuse BrowserAgentManager's sole durable model-budget reservation authority.
// The router only validates and copies its pre-dispatch receipt; it never
// creates a competing budget ledger or authorizes another provider effect.
function providerBudgetAdmissionError(detail) {
  const error = new Error('AI provider budget reservation missing or invalid: ' + detail);
  error.code = 'AI_PROVIDER_BUDGET_RESERVATION_MISSING';
  return error;
}
function providerBudgetSettlementError(detail) {
  const error = new Error('Provider call did not settle the durable budget reservation: ' + detail);
  error.code = 'AI_PROVIDER_BUDGET_SETTLEMENT_REJECTED';
  return error;
}
const PROVIDER_RESERVATION_FIELDS = Object.freeze([
  'reservationId', 'controlEpoch', 'modelCalls', 'inputTokens',
  'outputTokens', 'totalTokens', 'estimatedCostUsd', 'createdAt',
  'routeId', 'provider', 'model', 'callNumber',
]);
function admittedProviderBudgetReservation(value, context, route, callNumber) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw providerBudgetAdmissionError('expected a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(PROVIDER_RESERVATION_FIELDS);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw providerBudgetAdmissionError('unknown reservation field');
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw providerBudgetAdmissionError(key + ' must be an enumerable own data property');
    }
  }
  const receipt = {};
  for (const key of PROVIDER_RESERVATION_FIELDS) {
    if (!Object.hasOwn(descriptors, key)) {
      throw providerBudgetAdmissionError(key + ' must be an enumerable own data property');
    }
    receipt[key] = descriptors[key].value;
  }
  if (typeof context?.jobId !== 'string' || !context.jobId
      || typeof receipt.reservationId !== 'string'
      || !receipt.reservationId.startsWith(context.jobId + ':model-budget:')
      || !/^[1-9][0-9]*$/u.test(receipt.reservationId.slice((context.jobId + ':model-budget:').length))) {
    throw providerBudgetAdmissionError('reservationId does not match admitted Browser Agent job');
  }
  if (!Number.isSafeInteger(receipt.controlEpoch) || Object.is(receipt.controlEpoch, -0)
      || receipt.controlEpoch !== context.controlEpoch) {
    throw providerBudgetAdmissionError('controlEpoch does not match admission');
  }
  if (!Number.isSafeInteger(receipt.callNumber) || receipt.callNumber !== callNumber) {
    throw providerBudgetAdmissionError('callNumber does not match admission');
  }
  if (receipt.modelCalls !== 1) {
    throw providerBudgetAdmissionError('a reservation must admit exactly one model call');
  }
  for (const key of ['routeId', 'provider', 'model']) {
    if (typeof receipt[key] !== 'string' || receipt[key] !== route[key]) {
      throw providerBudgetAdmissionError(key + ' does not match admitted route');
    }
  }
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'createdAt']) {
    if (!Number.isSafeInteger(receipt[key]) || receipt[key] < 0 || Object.is(receipt[key], -0)) {
      throw providerBudgetAdmissionError(key + ' must be a nonnegative safe integer');
    }
  }
  if (receipt.totalTokens < receipt.inputTokens + receipt.outputTokens
      || typeof receipt.estimatedCostUsd !== 'number'
      || !Number.isFinite(receipt.estimatedCostUsd) || receipt.estimatedCostUsd < 0
      || Object.is(receipt.estimatedCostUsd, -0)) {
    throw providerBudgetAdmissionError('reserved model budget has invalid amounts');
  }
  return Object.freeze(receipt);
}
function requireProviderBudgetSettlement(value) {
  // Legacy callbacks may resolve void; an explicit settlement response must
  // prove success without accessing getters or accepting a forged status.
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw providerBudgetSettlementError('invalid settlement status');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'settled');
  if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
    throw providerBudgetSettlementError('settled must be an enumerable own data property');
  }
  if (descriptor.value !== true) {
    throw providerBudgetSettlementError('settled was not true');
  }
}


function normalizeSlot(raw, fallback) {
  const provider = PROVIDERS.has(raw?.provider) ? raw.provider : fallback.provider;
  const model = clean(raw?.model);
  if (model.length > 300) throw new Error('AI model name is too long');
  return { provider, model };
}

export function normalizeAiRouterSettings(raw = {}) {
  const timeoutSeconds = Number(raw.timeoutSeconds ?? DEFAULT_AI_ROUTER_SETTINGS.timeoutSeconds);
  const strongEveryNRequests = Number(raw.strongEveryNRequests ?? DEFAULT_AI_ROUTER_SETTINGS.strongEveryNRequests);
  const strongEveryMinutes = Number(raw.strongEveryMinutes ?? DEFAULT_AI_ROUTER_SETTINGS.strongEveryMinutes);
  const handoffMaxChars = Number(raw.handoffMaxChars ?? DEFAULT_AI_ROUTER_SETTINGS.handoffMaxChars);
  const strongMinGapMinutes = Number(raw.strongMinGapMinutes ?? DEFAULT_AI_ROUTER_SETTINGS.strongMinGapMinutes);
  const strongMaxPerHour = Number(raw.strongMaxPerHour ?? DEFAULT_AI_ROUTER_SETTINGS.strongMaxPerHour);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 900) throw new Error('AI timeout must be a whole number from 5 to 900 seconds');
  if (!Number.isInteger(strongEveryNRequests) || strongEveryNRequests < 0 || strongEveryNRequests > 10000) throw new Error('Strong-model request interval must be 0-10000 prompts');
  if (!Number.isInteger(strongEveryMinutes) || strongEveryMinutes < 0 || strongEveryMinutes > 10080) throw new Error('Strong-model time interval must be 0-10080 minutes');
  if (!Number.isInteger(handoffMaxChars) || handoffMaxChars < 1000 || handoffMaxChars > MAX_HANDOFF_CHARS) throw new Error(`AI handoff size must be 1000-${MAX_HANDOFF_CHARS} characters`);
  if (!Number.isInteger(strongMinGapMinutes) || strongMinGapMinutes < 0 || strongMinGapMinutes > 1440) throw new Error('Strong-model minimum gap must be 0-1440 minutes');
  if (!Number.isInteger(strongMaxPerHour) || strongMaxPerHour < 0 || strongMaxPerHour > 1000) throw new Error('Strong-model hourly limit must be 0-1000 calls');
  const routes = normalizeAiRoutePool(raw.routes || []);
  return {
    enabled: raw.enabled === true,
    gatewayUrl: normalizeGatewayUrl(raw.gatewayUrl),
    timeoutSeconds,
    mode: MODES.has(raw.mode) ? raw.mode : DEFAULT_AI_ROUTER_SETTINGS.mode,
    primary: normalizeSlot(raw.primary, DEFAULT_AI_ROUTER_SETTINGS.primary),
    strong: normalizeSlot(raw.strong, DEFAULT_AI_ROUTER_SETTINGS.strong),
    strongEveryNRequests,
    strongEveryMinutes,
    strongMinGapMinutes,
    strongMaxPerHour,
    carryStrongResultToPrimary: raw.carryStrongResultToPrimary !== false,
    handoffMaxChars,
    fallbackToStrongOnPrimaryError: raw.fallbackToStrongOnPrimaryError !== false,
    keepPrimaryIfStrongFails: raw.keepPrimaryIfStrongFails !== false,
    routes,
    routePolicy: normalizeAiRoutePolicy(raw.routePolicy || DEFAULT_AI_ROUTE_POLICY),
    workerPolicy: normalizeAiWorkerPolicy(raw.workerPolicy || DEFAULT_AI_WORKER_POLICY, routes),
  };
}

export function validateAiRouterReadiness(rawSettings = {}) {
  const settings = normalizeAiRouterSettings(rawSettings);
  if (!settings.enabled) return settings;
  if (settings.routes.length) return settings;

  const requireModel = (slot, label) => {
    if (!slot?.model) throw new Error(`${label} AI model must be selected before enabling the AI coordinator`);
  };

  if (settings.mode === AiRouterMode.PRIMARY) {
    requireModel(settings.primary, 'Primary');
  } else if (settings.mode === AiRouterMode.STRONG) {
    requireModel(settings.strong, 'Strong');
  } else {
    requireModel(settings.primary, 'Primary');
    requireModel(settings.strong, 'Strong');
  }
  return settings;
}

export function normalizeAiRouterRuntime(raw = {}) {
  const num = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  const routes = Array.isArray(raw.__routesForNormalization) ? raw.__routesForNormalization : [];
  return {
    requestCount: Math.floor(num(raw.requestCount)),
    primaryCount: Math.floor(num(raw.primaryCount)),
    startedAt: num(raw.startedAt),
    strongCount: Math.floor(num(raw.strongCount)),
    lastStrongAt: num(raw.lastStrongAt),
    lastRoute: clean(raw.lastRoute),
    lastStrongResult: clean(raw.lastStrongResult).slice(0, MAX_HANDOFF_CHARS),
    strongHistoryAt: Array.isArray(raw.strongHistoryAt) ? raw.strongHistoryAt.map(num).filter(Boolean).slice(-1000) : [],
    routeStates: normalizeAiRouteStates(raw.routeStates, routes.length ? routes : Object.keys(raw.routeStates || {}).map(routeId => ({ routeId }))),
    lastRouteId: clean(raw.lastRouteId),
    lastProvider: clean(raw.lastProvider).slice(0, 100),
    lastModel: clean(raw.lastModel).slice(0, 300),
    lastEndpointId: clean(raw.lastEndpointId).slice(0, 180),
    lastFailoverChain: Array.isArray(raw.lastFailoverChain) ? raw.lastFailoverChain.filter(item => item && typeof item === 'object' && !Array.isArray(item)).slice(-32).map(item => ({
      routeId:clean(item.routeId),
      provider:clean(item.provider).slice(0, 100),
      model:clean(item.model).slice(0, 300),
      endpointId:clean(item.endpointId).slice(0, 180),
      outcome:clean(item.outcome),
      code:clean(item.code),
      category:clean(item.category),
    })) : [],
  };
}

function requireConfigured(slot, label) {
  if (!slot?.model) throw new Error(`${label} AI model is not selected`);
}

function previousStrongContext(settings, runtime) {
  if (!settings.carryStrongResultToPrimary || !runtime.lastStrongResult) return '';
  return `\n\nCONTEXT FROM THE LAST STRONG-MODEL PASS:\n${runtime.lastStrongResult.slice(0, settings.handoffMaxChars)}`;
}

function autoEscalationSystemPrompt(baseSystem = '') {
  return `${clean(baseSystem)}\n\nHYBRID ROUTING RULE:\nDo the task yourself if you can do it reliably. If the task needs the stronger model because of uncertainty, complexity, high-stakes verification, or a blocker you cannot resolve confidently, do not pretend to finish it. Start your response with exactly ${ESCALATION_MARKER} and then write a concise handoff report for the stronger model: what you understood, what you checked, what remains, and what the stronger model must decide or do.`.trim();
}

function automaticStrongGuard(settings, runtime, now) {
  if (settings.strongMinGapMinutes > 0 && runtime.lastStrongAt > 0) {
    const earliest = runtime.lastStrongAt + settings.strongMinGapMinutes * 60_000;
    if (now < earliest) return { allowed: false, reason: 'strong-min-gap', retryAt: earliest };
  }
  if (settings.strongMaxPerHour > 0) {
    const recent = (runtime.strongHistoryAt || []).filter(at => now - at < 60 * 60_000);
    if (recent.length >= settings.strongMaxPerHour) {
      const retryAt = Math.min(...recent) + 60 * 60_000;
      return { allowed: false, reason: 'strong-hourly-limit', retryAt };
    }
  }
  return { allowed: true, reason: '', retryAt: 0 };
}

function routePolicyBlocksAutomaticFallback(settings) {
  return Boolean(settings?.routes?.length) && (
    Boolean(clean(settings?.routePolicy?.pinnedRouteId))
    || settings?.routePolicy?.autoSwitch === false
  );
}

function shouldScheduledStrong(settings, runtime, now) {
  const nextRequestNumber = runtime.requestCount + 1;
  const dueByCount = settings.strongEveryNRequests > 0 && nextRequestNumber % settings.strongEveryNRequests === 0;
  const timeBaseline = runtime.lastStrongAt || runtime.startedAt;
  const dueByTime = settings.strongEveryMinutes > 0
    && timeBaseline > 0
    && now - timeBaseline >= settings.strongEveryMinutes * 60_000;
  return dueByCount || dueByTime;
}

function buildStrongHandoff({ prompt, primaryText, runtime, settings, trigger }) {
  const previous = runtime.lastStrongResult
    ? `\n\nPREVIOUS STRONG-MODEL RESULT (context only):\n${runtime.lastStrongResult.slice(0, settings.handoffMaxChars)}`
    : '';
  const report = clean(primaryText).replace(new RegExp(`^${ESCALATION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '');
  return `You are the stronger escalation/review model in a persistent hybrid AI workflow.\n\nTRIGGER: ${trigger}\n\nORIGINAL TASK:\n${clean(prompt)}\n\nPRIMARY/LOCAL WORKER REPORT OR DRAFT:\n${report || '(no primary report)'}${previous}\n\nContinue the task from this handoff. Correct errors, resolve uncertainty, and return the best usable result. Do not merely comment on the handoff.`.slice(0, settings.handoffMaxChars + clean(prompt).length + 2000);
}

export class AiOrchestrator {
  constructor({ gatewayClient, now = () => Date.now(), providerCallLifecycle = null,
    routeQualityEvidenceResolver = null, routeQualityEvidenceTimeoutMs = 250 } = {}) {
    if (!gatewayClient) throw new Error('AI Gateway client is required');
    if (providerCallLifecycle != null && (
      typeof providerCallLifecycle !== 'object'
      || typeof providerCallLifecycle.beforeProviderCall !== 'function'
      || typeof providerCallLifecycle.afterProviderCall !== 'function'
    )) {
      throw new Error('AI provider-call lifecycle must expose beforeProviderCall and afterProviderCall');
    }
    if (routeQualityEvidenceResolver !== null && typeof routeQualityEvidenceResolver !== 'function') {
      throw new Error('AI route quality evidence resolver must be a function');
    }
    if (typeof routeQualityEvidenceTimeoutMs !== 'number'
        || !Number.isSafeInteger(routeQualityEvidenceTimeoutMs)
        || Object.is(routeQualityEvidenceTimeoutMs, -0)
        || routeQualityEvidenceTimeoutMs < 1 || routeQualityEvidenceTimeoutMs > 5000) {
      throw new Error('AI route quality evidence timeout must be a whole number from 1 to 5000 milliseconds');
    }
    this.gateway = gatewayClient;
    this.now = now;
    this.providerCallLifecycle = providerCallLifecycle;
    this.routeQualityEvidenceResolver = routeQualityEvidenceResolver;
    this.routeQualityEvidenceTimeoutMs = routeQualityEvidenceTimeoutMs;
  }

  async run(rawSettings, rawRuntime, prompt, {
    systemPrompt = '', forceStrong = false, maxOutputTokens = 0, maxModelCallsForRequest = 0, imageDataUrl = '',
    taskRole = AiRouteRole.PLANNER, strongTaskRole = AiRouteRole.VERIFIER, capabilityIds = [],
    providerCallBudgetContext = null,
  } = {}) {
    const settings = normalizeAiRouterSettings(rawSettings);
    const runtime = normalizeAiRouterRuntime(rawRuntime);
    if (!settings.enabled) throw new Error('AI coordinator is disabled');
    const userPrompt = clean(prompt);
    if (!userPrompt) throw new Error('AI coordinator prompt is empty');
    const now = this.now();

    const outputCeiling = Math.max(0, Math.floor(Number(maxOutputTokens) || 0));
    const callCeiling = Math.max(0, Math.floor(Number(maxModelCallsForRequest) || 0));
    let callsUsed = 0;
    let routeStates = normalizeAiRouteStates(runtime.routeStates, settings.routes);
    const routeAttempts = [];
    let selectedRouteId = runtime.lastRouteId;
    let selectedRouteIdentity = Object.freeze({
      provider: runtime.lastProvider,
      model: runtime.lastModel,
      endpointId: runtime.lastEndpointId,
    });
    const consumedOutput = () => Math.max(0, Number(primaryResult?.usage?.outputTokens || 0)) + Math.max(0, Number(strongResult?.usage?.outputTokens || 0));
    const remainingOutput = () => outputCeiling ? Math.max(0, outputCeiling - consumedOutput()) : 0;
    const routeRuntimeSnapshot = () => normalizeAiRouterRuntime({
      ...runtime,
      routeStates,
      lastRouteId:selectedRouteId,
      lastProvider:selectedRouteIdentity.provider,
      lastModel:selectedRouteIdentity.model,
      lastEndpointId:selectedRouteIdentity.endpointId,
      lastFailoverChain:routeAttempts,
    });
    const attachFailureRuntime = error => {
      if (error && typeof error === 'object') {
        error.modelCallsUsed = Math.max(Number(error.modelCallsUsed || 0), callsUsed);
        error.routerRuntime = routeRuntimeSnapshot();
        error.routeAttempts = structuredClone(routeAttempts);
      }
      return error;
    };
    const invoke = async (route, callPrompt, callSystem, bounded) => {
      if (callCeiling && callsUsed >= callCeiling) {
        const error = new Error('AI model-call budget exhausted before another provider call');
        error.code = 'AI_MODEL_CALL_BUDGET_EXHAUSTED';
        error.modelCallsUsed = callsUsed;
        throw attachFailureRuntime(error);
      }
      const lifecycle = providerCallBudgetContext ? this.providerCallLifecycle : null;
      const routeIdentity = Object.freeze({
        routeId: clean(route?.routeId),
        provider: clean(route?.provider),
        model: clean(route?.model),
        endpointId: clean(route?.endpointId),
      });
      let reservation = null;
      if (lifecycle) {
        const admitted = await lifecycle.beforeProviderCall({
          context: providerCallBudgetContext,
          route: routeIdentity,
          prompt: callPrompt,
          systemPrompt: callSystem,
          maxOutputTokens: bounded,
          callNumber: callsUsed + 1,
        });
        reservation = admittedProviderBudgetReservation(
          admitted, providerCallBudgetContext, routeIdentity, callsUsed + 1,
        );
      }
      callsUsed += 1;
      let value;
      try {
        value = await this.gateway.complete({
          gatewayUrl: settings.gatewayUrl,
          timeoutSeconds: settings.timeoutSeconds,
          provider: route.provider,
          model: route.model,
          ...(route.endpointId ? { endpointId: route.endpointId } : {}),
          prompt: callPrompt,
          systemPrompt: callSystem,
          ...(bounded ? { maxOutputTokens: bounded } : {}),
          ...(clean(imageDataUrl) ? { imageDataUrl: clean(imageDataUrl) } : {}),
        });
      } catch (error) {
        if (lifecycle) {
          try {
            const settlement = await lifecycle.afterProviderCall({
              context: providerCallBudgetContext,
              reservation,
              route: routeIdentity,
              ok: false,
              error,
            });
            requireProviderBudgetSettlement(settlement);
          } catch (settlementError) {
            const classification = classifyAiRouteError(settlementError);
            routeAttempts.push({ ...routeIdentity, outcome:'FAILED', code:classification.code, category:classification.category });
            throw attachFailureRuntime(settlementError);
          }
        }
        const classification = classifyAiRouteError(error);
        routeAttempts.push({ ...routeIdentity, outcome:'FAILED', code:classification.code, category:classification.category });
        throw attachFailureRuntime(error);
      }
      if (lifecycle) {
        try {
          const settlement = await lifecycle.afterProviderCall({
            context: providerCallBudgetContext,
            reservation,
            route: routeIdentity,
            ok: true,
            result: value,
          });
          requireProviderBudgetSettlement(settlement);
        } catch (settlementError) {
          const classification = classifyAiRouteError(settlementError);
          routeAttempts.push({ ...routeIdentity, outcome:'FAILED', code:classification.code, category:classification.category });
          throw attachFailureRuntime(settlementError);
        }
      }
      routeAttempts.push({ ...routeIdentity, outcome:'SUCCESS', code:'', category:'' });
      selectedRouteId = routeIdentity.routeId;
      selectedRouteIdentity = Object.freeze({
        provider: routeIdentity.provider,
        model: routeIdentity.model,
        endpointId: routeIdentity.endpointId,
      });
      return reservation ? { ...value, providerReservation: reservation } : value;
    };
    const call = async (slot, callPrompt, callSystem, callOutputLimit = 0, requestedRole = taskRole) => {
      const bounded = Math.max(0, Math.floor(Number(callOutputLimit) || 0));
      if (!settings.routes.length) {
        requireConfigured(slot, slot === settings.strong ? 'Strong' : 'Primary');
        return invoke({ routeId:'', provider:slot.provider, model:slot.model, endpointId:'' }, callPrompt, callSystem, bounded);
      }
      const requiresVision = Boolean(clean(imageDataUrl));
      const selectFresh = () => selectAiRouteCandidates({
        routes:settings.routes, policy:settings.routePolicy, routeStates,
        role:requestedRole, capabilityIds, requiresVision, now:this.now(),
      });
      let selected = selectFresh();
      // Quality evidence is advisory: refresh owner eligibility after async lookup.
      if (this.routeQualityEvidenceResolver && settings.routePolicy.autoSwitch
          && !settings.routePolicy.pinnedRouteId && selected.candidates.length > 1) {
        const request = Object.freeze({
          routeIds:Object.freeze(selected.candidates.map(route => route.routeId)),
          role:requestedRole,
          capabilityIds:Object.freeze([...capabilityIds]),
          requiresVision,
        });
        let timer;
        let evidence = null;
        try {
          evidence = await Promise.race([
            Promise.resolve().then(() => this.routeQualityEvidenceResolver(request)),
            new Promise(resolve => { timer = setTimeout(() => resolve(null), this.routeQualityEvidenceTimeoutMs); }),
          ]);
        } catch {
          // No evidence never widens permissions or blocks canonical dispatch.
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        selected = selectFresh();
        if (Array.isArray(evidence) && selected.candidates.length > 1) {
          try {
            const ranked = await rankAiRouteCandidatesByEvidenceV1({
              routes:settings.routes, policy:settings.routePolicy, routeStates,
              role:requestedRole, capabilityIds, requiresVision,
              now:this.now(), benchmarkRequests:evidence,
            });
            const canonical = new Map(selected.candidates.map(route => [route.routeId, route]));
            const reordered = ranked.rankedRouteIds
              .filter(routeId => canonical.has(routeId))
              .map(routeId => canonical.get(routeId));
            if (reordered.length === selected.candidates.length) {
              selected = { ...selected, candidates:reordered };
            }
          } catch {
            // Invalid, expired, or untrusted evidence keeps canonical owner order.
          }
        }
      }
      if (!selected.candidates.length) {
        throw attachFailureRuntime(createAiRoutePoolExhaustedError({
          attempts:routeAttempts,
          retryAt:selected.retryAt,
          message:selected.retryAt ? 'Every eligible AI route is in durable backoff' : 'No AI route satisfies the requested role, capabilities, vision and owner policy',
        }));
      }
      for (const route of selected.candidates) {
        const started = this.now();
        try {
          const routeSystem = route.systemPrompt ? [callSystem, route.systemPrompt].filter(Boolean).join('\n\n') : callSystem;
          const routePrompt = route.workerPrompt ? [route.workerPrompt, callPrompt].filter(Boolean).join('\n\n') : callPrompt;
          const value = await invoke(route, routePrompt, routeSystem, bounded);
          routeStates = { ...routeStates, [route.routeId]:recordAiRouteOutcome(routeStates, route, settings.routePolicy, { ok:true, at:this.now(), latencyMs:Math.max(0, this.now() - started) }) };
          return { ...value, routeSelection:{ routeId:route.routeId, provider:route.provider, model:route.model, endpointId:route.endpointId, reason:routeAttempts.length > 1 ? 'failover' : 'policy-selection' } };
        } catch (error) {
          const classification = classifyAiRouteError(error);
          if (error && typeof error === 'object') error.routeFailureClassification = classification;
          routeStates = { ...routeStates, [route.routeId]:recordAiRouteOutcome(routeStates, route, settings.routePolicy, { ok:false, classification, at:this.now(), latencyMs:Math.max(0, this.now() - started) }) };
          attachFailureRuntime(error);
          if (!classification.retryable) throw error;
          if (!settings.routePolicy.autoSwitch) {
            const failedState = routeStates[route.routeId];
            const retryAt = Math.max(failedState?.backoffUntil || 0, failedState?.circuitOpenUntil || 0);
            if (error && typeof error === 'object' && retryAt > now) error.retryAt = retryAt;
            throw attachFailureRuntime(error);
          }
        }
      }
      const exhausted = selectAiRouteCandidates({
        routes: settings.routes,
        policy: settings.routePolicy,
        routeStates,
        role: requestedRole,
        capabilityIds,
        requiresVision: Boolean(clean(imageDataUrl)),
        now,
      });
      throw attachFailureRuntime(createAiRoutePoolExhaustedError({
        attempts: routeAttempts,
        retryAt: exhausted.retryAt,
        message: 'Every eligible AI route failed with a retryable provider error',
      }));
    };

    let primaryResult = null;
    let strongResult = null;
    let trigger = '';
    let primaryError = '';
    let strongError = '';

    const tryStrong = async (callPrompt, callSystem, why, { respectAutomaticGuard = false } = {}) => {
      if (respectAutomaticGuard) {
        const guard = automaticStrongGuard(settings, runtime, now);
        if (!guard.allowed) {
          const error = new Error(`Automatic strong fallback blocked by ${guard.reason}`);
          strongError = error.message;
          trigger = `${why}-${guard.reason}-blocked`;
          throw error;
        }
      }
      try {
        const strongLimit = outputCeiling ? remainingOutput() : 0;
        if (outputCeiling && strongLimit < 1) {
          const error = new Error('Strong-model escalation blocked by Browser Agent output-token budget');
          strongError = error.message;
          trigger = `${why}-output-budget-blocked`;
          throw error;
        }
        const value = await call(settings.strong, callPrompt, callSystem, strongLimit, strongTaskRole);
        trigger = why;
        return value;
      } catch (error) {
        strongError = clean(error?.message || error);
        throw error;
      }
    };

    if (forceStrong || settings.mode === AiRouterMode.STRONG) {
      trigger = forceStrong ? 'manual-force-strong' : 'strong-only';
      strongResult = await call(settings.strong, userPrompt, clean(systemPrompt), outputCeiling, strongTaskRole);
    } else if (settings.mode === AiRouterMode.PRIMARY) {
      try {
        primaryResult = await call(settings.primary, userPrompt, `${clean(systemPrompt)}${previousStrongContext(settings, runtime)}`.trim(), outputCeiling);
      } catch (error) {
        primaryError = clean(error?.message || error);
        if (routePolicyBlocksAutomaticFallback(settings)) throw error;
        if (error?.routeFailureClassification?.retryable === false) throw error;
        if (!settings.fallbackToStrongOnPrimaryError || (!settings.routes.length && !settings.strong.model)) throw error;
        strongResult = await tryStrong(
          `PRIMARY MODEL FAILED. Continue the original task directly.\n\nPRIMARY ERROR:\n${primaryError}\n\nORIGINAL TASK:\n${userPrompt}`,
          clean(systemPrompt),
          'primary-error-fallback-to-strong',
          { respectAutomaticGuard: true },
        );
      }
    } else {
      const primarySystem = settings.mode === AiRouterMode.HYBRID_AUTO
        ? autoEscalationSystemPrompt(`${clean(systemPrompt)}${previousStrongContext(settings, runtime)}`)
        : `${clean(systemPrompt)}${previousStrongContext(settings, runtime)}`.trim();
      try {
        primaryResult = await call(settings.primary, userPrompt, primarySystem, outputCeiling);
      } catch (error) {
        primaryError = clean(error?.message || error);
        if (routePolicyBlocksAutomaticFallback(settings)) throw error;
        if (error?.routeFailureClassification?.retryable === false) throw error;
        if (!settings.fallbackToStrongOnPrimaryError || (!settings.routes.length && !settings.strong.model)) throw error;
        strongResult = await tryStrong(
          `PRIMARY/LOCAL MODEL FAILED BEFORE PRODUCING A HANDOFF. Complete the original task.\n\nPRIMARY ERROR:\n${primaryError}\n\nORIGINAL TASK:\n${userPrompt}`,
          clean(systemPrompt),
          'primary-error-fallback-to-strong',
          { respectAutomaticGuard: true },
        );
      }
      if (primaryResult) {
        const autoRequested = settings.mode === AiRouterMode.HYBRID_AUTO && clean(primaryResult.text).startsWith(ESCALATION_MARKER);
        const scheduled = settings.mode === AiRouterMode.HYBRID_RULES && shouldScheduledStrong(settings, runtime, now);
        if (autoRequested || scheduled) {
          const requestedTrigger = autoRequested ? 'primary-requested-escalation' : 'scheduled-review';
          const guard = automaticStrongGuard(settings, runtime, now);
          if (!guard.allowed) {
            trigger = `${requestedTrigger}-${guard.reason}-deferred`;
          } else {
            const handoff = buildStrongHandoff({ prompt: userPrompt, primaryText: primaryResult.text, runtime, settings, trigger: requestedTrigger });
            try {
              strongResult = await tryStrong(handoff, clean(systemPrompt), requestedTrigger);
            } catch (error) {
              if (!settings.keepPrimaryIfStrongFails) throw error;
              trigger = `${requestedTrigger}-strong-failed-primary-used`;
            }
          }
        }
      }
    }

    const finalResult = strongResult || primaryResult;
    const nextRuntime = {
      ...runtime,
      requestCount: runtime.requestCount + 1,
      startedAt: runtime.startedAt || now,
      primaryCount: runtime.primaryCount + (primaryResult ? 1 : 0),
      strongCount: runtime.strongCount + (strongResult ? 1 : 0),
      lastStrongAt: strongResult ? now : runtime.lastStrongAt,
      lastRoute: strongResult ? 'strong' : 'primary',
      lastStrongResult: strongResult ? clean(strongResult.text).slice(0, settings.handoffMaxChars) : runtime.lastStrongResult,
      strongHistoryAt: strongResult
        ? [...(runtime.strongHistoryAt || []).filter(at => now - at < 24 * 60 * 60_000), now].slice(-1000)
        : (runtime.strongHistoryAt || []).filter(at => now - at < 24 * 60 * 60_000),
      routeStates,
      lastRouteId: finalResult?.routeSelection?.routeId || selectedRouteId,
      lastProvider: finalResult?.routeSelection?.provider || selectedRouteIdentity.provider,
      lastModel: finalResult?.routeSelection?.model || selectedRouteIdentity.model,
      lastEndpointId: finalResult?.routeSelection?.endpointId || selectedRouteIdentity.endpointId,
      lastFailoverChain: routeAttempts,
    };

    const usageParts = [primaryResult?.usage, strongResult?.usage].filter(Boolean);
    const usage = {
      inputTokens: usageParts.reduce((sum, item) => sum + Math.max(0, Number(item.inputTokens || 0)), 0),
      outputTokens: usageParts.reduce((sum, item) => sum + Math.max(0, Number(item.outputTokens || 0)), 0),
      totalTokens: usageParts.reduce((sum, item) => sum + Math.max(0, Number(item.totalTokens || 0)), 0),
      // Count actual provider attempts, including a failed primary followed by a
      // successful fallback. Provider-reported usage can omit failed attempts.
      modelCalls: callsUsed,
    };
    if (!usage.totalTokens) usage.totalTokens = usage.inputTokens + usage.outputTokens;

    return {
      ok: true,
      text: finalResult.text,
      usage,
      route: strongResult ? 'strong' : 'primary',
      trigger: trigger || (strongResult ? 'strong-only' : 'primary-only'),
      primary: primaryResult ? { provider: primaryResult.routeSelection?.provider || settings.primary.provider, model: primaryResult.routeSelection?.model || settings.primary.model, routeId:primaryResult.routeSelection?.routeId || '', text: primaryResult.text, usage: primaryResult.usage || null } : null,
      strong: strongResult ? { provider: strongResult.routeSelection?.provider || settings.strong.provider, model: strongResult.routeSelection?.model || settings.strong.model, routeId:strongResult.routeSelection?.routeId || '', text: strongResult.text, usage: strongResult.usage || null } : null,
      primaryError,
      strongError,
      routing: {
        selectedRouteId:finalResult?.routeSelection?.routeId || '',
        selectedProvider:finalResult?.routeSelection?.provider || selectedRouteIdentity.provider,
        selectedModel:finalResult?.routeSelection?.model || selectedRouteIdentity.model,
        selectedEndpointId:finalResult?.routeSelection?.endpointId || selectedRouteIdentity.endpointId,
        reason:finalResult?.routeSelection?.reason || (strongResult ? 'legacy-strong' : 'legacy-primary'),
        failoverChain:structuredClone(routeAttempts),
      },
      runtime: nextRuntime,
      ...(finalResult?.providerReservation
        ? { providerReservation: finalResult.providerReservation }
        : {}),
    };
  }
}

export { ESCALATION_MARKER, MAX_HANDOFF_CHARS };
