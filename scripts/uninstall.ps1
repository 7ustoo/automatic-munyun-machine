# Automatic Munyun Machine — uninstall wrapper.
#
# Symmetric to the install one-liner. Two modes:
#   pause  — stop the bot + unregister scheduled tasks; preserves data
#   wipe   — pause + delete data/, config.json, .env, browser-profile
#
# Usage:
#   iwr -useb https://raw.githubusercontent.com/7ustoo/automatic-munyun-machine/main/scripts/uninstall.ps1 | iex
#
# Or locally:
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '=== Automatic Munyun Machine uninstaller ===' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Two modes:' -ForegroundColor Yellow
Write-Host '  [1] Pause  — stop bot + unregister scheduled tasks. Keeps data.' -ForegroundColor Yellow
Write-Host '  [2] Wipe   — pause + delete data/, config.json, .env, browser session.' -ForegroundColor Yellow
Write-Host ''

$choice = Read-Host 'Pick 1 or 2 (default: 1)'
if ([string]::IsNullOrWhiteSpace($choice)) { $choice = '1' }

$mode = switch ($choice) {
  '1' { 'pause' }
  '2' { 'wipe' }
  default {
    Write-Host "Unknown choice '$choice'. Aborting." -ForegroundColor Red
    exit 1
  }
}

if ($mode -eq 'wipe') {
  Write-Host ''
  Write-Host 'Wipe mode will DELETE:' -ForegroundColor Red
  Write-Host '  - data/ (CV, seen-jobs memory, applications log, batch history)' -ForegroundColor Red
  Write-Host '  - config.json (user settings)' -ForegroundColor Red
  Write-Host '  - .env (Telegram bot token + chat ID)' -ForegroundColor Red
  Write-Host '  - browser session (you will need to re-auth hiring.cafe)' -ForegroundColor Red
  Write-Host ''
  $confirm = Read-Host 'Type "wipe" to confirm'
  if ($confirm -ne 'wipe') {
    Write-Host 'Cancelled.' -ForegroundColor Yellow
    exit 0
  }
}

# Resolve install dir — assumes this script sits in <root>\scripts\
$ROOT = Split-Path -Parent $PSScriptRoot
$UNINSTALL_MJS = Join-Path $ROOT 'scripts\uninstall.mjs'

if (-not (Test-Path $UNINSTALL_MJS)) {
  Write-Host "Could not locate $UNINSTALL_MJS." -ForegroundColor Red
  Write-Host "Run this script from inside the AMM install directory, or use the .exe uninstaller." -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host "Running: node scripts\uninstall.mjs --mode=$mode" -ForegroundColor Cyan
& node $UNINSTALL_MJS "--mode=$mode"

if ($mode -eq 'wipe') {
  Write-Host ''
  Write-Host "All user data wiped. Install dir at $ROOT remains." -ForegroundColor Green
  Write-Host "To remove the code itself, delete that directory:" -ForegroundColor Green
  Write-Host "  Remove-Item -Recurse -Force '$ROOT'" -ForegroundColor Cyan
}
