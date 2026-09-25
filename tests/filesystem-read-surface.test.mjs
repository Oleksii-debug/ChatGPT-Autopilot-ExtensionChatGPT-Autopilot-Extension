import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFilesystemScopeV1 } from '../companion/native-host/filesystem-provider.mjs';
import { listFilesystemDirectoryV1, statFilesystemPathV1 } from '../companion/native-host/filesystem-read-surface.mjs';
import { listScopedFilesystemV1, statScopedFilesystemV1 } from '../companion/native-host/filesystem-host-provider.mjs';
import { handleNativeCompanionRequest } from '../companion/native-host/host-core.mjs';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
function digest(value) { return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex'); }
function config(root) { return { schemaVersion: 1, allowedOrigin: ORIGIN, roots: [{ rootId: 'workspace', path: root, writable: false }] }; }
function request(type, payload, requestId) { return { protocolVersion: 1, requestId, type, payload }; }

test('owner-scoped list is deterministic, streamed, bounded and hides link targets', async t => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-list-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'root');
  const outside = path.join(sandbox, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'b.txt'), 'bb');
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  try { await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.diagnostic(`symlink unavailable: ${error.code || error.message}`); }

  const scope = createFilesystemScopeV1({ scopeId: 'owner', roots: [root] });
  const listed = await listFilesystemDirectoryV1(scope, root, { maxEntries: 16 });
  assert.deepEqual(listed.items.map(item => item.name), ['a.txt', 'b.txt', 'docs']);
  assert.deepEqual(listed.items.map(item => item.kind), ['FILE', 'FILE', 'DIRECTORY']);
  assert.equal(listed.items.some(item => item.name === 'escape'), false);

  let readCalls = 0;
  const bounded = await listFilesystemDirectoryV1(scope, root, {
    maxEntries: 1,
    openDirectory: async current => {
      const real = await fs.opendir(current, { bufferSize: 1 });
      return { async read() { readCalls += 1; return real.read(); }, async close() { return real.close(); } };
    },
  });
  assert.equal(readCalls, 1);
  assert.equal(bounded.visitedEntries, 1);
  assert.equal(bounded.truncated, true);
});

test('filesystem stat computes bounded SHA-256 from the admitted regular-file handle', async t => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-stat-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'root'); await fs.mkdir(root);
  const target = path.join(root, 'data.txt'); await fs.writeFile(target, 'hello');
  const scope = createFilesystemScopeV1({ scopeId: 'owner', roots: [root] });
  const metadata = await statFilesystemPathV1(scope, target, { hash: false });
  assert.equal(metadata.kind, 'FILE'); assert.equal(metadata.sizeBytes, 5); assert.equal(metadata.hashed, false); assert.equal(metadata.sha256, '');
  const hashed = await statFilesystemPathV1(scope, target, { hash: true, maxHashBytes: 5 });
  assert.equal(hashed.sha256, digest('hello')); assert.match(hashed.sha256, /^[a-f0-9]{64}$/u);
  await assert.rejects(() => statFilesystemPathV1(scope, target, { hash: true, maxHashBytes: 4 }), /exceeds hash bound/u);
});

test('filesystem stat rejects target substitution before hash open', async t => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-stat-race-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'root'), outside = path.join(sandbox, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  const target = path.join(root, 'data.txt'), parked = path.join(root, 'parked.txt'), secret = path.join(outside, 'secret.txt');
  await fs.writeFile(target, 'inside'); await fs.writeFile(secret, 'outside-secret');
  const scope = createFilesystemScopeV1({ scopeId: 'owner', roots: [root] });
  const probe = path.join(root, 'probe-link');
  try {
    await fs.symlink(secret, probe, 'file');
    await fs.unlink(probe);
  } catch (error) {
    t.diagnostic(`file symlink unavailable: ${error.code || error.message}`);
    return;
  }
  await assert.rejects(() => statFilesystemPathV1(scope, target, {
    hash: true,
    beforeHashOpen: async () => { await fs.rename(target, parked); await fs.symlink(secret, target, 'file'); },
  }), /symbolic link|escapes owner scope|identity changed|ELOOP/iu);
  assert.equal(await fs.readFile(secret, 'utf8'), 'outside-secret');
});

test('Native Companion list/stat keep absolute roots private and advertise read-only capabilities', async t => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-read-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'root'); await fs.mkdir(path.join(root, 'docs'), { recursive: true }); await fs.writeFile(path.join(root, 'docs', 'note.txt'), 'note');
  const listed = await listScopedFilesystemV1({ rootId: 'workspace', relativePath: 'docs', maxEntries: 8 }, config(root));
  assert.deepEqual(listed.items.map(item => item.name), ['note.txt']); assert.equal(JSON.stringify(listed).includes(root), false);
  const stated = await statScopedFilesystemV1({ rootId: 'workspace', relativePath: 'docs/note.txt', hash: true, maxHashBytes: 1024 }, config(root));
  assert.equal(stated.sha256, digest('note')); assert.equal(JSON.stringify(stated).includes(root), false);

  const caps = await handleNativeCompanionRequest(request('capabilities', {}, 'caps-fs-read'), { config: config(root), callerOrigin: ORIGIN });
  assert.equal(caps.ok, true);
  assert.equal(caps.result.capabilities.some(item => item.capabilityId === 'filesystem.list' && item.readOnly === true), true);
  assert.equal(caps.result.capabilities.some(item => item.capabilityId === 'filesystem.stat' && item.readOnly === true), true);
  const listResponse = await handleNativeCompanionRequest(request('filesystem.list', { rootId: 'workspace', relativePath: 'docs', maxEntries: 8 }, 'list-fs-read'), { config: config(root), callerOrigin: ORIGIN });
  assert.equal(listResponse.ok, true); assert.deepEqual(listResponse.result.items.map(item => item.name), ['note.txt']);
  const statResponse = await handleNativeCompanionRequest(request('filesystem.stat', { rootId: 'workspace', relativePath: 'docs/note.txt', hash: true, maxHashBytes: 1024 }, 'stat-fs-read'), { config: config(root), callerOrigin: ORIGIN });
  assert.equal(statResponse.ok, true); assert.equal(statResponse.result.sha256, digest('note'));
});

test('list/stat adapter payloads reject coercive bounds and inherited authority', async t => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-read-boundary-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'root'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'note.txt'), 'note');
  const cfg = config(root);
  await assert.rejects(() => listScopedFilesystemV1({ rootId: 'workspace', relativePath: '.', maxEntries: '1' }, cfg), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(() => statScopedFilesystemV1({ rootId: 'workspace', relativePath: 'note.txt', hash: 'true' }, cfg), error => error.code === 'INVALID_REQUEST');
  const inherited = Object.create({ rootId: 'workspace', relativePath: '.', maxEntries: 1 });
  await assert.rejects(() => listScopedFilesystemV1(inherited, cfg), error => error.code === 'INVALID_REQUEST' && /plain object/u.test(error.message));
});