$ErrorActionPreference = 'Stop'
$version = '24.15.0'
$archiveName = "node-v$version-win-x64.zip"
$url = "https://nodejs.org/dist/v$version/$archiveName"
$expectedSha256 = 'cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62'
$runtimeRoot = Join-Path $PSScriptRoot 'runtime'
$targetDir = Join-Path $runtimeRoot "node-v$version-win-x64"
$nodeExe = Join-Path $targetDir 'node.exe'

if (Test-Path $nodeExe) {
  Write-Host "Portable Node уже є: $nodeExe"
  & $nodeExe --version
  exit 0
}

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$tempZip = Join-Path ([IO.Path]::GetTempPath()) ("chatgpt-autopilot-node-" + [Guid]::NewGuid().ToString('N') + '.zip')
try {
  Write-Host "Завантажую офіційний Node.js v$version Windows x64 з nodejs.org..."
  Invoke-WebRequest -Uri $url -OutFile $tempZip -UseBasicParsing
  $actual = (Get-FileHash -Path $tempZip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expectedSha256) {
    throw "SHA256 portable Node не збігається. Очікувався $expectedSha256, отримано $actual. Архів НЕ буде розпаковано."
  }
  Write-Host 'SHA256 перевірено. Розпаковую portable runtime...'
  Expand-Archive -Path $tempZip -DestinationPath $runtimeRoot -Force
  if (-not (Test-Path $nodeExe)) { throw "Після розпакування node.exe не знайдено: $nodeExe" }
  Write-Host "Portable Node готовий: $nodeExe"
  & $nodeExe --version
}
finally {
  Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
}
