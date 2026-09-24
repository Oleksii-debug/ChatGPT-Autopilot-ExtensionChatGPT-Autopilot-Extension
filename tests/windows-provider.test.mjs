import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPowerShellUiaAdapter,
  createWindowsProvider,
  normalizeWindowsProviderConfig,
} from '../companion/native-host/windows-provider.mjs';

const config = {
  schemaVersion: 1,
  executables: [
    {
      executableId: 'git',
      path: 'C:\\Program Files\\Git\\cmd\\git.exe',
      readOnly: false,
    },
  ],
};

test('Windows provider accepts only pinned owner-configured executable identities', async () => {
  const calls = [];
  const provider = createWindowsProvider({
    config,
    platform: 'win32',
    execFile: async (...args) => {
      calls.push(args);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
    uiaAdapter: { query: async () => [] },
  });

  const result = await provider.execPinned({
    executableId: 'git',
    args: ['status'],
    timeoutMs: 5000,
  });

  assert.equal(result.stdout, 'ok');
  assert.deepEqual(calls[0], [
    'C:\\Program Files\\Git\\cmd\\git.exe',
    ['status'],
    {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 256 * 1024,
    },
  ]);
  await assert.rejects(
    () => provider.execPinned({ executableId: 'powershell', args: [] }),
    /not owner-configured/,
  );
});

test('Windows provider rejects model-controlled executable paths and type aliases', async () => {
  let calls = 0;
  const provider = createWindowsProvider({
    config,
    platform: 'win32',
    execFile: async () => {
      calls += 1;
      return {};
    },
    uiaAdapter: { query: async () => [] },
  });

  await assert.rejects(
    () => provider.execPinned({ executableId: 'git', path: 'C:\\evil.exe', args: [] }),
    /unknown field: path/,
  );
  await assert.rejects(
    () => provider.execPinned({ executableId: 'git', args: new Array(65).fill('x') }),
    /at most 64/,
  );
  await assert.rejects(
    () => provider.execPinned({ executableId: 'git', timeoutMs: '5000' }),
    /timeoutMs must be/,
  );
  await assert.rejects(
    () => provider.execPinned(Object.create({ executableId: 'git' })),
    /plain object/,
  );
  assert.equal(calls, 0);
});

test('Windows provider config rejects inherited authority and type-coerced readOnly', () => {
  assert.throws(
    () => normalizeWindowsProviderConfig(Object.assign(Object.create({ schemaVersion: 1 }), { executables: [] })),
    /plain object/,
  );
  assert.throws(
    () => normalizeWindowsProviderConfig({
      schemaVersion: 1,
      executables: [
        {
          executableId: 'git',
          path: 'C:\\Program Files\\Git\\cmd\\git.exe',
          readOnly: 'false',
        },
      ],
    }),
    /readOnly must be boolean/,
  );
});

test('Windows provider fails closed off Windows', async () => {
  const provider = createWindowsProvider({
    config,
    platform: 'linux',
    execFile: async () => ({}),
  });
  const capability = provider.capabilities().find(item => item.capabilityId === 'windows.uia.query');
  assert.equal(capability.available, false);
  await assert.rejects(
    () => provider.execPinned({ executableId: 'git' }),
    /only on Windows/,
  );
  await assert.rejects(
    () => provider.queryUia({ windowId: 'desktop' }),
    /only on Windows/,
  );
});

test('injected UIA query is semantic, bounded, and does not expose arbitrary adapter fields', async () => {
  const provider = createWindowsProvider({
    config,
    platform: 'win32',
    execFile: async () => ({}),
    uiaAdapter: {
      query: async request => {
        assert.deepEqual(request, {
          windowId: 'window-1',
          role: 'button',
          name: 'Save',
          limit: 2,
        });
        return [
          {
            elementId: 'el-1',
            role: 'button',
            name: 'Save',
            enabled: true,
            offscreen: false,
          },
        ];
      },
    },
  });

  const rows = await provider.queryUia({
    windowId: 'window-1',
    role: 'button',
    name: 'Save',
    limit: 2,
  });
  assert.deepEqual(rows, [
    {
      elementId: 'el-1',
      role: 'button',
      name: 'Save',
      enabled: true,
      offscreen: false,
    },
  ]);
  await assert.rejects(
    () => provider.queryUia({ windowId: 'window-1', limit: 257 }),
    /limit must be/,
  );
  await assert.rejects(
    () => provider.queryUia({ windowId: 'window-1', limit: '2' }),
    /limit must be/,
  );
  await assert.rejects(
    () => provider.queryUia({ windowId: 'window-1', role: 7 }),
    /role must be text/,
  );
});

test('UIA result schema fails closed on extra fields and state type aliases', async () => {
  assert.throws(
    () => normalizeWindowsProviderConfig({ ...config, extra: true }),
    /unknown field/,
  );
  const extraProvider = createWindowsProvider({
    config,
    platform: 'win32',
    execFile: async () => ({}),
    uiaAdapter: {
      query: async () => [
        {
          elementId: 'el-1',
          role: 'button',
          name: 'Save',
          enabled: true,
          offscreen: false,
          secret: 'no',
        },
      ],
    },
  });
  await assert.rejects(
    () => extraProvider.queryUia({ windowId: 'window-1' }),
    /unknown field: secret/,
  );

  const aliasProvider = createWindowsProvider({
    config,
    platform: 'win32',
    execFile: async () => ({}),
    uiaAdapter: {
      query: async () => [
        {
          elementId: 'el-1',
          role: 'button',
          name: 'Save',
          enabled: 'true',
          offscreen: false,
        },
      ],
    },
  });
  await assert.rejects(
    () => aliasProvider.queryUia({ windowId: 'window-1' }),
    /state must be boolean/,
  );
});

test('production UIA fallback uses fixed encoded PowerShell and returns observation-bound window identities', async () => {
  const calls = [];
  const powershellPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const modelSuppliedName = "Save'; Get-ChildItem Env:";
  const observedWindow = 'win:4242:pid:77:rid:42.7.-3';
  const provider = createWindowsProvider({
    config,
    platform: 'win32',
    powershellPath,
    execFile: async (...args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify([
          {
            elementId: observedWindow,
            role: 'Window',
            name: 'Editor',
            enabled: true,
            offscreen: false,
          },
        ]),
        stderr: '',
      };
    },
  });

  const capability = provider.capabilities().find(item => item.capabilityId === 'windows.uia.query');
  assert.equal(capability.available, true);
  assert.equal(capability.windowIdFormat, 'desktop | win:<hwnd>:pid:<pid>:rid:<runtimeId>');

  const rows = await provider.queryUia({
    windowId: 'desktop',
    role: 'Window',
    name: modelSuppliedName,
    limit: 5,
  });

  assert.deepEqual(rows, [
    {
      elementId: observedWindow,
      role: 'Window',
      name: 'Editor',
      enabled: true,
      offscreen: false,
    },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], powershellPath);
  assert.deepEqual(calls[0][1].slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(calls[0][1][3], 'base64').toString('utf16le');
  assert.match(script, /UIAutomationClient/);
  assert.match(script, /ControlViewWalker/);
  assert.match(script, /UIA window reference is stale/);
  assert.match(script, /rootProcessId -ne \$expectedProcessId/);
  assert.match(script, /rootRuntimeId, \$expectedRuntimeId/);
  assert.equal(script.includes(modelSuppliedName), false, 'model text must be encoded as data, not interpolated PowerShell');
  assert.equal(Object.hasOwn(calls[0][2].env, 'OPENAI_API_KEY'), false);
  assert.equal(Object.hasOwn(calls[0][2].env, 'MISTRAL_API_KEY'), false);
  assert.equal(calls[0][2].timeout, 15_000);
  assert.equal(calls[0][2].maxBuffer, 256 * 1024);
});

test('PowerShell UIA adapter rejects non-canonical window identities before process launch', async () => {
  let calls = 0;
  const adapter = createPowerShellUiaAdapter({
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    execFile: async () => {
      calls += 1;
      return { stdout: '[]', stderr: '' };
    },
  });

  for (const windowId of ['window-1', 'hwnd:4242', 'win:01:pid:77:rid:42.7', 'win:4242:pid:0:rid:42.7', 'win:4242:pid:77:rid:042.7', 'win:9999999999999999999:pid:77:rid:42.7']) {
    await assert.rejects(
      () => adapter.query({ windowId, role: '', name: '', limit: 2 }),
      /windowId/,
    );
  }
  await assert.rejects(
    () => adapter.query({ windowId: 'desktop', role: 7, name: '', limit: 2 }),
    /role must be text/,
  );
  await assert.rejects(
    () => adapter.query({ windowId: 'desktop', role: '', name: '', limit: '2' }),
    /limit must be/,
  );
  assert.equal(calls, 0);
});

test('PowerShell UIA adapter binds a targeted window to handle, process, and runtime identity', async () => {
  const calls = [];
  const adapter = createPowerShellUiaAdapter({
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    execFile: async (...args) => {
      calls.push(args);
      return { stdout: '[]', stderr: '' };
    },
  });

  const windowId = 'win:4242:pid:77:rid:42.7.-3';
  await adapter.query({ windowId, role: '', name: '', limit: 2 });
  assert.equal(calls.length, 1);
  const script = Buffer.from(calls[0][1][3], 'base64').toString('utf16le');
  assert.match(script, /expectedHandle/);
  assert.match(script, /expectedProcessId/);
  assert.match(script, /expectedRuntimeId/);
  assert.match(script, /rootHandle -ne \$expectedHandle/);
  assert.match(script, /rootProcessId -ne \$expectedProcessId/);
  assert.match(script, /rootRuntimeId, \$expectedRuntimeId/);
  assert.match(script, /throw 'UIA window reference is stale'/);
});

test('PowerShell UIA adapter rejects raw HWND output as non-canonical authority', async () => {
  const adapter = createPowerShellUiaAdapter({
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    execFile: async () => ({
      stdout: JSON.stringify([{ elementId: 'hwnd:4242', role: 'Window', name: 'Old', enabled: true, offscreen: false }]),
      stderr: '',
    }),
  });
  await assert.rejects(
    () => adapter.query({ windowId: 'desktop', role: '', name: '', limit: 2 }),
    error => error.code === 'WINDOWS_UIA_INVALID_RESPONSE',
  );
});

test('PowerShell UIA adapter requires an own plain request envelope before process launch', async () => {
  let calls = 0;
  const adapter = createPowerShellUiaAdapter({
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    execFile: async () => {
      calls += 1;
      return { stdout: '[]', stderr: '' };
    },
  });
  await assert.rejects(
    () => adapter.query(Object.assign(Object.create({ windowId: 'desktop' }), { limit: 2 })),
    /plain object/,
  );
  await assert.rejects(
    () => adapter.query({ windowId: 'desktop', limit: 2, command: 'Get-Process' }),
    /unknown field: command/,
  );
  assert.equal(calls, 0);
});

test('UIA capability truth follows callable adapter availability', () => {
  const unavailable = createWindowsProvider({
    config,
    platform: 'win32',
    execFile: async () => ({}),
    uiaAdapter: {},
  });
  const capability = unavailable.capabilities().find(item => item.capabilityId === 'windows.uia.query');
  assert.equal(capability.available, false);
});

test('PowerShell UIA adapter treats malformed output and process failure as fail-closed', async () => {
  const powershellPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const invalid = createPowerShellUiaAdapter({
    powershellPath,
    execFile: async () => ({ stdout: '{bad json', stderr: '' }),
  });
  await assert.rejects(
    () => invalid.query({ windowId: 'desktop', role: '', name: '', limit: 2 }),
    error => error.code === 'WINDOWS_UIA_INVALID_RESPONSE',
  );

  const failed = createPowerShellUiaAdapter({
    powershellPath,
    execFile: async () => {
      throw new Error('PowerShell emitted private diagnostic detail');
    },
  });
  await assert.rejects(
    () => failed.query({ windowId: 'desktop', role: '', name: '', limit: 2 }),
    error => error.code === 'WINDOWS_UIA_FAILED'
      && error.message === 'Windows UI Automation query failed'
      && !error.message.includes('private diagnostic'),
  );
});

test('UIA request object cannot inherit window authority', async () => {
  let called = false;
  const provider = createWindowsProvider({
    config,
    platform: 'win32',
    execFile: async () => ({}),
    uiaAdapter: {
      query: async () => {
        called = true;
        return [];
      },
    },
  });

  await assert.rejects(
    () => provider.queryUia(Object.assign(Object.create({ windowId: 'desktop' }), { limit: 2 })),
    /plain object/,
  );
  assert.equal(called, false);
});
