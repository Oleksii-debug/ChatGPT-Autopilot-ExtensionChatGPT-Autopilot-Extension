import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const ARTIFACT_DESIGN_CANVAS_VERSION = 1;
export const MAX_CANVAS_ITEMS = 256;

export const CanvasItemKind = Object.freeze({
  DOCUMENT: 'DOCUMENT',
  IMAGE: 'IMAGE',
  SHEET: 'SHEET',
  SLIDE: 'SLIDE',
  PDF: 'PDF',
  CODE: 'CODE',
  DATA: 'DATA',
  MEDIA: 'MEDIA',
  DESIGN: 'DESIGN',
  OTHER: 'OTHER',
});

export const CanvasPreviewStatus = Object.freeze({
  READY: 'READY',
  MISSING_SOURCE: 'MISSING_SOURCE',
  STALE_SOURCE: 'STALE_SOURCE',
  PREVIEW_REQUIRED: 'PREVIEW_REQUIRED',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ITEM_KINDS = new Set(Object.values(CanvasItemKind));
const ARTIFACT_KEYS = new Set([
  'schemaVersion', 'artifactId', 'kind', 'uri', 'mediaType', 'sha256',
  'sizeBytes', 'createdAt', 'producerInvocationId', 'sensitive',
]);
const LAYOUT_KEYS = new Set(['x', 'y', 'width', 'height', 'z']);
const PREVIEW_KEYS = new Set(['schemaVersion', 'previewArtifactRef', 'sourceSha256', 'observedAt']);
const ITEM_KEYS = new Set(['schemaVersion', 'itemId', 'kind', 'label', 'artifactRef', 'preview', 'layout']);
const CANVAS_KEYS = new Set([
  'schemaVersion', 'canvasId', 'projectId', 'revisionId', 'title',
  'items', 'focusOrder', 'activeItemId', 'createdAt', 'updatedAt',
]);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(message) {
  throw new Error(message);
}

function exactRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !hasOwn(descriptor, 'value')) {
      fail(`${label} fields must be enumerable own data properties`);
    }
    out[key] = descriptor.value;
  }
  return Object.freeze(out);
}

function denseDataArray(value, label, { min = 0, max = MAX_CANVAS_ITEMS } = {}) {
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
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key === 'symbol')) {
    fail(`${label} must contain only canonical data indices`);
  }
  const names = keys.filter(key => key !== 'length');
  if (names.length !== length) {
    fail(`${label} must be a canonical dense array`);
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
  if (typeof value !== 'string' || value.trim() !== value || !ID.test(value)) {
    fail(`${label} must use exact canonical ID representation`);
  }
  return value;
}

function exactText(value, label, max) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > max) {
    fail(`${label} must be exact bounded text`);
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string' || value.trim() !== value) {
    fail(`${label} must use canonical ISO-8601 UTC representation`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    fail(`${label} must use canonical ISO-8601 UTC representation`);
  }
  return value;
}

function exactSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail(`${label} must use exact lowercase SHA-256 representation`);
  }
  return value;
}

function exactInteger(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${label} must be an integer in ${min}..${max}`);
  }
  return value;
}

function exactArtifactRef(input, label) {
  const raw = exactRecord(input, ARTIFACT_KEYS, label);
  if (raw.schemaVersion !== 1) fail(`${label}.schemaVersion must be 1`);
  if (!hasOwn(raw, 'sha256') || raw.sha256 === '') {
    fail(`${label}.sha256 is required for source-bound Canvas identity`);
  }
  const normalized = normalizeArtifactRefV1(raw);
  const exactPairs = [
    ['artifactId', raw.artifactId, normalized.artifactId],
    ['kind', raw.kind, normalized.kind],
    ['uri', raw.uri, normalized.uri],
    ['sha256', raw.sha256, normalized.sha256],
    ['createdAt', raw.createdAt, normalized.createdAt],
  ];
  for (const [field, supplied, canonical] of exactPairs) {
    if (supplied !== canonical) fail(`${label}.${field} must already be canonical`);
  }
  if (hasOwn(raw, 'mediaType') && raw.mediaType !== normalized.mediaType) {
    fail(`${label}.mediaType must already be canonical`);
  }
  if (hasOwn(raw, 'sizeBytes') && raw.sizeBytes !== normalized.sizeBytes) {
    fail(`${label}.sizeBytes must already be canonical`);
  }
  if (hasOwn(raw, 'producerInvocationId') && raw.producerInvocationId !== normalized.producerInvocationId) {
    fail(`${label}.producerInvocationId must already be canonical`);
  }
  if (hasOwn(raw, 'sensitive') && raw.sensitive !== normalized.sensitive) {
    fail(`${label}.sensitive must already be canonical`);
  }
  exactId(normalized.artifactId, `${label}.artifactId`);
  exactId(normalized.kind, `${label}.kind`);
  exactSha256(normalized.sha256, `${label}.sha256`);
  exactTimestamp(normalized.createdAt, `${label}.createdAt`);
  return normalized;
}

function normalizeLayoutV1(input, label) {
  const raw = exactRecord(input, LAYOUT_KEYS, label);
  for (const key of LAYOUT_KEYS) {
    if (!hasOwn(raw, key)) fail(`${label}.${key} is required`);
  }
  return Object.freeze({
    x: exactInteger(raw.x, `${label}.x`, -100000, 100000),
    y: exactInteger(raw.y, `${label}.y`, -100000, 100000),
    width: exactInteger(raw.width, `${label}.width`, 1, 100000),
    height: exactInteger(raw.height, `${label}.height`, 1, 100000),
    z: exactInteger(raw.z, `${label}.z`, 0, 10000),
  });
}

function normalizePreviewBindingV1(input, sourceArtifactRef, label) {
  const raw = exactRecord(input, PREVIEW_KEYS, label);
  if (raw.schemaVersion !== 1) fail(`${label}.schemaVersion must be 1`);
  const sourceSha256 = exactSha256(raw.sourceSha256, `${label}.sourceSha256`);
  if (sourceSha256 !== sourceArtifactRef.sha256) {
    fail(`${label}.sourceSha256 does not bind the Canvas source artifact`);
  }
  const previewArtifactRef = exactArtifactRef(raw.previewArtifactRef, `${label}.previewArtifactRef`);
  if (previewArtifactRef.artifactId === sourceArtifactRef.artifactId) {
    fail(`${label}.previewArtifactRef must be distinct from the source artifact`);
  }
  if (sourceArtifactRef.sensitive === true && previewArtifactRef.sensitive !== true) {
    fail(`${label}.previewArtifactRef cannot downgrade sensitive source material`);
  }
  const observedAt = exactTimestamp(raw.observedAt, `${label}.observedAt`);
  if (Date.parse(previewArtifactRef.createdAt) < Date.parse(sourceArtifactRef.createdAt)) {
    fail(`${label} preview artifact predates its source artifact`);
  }
  if (Date.parse(observedAt) < Date.parse(previewArtifactRef.createdAt)) {
    fail(`${label}.observedAt predates preview materialization`);
  }
  return Object.freeze({
    schemaVersion: 1,
    previewArtifactRef,
    sourceSha256,
    observedAt,
  });
}

function normalizeCanvasItemV1(input, index) {
  const label = `items[${index}]`;
  const raw = exactRecord(input, ITEM_KEYS, label);
  if (raw.schemaVersion !== 1) fail(`${label}.schemaVersion must be 1`);
  const itemId = exactId(raw.itemId, `${label}.itemId`);
  if (typeof raw.kind !== 'string' || !ITEM_KINDS.has(raw.kind)) {
    fail(`${label}.kind is invalid`);
  }
  const artifactRef = exactArtifactRef(raw.artifactRef, `${label}.artifactRef`);
  const preview = raw.preview == null
    ? null
    : normalizePreviewBindingV1(raw.preview, artifactRef, `${label}.preview`);
  return Object.freeze({
    schemaVersion: 1,
    itemId,
    kind: raw.kind,
    label: exactText(raw.label, `${label}.label`, 300),
    artifactRef,
    preview,
    layout: normalizeLayoutV1(raw.layout, `${label}.layout`),
  });
}

function exactIdList(input, label, count) {
  const values = denseDataArray(input, label, { min: count, max: count });
  const out = values.map((value, index) => exactId(value, `${label}[${index}]`));
  return Object.freeze(out);
}

export function normalizeArtifactDesignCanvasV1(input) {
  const raw = exactRecord(input, CANVAS_KEYS, 'ArtifactDesignCanvasV1');
  if (raw.schemaVersion !== ARTIFACT_DESIGN_CANVAS_VERSION) {
    fail('ArtifactDesignCanvasV1.schemaVersion must be 1');
  }
  const createdAt = exactTimestamp(raw.createdAt, 'createdAt');
  const updatedAt = exactTimestamp(raw.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    fail('updatedAt must not predate createdAt');
  }

  const itemInputs = denseDataArray(raw.items, 'items', { min: 1, max: MAX_CANVAS_ITEMS });
  const items = itemInputs.map(normalizeCanvasItemV1);
  const byId = new Map();
  for (const item of items) {
    if (byId.has(item.itemId)) fail(`duplicate Canvas itemId: ${item.itemId}`);
    byId.set(item.itemId, item);
    if (Date.parse(item.artifactRef.createdAt) > Date.parse(updatedAt)) {
      fail(`Canvas item artifact postdates updatedAt: ${item.itemId}`);
    }
    if (item.preview && Date.parse(item.preview.observedAt) > Date.parse(updatedAt)) {
      fail(`Canvas preview observation postdates updatedAt: ${item.itemId}`);
    }
  }

  const focusOrder = exactIdList(raw.focusOrder, 'focusOrder', items.length);
  const focused = new Set();
  for (const itemId of focusOrder) {
    if (focused.has(itemId)) fail(`focusOrder contains duplicate itemId: ${itemId}`);
    if (!byId.has(itemId)) fail(`focusOrder references unknown itemId: ${itemId}`);
    focused.add(itemId);
  }
  if (focused.size !== items.length) fail('focusOrder must include every Canvas item exactly once');

  const activeItemId = exactId(raw.activeItemId, 'activeItemId');
  if (!byId.has(activeItemId)) fail('activeItemId must reference a Canvas item');

  return Object.freeze({
    schemaVersion: 1,
    canvasId: exactId(raw.canvasId, 'canvasId'),
    projectId: exactId(raw.projectId, 'projectId'),
    revisionId: exactId(raw.revisionId, 'revisionId'),
    title: exactText(raw.title, 'title', 300),
    items: Object.freeze(items),
    focusOrder,
    activeItemId,
    createdAt,
    updatedAt,
  });
}

export function buildArtifactDesignCanvasSemanticTwinV1(input) {
  const canvas = normalizeArtifactDesignCanvasV1(input);
  const byId = new Map(canvas.items.map(item => [item.itemId, item]));
  const entries = canvas.focusOrder.map((itemId, index) => {
    const item = byId.get(itemId);
    return Object.freeze({
      schemaVersion: 1,
      ordinal: index + 1,
      itemId,
      label: item.label,
      kind: item.kind,
      active: itemId === canvas.activeItemId,
      artifactId: item.artifactRef.artifactId,
      sourceSha256: item.artifactRef.sha256,
      previewStatus: item.preview ? 'SOURCE_BOUND' : 'MISSING',
      previewArtifactId: item.preview?.previewArtifactRef.artifactId || '',
      keyboardReachable: true,
      visualPosition: item.layout,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    canvasId: canvas.canvasId,
    projectId: canvas.projectId,
    revisionId: canvas.revisionId,
    title: canvas.title,
    activeItemId: canvas.activeItemId,
    itemCount: entries.length,
    keyboardModel: 'LINEAR_FOCUS_ORDER',
    semanticTwinComplete: true,
    coordinateNavigationRequired: false,
    entries: Object.freeze(entries),
  });
}

export function buildArtifactDesignCanvasPreviewManifestV1(input) {
  const canvas = normalizeArtifactDesignCanvasV1(input);
  const byId = new Map(canvas.items.map(item => [item.itemId, item]));
  const entries = canvas.focusOrder.map(itemId => {
    const item = byId.get(itemId);
    return Object.freeze({
      schemaVersion: 1,
      itemId,
      sourceArtifactId: item.artifactRef.artifactId,
      sourceSha256: item.artifactRef.sha256,
      sourceMediaType: item.artifactRef.mediaType,
      sourceSensitive: item.artifactRef.sensitive,
      previewArtifactId: item.preview?.previewArtifactRef.artifactId || '',
      previewSha256: item.preview?.previewArtifactRef.sha256 || '',
      previewMediaType: item.preview?.previewArtifactRef.mediaType || '',
      previewSensitive: item.preview?.previewArtifactRef.sensitive || false,
      previewBindingStatus: item.preview ? 'SOURCE_BOUND' : 'MISSING',
      requiresArtifactResolver: true,
      requiresFreshSourceObservation: true,
      liveSourceFreshnessVerified: false,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    canvasId: canvas.canvasId,
    revisionId: canvas.revisionId,
    entries: Object.freeze(entries),
  });
}

export function assessArtifactDesignCanvasPreviewFreshnessV1(canvasInput, currentArtifactRefsInput) {
  const canvas = normalizeArtifactDesignCanvasV1(canvasInput);
  const currentInputs = denseDataArray(
    currentArtifactRefsInput,
    'currentArtifactRefs',
    { min: 0, max: MAX_CANVAS_ITEMS },
  );
  const currentById = new Map();
  for (let index = 0; index < currentInputs.length; index += 1) {
    const current = exactArtifactRef(currentInputs[index], `currentArtifactRefs[${index}]`);
    if (currentById.has(current.artifactId)) {
      fail(`currentArtifactRefs contains duplicate artifactId: ${current.artifactId}`);
    }
    currentById.set(current.artifactId, current);
  }
  const byId = new Map(canvas.items.map(item => [item.itemId, item]));
  const entries = canvas.focusOrder.map(itemId => {
    const item = byId.get(itemId);
    const current = currentById.get(item.artifactRef.artifactId);
    let status;
    if (!current) status = CanvasPreviewStatus.MISSING_SOURCE;
    else if (current.sha256 !== item.artifactRef.sha256) status = CanvasPreviewStatus.STALE_SOURCE;
    else if (!item.preview) status = CanvasPreviewStatus.PREVIEW_REQUIRED;
    else status = CanvasPreviewStatus.READY;
    return Object.freeze({
      schemaVersion: 1,
      itemId,
      artifactId: item.artifactRef.artifactId,
      expectedSha256: item.artifactRef.sha256,
      currentSha256: current?.sha256 || '',
      status,
      livePreviewReady: status === CanvasPreviewStatus.READY,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    canvasId: canvas.canvasId,
    revisionId: canvas.revisionId,
    allReady: entries.every(entry => entry.livePreviewReady),
    entries: Object.freeze(entries),
  });
}
