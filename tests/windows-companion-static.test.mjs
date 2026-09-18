import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = name => fs.readFileSync(new URL(`../companion/ai-gateway/${name}`, import.meta.url), 'utf8');

test('Windows Gateway can prepare pinned portable Node 24.15.0 with official SHA256 verification', () => {
  const prepare = read('ПІДГОТУВАТИ PORTABLE NODE.ps1');
  assert.match(prepare, /node-v\$version-win-x64\.zip/);
  assert.match(prepare, /\$version = '24\.15\.0'/);
  assert.match(prepare, /https:\/\/nodejs\.org\/dist\/v\$version\/\$archiveName/);
  assert.match(prepare, /cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62/);
  assert.match(prepare, /Get-FileHash[\s\S]*SHA256/);
  assert.match(prepare, /if \(\$actual -ne \$expectedSha256\)/);
});

test('all Windows launch modes share portable-or-system Node helper', () => {
  const helper = read('NODE-HELPER.ps1');
  assert.match(helper, /runtime\\node-v24\.15\.0-win-x64\\node\.exe/);
  assert.match(helper, /Ensure-AutopilotNodeExe/);
  for (const name of ['ЗАПУСТИТИ — ЛОКАЛЬНИЙ ШІ.ps1','ЗАПУСТИТИ — OPENAI API.ps1','ЗАПУСТИТИ — LM STUDIO або OPENAI-COMPATIBLE.ps1']) {
    const script = read(name);
    assert.match(script, /NODE-HELPER\.ps1/);
    assert.match(script, /Ensure-AutopilotNodeExe/);
    assert.match(script, /\$nodeExe/);
  }
});

test('OpenAI key can be stored only as Windows DPAPI ciphertext for unattended startup', () => {
  const save = read('НАЛАШТУВАТИ OPENAI API КЛЮЧ.ps1');
  const auto = read('СТАРТ GATEWAY — АВТО.ps1');
  assert.match(save, /Read-Host[\s\S]*-AsSecureString/);
  assert.match(save, /ConvertFrom-SecureString/);
  assert.match(save, /openai-key\.dpapi/);
  assert.doesNotMatch(save, /Set-Content[^\n]*OPENAI_API_KEY/);
  assert.match(auto, /ConvertTo-SecureString/);
  assert.match(auto, /SecureStringToBSTR/);
  assert.match(auto, /Remove-Item Env:OPENAI_API_KEY/);
});

test('Windows startup shortcut launches hidden automatic Gateway starter', () => {
  const enable = read('УВІМКНУТИ АВТОЗАПУСК GATEWAY.ps1');
  const auto = read('СТАРТ GATEWAY — АВТО.ps1');
  assert.match(enable, /GetFolderPath\('Startup'\)/);
  assert.match(enable, /ChatGPT Автопілот AI Gateway\.lnk/);
  assert.match(enable, /WindowStyle Hidden/);
  assert.match(enable, /СТАРТ GATEWAY — АВТО\.ps1/);
  assert.match(auto, /Gateway-IsRunning/);
  assert.match(auto, /Start-Process[\s\S]*gateway\.mjs/);
  assert.match(auto, /Ensure-AutopilotNodeExe -NonInteractive/);
});

test('one-click Gateway launcher prepares Node if needed and starts hidden Gateway with saved DPAPI key when present', () => {
  const launch = read('ЗАПУСТИТИ GATEWAY.ps1');
  const cmd = read('ЗАПУСТИТИ GATEWAY.cmd');
  assert.match(launch, /Ensure-AutopilotNodeExe/);
  assert.match(launch, /openai-key\.dpapi/);
  assert.match(launch, /ConvertTo-SecureString/);
  assert.match(launch, /Start-Process[\s\S]*-WindowStyle Hidden/);
  assert.match(launch, /Gateway-IsRunning/);
  assert.match(cmd, /ЗАПУСТИТИ GATEWAY\.ps1/);
});

test('installer copies Gateway into LocalAppData without overwriting config/runtime and can enable autostart', () => {
  const install = read('ВСТАНОВИТИ АБО ОНОВИТИ AI GATEWAY.ps1');
  const cmd = read('ВСТАНОВИТИ AI GATEWAY.cmd');
  assert.match(install, /LOCALAPPDATA/);
  assert.match(install, /ChatGPT-Autopilot\\AI-Gateway/);
  assert.match(install, /'config', 'runtime', 'logs'/);
  assert.match(install, /runtime-state\\gateway\.pid/);
  assert.match(install, /ЗУПИНИТИ GATEWAY\.ps1/);
  assert.match(install, /ПІДГОТУВАТИ PORTABLE NODE\.ps1/);
  assert.match(install, /УВІМКНУТИ АВТОЗАПУСК GATEWAY\.ps1/);
  assert.match(install, /ЗАПУСТИТИ GATEWAY\.ps1/);
  assert.match(cmd, /ВСТАНОВИТИ АБО ОНОВИТИ AI GATEWAY\.ps1/);
});

test('Gateway stop/restart uses a PID file and refuses to kill unrelated processes', () => {
  const stop = read('ЗУПИНИТИ GATEWAY.ps1');
  const restart = read('ПЕРЕЗАПУСТИТИ GATEWAY.ps1');
  assert.match(stop, /runtime-state\\gateway\.pid/);
  assert.match(stop, /Get-CimInstance Win32_Process/);
  assert.match(stop, /gateway\\\.mjs/);
  assert.match(stop, /Stop-Process -Id \$gatewayPid/);
  assert.match(restart, /ЗУПИНИТИ GATEWAY\.ps1/);
  assert.match(restart, /ЗАПУСТИТИ GATEWAY\.ps1/);
});

test('OpenAI-compatible API key can persist via DPAPI for one-click and autostart Gateway', () => {
  const save = read('НАЛАШТУВАТИ OPENAI-COMPATIBLE API КЛЮЧ.ps1');
  const remove = read('ВИДАЛИТИ ЗБЕРЕЖЕНИЙ OPENAI-COMPATIBLE КЛЮЧ.ps1');
  const launch = read('ЗАПУСТИТИ GATEWAY.ps1');
  const auto = read('СТАРТ GATEWAY — АВТО.ps1');
  const interactive = read('ЗАПУСТИТИ — LM STUDIO або OPENAI-COMPATIBLE.ps1');
  const menu = read('СТАРТ — ВИБРАТИ РЕЖИМ.ps1');
  assert.match(save, /Read-Host[\s\S]*-AsSecureString/);
  assert.match(save, /ConvertFrom-SecureString/);
  assert.match(save, /compatible-key\.dpapi/);
  assert.doesNotMatch(save, /Set-Content[^\n]*COMPATIBLE_API_KEY/);
  assert.match(remove, /compatible-key\.dpapi/);
  for (const script of [launch, auto]) {
    assert.match(script, /compatible-key\.dpapi/);
    assert.match(script, /ConvertTo-SecureString/);
    assert.match(script, /COMPATIBLE_API_KEY/);
    assert.match(script, /Remove-Item Env:COMPATIBLE_API_KEY/);
  }
  assert.match(interactive, /compatible-key\.dpapi/);
  assert.match(menu, /НАЛАШТУВАТИ OPENAI-COMPATIBLE API КЛЮЧ\.ps1/);
  assert.match(menu, /ВИДАЛИТИ ЗБЕРЕЖЕНИЙ OPENAI-COMPATIBLE КЛЮЧ\.ps1/);
});


test('generic OpenAI-compatible endpoint setup requires HTTPS for remote hosts and preserves LM Studio alias', () => {
  const setup = read('НАЛАШТУВАТИ OPENAI-COMPATIBLE АДРЕСУ.ps1');
  const legacy = read('НАЛАШТУВАТИ LM STUDIO АДРЕСУ.ps1');
  const menu = read('СТАРТ — ВИБРАТИ РЕЖИМ.ps1');
  assert.match(setup, /Uri\]::TryCreate/);
  assert.match(setup, /http.*https/si);
  assert.match(setup, /localhost.*loopback|loopback.*localhost/si);
  assert.match(setup, /Віддалений OpenAI-compatible API повинен використовувати HTTPS/);
  assert.match(setup, /gateway-settings\.json/);
  assert.match(legacy, /НАЛАШТУВАТИ OPENAI-COMPATIBLE АДРЕСУ\.ps1/);
  assert.match(menu, /НАЛАШТУВАТИ OPENAI-COMPATIBLE АДРЕСУ\.ps1/);
});


test('Windows companion exposes explicit bounded Chrome-extension pairing and reset scripts', () => {
  const open = read('ВІДКРИТИ ПРИВЯЗКУ CHROME РОЗШИРЕННЯ.ps1');
  const reset = read('СКИНУТИ ПРИВЯЗКУ CHROME РОЗШИРЕННЯ.ps1');
  const menu = read('СТАРТ — ВИБРАТИ РЕЖИМ.ps1');
  const installer = read('ВСТАНОВИТИ АБО ОНОВИТИ AI GATEWAY.ps1');
  assert.match(open, /pairing-window\.json/);
  assert.match(open, /AddMinutes\(5\)/);
  assert.match(open, /extension-origin\.json/);
  assert.doesNotMatch(open, /Remove-Item[^\n]*extension-origin\.json/);
  assert.match(reset, /Remove-Item[\s\S]*extension-origin\.json|extension-origin\.json[\s\S]*Remove-Item/);
  assert.match(reset, /pairing-window\.json/);
  assert.match(menu, /ВІДКРИТИ ПРИВЯЗКУ CHROME РОЗШИРЕННЯ\.ps1/);
  assert.match(menu, /СКИНУТИ ПРИВЯЗКУ CHROME РОЗШИРЕННЯ\.ps1/);
  assert.match(installer, /ВІДКРИТИ ПРИВЯЗКУ CHROME РОЗШИРЕННЯ\.ps1/);
});
