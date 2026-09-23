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
  commitFilesystemMutationV1,
  createFilesystemMutationV1,
  createFilesystemScopeV1,
  markFilesystemExecutingV1,
  observeFilesystemMutationV1,
  readFilesystemFileV1,
  recoverFilesystemMutationV1,
  verifyFilesystemMutationV1,
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

test('mutation exact-effect lifecycle commits only verified observation', () => {
  const prepared = createFilesystemMutationV1({ effectId: 'fx-1', operation: 'WRITE', sourcePath: path.join(root, 'a.txt'), scope, nowMs: 1 });
  const executing = markFilesystemExecutingV1(prepared, 2);
  const observed = observeFilesystemMutationV1(executing, { exists: true, sha256: 'abc' }, 3);
  const verified = verifyFilesystemMutationV1(observed, true, 4);
  const committed = commitFilesystemMutationV1(verified, 5);
  assert.equal(committed.state, 'COMMITTED');
  assert.throws(() => commitFilesystemMutationV1(observed), /must be VERIFIED/);
});

test('restart never blindly replays an uncertain mutation', () => {
  const prepared = createFilesystemMutationV1({ effectId: 'fx-2', operation: 'DELETE', sourcePath: path.join(root, 'a.txt'), scope, nowMs: 1 });
  assert.equal(recoverFilesystemMutationV1(prepared).recovery, 'SAFE_RETRY');
  const executing = markFilesystemExecutingV1(prepared, 2);
  const recovered = recoverFilesystemMutationV1(executing);
  assert.equal(recovered.state, 'AMBIGUOUS');
  assert.equal(recovered.recovery, 'RECONCILE');
  assert.equal(recovered.reconcileRequired, true);
});

test('failed independent verification becomes ambiguous rather than retryable', () => {
  const prepared = createFilesystemMutationV1({ effectId: 'fx-3', operation: 'WRITE', sourcePath: path.join(root, 'a.txt'), scope, nowMs: 1 });
  const observed = observeFilesystemMutationV1(markFilesystemExecutingV1(prepared, 2), { exists: false }, 3);
  const ambiguous = verifyFilesystemMutationV1(observed, false, 4);
  assert.equal(ambiguous.state, 'AMBIGUOUS');
  assert.equal(ambiguous.reconcileRequired, true);
});
