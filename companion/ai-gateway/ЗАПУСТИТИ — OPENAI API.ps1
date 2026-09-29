$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'NODE-HELPER.ps1')
$nodeExe = Ensure-AutopilotNodeExe
$keyFile = Join-Path $PSScriptRoot 'config\openai-key.dpapi'
$ptr = [IntPtr]::Zero
try {
  if (Test-Path $keyFile) {
    $encrypted = Get-Content -LiteralPath $keyFile -Raw
    $secure = ConvertTo-SecureString $encrypted
    Write-Host 'Використовую збережений DPAPI OpenAI key цього Windows-користувача.'
  } else {
    $secure = Read-Host 'Введіть OpenAI API key (лише для цього запуску)' -AsSecureString
  }
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $env:OPENAI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  Write-Host 'Запускаю ChatGPT Автопілот AI Gateway на 127.0.0.1:17621...'
  & $nodeExe (Join-Path $PSScriptRoot 'gateway.mjs')
}
finally {
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
}
