import { BrowserAgentRunState } from './browser-agent.js';

export const BROWSER_AGENT_PARENT_RUNTIME_FENCE_VERSION = 1;

export const BrowserAgentParentRuntimeFenceStatus = Object.freeze({
  CURRENT: 'CURRENT',
  JOB_DRIFTED: 'JOB_DRIFTED',
  NOT_RUNNING: 'NOT_RUNNING',
  CONTROL_EPOCH_DRIFTED: 'CONTROL_EPOCH_DRIFTED',
  CAPABILITY_SCOPE_DRIFTED: 'CAPABILITY_SCOPE_DRIFTED',
  TOOL_SCOPE_DRIFTED: 'TOOL_SCOPE_DRIFTED',
});

const LIVE_KEYS = new Set(['jobId', 'runState', 'controlEpoch', 'capabilityIds', 'toolIds']);
const FENCE_KEYS = new Set(['schemaVersion', 'jobId', 'controlEpoch', 'capabilityIds', 'toolIds']);
const INSPECT_KEYS = new Set(['fence', 'live']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_CAPABILITY_IDS = 64;
const MAX_TOOL_IDS = 128;
const KNOWN_RUN_STATES = new Set(Object.values(BrowserAgentRunState));

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
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length)
      || Object.is(length, -0)
      || length < 0
      || length > max) {
    throw new Error(label + ' has invalid length');
  }
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' contains non-canonical array fields');
    }
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

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function jobId(value) {
  if (typeof value !== 'string'
      || value !== value.trim()
      || !value
      || value.length > 128) {
    throw new Error('Browser Agent parent runtime jobId is invalid');
  }
  return value;
}

function runState(value) {
  if (typeof value !== 'string' || !KNOWN_RUN_STATES.has(value)) {
    throw new Error('Browser Agent parent runtime runState is invalid');
  }
  return value;
}

function controlEpoch(value, { positive = false } = {}) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < (positive ? 1 : 0)) {
    throw new Error('Browser Agent parent runtime controlEpoch is invalid');
  }
  return value;
}

function scopeIds(value, label, max) {
  const ids = denseArray(value, label, max).map((item, index) => {
    if (typeof item !== 'string'
        || item !== item.trim()
        || !ID.test(item)) {
      throw new Error(label + '[' + index + '] is invalid');
    }
    return item;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error(label + ' contains duplicate identity');
  }
  return Object.freeze([...ids].sort());
}

function sameIds(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function normalizeLive(input) {
  const raw = strictRecord(input, LIVE_KEYS, 'BrowserAgentParentRuntimeLiveV1');
  for (const key of LIVE_KEYS) {
    if (!Object.hasOwn(raw, key)) {
      throw new Error('BrowserAgentParentRuntimeLiveV1 requires ' + key);
    }
  }
  const state = runState(raw.runState);
  return freeze({
    jobId: jobId(raw.jobId),
    runState: state,
    controlEpoch: controlEpoch(raw.controlEpoch, {
      positive: state === BrowserAgentRunState.RUNNING,
    }),
    capabilityIds: scopeIds(raw.capabilityIds, 'parent capabilityIds', MAX_CAPABILITY_IDS),
    toolIds: scopeIds(raw.toolIds, 'parent toolIds', MAX_TOOL_IDS),
  });
}

export function normalizeBrowserAgentParentRuntimeFenceV1(input) {
  const raw = strictRecord(input, FENCE_KEYS, 'BrowserAgentParentRuntimeFenceV1');
  for (const key of FENCE_KEYS) {
    if (!Object.hasOwn(raw, key)) {
      throw new Error('BrowserAgentParentRuntimeFenceV1 requires ' + key);
    }
  }
  if (raw.schemaVersion !== BROWSER_AGENT_PARENT_RUNTIME_FENCE_VERSION) {
    throw new Error('Unsupported BrowserAgentParentRuntimeFenceV1 schemaVersion');
  }
  return freeze({
    schemaVersion: BROWSER_AGENT_PARENT_RUNTIME_FENCE_VERSION,
    jobId: jobId(raw.jobId),
    controlEpoch: controlEpoch(raw.controlEpoch, { positive: true }),
    capabilityIds: scopeIds(raw.capabilityIds, 'fence capabilityIds', MAX_CAPABILITY_IDS),
    toolIds: scopeIds(raw.toolIds, 'fence toolIds', MAX_TOOL_IDS),
  });
}

/**
 * Captures the least runtime facts needed to prove that an automatic child
 * admission still belongs to the same live owner-controlled Browser Agent.
 *
 * This is a read-only anti-TOCTOU fence. It grants no execution, provider,
 * policy, scheduling, recovery, credential, completion or verification
 * authority.
 */
export function createBrowserAgentParentRuntimeFenceV1(input = {}) {
  const live = normalizeLive(input);
  if (live.runState !== BrowserAgentRunState.RUNNING) {
    throw new Error('Browser Agent parent must be RUNNING to create a runtime fence');
  }
  return normalizeBrowserAgentParentRuntimeFenceV1({
    schemaVersion: BROWSER_AGENT_PARENT_RUNTIME_FENCE_VERSION,
    jobId: live.jobId,
    controlEpoch: live.controlEpoch,
    capabilityIds: live.capabilityIds,
    toolIds: live.toolIds,
  });
}

/**
 * Revalidates a previously captured fence against exact live parent facts.
 * CURRENT means only that the anti-TOCTOU fence still matches; it is not an
 * execution or child-spawn authorization.
 */
export function inspectBrowserAgentParentRuntimeFenceV1(input = {}) {
  const raw = strictRecord(input, INSPECT_KEYS, 'Browser Agent parent runtime fence inspection');
  for (const key of INSPECT_KEYS) {
    if (!Object.hasOwn(raw, key)) {
      throw new Error('Browser Agent parent runtime fence inspection requires ' + key);
    }
  }
  const fence = normalizeBrowserAgentParentRuntimeFenceV1(raw.fence);
  const live = normalizeLive(raw.live);

  let status = BrowserAgentParentRuntimeFenceStatus.CURRENT;
  if (live.jobId !== fence.jobId) {
    status = BrowserAgentParentRuntimeFenceStatus.JOB_DRIFTED;
  } else if (live.runState !== BrowserAgentRunState.RUNNING) {
    status = BrowserAgentParentRuntimeFenceStatus.NOT_RUNNING;
  } else if (live.controlEpoch !== fence.controlEpoch) {
    status = BrowserAgentParentRuntimeFenceStatus.CONTROL_EPOCH_DRIFTED;
  } else if (!sameIds(live.capabilityIds, fence.capabilityIds)) {
    status = BrowserAgentParentRuntimeFenceStatus.CAPABILITY_SCOPE_DRIFTED;
  } else if (!sameIds(live.toolIds, fence.toolIds)) {
    status = BrowserAgentParentRuntimeFenceStatus.TOOL_SCOPE_DRIFTED;
  }

  return freeze({
    schemaVersion: BROWSER_AGENT_PARENT_RUNTIME_FENCE_VERSION,
    fence,
    live,
    status,
    current: status === BrowserAgentParentRuntimeFenceStatus.CURRENT,
    authority: {
      childAdmissionAuthorized: false,
      childExecutionAuthorized: false,
      providerExecutionAuthorized: false,
      policyAuthorized: false,
      schedulingAuthorized: false,
      recoveryAuthorized: false,
      credentialAuthorized: false,
      completionAuthorized: false,
      verificationAuthorized: false,
    },
  });
}
