$ErrorActionPreference = 'Stop'
$regKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\org.chatgpt_autopilot.companion'
if (Test-Path $regKey) { Remove-Item -Path $regKey -Recurse -Force }
Write-Host 'Native Companion відв’язано від Chrome. Локальні файли не видалялися автоматично.'
