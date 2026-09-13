@echo off
set ROOT=%~dp0..
cd /d "%ROOT%"
set "NODE="
if exist "%ROOT%\runtime\node.exe" set "NODE=%ROOT%\runtime\node.exe"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE set "NODE=node"
"%NODE%" "%~dp0scheduled-batches.mjs"
exit /b %errorlevel%
