#!/usr/bin/env bash
# Automatic Munyun Machine — macOS/Linux one-line installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/7ustoo/automatic-munyun-machine/main/install.sh | bash
#
# What it does:
#   1. Verifies prerequisites (git, node ≥ 18) — installs via brew/apt if missing.
#   2. Clones (or pulls) the repo into ~/.local/share/automatic-munyun-machine
#      (Mac: ~/Library/Application\ Support/automatic-munyun-machine).
#   3. Runs npm install. (v2.0.1: Playwright Chromium is only downloaded
#      when no Chrome/Edge/chromium is already installed — AMM drives your
#      system browser with its own private profile.)
#   4. Hands off to the interactive wizard (`npm run setup`).
#
# Idempotent: re-running pulls latest + re-runs the wizard.

set -euo pipefail

OS="$(uname -s)"
case "$OS" in
  Darwin)  PLATFORM="mac";   INSTALL_DIR="$HOME/Library/Application Support/automatic-munyun-machine";;
  Linux)   PLATFORM="linux"; INSTALL_DIR="$HOME/.local/share/automatic-munyun-machine";;
  *)       echo "❌ Unsupported OS: $OS"; exit 1;;
esac

REPO="https://github.com/7ustoo/automatic-munyun-machine.git"

cyan() { printf "\033[36m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1"; }

cyan "=== Automatic Munyun Machine — installer ($PLATFORM) ==="

# ---- 1. Prerequisites ----
need_install=()
command -v git >/dev/null 2>&1 || need_install+=("git")
if ! command -v node >/dev/null 2>&1; then
  need_install+=("node")
else
  NODE_VER="$(node -v | sed 's/^v//;s/\..*//')"
  if [[ "$NODE_VER" -lt 18 ]]; then
    yellow "Node $NODE_VER is too old (need ≥ 18). Will install latest."
    need_install+=("node")
  fi
fi

if [[ ${#need_install[@]} -gt 0 ]]; then
  yellow "Missing prerequisites: ${need_install[*]}"
  if [[ "$PLATFORM" == "mac" ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      red "Homebrew not found. Install from https://brew.sh first, then re-run."
      exit 1
    fi
    for pkg in "${need_install[@]}"; do brew install "$pkg" || true; done
  else
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get update -qq
      [[ " ${need_install[*]} " == *" git "* ]] && sudo apt-get install -y git
      [[ " ${need_install[*]} " == *" node "* ]] && {
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
      }
    elif command -v dnf >/dev/null 2>&1; then
      [[ " ${need_install[*]} " == *" git "* ]] && sudo dnf install -y git
      [[ " ${need_install[*]} " == *" node "* ]] && sudo dnf install -y nodejs
    else
      red "Unknown Linux package manager. Install git + node ≥ 18 manually then re-run."
      exit 1
    fi
  fi
fi

green "✓ Prerequisites OK ($(node -v))"

# ---- 2. Clone / pull repo ----
mkdir -p "$(dirname "$INSTALL_DIR")"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  cyan "→ Existing install at $INSTALL_DIR — pulling latest"
  git -C "$INSTALL_DIR" pull --ff-only origin main
else
  cyan "→ Cloning into $INSTALL_DIR"
  git clone "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ---- 3. npm + browser ----
cyan "→ Installing dependencies (this can take a minute)…"
npm install --no-audit --no-fund --loglevel=error

# v2.0.1: AMM drives your installed Chrome/Edge/chromium via Playwright's
# channel/executablePath options (scripts/browser-launcher.mjs) — the
# bundled-Chromium download is a fallback, not a requirement. Keep this
# candidate list in sync with browser-launcher.mjs.
have_system_browser() {
  [ -e "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && return 0
  [ -e "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" ] && return 0
  for b in /usr/bin/google-chrome /usr/bin/google-chrome-stable /opt/google/chrome/chrome \
           /usr/bin/microsoft-edge /usr/bin/microsoft-edge-stable \
           /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium; do
    [ -e "$b" ] && return 0
  done
  return 1
}

if have_system_browser; then
  green "✓ System browser found — skipping the ~120 MB Chromium download."
else
  cyan "→ No Chrome/Edge/chromium found. Downloading bundled Chromium (~120 MB)…"
  npx playwright install chromium
fi

# ---- 4. Wizard ----
green ""
green "✅ Install complete. Launching the setup wizard…"
green ""
exec npm run setup
