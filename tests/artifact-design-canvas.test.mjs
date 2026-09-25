import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanvasPreviewStatus,
  assessArtifactDesignCanvasPreviewFreshnessV1,
  buildArtifactDesignCanvasPreviewManifestV1,
  buildArtifactDesignCanvasSemanticTwinV1,
  normalizeArtifactDesignCanvasV1,
} from '../src/core/artifact-design-canvas.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

function artifact({
  artifactId,
  sha256,
  createdAt,
  kind = 'artifact',
  uri = `artifact://${artifactId}`,
  mediaType = 'application/octet-stream',
  sensitive = false,
} = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind,
    uri,
    mediaType,
    sha256,
    sizeBytes: 128,
    createdAt,
    producerInvocationId: 'inv-1',
    sensitive,
  };
}

function validCanvas() {
  const sourceA = artifact({
    artifactId: 'artifact-a',
    sha256: SHA_A,
    createdAt: '2026-09-25T04:00:00.000Z',
    kind: 'image',
    mediaType: 'image/png',
    sensitive: true,
  });
  const sourceB = artifact({
    artifactId: 'artifact-b',
    sha256: SHA_B,
    createdAt: '2026-09-25T04:30:00.000Z',
    kind: 'document',
    mediaType: 'text/markdown',
  });
  const previewA = artifact({
    artifactId: 'preview-a',
    sha256: SHA_C,
    createdAt: '2026-09-25T05:00:00.000Z',
    kind: 'preview',
    mediaType: 'image/png',
  });

  return {
    schemaVersion: 1,
    canvasId: 'canvas-1',
    projectId: 'project-1',
    revisionId: 'canvas-rev-1',
    title: 'Launch assets',
    items: [
      {
        schemaVersion: 1,
        itemId: 'item-a',
        kind: 'IMAGE',
        label: 'Hero image',
        artifactRef: sourceA,
        preview: {
          schemaVersion: 1,
          previewArtifactRef: previewA,
          sourceSha256: SHA_A,
          observedAt: '2026-09-25T05:01:00.000Z',
        },
        layout: { x: 20, y: 10, width: 800, height: 450, z: 1 },
      },
      {
        schemaVersion: 1,
        itemId: 'item-b',
        kind: 'DOCUMENT',
        label: 'Launch copy',
        artifactRef: sourceB,
        preview: null,
        layout: { x: 20, y: 500, width: 800, height: 600, z: 2 },
      },
    ],
    focusOrder: ['item-b', 'item-a'],
    activeItemId: 'item-b',
    createdAt: '2026-09-25T03:00:00.000Z',
    updatedAt: '2026-09-25T05:02:00.000Z',
  };
}

test('Canvas normalizes exact source-bound artifacts and keeps visual layout separate from focus order', () => {
  const canvas = normalizeArtifactDesignCanvasV1(validCanvas());
  assert.equal(canvas.canvasId, 'canvas-1');
  assert.equal(canvas.items.length, 2);
  assert.deepEqual(canvas.focusOrder, ['item-b', 'item-a']);
  assert.equal(canvas.items[0].preview.sourceSha256, SHA_A);
  assert.equal(canvas.items[0].layout.x, 20);
  assert.equal(Object.isFrozen(canvas), true);
  assert.equal(Object.isFrozen(canvas.items), true);
  assert.equal(Object.isFrozen(canvas.items[0].layout), true);
});

test('semantic twin is complete, deterministic, keyboard-first, and does not expose artifact URI/content', () => {
  const twin = buildArtifactDesignCanvasSemanticTwinV1(validCanvas());
  assert.equal(twin.keyboardModel, 'LINEAR_FOCUS_ORDER');
  assert.equal(twin.semanticTwinComplete, true);
  assert.equal(twin.coordinateNavigationRequired, false);
  assert.equal(twin.itemCount, 2);
  assert.deepEqual(twin.entries.map(entry => entry.itemId), ['item-b', 'item-a']);
  assert.deepEqual(twin.entries.map(entry => entry.ordinal), [1, 2]);
  assert.equal(twin.entries[0].active, true);
  assert.equal(twin.entries[1].previewStatus, 'SOURCE_BOUND');
  assert.equal(twin.entries[0].previewStatus, 'MISSING');
  for (const entry of twin.entries) {
    assert.equal(entry.keyboardReachable, true);
    assert.equal(Object.hasOwn(entry, 'uri'), false);
    assert.equal(Object.hasOwn(entry, 'sensitive'), false);
  }
});

test('preview manifest remains source-bound and never claims live freshness without current evidence', () => {
  const manifest = buildArtifactDesignCanvasPreviewManifestV1(validCanvas());
  assert.equal(manifest.entries.length, 2);
  const previewed = manifest.entries.find(entry => entry.itemId === 'item-a');
  const missing = manifest.entries.find(entry => entry.itemId === 'item-b');
  assert.equal(previewed.previewBindingStatus, 'SOURCE_BOUND');
  assert.equal(previewed.sourceArtifactId, 'artifact-a');
  assert.equal(previewed.sourceSha256, SHA_A);
  assert.equal(previewed.previewArtifactId, 'preview-a');
  assert.equal(previewed.previewSha256, SHA_C);
  assert.equal(previewed.requiresArtifactResolver, true);
  assert.equal(previewed.requiresFreshSourceObservation, true);
  assert.equal(previewed.liveSourceFreshnessVerified, false);
  assert.equal(Object.hasOwn(previewed, 'sourceArtifactRef'), false);
  assert.equal(Object.hasOwn(previewed, 'previewArtifactRef'), false);
  assert.equal(Object.hasOwn(previewed, 'uri'), false);
  assert.equal(missing.previewBindingStatus, 'MISSING');
  assert.equal(missing.previewArtifactId, '');
  assert.equal(missing.previewSha256, '');
});

test('freshness assessment distinguishes ready, preview-required, stale, and missing source states', () => {
  const canvas = validCanvas();
  const currentA = structuredClone(canvas.items[0].artifactRef);
  const currentB = structuredClone(canvas.items[1].artifactRef);
  const first = assessArtifactDesignCanvasPreviewFreshnessV1(canvas, [currentA, currentB]);
  assert.equal(first.allReady, false);
  assert.deepEqual(
    first.entries.map(entry => [entry.itemId, entry.status]),
    [
      ['item-b', CanvasPreviewStatus.PREVIEW_REQUIRED],
      ['item-a', CanvasPreviewStatus.READY],
    ],
  );

  const changedA = artifact({
    artifactId: 'artifact-a',
    sha256: SHA_D,
    createdAt: '2026-09-25T06:00:00.000Z',
    kind: 'image',
    mediaType: 'image/png',
    sensitive: true,
  });
  const stale = assessArtifactDesignCanvasPreviewFreshnessV1(canvas, [changedA]);
  assert.equal(stale.entries.find(entry => entry.itemId === 'item-a').status, CanvasPreviewStatus.STALE_SOURCE);
  assert.equal(stale.entries.find(entry => entry.itemId === 'item-b').status, CanvasPreviewStatus.MISSING_SOURCE);
  assert.equal(stale.allReady, false);
});

test('focusOrder must contain every item exactly once and activeItemId must exist', () => {
  const duplicate = validCanvas();
  duplicate.focusOrder = ['item-a', 'item-a'];
  assert.throws(() => normalizeArtifactDesignCanvasV1(duplicate), /duplicate itemId/);

  const unknown = validCanvas();
  unknown.focusOrder = ['item-a', 'item-c'];
  assert.throws(() => normalizeArtifactDesignCanvasV1(unknown), /unknown itemId/);

  const missingActive = validCanvas();
  missingActive.activeItemId = 'item-c';
  assert.throws(() => normalizeArtifactDesignCanvasV1(missingActive), /activeItemId/);
});

test('duplicate Canvas item identity is rejected', () => {
  const canvas = validCanvas();
  canvas.items[1].itemId = 'item-a';
  canvas.focusOrder = ['item-a', 'item-a'];
  assert.throws(() => normalizeArtifactDesignCanvasV1(canvas), /duplicate Canvas itemId/);
});

test('preview must bind the exact source SHA and obey source -> preview -> observation chronology', () => {
  const mismatch = validCanvas();
  mismatch.items[0].preview.sourceSha256 = SHA_B;
  assert.throws(() => normalizeArtifactDesignCanvasV1(mismatch), /does not bind/);

  const previewBeforeSource = validCanvas();
  previewBeforeSource.items[0].preview.previewArtifactRef.createdAt = '2026-09-25T03:59:59.000Z';
  assert.throws(() => normalizeArtifactDesignCanvasV1(previewBeforeSource), /predates its source/);

  const observationBeforePreview = validCanvas();
  observationBeforePreview.items[0].preview.observedAt = '2026-09-25T04:59:59.000Z';
  assert.throws(() => normalizeArtifactDesignCanvasV1(observationBeforePreview), /predates preview materialization/);

  const observationAfterCanvas = validCanvas();
  observationAfterCanvas.items[0].preview.observedAt = '2026-09-25T05:03:00.000Z';
  assert.throws(() => normalizeArtifactDesignCanvasV1(observationAfterCanvas), /postdates updatedAt/);
});

test('source and preview artifacts require exact canonical IDs, lowercase SHA, and canonical timestamps', () => {
  const paddedId = validCanvas();
  paddedId.items[0].artifactRef.artifactId = ' artifact-a';
  assert.throws(() => normalizeArtifactDesignCanvasV1(paddedId), /artifactId must already be canonical|exact canonical ID/);

  const uppercaseDigest = validCanvas();
  uppercaseDigest.items[0].artifactRef.sha256 = SHA_A.toUpperCase();
  assert.throws(() => normalizeArtifactDesignCanvasV1(uppercaseDigest), /sha256 must already be canonical|lowercase SHA-256/);

  const timestampAlias = validCanvas();
  timestampAlias.items[0].artifactRef.createdAt = '2026-09-25T04:00:00Z';
  assert.throws(() => normalizeArtifactDesignCanvasV1(timestampAlias), /createdAt must already be canonical|canonical ISO-8601/);

  const canvasTimestampAlias = validCanvas();
  canvasTimestampAlias.updatedAt = '2026-09-25T05:02:00Z';
  assert.throws(() => normalizeArtifactDesignCanvasV1(canvasTimestampAlias), /canonical ISO-8601/);
});

test('Canvas rejects item artifacts and preview observations from the future of its revision', () => {
  const sourceFuture = validCanvas();
  sourceFuture.items[1].artifactRef.createdAt = '2026-09-25T05:03:00.000Z';
  assert.throws(() => normalizeArtifactDesignCanvasV1(sourceFuture), /artifact postdates updatedAt/);

  const canvasTime = validCanvas();
  canvasTime.updatedAt = '2026-09-25T02:59:59.000Z';
  assert.throws(() => normalizeArtifactDesignCanvasV1(canvasTime), /must not predate createdAt/);
});

test('top-level and nested accessor fields fail without executing getters', () => {
  let reads = 0;
  const top = validCanvas();
  Object.defineProperty(top, 'canvasId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'canvas-evil';
    },
  });
  assert.throws(() => normalizeArtifactDesignCanvasV1(top), /enumerable own data properties/);
  assert.equal(reads, 0);

  const nested = validCanvas();
  Object.defineProperty(nested.items[0].layout, 'x', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 999;
    },
  });
  assert.throws(() => normalizeArtifactDesignCanvasV1(nested), /enumerable own data properties/);
  assert.equal(reads, 0);

  const artifactGetter = validCanvas();
  Object.defineProperty(artifactGetter.items[0].artifactRef, 'sha256', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return SHA_D;
    },
  });
  assert.throws(() => normalizeArtifactDesignCanvasV1(artifactGetter), /enumerable own data properties/);
  assert.equal(reads, 0);
});

test('dense Canvas arrays are snapshotted without ordinary Proxy reads', () => {
  let reads = 0;
  const wrap = value => new Proxy(value, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const canvas = validCanvas();
  canvas.items = wrap(canvas.items);
  canvas.focusOrder = wrap(canvas.focusOrder);
  const normalized = normalizeArtifactDesignCanvasV1(canvas);
  assert.equal(normalized.items.length, 2);
  assert.equal(reads, 0);

  const currentRefs = normalized.items.map(item => structuredClone(item.artifactRef));
  reads = 0;
  const current = wrap(currentRefs);
  assessArtifactDesignCanvasPreviewFreshnessV1(canvas, current);
  assert.equal(reads, 0);
});

test('hidden, symbol, unknown, exotic, and sparse Canvas data fail closed', () => {
  const hidden = validCanvas();
  Object.defineProperty(hidden.items[0], 'secret', {
    value: 'hidden',
    enumerable: false,
  });
  assert.throws(() => normalizeArtifactDesignCanvasV1(hidden), /unknown field/);

  const symbol = validCanvas();
  symbol.items[0][Symbol('authority')] = 'ALLOW';
  assert.throws(() => normalizeArtifactDesignCanvasV1(symbol), /unknown field/);

  const unknown = validCanvas();
  unknown.items[0].authority = 'ALLOW';
  assert.throws(() => normalizeArtifactDesignCanvasV1(unknown), /unknown field/);

  const exotic = validCanvas();
  exotic.items[0].layout = Object.assign(Object.create({ x: 20 }), {
    y: 10, width: 100, height: 100, z: 1,
  });
  assert.throws(() => normalizeArtifactDesignCanvasV1(exotic), /plain object/);

  const sparse = validCanvas();
  sparse.items = [sparse.items[0], , sparse.items[1]];
  sparse.focusOrder = ['item-a', 'item-b', 'item-a'];
  assert.throws(() => normalizeArtifactDesignCanvasV1(sparse), /canonical dense array/);
});

test('layout values do not accept numeric aliases and visual coordinates do not define keyboard order', () => {
  const alias = validCanvas();
  alias.items[0].layout.x = '20';
  assert.throws(() => normalizeArtifactDesignCanvasV1(alias), /must be an integer/);

  const canvas = validCanvas();
  canvas.items[0].layout.y = 9000;
  canvas.items[1].layout.y = -9000;
  const twin = buildArtifactDesignCanvasSemanticTwinV1(canvas);
  assert.deepEqual(twin.entries.map(entry => entry.itemId), ['item-b', 'item-a']);
});

test('current artifact evidence rejects duplicate identities and coercive current-state aliases', () => {
  const canvas = validCanvas();
  const currentA = structuredClone(canvas.items[0].artifactRef);
  assert.throws(
    () => assessArtifactDesignCanvasPreviewFreshnessV1(canvas, [currentA, structuredClone(currentA)]),
    /duplicate artifactId/,
  );

  const alias = structuredClone(currentA);
  alias.sha256 = SHA_A.toUpperCase();
  assert.throws(
    () => assessArtifactDesignCanvasPreviewFreshnessV1(canvas, [alias]),
    /sha256 must already be canonical|lowercase SHA-256/,
  );
});
