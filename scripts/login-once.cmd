@echo off
REM One-time setup: opens the daily-batch Chromium profile so you can
REM sign into hiring.cafe via Google SSO. After login, future scrapes
REM use your account (filtering Saved/Applied/Viewed server-side).

set ROOT=%~dp0..
cd /d "%ROOT%"
node scripts\login-once.mjs
