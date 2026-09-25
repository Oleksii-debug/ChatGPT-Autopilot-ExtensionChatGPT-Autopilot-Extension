import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {
  authorizeFilesystemPathAtIoV1,
  authorizeFilesystemPathV1,
  boundReadV1,
  boundSearchResultsV1,
  createFilesystemScopeV1,
  readFilesystemFileV1,
  searchFilesystemV1,
  withAuthorizedExistingFileV1,
} from '../companion/native-host/filesystem-provider.mjs';

const root = path.resolve('/owner/project');
const scope = createFilesystemScopeV1({ scopeId: 'owner-project', roots: [root], writableRoots: [root] });

test('filesystem scope rejects traversal and sibling-prefix escape', () => {
  assert.equal(authorizeFilesystemPathV1(scope, path.join(root, 'docs/a.txt')), path.resolve(root, 'docs/a.txt'));
  assert.throws(() => authorizeFilesystemPathV1(scope, path.join(root, '..', 'secret.txt')), /outside owner scope/);
  assert.throws(() => authorizeFilesystemPathV1(scope, `${root}-other/file.txt`), /outside owner scope/);
});

test('I/O fence rejects symlink escape for reads and missing write destinations', async t => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const owned = path.join(sandbox, 'owned');
  const outside = path.join(sandbox, 'outside');
  await fs.mkdir(owned);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await fs.symlink(outside, path.join(owned, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const ioScope = createFilesystemScopeV1({ scopeId: 'io-owner', roots: [owned], writableRoots: [owned] });
  await assert.rejects(authorizeFilesystemPathAtIoV1(ioScope, path.join(owned, 'escape', 'secret.txt')), /escapes owner scope/);
  await assert.rejects(authorizeFilesystemPathAtIoV1(ioScope, path.join(owned, 'escape', 'new.txt'), { write: true }), /escapes owner scope/);
  assert.equal(await authorizeFilesystemPathAtIoV1(ioScope, path.join(owned, 'new.txt'), { write: true }), path.join(owned, 'new.txt'));
});

test('real read is handle-bound, bounded, and rejects a target swapped after admission', async t => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-io-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const owned = path.join(sandbox, 'owned');
  const outside = path.join(sandbox, 'outside');
  await fs.mkdir(owned);
  await fs.mkdir(outside);
  const target = path.join(owned, 'data.txt');
  const secret = path.join(outside, 'secret.txt');
  await fs.writeFile(target, 'abcdef');
  await fs.writeFile(secret, 'outside-secret');
  const ioScope = createFilesystemScopeV1({ scopeId: 'handle-owner', roots: [owned], writableRoots: [owned] });

  const read = await readFilesystemFileV1(ioScope, target, { maxBytes: 3 });
  assert.equal(read.bytes.toString(), 'abc');
  assert.equal(read.truncated, true);

  await assert.rejects(readFilesystemFileV1(ioScope, target, {
    beforeOpen: async () => {
      await fs.rm(target);
      await fs.symlink(secret, target, 'file');
    },
  }), /symbolic link|escapes owner scope|identity changed|ELOOP/i);
});

test('existing-file write boundary checks object identity before invoking effect callback', async t => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-write-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const owned = path.join(sandbox, 'owned');
  const outside = path.join(sandbox, 'outside');
  await fs.mkdir(owned);
  await fs.mkdir(outside);
  const target = path.join(owned, 'data.txt');
  const secret = path.join(outside, 'secret.txt');
  await fs.writeFile(target, 'owned');
  await fs.writeFile(secret, 'secret');
  const ioScope = createFilesystemScopeV1({ scopeId: 'write-owner', roots: [owned], writableRoots: [owned] });
  let effectCalled = false;
  await assert.rejects(withAuthorizedExistingFileV1(ioScope, target, {
    write: true,
    beforeOpen: async () => {
      await fs.rm(target);
      await fs.symlink(secret, target, 'file');
    },
  }, async () => { effectCalled = true; }), /symbolic link|escapes owner scope|identity changed|ELOOP/i);
  assert.equal(effectCalled, false);
  assert.equal(await fs.readFile(secret, 'utf8'), 'secret');
});

test('owner-scoped search is deterministic, bounded, and never follows symlinks', async t => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-search-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const owned = path.join(sandbox, 'owned');
  const outside = path.join(sandbox, 'outside');
  await fs.mkdir(path.join(owned, 'docs'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(owned, 'docs', 'alpha-note.txt'), 'a');
  await fs.writeFile(path.join(owned, 'docs', 'alpha-two.txt'), 'b');
  await fs.writeFile(path.join(outside, 'alpha-secret.txt'), 'secret');
  await fs.symlink(outside, path.join(owned, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const ioScope = createFilesystemScopeV1({ scopeId: 'search-owner', roots: [owned] });

  const found = await searchFilesystemV1(ioScope, owned, 'ALPHA', { maxResults: 1 });
  assert.deepEqual(found.items, ['docs/alpha-note.txt']);
  assert.equal(found.truncated, true);
  assert.ok(found.visitedEntries >= 3);
  assert.equal(found.items.some(item => item.includes('secret')), false);

  const workBound = await searchFilesystemV1(ioScope, owned, 'alpha', { maxEntries: 1 });
  assert.equal(workBound.truncated, true);
  assert.equal(workBound.visitedEntries, 1);
  await assert.rejects(searchFilesystemV1(ioScope, outside, 'alpha'), /outside owner scope/);
});

test('search enumeration itself never reads beyond maxEntries budget', async t => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-search-budget-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const owned = path.join(sandbox, 'owned');
  await fs.mkdir(owned);
  for (let index = 0; index < 32; index += 1) {
    await fs.writeFile(path.join(owned, `item-${String(index).padStart(2, '0')}.txt`), String(index));
  }
  const ioScope = createFilesystemScopeV1({ scopeId: 'search-budget-owner', roots: [owned] });
  let readCalls = 0;
  let opens = 0;
  const result = await searchFilesystemV1(ioScope, owned, 'item', {
    maxEntries: 1,
    maxResults: 1,
    openDirectory: async current => {
      opens += 1;
      const real = await fs.opendir(current, { bufferSize: 1 });
      return {
        async read() {
          readCalls += 1;
          return real.read();
        },
        async close() { return real.close(); },
      };
    },
  });
  assert.equal(opens, 1);
  assert.equal(readCalls, 1, 'maxEntries=1 must perform exactly one directory read, not materialize the directory');
  assert.equal(result.visitedEntries, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.items.length, 1);
});

test('search fails closed when a queued directory is swapped to an outside link before enumeration', async t => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-search-race-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const owned = path.join(sandbox, 'owned');
  const docs = path.join(owned, 'docs');
  const parkedDocs = path.join(owned, 'docs-original');
  const outside = path.join(sandbox, 'outside');
  await fs.mkdir(docs, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(docs, 'alpha-inside.txt'), 'inside');
  await fs.writeFile(path.join(outside, 'alpha-secret.txt'), 'secret');
  const ioScope = createFilesystemScopeV1({ scopeId: 'search-race-owner', roots: [owned] });
  let swapped = false;

  await assert.rejects(searchFilesystemV1(ioScope, owned, 'alpha', {
    beforeEnumerate: async current => {
      if (swapped || path.resolve(current) !== path.resolve(docs)) return;
      swapped = true;
      await fs.rename(docs, parkedDocs);
      await fs.symlink(outside, docs, process.platform === 'win32' ? 'junction' : 'dir');
    },
  }), /escapes owner scope|identity changed|symbolic link|reparse/i);
  assert.equal(swapped, true);
});

test('write scope cannot exceed readable owner scope', () => {
  assert.throws(() => createFilesystemScopeV1({ scopeId: 'bad', roots: [root], writableRoots: [path.resolve('/other')] }), /Writable root/);
});

test('reads and searches are bounded with deterministic evidence', () => {
  const read = boundReadV1(Buffer.from('abcdef'), { maxBytes: 3 });
  assert.equal(read.bytes.toString(), 'abc');
  assert.equal(read.truncated, true);
  assert.match(read.sha256, /^[0-9a-f]{64}$/);
  const search = boundSearchResultsV1(['a', 'b', 'c'], { maxResults: 2 });
  assert.deepEqual(search.items, ['a', 'b']);
  assert.equal(search.truncated, true);
});
