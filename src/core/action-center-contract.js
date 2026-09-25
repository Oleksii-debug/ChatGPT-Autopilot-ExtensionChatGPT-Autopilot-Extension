/**
 * Universal Action Center V1 read-only attention candidate contract.
 *
 * This module is deliberately not an inbox store, policy engine, approval
 * authority, notifier or task mutator. Caller-owned records are normalized as
 * advisory candidates only. A product surface must resolve each source against
 * its canonical owner before enabling any consequential owner action.
 */

export const ACTION_CENTER_SCHEMA_VERSION = 1;
export const MAX_ACTION_CENTER_ITEMS = 256;
export const MAX_ACTION_CENTER_EVIDENCE_REFS = 64;

export const ActionCenterItemStatus = Object.freeze({
  OPEN: 'OPEN',
  RESOLVED: 'RESOLVED',
  SUPERSEDED: 'SUPERSEDED',
});

export const ActionCenterSeverity = Object.freeze({
  BLOCKING: 'BLOCKING',
  HIGH: 'HIGH',
  NORMAL: 'NORMAL',
  LOW: 'LOW',
});

export const ActionCenterOwnerActionKind = Object.freeze({
  APPROVE_OR_DENY: 'APPROVE_OR_DENY',
  CLARIFY: 'CLARIFY',
  REVIEW: 'REVIEW',
  RECONCILE: 'RECONCILE',
  TAKE_OVER: 'TAKE_OVER',
  REAUTHENTICATE: 'REAUTHENTICATE',
  NONE: 'NONE',
});

export const ActionCenterSourceKind = Object.freeze({
  JOB: 'JOB',
  TASK: 'TASK',
  EFFECT: 'EFFECT',
  APPROVAL: 'APPROVAL',
  REVIEW: 'REVIEW',
  PROJECT: 'PROJECT',
  PROVIDER: 'PROVIDER',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const STATUSES = new Set(Object.values(ActionCenterItemStatus));
const SEVERITIES = new Set(Object.values(ActionCenterSeverity));
const ACTIONS = new Set(Object.values(ActionCenterOwnerActionKind));
const SOURCE_KINDS = new Set(Object.values(ActionCenterSourceKind));
const SEVERITY_RANK = Object.freeze({
  [ActionCenterSeverity.BLOCKING]: 0,
  [ActionCenterSeverity.HIGH]: 1,
  [ActionCenterSeverity.NORMAL]: 2,
  [ActionCenterSeverity.LOW]: 3,
});
const ITEM_KEYS = new Set([
  'schemaVersion',
  'itemId',
  'status',
  'severity',
  'ownerActionKind',
  'title',
  'materialityReason',
  'sourceKind',
  'sourceId',
  'sourceRevisionId',
  'sourceEffectId',
  'evidenceArtifactIds',
  'createdAt',
  'updatedAt',
  'closedAt',
  'supersededByItemId',
]);

function dataRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain or null-prototype object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} must not contain symbol fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error(`${label} fields must be enumerable own data properties`);
    }
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function own(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function dataArray(value, label, { min = 0, max = MAX_ACTION_CENTER_ITEMS } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a canonical array`);
  }
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < min || length > max) {
    throw new Error(`${label} must contain ${min}-${max} items`);
  }
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(`${label} contains non-canonical array fields`);
    }
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error(`${label}[${index}] must be an enumerable own data property`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function canonicalId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must be a canonical string identity`);
  }
  return value;
}

function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return '';
  return canonicalId(value, label);
}

function canonicalText(value, label, max) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new Error(`${label} must be canonical bounded text`);
  }
  return value;
}

function optionalText(value, label, max) {
  if (value === undefined || value === null || value === '') return '';
  return canonicalText(value, label, max);
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function optionalTimestamp(value, label) {
  if (value === undefined || value === null || value === '') return '';
  return canonicalTimestamp(value, label);
}

function enumValue(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.has(value)) throw new Error(`${label} is invalid`);
  return value;
}

function uniqueIds(value, label) {
  const items = dataArray(value, label, { max: MAX_ACTION_CENTER_EVIDENCE_REFS })
    .map((item, index) => canonicalId(item, `${label}[${index}]`));
  if (new Set(items).size !== items.length) throw new Error(`${label} contains duplicates`);
  return items.sort(compare);
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export function normalizeActionCenterItemV1(input) {
  const raw = dataRecord(input, 'ActionCenterItemV1');
  exactKeys(raw, ITEM_KEYS, 'ActionCenterItemV1');
  if (own(raw, 'schemaVersion') !== ACTION_CENTER_SCHEMA_VERSION) {
    throw new Error('ActionCenterItemV1 schemaVersion must be numeric 1');
  }

  const itemId = canonicalId(own(raw, 'itemId'), 'itemId');
  const status = enumValue(own(raw, 'status'), STATUSES, 'status');
  const severity = enumValue(own(raw, 'severity'), SEVERITIES, 'severity');
  const ownerActionKind = enumValue(own(raw, 'ownerActionKind'), ACTIONS, 'ownerActionKind');
  const title = canonicalText(own(raw, 'title'), 'title', 240);
  const materialityReason = canonicalText(own(raw, 'materialityReason'), 'materialityReason', 1200);
  const sourceKind = enumValue(own(raw, 'sourceKind'), SOURCE_KINDS, 'sourceKind');
  const sourceId = canonicalId(own(raw, 'sourceId'), 'sourceId');
  const sourceRevisionId = canonicalId(own(raw, 'sourceRevisionId'), 'sourceRevisionId');
  const sourceEffectId = optionalId(own(raw, 'sourceEffectId'), 'sourceEffectId');
  const evidenceArtifactIds = uniqueIds(
    own(raw, 'evidenceArtifactIds') === undefined ? [] : own(raw, 'evidenceArtifactIds'),
    'evidenceArtifactIds',
  );
  const createdAt = canonicalTimestamp(own(raw, 'createdAt'), 'createdAt');
  const updatedAt = canonicalTimestamp(own(raw, 'updatedAt'), 'updatedAt');
  const closedAt = optionalTimestamp(own(raw, 'closedAt'), 'closedAt');
  const supersededByItemId = optionalId(own(raw, 'supersededByItemId'), 'supersededByItemId');

  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error('updatedAt cannot predate createdAt');
  }

  if (status === ActionCenterItemStatus.OPEN) {
    if (ownerActionKind === ActionCenterOwnerActionKind.NONE) {
      throw new Error('OPEN attention item requires a concrete owner action');
    }
    if (closedAt) throw new Error('OPEN attention item cannot have closedAt');
    if (supersededByItemId) throw new Error('OPEN attention item cannot have supersededByItemId');
  } else {
    if (ownerActionKind !== ActionCenterOwnerActionKind.NONE) {
      throw new Error('closed attention item cannot request live owner action');
    }
    if (!closedAt) throw new Error('closed attention item requires closedAt');
    if (Date.parse(closedAt) < Date.parse(updatedAt)) {
      throw new Error('closedAt cannot predate updatedAt');
    }
    if (status === ActionCenterItemStatus.SUPERSEDED) {
      if (!supersededByItemId || supersededByItemId === itemId) {
        throw new Error('SUPERSEDED attention item requires a distinct superseding item identity');
      }
    } else if (supersededByItemId) {
      throw new Error('RESOLVED attention item cannot have supersededByItemId');
    }
  }

  return freezeDeep({
    schemaVersion: ACTION_CENTER_SCHEMA_VERSION,
    itemId,
    status,
    severity,
    ownerActionKind,
    title,
    materialityReason,
    sourceKind,
    sourceId,
    sourceRevisionId,
    sourceEffectId,
    evidenceArtifactIds,
    createdAt,
    updatedAt,
    closedAt,
    supersededByItemId,
    advisoryOnly: true,
    sourceTrust: 'UNVERIFIED_INPUT',
    decisionAuthorized: false,
  });
}

export function buildActionCenterProjectionV1(rawItems) {
  const items = dataArray(rawItems, 'Action Center items', { max: MAX_ACTION_CENTER_ITEMS })
    .map(normalizeActionCenterItemV1);
  if (new Set(items.map((item) => item.itemId)).size !== items.length) {
    throw new Error('Action Center items contain duplicate itemId');
  }

  const itemById = new Map(items.map((item) => [item.itemId, item]));
  for (const item of items) {
    if (item.status !== ActionCenterItemStatus.SUPERSEDED) continue;
    const successor = itemById.get(item.supersededByItemId);
    if (!successor) {
      throw new Error(`SUPERSEDED attention item references unknown superseding item: ${item.supersededByItemId}`);
    }
    if (Date.parse(successor.createdAt) < Date.parse(item.createdAt)) {
      throw new Error(`superseding attention item predates superseded item: ${item.itemId}`);
    }
    if (Date.parse(successor.createdAt) > Date.parse(item.closedAt)) {
      throw new Error(`superseding attention item postdates superseded item closure: ${item.itemId}`);
    }
  }

  for (const item of items) {
    if (item.status !== ActionCenterItemStatus.SUPERSEDED) continue;
    const seen = new Set([item.itemId]);
    let cursor = item;
    while (cursor.status === ActionCenterItemStatus.SUPERSEDED) {
      const nextId = cursor.supersededByItemId;
      if (seen.has(nextId)) throw new Error('Action Center supersession graph contains a cycle');
      seen.add(nextId);
      cursor = itemById.get(nextId);
    }
  }

  const orderedItems = [...items].sort((left, right) => {
    const leftOpen = left.status === ActionCenterItemStatus.OPEN ? 0 : 1;
    const rightOpen = right.status === ActionCenterItemStatus.OPEN ? 0 : 1;
    return leftOpen - rightOpen
      || SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
      || compare(left.createdAt, right.createdAt)
      || compare(left.itemId, right.itemId);
  });

  const openItems = orderedItems.filter((item) => item.status === ActionCenterItemStatus.OPEN);
  const openBySeverity = Object.fromEntries(
    Object.values(ActionCenterSeverity).map((severity) => [
      severity,
      openItems.filter((item) => item.severity === severity).length,
    ]),
  );

  return freezeDeep({
    schemaVersion: ACTION_CENTER_SCHEMA_VERSION,
    advisoryOnly: true,
    requiresCanonicalSourceResolution: true,
    decisionAuthorized: false,
    items: orderedItems,
    summary: {
      totalCount: orderedItems.length,
      openCount: openItems.length,
      resolvedCount: orderedItems.filter((item) => item.status === ActionCenterItemStatus.RESOLVED).length,
      supersededCount: orderedItems.filter((item) => item.status === ActionCenterItemStatus.SUPERSEDED).length,
      blockingOpenCount: openBySeverity[ActionCenterSeverity.BLOCKING],
      ownerActionOpenCount: openItems.length,
      openBySeverity,
    },
  });
}
