# SalsaDevKit dev loop — install deps if needed, fix the electron binary (npm C8 gotcha), launch from source.
# Usage:  pwsh -NoProfile -File scripts\run-devkit.ps1
$ErrorActionPreference = 'Stop'
$env:npm_config_cache = 'I:\Apps\DevKit\cache\npm'
$env:PATH = "I:\Apps\DevKit\runtimes\node;$env:PATH"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Test-Path node_modules)) {
  Write-Output '── npm install ──'
  & npm.cmd install --no-audit --no-fund
} else {
  Write-Output 'node_modules present — skipping install'
}

# C8 gotcha: newer npm gates postinstall scripts behind an allowlist; verify the electron binary exists.
if (-not (Test-Path 'node_modules\electron\dist\electron.exe')) {
  Write-Output '── electron binary missing, running installer manually ──'
  & node.exe node_modules\electron\install.js
}

Write-Output '── launching SalsaDevKit from source ──'
Start-Process -FilePath (Join-Path $PSScriptRoot 'launch-devkit.bat') -WindowStyle Minimized
Write-Output 'launched (minimized console). Check the window or tray icon.'
