import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DRIVE_FOLDER_DISPATCH_PROVIDER_V1,
  DriveFolderDispatchError,
  DriveFolderDispatchProviderV1,
} from '../../src/core/orchestration-drive-folder-provider.js';

const SOURCE = 'folder_dispatch_root';
const GROUP = 'manager:runtime';
const CHILDREN = ['worker:runtime:01', 'worker:runtime:02', 'worker:runtime:03'];
const PROFILES = {
  'worker:runtime:01': ['worker:runtime:01:prompt-v1'],
  'worker:runtime:02': ['worker:runtime:02:prompt-v1'],
  'worker:runtime:03': ['worker:runtime:03:prompt-v1'],
};

function entry(id, name, version = '1', mimeType = 'application/json') {
  return { id, name, version, mimeType, size: '100' };
}

function envelope({
  generation = 41,
  target = 'worker:runtime:01',
  prompt = 'Do bounded runtime work.',
  profile = '',
  order = 0,
  parent = GROUP,
} = {}) {
  const body = {
    schema_version: 1,
    parent_node_id: parent,
    generation,
    target_child_id: target,
    order,
  };
  if (profile) body.prompt_profile_id = profile;
  else body.prompt = prompt;
  return JSON.stringify(body);
}

function provider({
  generations = [{ id: 'g41', name: 'generation-000041' }],
  before = [entry('ready', 'READY', '3', 'text/plain'), entry('d1', 'child-01.json', '7')],
  after = null,
  contents = { d1: envelope() },
} = {}) {
  let listCount = 0;
  return new DriveFolderDispatchProviderV1({
    listGenerations: async ({ sourceId }) => {
      assert.equal(sourceId, SOURCE);
      return structuredClone(generations);
    },
    listGenerationEntries: async () => {
      listCount += 1;
      return structuredClone(listCount === 1 ? before : (after || before));
    },
    readEntryContent: async ({ entry: item }) => contents[item.id],
  });
}

async function read(p) {
  return p.read({
    groupNodeId: GROUP,
    maxWorkers: 3,
    sourceId: SOURCE,
    childNodeIds: CHILDREN,
    childPromptProfileIds: PROFILES,
  });
}

test('L3 provider accepts one stable READY generation and sorts deterministic dispatch order', async () => {
  const before = [
    entry('ready', 'READY', '2', 'text/plain'),
    entry('d2', 'child-02.json', '9'),
    entry('d1', 'child-01.json', '8'),
  ];
  const p = provider({
    generations: [
      { id: 'g40', name: 'generation-000040' },
      { id: 'g41', name: 'generation-000041' },
      { id: 'junk', name: 'notes' },
    ],
    before,
    contents: {
      d1: envelope({ target: 'worker:runtime:01', prompt: 'first', order: 10 }),
      d2: envelope({ target: 'worker:runtime:02', profile: 'worker:runtime:02:prompt-v1', order: 5 }),
    },
  });
  const result = await read(p);
  assert.equal(result.kind, 'READY');
  assert.equal(result.providerId, DRIVE_FOLDER_DISPATCH_PROVIDER_V1);
  assert.equal(result.providerRevision, '41');
  assert.equal(result.generationFolderId, 'g41');
  assert.deepEqual(result.dispatches.map(item => item.targetChildId), ['worker:runtime:02', 'worker:runtime:01']);
  assert.equal(result.dispatches[0].promptProfileId, 'worker:runtime:02:prompt-v1');
  assert.equal(result.dispatches[1].promptPayload, 'first');
});

test('L3 provider refuses generation until exact READY marker exists', async () => {
  const result = await read(provider({
    before: [entry('d1', 'child-01.json', '7')],
  }));
  assert.deepEqual(result, {
    kind: 'NOT_READY',
    providerId: DRIVE_FOLDER_DISPATCH_PROVIDER_V1,
    groupNodeId: GROUP,
    sourceId: SOURCE,
    providerRevision: '41',
  });
});

test('L3 provider is all-or-nothing on unknown or duplicate child targets', async () => {
  await assert.rejects(() => read(provider({
    before: [entry('ready', 'READY'), entry('d1', 'a.json')],
    contents: { d1: envelope({ target: 'worker:foreign:01' }) },
  })), error => error instanceof DriveFolderDispatchError && error.code === 'UNKNOWN_TARGET');

  await assert.rejects(() => read(provider({
    before: [entry('ready', 'READY'), entry('d1', 'a.json'), entry('d2', 'b.json')],
    contents: {
      d1: envelope({ target: 'worker:runtime:01', prompt: 'a' }),
      d2: envelope({ target: 'worker:runtime:01', prompt: 'b' }),
    },
  })), error => error.code === 'DUPLICATE_TARGET');
});

test('L3 provider rejects wrong parent, wrong generation, and unapproved local prompt profile', async () => {
  await assert.rejects(() => read(provider({
    contents: { d1: envelope({ parent: 'manager:other' }) },
  })), error => error.code === 'WRONG_PARENT');

  await assert.rejects(() => read(provider({
    contents: { d1: envelope({ generation: 42 }) },
  })), error => error.code === 'WRONG_GENERATION');

  await assert.rejects(() => read(provider({
    contents: { d1: envelope({ profile: 'arbitrary-profile' }) },
  })), error => error.code === 'PROMPT_PROFILE_NOT_ALLOWED');
});

test('L3 provider detects mutation after READY and launches nothing from unstable generation', async () => {
  const before = [entry('ready', 'READY', '1', 'text/plain'), entry('d1', 'a.json', '7')];
  const after = [entry('ready', 'READY', '1', 'text/plain'), entry('d1', 'a.json', '8')];
  await assert.rejects(() => read(provider({ before, after })), error =>
    error.code === 'UNSTABLE_GENERATION'
  );
});

test('L3 provider rejects over-capacity generation and prompt envelope ambiguity', async () => {
  const many = [
    entry('ready', 'READY'),
    entry('d1', '1.json'), entry('d2', '2.json'), entry('d3', '3.json'), entry('d4', '4.json'),
  ];
  await assert.rejects(() => read(provider({ before: many })), error => error.code === 'OVER_CAPACITY');

  await assert.rejects(() => read(provider({
    contents: {
      d1: JSON.stringify({
        schema_version: 1,
        parent_node_id: GROUP,
        generation: 41,
        target_child_id: 'worker:runtime:01',
        prompt: 'x',
        prompt_profile_id: 'worker:runtime:01:prompt-v1',
      }),
    },
  })), error => error.code === 'INVALID_DISPATCH_FILE');
});
