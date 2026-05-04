# Automatic Munyun Machine — one-liner installer.
#
# Run via:
#   iwr -useb https://raw.githubusercontent.com/7ustoo/automatic-munyun-machine/main/install.ps1 | iex
#
# Installs Node.js + Git (if missing), clones the repo, installs deps, downloads
# Chromium, and launches the interactive setup wizard.

$ErrorActionPreference = 'Stop'

# Branding header
$banner = @"

  $('═' * 60)
  AUTOMATIC MUNYUN MACHINE — Installer
  Daily 100-job Telegram batch, scored against your CV
  $('═' * 60)
"@
Write-Host $banner -ForegroundColor Cyan

# 1. Pick install location
$INSTALL_DIR = Join-Path $env:LOCALAPPDATA 'automatic-munyun-machine'
$REPO_URL = 'https://github.com/7ustoo/automatic-munyun-machine.git'

# 2. Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "`n[1/5] Node.js not found. Installing via winget..." -ForegroundColor Yellow
  try {
    winget install -e --id OpenJS.NodeJS --silent --accept-package-agreements --accept-source-agreements
  } catch {
    Write-Host "winget install failed. Install Node.js manually from https://nodejs.org/ then re-run." -ForegroundColor Red
    exit 1
  }
  # Refresh PATH for current session
  $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
} else {
  Write-Host "[1/5] Node.js found: $(node --version)" -ForegroundColor Green
}

# 3. Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "`n[2/5] Git not found. Installing via winget..." -ForegroundColor Yellow
  try {
    winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements
  } catch {
    Write-Host "winget install failed. Install Git manually from https://git-scm.com/ then re-run." -ForegroundColor Red
    exit 1
  }
  $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
} else {
  Write-Host "[2/5] Git found: $(git --version)" -ForegroundColor Green
}

# 4. Clone or update repo
if (Test-Path $INSTALL_DIR) {
  Write-Host "`n[3/5] Existing install at $INSTALL_DIR. Pulling latest..." -ForegroundColor Yellow
  git -C $INSTALL_DIR pull --quiet
} else {
  Write-Host "`n[3/5] Cloning to $INSTALL_DIR..." -ForegroundColor Yellow
  git clone --quiet $REPO_URL $INSTALL_DIR
}

Set-Location $INSTALL_DIR

# 5. npm install
Write-Host "`n[4/5] Installing npm dependencies (~30 sec)..." -ForegroundColor Yellow
npm install --silent --no-audit --no-fund

# 6. Playwright Chromium
Write-Host "`n[5/5] Downloading Chromium (~90 sec, one-time)..." -ForegroundColor Yellow
npx --yes playwright install chromium 2>&1 | Out-String | Out-Null
Write-Host "    Chromium ready." -ForegroundColor Green

# 7. Launch wizard
Write-Host "`n$('═' * 60)" -ForegroundColor Cyan
Write-Host "Launching setup wizard..." -ForegroundColor Cyan
Write-Host "$('═' * 60)`n" -ForegroundColor Cyan
node scripts\setup-wizard.mjs
