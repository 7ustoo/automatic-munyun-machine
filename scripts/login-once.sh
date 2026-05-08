#!/usr/bin/env bash
# Mac/Linux Cloudflare-warmup launcher.
# Opens a visible Chromium with the persistent profile and waits for cards
# to render. No sign-in required — this just clears the Cloudflare challenge.
set -euo pipefail
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$ROOT"
exec node "$ROOT/scripts/login-once.mjs"
