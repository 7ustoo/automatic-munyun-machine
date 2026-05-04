@echo off
REM Wrapper invoked by Task Scheduler at 7am Mon-Fri AND by telegram-bot.mjs
REM on /daily. Runs the Playwright/CDP scraper which connects to your already-
REM running Chrome on port 9222.
REM
REM Prereq: Chrome must be running with --remote-debugging-port=9222.
REM If it isn't, the script logs the error to data/daily-batch-{date}.log and
REM also pings Telegram via its built-in error handler.

set ROOT=%~dp0..
cd /d "%ROOT%"

node "%~dp0daily-batch.mjs"
exit /b %errorlevel%
