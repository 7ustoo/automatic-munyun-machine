#!/usr/bin/env bash
# Mac/Linux launcher for the long-running Telegram bot.
# Symmetric to scripts/start-bot.cmd on Windows.
set -euo pipefail
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$ROOT"
exec node "$ROOT/scripts/telegram-bot.mjs"
