#!/usr/bin/env bash
# Automatic Munyun Machine — macOS launchd setup (v1.1).
#
# Idempotent: re-running re-registers all four agents.
#
# Renders + loads four LaunchAgent plists into ~/Library/LaunchAgents/:
#   com.amm.bot.plist           At login + KeepAlive  → telegram-bot.mjs
#   com.amm.daily.plist         Calendar (per config) → daily-batch.mjs
#   com.amm.watchdog.plist      Every 5 min           → watchdog.mjs
#   com.amm.batch-missed.plist  Calendar +1h          → batch-missed-watcher.mjs
#
# Usage:
#   bash scripts/setup-tasks-mac.sh
#
# Or invoked automatically by setup-wizard.mjs.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
NODE="$( command -v node || echo /usr/local/bin/node )"
LA_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LA_DIR"

# Read schedule from config.json — same logic as setup-tasks.ps1 / .sh.
# v1.0 E5+: schedule lives at profiles.<active>.schedule (post-migration).
SCHED_TIME="07:00"
SCHED_DAYS=(Monday Tuesday Wednesday Thursday Friday)
if [[ -f "$ROOT/config.json" ]] && command -v node >/dev/null 2>&1; then
  read_cfg=$(node -e '
    try {
      const fs = require("fs");
      const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      let s = null;
      if (cfg.profiles && cfg.active_profile) s = cfg.profiles[cfg.active_profile]?.schedule;
      else s = cfg.schedule;
      if (s) console.log(JSON.stringify({ time: s.time, days: s.days }));
      else console.log(JSON.stringify({ time: "07:00", days: ["Monday","Tuesday","Wednesday","Thursday","Friday"] }));
    } catch { console.log(JSON.stringify({ time: "07:00", days: ["Monday","Tuesday","Wednesday","Thursday","Friday"] })); }
  ' "$ROOT/config.json")
  SCHED_TIME=$(echo "$read_cfg" | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{ try { console.log(JSON.parse(s).time || "07:00") } catch { console.log("07:00") } })')
  read -r -a SCHED_DAYS < <(echo "$read_cfg" | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{ try { console.log((JSON.parse(s).days || []).join(" ")) } catch { console.log("Monday Tuesday Wednesday Thursday Friday") } })')
fi

HH="${SCHED_TIME%:*}"
MM="${SCHED_TIME#*:}"
HH=$((10#$HH))
MM=$((10#$MM))
MISSED_HH=$(( (HH + 1) % 24 ))
MISSED_MM=$MM

# Map day-name → launchd Weekday number (0=Sun, 1=Mon, ..., 6=Sat).
day_to_num() {
  case "$1" in
    Sunday) echo 0;;
    Monday) echo 1;;
    Tuesday) echo 2;;
    Wednesday) echo 3;;
    Thursday) echo 4;;
    Friday) echo 5;;
    Saturday) echo 6;;
    *) echo "";;
  esac
}

calendar_intervals() {
  local h=$1 m=$2
  local out=""
  for d in "${SCHED_DAYS[@]}"; do
    local n; n=$(day_to_num "$d")
    [[ -z "$n" ]] && continue
    out+="    <dict>
      <key>Weekday</key><integer>$n</integer>
      <key>Hour</key><integer>$h</integer>
      <key>Minute</key><integer>$m</integer>
    </dict>
"
  done
  printf "%s" "$out"
}

write_plist() {
  local label="$1" plist="$2"
  echo "$plist" > "$LA_DIR/$label.plist"
}

bootstrap() {
  local label="$1"
  # Bootout existing instance (idempotent — silent if not loaded), then load.
  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$LA_DIR/$label.plist"
  echo "[OK] Loaded: $label"
}

# ---- com.amm.bot — long-running, KeepAlive ----
# v1.2: launches the AMM menubar wrapper (Go binary) which supervises the
# node bot internally. Falls back to direct node invocation if the
# wrapper hasn't been built yet (fresh source checkout).
if [[ -x "$ROOT/wrapper/dist/AMM-darwin-arm64" ]]; then
  BOT_LAUNCHER_BIN="$ROOT/wrapper/dist/AMM-darwin-arm64"
elif [[ -x "$ROOT/wrapper/dist/AMM-darwin-amd64" ]]; then
  BOT_LAUNCHER_BIN="$ROOT/wrapper/dist/AMM-darwin-amd64"
else
  BOT_LAUNCHER_BIN=""
fi

if [[ -n "$BOT_LAUNCHER_BIN" ]]; then
  echo "[v1.2] Using tray-wrapper binary: $BOT_LAUNCHER_BIN"
  PROGRAM_ARGUMENTS="    <string>$BOT_LAUNCHER_BIN</string>"
else
  echo "[v1.2] Wrapper not built yet — falling back to direct node invocation."
  echo "       Build it later with: cd wrapper && make build"
  PROGRAM_ARGUMENTS="    <string>$NODE</string>
    <string>$ROOT/scripts/telegram-bot.mjs</string>"
fi

write_plist "com.amm.bot" "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>com.amm.bot</string>
  <key>ProgramArguments</key>
  <array>
$PROGRAM_ARGUMENTS
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ROOT/data/telegram-bot.stdout.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/telegram-bot.stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>"

# ---- com.amm.daily — scheduled batch ----
write_plist "com.amm.daily" "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>com.amm.daily</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/scripts/daily-batch.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartCalendarInterval</key>
  <array>
$(calendar_intervals "$HH" "$MM")
  </array>
  <key>StandardOutPath</key><string>$ROOT/data/daily-batch.stdout.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/daily-batch.stderr.log</string>
</dict>
</plist>"

# ---- com.amm.watchdog — every 5 min ----
write_plist "com.amm.watchdog" "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>com.amm.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/scripts/watchdog.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>$ROOT/data/watchdog.stdout.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/watchdog.stderr.log</string>
</dict>
</plist>"

# ---- com.amm.batch-missed — same days, +1h after batch time ----
write_plist "com.amm.batch-missed" "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>com.amm.batch-missed</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/scripts/batch-missed-watcher.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartCalendarInterval</key>
  <array>
$(calendar_intervals "$MISSED_HH" "$MISSED_MM")
  </array>
  <key>StandardOutPath</key><string>$ROOT/data/batch-missed.stdout.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/batch-missed.stderr.log</string>
</dict>
</plist>"

# Load all four
bootstrap "com.amm.bot"
bootstrap "com.amm.daily"
bootstrap "com.amm.watchdog"
bootstrap "com.amm.batch-missed"

echo ""
echo "[OK] All four AMM agents registered ($SCHED_TIME, ${SCHED_DAYS[*]})."
echo "[OK] Verify with: launchctl list | grep com.amm"
