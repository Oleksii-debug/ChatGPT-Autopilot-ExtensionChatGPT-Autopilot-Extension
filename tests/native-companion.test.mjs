import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NATIVE_COMPANION_HOST_NAME,
  NATIVE_COMPANION_PROTOCOL_VERSION,
  NativeCompanionClient,
  NativeCompanionError,
  createNativeCompanionRequest,
  normalizeNativeCompanionResponse,
} from '../src/core/native-companion.js';
import {
  HOST_NAME,
  PROTOCOL_VERSION,
  MAX_READ_BYTES,
  NativeMessageDecoder,
  encodeNativeMessage,
  handleNativeCompanionRequest,
  normalizeNativeCompanionConfig,
} from '../companion/native-host/host-core.mjs';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function config(rootPath = null) {
  return {
    schemaVersion: 1,
    allowedOrigin: ORIGIN,
    roots: rootPath ? [{ rootId: 'workspace', path: rootPath }] : [],
  };
}

function request(type, payload = {}, requestId = 'req-1') {
  return {
    protocolVersion: 1,
    requestId,
    type,
    payload,
  };
}

test('extension Native Companion client binds request id, type and protocol', async () => {
  const calls = [];
  const chromeApi = {
    runtime: {
      async sendNativeMessage(host, message) {
        calls.push({ host, message });
        return {
          protocolVersion: 1,
          requestId: message.requestId,
          type: message.type,
          ok: true,
          result: { status: 'ok' },
        };
      },
    },
  };
  const client = new NativeCompanionClient({ chromeApi, createId: () => 'req-fixed' });
  const result = await client.health();
  assert.deepEqual(result, { status: 'ok' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, NATIVE_COMPANION_HOST_NAME);
  assert.equal(calls[0].message.requestId, 'req-fixed');
  assert.equal(calls[0].message.protocolVersion, NATIVE_COMPANION_PROTOCOL_VERSION);
  assert.equal(calls[0].message.type, 'health');
});

test('extension client rejects mismatched or failed Native Companion responses', async () => {
  assert.throws(() => normalizeNativeCompanionResponse({
    protocolVersion: 1,
    requestId: 'other',
    type: 'health',
    ok: true,
    result: {},
  }, { requestId: 'expected', type: 'health' }), /requestId mismatch/);

  const client = new NativeCompanionClient({
    chromeApi: {
      runtime: {
        async sendNativeMessage(_host, message) {
          return {
            protocolVersion: 1,
            requestId: message.requestId,
            type: message.type,
            ok: false,
            error: { code: 'ROOT_NOT_ALLOWED', message: 'No root' },
          };
        },
      },
    },
    createId: () => 'req-fixed',
  });
  await assert.rejects(() => client.readText({ rootId: 'workspace', relativePath: 'a.txt' }), error => {
    assert.ok(error instanceof NativeCompanionError);
    assert.equal(error.code, 'ROOT_NOT_ALLOWED');
    return true;
  });
});

test('host configuration requires one exact Chrome extension origin and unique scoped roots', () => {
  const normalized = normalizeNativeCompanionConfig(config(path.resolve(os.tmpdir(), 'Workspace')));
  assert.equal(normalized.allowedOrigin, ORIGIN);
  assert.equal(normalized.roots[0].rootId, 'workspace');
  assert.throws(() => normalizeNativeCompanionConfig({ schemaVersion: 1, allowedOrigin: 'chrome-extension://*/', roots: [] }), /allowedOrigin/);
  assert.throws(() => normalizeNativeCompanionConfig({
    schemaVersion: 1,
    allowedOrigin: ORIGIN,
    roots: [{ rootId: 'same', path: path.resolve(os.tmpdir(), 'One') }, { rootId: 'same', path: path.resolve(os.tmpdir(), 'Two') }],
  }), /unique/);
});

test('host hello, health and capabilities are versioned and caller-bound', async () => {
  const hello = await handleNativeCompanionRequest(request('hello', { clientVersion: '0.9.19' }), {
    config: config(),
    callerOrigin: ORIGIN,
    now: () => Date.parse('2026-09-19T17:00:00Z'),
  });
  assert.equal(hello.ok, true);
  assert.equal(hello.result.hostName, HOST_NAME);
  assert.equal(hello.result.protocolVersion, PROTOCOL_VERSION);

  const capabilities = await handleNativeCompanionRequest(request('capabilities', {}, 'req-2'), {
    config: config(),
    callerOrigin: ORIGIN,
  });
  assert.equal(capabilities.ok, true);
  assert.ok(capabilities.result.capabilities.some(item => item.capabilityId === 'filesystem.readText'));
  assert.equal(capabilities.result.roots.length, 0);

  const rejected = await handleNativeCompanionRequest(request('health'), {
    config: config(),
    callerOrigin: 'chrome-extension://pppppppppppppppppppppppppppppppp/',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'CALLER_NOT_ALLOWED');

  const mismatch = await handleNativeCompanionRequest({ ...request('health'), protocolVersion: 2 }, {
    config: config(),
    callerOrigin: ORIGIN,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, 'PROTOCOL_MISMATCH');
});

test('filesystem.readText reads only a valid UTF-8 file inside an explicitly configured root', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-native-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'note.txt'), 'Привіт Native Companion\n', 'utf8');

  const response = await handleNativeCompanionRequest(request('filesystem.readText', {
    rootId: 'workspace',
    relativePath: 'docs/note.txt',
    maxBytes: 4096,
  }), {
    config: config(root),
    callerOrigin: ORIGIN,
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.rootId, 'workspace');
  assert.equal(response.result.relativePath, 'docs/note.txt');
  assert.equal(response.result.text, 'Привіт Native Companion\n');
  assert.ok(response.result.sizeBytes > 0);
});

test('filesystem.readText rejects traversal, absolute paths, unknown roots and oversized files', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-native-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'small.txt'), 'small', 'utf8');
  await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(1024), 'utf8');

  for (const relativePath of ['../outside.txt', path.resolve(temp, 'outside.txt')]) {
    const response = await handleNativeCompanionRequest(request('filesystem.readText', {
      rootId: 'workspace',
      relativePath,
      maxBytes: 4096,
    }), { config: config(root), callerOrigin: ORIGIN });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'PATH_OUTSIDE_SCOPE');
  }

  const unknown = await handleNativeCompanionRequest(request('filesystem.readText', {
    rootId: 'other',
    relativePath: 'small.txt',
  }), { config: config(root), callerOrigin: ORIGIN });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'ROOT_NOT_ALLOWED');

  const oversized = await handleNativeCompanionRequest(request('filesystem.readText', {
    rootId: 'workspace',
    relativePath: 'large.txt',
    maxBytes: 10,
  }), { config: config(root), callerOrigin: ORIGIN });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, 'FILE_TOO_LARGE');
});

test('filesystem.readText rejects a symlink that escapes the configured root', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-native-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const outside = path.join(temp, 'secret.txt');
  await fs.writeFile(outside, 'outside', 'utf8');
  const link = path.join(root, 'escape.txt');
  try {
    await fs.symlink(outside, link, 'file');
  } catch (error) {
    t.skip(`symlink unavailable in this test environment: ${error.code || error.message}`);
    return;
  }

  const response = await handleNativeCompanionRequest(request('filesystem.readText', {
    rootId: 'workspace',
    relativePath: 'escape.txt',
  }), { config: config(root), callerOrigin: ORIGIN });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PATH_OUTSIDE_SCOPE');
});

test('native message framing survives fragmented input and enforces response bound', () => {
  const value = { protocolVersion: 1, requestId: 'r1', type: 'health', ok: true, result: { status: 'ok' } };
  const encoded = encodeNativeMessage(value);
  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(encoded.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(encoded.subarray(3, 9)), []);
  assert.deepEqual(decoder.push(encoded.subarray(9)), [value]);

  assert.throws(() => encodeNativeMessage({ text: 'x'.repeat(1024 * 1024 + 100) }), /1 MiB/);
});

test('request schema and read bounds fail closed', () => {
  assert.throws(() => createNativeCompanionRequest('unknown', {}), /Unsupported/);
  assert.equal(MAX_READ_BYTES, 1024 * 1024);
  assert.throws(() => normalizeNativeCompanionResponse({
    protocolVersion: 1,
    requestId: 'r1',
    type: 'health',
    ok: true,
    result: {},
    extra: true,
  }), /unknown field/);
});

test('Native host config loader explicitly strips a PowerShell UTF-8 BOM', async () => {
  const source = await fs.readFile(path.join(repoRoot, 'companion', 'native-host', 'host.mjs'), 'utf8');
  assert.match(source, /replace\(\/\^\\\\uFEFF\/u, ''\)/);
});

test('extension manifest and Windows installer expose the exact native host contract', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'manifest.json'), 'utf8'));
  assert.ok(manifest.permissions.includes('nativeMessaging'));

  const installer = await fs.readFile(path.join(repoRoot, 'companion', 'native-host', 'ВСТАНОВИТИ NATIVE COMPANION.ps1'), 'utf8');
  assert.match(installer, /\^\[a-p\]\{32\}\$/);
  assert.match(installer, /HKCU:\\\\Software\\\\Google\\\\Chrome\\\\NativeMessagingHosts/);
  assert.match(installer, /org\.chatgpt_autopilot\.companion/);
  assert.match(installer, /allowed_origins/);
  assert.doesNotMatch(installer, /chrome-extension:\/\/\*/);
});
