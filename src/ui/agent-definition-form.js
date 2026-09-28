import { normalizeAgentSpecialistDelegationProfileV1 } from '../core/agent-specialist-delegation-profile.js';
import { normalizeAiRoutePolicy } from '../core/ai-route-pool.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function exactText(value, label, max, { optional = false } = {}) {
  if (typeof value !== 'string') throw new Error(label + ' має бути текстом.');
  if (value === '' && optional) return '';
  if (!value || value !== value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(label + ' має бути заповненим без пробілів на початку/в кінці.');
  }
  return value;
}

export function parseCanonicalAgentIdentity(value, label = 'ID') {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' має бути канонічним ID без пробілів.');
  }
  return value;
}

function listFromLines(value, label, { maxItems, itemMax, identity = false } = {}) {
  if (typeof value !== 'string') throw new Error(label + ' має бути текстом.');
  const values = [];
  const seen = new Set();
  for (const raw of value.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw === '') continue;
    const item = identity
      ? parseCanonicalAgentIdentity(raw, label)
      : exactText(raw, label, itemMax);
    if (seen.has(item)) throw new Error(label + ' містить дублікат: ' + item);
    seen.add(item);
    values.push(item);
    if (values.length > maxItems) throw new Error(label + ' містить забагато значень.');
  }
  return identity ? values.sort((a,b)=>a<b?-1:a>b?1:0) : values;
}

function copyDataRecord(value, label) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' має бути data object.');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(label + ' має бути data object.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(label + ' містить неканонічне поле.');
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + key + ' має бути enumerable data property.');
    }
    const item = descriptor.value;
    if (!['string','number','boolean'].includes(typeof item)
        || (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item,-0)))) {
      throw new Error(label + '.' + key + ' має бути scalar data value.');
    }
    out[key] = item;
  }
  return out;
}


const AGENT_MODEL_ROUTING_MODES = new Set(['inherit', 'primary', 'strong', 'hybrid-auto', 'hybrid-rules']);
const AGENT_MODEL_PROVIDERS = new Set(['inherit', 'ollama', 'openai', 'openai-compatible']);

function optionalOwnFormText(input, key, label, max) {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return { present: false, value: '' };
  if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(label + ' має бути enumerable data property.');
  }
  const value = descriptor.value;
  if (typeof value !== 'string') throw new Error(label + ' має бути текстом.');
  if (value !== value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(label + ' має бути канонічним текстом без пробілів на початку/в кінці.');
  }
  return { present: true, value };
}

export function mergeAgentDefinitionModelDefaultsV1(input = {}, configDefaults = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Форма model defaults недоступна.');
  }
  const out = copyDataRecord(configDefaults, 'configDefaults');

  const routingMode = optionalOwnFormText(input, 'aiRoutingMode', 'AI routing mode', 40);
  if (routingMode.present) {
    if (!routingMode.value) delete out.aiRoutingMode;
    else if (!AGENT_MODEL_ROUTING_MODES.has(routingMode.value)) throw new Error('AI routing mode не підтримується.');
    else out.aiRoutingMode = routingMode.value;
  }

  const pinnedRouteId = optionalOwnFormText(input, 'aiPinnedRouteId', 'Pinned route ID', 180);
  if (pinnedRouteId.present) {
    if (!pinnedRouteId.value) delete out.aiPinnedRouteId;
    else out.aiPinnedRouteId = parseCanonicalAgentIdentity(pinnedRouteId.value, 'Pinned route ID');
  }

  const primaryProvider = optionalOwnFormText(input, 'aiPrimaryProvider', 'Primary provider', 40);
  if (primaryProvider.present) {
    if (!primaryProvider.value) delete out.aiPrimaryProvider;
    else if (!AGENT_MODEL_PROVIDERS.has(primaryProvider.value)) throw new Error('Primary provider не підтримується.');
    else out.aiPrimaryProvider = primaryProvider.value;
  }
  const primaryModel = optionalOwnFormText(input, 'aiPrimaryModel', 'Primary model', 300);
  if (primaryModel.present) {
    if (!primaryModel.value) delete out.aiPrimaryModel;
    else out.aiPrimaryModel = primaryModel.value;
  }

  const strongProvider = optionalOwnFormText(input, 'aiStrongProvider', 'Strong provider', 40);
  if (strongProvider.present) {
    if (!strongProvider.value) delete out.aiStrongProvider;
    else if (!AGENT_MODEL_PROVIDERS.has(strongProvider.value)) throw new Error('Strong provider не підтримується.');
    else out.aiStrongProvider = strongProvider.value;
  }
  const strongModel = optionalOwnFormText(input, 'aiStrongModel', 'Strong model', 300);
  if (strongModel.present) {
    if (!strongModel.value) delete out.aiStrongModel;
    else out.aiStrongModel = strongModel.value;
  }

  if (out.aiPrimaryProvider && out.aiPrimaryProvider !== 'inherit' && !out.aiPrimaryModel) {
    throw new Error('Primary provider override потребує explicit Primary model.');
  }
  if (out.aiStrongProvider && out.aiStrongProvider !== 'inherit' && !out.aiStrongModel) {
    throw new Error('Strong provider override потребує explicit Strong model.');
  }
  return out;
}

function exactIntegerText(value, label, { min, max }) {
  if (typeof value !== 'string' || value !== value.trim() || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(label + ' має бути цілим числом у канонічному форматі.');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(label + ' поза допустимим діапазоном.');
  }
  return number;
}

export function buildAgentSpecialistDelegationProfileFromFormV1(input = {}, {
  persistedProfile = undefined,
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Форма Specialist delegation недоступна.');
  }
  const configured = input.specialistDelegationConfigured === true;
  if (!configured) {
    return persistedProfile === undefined ? undefined : null;
  }
  const profile = normalizeAgentSpecialistDelegationProfileV1({
    schemaVersion: 1,
    registryId: parseCanonicalAgentIdentity(
      input.specialistRegistryId,
      'Specialist registry ID',
    ),
    requiredCapabilityIds: listFromLines(
      input.specialistCapabilityIdsText ?? '',
      'Specialist capability ID',
      { maxItems: 64, itemMax: 180, identity: true },
    ),
    requiredToolIds: listFromLines(
      input.specialistToolIdsText ?? '',
      'Specialist tool ID',
      { maxItems: 128, itemMax: 180, identity: true },
    ),
    policyEnvelopeId: parseCanonicalAgentIdentity(
      input.specialistPolicyEnvelopeId,
      'Policy envelope ID',
    ),
    deadlineSeconds: exactIntegerText(
      input.specialistDeadlineSeconds,
      'Specialist deadline',
      { min: 1, max: 31_536_000 },
    ),
    maxConcurrentHandoffs: exactIntegerText(
      input.specialistMaxConcurrentHandoffs,
      'Specialist concurrency',
      { min: 0, max: 256 },
    ),
    leaseSeconds: exactIntegerText(
      input.specialistLeaseSeconds,
      'Specialist lease',
      { min: 1, max: 86_400 },
    ),
    priority: exactIntegerText(
      input.specialistPriority,
      'Specialist priority',
      { min: 0, max: 1_000_000 },
    ),
    enabled: input.specialistDelegationEnabled === true,
  });
  return profile;
}

function modelRouteIdListFromLines(value, label) {
  if (typeof value !== 'string') throw new Error(label + ' має бути текстом.');
  const values = [];
  const seen = new Set();
  for (const raw of value.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw === '') continue;
    const item = parseCanonicalAgentIdentity(raw, label);
    if (seen.has(item)) throw new Error(label + ' містить дублікат: ' + item);
    seen.add(item);
    values.push(item);
    if (values.length > 32) throw new Error(label + ' містить забагато значень.');
  }
  return values;
}

function optionalOwnModelPolicyFormValue(input, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return { present: false, value: undefined };
  if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(label + ' має бути enumerable data property.');
  }
  return { present: true, value: descriptor.value };
}

function modelPolicyFormValue(input, key, label, fallback) {
  const field = optionalOwnModelPolicyFormValue(input, key, label);
  return field.present ? field.value : fallback;
}

function exactModelPolicyBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' має бути boolean.');
  return value;
}

function optionalPolicyPriceText(value, label) {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error(label + ' має бути канонічним числом або порожнім.');
  }
  if (value === '') return null;
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) {
    throw new Error(label + ' має бути канонічним невід’ємним числом.');
  }
  const number = Number(value);
  if (!Number.isFinite(number) || Object.is(number, -0)) {
    throw new Error(label + ' має бути скінченним невід’ємним числом.');
  }
  return number;
}

export function buildAgentDefinitionModelRoutePolicyFromFormV1(input = {}, {
  persistedPolicy = null,
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Форма Agent model policy недоступна.');
  }
  const configuredField = optionalOwnModelPolicyFormValue(
    input,
    'modelRoutePolicyConfigured',
    'Model route policy configured',
  );
  if (!configuredField.present) return copyModelRoutePolicy(persistedPolicy);
  const configured = exactModelPolicyBoolean(
    configuredField.value,
    'Model route policy configured',
  );
  if (!configured) return null;

  const pinnedRouteId = exactText(
    modelPolicyFormValue(input, 'modelRoutePinnedRouteId', 'Pinned model route ID', ''),
    'Pinned model route ID',
    180,
    { optional: true },
  );
  const locality = exactText(
    modelPolicyFormValue(input, 'modelRouteLocality', 'Model route locality', 'any'),
    'Model route locality',
    20,
  );
  const policy = normalizeAiRoutePolicy({
    autoSwitch: exactModelPolicyBoolean(
      modelPolicyFormValue(input, 'modelRouteAutoSwitch', 'Model route auto switch', true),
      'Model route auto switch',
    ),
    pinnedRouteId: pinnedRouteId
      ? parseCanonicalAgentIdentity(pinnedRouteId, 'Pinned model route ID')
      : '',
    orderedRouteIds: modelRouteIdListFromLines(
      modelPolicyFormValue(input, 'modelRouteOrderedRouteIdsText', 'Ordered model route IDs', ''),
      'Ordered model route ID',
    ),
    allowRouteIds: modelRouteIdListFromLines(
      modelPolicyFormValue(input, 'modelRouteAllowRouteIdsText', 'Allowed model route IDs', ''),
      'Allowed model route ID',
    ),
    denyRouteIds: modelRouteIdListFromLines(
      modelPolicyFormValue(input, 'modelRouteDenyRouteIdsText', 'Denied model route IDs', ''),
      'Denied model route ID',
    ),
    freeOnly: exactModelPolicyBoolean(
      modelPolicyFormValue(input, 'modelRouteFreeOnly', 'Model route free only', false),
      'Model route free only',
    ),
    locality,
    maxInputPricePerMillionUsd: optionalPolicyPriceText(
      modelPolicyFormValue(input, 'modelRouteMaxInputPriceText', 'Максимальна input-ціна', ''),
      'Максимальна input-ціна',
    ),
    maxOutputPricePerMillionUsd: optionalPolicyPriceText(
      modelPolicyFormValue(input, 'modelRouteMaxOutputPriceText', 'Максимальна output-ціна', ''),
      'Максимальна output-ціна',
    ),
    retryBackoffSeconds: exactIntegerText(
      modelPolicyFormValue(input, 'modelRouteRetryBackoffSeconds', 'Model route retry backoff', ''),
      'Model route retry backoff',
      { min: 1, max: 86_400 },
    ),
    circuitBreakerFailures: exactIntegerText(
      modelPolicyFormValue(input, 'modelRouteCircuitBreakerFailures', 'Model route circuit breaker failures', ''),
      'Model route circuit breaker failures',
      { min: 1, max: 100 },
    ),
    circuitBreakerSeconds: exactIntegerText(
      modelPolicyFormValue(input, 'modelRouteCircuitBreakerSeconds', 'Model route circuit breaker duration', ''),
      'Model route circuit breaker duration',
      { min: 1, max: 86_400 },
    ),
  });
  if (policy.allowRouteIds.length) {
    const allow = new Set(policy.allowRouteIds);
    for (const [label, routeIds] of [
      ['Ordered model route ID', policy.orderedRouteIds],
      ['Denied model route ID', policy.denyRouteIds],
    ]) {
      const outside = routeIds.find(routeId => !allow.has(routeId));
      if (outside) throw new Error(label + ' поза allow scope: ' + outside);
    }
    if (policy.pinnedRouteId && !allow.has(policy.pinnedRouteId)) {
      throw new Error('Pinned model route ID поза allow scope: ' + policy.pinnedRouteId);
    }
  }
  if (policy.pinnedRouteId && policy.denyRouteIds.includes(policy.pinnedRouteId)) {
    throw new Error('Pinned model route ID одночасно заборонений deny policy.');
  }

  return {
    autoSwitch: policy.autoSwitch,
    pinnedRouteId: policy.pinnedRouteId,
    orderedRouteIds: [...policy.orderedRouteIds],
    allowRouteIds: [...policy.allowRouteIds],
    denyRouteIds: [...policy.denyRouteIds],
    freeOnly: policy.freeOnly,
    locality: policy.locality,
    maxInputPricePerMillionUsd: policy.maxInputPricePerMillionUsd,
    maxOutputPricePerMillionUsd: policy.maxOutputPricePerMillionUsd,
    retryBackoffSeconds: policy.retryBackoffSeconds,
    circuitBreakerFailures: policy.circuitBreakerFailures,
    circuitBreakerSeconds: policy.circuitBreakerSeconds,
  };
}

function copyModelRoutePolicy(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('modelRoutePolicy має бути data object.');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error('modelRoutePolicy має бути data object.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error('modelRoutePolicy містить неканонічне поле.');
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('modelRoutePolicy.' + key + ' має бути enumerable data property.');
    }
    const item = descriptor.value;
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) throw new Error('modelRoutePolicy.' + key + ' має бути canonical array.');
      const arrayDescriptors = Object.getOwnPropertyDescriptors(item);
      const length = arrayDescriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 32) throw new Error('modelRoutePolicy.' + key + ' має некоректну довжину.');
      const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
      if (Reflect.ownKeys(arrayDescriptors).some(arrayKey => typeof arrayKey !== 'string' || !expected.has(arrayKey))) {
        throw new Error('modelRoutePolicy.' + key + ' має бути dense data array.');
      }
      out[key] = Array.from({ length }, (_, index) => {
        const entry = arrayDescriptors[String(index)];
        if (!entry || entry.enumerable !== true || !Object.hasOwn(entry, 'value') || typeof entry.value !== 'string') {
          throw new Error('modelRoutePolicy.' + key + ' має містити лише text data values.');
        }
        return entry.value;
      });
      continue;
    }
    if (item === null || ['string','number','boolean'].includes(typeof item)) {
      if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item,-0))) {
        throw new Error('modelRoutePolicy.' + key + ' має бути exact data value.');
      }
      out[key] = item;
      continue;
    }
    throw new Error('modelRoutePolicy.' + key + ' має бути scalar або array data value.');
  }
  return out;
}

export function buildAgentDefinitionFromFormV1(input = {}, {
  definitionRevision = 1,
  configDefaults = {},
  modelRoutePolicy = null,
  specialistDelegationProfile = undefined,
} = {}) {
  if (!Number.isSafeInteger(definitionRevision) || definitionRevision < 1 || Object.is(definitionRevision,-0)) {
    throw new Error('Definition revision має бути додатним цілим числом.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Форма Agent definition недоступна.');
  const effectiveConfigDefaults = mergeAgentDefinitionModelDefaultsV1(input, configDefaults);
  const effectiveModelRoutePolicy = buildAgentDefinitionModelRoutePolicyFromFormV1(input, {
    persistedPolicy: modelRoutePolicy,
  });
  const legacyPinnedRouteId = effectiveConfigDefaults.aiPinnedRouteId || '';
  if (effectiveModelRoutePolicy && legacyPinnedRouteId) {
    const policyPinnedRouteId = effectiveModelRoutePolicy.pinnedRouteId || '';
    const policyAllowRouteIds = Array.isArray(effectiveModelRoutePolicy.allowRouteIds)
      ? effectiveModelRoutePolicy.allowRouteIds
      : [];
    const policyDenyRouteIds = Array.isArray(effectiveModelRoutePolicy.denyRouteIds)
      ? effectiveModelRoutePolicy.denyRouteIds
      : [];
    if (policyPinnedRouteId && policyPinnedRouteId !== legacyPinnedRouteId) {
      throw new Error('Legacy pinned route конфліктує з Model Router policy pinned route.');
    }
    if (policyAllowRouteIds.length && !policyAllowRouteIds.includes(legacyPinnedRouteId)) {
      throw new Error('Legacy pinned route поза Model Router policy allow scope.');
    }
    if (policyDenyRouteIds.includes(legacyPinnedRouteId)) {
      throw new Error('Legacy pinned route заборонений Model Router policy deny scope.');
    }
  }
  return {
    schemaVersion: 1,
    agentDefinitionId: parseCanonicalAgentIdentity(input.agentDefinitionId, 'Agent definition ID'),
    label: exactText(input.label, 'Назва', 160),
    description: exactText(input.description ?? '', 'Опис', 4000, { optional: true }),
    instructions: exactText(input.instructions, 'Інструкції', 12000),
    capabilityIds: listFromLines(input.capabilityIdsText ?? '', 'Capability ID', { maxItems:64, itemMax:180, identity:true }),
    toolIds: listFromLines(input.toolIdsText ?? '', 'Tool ID', { maxItems:128, itemMax:180, identity:true }),
    tags: listFromLines(input.tagsText ?? '', 'Тег', { maxItems:32, itemMax:180, identity:true }),
    acceptanceCriteria: listFromLines(input.acceptanceCriteriaText ?? '', 'Критерій завершення', { maxItems:20, itemMax:1000 }),
    configDefaults: effectiveConfigDefaults,
    modelRoutePolicy: effectiveModelRoutePolicy,
    ...(() => {
      const effectiveProfile = Object.hasOwn(input, 'specialistDelegationConfigured')
        ? buildAgentSpecialistDelegationProfileFromFormV1(input, {
          persistedProfile: specialistDelegationProfile,
        })
        : specialistDelegationProfile === undefined || specialistDelegationProfile === null
          ? specialistDelegationProfile
          : normalizeAgentSpecialistDelegationProfileV1(specialistDelegationProfile);
      return effectiveProfile === undefined
        ? {}
        : { specialistDelegationProfile: effectiveProfile };
    })(),
    enabled: input.enabled === true,
    definitionRevision,
  };
}
