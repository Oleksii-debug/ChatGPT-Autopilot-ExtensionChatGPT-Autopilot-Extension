export const RUN_TRACE_SCHEMA_VERSION = 1;
export const MAX_RUN_TRACE_EVENTS = 2048;
export const MAX_RUN_TRACE_ARTIFACT_REFS = 64;

export const RunTraceEventKind = Object.freeze({
  PLAN: 'PLAN',
  TASK: 'TASK',
  EFFECT: 'EFFECT',
  VERIFICATION: 'VERIFICATION',
  ARTIFACT: 'ARTIFACT',
  CHECKPOINT: 'CHECKPOINT',
  BUDGET: 'BUDGET',
  OWNER_ATTENTION: 'OWNER_ATTENTION',
  STATUS: 'STATUS',
});

const EVENT_KINDS = new Set(Object.values(RunTraceEventKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ARTIFACT_REF_KEYS = new Set(['artifactId', 'versionId', 'sha256']);
const EVENT_KEYS = new Set([
  'schemaVersion',
  'eventId',
  'runId',
  'projectId',
  'jobId',
  'runRevisionId',
  'kind',
  'actorId',
  'parentEventId',
  'sourceRevisionId',
  'artifactRefs',
  'effectId',
  'verificationId',
  'checkpointId',
  'status',
  'reasonCode',
  'budgetCostUsdMicros',
  'occurredAt',
]);
const REQUEST_KEYS = new Set([
  'schemaVersion',
  'traceId',
  'runId',
  'projectId',
  'jobId',
  'runRevisionId',
  'observedThrough',
  'events',
  'filterKinds',
  'afterEventId',
]);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain or null-prototype object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(label + ' must not contain symbol fields');
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(label + ' fields must be enumerable own data properties');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) throw new Error(label + ' contains unknown field: ' + key);
  }
}

function own(value, key) {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function denseArray(value, label, { min = 0, max = MAX_RUN_TRACE_EVENTS } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < min || length > max) {
    throw new Error(label + ' must contain ' + min + '-' + max + ' items');
  }
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' contains non-canonical array fields');
    }
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(label + '[' + index + '] must be an enumerable own data property');
    }
    out.push(descriptor.value);
  }
  return out;
}

function id(value, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must be a canonical string identity');
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  return value;
}

function integer(value, label, min, max) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min
      || value > max) {
    throw new Error(label + ' must be an exact canonical integer in ' + min + '..' + max);
  }
  return value;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function sha256(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !SHA256.test(value)) {
    throw new Error(label + ' must be canonical lowercase SHA-256');
  }
  return value;
}

function normalizeArtifactRef(input, label) {
  const raw = record(input, label);
  exactKeys(raw, ARTIFACT_REF_KEYS, label);
  return freezeDeep({
    artifactId: id(own(raw, 'artifactId'), label + '.artifactId'),
    versionId: id(own(raw, 'versionId'), label + '.versionId'),
    sha256: sha256(own(raw, 'sha256'), label + '.sha256'),
  });
}

function artifactRefs(value, label) {
  const items = denseArray(value, label, { max: MAX_RUN_TRACE_ARTIFACT_REFS })
    .map((item, index) => normalizeArtifactRef(item, label + '[' + index + ']'));
  const exactKeysSeen = new Set();
  const versionIds = new Set();
  for (const item of items) {
    const exactKey = item.artifactId + '\\u0000' + item.versionId + '\\u0000' + item.sha256;
    if (exactKeysSeen.has(exactKey)) throw new Error(label + ' contains duplicate immutable ArtifactRef');
    if (versionIds.has(item.versionId)) throw new Error(label + ' contains duplicate versionId');
    exactKeysSeen.add(exactKey);
    versionIds.add(item.versionId);
  }
  return items.sort((left, right) => (
    compare(left.artifactId, right.artifactId)
    || compare(left.versionId, right.versionId)
    || compare(left.sha256, right.sha256)
  ));
}

function kindList(value, label) {
  const raw = denseArray(value, label, { max: Object.keys(RunTraceEventKind).length });
  const out = raw.map((item, index) => {
    if (typeof item !== 'string' || !EVENT_KINDS.has(item)) {
      throw new Error(label + '[' + index + '] is invalid');
    }
    return item;
  });
  if (new Set(out).size !== out.length) throw new Error(label + ' contains duplicates');
  return out.sort(compare);
}

function normalizeKindBoundFields(event) {
  if (event.kind === RunTraceEventKind.EFFECT && !event.effectId) {
    throw new Error('EFFECT event requires effectId');
  }
  if (event.kind === RunTraceEventKind.VERIFICATION && !event.verificationId) {
    throw new Error('VERIFICATION event requires verificationId');
  }
  if (event.kind === RunTraceEventKind.ARTIFACT && event.artifactRefs.length === 0) {
    throw new Error('ARTIFACT event requires at least one artifactId');
  }
  if (event.kind === RunTraceEventKind.CHECKPOINT && !event.checkpointId) {
    throw new Error('CHECKPOINT event requires checkpointId');
  }
  if (event.kind !== RunTraceEventKind.CHECKPOINT && event.checkpointId) {
    throw new Error('checkpointId is valid only for CHECKPOINT events');
  }
  if (event.kind !== RunTraceEventKind.VERIFICATION && event.verificationId) {
    throw new Error('verificationId is valid only for VERIFICATION events');
  }
  if (event.kind !== RunTraceEventKind.EFFECT
      && event.kind !== RunTraceEventKind.VERIFICATION
      && event.effectId) {
    throw new Error('effectId is valid only for EFFECT or VERIFICATION events');
  }
  if (event.kind !== RunTraceEventKind.BUDGET && event.budgetCostUsdMicros !== 0) {
    throw new Error('budgetCostUsdMicros is valid only for BUDGET events');
  }
}

export function normalizeRunTraceEventV1(input) {
  const raw = record(input, 'RunTraceEventV1');
  exactKeys(raw, EVENT_KEYS, 'RunTraceEventV1');
  if (own(raw, 'schemaVersion') !== RUN_TRACE_SCHEMA_VERSION) {
    throw new Error('RunTraceEventV1 schemaVersion must be numeric 1');
  }

  const kind = own(raw, 'kind');
  if (typeof kind !== 'string' || !EVENT_KINDS.has(kind)) {
    throw new Error('RunTraceEventV1 kind is invalid');
  }

  const event = {
    schemaVersion: RUN_TRACE_SCHEMA_VERSION,
    eventId: id(own(raw, 'eventId'), 'eventId'),
    runId: id(own(raw, 'runId'), 'runId'),
    projectId: id(own(raw, 'projectId'), 'projectId'),
    jobId: id(own(raw, 'jobId'), 'jobId'),
    runRevisionId: id(own(raw, 'runRevisionId'), 'runRevisionId'),
    kind,
    actorId: id(own(raw, 'actorId'), 'actorId'),
    parentEventId: id(own(raw, 'parentEventId'), 'parentEventId', { optional: true }),
    sourceRevisionId: id(own(raw, 'sourceRevisionId'), 'sourceRevisionId'),
    artifactRefs: artifactRefs(own(raw, 'artifactRefs') ?? [], 'artifactRefs'),
    effectId: id(own(raw, 'effectId'), 'effectId', { optional: true }),
    verificationId: id(own(raw, 'verificationId'), 'verificationId', { optional: true }),
    checkpointId: id(own(raw, 'checkpointId'), 'checkpointId', { optional: true }),
    status: id(own(raw, 'status'), 'status'),
    reasonCode: id(own(raw, 'reasonCode'), 'reasonCode', { optional: true }),
    budgetCostUsdMicros: integer(own(raw, 'budgetCostUsdMicros') ?? 0, 'budgetCostUsdMicros', 0, Number.MAX_SAFE_INTEGER),
    occurredAt: timestamp(own(raw, 'occurredAt'), 'occurredAt'),
  };

  if (event.parentEventId === event.eventId) throw new Error('event cannot parent itself');
  normalizeKindBoundFields(event);
  return freezeDeep(event);
}

function exactIdentity(event, request) {
  return event.runId === request.runId
    && event.projectId === request.projectId
    && event.jobId === request.jobId
    && event.runRevisionId === request.runRevisionId;
}

function validateGraph(events, observedThrough) {
  const byId = new Map();
  for (const event of events) {
    if (byId.has(event.eventId)) throw new Error('Run trace contains duplicate eventId: ' + event.eventId);
    if (Date.parse(event.occurredAt) > Date.parse(observedThrough)) {
      throw new Error('Run trace event occurs after observedThrough: ' + event.eventId);
    }
    byId.set(event.eventId, event);
  }

  for (const event of events) {
    if (!event.parentEventId) continue;
    const parent = byId.get(event.parentEventId);
    if (!parent) throw new Error('Run trace references unknown parentEventId: ' + event.parentEventId);
    if (Date.parse(parent.occurredAt) > Date.parse(event.occurredAt)) {
      throw new Error('Run trace parent occurs after child: ' + event.eventId);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(event) {
    if (visited.has(event.eventId)) return;
    if (visiting.has(event.eventId)) throw new Error('Run trace parent graph contains a cycle');
    visiting.add(event.eventId);
    if (event.parentEventId) visit(byId.get(event.parentEventId));
    visiting.delete(event.eventId);
    visited.add(event.eventId);
  }
  for (const event of events) visit(event);

  return byId;
}

function causalOrder(events, byId) {
  const sorted = [...events].sort((left, right) => (
    compare(left.occurredAt, right.occurredAt)
    || compare(left.eventId, right.eventId)
  ));
  const emitted = new Set();
  const out = [];
  function emit(event) {
    if (emitted.has(event.eventId)) return;
    if (event.parentEventId) emit(byId.get(event.parentEventId));
    emitted.add(event.eventId);
    out.push(event);
  }
  for (const event of sorted) emit(event);
  return out;
}

function countsByKind(events) {
  const counts = Object.fromEntries(Object.values(RunTraceEventKind).map(kind => [kind, 0]));
  for (const event of events) counts[event.kind] += 1;
  return counts;
}

export function buildRunTraceProjectionV1(input) {
  const raw = record(input, 'RunTraceProjectionRequestV1');
  exactKeys(raw, REQUEST_KEYS, 'RunTraceProjectionRequestV1');
  if (own(raw, 'schemaVersion') !== RUN_TRACE_SCHEMA_VERSION) {
    throw new Error('RunTraceProjectionRequestV1 schemaVersion must be numeric 1');
  }

  const request = {
    schemaVersion: RUN_TRACE_SCHEMA_VERSION,
    traceId: id(own(raw, 'traceId'), 'traceId'),
    runId: id(own(raw, 'runId'), 'runId'),
    projectId: id(own(raw, 'projectId'), 'projectId'),
    jobId: id(own(raw, 'jobId'), 'jobId'),
    runRevisionId: id(own(raw, 'runRevisionId'), 'runRevisionId'),
    observedThrough: timestamp(own(raw, 'observedThrough'), 'observedThrough'),
    events: denseArray(own(raw, 'events'), 'events', { max: MAX_RUN_TRACE_EVENTS })
      .map(normalizeRunTraceEventV1),
    filterKinds: kindList(own(raw, 'filterKinds') ?? [], 'filterKinds'),
    afterEventId: id(own(raw, 'afterEventId'), 'afterEventId', { optional: true }),
  };

  for (const event of request.events) {
    if (!exactIdentity(event, request)) {
      throw new Error('Run trace event identity does not match requested run identity: ' + event.eventId);
    }
  }

  const byId = validateGraph(request.events, request.observedThrough);
  const ordered = causalOrder(request.events, byId);

  let startIndex = 0;
  if (request.afterEventId) {
    const index = ordered.findIndex(event => event.eventId === request.afterEventId);
    if (index < 0) throw new Error('afterEventId is not present in this run trace');
    startIndex = index + 1;
  }

  const selectedKinds = request.filterKinds.length ? new Set(request.filterKinds) : null;
  const replayWindow = ordered.slice(startIndex);
  const projected = selectedKinds
    ? replayWindow.filter(event => selectedKinds.has(event.kind))
    : replayWindow;

  return freezeDeep({
    schemaVersion: RUN_TRACE_SCHEMA_VERSION,
    traceId: request.traceId,
    runId: request.runId,
    projectId: request.projectId,
    jobId: request.jobId,
    runRevisionId: request.runRevisionId,
    observedThrough: request.observedThrough,
    filterKinds: request.filterKinds,
    cursor: {
      afterEventId: request.afterEventId,
      nextAfterEventId: ordered.length ? ordered[ordered.length - 1].eventId : '',
    },
    events: projected,
    summary: {
      totalEventCount: ordered.length,
      replayWindowCount: replayWindow.length,
      projectedEventCount: projected.length,
      allCountsByKind: countsByKind(ordered),
      projectedCountsByKind: countsByKind(projected),
    },
    readOnly: true,
    advisoryOnly: true,
    sourceTrust: 'UNVERIFIED_INPUT',
    hiddenReasoningIncluded: false,
    rawTranscriptIncluded: false,
    replayAuthorized: false,
    executionAuthorized: false,
    evidenceAuthorityMinted: false,
    requiresCanonicalSourceResolution: true,
  });
}
