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

function exactIntegerText(value, label, { min, max }) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(label + ' має бути у канонічному форматі цілого числа.');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(label + ' має бути в дозволеному діапазоні.');
  }
  return number;
}

function optionalPriceText(value, label) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error(label + ' має бути канонічним числом або порожнім.');
  if (value === '') return null;
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) throw new Error(label + ' має бути канонічним невід’ємним числом.');
  const number = Number(value);
  if (!Number.isFinite(number) || Object.is(number, -0)) throw new Error(label + ' має бути скінченним невід’ємним числом.');
  return number;
}

function ownData(input, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return { present:false, value:undefined };
  if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(label + ' має бути enumerable data property.');
  }
  return { present:true, value:descriptor.value };
}

function routeIdsFromLines(value, label, { preserveOrder = false } = {}) {
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
  return preserveOrder ? values : values.sort((a,b)=>a<b?-1:a>b?1:0);
}

export function buildAgentDefinitionModelRoutePolicyFromFormV1(input = {}, { persistedPolicy = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Форма Agent model policy недоступна.');
  const configuredField = ownData(input, 'modelRoutePolicyConfigured', 'Model route policy configured');
  if (!configuredField.present) return copyStructuredData(persistedPolicy, 'modelRoutePolicy');
  if (typeof configuredField.value !== 'boolean') throw new Error('Model route policy configured має бути boolean.');
  if (!configuredField.value) return null;

  const read = (key, fallback) => {
    const field = ownData(input, key, key);
    return field.present ? field.value : fallback;
  };
  const pinned = read('modelRoutePinnedRouteId', '');
  const locality = read('modelRouteLocality', 'any');
  const autoSwitch = read('modelRouteAutoSwitch', true);
  const freeOnly = read('modelRouteFreeOnly', false);
  if (typeof autoSwitch !== 'boolean' || typeof freeOnly !== 'boolean') throw new Error('Model route boolean fields мають бути boolean.');
  if (typeof pinned !== 'string' || pinned !== pinned.trim()) throw new Error('Pinned model route ID має бути канонічним.');
  if (pinned) parseCanonicalAgentIdentity(pinned, 'Pinned model route ID');
  const policy = normalizeAiRoutePolicy({
    autoSwitch,
    pinnedRouteId: pinned,
    orderedRouteIds: routeIdsFromLines(read('modelRouteOrderedRouteIdsText', ''), 'Ordered model route ID', { preserveOrder:true }),
    allowRouteIds: routeIdsFromLines(read('modelRouteAllowRouteIdsText', ''), 'Allowed model route ID'),
    denyRouteIds: routeIdsFromLines(read('modelRouteDenyRouteIdsText', ''), 'Denied model route ID'),
    freeOnly,
    locality,
    maxInputPricePerMillionUsd: optionalPriceText(read('modelRouteMaxInputPriceText', ''), 'Максимальна input-ціна'),
    maxOutputPricePerMillionUsd: optionalPriceText(read('modelRouteMaxOutputPriceText', ''), 'Максимальна output-ціна'),
  });
  if (policy.allowRouteIds.length) {
    const allow = new Set(policy.allowRouteIds);
    for (const routeId of [...policy.orderedRouteIds, ...policy.denyRouteIds]) {
      if (!allow.has(routeId)) throw new Error('Model route ID поза allow scope: ' + routeId);
    }
    if (policy.pinnedRouteId && !allow.has(policy.pinnedRouteId)) throw new Error('Pinned model route ID поза allow scope: ' + policy.pinnedRouteId);
    const denied = new Set(policy.denyRouteIds);
    if (policy.allowRouteIds.every(routeId => denied.has(routeId))) throw new Error('Model Router policy deny scope перекриває весь allow scope.');
  }
  if (policy.pinnedRouteId && policy.denyRouteIds.includes(policy.pinnedRouteId)) throw new Error('Pinned model route ID одночасно заборонений deny policy.');
  return {
    autoSwitch: policy.autoSwitch,
    pinnedRouteId: policy.pinnedRouteId,
    orderedRouteIds:[...policy.orderedRouteIds],
    allowRouteIds:[...policy.allowRouteIds],
    denyRouteIds:[...policy.denyRouteIds],
    freeOnly:policy.freeOnly,
    locality:policy.locality,
    maxInputPricePerMillionUsd:policy.maxInputPricePerMillionUsd,
    maxOutputPricePerMillionUsd:policy.maxOutputPricePerMillionUsd,
  };
}

const AGENT_MODEL_ROUTING_MODES = new Set(['inherit', 'primary', 'strong', 'hybrid-auto', 'hybrid-rules']);
const AGENT_MODEL_PROVIDERS = new Set(['inherit', 'ollama', 'openai', 'openai-compatible']);

function optionalOwnModelDefaultText(input, key, label, max) {
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

  const routingMode = optionalOwnModelDefaultText(input, 'aiRoutingMode', 'AI routing mode', 40);
  if (routingMode.present) {
    if (!routingMode.value) delete out.aiRoutingMode;
    else if (!AGENT_MODEL_ROUTING_MODES.has(routingMode.value)) throw new Error('AI routing mode не підтримується.');
    else out.aiRoutingMode = routingMode.value;
  }

  const primaryProvider = optionalOwnModelDefaultText(input, 'aiPrimaryProvider', 'Primary provider', 40);
  if (primaryProvider.present) {
    if (!primaryProvider.value) delete out.aiPrimaryProvider;
    else if (!AGENT_MODEL_PROVIDERS.has(primaryProvider.value)) throw new Error('Primary provider не підтримується.');
    else out.aiPrimaryProvider = primaryProvider.value;
  }
  const primaryModel = optionalOwnModelDefaultText(input, 'aiPrimaryModel', 'Primary model', 300);
  if (primaryModel.present) {
    if (!primaryModel.value) delete out.aiPrimaryModel;
    else out.aiPrimaryModel = primaryModel.value;
  }

  const strongProvider = optionalOwnModelDefaultText(input, 'aiStrongProvider', 'Strong provider', 40);
  if (strongProvider.present) {
    if (!strongProvider.value) delete out.aiStrongProvider;
    else if (!AGENT_MODEL_PROVIDERS.has(strongProvider.value)) throw new Error('Strong provider не підтримується.');
    else out.aiStrongProvider = strongProvider.value;
  }
  const strongModel = optionalOwnModelDefaultText(input, 'aiStrongModel', 'Strong model', 300);
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

function copyStructuredData(value, label) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' має бути data object.');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(label + ' має бути data object.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(label + ' містить неканонічне поле.');
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + key + ' має бути enumerable data property.');
    }
  }
  return structuredClone(value);
}

export function buildAgentDefinitionFromFormV1(input = {}, {
  definitionRevision = 1,
  configDefaults = {},
  modelRoutePolicy = null,
  specialistDelegationProfile,
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
    if (effectiveModelRoutePolicy.pinnedRouteId
        && effectiveModelRoutePolicy.pinnedRouteId !== legacyPinnedRouteId) {
      throw new Error('Legacy pinned route конфліктує з Model Router policy pinned route.');
    }
    if (effectiveModelRoutePolicy.allowRouteIds.length
        && !effectiveModelRoutePolicy.allowRouteIds.includes(legacyPinnedRouteId)) {
      throw new Error('Legacy pinned route поза Model Router policy allow scope.');
    }
    if (effectiveModelRoutePolicy.denyRouteIds.includes(legacyPinnedRouteId)) {
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
    ...(specialistDelegationProfile === undefined
      ? {}
      : { specialistDelegationProfile: copyStructuredData(specialistDelegationProfile, 'specialistDelegationProfile') }),
    enabled: input.enabled === true,
    definitionRevision,
  };
}
