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

export function buildAgentDefinitionFromFormV1(input = {}, {
  definitionRevision = 1,
  configDefaults = {},
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
    configDefaults: copyDataRecord(configDefaults, 'configDefaults'),
    enabled: input.enabled === true,
    definitionRevision,
  };
}
