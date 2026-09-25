$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'NODE-HELPER.ps1')
$null = Ensure-AutopilotNodeExe
$startupDir = [Environment]::GetFolderPath('Startup')
$linkPath = Join-Path $startupDir 'ChatGPT Автопілот AI Gateway.lnk'
$scriptPath = Join-Path $PSScriptRoot 'СТАРТ GATEWAY — АВТО.ps1'
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut($linkPath)
$shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = 'ChatGPT Автопілот — локальний AI Gateway'
$shortcut.Save()
Write-Host "Автозапуск увімкнено: $linkPath"
Write-Host 'Gateway стартуватиме після входу цього Windows-користувача.'
