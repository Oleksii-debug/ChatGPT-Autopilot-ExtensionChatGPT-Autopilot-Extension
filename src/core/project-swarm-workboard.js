import { AgentPlanNodeState, normalizeAgentPlanV1 } from './agent-plan.js';

export const PROJECT_SWARM_WORKBOARD_VERSION = 1;
export const MAX_WORKBOARD_PLANS = 64;
export const MAX_WORKBOARD_TASKS = 512;
export const MAX_WORKBOARD_REVIEWS = 512;

export const WorkboardReviewState = Object.freeze({
  REQUESTED: 'REQUESTED',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  APPROVED: 'APPROVED',
  MERGED: 'MERGED',
});

export const WorkboardLane = Object.freeze({
  BLOCKED: 'BLOCKED',
  ACTIVE: 'ACTIVE',
  READY: 'READY',
  REVIEW: 'REVIEW',
  WAITING: 'WAITING',
  DONE: 'DONE',
  CANCELLED: 'CANCELLED',
});

const REVIEW_STATES = new Set(Object.values(WorkboardReviewState));
const LANE_ORDER = Object.freeze([
  WorkboardLane.BLOCKED,
  WorkboardLane.ACTIVE,
  WorkboardLane.READY,
  WorkboardLane.REVIEW,
  WorkboardLane.WAITING,
  WorkboardLane.DONE,
  WorkboardLane.CANCELLED,
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const REQUEST_KEYS = new Set([
  'schemaVersion', 'boardId', 'projectId', 'projectRevisionId', 'generatedAt',
  'planSnapshots', 'reviews',
]);
const PLAN_SNAPSHOT_KEYS = new Set(['schemaVersion', 'projectId', 'projectRevisionId', 'plan']);
const PLAN_KEYS = new Set([
  'schemaVersion', 'planId', 'jobId', 'objective', 'successCriteria', 'nodes',
  'createdAt', 'updatedAt', 'revision',
]);
const NODE_KEYS = new Set([
  'nodeId', 'title', 'objective', 'dependsOn', 'conflictKeys', 'ownerId',
  'executionPlane', 'acceptanceCriteria', 'budget', 'state', 'evidence', 'updatedAt',
]);
const REVIEW_KEYS = new Set([
  'schemaVersion', 'planId', 'nodeId', 'state', 'reviewerId', 'evidenceIds', 'updatedAt',
]);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(message) {
  throw new Error(message);
}

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !hasOwn(descriptor, 'value')) {
      fail(`${label} fields must be enumerable own data properties`);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(snapshot);
}

function denseDataArray(value, label, { min = 0, max = MAX_WORKBOARD_TASKS } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be a canonical dense array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < min || lengthDescriptor.value > max) {
    fail(`${label} length must be ${min}..${max}`);
  }
  const length = lengthDescriptor.value;
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      fail(`${label} contains non-canonical array fields`);
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !hasOwn(descriptor, 'value')) {
      fail(`${label}[${index}] must be an enumerable own data property`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string') fail(`${label} must use canonical ISO-8601 UTC representation`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    fail(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

function compareExact(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function refKey(planId, nodeId) {
  return JSON.stringify([planId, nodeId]);
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function publicTaskRef(task) {
  return Object.freeze({ planId: task.planId, nodeId: task.nodeId });
}

function assertExactAgentPlanTimestamps(rawPlan, normalized, label) {
  const source = strictRecord(rawPlan, PLAN_KEYS, label);
  const createdAt = exactTimestamp(source.createdAt, `${label}.createdAt`);
  const updatedAt = exactTimestamp(source.updatedAt, `${label}.updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail(`${label}.updatedAt predates createdAt`);
  if (createdAt !== normalized.createdAt || updatedAt !== normalized.