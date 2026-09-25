function Get-AutopilotNodeExe {
  $local = Join-Path $PSScriptRoot 'runtime\node-v24.15.0-win-x64\node.exe'
  if (Test-Path $local) { return $local }
  $system = Get-Command node -ErrorAction SilentlyContinue
  if ($system) {
    try { $major = [int]((& $system.Source -p "process.versions.node.split('.')[0]").Trim()) }
    catch { $major = 0 }
    if ($major -ge 20) { return $system.Source }
  }
  return $null
}

function Ensure-AutopilotNodeExe {
  param([switch]$NonInteractive)
  $nodeExe = Get-AutopilotNodeExe
  if ($nodeExe) { return $nodeExe }
  if ($NonInteractive) { return $null }
  Write-Host 'Node.js 20+ не знайдено.'
  $answer = Read-Host 'Завантажити portable Node.js з офіційного nodejs.org і перевірити SHA256? (т/н)'
  if ($answer -notmatch '^(т|t|y|yes|так)$') { throw 'Node.js 20+ потрібен для AI Gateway.' }
  & (Join-Path $PSScriptRoot 'ПІДГОТУВАТИ PORTABLE NODE.ps1')
  $nodeExe = Get-AutopilotNodeExe
  if (-not $nodeExe) { throw 'Portable Node не вдалося підготувати.' }
  return $nodeExe
}
