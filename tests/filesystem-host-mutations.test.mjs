import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleNativeCompanionRequest } from '../companion/native-host/host-core.mjs';

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

test('existing-text mutation is writable-root gated, digest fenced, verified, and idempotently observable', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-write-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const target = path.join(root, 'note.txt');
  await fs.writeFile(target, 'before', 'utf8');
  const payload = {
    rootId: 'workspace',
    relativePath: 'note.txt',
    text: 'after',
    expectedSha256: digest('before'),
  };

  const denied = await handleNativeCompanionRequest(request('filesystem.writeExistingText', payload, 'readonly'), {
    config: config(root, false), callerOrigin: ORIGIN,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'ROOT_NOT_WRITABLE');
  assert.equal(await fs.readFile(target, 'utf8'), 'before');

  const wrongPrecondition = await handleNativeCompanionRequest(request('filesystem.writeExistingText', {
    ...payload, expectedSha256: digest('other'),
  }, 'wrong-sha'), { config: config(root, true), callerOrigin: ORIGIN });
  assert.equal(wrongPrecondition.ok, false);
  assert.equal(wrongPrecondition.error.code, 'PRECONDITION_FAILED');
  assert.equal(await fs.readFile(target, 'utf8'), 'before');

  const written = await handleNativeCompanionRequest(request('filesystem.writeExistingText', payload, 'write'), {
    config: config(root, true), callerOrigin: ORIGIN,
  });
  assert.equal(written.ok, true);
  assert.equal(written.result.beforeSha256, digest('before'));
  assert.equal(written.result.sha256, digest('after'));
  assert.equal(written.result.alreadyApplied, false);
  assert.equal(await fs.readFile(target, 'utf8'), 'after');

  const reconciledObservation = await handleNativeCompanionRequest(request('filesystem.writeExistingText', payload, 'repeat'), {
    config: config(root, true), callerOrigin: ORIGIN,
  });
  assert.equal(reconciledObservation.ok, true);
  assert.equal(reconciledObservation.result.sha256, digest('after'));
  assert.equal(reconciledObservation.result.alreadyApplied, true);
  assert.equal(await fs.readFile(target, 'utf8'), 'after');
});

test('existing-text mutation fails closed if target is swapped to an outside symlink after admission', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-swap-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const target = path.join(root, 'note.txt');
  const outside = path.join(temp, 'secret.txt');
  await fs.writeFile(target, 'before', 'utf8');
  await fs.writeFile(outside, 'secret', 'utf8');
  let swapped = false;

  const response = await handleNativeCompanionRequest(request('filesystem.writeExistingText', {
    rootId: 'workspace', relativePath: 'note.txt', text: 'after', expectedSha256: digest('before'),
  }, 'swap'), {
    config: config(root, true),
    callerOrigin: ORIGIN,
    fsWriteBeforeOpen: async () => {
      try {
        await fs.rm(target);
        await fs.symlink(outside, target, 'file');
        swapped = true;
      } catch (error) {
        if (process.platform === 'win32') return;
        throw error;
      }
    },
  });

  if (!swapped && process.platform === 'win32') {
    t.skip('symlink creation unavailable in this Windows test environment');
    return;
  }
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PATH_OUTSIDE_SCOPE');
  assert.equal(await fs.readFile(outside, 'utf8'), 'secret');
});
