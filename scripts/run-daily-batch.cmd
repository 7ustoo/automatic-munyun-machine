@echo off
REM Wrapper invoked by Task Scheduler at the configured time (default 7am
REM Mon-Fri) AND by telegram-bot.mjs on /daily (Win32 path). Runs the
REM Playwright scraper, which launches its own persistent-profile Chromium.

set ROOT=%~dp0..
cd /d "%ROOT%"

REM Resolve node.exe WITHOUT relying on PATH (v2.0) — same chain as start-bot.cmd.
set "NODE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE set "NODE=node"

"%NODE%" "%~dp0daily-batch.mjs"
exit /b %errorlevel%
