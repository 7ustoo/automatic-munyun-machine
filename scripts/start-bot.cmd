@echo off
REM Launches telegram-bot.mjs detached/minimized.
REM Invoked by Task Scheduler "munyun-bot" at user logon.
REM
REM To run manually for debugging: just double-click; close window to stop.

set ROOT=%~dp0..
cd /d "%ROOT%"

REM Use start /min to detach so the bot keeps running after the launcher exits.
start "munyun bot" /min cmd /c "node scripts\telegram-bot.mjs"
