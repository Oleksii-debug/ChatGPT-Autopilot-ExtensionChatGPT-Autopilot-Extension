import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  const binaryCapability = capabilities.result.capabilities.find(item => item.capabilityId === 'filesystem.readBinary');
  assert.ok(binaryCapability);
  assert.equal(binaryCapability.readOnly, true);
  assert.ok(binaryCapability.maxChunkBytes > 0);
  assert.ok(binaryCapability.maxFileBytes >= binaryCapability.maxChunkBytes);
  assert.ok(capabilities.result.capabilities.some(item => item.capabilityId === 'credentials.list'));
  assert.ok(capabilities.result.capabilities.some(item => item.capabilityId === 'credentials.resolve'));
  assert.equal(capabilities.result.credentialBrokerAvailable, false);
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

test('host exposes only a configured Windows provider and forwards no arbitrary executable path', async () => {
  const calls = [];
  const windowsProvider = {
    capabilities: () => [{ capabilityId: 'windows.process.execPinned', readOnly: false, scoped: true }],
    execPinned: async payload => { calls.push(payload); return { executableId: 'git', exitCode: 0, stdout: 'ok', stderr: '' }; },
    queryUia: async () => [],
  };
  const capabilities = await handleNativeCompanionRequest(request('capabilities'), { config: config(), callerOrigin: ORIGIN, windowsProvider });
  assert.equal(capabilities.result.windowsProviderAvailable, true);
  assert.ok(capabilities.result.capabilities.some(item => item.capabilityId === 'windows.process.execPinned'));
  const response = await handleNativeCompanionRequest(request('windows.execPinned', { executableId: 'git', args: ['status'] }), { config: config(), callerOrigin: ORIGIN, windowsProvider });
  assert.equal(response.ok, true);
  assert.deepEqual(calls, [{ executableId: 'git', args: ['status'] }]);
  const unavailable = await handleNativeCompanionRequest(request('windows.execPinned', { executableId: 'git' }), { config: config(), callerOrigin: ORIGIN });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.code, 'WINDOWS_PROVIDER_UNAVAILABLE');
});

test('Native Companion credential client and host keep listing opaque and resolve only on explicit request', async () => {
  const brokerCalls = [];
  const broker = {
    list(targetOrigin) {
      brokerCalls.push(['list', targetOrigin]);
      return [{
        schemaVersion: 1,
        credentialId: 'ais-main',
        brokerId: 'native-companion',
        kind: 'username-password',
        scope: ['https://ais.example.edu'],
        expiresAt: null,
      }];
    },
    async resolve(input) {
      brokerCalls.push(['resolve', structuredClone(input)]);
      return {
        credentialId: input.credentialId,
        kind: 'username-password',
        targetOrigin: input.targetOrigin,
        username: 'owner@example.edu',
        secret: 'S3cret-value',
      };
    },
  };

  const listed = await handleNativeCompanionRequest(request('credentials.list', {
    targetOrigin: 'https://ais.example.edu',
  }, 'cred-list'), {
    config: config(),
    callerOrigin: ORIGIN,
    credentialBroker: broker,
  });
  assert.equal(listed.ok, true);
  assert.equal(listed.result.credentialRefs.length, 1);
  assert.equal(JSON.stringify(listed.result).includes('owner@example.edu'), false);
  assert.equal(JSON.stringify(listed.result).includes('S3cret-value'), false);
  assert.deepEqual(brokerCalls, [['list', 'https://ais.example.edu']]);

  const resolved = await handleNativeCompanionRequest(request('credentials.resolve', {
    credentialId: 'ais-main',
    targetOrigin: 'https://ais.example.edu',
  }, 'cred-resolve'), {
    config: config(),
    callerOrigin: ORIGIN,
    credentialBroker: broker,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.result.username, 'owner@example.edu');
  assert.equal(resolved.result.secret, 'S3cret-value');
  assert.equal(brokerCalls.length, 2);

  const unavailable = await handleNativeCompanionRequest(request('credentials.list', {
    targetOrigin: 'https://ais.example.edu',
  }, 'cred-unavailable'), {
    config: config(),
    callerOrigin: ORIGIN,
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.code, 'CREDENTIAL_BROKER_UNAVAILABLE');
});

test('Native Companion extension client sends scoped credential requests without inventing fields', async () => {
  const messages = [];
  const chromeApi = {
    runtime: {
      async sendNativeMessage(_host, message) {
        messages.push(structuredClone(message));
        const result = message.type === 'credentials.list'
          ? { credentialRefs: [{ schemaVersion: 1, credentialId: 'ais-main', brokerId: 'native-companion', kind: 'username-password', scope: ['https://ais.example.edu'], expiresAt: null }] }
          : { credentialId: 'ais-main', kind: 'username-password', targetOrigin: 'https://ais.example.edu', username: 'owner@example.edu', secret: 'S3cret-value' };
        return { protocolVersion: 1, requestId: message.requestId, type: message.type, ok: true, result };
      },
    },
  };
  let n = 0;
  const client = new NativeCompanionClient({ chromeApi, createId: () => `cred-${++n}` });
  const listed = await client.listCredentials({ targetOrigin: 'https://ais.example.edu' });
  const resolved = await client.resolveCredential({ credentialId: 'ais-main', targetOrigin: 'https://ais.example.edu' });
  assert.equal(listed.credentialRefs[0].credentialId, 'ais-main');
  assert.equal(resolved.secret, 'S3cret-value');
  assert.deepEqual(messages.map(item => item.type), ['credentials.list', 'credentials.resolve']);
  assert.deepEqual(messages[0].payload, { targetOrigin: 'https://ais.example.edu' });
  assert.deepEqual(messages[1].payload, { credentialId: 'ais-main', targetOrigin: 'https://ais.example.edu' });
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

test('filesystem.readBinary returns digest-bound chunks and rejects drift or noncanonical bounds', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-native-binary-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const bytes = Buffer.from([0x00, 0xff, 0x10, 0x20, 0x30, 0x40, 0x7f]);
  const target = path.join(root, 'asset.bin');
  await fs.writeFile(target, bytes);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

  const first = await handleNativeCompanionRequest(request('filesystem.readBinary', {
    rootId: 'workspace',
    relativePath: 'asset.bin',
    offsetBytes: 0,
    maxBytes: 3,
    expectedSha256: '',
  }), { config: config(root), callerOrigin: ORIGIN });
  assert.equal(first.ok, true);
  assert.equal(first.result.relativePath, 'asset.bin');
  assert.equal(first.result.sizeBytes, bytes.length);
  assert.equal(first.result.chunkSizeBytes, 3);
  assert.equal(first.result.offsetBytes, 0);
  assert.equal(first.result.sha256, sha256);
  assert.equal(first.result.dataBase64, bytes.subarray(0, 3).toString('base64'));
  assert.equal(first.result.eof, false);

  const second = await handleNativeCompanionRequest(request('filesystem.readBinary', {
    rootId: 'workspace',
    relativePath: 'asset.bin',
    offsetBytes: 3,
    maxBytes: 32,
    expectedSha256: sha256,
  }), { config: config(root), callerOrigin: ORIGIN });
  assert.equal(second.ok, true);
  assert.equal(second.result.dataBase64, bytes.subarray(3).toString('base64'));
  assert.equal(second.result.eof, true);
  assert.equal(second.result.sha256, sha256);

  const wrongDigest = await handleNativeCompanionRequest(request('filesystem.readBinary', {
    rootId: 'workspace',
    relativePath: 'asset.bin',
    offsetBytes: 0,
    maxBytes: 3,
    expectedSha256: 'a'.repeat(64),
  }), { config: config(root), callerOrigin: ORIGIN });
  assert.equal(wrongDigest.ok, false);
  assert.equal(wrongDigest.error.code, 'PRECONDITION_FAILED');

  for (const payload of [
    { rootId: 'workspace', relativePath: 'asset.bin', offsetBytes: '0', maxBytes: 3, expectedSha256: '' },
    { rootId: 'workspace', relativePath: 'asset.bin', offsetBytes: 0, maxBytes: 524289, expectedSha256: '' },
    { rootId: 'workspace', relativePath: 'asset.bin', offsetBytes: 0, maxBytes: 3, expectedSha256: sha256.toUpperCase() },
    { rootId: 'workspace', relativePath: 'asset.bin', offsetBytes: 0, maxBytes: 3, expectedSha256: '', extra: true },
  ]) {
    const rejected = await handleNativeCompanionRequest(
      request('filesystem.readBinary', payload),
      { config: config(root), callerOrigin: ORIGIN },
    );
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'INVALID_REQUEST');
  }
});

test('filesystem.readBinary refuses traversal and a target swapped to an out-of-scope symlink', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-native-binary-swap-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const target = path.join(root, 'asset.bin');
  const outside = path.join(temp, 'private.bin');
  await fs.writeFile(target, Buffer.from([1, 2, 3]));
  await fs.writeFile(outside, Buffer.from('outside-secret'));

  const traversal = await handleNativeCompanionRequest(request('filesystem.readBinary', {
    rootId: 'workspace',
    relativePath: '../private.bin',
    offsetBytes: 0,
    maxBytes: 8,
    expectedSha256: '',
  }), { config: config(root), callerOrigin: ORIGIN });
  assert.equal(traversal.ok, false);
  assert.equal(traversal.error.code, 'PATH_OUTSIDE_SCOPE');

  let symlinkReady = true;
  try {
    const swapped = await handleNativeCompanionRequest(request('filesystem.readBinary', {
      rootId: 'workspace',
      relativePath: 'asset.bin',
      offsetBytes: 0,
      maxBytes: 8,
      expectedSha256: '',
    }), {
      config: config(root),
      callerOrigin: ORIGIN,
      fsBinaryBeforeOpen: async () => {
        await fs.rm(target);
        await fs.symlink(outside, target, 'file');
      },
    });
    assert.equal(swapped.ok, false);
    assert.equal(swapped.error.code, 'PATH_OUTSIDE_SCOPE');
    assert.equal(JSON.stringify(swapped).includes('outside-secret'), false);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) symlinkReady = false;
    else throw error;
  }
  if (!symlinkReady) t.diagnostic('symlink swap unavailable in this test environment');
});

test('Native Companion extension client emits exact filesystem.readBinary payload without digest rewriting', async () => {
  const messages = [];
  const chromeApi = {
    runtime: {
      async sendNativeMessage(_host, message) {
        messages.push(structuredClone(message));
        return {
          protocolVersion: 1,
          requestId: message.requestId,
          type: message.type,
          ok: true,
          result: {
            rootId: 'workspace',
            relativePath: 'asset.bin',
            offsetBytes: 4,
            chunkSizeBytes: 2,
            sizeBytes: 6,
            sha256: 'a'.repeat(64),
            dataBase64: 'AQI=',
            eof: true,
          },
        };
      },
    },
  };
  const client = new NativeCompanionClient({ chromeApi, createId: () => 'binary-1' });
  await client.readBinary({
    rootId: 'workspace',
    relativePath: 'asset.bin',
    offsetBytes: 4,
    maxBytes: 2,
    expectedSha256: 'a'.repeat(64),
  });
  assert.deepEqual(messages[0].payload, {
    rootId: 'workspace',
    relativePath: 'asset.bin',
    offsetBytes: 4,
    maxBytes: 2,
    expectedSha256: 'a'.repeat(64),
  });
});

test('filesystem.readText rejects traversal, absolute paths, unknown roots and oversized files', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-native-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'small.txt'), 'small', 'utf8');
  await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(1024), 'utf8');

  for (const relativePath of ['../outside.txt', path.resolve(temp, 'outside.txt'), 'small.txt:alternate']) {
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

test('native host read refuses a symlink swapped after scope admission', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-native-swap-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  const target = path.join(root, 'note.txt');
  const outside = path.join(temp, 'private.txt');
  await fs.writeFile(target, 'allowed');
  await fs.writeFile(outside, 'outside-secret');
  const result = await handleNativeCompanionRequest(request('filesystem.readText', {
    rootId: 'workspace', relativePath: 'note.txt',
  }), {
    config: config(root), callerOrigin: ORIGIN,
    fsReadBeforeOpen: async () => {
      await fs.rm(target);
      await fs.symlink(outside, target, 'file');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PATH_OUTSIDE_SCOPE');
  assert.equal(JSON.stringify(result).includes('outside-secret'), false);
});

test('Windows installer copies the full transitive local module closure of the Native Host', async () => {
  const hostDir = path.join(repoRoot, 'companion', 'native-host');
  const installer = await fs.readFile(path.join(hostDir, 'ВСТАНОВИТИ NATIVE COMPANION.ps1'), 'utf8');
  const pending = ['host.mjs'];
  const visited = new Set();
  const importPatterns = [
    /\bfrom\s+['"]\.\/([^'"]+\.mjs)['"]/gu,
    /\bimport\s+['"]\.\/([^'"]+\.mjs)['"]/gu,
    /\bimport\s*\(\s*['"]\.\/([^'"]+\.mjs)['"]\s*\)/gu,
  ];

  while (pending.length > 0) {
    const entry = pending.shift();
    if (visited.has(entry)) continue;
    visited.add(entry);
    assert.ok(installer.includes(`'${entry}'`), `Native Host installer does not copy ${entry}`);

    const source = await fs.readFile(path.join(hostDir, entry), 'utf8');
    for (const pattern of importPatterns) {
      for (const match of source.matchAll(pattern)) {
        const localModule = match[1];
        assert.ok(
          installer.includes(`'${localModule}'`),
          `${entry} imports ${localModule}, but installer does not copy it`,
        );
        if (!visited.has(localModule)) pending.push(localModule);
      }
    }
  }

  assert.ok(
    visited.has('filesystem-read-surface.mjs'),
    'recursive closure regression must reach the FS-003 read-surface dependency',
  );
});

test('Windows installer fails closed before active-target mutation for missing or invalid Native Host modules', async () => {
  const hostDir = path.join(repoRoot, 'companion', 'native-host');
  const installer = await fs.readFile(path.join(hostDir, 'ВСТАНОВИТИ NATIVE COMPANION.ps1'), 'utf8');

  const requiredFileGuard = "if (-not (Test-Path -LiteralPath $src -PathType Leaf))";
  const requiredFileError = "Пакет Native Companion неповний: відсутній обов'язковий файл";
  const targetCreate = 'New-Item -ItemType Directory -Path $target, $runtime, $configDir, $credentialsDir -Force';
  const activeTargetCopy = "Copy-Item -LiteralPath $src -Destination (Join-Path $target $name) -Force";
  const sourceSyntaxCheck = '& $nodeExe --check $sourceModule';
  const syntaxFailureGuard = 'if ($LASTEXITCODE -ne 0)';
  const configParse = 'Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json';
  const stagedLauncher = "$stagedLauncher = Join-Path $stagingDir 'autopilot-native-host.exe'";
  const launcherPreflight = "Add-Type -Path (Join-Path $source 'NativeHostLauncher.cs') -OutputAssembly $stagedLauncher -OutputType ConsoleApplication";
  const installedNode = "$installedNode = Join-Path $runtime 'node.exe'";
  const registryMutation = "$regKey = 'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\org.chatgpt_autopilot.companion'";

  const guardIndex = installer.indexOf(requiredFileGuard);
  const syntaxIndex = installer.indexOf(sourceSyntaxCheck);
  const syntaxFailureIndex = installer.indexOf(syntaxFailureGuard);
  const configIndex = installer.indexOf(configParse);
  const stagedLauncherIndex = installer.indexOf(stagedLauncher);
  const launcherPreflightIndex = installer.indexOf(launcherPreflight);
  const targetCreateIndex = installer.indexOf(targetCreate);
  const copyIndex = installer.indexOf(activeTargetCopy);
  const nodeIndex = installer.indexOf(installedNode);
  const registryIndex = installer.indexOf(registryMutation);

  assert.ok(guardIndex >= 0, 'installer must require every packaged Native Companion file');
  assert.ok(installer.includes(requiredFileError), 'missing required file must fail with an explicit error');
  assert.equal(
    installer.includes("if (Test-Path -LiteralPath $src) { Copy-Item"),
    false,
    'installer must not silently skip required files',
  );
  assert.ok(syntaxIndex > guardIndex, 'source syntax preflight must run after complete required-file validation');
  assert.ok(syntaxFailureIndex > syntaxIndex, 'nonzero node --check status must fail installation');
  assert.ok(configIndex > syntaxFailureIndex, 'existing config must be validated after source syntax and before active mutation');
  assert.ok(stagedLauncherIndex > configIndex, 'launcher staging must begin only after existing config validation');
  assert.ok(launcherPreflightIndex > stagedLauncherIndex, 'launcher must compile in staging before active mutation');
  assert.equal(
    installer.includes('Add-Type -Path $launcherSource -OutputAssembly $launcherExe'),
    false,
    'installer must not compile the launcher from the already-mutated active target',
  );
  assert.ok(
    targetCreateIndex > launcherPreflightIndex,
    'missing/syntax/config/launcher failure must occur before creating or mutating the active install target',
  );
  assert.ok(copyIndex > targetCreateIndex, 'active-target file copies must begin only after successful preflight');
  assert.ok(nodeIndex > copyIndex, 'installed Node path must be established only after source payload preflight');
  assert.ok(registryIndex > nodeIndex, 'Chrome Native Messaging registration must remain after payload publication');
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
  assert.equal(MAX_READ_BYTES, 768 * 1024);
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
  assert.ok(installer.includes('HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\org.chatgpt_autopilot.companion'));
  assert.match(installer, /org\.chatgpt_autopilot\.companion/);
  assert.match(installer, /allowed_origins/);
  assert.doesNotMatch(installer, /chrome-extension:\/\/\*/);
});

test('filesystem.readBinary rejects signed-zero offset while preserving canonical zero', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-native-binary-zero-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'asset.bin'), Buffer.from([0x01, 0x02, 0x03]));

  const canonicalZero = await handleNativeCompanionRequest(request('filesystem.readBinary', {
    rootId: 'workspace',
    relativePath: 'asset.bin',
    offsetBytes: 0,
    maxBytes: 1,
    expectedSha256: '',
  }), { config: config(root), callerOrigin: ORIGIN });
  assert.equal(canonicalZero.ok, true);
  assert.equal(canonicalZero.result.offsetBytes, 0);
  assert.equal(Object.is(canonicalZero.result.offsetBytes, -0), false);

  const signedZero = await handleNativeCompanionRequest(request('filesystem.readBinary', {
    rootId: 'workspace',
    relativePath: 'asset.bin',
    offsetBytes: -0,
    maxBytes: 1,
    expectedSha256: '',
  }), { config: config(root), callerOrigin: ORIGIN });
  assert.equal(signedZero.ok, false);
  assert.equal(signedZero.error.code, 'INVALID_REQUEST');
});

