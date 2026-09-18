import { DEFAULT_GATEWAY_URL, normalizeGatewayUrl } from './ai-gateway-client.js';

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
});

const clean = value => typeof value === 'string' ? value.trim() : '';

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
  };
}

export function validateAiRouterReadiness(rawSettings = {}) {
  const settings = normalizeAiRouterSettings(rawSettings);
  if (!settings.enabled) return settings;

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
  return {
    requestCount: Math.floor(num(raw.requestCount)),
    primaryCount: Math.floor(num(raw.primaryCount)),
    startedAt: num(raw.startedAt),
    strongCount: Math.floor(num(raw.strongCount)),
    lastStrongAt: num(raw.lastStrongAt),
    lastRoute: clean(raw.lastRoute),
    lastStrongResult: clean(raw.lastStrongResult).slice(0, MAX_HANDOFF_CHARS),
    strongHistoryAt: Array.isArray(raw.strongHistoryAt) ? raw.strongHistoryAt.map(num).filter(Boolean).slice(-1000) : [],
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
  constructor({ gatewayClient, now = () => Date.now() } = {}) {
    if (!gatewayClient) throw new Error('AI Gateway client is required');
    this.gateway = gatewayClient;
    this.now = now;
  }

  async run(rawSettings, rawRuntime, prompt, { systemPrompt = '', forceStrong = false, maxOutputTokens = 0, maxModelCallsForRequest = 0, imageDataUrl = '' } = {}) {
    const settings = normalizeAiRouterSettings(rawSettings);
    const runtime = normalizeAiRouterRuntime(rawRuntime);
    if (!settings.enabled) throw new Error('AI coordinator is disabled');
    const userPrompt = clean(prompt);
    if (!userPrompt) throw new Error('AI coordinator prompt is empty');
    const now = this.now();

    const outputCeiling = Math.max(0, Math.floor(Number(maxOutputTokens) || 0));
    const callCeiling = Math.max(0, Math.floor(Number(maxModelCallsForRequest) || 0));
    let callsUsed = 0;
    const consumedOutput = () => Math.max(0, Number(primaryResult?.usage?.outputTokens || 0)) + Math.max(0, Number(strongResult?.usage?.outputTokens || 0));
    const remainingOutput = () => outputCeiling ? Math.max(0, outputCeiling - consumedOutput()) : 0;
    const call = async (slot, callPrompt, callSystem, callOutputLimit = 0) => {
      requireConfigured(slot, slot === settings.strong ? 'Strong' : 'Primary');
      if (callCeiling && callsUsed >= callCeiling) {
        const error = new Error('AI model-call budget exhausted before another provider call');
        error.code = 'AI_MODEL_CALL_BUDGET_EXHAUSTED';
        error.modelCallsUsed = callsUsed;
        throw error;
      }
      const bounded = Math.max(0, Math.floor(Number(callOutputLimit) || 0));
      callsUsed += 1;
      try {
        return await this.gateway.complete({
        gatewayUrl: settings.gatewayUrl,
        timeoutSeconds: settings.timeoutSeconds,
        provider: slot.provider,
        model: slot.model,
        prompt: callPrompt,
        systemPrompt: callSystem,
        ...(bounded ? { maxOutputTokens: bounded } : {}),
          ...(clean(imageDataUrl) ? { imageDataUrl: clean(imageDataUrl) } : {}),
        });
      } catch (error) {
        if (error && typeof error === 'object') {
          error.modelCallsUsed = Math.max(Number(error.modelCallsUsed || 0), callsUsed);
        }
        throw error;
      }
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
        const value = await call(settings.strong, callPrompt, callSystem, strongLimit);
        trigger = why;
        return value;
      } catch (error) {
        strongError = clean(error?.message || error);
        throw error;
      }
    };

    if (forceStrong || settings.mode === AiRouterMode.STRONG) {
      trigger = forceStrong ? 'manual-force-strong' : 'strong-only';
      strongResult = await call(settings.strong, userPrompt, clean(systemPrompt), outputCeiling);
    } else if (settings.mode === AiRouterMode.PRIMARY) {
      try {
        primaryResult = await call(settings.primary, userPrompt, `${clean(systemPrompt)}${previousStrongContext(settings, runtime)}`.trim(), outputCeiling);
      } catch (error) {
        primaryError = clean(error?.message || error);
        if (!settings.fallbackToStrongOnPrimaryError || !settings.strong.model) throw error;
        strongResult = await tryStrong(
          `PRIMARY MODEL FAILED. Continue the original task directly.

PRIMARY ERROR:
${primaryError}

ORIGINAL TASK:
${userPrompt}`,
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
        if (!settings.fallbackToStrongOnPrimaryError || !settings.strong.model) throw error;
        strongResult = await tryStrong(
          `PRIMARY/LOCAL MODEL FAILED BEFORE PRODUCING A HANDOFF. Complete the original task.

PRIMARY ERROR:
${primaryError}

ORIGINAL TASK:
${userPrompt}`,
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
      primary: primaryResult ? { provider: settings.primary.provider, model: settings.primary.model, text: primaryResult.text, usage: primaryResult.usage || null } : null,
      strong: strongResult ? { provider: settings.strong.provider, model: settings.strong.model, text: strongResult.text, usage: strongResult.usage || null } : null,
      primaryError,
      strongError,
      runtime: nextRuntime,
    };
  }
}

export { ESCALATION_MARKER, MAX_HANDOFF_CHARS };
