import {
  ExactEffectPhase,
  normalizeExactEffectStateV1,
} from './universal-agent-exact-effect.js';

export const CrossAppTransactionContractVersion = 1;

export const CrossAppTransactionProjectionStatus = Object.freeze({
  READY: 'READY',
  ACTIVE: 'ACTIVE',
  ATTENTION: 'ATTENTION',
  BLOCKED: 'BLOCKED',
  COMPLETE: 'COMPLETE',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_LABEL = 2_000;
const MAX_STEPS = 128;
const MAX_JSON_DEPTH = 64;

const TRANSACTION_KEYS = new Set([
  'schemaVersion', 'transactionId', 'projectId', 'label', 'createdAt', 'steps',
]);
const STEP_KEYS = new Set([
  'stepId', 'providerId', 'invocationId', 'invocationSha256', 'dependsOnStepIds',
  'compensationInvocationId', 'compensationInvocationSha256',
]);
const INVOCATION_KEYS = new Set([
  'schemaVersion', 'invocationId', 'toolId', 'providerId', 'requestedCapabilityIds',
  'policyDecisionId', 'arguments', 'createdAt', 'parentInvocationId',
]);

function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
  }
  for (const key of allowed) {
    if (key in value && !Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label} contains inherited field: ${key}`);
    }
  }
  return value;
}

function denseArray(value, label, max = MAX_STEPS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains an invalid array property`);
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
      throw new Error(`${label} contains an invalid array index`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error(`${label} must not be sparse`);
    }
  }
  return value;
}

function version(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value !== CrossAppTransactionContractVersion) {
    throw new Error(`Unsupported ${label} schemaVersion`);
  }
  return value;
}

function id(value, label, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function labelText(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > MAX_LABEL) {
    throw new Error('label is invalid');
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${label} must be a timestamp`);
  return new Date(millis).toISOString();
}

function idList(value, label) {
  const input = denseArray(value ?? [], label, MAX_STEPS);
  const output = input.map((item, index) => id(item, `${label}[${index}]`));
  if (new Set(output).size !== output.length) throw new Error(`${label} contains duplicates`);
  return output.sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)));
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) frozen(value[key]);
  return Object.freeze(value);
}

function canonicalJson(value, label, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw new Error(`${label} is too deeply nested`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    const items = denseArray(value, label, 4096);
    return items.map((item, index) => canonicalJson(item, `${label}[${index}]`, depth + 1));
  }
  if (!value || typeof value !== 'object') throw new Error(`${label} must contain JSON data only`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must contain plain JSON objects only`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 4096) throw new Error(`${label} contains too many fields`);
  const output = Object.create(null);
  for (const key of keys.sort((a, b) => (String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0)))) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol data`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    output[key] = canonicalJson(descriptor.value, `${label}.${key}`, depth + 1);
  }
  return output;
}

function normalizeInvocationForFingerprint(input) {
  const raw = record(input, INVOCATION_KEYS, 'ToolInvocationV1');
  version(raw.schemaVersion, 'ToolInvocationV1');
  const requestedCapabilityIds = idList(raw.requestedCapabilityIds, 'requestedCapabilityIds');
  if (requestedCapabilityIds.length === 0) throw new Error('requestedCapabilityIds must not be empty');
  return frozen({
    schemaVersion: CrossAppTransactionContractVersion,
    invocationId: id(raw.invocationId, 'invocationId'),
    toolId: id(raw.toolId, 'toolId'),
    providerId: id(raw.providerId, 'providerId'),
    requestedCapabilityIds,
    policyDecisionId: id(raw.policyDecisionId, 'policyDecisionId'),
    arguments: canonicalJson(raw.arguments, 'arguments'),
    createdAt: timestamp(raw.createdAt, 'createdAt'),
    parentInvocationId: id(raw.parentInvocationId, 'parentInvocationId', { optional: true }),
  });
}

function normalizeStep(input) {
  const raw = record(input, STEP_KEYS, 'CrossAppTransactionStepV1');
  const stepId = id(raw.stepId, 'stepId');
  const invocationId = id(raw.invocationId, 'invocationId');
  const invocationSha256 = sha256(raw.invocationSha256, 'invocationSha256');
  const compensationInvocationId = id(raw.compensationInvocationId, 'compensationInvocationId', { optional: true });
  const compensationInvocationSha256 = raw.compensationInvocationSha256 == null
    ? null
    : sha256(raw.compensationInvocationSha256, 'compensationInvocationSha256');

  if ((compensationInvocationId == null) !== (compensationInvocationSha256 == null)) {
    throw new Error('compensationInvocationId and compensationInvocationSha256 must be provided together');
  }
  if (compensationInvocationId === invocationId) {
    throw new Error('compensationInvocationId must differ from invocationId');
  }

  return frozen({
    stepId,
    providerId: id(raw.providerId, 'providerId'),
    invocationId,
    invocationSha256,
    dependsOnStepIds: idList(raw.dependsOnStepIds, 'dependsOnStepIds'),
    compensationInvocationId,
    compensationInvocationSha256,
  });
}

function assertDag(steps) {
  const byId = new Map(steps.map(step => [step.stepId, step]));
  for (const step of steps) {
    for (const dependencyId of step.dependsOnStepIds) {
      if (dependencyId === step.stepId) throw new Error(`step ${step.stepId} cannot depend on itself`);
      if (!byId.has(dependencyId)) {
        throw new Error(`step ${step.stepId} references unknown dependency ${dependencyId}`);
      }
    }
  }

  const state = new Map();
  function visit(stepId) {
    const current = state.get(stepId);
    if (current === 'visiting') throw new Error('transaction step graph contains a cycle');
    if (current === 'done') return;
    state.set(stepId, 'visiting');
    for (const dependencyId of byId.get(stepId).dependsOnStepIds) visit(dependencyId);
    state.set(stepId, 'done');
  }
  for (const step of steps) visit(step.stepId);
}

export function normalizeCrossAppTransactionV1(input) {
  const raw = record(input, TRANSACTION_KEYS, 'CrossAppTransactionV1');
  version(raw.schemaVersion, 'CrossAppTransactionV1');
  const inputSteps = denseArray(raw.steps, 'steps', MAX_STEPS);
  if (inputSteps.length === 0) throw new Error('steps must not be empty');
  const steps = inputSteps.map(normalizeStep);
  if (new Set(steps.map(step => step.stepId)).size !== steps.length) {
    throw new Error('steps contain duplicate stepId values');
  }
  const invocationIds = new Set();
  const invocationDigests = new Set();
  for (const step of steps) {
    for (const [invocationId, invocationDigest] of [
      [step.invocationId, step.invocationSha256],
      [step.compensationInvocationId, step.compensationInvocationSha256],
    ]) {
      if (invocationId == null) continue;
      if (invocationIds.has(invocationId)) throw new Error('steps contain duplicate invocationId values');
      if (invocationDigests.has(invocationDigest)) throw new Error('steps contain duplicate invocationSha256 values');
      invocationIds.add(invocationId);
      invocationDigests.add(invocationDigest);
    }
  }
  assertDag(steps);
  const sortedSteps = [...steps]
    .sort((a, b) => (a.stepId < b.stepId ? -1 : (a.stepId > b.stepId ? 1 : 0)));

  return frozen({
    schemaVersion: CrossAppTransactionContractVersion,
    transactionId: id(raw.transactionId, 'transactionId'),
    projectId: id(raw.projectId, 'projectId'),
    label: labelText(raw.label),
    createdAt: timestamp(raw.createdAt, 'createdAt'),
    steps: sortedSteps,
  });
}

function toHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Json(value, cryptoApi) {
  if (!cryptoApi?.subtle?.digest) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return toHex(new Uint8Array(digest));
}

export async function createCrossAppInvocationFingerprintV1(invocationInput, cryptoApi = globalThis.crypto) {
  const invocation = normalizeInvocationForFingerprint(invocationInput);
  return sha256Json(['chatgpt-autopilot-tool-invocation-v1', invocation], cryptoApi);
}

export async function createCrossAppTransactionFingerprintV1(transactionInput, cryptoApi = globalThis.crypto) {
  const transaction = normalizeCrossAppTransactionV1(transactionInput);
  return sha256Json(['chatgpt-autopilot-cross-app-transaction-v1', transaction], cryptoApi);
}

function assertDeepDataOnly(value, label, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw new Error(`${label} is too deeply nested`);
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return;
  if (Array.isArray(value)) {
    denseArray(value, label, 4096);
    for (let index = 0; index < value.length; index += 1) {
      assertDeepDataOnly(value[index], `${label}[${index}]`, depth + 1);
    }
    return;
  }
  if (!value || typeof value !== 'object') throw new Error(`${label} must contain data properties only`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must contain plain objects only`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} contains symbol data`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    assertDeepDataOnly(descriptor.value, `${label}.${key}`, depth + 1);
  }
}

function projectionStatus({ complete, attention, active, ready }) {
  if (complete) return CrossAppTransactionProjectionStatus.COMPLETE;
  if (attention) return CrossAppTransactionProjectionStatus.ATTENTION;
  if (active) return CrossAppTransactionProjectionStatus.ACTIVE;
  if (ready) return CrossAppTransactionProjectionStatus.READY;
  return CrossAppTransactionProjectionStatus.BLOCKED;
}

export async function projectCrossAppTransactionV1(
  transactionInput,
  exactEffectStateInputs = [],
  cryptoApi = globalThis.crypto,
) {
  const transaction = normalizeCrossAppTransactionV1(transactionInput);
  const inputStates = denseArray(exactEffectStateInputs, 'exactEffectStates', MAX_STEPS);
  const states = [];
  for (let index = 0; index < inputStates.length; index += 1) {
    const input = inputStates[index];
    assertDeepDataOnly(input, `exactEffectStates[${index}]`);
    const state = normalizeExactEffectStateV1(input);
    states.push(state);
  }

  const byStep = new Map(transaction.steps.map(step => [step.stepId, step]));
  const stepByInvocation = new Map(transaction.steps.map(step => [step.invocationId, step]));
  const stateByStep = new Map();
  const commitIds = new Set();

  for (const state of states) {
    const step = stepByInvocation.get(state.invocation.invocationId);
    if (!step) throw new Error(`exact-effect state ${state.effectId} is not part of transaction`);
    if (stateByStep.has(step.stepId)) throw new Error(`duplicate exact-effect state for step ${step.stepId}`);
    if (state.invocation.providerId !== step.providerId) {
      throw new Error(`exact-effect provider binding does not match step ${step.stepId}`);
    }
    const invocationSha256 = await createCrossAppInvocationFingerprintV1(state.invocation, cryptoApi);
    if (invocationSha256 !== step.invocationSha256) {
      throw new Error(`exact-effect invocation binding does not match step ${step.stepId}`);
    }
    if (Date.parse(state.createdAt) < Date.parse(transaction.createdAt)) {
      throw new Error(`exact-effect state for step ${step.stepId} predates transaction`);
    }
    if (state.phase === ExactEffectPhase.COMMITTED) {
      if (!state.commitId) throw new Error(`committed exact-effect state for step ${step.stepId} lacks commitId`);
      if (commitIds.has(state.commitId)) throw new Error('exact-effect states contain duplicate commitId values');
      commitIds.add(state.commitId);
    }
    stateByStep.set(step.stepId, state);
  }

  for (const step of transaction.steps) {
    const state = stateByStep.get(step.stepId);
    if (!state) continue;
    for (const dependencyId of step.dependsOnStepIds) {
      const dependencyState = stateByStep.get(dependencyId);
      if (state.phase !== ExactEffectPhase.PREPARED) {
        if (!dependencyState || dependencyState.phase !== ExactEffectPhase.COMMITTED) {
          throw new Error(`active exact-effect state for step ${step.stepId} lacks committed dependency ${dependencyId}`);
        }
        if (Date.parse(state.updatedAt) < Date.parse(dependencyState.updatedAt)) {
          throw new Error(`exact-effect state for step ${step.stepId} predates committed dependency ${dependencyId}`);
        }
      }
    }
  }

  const committedStepIds = [];
  const readyStepIds = [];
  const activeStepIds = [];
  const attentionStepIds = [];
  const blockedStepIds = [];
  const executablePhases = new Set([ExactEffectPhase.PREPARED, ExactEffectPhase.SAFE_RETRY]);
  const activePhases = new Set([ExactEffectPhase.EXECUTING, ExactEffectPhase.OBSERVED, ExactEffectPhase.VERIFIED]);
  const attentionPhases = new Set([ExactEffectPhase.RECONCILE, ExactEffectPhase.MANUAL_REVIEW]);

  for (const step of transaction.steps) {
    const state = stateByStep.get(step.stepId);
    const dependenciesCommitted = step.dependsOnStepIds.every(dependencyId =>
      stateByStep.get(dependencyId)?.phase === ExactEffectPhase.COMMITTED);

    if (state?.phase === ExactEffectPhase.COMMITTED) {
      committedStepIds.push(step.stepId);
    } else if (state && attentionPhases.has(state.phase)) {
      attentionStepIds.push(step.stepId);
    } else if (state && activePhases.has(state.phase)) {
      activeStepIds.push(step.stepId);
    } else if (dependenciesCommitted && (!state || executablePhases.has(state.phase))) {
      readyStepIds.push(step.stepId);
    } else {
      blockedStepIds.push(step.stepId);
    }
  }

  const complete = committedStepIds.length === transaction.steps.length;
  return frozen({
    schemaVersion: CrossAppTransactionContractVersion,
    transactionId: transaction.transactionId,
    projectId: transaction.projectId,
    status: projectionStatus({
      complete,
      attention: attentionStepIds.length > 0,
      active: activeStepIds.length > 0,
      ready: readyStepIds.length > 0,
    }),
    advisoryOnly: true,
    committedStepIds,
    readyStepIds,
    activeStepIds,
    attentionStepIds,
    blockedStepIds,
  });
}
