import { normalizeTrustedSubagentTaskActivationBindingV1 } from './subagent-result-reconciliation.js';

export const SUBAGENT_TASK_ACTIVATION_BINDING_REGISTRY_VERSION = 1;
export const MAX_SUBAGENT_TASK_ACTIVATION_BINDINGS = 1024;
export const MAX_SUBAGENT_TASK_ACTIVATION_BINDINGS_PER_TASK = 32;

export const SUBAGENT_TASK_ACTIVATION_BINDING_REGISTRY_AUTHORITY = Object.freeze({
  appendOnlyBindingHistory: true,
  ownerStateProjectionOnly: true,
  persistenceAuthorized: false,
  executionAuthorized: false,
  schedulingAuthorized: false,
  completionAuthorized: false,
  verificationAuthorized: false,
  policyAuthorized: false,
  credentialAuthorized: false,
  recoveryAuthorized: false,
});

const REGISTRY_KEYS = new Set(['schemaVersion', 'revision', 'records']);
const RECORD_KEYS = new Set(['binding', 'registeredAt']);
const PUT_KEYS = new Set(['binding', 'registeredAt']);
const READ_KEYS = new Set(['bindingId']);
const ACTIVATION_READ_KEYS = new Set([
  'projectId',
  'childAgentId',
  'controlEpoch',
  'activationId',
  'generation',
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

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
  const seen = new Set();
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
    seen.add(key);
  }
  for (const key of allowed) {
    if (!seen.has(key)) throw new Error(label + ' is missing field: ' + key);
  }
  return out;
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(label + ' has invalid length');
  }
  const length = lengthDescriptor.value;
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.size || keys.some(key => typeof key !== 'string' || !expected.has(key))) {
    throw new Error(label + ' must be dense and data-only');
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '[' + index + '] must be an enumerable own data property');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function exactInteger(value, label, min = 0) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical timestamp');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(label + ' must be canonical ISO-8601 UTC');
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactBindingSignature(binding) {
  return JSON.stringify(binding);
}

function activationKey(binding) {
  return [
    binding.projectId,
    binding.childAgentId,
    binding.controlEpoch,
    binding.activationId,
    binding.generation,
  ].join('\u0000');
}

function invocationKey(binding) {
  return [binding.projectId, binding.childAgentId, binding.invocationId].join('\u0000');
}

function taskKey(binding) {
  return [binding.projectId, binding.parentAgentId, binding.childAgentId, binding.taskId].join('\u0000');
}

function normalizeStoredRecord(input, index) {
  const label = 'SubagentTaskActivationBindingRegistryRecordV1[' + index + ']';
  const raw = strictRecord(input, RECORD_KEYS, label);
  const binding = normalizeTrustedSubagentTaskActivationBindingV1(raw.binding);
  const registeredAt = exactTimestamp(raw.registeredAt, label + '.registeredAt');
  if (Date.parse(registeredAt) < Date.parse(binding.boundAt)) {
    throw new Error(label + ' registeredAt cannot predate binding.boundAt');
  }
  return deepFreeze({ binding, registeredAt });
}

export function createSubagentTaskActivationBindingRegistryV1() {
  return deepFreeze({
    schemaVersion: SUBAGENT_TASK_ACTIVATION_BINDING_REGISTRY_VERSION,
    revision: 0,
    records: [],
  });
}

export function normalizeSubagentTaskActivationBindingRegistryV1(input) {
  const raw = strictRecord(input, REGISTRY_KEYS, 'SubagentTaskActivationBindingRegistryV1');
  if (raw.schemaVersion !== SUBAGENT_TASK_ACTIVATION_BINDING_REGISTRY_VERSION) {
    throw new Error('Unsupported SubagentTaskActivationBindingRegistryV1 schemaVersion');
  }
  const records = denseArray(
    raw.records,
    'SubagentTaskActivationBindingRegistryV1.records',
    MAX_SUBAGENT_TASK_ACTIVATION_BINDINGS,
  ).map((item, index) => normalizeStoredRecord(item, index));
  const revision = exactInteger(raw.revision, 'SubagentTaskActivationBindingRegistryV1.revision');
  if (revision !== records.length) {
    throw new Error('SubagentTaskActivationBindingRegistryV1 revision must equal append-only record count');
  }

  const bindingIds = new Set();
  const activations = new Map();
  const invocations = new Map();
  const taskCounts = new Map();
  let previousRegisteredAt = -1;

  for (const record of records) {
    const { binding } = record;
    if (bindingIds.has(binding.bindingId)) {
      throw new Error(
        'SubagentTaskActivationBindingRegistryV1 contains duplicate bindingId: ' + binding.bindingId,
      );
    }
    bindingIds.add(binding.bindingId);

    const activation = activationKey(binding);
    const priorActivation = activations.get(activation);
    if (priorActivation && priorActivation !== binding.bindingId) {
      throw new Error(
        'SubagentTaskActivationBindingRegistryV1 activation is rebound to multiple task bindings',
      );
    }
    activations.set(activation, binding.bindingId);

    const invocation = invocationKey(binding);
    const priorInvocation = invocations.get(invocation);
    if (priorInvocation && priorInvocation !== binding.bindingId) {
      throw new Error(
        'SubagentTaskActivationBindingRegistryV1 invocationId is rebound to multiple activations or tasks',
      );
    }
    invocations.set(invocation, binding.bindingId);

    const task = taskKey(binding);
    const nextTaskCount = (taskCounts.get(task) || 0) + 1;
    if (nextTaskCount > MAX_SUBAGENT_TASK_ACTIVATION_BINDINGS_PER_TASK) {
      throw new Error('Subagent task activation binding history limit exceeded for task: ' + binding.taskId);
    }
    taskCounts.set(task, nextTaskCount);

    const registeredAtMs = Date.parse(record.registeredAt);
    if (registeredAtMs < previousRegisteredAt) {
      throw new Error('SubagentTaskActivationBindingRegistryV1 registeredAt chronology cannot regress');
    }
    previousRegisteredAt = registeredAtMs;
  }

  return deepFreeze({
    schemaVersion: SUBAGENT_TASK_ACTIVATION_BINDING_REGISTRY_VERSION,
    revision,
    records,
  });
}

export function putSubagentTaskActivationBindingV1(registryInput, input) {
  const registry = normalizeSubagentTaskActivationBindingRegistryV1(registryInput);
  const raw = strictRecord(input, PUT_KEYS, 'PutSubagentTaskActivationBindingV1 request');
  const binding = normalizeTrustedSubagentTaskActivationBindingV1(raw.binding);
  const registeredAt = exactTimestamp(raw.registeredAt, 'PutSubagentTaskActivationBindingV1 registeredAt');
  if (Date.parse(registeredAt) < Date.parse(binding.boundAt)) {
    throw new Error('Subagent task activation binding registration cannot predate boundAt');
  }

  const existingById = registry.records.find(record => record.binding.bindingId === binding.bindingId);
  if (existingById) {
    if (exactBindingSignature(existingById.binding) !== exactBindingSignature(binding)) {
      throw new Error('Divergent subagent task activation bindingId collision: ' + binding.bindingId);
    }
    return registry;
  }

  const sameActivation = registry.records.find(record => activationKey(record.binding) === activationKey(binding));
  if (sameActivation) {
    throw new Error(
      'Subagent activation cannot be rebound from '
        + sameActivation.binding.bindingId
        + ' to '
        + binding.bindingId,
    );
  }
  const sameInvocation = registry.records.find(record => invocationKey(record.binding) === invocationKey(binding));
  if (sameInvocation) {
    throw new Error(
      'Subagent invocationId cannot be rebound from '
        + sameInvocation.binding.bindingId
        + ' to '
        + binding.bindingId,
    );
  }

  if (registry.records.length >= MAX_SUBAGENT_TASK_ACTIVATION_BINDINGS) {
    throw new Error('Subagent task activation binding registry capacity exceeded');
  }
  const countForTask = registry.records.filter(record => taskKey(record.binding) === taskKey(binding)).length;
  if (countForTask >= MAX_SUBAGENT_TASK_ACTIVATION_BINDINGS_PER_TASK) {
    throw new Error('Subagent task activation binding history limit exceeded for task: ' + binding.taskId);
  }
  const last = registry.records.at(-1);
  if (last && Date.parse(registeredAt) < Date.parse(last.registeredAt)) {
    throw new Error('Subagent task activation binding registeredAt chronology cannot regress');
  }

  return deepFreeze({
    schemaVersion: SUBAGENT_TASK_ACTIVATION_BINDING_REGISTRY_VERSION,
    revision: registry.revision + 1,
    records: [...registry.records, deepFreeze({ binding, registeredAt })],
  });
}

export function resolveSubagentTaskActivationBindingV1(registryInput, input) {
  const registry = normalizeSubagentTaskActivationBindingRegistryV1(registryInput);
  const raw = strictRecord(input, READ_KEYS, 'ResolveSubagentTaskActivationBindingV1 request');
  const bindingId = exactId(raw.bindingId, 'ResolveSubagentTaskActivationBindingV1 bindingId');
  return registry.records.find(record => record.binding.bindingId === bindingId)?.binding ?? null;
}

export function resolveSubagentTaskActivationBindingForActivationV1(registryInput, input) {
  const registry = normalizeSubagentTaskActivationBindingRegistryV1(registryInput);
  const raw = strictRecord(
    input,
    ACTIVATION_READ_KEYS,
    'ResolveSubagentTaskActivationBindingForActivationV1 request',
  );
  const projectId = exactId(raw.projectId, 'ResolveSubagentTaskActivationBindingForActivationV1 projectId');
  const childAgentId = exactId(raw.childAgentId, 'ResolveSubagentTaskActivationBindingForActivationV1 childAgentId');
  const controlEpoch = exactInteger(
    raw.controlEpoch,
    'ResolveSubagentTaskActivationBindingForActivationV1 controlEpoch',
    1,
  );
  const activationId = exactId(raw.activationId, 'ResolveSubagentTaskActivationBindingForActivationV1 activationId');
  const generation = exactInteger(
    raw.generation,
    'ResolveSubagentTaskActivationBindingForActivationV1 generation',
    1,
  );

  const match = registry.records.find(record => {
    const binding = record.binding;
    return binding.projectId === projectId
      && binding.childAgentId === childAgentId
      && binding.controlEpoch === controlEpoch
      && binding.activationId === activationId
      && binding.generation === generation;
  });
  return match?.binding ?? null;
}
