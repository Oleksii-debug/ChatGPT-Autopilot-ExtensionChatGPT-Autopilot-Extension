import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DriveFolderDispatchError,
  DriveFolderDispatchProviderV1,
} from '../../src/core/orchestration-drive-folder-provider.js';
import { L3_DRIVE_FOLDER_FIXTURES } from '../fixtures/l3-drive-folder-dispatch-fixtures.js';

function clone(value) {
  return structuredClone(value);
}

function resolveFixture(name) {
  const raw = L3_DRIVE_FOLDER_FIXTURES[name];
  if (!raw) throw new Error(`Unknown fixture ${name}`);
  if (!raw.base) return clone(raw);

  const base = resolveFixture(raw.base);
  if (raw.contentsPatch) base.contents = { ...base.contents, ...clone(raw.contentsPatch) };
  if (Array.isArray(raw.entriesFilter)) {
    const keep = new Set(raw.entriesFilter);
    base.entries = base.entries.filter(item => keep.has(item.id));
  }
  return { ...base, expectedError: raw.expectedError, expectedKind: raw.expectedKind };
}

function makeProvider(fixture, { unstableRoot = false, unstableEntries = false } = {}) {
  let rootReads = 0;
  let entryReads = 0;
  return new DriveFolderDispatchProviderV1({
    listGenerations: async () => {
      rootReads += 1;
      if (unstableRoot && rootReads > 1) {
        return [
          ...clone(fixture.generations),
          { id: 'newer-generation', name: 'generation-999999' },
        ];
      }
      return clone(fixture.generations);
    },
    listGenerationEntries: async () => {
      entryReads += 1;
      if (unstableEntries && entryReads > 1) {
        return fixture.entries.map((item, index) =>
          index === fixture.entries.length - 1
            ? { ...clone(item), version: String(Number(item.version || 0) + 1) }
            : clone(item)
        );
      }
      return clone(fixture.entries);
    },
    readEntryContent: async ({ entry }) => fixture.contents[entry.id],
  });
}

async function runFixture(fixture, options = {}) {
  const provider = makeProvider(fixture, options);
  return provider.read({
    groupNodeId: fixture.groupNodeId,
    maxWorkers: fixture.maxWorkers,
    sourceId: fixture.sourceId,
    childNodeIds: fixture.childNodeIds,
    childPromptProfileIds: fixture.childPromptProfileIds,
  });
}

test('L3-B fixture: valid Director -> Managers READY generation is consumable', async () => {
  const fixture = resolveFixture('validDirectorToManagers');
  const result = await runFixture(fixture);
  assert.equal(result.kind, 'READY');
  assert.equal(result.providerRevision, '101');
  assert.deepEqual(result.dispatches.map(item => item.targetChildId), fixture.expectedTargets);
});

test('L3-B fixture: valid Manager -> Workers generation preserves deterministic order', async () => {
  const fixture = resolveFixture('validManagerToWorkers');
  const result = await runFixture(fixture);
  assert.equal(result.kind, 'READY');
  assert.equal(result.providerRevision, '41');
  assert.deepEqual(result.dispatches.map(item => item.targetChildId), fixture.expectedTargets);
});

for (const name of ['malformedEnvelope', 'duplicateSlot', 'wrongParent']) {
  test(`L3-B fixture: ${name} fails closed atomically`, async () => {
    const fixture = resolveFixture(name);
    await assert.rejects(
      () => runFixture(fixture),
      error => error instanceof DriveFolderDispatchError && error.code === fixture.expectedError,
    );
  });
}

test('L3-B fixture: partial/unready generation produces no dispatch', async () => {
  const fixture = resolveFixture('partialUnready');
  const result = await runFixture(fixture);
  assert.equal(result.kind, fixture.expectedKind);
  assert.equal(result.dispatches, undefined);
});

test('L3-B fixture: unstable generation entries fail closed', async () => {
  const fixture = resolveFixture('validManagerToWorkers');
  await assert.rejects(
    () => runFixture(fixture, { unstableEntries: true }),
    error => error instanceof DriveFolderDispatchError && error.code === 'UNSTABLE_GENERATION',
  );
});

test('L3-B fixture: unstable root generation inventory fails closed', async () => {
  const fixture = resolveFixture('validManagerToWorkers');
  await assert.rejects(
    () => runFixture(fixture, { unstableRoot: true }),
    error => error instanceof DriveFolderDispatchError && error.code === 'UNSTABLE_GENERATION',
  );
});

test('L3-B fixture: identical prompt in generations 41 and 45 still yields distinct dispatch identities', async () => {
  const first = await runFixture(resolveFixture('samePromptGeneration41'));
  const second = await runFixture(resolveFixture('samePromptGeneration45'));

  assert.equal(first.kind, 'READY');
  assert.equal(second.kind, 'READY');
  assert.equal(first.dispatches[0].promptPayload, second.dispatches[0].promptPayload);
  assert.equal(first.providerRevision, '41');
  assert.equal(second.providerRevision, '45');
  assert.notEqual(first.dispatches[0].dispatchIdentity, second.dispatches[0].dispatchIdentity);
  assert.notEqual(first.snapshotHash, second.snapshotHash);
});
