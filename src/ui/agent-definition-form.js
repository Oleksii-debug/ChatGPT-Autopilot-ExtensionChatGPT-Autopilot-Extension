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
    configDefaults: mergeAgentDefinitionModelDefaultsV1(input, configDefaults),
    modelRoutePolicy: copyModelRoutePolicy(modelRoutePolicy),
    ...(specialistDelegationProfile === undefined
      ? {}
      : {
        specialistDelegationProfile: specialistDelegationProfile === null
          ? null
          : normalizeAgentSpecialistDelegationProfileV1(specialistDelegationProfile),
      }),
    enabled: input.enabled === true,
    definitionRevision,
  };
}
