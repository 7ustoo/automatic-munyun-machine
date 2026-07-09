@echo off
REM Launches telegram-bot.mjs detached/minimized.
REM Invoked by Task Scheduler "munyun-bot" at user logon (fallback path when
REM the v1.2 tray wrapper binary hasn't been built — see setup-tasks.ps1).
REM
REM To run manually for debugging: just double-click; close window to stop.

set ROOT=%~dp0..
cd /d "%ROOT%"

REM Resolve node.exe WITHOUT relying on PATH (v2.0) — stripped-PATH installs
REM are a recurring bug class here (v0.4.1, v0.5). Order:
REM   1. the Node runtime bundled inside the install (v4.1.1 — the .exe
REM      installer ships it so a fresh machine needs no system Node)
REM   2. the standard Node.js install location
REM   3. bare "node" via PATH (last resort, pre-v2.0 behavior)
set "NODE="
if exist "%ROOT%\runtime\node.exe" set "NODE=%ROOT%\runtime\node.exe"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE set "NODE=node"

REM Use start /min to detach so the bot keeps running after the launcher exits.
start "munyun bot" /min "%NODE%" scripts\telegram-bot.mjs
