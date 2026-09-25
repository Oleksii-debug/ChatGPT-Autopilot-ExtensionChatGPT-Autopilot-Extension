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

function exactObject(value, allowed, label, code = 'WINDOWS_INVALID_REQUEST') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, label + ' must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, label + ' must be a plain object');
  }
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail(code, label + ' contains unknown field: ' + String(key));
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      fail(code, label + ' fields must be enumerable data properties');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function denseDataArray(value, label, maxLength, code = 'WINDOWS_INVALID_REQUEST') {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(code, label + ' must be a bounded dense array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > maxLength) {
    fail(code, label + ' must be a bounded dense array');
  }
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some(key => typeof key === 'symbol')) {
    fail(code, label + ' must contain only canonical data indices');
  }
  const names = ownKeys.filter(key => key !== 'length');
  if (names.length !== length) {
    fail(code, label + ' must be a bounded dense array');
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      fail(code, label + ' must contain only enumerable data items');
    }
    out[index] = descriptor.value;
  }
  return out;
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
  const items = denseDataArray(value, 'args', MAX_ARGS);
  let chars = 0;
  return items.map((item, index) => {
    if (typeof item !== 'string') fail('WINDOWS_INVALID_REQUEST', 'args[' + index + '] must be text');
    chars += item.length;
    if (chars > MAX_ARG_CHARS) fail('WINDOWS_INVALID_REQUEST', 'args are too large');
    return item;
  });
}

function normalizeExecutable(raw, index) {
  const data = exactObject(
    raw,
    new Set(['executableId', 'path', 'readOnly']),
    'executables[' + index + ']',
    'WINDOWS_CONFIG_INVALID',
  );
  const executableId = id(data.executableId, 'executables[' + index + '].executableId');
  const executablePath = clean(data.path, 32000);
  if (!executablePath || !WINDOWS_ABSOLUTE_PATH.test(executablePath)) {
    fail('WINDOWS_CONFIG_INVALID', 'executables[' + index + '].path must be an absolute Windows path');
  }
  if (data.readOnly != null && typeof data.readOnly !== 'boolean') {
    fail('WINDOWS_CONFIG_INVALID', 'executables[' + index + '].readOnly must be boolean');
  }
  return Object.freeze({ executableId, path: executablePath, readOnly: data.readOnly === true });
}

export function normalizeWindowsProviderConfig(raw) {
  const data = exactObject(
    raw,
    new Set(['schemaVersion', 'executables']),
    'windows provider config',
    'WINDOWS_CONFIG_INVALID',
  );
  if (data.schemaVersion !== 1) fail('WINDOWS_CONFIG_INVALID', 'windows provider config schemaVersion must be 1');
  const rawExecutables = denseDataArray(
    data.executables,
    'executables',
    64,
    'WINDOWS_CONFIG_INVALID',
  );
  const executables = rawExecutables.map(normalizeExecutable);
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
  if (windowId !== 'desktop') {
    fail(
      'WINDOWS_INVALID_REQUEST',
      'Production PowerShell UIA accepts only desktop; select a current window with currentWindowProcessId + currentWindowName in the same observation',
    );
  }
  return 'desktop';
}

function canonicalPowerShellElementId(value) {
  const elementId = id(value, 'UIA elementId');
  const match = /^rid:(.+)$/u.exec(elementId);
  if (!match) {
    fail(
      'WINDOWS_UIA_INVALID_RESPONSE',
      'UI Automation elementId must be an observation-only runtime identity and cannot be reused as a window target',
    );
  }
  return 'rid:' + canonicalRuntimeId(match[1], 'WINDOWS_UIA_INVALID_RESPONSE', 'UIA runtime identity');
}

function currentWindowSelector(data) {
  const hasProcessId = data.currentWindowProcessId != null;
  const processId = hasProcessId
    ? strictInteger(data.currentWindowProcessId, 'currentWindowProcessId', 1, 2147483647)
    : null;
  const windowName = boundedOptionalText(data.currentWindowName, 'currentWindowName', 512);
  const hasWindowName = windowName.length > 0;
  if (hasProcessId !== hasWindowName) {
    fail(
      'WINDOWS_INVALID_REQUEST',
      'currentWindowProcessId and currentWindowName must be supplied together for fresh current-state selection',
    );
  }
  return hasProcessId ? Object.freeze({ processId, windowName }) : null;
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
    "$root = [System.Windows.Automation.AutomationElement]::RootElement",
    "$desktop = $true",
    "if ($null -ne $request.currentWindowProcessId -or -not [string]::IsNullOrEmpty([string]$request.currentWindowName)) {",
    "  if ($null -eq $request.currentWindowProcessId -or [string]::IsNullOrEmpty([string]$request.currentWindowName)) { throw 'Fresh UIA window selector is incomplete' }",
    "  $expectedProcessId = [Int32]$request.currentWindowProcessId",
    "  $expectedWindowName = [string]$request.currentWindowName",
    "  $matchedWindow = $null",
    "  $matchCount = 0",
    "  $candidate = $walker.GetFirstChild($root)",
    "  $selectorVisited = 0",
    "  while ($null -ne $candidate) {",
    "    $selectorVisited++",
    "    if ($selectorVisited -gt $maxVisited) { throw 'UIA window selection exceeded bounded visit limit' }",
    "    try {",
    "      $candidateCurrent = $candidate.Current",
    "      if ([Int32]$candidateCurrent.ProcessId -eq $expectedProcessId -and [string]::Equals([string]$candidateCurrent.Name, $expectedWindowName, [StringComparison]::Ordinal)) {",
    "        $matchedWindow = $candidate",
    "        $matchCount++",
    "        if ($matchCount -gt 1) { break }",
    "      }",
    "    } catch { }",
    "    $candidate = $walker.GetNextSibling($candidate)",
    "  }",
    "  if ($matchCount -ne 1 -or $null -eq $matchedWindow) { throw 'Fresh UIA window selector did not resolve exactly one current window' }",
    "  $root = $matchedWindow",
    "  $desktop = $false",
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
    "    $processId = [Int32]$current.ProcessId",
    "    if ($processId -le 0) { return }",
    "    $results.Add([pscustomobject]@{",
    "      elementId = 'rid:' + $runtimeText",
    "      processId = $processId",
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
  const items = denseDataArray(
    rows,
    'UI Automation adapter result',
    limit,
    'WINDOWS_UIA_INVALID_RESPONSE',
  );
  return Object.freeze(items.map((row, index) => {
    const data = exactObject(
      row,
      new Set(['elementId', 'processId', 'role', 'name', 'enabled', 'offscreen']),
      'UIA result[' + index + ']',
      'WINDOWS_UIA_INVALID_RESPONSE',
    );
    if (typeof data.role !== 'string' || data.role.length > 120) {
      fail('WINDOWS_UIA_INVALID_RESPONSE', 'UIA result[' + index + '].role is invalid');
    }
    if (typeof data.name !== 'string' || data.name.length > 512) {
      fail('WINDOWS_UIA_INVALID_RESPONSE', 'UIA result[' + index + '].name is invalid');
    }
    if (typeof data.enabled !== 'boolean' || typeof data.offscreen !== 'boolean') {
      fail('WINDOWS_UIA_INVALID_RESPONSE', 'UIA result[' + index + '] state must be boolean');
    }
    if (data.processId != null
      && (typeof data.processId !== 'number'
        || !Number.isInteger(data.processId)
        || data.processId < 1
        || data.processId > 2147483647)) {
      fail('WINDOWS_UIA_INVALID_RESPONSE', 'UIA result[' + index + '].processId is invalid');
    }
    const normalized = {
      elementId: id(data.elementId, 'UIA result[' + index + '].elementId'),
      role: data.role.trim(),
      name: data.name.trim(),
      enabled: data.enabled,
      offscreen: data.offscreen,
    };
    if (data.processId != null) normalized.processId = data.processId;
    return Object.freeze(normalized);
  }));
}

export function createPowerShellUiaAdapter({ execFile, powershellPath = null } = {}) {
  if (typeof execFile !== 'function') fail('WINDOWS_CONFIG_INVALID', 'execFile adapter is required');
  return Object.freeze({
    async query(payload = {}) {
      const data = exactObject(
        payload,
        new Set(['windowId', 'currentWindowProcessId', 'currentWindowName', 'role', 'name', 'limit']),
        'PowerShell UIA query',
      );
      const selector = currentWindowSelector(data);
      const request = {
        windowId: canonicalPowerShellWindowId(data.windowId),
        role: boundedOptionalText(data.role, 'role', 120),
        name: boundedOptionalText(data.name, 'name', 512),
        limit: strictInteger(data.limit, 'limit', 1, MAX_UIA_RESULTS, 64),
      };
      if (selector) {
        request.currentWindowProcessId = selector.processId;
        request.currentWindowName = selector.windowName;
      }
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
          windowIdFormat: 'desktop',
          windowSelection: 'fresh currentWindowProcessId + currentWindowName, re-resolved in the same observation',
          elementIdSemantics: 'observation-only; never reusable as a window target',
        },
      ]);
    },

    async execPinned(payload) {
      requireWindows(platform);
      const data = exactObject(payload, new Set(['executableId', 'args', 'timeoutMs']), 'windows process request');
      const executableId = id(data.executableId, 'executableId');
      const executable = normalized.executables.find(item => item.executableId === executableId);
      if (!executable) fail('WINDOWS_EXECUTABLE_NOT_ALLOWED', 'Executable identity is not owner-configured');
      const args = boundedArgs(data.args);
      const timeoutMs = strictInteger(data.timeoutMs, 'timeoutMs', 100, 120_000, 30_000);
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
      const data = exactObject(
        payload,
        new Set(['windowId', 'currentWindowProcessId', 'currentWindowName', 'role', 'name', 'limit']),
        'UIA query',
      );
      const windowId = id(data.windowId, 'windowId');
      const selector = currentWindowSelector(data);
      const role = boundedOptionalText(data.role, 'role', 120);
      const name = boundedOptionalText(data.name, 'name', 512);
      const limit = strictInteger(data.limit, 'limit', 1, MAX_UIA_RESULTS, 64);
      const request = { windowId, role, name, limit };
      if (selector) {
        request.currentWindowProcessId = selector.processId;
        request.currentWindowName = selector.windowName;
      }
      const rows = await effectiveUiaAdapter.query(request);
      return normalizeUiaRows(rows, limit);
    },
  });
}
