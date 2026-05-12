#!/usr/bin/env bash
# Mac/Linux launcher for the daily scrape.
# Symmetric to scripts/run-daily-batch.cmd on Windows.
set -euo pipefail
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$ROOT"
exec node "$ROOT/scripts/daily-batch.mjs"
