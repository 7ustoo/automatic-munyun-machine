# Automatic Munyun Machine — Windows Task Scheduler setup.
# Idempotent: re-running re-registers both tasks.
#
# Run via:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-tasks.ps1
#
# Or invoked automatically by setup-wizard.mjs.

$ErrorActionPreference = 'Stop'

$ROOT = Split-Path -Parent $PSScriptRoot
$RUN_BATCH_CMD = Join-Path $ROOT 'scripts\run-daily-batch.cmd'
$START_BOT_CMD = Join-Path $ROOT 'scripts\start-bot.cmd'

# Read time + days from config.json if present
$cfg = $null
$cfgPath = Join-Path $ROOT 'config.json'
if (Test-Path $cfgPath) {
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
}
$time = if ($cfg -and $cfg.schedule -and $cfg.schedule.time) { $cfg.schedule.time } else { '07:00' }
$days = if ($cfg -and $cfg.schedule -and $cfg.schedule.days) { $cfg.schedule.days } else { @('Monday','Tuesday','Wednesday','Thursday','Friday') }
$dayEnums = $days | ForEach-Object { [System.DayOfWeek]$_ }

# Migration: delete old career-ops-* tasks if they exist
foreach ($oldName in @('career-ops-daily-batch','career-ops-bot')) {
  if (Get-ScheduledTask -TaskName $oldName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $oldName -Confirm:$false
    Write-Host "[migration] Removed legacy task: $oldName"
  }
}

# Daily batch at scheduled time, scheduled days
$action7  = New-ScheduledTaskAction -Execute $RUN_BATCH_CMD
$trigger7 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $dayEnums -At $time
$set7     = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName 'munyun-daily-batch' -Action $action7 -Trigger $trigger7 -Settings $set7 -Description "AMM daily 100-job batch ($time, $($days -join ','))" -Force | Out-Null
Write-Host "[OK] Registered: munyun-daily-batch ($time, $($days -join ','))"

# Bot listener at logon
$actionB  = New-ScheduledTaskAction -Execute $START_BOT_CMD
$triggerB = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$setB     = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 1) -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName 'munyun-bot' -Action $actionB -Trigger $triggerB -Settings $setB -Description "AMM Telegram bot listener (polls /daily etc.)" -Force | Out-Null
Write-Host "[OK] Registered: munyun-bot (At logon, auto-restart on crash)"
