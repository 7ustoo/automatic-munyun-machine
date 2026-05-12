#!/usr/bin/env bash
# Automatic Munyun Machine — Linux systemd (user-level) setup (v1.1).
#
# Idempotent: re-running re-renders + reloads.
#
# Renders four user units into ~/.config/systemd/user/:
#   munyun-bot.service          long-running, KeepAlive
#   munyun-daily.service+timer  scheduled batch
#   munyun-watchdog.service+timer  every 5 min
#   munyun-batch-missed.service+timer  scheduled +1h
#
# Usage:
#   bash scripts/setup-tasks-linux.sh
#
# Or invoked automatically by setup-wizard.mjs.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
NODE="$( command -v node || echo /usr/bin/node )"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

# Schedule from config.json (same logic as the Mac script).
SCHED_TIME="07:00"
SCHED_DAYS_CSV="Mon,Tue,Wed,Thu,Fri"
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
  # systemd OnCalendar wants Mon,Tue,Wed,...
  SCHED_DAYS_CSV=$(echo "$read_cfg" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
      try {
        const days = JSON.parse(s).days || [];
        const map = { Monday:"Mon", Tuesday:"Tue", Wednesday:"Wed", Thursday:"Thu", Friday:"Fri", Saturday:"Sat", Sunday:"Sun" };
        console.log(days.map(d => map[d] || "Mon").join(","));
      } catch { console.log("Mon,Tue,Wed,Thu,Fri") }
    })')
fi

HH="${SCHED_TIME%:*}"
MM="${SCHED_TIME#*:}"
HH=$((10#$HH))
MM=$((10#$MM))
MISSED_HH=$(( (HH + 1) % 24 ))
MISSED_MM=$MM
DAILY_CAL="$SCHED_DAYS_CSV $(printf '%02d:%02d' "$HH" "$MM"):00"
MISSED_CAL="$SCHED_DAYS_CSV $(printf '%02d:%02d' "$MISSED_HH" "$MISSED_MM"):00"

write_unit() {
  local name="$1" content="$2"
  echo "$content" > "$UNIT_DIR/$name"
}

# ---- bot.service — long-running ----
# v1.2: launches the AMM tray wrapper (Go binary) which supervises the
# node bot internally and owns the StatusNotifier tray icon. Falls back
# to direct node invocation if the wrapper hasn't been built yet.
if [[ -x "$ROOT/wrapper/dist/amm-tray" ]]; then
  BOT_EXEC_START="$ROOT/wrapper/dist/amm-tray"
  echo "[v1.2] Using tray-wrapper binary: $BOT_EXEC_START"
else
  BOT_EXEC_START="$NODE $ROOT/scripts/telegram-bot.mjs"
  echo "[v1.2] Wrapper not built yet — falling back to direct node invocation."
  echo "       Build it later with: cd wrapper && make build"
fi

write_unit "munyun-bot.service" "[Unit]
Description=Automatic Munyun Machine — Telegram bot listener
After=network-online.target graphical-session.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$BOT_EXEC_START
Restart=on-failure
RestartSec=10
StandardOutput=append:$ROOT/data/telegram-bot.stdout.log
StandardError=append:$ROOT/data/telegram-bot.stderr.log
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=default.target
"

# ---- daily.service / .timer ----
write_unit "munyun-daily.service" "[Unit]
Description=AMM daily 100-job batch
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/scripts/daily-batch.mjs
StandardOutput=append:$ROOT/data/daily-batch.stdout.log
StandardError=append:$ROOT/data/daily-batch.stderr.log
"

write_unit "munyun-daily.timer" "[Unit]
Description=AMM daily batch timer ($DAILY_CAL)

[Timer]
OnCalendar=$DAILY_CAL
Persistent=true
Unit=munyun-daily.service

[Install]
WantedBy=timers.target
"

# ---- watchdog.service / .timer (every 5 min) ----
write_unit "munyun-watchdog.service" "[Unit]
Description=AMM bot watchdog (kills + restarts on stale heartbeat)

[Service]
Type=oneshot
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/scripts/watchdog.mjs
StandardOutput=append:$ROOT/data/watchdog.stdout.log
StandardError=append:$ROOT/data/watchdog.stderr.log
"

write_unit "munyun-watchdog.timer" "[Unit]
Description=AMM watchdog timer (every 5 min)

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Unit=munyun-watchdog.service

[Install]
WantedBy=timers.target
"

# ---- batch-missed.service / .timer ----
write_unit "munyun-batch-missed.service" "[Unit]
Description=AMM batch-missed alert

[Service]
Type=oneshot
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/scripts/batch-missed-watcher.mjs
StandardOutput=append:$ROOT/data/batch-missed.stdout.log
StandardError=append:$ROOT/data/batch-missed.stderr.log
"

write_unit "munyun-batch-missed.timer" "[Unit]
Description=AMM batch-missed timer ($MISSED_CAL)

[Timer]
OnCalendar=$MISSED_CAL
Persistent=true
Unit=munyun-batch-missed.service

[Install]
WantedBy=timers.target
"

# Reload + enable
systemctl --user daemon-reload
systemctl --user enable --now munyun-bot.service
systemctl --user enable --now munyun-daily.timer
systemctl --user enable --now munyun-watchdog.timer
systemctl --user enable --now munyun-batch-missed.timer

# linger so units run when not logged in (recommended for laptops)
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$USER" 2>/dev/null || true
fi

echo ""
echo "[OK] All four AMM units registered (daily: $DAILY_CAL)."
echo "[OK] Verify with: systemctl --user list-units 'munyun-*'"
