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
# winget notes (v2.0): --source winget pins the non-Microsoft-Store source —
# the msstore source can throw an interactive agreement prompt even with
# --accept-* flags, which looks like a hang in a piped iex session.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "`n[1/5] Node.js not found. Installing via winget (1-2 min)..." -ForegroundColor Yellow
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "winget is not available on this machine. Install Node.js manually from https://nodejs.org/ then re-run this installer." -ForegroundColor Red
    exit 1
  }
  winget install -e --id OpenJS.NodeJS --source winget --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    Write-Host "winget install failed (exit $LASTEXITCODE). Install Node.js manually from https://nodejs.org/ then re-run." -ForegroundColor Red
    exit 1
  }
  # Refresh PATH for current session
  $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
} else {
  Write-Host "[1/5] Node.js found: $(node --version)" -ForegroundColor Green
}

# 3. Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "`n[2/5] Git not found. Installing via winget (1-2 min)..." -ForegroundColor Yellow
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "winget is not available on this machine. Install Git manually from https://git-scm.com/ then re-run this installer." -ForegroundColor Red
    exit 1
  }
  winget install -e --id Git.Git --source winget --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    Write-Host "winget install failed (exit $LASTEXITCODE). Install Git manually from https://git-scm.com/ then re-run." -ForegroundColor Red
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
if ($LASTEXITCODE -ne 0) {
  Write-Host "git failed (exit $LASTEXITCODE). Check your network connection and re-run." -ForegroundColor Red
  exit 1
}

Set-Location $INSTALL_DIR

# 5. npm install — progress visible (v2.0). A silent multi-minute step on
# slow connections is indistinguishable from a hang; let npm talk.
Write-Host "`n[4/5] Installing npm dependencies (~30 sec on fast connections)..." -ForegroundColor Yellow
npm install --no-audit --no-fund --loglevel=http
if ($LASTEXITCODE -ne 0) {
  Write-Host "npm install failed (exit $LASTEXITCODE). Check your network connection and re-run this installer." -ForegroundColor Red
  exit 1
}

# 6. Playwright Chromium — ~150 MB download. Output deliberately NOT
# suppressed (v2.0): playwright prints a real progress bar, and hiding it
# made slow downloads look like the installer froze.
Write-Host "`n[5/5] Downloading Chromium (~150 MB - a few minutes on slow connections)..." -ForegroundColor Yellow
npx --yes playwright install chromium
if ($LASTEXITCODE -ne 0) {
  Write-Host "Chromium download failed (exit $LASTEXITCODE). Re-run this installer to retry." -ForegroundColor Red
  exit 1
}
Write-Host "    Chromium ready." -ForegroundColor Green

# 7. Launch wizard
Write-Host "`n$('═' * 60)" -ForegroundColor Cyan
Write-Host "Launching setup wizard..." -ForegroundColor Cyan
Write-Host "$('═' * 60)`n" -ForegroundColor Cyan
node scripts\setup-wizard.mjs
