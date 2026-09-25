import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleNativeCompanionRequest } from '../companion/native-host/host-core.mjs';
import {
  searchScopedFilesystemV1,
  writeExistingTextScopedV1,
} from '../companion/native-host/filesystem-host-provider.mjs';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

function digest(value) {
  return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function config(root, writable = false) {
  return {
    schemaVersion: 1,
    allowedOrigin: ORIGIN,
    roots: [{ rootId: 'workspace', path: root, writable }],
  };
}

function request(type, payload, requestId = 'fs-req') {
  return { protocolVersion: 1, requestId, type, payload };
}

test('Native Companion exposes bounded scoped search without leaking outside links', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-search-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  const outside = path.join(temp, 'outside');
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'docs', 'alpha.txt'), 'inside');
  await fs.writeFile(path.join(outside, 'alpha-secret.txt'), 'outside');
  try {
    await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.diagnostic(`symlink unavailable: ${error.code || error.message}`);
  }

  const response = await handleNativeCompanionRequest(request('filesystem.search', {
    rootId: 'workspace', query: 'alpha', maxResults: 10, maxEntries: 100,
  }), { config: config(root), callerOrigin: ORIGIN });
  assert.equal(response.ok, true);
  assert.deepEqual(response.result.items, ['docs/alpha.txt']);
  assert.equal(response.result.items.some(item => item.includes('secret')), false);
});

test('Native Companion does not advertise filesystem write while parent-bound atomic publication is unavailable', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-caps-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);

  const response = await handleNativeCompanionRequest(request('capabilities', {}, 'caps'), {
    config: config(root, true),
    callerOrigin: ORIGIN,
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.capabilities.some(item => item.capabilityId === 'filesystem.writeExistingText'), false);
});

test('valid filesystem write fails closed before any mutation or staging file is created', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-write-closed-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const target = path.join(root, 'note.txt');
  await fs.writeFile(target, 'before', 'utf8');
  let beforeOpenCalls = 0;

  const response = await handleNativeCompanionRequest(request('filesystem.writeExistingText', {
    rootId: 'workspace',
    relativePath: 'note.txt',
    text: 'after',
    expectedSha256: digest('before'),
  }, 'write-closed'), {
    config: config(root, true),
    callerOrigin: ORIGIN,
    fsWriteBeforeOpen: async () => { beforeOpenCalls += 1; },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'ATOMIC_WRITE_UNAVAILABLE');
  assert.equal(beforeOpenCalls, 0);
  assert.equal(await fs.readFile(target, 'utf8'), 'before');
  assert.deepEqual(await fs.readdir(root), ['note.txt']);
});

test('filesystem write digest spelling is exact lowercase SHA-256 and never trimmed or coerced', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-digest-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const target = path.join(root, 'note.txt');
  await fs.writeFile(target, 'before', 'utf8');
  const cfg = config(root, true);
  const good = digest('before');

  for (const expectedSha256 of [123, true, { toString: () => good }, good.toUpperCase(), ` ${good}`, `${good} `]) {
    await assert.rejects(
      () => writeExistingTextScopedV1({
        rootId: 'workspace',
        relativePath: 'note.txt',
        text: 'after',
        expectedSha256,
      }, cfg),
      error => error.code === 'INVALID_REQUEST' && /lowercase SHA-256/.test(error.message),
    );
    assert.equal(await fs.readFile(target, 'utf8'), 'before');
    assert.deepEqual(await fs.readdir(root), ['note.txt']);
  }
});

test('filesystem write rejects exotic payload authority before unavailable-effect gate', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-boundary-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const target = path.join(root, 'note.txt');
  await fs.writeFile(target, 'before', 'utf8');
  const cfg = config(root, true);

  const nonEnumerableWrite = {
    rootId: 'workspace',
    relativePath: 'note.txt',
    text: 'after',
    expectedSha256: digest('before'),
  };
  Object.defineProperty(nonEnumerableWrite, 'expectedSha256', {
    value: digest('before'),
    enumerable: false,
    configurable: true,
  });

  await assert.rejects(
    () => writeExistingTextScopedV1(nonEnumerableWrite, cfg),
    error => error.code === 'INVALID_REQUEST' && /enumerable data property/.test(error.message),
  );
  assert.equal(await fs.readFile(target, 'utf8'), 'before');
});

test('search payload remains strict against coerced bounds and inherited authority', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-search-boundary-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'note.txt'), 'before', 'utf8');
  const cfg = config(root, true);

  const stringBound = await handleNativeCompanionRequest(request('filesystem.search', {
    rootId: 'workspace',
    query: 'note',
    maxResults: '10',
    maxEntries: 100,
  }, 'string-bound'), { config: cfg, callerOrigin: ORIGIN });
  assert.equal(stringBound.ok, false);
  assert.equal(stringBound.error.code, 'INVALID_REQUEST');

  const inheritedSearch = Object.create({
    rootId: 'workspace',
    query: 'note',
    maxResults: 10,
    maxEntries: 100,
  });
  await assert.rejects(
    () => searchScopedFilesystemV1(inheritedSearch, cfg),
    error => error.code === 'INVALID_REQUEST' && /plain object/.test(error.message),
  );
});
