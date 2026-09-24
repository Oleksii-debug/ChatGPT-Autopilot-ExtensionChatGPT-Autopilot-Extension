const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\\[^\0]+$/u;
const MAX_TEXT = 4096;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 8192;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_UIA_RESULTS = 256;
const UIA_PROCESS_TIMEOUT_MS = 15_000;
const UIA_MAX_VISITED = 4096;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function clean(value, max = MAX_TEXT) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function exactObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('WINDOWS_INVALID_REQUEST', label + ' must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('WINDOWS_INVALID_REQUEST', label + ' must be a plain object');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail('WINDOWS_INVALID_REQUEST', label + ' contains unknown field: ' + String(key));
    }
  }
}

function id(value, label) {
  const out = clean(value, 128);
  if (!ID.test(out)) fail('WINDOWS_INVALID_REQUEST', label + ' is invalid');
  return out;
}

function boundedOptionalText(value, label, max) {
  if (value == null) return '';
  if (typeof value !== 'string') fail('WINDOWS_INVALID_REQUEST', label + ' must be text');
  if (value.length > max) fail('WINDOWS_INVALID_REQUEST', label + ' is too large');
  return value.trim();
}

function boundedArgs(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGS) {
    fail('WINDOWS_INVALID_REQUEST', 'args must contain at most ' + MAX_ARGS + ' items');
  }
  let chars = 0;
  return value.map((item, index) => {
    if (typeof item !== 'string') fail('WINDOWS_INVALID_REQUEST', 'args[' + index + '] must be text');
    chars += item.length;
    if (chars > MAX_ARG_CHARS) fail('WINDOWS_INVALID_REQUEST', 'args are too large');
    return item;
  });
}

function normalizeExecutable(raw, index) {
  exactObject(raw, new Set(['executableId', 'path', 'readOnly']), 'executables[' + index + ']');
  const executableId = id(raw.executableId, 'executables[' + index + '].executableId');
  const executablePath = clean(raw.path, 32000);
  if (!executablePath || !WINDOWS_ABSOLUTE_PATH.test(executablePath)) {
    fail('WINDOWS_CONFIG_INVALID', 'executables[' + index + '].path must be an absolute Windows path');
  }
  if (raw.readOnly != null && typeof raw.readOnly !== 'boolean') {
    fail('WINDOWS_CONFIG_INVALID', 'executables[' + index + '].readOnly must be boolean');
  }
  return Object.freeze({ executableId, path: executablePath, readOnly: raw.readOnly === true });
}

export function normalizeWindowsProviderConfig(raw) {
  exactObject(raw, new Set(['schemaVersion', 'executables']), 'windows provider config');
  if (raw.schemaVersion !== 1) fail('WINDOWS_CONFIG_INVALID', 'windows provider config schemaVersion must be 1');
  if (!Array.isArray(raw.executables) || raw.executables.length > 64) {
    fail('WINDOWS_CONFIG_INVALID', 'executables must be a bounded array');
  }
  const executables = raw.executables.map(normalizeExecutable);
  if (new Set(executables.map(item => item.executableId)).size !== executables.length) {
    fail('WINDOWS_CONFIG_INVALID', 'executableId values must be unique');
  }
  return Object.freeze({ schemaVersion: 1, executables: Object.freeze(executables) });
}

function requireWindows(platform) {
  if (platform !== 'win32') fail('WINDOWS_UNAVAILABLE', 'Windows provider is available only on Windows');
}

function normalizeOutput(value) {
  const text = typeof value === 'string' ? value : Buffer.from(value || '').toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) {
    fail('WINDOWS_OUTPUT_TOO_LARGE', 'Windows process output exceeded the bounded limit');
  }
  return text;
}

function strictInteger(value, label, min, max, fallback) {
  if (value == null && fallback != null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail('WINDOWS_INVALID_REQUEST', label + ' must be ' + min + '..' + max);
  }
  return value;
}

function systemPowerShellPath(explicitPath = null) {
  if (explicitPath != null) {
    if (typeof explicitPath !== 'string' || !WINDOWS_ABSOLUTE_PATH.test(explicitPath.trim())) {
      fail('WINDOWS_UIA_UNAVAILABLE', 'PowerShell path is invalid');
    }
    return explicitPath.trim();
  }
  const root = clean(process.env.SystemRoot || process.env.WINDIR, 32000);
  if (!root || !WINDOWS_ABSOLUTE_PATH.test(root + '\\placeholder')) {
    fail('WINDOWS_UIA_UNAVAILABLE', 'Windows SystemRoot is unavailable');
  }
  return root.replace(/[\\/]+$/u, '') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
}

function canonicalRuntimeId(value, code, label) {
  if (typeof value !== 'string' || !/^-?[0-9]{1,11}(?:\.-?[0-9]{1,11}){0,31}$/u.test(value)) {
    fail(code, label + ' is invalid');
  }
  const parts = value.split('.');
  const canonical = [];
  for (const part of parts) {
    let component;
    try {
      component = BigInt(part);
    } catch {
      fail(code, label + ' is invalid');
    }
    if (component < -2147483648n || component > 2147483647n || component.toString() !== part) {
      fail(code, label + ' is invalid');
    }
    canonical.push(part);
  }
  return canonical.join('.');
}

function canonicalPowerShellWindowId(value) {
  const windowId = id(value, 'windowId');
  if (windowId === 'desktop') return windowId;
  const match = /^win:([1-9][0-9]{0,18}):pid:([1-9][0-9]{0,9}):rid:(.+)$/u.exec(windowId);
  if (!match) {
    fail('WINDOWS_INVALID_REQUEST', 'windowId must be desktop or an observation-bound win:<hwnd>:pid:<pid>:rid:<runtimeId> reference');
  }
  const handle = BigInt(match[1]);
  const processId = BigInt(match[2]);
  if (handle > 9223372036854775807n) {
    fail('WINDOWS_INVALID_REQUEST', 'windowId exceeds the supported Windows handle range');
  }
  if (processId > 2147483647n) {
    fail('WINDOWS_INVALID_REQUEST', 'windowId process identity exceeds the supported range');
  }
  const runtimeId = canonicalRuntimeId(match[3], 'WINDOWS_INVALID_REQUEST', 'windowId runtime identity');
  const canonical = 'win:' + match[1] + ':pid:' + match[2] + ':rid:' + runtimeId;
  if (canonical !== windowId) {
    fail('WINDOWS_INVALID_REQUEST', 'windowId must use canonical observation identity encoding');
  }
  return canonical;
}

function canonicalPowerShellElementId(value) {
  const elementId = id(value, 'UIA elementId');
  if (elementId.startsWith('win:')) {
    try {
      return canonicalPowerShellWindowId(elementId);
    } catch {
      fail('WINDOWS_UIA_INVALID_RESPONSE', 'UI Automation returned an invalid observation-bound window identity');
    }
  }
  const match = /^rid:(.+)$/u.exec(elementId);
  if (!match) {
    fail('WINDOWS_UIA_INVALID_RESPONSE', 'UI Automation returned a non-canonical element identity');
  }
  return 'rid:' + canonicalRuntimeId(match[1], 'WINDOWS_UIA_INVALID_RESPONSE', 'UIA runtime identity');
}

function windowsChildEnvironment() {
  const keys = [
    'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'COMSPEC',
    'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
  ];
  const env = {};
  for (const key of keys) {
    if (typeof process.env[key] === 'string' && process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function encodePowerShellUiaScript(request) {
  const requestBase64 = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    "$requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + requestBase64 + "'))",
    "$request = $requestJson | ConvertFrom-Json",
    "$limit = [int]$request.limit",
    "$maxVisited = " + UIA_MAX_VISITED,
    "$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker",
    "$root = $null",
    "$desktop = $false",
    "if ([string]$request.windowId -eq 'desktop') {",
    "  $root = [System.Windows.Automation.AutomationElement]::RootElement",
    "  $desktop = $true",
    "} elseif ([string]$request.windowId -match '^win:([1-9][0-9]{0,18}):pid:([1-9][0-9]{0,9}):rid:(-?[0-9]+(?:\\.-?[0-9]+){0,31})$') {",
    "  $expectedHandle = [Int64]$Matches[1]",
    "  $expectedProcessId = [Int32]$Matches[2]",
    "  $expectedRuntimeId = [string]$Matches[3]",
    "  if ($expectedHandle -le 0 -or $expectedProcessId -le 0) { throw 'Invalid UIA window reference' }",
    "  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$expectedHandle)",
    "  if ($null -eq $root) { throw 'UIA window reference is stale' }",
    "  $rootCurrent = $root.Current",
    "  $rootHandle = [Int64]$rootCurrent.NativeWindowHandle",
    "  if ($rootHandle -lt 0) { $rootHandle += 4294967296 }",
    "  $rootProcessId = [Int32]$rootCurrent.ProcessId",
    "  $rootRuntime = $root.GetRuntimeId()",
    "  if ($null -eq $rootRuntime -or $rootRuntime.Count -eq 0) { throw 'UIA window reference is stale' }",
    "  $rootRuntimeId = (($rootRuntime | ForEach-Object { [string]$_ }) -join '.')",
    "  if ($rootHandle -ne $expectedHandle -or $rootProcessId -ne $expectedProcessId -or -not [string]::Equals($rootRuntimeId, $expectedRuntimeId, [StringComparison]::Ordinal)) {",
    "    throw 'UIA window reference is stale'",
    "  }",
    "} else {",
    "  throw 'windowId must be desktop or observation-bound win:<hwnd>:pid:<pid>:rid:<runtimeId>'",
    "}",
    "$results = New-Object System.Collections.Generic.List[object]",
    "function Add-UiRow([System.Windows.Automation.AutomationElement]$element) {",
    "  try {",
    "    $current = $element.Current",
    "    $role = [string]$current.ControlType.ProgrammaticName",
    "    if ($role.StartsWith('ControlType.')) { $role = $role.Substring(12) }",
    "    $name = [string]$current.Name",
    "    if ($request.role -and -not [string]::Equals($role, [string]$request.role, [StringComparison]::OrdinalIgnoreCase)) { return }",
    "    if ($request.name -and $name.IndexOf([string]$request.name, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return }",
    "    $runtimeId = $element.GetRuntimeId()",
    "    if ($null -eq $runtimeId -or $runtimeId.Count -eq 0) { return }",
    "    $runtimeText = (($runtimeId | ForEach-Object { [string]$_ }) -join '.')",
    "    $nativeHandle = [Int64]$current.NativeWindowHandle",
    "    if ($nativeHandle -lt 0) { $nativeHandle += 4294967296 }",
    "    $processId = [Int32]$current.ProcessId",
    "    if ($nativeHandle -gt 0 -and $processId -gt 0) {",
    "      $elementId = 'win:' + [string]$nativeHandle + ':pid:' + [string]$processId + ':rid:' + $runtimeText",
    "    } else {",
    "      $elementId = 'rid:' + $runtimeText",
    "    }",
    "    $results.Add([pscustomobject]@{",
    "      elementId = $elementId",
    "      role = $role",
    "      name = $name",
    "      enabled = [bool]$current.IsEnabled",
    "      offscreen = [bool]$current.IsOffscreen",
    "    })",
    "  } catch {",
    "    return",
    "  }",
    "}",
    "if ($desktop) {",
    "  $element = $walker.GetFirstChild($root)",
    "  $visited = 0",
    "  while ($null -ne $element -and $results.Count -lt $limit) {",
    "    $visited++",
    "    if ($visited -gt $maxVisited) { throw 'UIA traversal exceeded bounded visit limit' }",
    "    Add-UiRow $element",
    "    $element = $walker.GetNextSibling($element)",
    "  }",
    "} else {",
    "  $queue = New-Object System.Collections.Queue",
    "  $child = $walker.GetFirstChild($root)",
    "  while ($null -ne $child) {",
    "    if ($queue.Count -ge $maxVisited) { throw 'UIA traversal exceeded bounded visit limit' }",
    "    $queue.Enqueue($child)",
    "    $child = $walker.GetNextSibling($child)",
    "  }",
    "  $visited = 0",
    "  while ($queue.Count -gt 0 -and $results.Count -lt $limit) {",
    "    $visited++",
    "    if ($visited -gt $maxVisited) { throw 'UIA traversal exceeded bounded visit limit' }",
    "    $element = [System.Windows.Automation.AutomationElement]$queue.Dequeue()",
    "    Add-UiRow $element",
    "    if ($results.Count -ge $limit) { break }",
    "    $child = $walker.GetFirstChild($element)",
    "    while ($null -ne $child) {",
    "      if (($visited + $queue.Count) -ge $maxVisited) { throw 'UIA traversal exceeded bounded visit limit' }",
    "      $queue.Enqueue($child)",
    "      $child = $walker.GetNextSibling($child)",
    "    }",
    "  }",
    "}",
    "$json = ConvertTo-Json -InputObject ($results.ToArray()) -Compress -Depth 3",
    "[Console]::Out.Write($json)",
  ].join('\n');
  return Buffer.from(script, 'utf16le').toString('base64');
}

function normalizeUiaRows(rows, limit) {
  if (!Array.isArray(rows) || rows.length > limit) {
    fail('WINDOWS_UIA_INVALID_RESPONSE', 'UI Automation adapter returned an invalid result set');
  }
  return Object.freeze(rows.map((row, index) => {
    exactObject(row, new Set(['elementId', 'role', 'name', 'enabled', 'offscreen']), 'UIA result[' + index + ']');
    if (typeof row.role !== 'string' || row.role.length > 120) {
      fail('WINDOWS_UIA_INVALID_RESPONSE', 'UIA result[' + index + '].role is invalid');
    }
    if (typeof row.name !== 'string' || row.name.length > 512) {
      fail('WINDOWS_UIA_INVALID_RESPONSE', 'UIA result[' + index + '].name is invalid');
    }
    if (typeof row.enabled !== 'boolean' || typeof row.offscreen !== 'boolean') {
      fail('WINDOWS_UIA_INVALID_RESPONSE', 'UIA result[' + index + '] state must be boolean');
    }
    return Object.freeze({
      elementId: id(row.elementId, 'UIA result[' + index + '].elementId'),
      role: row.role.trim(),
      name: row.name.trim(),
      enabled: row.enabled,
      offscreen: row.offscreen,
    });
  }));
}

export function createPowerShellUiaAdapter({ execFile, powershellPath = null } = {}) {
  if (typeof execFile !== 'function') fail('WINDOWS_CONFIG_INVALID', 'execFile adapter is required');
  return Object.freeze({
    async query(payload = {}) {
      exactObject(payload, new Set(['windowId', 'role', 'name', 'limit']), 'PowerShell UIA query');
      const request = {
        windowId: canonicalPowerShellWindowId(payload.windowId),
        role: boundedOptionalText(payload.role, 'role', 120),
        name: boundedOptionalText(payload.name, 'name', 512),
        limit: strictInteger(payload.limit, 'limit', 1, MAX_UIA_RESULTS, 64),
      };
      const encoded = encodePowerShellUiaScript(request);
      let result;
      try {
        result = await execFile(
          systemPowerShellPath(powershellPath),
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          {
            windowsHide: true,
            timeout: UIA_PROCESS_TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT_BYTES,
            encoding: 'utf8',
            env: windowsChildEnvironment(),
          },
        );
      } catch (error) {
        const wrapped = new Error('Windows UI Automation query failed');
        wrapped.code = 'WINDOWS_UIA_FAILED';
        wrapped.cause = error;
        throw wrapped;
      }
      const stdout = normalizeOutput(result?.stdout).trim();
      let parsed;
      try {
        parsed = stdout ? JSON.parse(stdout) : [];
      } catch {
        fail('WINDOWS_UIA_INVALID_RESPONSE', 'Windows UI Automation returned invalid JSON');
      }
      const rows = normalizeUiaRows(parsed, request.limit);
      return Object.freeze(rows.map(row => Object.freeze({
        ...row,
        elementId: canonicalPowerShellElementId(row.elementId),
      })));
    },
  });
}

export function createWindowsProvider({
  config,
  platform = process.platform,
  execFile,
  uiaAdapter = null,
  powershellPath = null,
} = {}) {
  const normalized = normalizeWindowsProviderConfig(config);
  if (typeof execFile !== 'function') fail('WINDOWS_CONFIG_INVALID', 'execFile adapter is required');
  const effectiveUiaAdapter = uiaAdapter || (
    platform === 'win32' ? createPowerShellUiaAdapter({ execFile, powershellPath }) : null
  );

  return Object.freeze({
    capabilities() {
      return Object.freeze([
        { capabilityId: 'windows.process.execPinned', readOnly: false, scoped: true },
        {
          capabilityId: 'windows.uia.query',
          readOnly: true,
          scoped: true,
          available: typeof effectiveUiaAdapter?.query === 'function',
          windowIdFormat: 'desktop | win:<hwnd>:pid:<pid>:rid:<runtimeId>',
        },
      ]);
    },

    async execPinned(payload) {
      requireWindows(platform);
      exactObject(payload, new Set(['executableId', 'args', 'timeoutMs']), 'windows process request');
      const executableId = id(payload.executableId, 'executableId');
      const executable = normalized.executables.find(item => item.executableId === executableId);
      if (!executable) fail('WINDOWS_EXECUTABLE_NOT_ALLOWED', 'Executable identity is not owner-configured');
      const args = boundedArgs(payload.args);
      const timeoutMs = strictInteger(payload.timeoutMs, 'timeoutMs', 100, 120_000, 30_000);
      const result = await execFile(executable.path, args, {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      return Object.freeze({
        executableId,
        exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 0,
        stdout: normalizeOutput(result?.stdout),
        stderr: normalizeOutput(result?.stderr),
      });
    },

    async queryUia(payload) {
      requireWindows(platform);
      if (!effectiveUiaAdapter || typeof effectiveUiaAdapter.query !== 'function') {
        fail('WINDOWS_UIA_UNAVAILABLE', 'UI Automation adapter is unavailable');
      }
      exactObject(payload, new Set(['windowId', 'role', 'name', 'limit']), 'UIA query');
      const windowId = id(payload.windowId, 'windowId');
      const role = boundedOptionalText(payload.role, 'role', 120);
      const name = boundedOptionalText(payload.name, 'name', 512);
      const limit = strictInteger(payload.limit, 'limit', 1, MAX_UIA_RESULTS, 64);
      const rows = await effectiveUiaAdapter.query({ windowId, role, name, limit });
      return normalizeUiaRows(rows, limit);
    },
  });
}
