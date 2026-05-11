# Automatic Munyun Machine - Windows Task Scheduler setup.
# Idempotent: re-running re-registers both tasks.
#
# Run via:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-tasks.ps1
#
# Or invoked automatically by setup-wizard.mjs.

$ErrorActionPreference = 'Stop'

$ROOT = Split-Path -Parent $PSScriptRoot
$RUN_BATCH_CMD = Join-Path $ROOT 'scripts\run-daily-batch.cmd'
# v1.2: the bot is now launched via the AMM.exe wrapper (Go binary at
# wrapper/dist/AMM.exe) instead of start-bot.cmd's minimized cmd window.
# The wrapper owns the system tray icon + supervises the node child.
# Falls back to start-bot.cmd if the wrapper binary hasn't been built yet
# (e.g. fresh source checkout without `cd wrapper && make build`).
$WRAPPER_EXE   = Join-Path $ROOT 'wrapper\dist\AMM.exe'
$START_BOT_CMD = Join-Path $ROOT 'scripts\start-bot.cmd'
if (Test-Path $WRAPPER_EXE) {
  $BOT_LAUNCHER = $WRAPPER_EXE
  Write-Host "[v1.2] Using tray-wrapper binary: $BOT_LAUNCHER"
} else {
  $BOT_LAUNCHER = $START_BOT_CMD
  Write-Host "[v1.2] Wrapper not built yet — falling back to start-bot.cmd."
  Write-Host "       Build it later with: cd wrapper && make build"
}

# Read time + days from config.json if present.
# v1.0 E5+ : schedule lives at profiles.<active>.schedule (post-migration).
# v0.x    : schedule lived at the top level. Both shapes handled below.
$cfg = $null
$cfgPath = Join-Path $ROOT 'config.json'
if (Test-Path $cfgPath) {
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
} else {
  Write-Host "[warn] config.json not found at $cfgPath - using defaults (07:00 Mon-Fri)." -ForegroundColor Yellow
  Write-Host "[warn] Run: node scripts\setup-wizard.mjs to generate one." -ForegroundColor Yellow
}

# Resolve schedule from active profile (v1.0+) or top level (legacy).
$scheduleNode = $null
if ($cfg -and $cfg.profiles -and $cfg.active_profile) {
  $activeName = $cfg.active_profile
  $activeProfile = $cfg.profiles.$activeName
  if ($activeProfile -and $activeProfile.schedule) { $scheduleNode = $activeProfile.schedule }
} elseif ($cfg -and $cfg.schedule) {
  $scheduleNode = $cfg.schedule
}
$time = if ($scheduleNode -and $scheduleNode.time) { $scheduleNode.time } else { '07:00' }
$days = if ($scheduleNode -and $scheduleNode.days) { $scheduleNode.days } else { @('Monday','Tuesday','Wednesday','Thursday','Friday') }
$dayEnums = $days | ForEach-Object { [System.DayOfWeek]$_ }

# (career-ops-* legacy migration block removed in v1.1; pre-v0.2 installs
# are far enough back that we no longer carry the cleanup. Anyone still
# upgrading from v0.1 can manually `schtasks /delete /tn career-ops-bot`
# and `…career-ops-daily-batch`.)

# Daily batch at scheduled time, scheduled days
$action7  = New-ScheduledTaskAction -Execute $RUN_BATCH_CMD
$trigger7 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $dayEnums -At $time
$set7     = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName 'munyun-daily-batch' -Action $action7 -Trigger $trigger7 -Settings $set7 -Description "AMM daily 100-job batch ($time, $($days -join ','))" -Force | Out-Null
Write-Host "[OK] Registered: munyun-daily-batch ($time, $($days -join ','))"

# Bot listener at logon. v1.2: launches AMM.exe (tray wrapper) which then
# supervises the node bot as a child process. The wrapper owns the
# system-tray icon, so the user sees a real "AMM is running" indicator
# instead of a minimized cmd window. Falls back to start-bot.cmd if the
# wrapper binary hasn't been built (see $BOT_LAUNCHER resolution above).
$actionB  = New-ScheduledTaskAction -Execute $BOT_LAUNCHER -WorkingDirectory $ROOT
$triggerB = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$setB     = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 1) -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName 'munyun-bot' -Action $actionB -Trigger $triggerB -Settings $setB -Description "AMM Telegram bot listener (tray wrapper supervises node child)" -Force | Out-Null
Write-Host "[OK] Registered: munyun-bot (At logon, auto-restart on crash) → $BOT_LAUNCHER"

# Watchdog every 5 minutes — restarts the bot if its heartbeat is stale.
# Runs `node scripts/watchdog.mjs` via cmd.exe so it inherits PATH; the
# script itself uses absolute %SystemRoot% paths for the binaries it spawns.
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = 'node' }
$WATCHDOG_SCRIPT = Join-Path $ROOT 'scripts\watchdog.mjs'
$actionW   = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$WATCHDOG_SCRIPT`"" -WorkingDirectory $ROOT
$triggerW  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$setW      = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'munyun-watchdog' -Action $actionW -Trigger $triggerW -Settings $setW -Description "AMM bot watchdog (every 5 min; restarts on stale heartbeat)" -Force | Out-Null
Write-Host "[OK] Registered: munyun-watchdog (every 5 min)"

# Batch-missed watcher — runs 1 hour after the scheduled batch time on the
# same days. Pings Telegram if today's batch TSV is missing.
$BATCH_MISSED_SCRIPT = Join-Path $ROOT 'scripts\batch-missed-watcher.mjs'
$batchHour = [int]($time.Split(':')[0])
$batchMin  = [int]($time.Split(':')[1])
$missedTime = ('{0:D2}:{1:D2}' -f (($batchHour + 1) % 24), $batchMin)
$actionM  = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$BATCH_MISSED_SCRIPT`"" -WorkingDirectory $ROOT
$triggerM = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $dayEnums -At $missedTime
$setM     = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'munyun-batch-missed' -Action $actionM -Trigger $triggerM -Settings $setM -Description "AMM batch-missed alert ($missedTime, $($days -join ','))" -Force | Out-Null
Write-Host "[OK] Registered: munyun-batch-missed ($missedTime, $($days -join ','))"
