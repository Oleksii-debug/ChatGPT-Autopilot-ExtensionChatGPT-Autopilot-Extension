import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  authorizeFilesystemPathV1,
  boundReadV1,
  boundSearchResultsV1,
  commitFilesystemMutationV1,
  createFilesystemMutationV1,
  createFilesystemScopeV1,
  markFilesystemExecutingV1,
  observeFilesystemMutationV1,
  recoverFilesystemMutationV1,
  verifyFilesystemMutationV1,
} from '../companion/native-host/filesystem-provider.mjs';

const root = path.resolve('/owner/project');
const scope = createFilesystemScopeV1({ scopeId: 'owner-project', roots: [root], writableRoots: [root] });

test('filesystem scope rejects traversal and sibling-prefix escape', () => {
  assert.equal(authorizeFilesystemPathV1(scope, path.join(root, 'docs/a.txt')), path.resolve(root, 'docs/a.txt'));
  assert.throws(() => authorizeFilesystemPathV1(scope, path.join(root, '..', 'secret.txt')), /outside owner scope/);
  assert.throws(() => authorizeFilesystemPathV1(scope, `${root}-other/file.txt`), /outside owner scope/);
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
