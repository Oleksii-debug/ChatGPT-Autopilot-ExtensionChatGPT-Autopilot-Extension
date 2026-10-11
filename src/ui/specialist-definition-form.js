const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const EXECUTION_PLANES = new Set(['BROWSER', 'LOCAL', 'CLOUD', 'REMOTE']);

function ownData(input, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(label + ' має бути enumerable data property.');
  }
  return descriptor.value;
}

function canonicalIdentity(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' має бути канонічним ID без пробілів.');
  }
  return value;
}

function exactText(value, label, max, { optional = false } = {}) {
  if (typeof value !== 'string') throw new Error(label + ' має бути текстом.');
  if (value === '' && optional) return '';
  if (!value || value !== value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(label + ' має бути канонічним текстом без пробілів на початку/в кінці.');
  }
  return value;
}

function identityLines(value, label, { minItems = 0, maxItems } = {}) {
  if (typeof value !== 'string') throw new Error(label + ' має бути текстом.');
  const values = [];
  const seen = new Set();
  for (const raw of value.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw === '') continue;
    const item = canonicalIdentity(raw, label);
    if (seen.has(item)) throw new Error(label + ' містить дублікат: ' + item);
    seen.add(item);
    values.push(item);
    if (values.length > maxItems) throw new Error(label + ' містить забагато значень.');
  }
  if (values.length < minItems) throw new Error(label + ' потребує щонайменше ' + minItems + ' значення.');
  return values.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function buildSpecialistDefinitionFromFormV1(input = {}, { definitionRevision = 1 } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Форма Specialist definition недоступна.');
  }
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error('Форма Specialist definition має бути data object.');
  }
  if (!Number.isSafeInteger(definitionRevision) || definitionRevision < 1 || Object.is(definitionRevision, -0)) {
    throw new Error('Definition revision має бути додатним цілим числом.');
  }

  const executionPlane = ownData(input, 'executionPlane', 'Execution plane');
  if (typeof executionPlane !== 'string' || !EXECUTION_PLANES.has(executionPlane)) {
    throw new Error('Execution plane не підтримується.');
  }

  const enabled = ownData(input, 'enabled', 'Enabled');
  if (typeof enabled !== 'boolean') throw new Error('Enabled має бути boolean.');

  return {
    schemaVersion: 1,
    specialistId: canonicalIdentity(ownData(input, 'specialistId', 'Specialist ID'), 'Specialist ID'),
    providerId: canonicalIdentity(ownData(input, 'providerId', 'Provider ID'), 'Provider ID'),
    label: exactText(ownData(input, 'label', 'Назва'), 'Назва', 300),
    description: exactText(ownData(input, 'description', 'Опис'), 'Опис', 4000, { optional: true }),
    executionPlane,
    capabilityIds: identityLines(ownData(input, 'capabilityIdsText', 'Capability IDs'), 'Capability ID', { minItems: 1, maxItems: 64 }),
    toolIds: identityLines(ownData(input, 'toolIdsText', 'Tool IDs'), 'Tool ID', { maxItems: 128 }),
    resultContractId: canonicalIdentity(ownData(input, 'resultContractId', 'Result contract ID'), 'Result contract ID'),
    enabled,
    definitionRevision,
  };
}
