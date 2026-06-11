@echo off
REM One-time setup: opens the daily-batch Chromium profile so you can clear
REM Cloudflare (and optionally sign into hiring.cafe). After this, future
REM scrapes reuse the warmed profile.

set ROOT=%~dp0..
cd /d "%ROOT%"

REM Resolve node.exe WITHOUT relying on PATH (v2.0) — same chain as start-bot.cmd.
set "NODE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE set "NODE=node"

"%NODE%" scripts\login-once.mjs
