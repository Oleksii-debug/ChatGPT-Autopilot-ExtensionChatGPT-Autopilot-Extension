import { normalizeAiRoutePolicy } from '../core/ai-route-pool.js';
import { normalizeAgentSpecialistDelegationProfileV1 } from '../core/agent-specialist-delegation-profile.js';
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



const MODEL_DEFAULT_FIELDS = Object.freeze([
  'aiRoutingMode', 'aiPinnedRouteId', 'aiPrimaryProvider',
  'aiPrimaryModel', 'aiStrongProvider', 'aiStrongModel',
]);
const MODEL_ROUTING_MODES = new Set(['auto', 'primary', 'strong', 'hybrid-rules', 'hybrid-auto', 'inherit']);
export function mergeAgentDefinitionModelDefaultsV1(input = {}, persisted = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new Error('Agent model defaults input має бути data object.');
  }
  const result = copyDataRecord(persisted, 'configDefaults');
  for (const key of MODEL_DEFAULT_FIELDS) {
    const field = ownData(input, key, key);
    if (!field.present) continue;
    const value = field.value;
    if (typeof value !== 'string') throw new Error(key + ' має бути канонічним текстом.');
    if (value === '') {
      delete result[key];
      continue;
    }
    if (value !== value.trim() || value.includes('\0')
        || value.length > (key.endsWith('Model') ? 300 : 180)) {
      throw new Error(key + ' має бути канонічним текстом.');
    }
    if (key === 'aiRoutingMode' && !MODEL_ROUTING_MODES.has(value)) {
      throw new Error('AI routing mode не підтримується.');
    }
    if (key === 'aiPinnedRouteId') parseCanonicalAgentIdentity(value, key);
    if (key.endsWith('Provider') && value !== 'inherit') {
      parseCanonicalAgentIdentity(value, key);
    }
    result[key] = value;
  }
  for (const [provider, model, label] of [
    ['aiPrimaryProvider', 'aiPrimaryModel', 'Primary'],
    ['aiStrongProvider', 'aiStrongModel', 'Strong'],
  ]) {
    if (Object.hasOwn(result, provider) && result[provider] !== 'inherit'
        && !Object.hasOwn(result, model)) {
      throw new Error(label + ' provider override вимагає model ID.');
    }
  }
  return result;
}


function resolveSpecialistDelegationFromFormV1(input, persisted) {
  const configured = ownData(input, 'specialistDelegationConfigured', 'Specialist delegation configured');
  if (!configured.present) {
    return persisted === undefined ? undefined
      : persisted === null ? null : normalizeAgentSpecialistDelegationProfileV1(persisted);
  }
  if (typeof configured.value !== 'boolean') {
    throw new Error('Specialist delegation configured має бути boolean.');
  }
  if (configured.value === false) return persisted === undefined ? undefined : null;
  const field = (key) => ownData(input, key, key);
  const enabled = field('specialistDelegationEnabled');
  if (!enabled.present || typeof enabled.value !== 'boolean') {
    throw new Error('Specialist delegation enabled має бути boolean.');
  }
  const get = key => field(key).value;
  return normalizeAgentSpecialistDelegationProfileV1({
    schemaVersion: 1,
    registryId: parseCanonicalAgentIdentity(get('specialistRegistryId'), 'Specialist registry ID'),
    requiredCapabilityIds: listFromLines(get('specialistCapabilityIdsText'), 'Specialist capability ID', { maxItems:64, itemMax:180, identity:true }),
    requiredToolIds: listFromLines(get('specialistToolIdsText'), 'Specialist tool ID', { maxItems:128, itemMax:180, identity:true }),
    policyEnvelopeId: parseCanonicalAgentIdentity(get('specialistPolicyEnvelopeId'), 'Specialist policy envelope ID'),
    deadlineSeconds: exactIntegerText(get('specialistDeadlineSeconds'), 'Specialist deadline', { min:1, max:31536000 }),
    maxConcurrentHandoffs: exactIntegerText(get('specialistMaxConcurrentHandoffs'), 'Specialist concurrency', { min:0, max:256 }),
    leaseSeconds: exactIntegerText(get('specialistLeaseSeconds'), 'Specialist lease', { min:1, max:86400 }),
    priority: exactIntegerText(get('specialistPriority'), 'Specialist priority', { min:0, max:1000000 }),
    enabled: enabled.value,
  });
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
  const enabled = ownData(input, 'enabled', 'Agent definition enabled');
  if (enabled.present && typeof enabled.value !== 'boolean') throw new Error('Agent definition enabled має бути boolean.');
  const resolvedSpecialist = resolveSpecialistDelegationFromFormV1(input, specialistDelegationProfile);
  const effectiveConfigDefaults = mergeAgentDefinitionModelDefaultsV1(input, configDefaults);
  const effectiveModelRoutePolicy = buildAgentDefinitionModelRoutePolicyFromFormV1(input, {
    persistedPolicy: copyModelRoutePolicy(modelRoutePolicy),
  });
  const legacyPin = effectiveConfigDefaults.aiPinnedRouteId || '';
  if (legacyPin && effectiveModelRoutePolicy) {
    if (effectiveModelRoutePolicy.pinnedRouteId && effectiveModelRoutePolicy.pinnedRouteId !== legacyPin) {
      throw new Error('Legacy pinned route конфліктує з Model Router policy pinned route.');
    }
    if (effectiveModelRoutePolicy.allowRouteIds?.length && !effectiveModelRoutePolicy.allowRouteIds.includes(legacyPin)) {
      throw new Error('Legacy pinned route поза Model Router policy allow scope.');
    }
    if (effectiveModelRoutePolicy.denyRouteIds?.includes(legacyPin)) {
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
    ...(resolvedSpecialist === undefined ? {} : { specialistDelegationProfile: resolvedSpecialist }),
    enabled: enabled.value === true,
    definitionRevision,
  };
}
