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


test('Native filesystem IPC rejects coerced bounds and exotic payload authority', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-boundary-'));
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

  const symbolicSearch = {
    rootId: 'workspace',
    query: 'note',
    maxResults: 10,
    maxEntries: 100,
  };
  symbolicSearch[Symbol('authority')] = true;
  await assert.rejects(
    () => searchScopedFilesystemV1(symbolicSearch, cfg),
    error => error.code === 'INVALID_REQUEST' && /unknown field/.test(error.message),
  );

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
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'before');
});

test('Native filesystem write digest is strict lowercase text and never coerced', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-digest-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const target = path.join(root, 'note.txt');
  await fs.writeFile(target, 'before', 'utf8');
  const cfg = config(root, true);

  for (const expectedSha256 of [123, true, { toString: () => digest('before') }, digest('before').toUpperCase()]) {
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
  }
});


test('partial staging failure preserves original bytes and removes the staging file', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-partial-stage-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const target = path.join(root, 'note.txt');
  await fs.writeFile(target, 'before', 'utf8');
  const desired = 'x'.repeat(96 * 1024);
  let hookCalls = 0;

  await assert.rejects(
    () => writeExistingTextScopedV1({
      rootId: 'workspace',
      relativePath: 'note.txt',
      text: desired,
      expectedSha256: digest('before'),
    }, config(root, true), {
      afterTempWrite: ({ writtenBytes, totalBytes }) => {
        hookCalls += 1;
        assert.ok(writtenBytes > 0);
        assert.ok(writtenBytes < totalBytes);
        throw new Error('simulated crash during staging');
      },
    }),
    /simulated crash during staging/,
  );

  assert.equal(hookCalls, 1);
  assert.equal(await fs.readFile(target, 'utf8'), 'before');
  assert.deepEqual(await fs.readdir(root), ['note.txt']);
});

test('failure after fully synced staging but before publish preserves original bytes', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-before-publish-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const target = path.join(root, 'note.txt');
  await fs.writeFile(target, 'before', 'utf8');

  await assert.rejects(
    () => writeExistingTextScopedV1({
      rootId: 'workspace',
      relativePath: 'note.txt',
      text: 'after',
      expectedSha256: digest('before'),
    }, config(root, true), {
      beforePublish: () => {
        throw new Error('simulated crash before atomic publish');
      },
    }),
    /simulated crash before atomic publish/,
  );

  assert.equal(await fs.readFile(target, 'utf8'), 'before');
  assert.deepEqual(await fs.readdir(root), ['note.txt']);
});

test('atomic publish revalidates target identity after staging and never writes through an outside link', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-publish-swap-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const target = path.join(root, 'note.txt');
  const outside = path.join(temp, 'outside.txt');
  await fs.writeFile(target, 'before', 'utf8');
  await fs.writeFile(outside, 'secret', 'utf8');
  let swapped = false;

  await assert.rejects(
    () => writeExistingTextScopedV1({
      rootId: 'workspace',
      relativePath: 'note.txt',
      text: 'after',
      expectedSha256: digest('before'),
    }, config(root, true), {
      beforePublish: async () => {
        try {
          await fs.rm(target);
          await fs.symlink(outside, target, 'file');
          swapped = true;
        } catch (error) {
          if (process.platform === 'win32') return;
          throw error;
        }
      },
    }),
    error => {
      if (!swapped && process.platform === 'win32') return true;
      return error.code === 'PATH_OUTSIDE_SCOPE';
    },
  );

  if (!swapped && process.platform === 'win32') {
    t.skip('symlink creation unavailable in this Windows test environment');
    return;
  }
  assert.equal(await fs.readFile(outside, 'utf8'), 'secret');
  const entries = await fs.readdir(root);
  assert.equal(entries.some(name => name.startsWith('.chatgpt-autopilot-write-')), false);
});


test('concurrent same-inode edit during staging fails the optimistic digest fence', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-fs-host-concurrent-edit-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const target = path.join(root, 'note.txt');
  await fs.writeFile(target, 'before', 'utf8');

  await assert.rejects(
    () => writeExistingTextScopedV1({
      rootId: 'workspace',
      relativePath: 'note.txt',
      text: 'after',
      expectedSha256: digest('before'),
    }, config(root, true), {
      beforePublish: async () => {
        await fs.writeFile(target, 'concurrent', 'utf8');
      },
    }),
    error => error.code === 'PRECONDITION_FAILED',
  );

  assert.equal(await fs.readFile(target, 'utf8'), 'concurrent');
  const entries = await fs.readdir(root);
  assert.equal(entries.some(name => name.startsWith('.chatgpt-autopilot-write-')), false);
});
