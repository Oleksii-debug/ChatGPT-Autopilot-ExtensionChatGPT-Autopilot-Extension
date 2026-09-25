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

test('Windows provider rejects accessor and hidden owner config without reading getters', () => {
  let getterCalls = 0;
  const accessorExecutable = {
    executableId: 'git',
    readOnly: false,
  };
  Object.defineProperty(accessorExecutable, 'path', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 'C:\\Program Files\\Git\\cmd\\git.exe';
    },
  });
  assert.throws(
    () => normalizeWindowsProviderConfig({ schemaVersion: 1, executables: [accessorExecutable] }),
    /data properties/,
  );
  assert.equal(getterCalls, 0);

  const hidden = {
    schemaVersion: 1,
    executables: [],
  };
  Object.defineProperty(hidden, 'schemaVersion', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: 1,
  });
  assert.throws(() => normalizeWindowsProviderConfig(hidden), /data properties/);
});

test('Windows provider request and args reject accessors without executing them', async () => {
  let getterCalls = 0;
  let adapterCalls = 0;
  const provider = createWindowsProvider({
    config,
    platform: 'win32',
    execFile: async () => ({}),
    uiaAdapter: {
      query: async () => {
        adapterCalls += 1;
        return [];
      },
    },
  });

  const request = { limit: 2 };
  Object.defineProperty(request, 'windowId', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 'desktop';
    },
  });
  await assert.rejects(() => provider.queryUia(request), /data properties/);
  assert.equal(getterCalls, 0);
  assert.equal(adapterCalls, 0);

  const hiddenRequest = { windowId: 'desktop', limit: 2 };
  Object.defineProperty(hiddenRequest, 'windowId', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: 'desktop',
  });
  await assert.rejects(() => provider.queryUia(hiddenRequest), /data properties/);
  assert.equal(adapterCalls, 0);

  const args = [];
  Object.defineProperty(args, '0', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 'status';
    },
  });
  args.length = 1;
  await assert.rejects(
    () => provider.execPinned({ executableId: 'git', args }),
    /enumerable data items/,
  );
  assert.equal(getterCalls, 0);
});

test('Windows provider rejects accessor-backed UIA results without executing getters', async () => {
  let getterCalls = 0;
  const row = { elementId: 'el-1', role: 'button', name: 'Save', enabled: true };
  Object.defineProperty(row, 'offscreen', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return false;
    },
  });
  const provider = createWindowsProvider({
    config,
    platform: 'win32',
    execFile: async () => ({}),
    uiaAdapter: { query: async () => [row] },
  });
  await assert.rejects(
    () => provider.queryUia({ windowId: 'window-1' }),
    error => error.code === 'WINDOWS_UIA_INVALID_RESPONSE',
  );
  assert.equal(getterCalls, 0);
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

test('production UIA fallback uses fixed encoded PowerShell and returns observation-only identities', async () => {
  const calls = [];
  const powershellPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const modelSuppliedName = "Save'; Get-ChildItem Env:";
  const observedElement = 'rid:42.7.-3';
  const provider = createWindowsProvider({
    config,
    platform: 'win32',
    powershellPath,
    execFile: async (...args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify([
          {
            elementId: observedElement,
            processId: 77,
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
  assert.equal(capability.windowIdFormat, 'desktop');
  assert.match(capability.windowSelection, /fresh currentWindowProcessId/);
  assert.match(capability.elementIdSemantics, /observation-only/);

  const rows = await provider.queryUia({
    windowId: 'desktop',
    role: 'Window',
    name: modelSuppliedName,
    limit: 5,
  });

  assert.deepEqual(rows, [
    {
      elementId: observedElement,
      processId: 77,
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
  assert.match(script, /Fresh UIA window selector did not resolve exactly one current window/);
  assert.equal(script.includes('FromHandle'), false, 'fresh selection must not reopen a persisted HWND target');
  assert.equal(script.includes('expectedRuntimeId'), false, 'runtime ids are observation-only, not authorization');
  assert.equal(script.includes(modelSuppliedName), false, 'model text must be encoded as data, not interpolated PowerShell');
  assert.equal(Object.hasOwn(calls[0][2].env, 'OPENAI_API_KEY'), false);
  assert.equal(Object.hasOwn(calls[0][2].env, 'MISTRAL_API_KEY'), false);
  assert.equal(calls[0][2].timeout, 15_000);
  assert.equal(calls[0][2].maxBuffer, 256 * 1024);
});

test('PowerShell UIA adapter rejects persisted window identities before process launch', async () => {
  let calls = 0;
  const adapter = createPowerShellUiaAdapter({
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    execFile: async () => {
      calls += 1;
      return { stdout: '[]', stderr: '' };
    },
  });

  for (const windowId of [
    'window-1',
    'hwnd:4242',
    'win:4242:pid:77:rid:42.7.-3',
    'rid:42.7.-3',
  ]) {
    await assert.rejects(
      () => adapter.query({ windowId, role: '', name: '', limit: 2 }),
      /only desktop/,
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
  assert.equal(calls, 0, 'stale/reusable target identities must fail before native process launch');
});

test('PowerShell UIA adapter re-resolves an exact current window selector inside one observation', async () => {
  const calls = [];
  const adapter = createPowerShellUiaAdapter({
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    execFile: async (...args) => {
      calls.push(args);
      return { stdout: '[]', stderr: '' };
    },
  });

  await adapter.query({
    windowId: 'desktop',
    currentWindowProcessId: 77,
    currentWindowName: 'Editor',
    role: 'button',
    name: 'Save',
    limit: 2,
  });
  assert.equal(calls.length, 1);
  const script = Buffer.from(calls[0][1][3], 'base64').toString('utf16le');
  assert.match(script, /expectedProcessId/);
  assert.match(script, /expectedWindowName/);
  assert.match(script, /candidateCurrent\.ProcessId -eq \$expectedProcessId/);
  assert.match(script, /candidateCurrent\.Name, \$expectedWindowName/);
  assert.match(script, /matchCount -ne 1/);
  assert.match(script, /\$root = \$matchedWindow/);
  assert.equal(script.includes('FromHandle'), false);
  assert.equal(script.includes('expectedRuntimeId'), false);
});

test('PowerShell UIA adapter requires a complete fresh current-window selector', async () => {
  let calls = 0;
  const adapter = createPowerShellUiaAdapter({
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    execFile: async () => {
      calls += 1;
      return { stdout: '[]', stderr: '' };
    },
  });

  await assert.rejects(
    () => adapter.query({
      windowId: 'desktop',
      currentWindowProcessId: 77,
      role: '',
      name: '',
      limit: 2,
    }),
    /must be supplied together/,
  );
  await assert.rejects(
    () => adapter.query({
      windowId: 'desktop',
      currentWindowName: 'Editor',
      role: '',
      name: '',
      limit: 2,
    }),
    /must be supplied together/,
  );
  await assert.rejects(
    () => adapter.query({
      windowId: 'desktop',
      currentWindowProcessId: '77',
      currentWindowName: 'Editor',
      role: '',
      name: '',
      limit: 2,
    }),
    /currentWindowProcessId must be/,
  );
  assert.equal(calls, 0);
});

test('PowerShell UIA adapter rejects reusable target tokens returned as element identities', async () => {
  for (const elementId of ['hwnd:4242', 'win:4242:pid:77:rid:42.7.-3']) {
    const adapter = createPowerShellUiaAdapter({
      powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      execFile: async () => ({
        stdout: JSON.stringify([{
          elementId,
          processId: 77,
          role: 'Window',
          name: 'Old',
          enabled: true,
          offscreen: false,
        }]),
        stderr: '',
      }),
    });
    await assert.rejects(
      () => adapter.query({ windowId: 'desktop', role: '', name: '', limit: 2 }),
      error => error.code === 'WINDOWS_UIA_INVALID_RESPONSE',
    );
  }
});

test('PowerShell UIA adapter rejects invalid process identity in observation rows', async () => {
  const adapter = createPowerShellUiaAdapter({
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    execFile: async () => ({
      stdout: JSON.stringify([{
        elementId: 'rid:42.7.-3',
        processId: '77',
        role: 'Window',
        name: 'Editor',
        enabled: true,
        offscreen: false,
      }]),
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

test('Windows provider array boundaries snapshot length without ordinary Proxy reads', async () => {
  let reads = 0;
  const countReads = target => new Proxy(target, {
    get(object, property, receiver) {
      // Promise/await assimilation probes "then" on an object returned by an async
      // adapter. That language-level probe is not an authority-bearing array read.
      if (property !== 'then') reads += 1;
      return Reflect.get(object, property, receiver);
    },
  });

  const executables = countReads([
    {
      executableId: 'git',
      path: 'C:\\Program Files\\Git\\cmd\\git.exe',
      readOnly: false,
    },
  ]);
  const normalized = normalizeWindowsProviderConfig({
    schemaVersion: 1,
    executables,
  });
  assert.equal(normalized.executables[0].executableId, 'git');
  assert.equal(reads, 0, 'owner executable array must not perform ordinary caller reads');

  reads = 0;
  const args = countReads(['status']);
  const provider = createWindowsProvider({
    config,
    platform: 'win32',
    execFile: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    uiaAdapter: { query: async () => [] },
  });
  await provider.execPinned({ executableId: 'git', args });
  assert.equal(reads, 0, 'pinned command args must not perform ordinary caller reads');

  reads = 0;
  const rows = countReads([
    {
      elementId: 'rid:42.7.-3',
      processId: 77,
      role: 'button',
      name: 'Save',
      enabled: true,
      offscreen: false,
    },
  ]);
  const resultProvider = createWindowsProvider({
    config,
    platform: 'win32',
    execFile: async () => ({}),
    uiaAdapter: { query: async () => rows },
  });
  const result = await resultProvider.queryUia({ windowId: 'window-1', limit: 2 });
  assert.equal(result[0].elementId, 'rid:42.7.-3');
  assert.equal(reads, 0, 'UIA result array must not perform ordinary caller reads');
});

